/**
 * Usage tracking middleware.
 *
 * Enforces, per request:
 *  - per-minute rate limits (Redis-backed)
 *  - monthly credit allowance (cost-based credits; HARD stop at zero —
 *    no overage, no surprise bills)
 *  - per-key concurrency limits
 * Also runs the IP-diversity heuristic that flags (never bans) keys used
 * from unusually many IPs — a signal of key sharing/resale.
 */

import { Request, Response, NextFunction } from "express";
import { TIER_LIMITS, CONCURRENCY_LIMITS, config } from "../config";
import {
  getMonthlyCreditsUsed,
  getMonthlyTopupCredits,
  logKeyEvent,
  flagApiKeyForReview,
} from "../db/supabase";
import { checkRateLimit, getRedis } from "../services/cache";

// Rate limits per minute by tier
const RATE_LIMITS: Record<string, number> = {
  free: 10,
  creator: 30,
  creator_pro: 60,
  creator_ultra: 120,
};

// ── Concurrency limiter (Redis; skipped when Redis is absent) ──

async function acquireConcurrencySlot(
  keyId: string,
  limit: number
): Promise<{ ok: boolean; release: () => void }> {
  const noop = { ok: true, release: () => {} };
  try {
    const client = await getRedis();
    if (!client) return noop;

    const key = `pd:conc:${keyId}`;
    const count = await client.incr(key);
    // Safety TTL so a crashed request can't leak a slot forever
    await client.expire(key, 300);

    const release = () => {
      client.decr(key).catch(() => {});
    };

    if (count > limit) {
      release();
      return { ok: false, release: () => {} };
    }
    return { ok: true, release };
  } catch {
    return noop; // fail open on limiter infrastructure errors
  }
}

// ── IP-diversity heuristic: flag (not ban) likely shared/resold keys ──

async function checkIpDiversity(req: Request): Promise<void> {
  if (!req.auth) return;
  try {
    const client = await getRedis();
    if (!client) return;

    const day = new Date().toISOString().slice(0, 10);
    const setKey = `pd:ips:${req.auth.apiKey.id}:${day}`;
    await client.sadd(setKey, req.ip || "unknown");
    await client.expire(setKey, 172_800);

    const distinctIps = await client.scard(setKey);
    if (distinctIps >= config.guardrails.ipDiversityThreshold) {
      // Flag at most once per key per day
      const flagKey = `pd:ipflag:${req.auth.apiKey.id}:${day}`;
      const first = await client.set(flagKey, "1", "EX", 172_800, "NX");
      if (first) {
        console.warn(
          `[Guardrails] key=${req.auth.apiKey.id} used from ${distinctIps} IPs today — flagged for review (not blocked)`
        );
        await flagApiKeyForReview(req.auth.apiKey.id);
        await logKeyEvent({
          user_id: req.auth.user.id,
          api_key_id: req.auth.apiKey.id,
          type: "ip_diversity",
          category: null,
          action: `flagged_${distinctIps}_ips`,
        });
      }
    }
  } catch {
    // heuristic is best-effort
  }
}

export async function usageMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.auth) {
    next();
    return;
  }

  const { user, apiKey } = req.auth;
  const tier = user.tier || "free";

  try {
    // Check per-minute rate limit (Redis-backed)
    const rateLimit = await checkRateLimit(
      apiKey.id,
      RATE_LIMITS[tier] || 10
    );

    // Set rate limit headers (OpenAI convention)
    res.setHeader("x-ratelimit-limit-requests", RATE_LIMITS[tier] || 10);
    res.setHeader("x-ratelimit-remaining-requests", rateLimit.remaining);
    res.setHeader("x-ratelimit-reset-requests", `${Math.ceil(rateLimit.resetMs / 1000)}s`);

    if (!rateLimit.allowed) {
      res.status(429).json({
        error: {
          message: `Rate limit exceeded. ${tier} tier allows ${RATE_LIMITS[tier]} requests/min. Upgrade at https://pordl.dev/#pricing`,
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      });
      return;
    }

    // ── Monthly credit allowance (hard stop at zero) ──
    const [creditsUsed, topupCredits] = await Promise.all([
      getMonthlyCreditsUsed(user.id),
      getMonthlyTopupCredits(user.id),
    ]);
    const creditLimit = (TIER_LIMITS[tier] ?? TIER_LIMITS.free) + topupCredits;
    const creditsRemaining = Math.max(0, Math.floor(creditLimit - creditsUsed));

    res.setHeader("x-pordl-credits-limit", creditLimit);
    res.setHeader("x-pordl-credits-used", Math.round(creditsUsed));
    res.setHeader("x-pordl-credits-remaining", creditsRemaining);

    if (creditsUsed >= creditLimit) {
      res.status(429).json({
        error: {
          message:
            `Monthly credit allowance of ${creditLimit.toLocaleString()} reached. ` +
            `PORDL never auto-charges: upgrade or buy a one-time top-up at https://pordl.dev/#pricing`,
          type: "rate_limit_error",
          code: "credits_exhausted",
          usage: {
            credits_used: Math.round(creditsUsed),
            credits_limit: creditLimit,
            tier,
          },
        },
      });
      return;
    }

    // ── Per-key concurrency limit ──
    const concLimit = CONCURRENCY_LIMITS[tier] ?? CONCURRENCY_LIMITS.free;
    const slot = await acquireConcurrencySlot(apiKey.id, concLimit);
    if (!slot.ok) {
      res.status(429).json({
        error: {
          message: `Too many concurrent requests. ${tier} tier allows ${concLimit} in-flight requests.`,
          type: "rate_limit_error",
          code: "concurrency_limit_exceeded",
        },
      });
      return;
    }
    res.once("close", slot.release);

    // Fire-and-forget: key-sharing heuristic
    checkIpDiversity(req).catch(() => {});

    next();
  } catch (err) {
    console.error("[Usage] Error checking limits:", err);
    // Fail open — don't block requests if usage check fails
    next();
  }
}
