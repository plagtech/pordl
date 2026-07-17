/**
 * Request cache using Redis.
 *
 * V1: Exact-match cache (hash the messages array).
 * V2: Semantic cache using embeddings (higher hit rate, costs a tiny embedding call).
 *
 * Even exact-match caching saves significant money on repeated queries
 * (chatbots, data extraction pipelines, FAQ systems).
 */

import { createHash } from "crypto";
import { config } from "../config";

// ── Redis client (lazy init) ───────────────────────────

let redis: import("ioredis").default | null = null;

// Shared Redis client — also used by the moderation verdict cache,
// concurrency limiter, and signup guardrails.
export async function getRedis() {
  if (redis) return redis;
  if (!config.redis.url) return null;

  const Redis = (await import("ioredis")).default;
  redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 100, 3000),
  });

  redis.on("error", (err) => {
    console.error("[Cache] Redis error:", err.message);
  });

  redis.on("connect", () => {
    console.log("[Cache] Redis connected");
  });

  return redis;
}

// ── Cache key generation ───────────────────────────────

function generateCacheKey(
  messages: Array<{ role: string; content: string }>,
  model?: string
): string {
  const payload = JSON.stringify({ messages, model: model || "auto" });
  const hash = createHash("sha256").update(payload).digest("hex");
  return `pd:cache:${hash}`;
}

// ── Cache operations ───────────────────────────────────

export interface CachedResponse {
  response: unknown; // OpenAI-format response object
  provider: string;
  model: string;
  originalCostUsd: number;
  cachedAt: number;
}

export async function getCached(
  messages: Array<{ role: string; content: string }>,
  model?: string
): Promise<CachedResponse | null> {
  try {
    const client = await getRedis();
    if (!client) return null;

    const key = generateCacheKey(messages, model);
    const data = await client.get(key);

    if (!data) return null;

    const parsed = JSON.parse(data) as CachedResponse;

    // Check if cache entry is still fresh
    const ageSeconds = (Date.now() - parsed.cachedAt) / 1000;
    if (ageSeconds > config.cache.ttl) {
      await client.del(key);
      return null;
    }

    return parsed;
  } catch (err) {
    console.error("[Cache] Get error:", err);
    return null;
  }
}

export async function setCache(
  messages: Array<{ role: string; content: string }>,
  model: string | undefined,
  response: unknown,
  provider: string,
  resolvedModel: string,
  costUsd: number
): Promise<void> {
  try {
    const client = await getRedis();
    if (!client) return;

    // Don't cache very long responses (they're probably unique)
    const responseStr = JSON.stringify(response);
    const estimatedTokens = responseStr.length / 4;
    if (estimatedTokens > config.cache.maxTokens) return;

    const key = generateCacheKey(messages, model);
    const entry: CachedResponse = {
      response,
      provider,
      model: resolvedModel,
      originalCostUsd: costUsd,
      cachedAt: Date.now(),
    };

    await client.setex(key, config.cache.ttl, JSON.stringify(entry));
  } catch (err) {
    console.error("[Cache] Set error:", err);
  }
}

// ── Cache stats ────────────────────────────────────────

export async function getCacheStats(): Promise<{
  connected: boolean;
  keyCount: number;
}> {
  try {
    const client = await getRedis();
    if (!client) return { connected: false, keyCount: 0 };

    const keys = await client.keys("pd:cache:*");
    return { connected: true, keyCount: keys.length };
  } catch {
    return { connected: false, keyCount: 0 };
  }
}

// ── Rate limiter (also uses Redis) ─────────────────────

export async function checkRateLimit(
  apiKeyId: string,
  maxPerMinute: number = 60
): Promise<{ allowed: boolean; remaining: number; resetMs: number }> {
  try {
    const client = await getRedis();
    if (!client) return { allowed: true, remaining: maxPerMinute, resetMs: 0 };

    const key = `pd:rate:${apiKeyId}`;
    const count = await client.incr(key);

    if (count === 1) {
      await client.expire(key, 60);
    }

    const ttl = await client.ttl(key);

    return {
      allowed: count <= maxPerMinute,
      remaining: Math.max(0, maxPerMinute - count),
      resetMs: ttl * 1000,
    };
  } catch {
    return { allowed: true, remaining: maxPerMinute, resetMs: 0 };
  }
}
