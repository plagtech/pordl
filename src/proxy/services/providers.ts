/**
 * Provider abstraction layer.
 *
 * All providers are called via OpenAI-compatible endpoints.
 * Anthropic and others that aren't natively compatible get
 * request/response translation here.
 *
 * This keeps the router simple — it just picks a provider,
 * and this module handles the protocol differences.
 */

import type { ServerResponse } from "node:http";
import { config } from "../config";

// ── Provider definitions ───────────────────────────────

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: ModelConfig[];
  isAvailable: boolean;
}

export interface ModelConfig {
  id: string; // what users request: "gpt-5.4", "claude-sonnet-4-6"
  providerModelId: string; // what we send to the provider
  inputCostPer1M: number; // $/MTok
  outputCostPer1M: number;
  maxContext: number;
  tier: "budget" | "mid" | "frontier";
  capabilities: string[]; // ["code", "reasoning", "creative", "multilingual"]
}

export interface ProviderResponse {
  id: string;
  provider: string;
  model: string;
  content: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  finishReason: string;
  raw: unknown; // full provider response for passthrough
}

// ── Model catalog ──────────────────────────────────────
// Update these when providers change pricing

const MODELS: Record<string, ModelConfig[]> = {
  deepseek: [
    {
      id: "deepseek-v4-flash",
      providerModelId: "deepseek-v4-flash",
      inputCostPer1M: 0.14,
      outputCostPer1M: 0.28,
      maxContext: 1_000_000,
      tier: "budget",
      capabilities: ["creative", "code", "reasoning", "multilingual"],
    },
    {
      id: "deepseek-v4-pro",
      providerModelId: "deepseek-v4-pro",
      inputCostPer1M: 0.435,
      outputCostPer1M: 0.87,
      maxContext: 1_000_000,
      tier: "mid",
      capabilities: ["creative", "code", "reasoning", "multilingual"],
    },
  ],
  openai: [
    {
      id: "gpt-4o-mini",
      providerModelId: "gpt-4o-mini",
      inputCostPer1M: 0.15,
      outputCostPer1M: 0.6,
      maxContext: 128_000,
      tier: "budget",
      capabilities: ["code", "reasoning", "creative"],
    },
    {
      id: "gpt-4o",
      providerModelId: "gpt-4o",
      inputCostPer1M: 2.5,
      outputCostPer1M: 10.0,
      maxContext: 128_000,
      tier: "mid",
      capabilities: ["code", "reasoning", "creative", "multilingual"],
    },
    {
      id: "gpt-5.4",
      providerModelId: "gpt-5.4",
      inputCostPer1M: 2.5,
      outputCostPer1M: 15.0,
      maxContext: 256_000,
      tier: "frontier",
      capabilities: ["code", "reasoning", "creative", "multilingual"],
    },
  ],
};

// ── Provider registry ──────────────────────────────────

function buildProviders(): Map<string, ProviderConfig> {
  const map = new Map<string, ProviderConfig>();

  if (config.providers.deepseek) {
    map.set("deepseek", {
      name: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: config.providers.deepseek,
      models: MODELS.deepseek || [],
      isAvailable: true,
    });
  }

  if (config.providers.openai) {
    map.set("openai", {
      name: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: config.providers.openai,
      models: MODELS.openai || [],
      isAvailable: true,
    });
  }

  if (config.providers.anthropic) {
    map.set("anthropic", {
      name: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: config.providers.anthropic,
      models: MODELS.anthropic || [],
      isAvailable: true,
    });
  }

  if (config.providers.google) {
    map.set("google", {
      name: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: config.providers.google,
      models: MODELS.google || [],
      isAvailable: true,
    });
  }

  return map;
}

export const providers = buildProviders();

// ── Get all available models ───────────────────────────

export function getAllModels(): ModelConfig[] {
  const models: ModelConfig[] = [];
  for (const provider of providers.values()) {
    models.push(...provider.models);
  }
  return models.sort((a, b) => a.inputCostPer1M - b.inputCostPer1M);
}

export function findModel(
  modelId: string
): { provider: ProviderConfig; model: ModelConfig } | null {
  for (const provider of providers.values()) {
    const model = provider.models.find((m) => m.id === modelId);
    if (model) return { provider, model };
  }
  return null;
}

export function getModelsByTier(tier: "budget" | "mid" | "frontier"): ModelConfig[] {
  return getAllModels().filter((m) => m.tier === tier);
}

// ── Call a provider (OpenAI-compatible) ────────────────

export async function callProvider(
  providerName: string,
  model: ModelConfig,
  body: Record<string, unknown>
): Promise<ProviderResponse> {
  const provider = providers.get(providerName);
  if (!provider) throw new Error(`Unknown provider: ${providerName}`);

  const start = Date.now();

  // Anthropic uses a different API format
  if (providerName === "anthropic") {
    return callAnthropic(provider, model, body, start);
  }

  // Everyone else is OpenAI-compatible
  return callOpenAICompatible(provider, model, body, start);
}

async function callOpenAICompatible(
  provider: ProviderConfig,
  model: ModelConfig,
  body: Record<string, unknown>,
  start: number
): Promise<ProviderResponse> {
  const requestBody = {
    ...body,
    model: model.providerModelId,
    stream: false, // v1: non-streaming. Add streaming support in v2.
  };

  const resp = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(
      `Provider ${provider.name} returned ${resp.status}: ${errText}`
    );
  }

  const data = await resp.json();
  const latency = Date.now() - start;

  const inputTokens = data.usage?.prompt_tokens || 0;
  const outputTokens = data.usage?.completion_tokens || 0;
  const costUsd =
    (inputTokens / 1_000_000) * model.inputCostPer1M +
    (outputTokens / 1_000_000) * model.outputCostPer1M;

  return {
    id: data.id || `ir-${Date.now()}`,
    provider: provider.name,
    model: model.id,
    content: data.choices?.[0]?.message?.content || "",
    inputTokens,
    outputTokens,
    costUsd,
    latencyMs: latency,
    finishReason: data.choices?.[0]?.finish_reason || "stop",
    raw: data, // passthrough the full response
  };
}

async function callAnthropic(
  provider: ProviderConfig,
  model: ModelConfig,
  body: Record<string, unknown>,
  start: number
): Promise<ProviderResponse> {
  // Translate OpenAI format → Anthropic format
  const messages = body.messages as Array<{
    role: string;
    content: string;
  }>;

  // Extract system message if present
  const systemMsg = messages.find((m) => m.role === "system");
  const chatMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));

  const requestBody: Record<string, unknown> = {
    model: model.providerModelId,
    messages: chatMessages,
    max_tokens: (body.max_tokens as number) || 4096,
  };
  if (systemMsg) {
    requestBody.system = systemMsg.content;
  }

  const resp = await fetch(`${provider.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(
      `Provider ${provider.name} returned ${resp.status}: ${errText}`
    );
  }

  const data = await resp.json();
  const latency = Date.now() - start;

  const inputTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;
  const costUsd =
    (inputTokens / 1_000_000) * model.inputCostPer1M +
    (outputTokens / 1_000_000) * model.outputCostPer1M;

  const content =
    data.content?.map((c: { text: string }) => c.text).join("") || "";

  // Translate response back to OpenAI format
  const openaiFormatted = {
    id: data.id || `ir-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model.id,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: data.stop_reason === "end_turn" ? "stop" : data.stop_reason,
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };

  return {
    id: data.id,
    provider: provider.name,
    model: model.id,
    content,
    inputTokens,
    outputTokens,
    costUsd,
    latencyMs: latency,
    finishReason: data.stop_reason || "stop",
    raw: openaiFormatted, // return OpenAI-formatted response
  };
}

// ── Streaming (SSE) ────────────────────────────────────

export interface StreamUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export async function callProviderStreaming(
  providerName: string,
  model: ModelConfig,
  body: Record<string, unknown>,
  res: ServerResponse
): Promise<StreamUsage> {
  const provider = providers.get(providerName);
  if (!provider) throw new Error(`Unknown provider: ${providerName}`);

  const start = Date.now();

  if (providerName === "anthropic") {
    return streamAnthropic(provider, model, body, res, start);
  }

  return streamOpenAICompatible(provider, model, body, res, start);
}

function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
}

function computeCost(model: ModelConfig, inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * model.inputCostPer1M +
    (outputTokens / 1_000_000) * model.outputCostPer1M
  );
}

// Rough fallback when the provider doesn't send a usage chunk (~4 chars/token)
function estimateInputTokens(body: Record<string, unknown>): number {
  const messages = body.messages as Array<{ content?: unknown }> | undefined;
  if (!messages) return 0;
  const chars = messages.reduce(
    (n, m) => n + (typeof m.content === "string" ? m.content.length : 0),
    0
  );
  return Math.ceil(chars / 4);
}

async function streamOpenAICompatible(
  provider: ProviderConfig,
  model: ModelConfig,
  body: Record<string, unknown>,
  res: ServerResponse,
  start: number
): Promise<StreamUsage> {
  const requestBody: Record<string, unknown> = {
    ...body,
    model: model.providerModelId,
    stream: true,
  };
  // OpenAI only emits a usage chunk when explicitly asked; DeepSeek sends
  // usage in the final chunk by default and Google may reject the option.
  if (provider.name === "openai") {
    requestBody.stream_options = { include_usage: true };
  }

  const resp = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok || !resp.body) {
    const errText = await resp.text();
    throw new Error(
      `Provider ${provider.name} returned ${resp.status}: ${errText}`
    );
  }

  writeSseHeaders(res);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  let contentChars = 0;

  while (true) {
    if (res.destroyed) {
      await reader.cancel().catch(() => {});
      break;
    }

    const { done, value } = await reader.read();
    if (done) break;

    // Pipe raw SSE bytes straight through to the client
    res.write(value);

    // Also scan the chunks for token usage
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload);
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
          outputTokens = chunk.usage.completion_tokens ?? outputTokens;
          sawUsage = true;
        }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === "string") contentChars += delta.length;
      } catch {
        // Partial or non-JSON payload — ignore, we only pipe it through
      }
    }
  }

  res.end();

  if (!sawUsage) {
    inputTokens = estimateInputTokens(body);
    outputTokens = Math.ceil(contentChars / 4);
  }

  return {
    provider: provider.name,
    model: model.id,
    inputTokens,
    outputTokens,
    costUsd: computeCost(model, inputTokens, outputTokens),
    latencyMs: Date.now() - start,
  };
}

async function streamAnthropic(
  provider: ProviderConfig,
  model: ModelConfig,
  body: Record<string, unknown>,
  res: ServerResponse,
  start: number
): Promise<StreamUsage> {
  // Translate OpenAI format → Anthropic format (same as callAnthropic)
  const messages = body.messages as Array<{
    role: string;
    content: string;
  }>;

  const systemMsg = messages.find((m) => m.role === "system");
  const chatMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));

  const requestBody: Record<string, unknown> = {
    model: model.providerModelId,
    messages: chatMessages,
    max_tokens: (body.max_tokens as number) || 4096,
    stream: true,
  };
  if (systemMsg) {
    requestBody.system = systemMsg.content;
  }

  const resp = await fetch(`${provider.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok || !resp.body) {
    const errText = await resp.text();
    throw new Error(
      `Provider ${provider.name} returned ${resp.status}: ${errText}`
    );
  }

  writeSseHeaders(res);

  const streamId = `ir-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  // Translate Anthropic SSE events → OpenAI-format chunks
  const openaiChunk = (
    delta: Record<string, unknown>,
    finishReason: string | null = null
  ): string =>
    `data: ${JSON.stringify({
      id: streamId,
      object: "chat.completion.chunk",
      created,
      model: model.id,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = "stop";

  while (true) {
    if (res.destroyed) {
      await reader.cancel().catch(() => {});
      break;
    }

    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      let event: any;
      try {
        event = JSON.parse(trimmed.slice(5).trim());
      } catch {
        continue;
      }

      switch (event.type) {
        case "message_start":
          inputTokens = event.message?.usage?.input_tokens ?? 0;
          res.write(openaiChunk({ role: "assistant", content: "" }));
          break;
        case "content_block_delta":
          if (event.delta?.type === "text_delta") {
            res.write(openaiChunk({ content: event.delta.text }));
          }
          break;
        case "message_delta":
          outputTokens = event.usage?.output_tokens ?? outputTokens;
          if (event.delta?.stop_reason) {
            stopReason =
              event.delta.stop_reason === "end_turn"
                ? "stop"
                : event.delta.stop_reason;
          }
          break;
        case "message_stop":
          res.write(openaiChunk({}, stopReason));
          res.write("data: [DONE]\n\n");
          break;
      }
    }
  }

  res.end();

  return {
    provider: provider.name,
    model: model.id,
    inputTokens,
    outputTokens,
    costUsd: computeCost(model, inputTokens, outputTokens),
    latencyMs: Date.now() - start,
  };
}
