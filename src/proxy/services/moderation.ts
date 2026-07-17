/**
 * Universal content-safety gate (refuse, never reroute).
 *
 * Every chat message is screened with Llama Guard (via a US-hosted
 * OpenAI-compatible inference API, default Groq) BEFORE the request is
 * forwarded to any provider. Flagged requests are refused with a neutral
 * HTTP 400 `content_policy` error. The gate FAILS CLOSED: if the classifier
 * is unavailable or unconfigured, requests are refused with a 503 rather
 * than forwarded unscreened.
 *
 * Verdicts are hash-cached in Redis per message (SHA-256 of the content),
 * so multi-turn conversations only screen the newest message each turn.
 *
 * PRIVACY INVARIANT: this module never logs or persists message content —
 * only hashes, category codes, and actions.
 */

import { createHash } from "crypto";
import { config } from "../config";
import { getRedis } from "./cache";

// Llama Guard hazard taxonomy (S1–S14) → human-readable category names
export const HAZARD_CATEGORIES: Record<string, string> = {
  S1: "violent_crimes",
  S2: "non_violent_crimes",
  S3: "sex_related_crimes",
  S4: "sexual_minors", // child sexual exploitation — always severe
  S5: "defamation",
  S6: "specialized_advice",
  S7: "privacy",
  S8: "intellectual_property",
  S9: "indiscriminate_weapons",
  S10: "hate",
  S11: "self_harm",
  S12: "adult_sexual_content",
  S13: "elections",
  S14: "code_interpreter_abuse",
};

// Category that additionally flags the API key for review
export const SEVERE_CATEGORIES = new Set(["S4"]);

export interface ModerationVerdict {
  flagged: boolean;
  categories: string[]; // hazard codes, e.g. ["S4"]
  severe: boolean;
}

export class ModerationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModerationUnavailableError";
  }
}

// Injectable for tests — never override in production code.
export const _deps = {
  fetchFn: (...args: Parameters<typeof fetch>) => fetch(...args),
};

function messageHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function getCachedVerdict(hash: string): Promise<ModerationVerdict | null> {
  try {
    const client = await getRedis();
    if (!client) return null;
    const raw = await client.get(`pd:mod:${hash}`);
    return raw ? (JSON.parse(raw) as ModerationVerdict) : null;
  } catch {
    return null; // cache miss on error — we just re-screen
  }
}

async function setCachedVerdict(hash: string, verdict: ModerationVerdict): Promise<void> {
  try {
    const client = await getRedis();
    if (!client) return;
    await client.setex(
      `pd:mod:${hash}`,
      config.moderation.verdictTtl,
      JSON.stringify(verdict)
    );
  } catch {
    // best-effort cache
  }
}

// Trim very long messages to a bounded screening budget: keep the head and
// tail (where instructions usually live) rather than truncating blindly.
function screeningSlice(content: string): string {
  const max = config.moderation.maxScreenChars;
  if (content.length <= max) return content;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return content.slice(0, head) + "\n[...]\n" + content.slice(-tail);
}

// Classify a single message with Llama Guard. Response format is
// "safe" or "unsafe\nS1,S4" — anything unparseable fails closed.
async function classify(content: string): Promise<ModerationVerdict> {
  const { apiKey, baseUrl, model } = config.moderation;
  if (!apiKey) {
    throw new ModerationUnavailableError(
      "MODERATION_API_KEY is not configured — content-safety gate is mandatory, refusing request"
    );
  }

  const resp = await _deps.fetchFn(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: screeningSlice(content) }],
      max_tokens: 32,
      temperature: 0,
    }),
  });

  if (!resp.ok) {
    throw new ModerationUnavailableError(
      `Moderation provider returned ${resp.status}`
    );
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = (data.choices?.[0]?.message?.content || "").trim().toLowerCase();

  if (text.startsWith("safe")) {
    return { flagged: false, categories: [], severe: false };
  }
  if (text.startsWith("unsafe")) {
    const codes = (text.match(/s\d{1,2}/g) || []).map((c) => c.toUpperCase());
    const blocked = codes.filter(
      (c) => config.moderation.blockedCategories.includes(c) || SEVERE_CATEGORIES.has(c)
    );
    if (blocked.length === 0) {
      // Unsafe per Llama Guard, but only in categories we permit
      // (e.g. S12 adult fiction) — allow.
      return { flagged: false, categories: codes, severe: false };
    }
    return {
      flagged: true,
      categories: blocked,
      severe: blocked.some((c) => SEVERE_CATEGORIES.has(c)),
    };
  }

  // Unparseable classifier output → fail closed
  throw new ModerationUnavailableError("Unparseable moderation verdict");
}

/**
 * Screen all messages in a request. Uses the per-message verdict cache, so
 * in an ongoing conversation only the new message hits the classifier.
 * Throws ModerationUnavailableError when screening cannot be performed.
 */
export async function screenMessages(
  messages: Array<{ role: string; content: string }>
): Promise<ModerationVerdict> {
  const result: ModerationVerdict = { flagged: false, categories: [], severe: false };

  for (const msg of messages) {
    if (typeof msg.content !== "string" || msg.content.length === 0) continue;

    const hash = messageHash(msg.content);
    let verdict = await getCachedVerdict(hash);
    if (!verdict) {
      verdict = await classify(msg.content);
      await setCachedVerdict(hash, verdict);
    }

    if (verdict.flagged) {
      result.flagged = true;
      result.severe = result.severe || verdict.severe;
      for (const c of verdict.categories) {
        if (!result.categories.includes(c)) result.categories.push(c);
      }
    }
  }

  return result;
}
