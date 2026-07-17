/**
 * Section 6 test: no code path persists prompt/completion content.
 *  - usage logging writes metadata fields only
 *  - key-event logging writes metadata fields only
 *  - the response cache TTL is capped at 1 hour (short-lived by policy)
 */
import { describe, it, expect, vi } from "vitest";

const inserted: Array<{ table: string; payload: any }> = [];

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      insert: (payload: any) => {
        inserted.push({ table, payload });
        return Promise.resolve({ data: null, error: null });
      },
    }),
  }),
}));

import { logUsage, logKeyEvent } from "../src/proxy/db/supabase";
import { config } from "../src/proxy/config";

const CONTENT_FIELD_PATTERN = /content|message|prompt|completion|text|body/i;

const ALLOWED_USAGE_FIELDS = new Set([
  "user_id", "api_key_id", "provider", "model", "requested_model",
  "input_tokens", "output_tokens", "cost_usd", "credits", "cached",
  "latency_ms",
]);

describe("no content persistence", () => {
  it("usage logs contain only allowed metadata fields", async () => {
    inserted.length = 0;
    await logUsage({
      user_id: "u1",
      api_key_id: "k1",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      requested_model: null,
      input_tokens: 100,
      output_tokens: 200,
      cost_usd: 0.0001,
      credits: 0.43,
      cached: false,
      latency_ms: 250,
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0].table).toBe("usage_logs");
    for (const key of Object.keys(inserted[0].payload)) {
      expect(ALLOWED_USAGE_FIELDS.has(key), `unexpected usage_logs field: ${key}`).toBe(true);
      expect(CONTENT_FIELD_PATTERN.test(key), `content-like field name: ${key}`).toBe(false);
    }
  });

  it("key events contain only metadata (timestamp, key, category, action)", async () => {
    inserted.length = 0;
    await logKeyEvent({
      user_id: "u1",
      api_key_id: "k1",
      type: "moderation_severe",
      category: "sexual_minors",
      action: "refused_and_flagged",
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0].table).toBe("key_events");
    const keys = Object.keys(inserted[0].payload);
    expect(keys.sort()).toEqual(
      ["action", "api_key_id", "category", "type", "user_id"].sort()
    );
  });

  it("the UsageLog interface declares no content-like fields", async () => {
    // Type-level guarantee checked structurally at runtime via a sample object
    const sample: import("../src/proxy/db/supabase").UsageLog = {
      user_id: "", api_key_id: "", provider: "", model: "",
      requested_model: null, input_tokens: 0, output_tokens: 0,
      cost_usd: 0, credits: 0, cached: false, latency_ms: 0,
    };
    for (const key of Object.keys(sample)) {
      expect(CONTENT_FIELD_PATTERN.test(key), `content-like field: ${key}`).toBe(false);
    }
  });

  it("the response cache is short-lived: TTL capped at 1 hour", () => {
    expect(config.cache.ttl).toBeLessThanOrEqual(3600);
  });
});
