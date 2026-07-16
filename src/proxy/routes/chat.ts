/**
 * POST /v1/chat/completions
 *
 * Drop-in replacement for OpenAI's chat completions endpoint.
 * This is where the money happens:
 *   1. Check cache
 *   2. Classify request complexity
 *   3. Route to optimal provider/model
 *   4. Call provider
 *   5. Cache response
 *   6. Log usage
 *   7. Return OpenAI-compatible response
 */

import { Router, Request, Response } from "express";
import { classifyRequest } from "../utils/classifier";
import { routeRequest, getFailoverRoute, markProviderDown, RoutingMode } from "../services/router";
import {
  callProvider,
  callProviderStreaming,
  ProviderResponse,
  StreamUsage,
} from "../services/providers";
import { getCached, setCache } from "../services/cache";
import { logUsage } from "../db/supabase";

const router = Router();

interface ChatCompletionRequest {
  model?: string; // "auto" (default), or specific like "gpt-5.4"
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  stream?: boolean;
  // PORDL-specific
  routing_mode?: RoutingMode; // "fast" | "balanced" | "best"
  cache?: boolean; // default true
}

router.post("/", async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();

  try {
    const body = req.body as ChatCompletionRequest;

    // ── Validate request ──
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    const routingMode: RoutingMode =
      body.routing_mode || (req.auth?.user?.tier === "free" ? "fast" : "balanced");
    const useCache = body.cache !== false;
    const requestedModel = body.model === "auto" ? undefined : body.model;

    // ── Streaming path (SSE) ──
    // Skips the cache (streamed responses aren't cached) but still
    // classifies and routes like the normal flow.
    if (body.stream === true) {
      const classification = classifyRequest(body.messages);
      const route = routeRequest(classification.complexity, routingMode, requestedModel);

      const providerParams = {
        messages: body.messages,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        top_p: body.top_p,
        frequency_penalty: body.frequency_penalty,
        presence_penalty: body.presence_penalty,
        stop: body.stop,
      };

      // PORDL headers must be set before the SSE stream starts
      res.setHeader("x-pordl-cached", "false");
      res.setHeader("x-pordl-provider", route.provider);
      res.setHeader("x-pordl-model", route.model.id);
      res.setHeader("x-pordl-complexity", classification.complexity);
      res.setHeader("x-pordl-routing", route.reason.replace(/[^\x20-\x7E]/g, "-"));
      res.setHeader("x-pordl-savings", `${route.estimatedSavingsVsOpenAI}%`);

      let usage: StreamUsage;
      try {
        usage = await callProviderStreaming(route.provider, route.model, providerParams, res);
      } catch (providerError: any) {
        console.warn(
          `[Chat] Provider ${route.provider} failed: ${providerError.message}`
        );

        if (res.headersSent) {
          // Stream already started — can't send an error response, just end it
          res.end();
          return;
        }

        markProviderDown(route.provider);
        const failover = getFailoverRoute(route.provider, route.model);
        if (!failover) {
          res.status(502).json({
            error: {
              message: "All providers are currently unavailable. Please retry.",
              type: "server_error",
              code: "all_providers_down",
            },
          });
          return;
        }

        console.log(`[Chat] Failing over to ${failover.provider}/${failover.model.id}`);
        res.setHeader("x-pordl-provider", failover.provider);
        res.setHeader("x-pordl-model", failover.model.id);
        usage = await callProviderStreaming(
          failover.provider,
          failover.model,
          providerParams,
          res
        );
      }

      // Log usage asynchronously after the stream completes
      if (req.auth) {
        logUsage({
          user_id: req.auth.user.id,
          api_key_id: req.auth.apiKey.id,
          provider: usage.provider,
          model: usage.model,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cost_usd: usage.costUsd,
          cached: false,
          latency_ms: usage.latencyMs,
        }).catch((err) => console.error("[Usage] Log error:", err));
      }
      return;
    }

    // ── Step 1: Check cache ──
    if (useCache) {
      const cached = await getCached(body.messages, requestedModel);
      if (cached) {
        // Cache hit — free request!
        const latency = Date.now() - startTime;

        // Log as cached request (zero cost to us)
        if (req.auth) {
          logUsage({
            user_id: req.auth.user.id,
            api_key_id: req.auth.apiKey.id,
            provider: cached.provider,
            model: cached.model,
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0,
            cached: true,
            latency_ms: latency,
          }).catch((err) => console.error("[Usage] Log error:", err));
        }

        // Add PORDL headers
        const response = cached.response as Record<string, unknown>;
        res.setHeader("x-pordl-cached", "true");
        res.setHeader("x-pordl-provider", cached.provider);
        res.setHeader("x-pordl-model", cached.model);
        res.setHeader("x-pordl-savings", `$${cached.originalCostUsd.toFixed(6)}`);
        res.setHeader("x-pordl-latency", `${latency}ms`);

        res.json(response);
        return;
      }
    }

    // ── Step 2: Classify request ──
    const classification = classifyRequest(body.messages);

    // ── Step 3: Route to provider ──
    const route = routeRequest(classification.complexity, routingMode, requestedModel);

    // ── Step 4: Call provider ──
    let result: ProviderResponse;
    try {
      result = await callProvider(route.provider, route.model, {
        messages: body.messages,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        top_p: body.top_p,
        frequency_penalty: body.frequency_penalty,
        presence_penalty: body.presence_penalty,
        stop: body.stop,
      });
    } catch (providerError: any) {
      // Provider failed — try failover
      console.warn(
        `[Chat] Provider ${route.provider} failed: ${providerError.message}`
      );
      markProviderDown(route.provider);

      const failover = getFailoverRoute(route.provider, route.model);
      if (!failover) {
        res.status(502).json({
          error: {
            message: "All providers are currently unavailable. Please retry.",
            type: "server_error",
            code: "all_providers_down",
          },
        });
        return;
      }

      console.log(`[Chat] Failing over to ${failover.provider}/${failover.model.id}`);
      result = await callProvider(failover.provider, failover.model, {
        messages: body.messages,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        top_p: body.top_p,
      });
    }

    // ── Step 5: Cache response ──
    if (useCache) {
      setCache(
        body.messages,
        requestedModel,
        result.raw,
        result.provider,
        result.model,
        result.costUsd
      ).catch((err) => console.error("[Cache] Store error:", err));
    }

    // ── Step 6: Log usage ──
    if (req.auth) {
      logUsage({
        user_id: req.auth.user.id,
        api_key_id: req.auth.apiKey.id,
        provider: result.provider,
        model: result.model,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cost_usd: result.costUsd,
        cached: false,
        latency_ms: result.latencyMs,
      }).catch((err) => console.error("[Usage] Log error:", err));
    }

    // ── Step 7: Return OpenAI-compatible response ──
    const totalLatency = Date.now() - startTime;

    // Add PORDL headers (the developer can see what happened)
    res.setHeader("x-pordl-cached", "false");
    res.setHeader("x-pordl-provider", result.provider);
    res.setHeader("x-pordl-model", result.model);
    res.setHeader("x-pordl-complexity", classification.complexity);
    res.setHeader("x-pordl-routing", route.reason.replace(/[^\x20-\x7E]/g, '-'));
    res.setHeader("x-pordl-cost", `$${result.costUsd.toFixed(6)}`);
    res.setHeader("x-pordl-latency", `${totalLatency}ms`);
    res.setHeader("x-pordl-savings", `${route.estimatedSavingsVsOpenAI}%`);

    res.json(result.raw);
  } catch (err: any) {
    console.error("[Chat] Unhandled error:", err);
    if (res.headersSent) {
      // Mid-stream failure — the SSE response is already underway
      res.end();
      return;
    }
    res.status(500).json({
      error: {
        message: "Internal server error",
        type: "server_error",
        code: "internal_error",
      },
    });
  }
});

export default router;
