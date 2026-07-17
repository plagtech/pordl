import dotenv from "dotenv";
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  port: parseInt(optional("PORT", "3000")),
  env: optional("NODE_ENV", "development"),

  supabase: {
    url: optional("SUPABASE_URL", ""),
    serviceKey: optional("SUPABASE_SERVICE_KEY", ""),
  },

  redis: {
    url: optional("REDIS_URL", ""),
  },

  stripe: {
    secretKey: optional("STRIPE_SECRET_KEY", ""),
    webhookSecret: optional("STRIPE_WEBHOOK_SECRET", ""),
    prices: {
      creator: optional("STRIPE_PRICE_CREATOR", ""),
      creator_pro: optional("STRIPE_PRICE_CREATOR_PRO", ""),
      creator_ultra: optional("STRIPE_PRICE_CREATOR_ULTRA", ""),
    },
  },

  providers: {
    openai: optional("OPENAI_API_KEY", ""),
    anthropic: optional("ANTHROPIC_API_KEY", ""),
    deepseek: optional("DEEPSEEK_API_KEY", ""),
    google: optional("GOOGLE_API_KEY", ""),
  },

  routing: {
    defaultMode: optional("DEFAULT_ROUTING_MODE", "balanced") as
      | "fast"
      | "balanced"
      | "best",
  },

  cache: {
    // Response cache is capped at 1 hour: cached completions must stay
    // short-lived (privacy policy promises ≤1h, then auto-expire).
    ttl: Math.min(parseInt(optional("CACHE_TTL_SECONDS", "3600")), 3600),
    maxTokens: parseInt(optional("MAX_CACHE_ENTRY_TOKENS", "4000")),
  },

  moderation: {
    // Llama Guard via a US-hosted OpenAI-compatible inference API.
    // The gate FAILS CLOSED: without a key, chat requests are refused.
    apiKey: optional("MODERATION_API_KEY", ""),
    baseUrl: optional("MODERATION_BASE_URL", "https://api.groq.com/openai/v1"),
    model: optional("MODERATION_MODEL", "meta-llama/llama-guard-4-12b"),
    // Llama Guard hazard codes that trigger refusal. S4 (child sexual
    // exploitation) is always treated as severe regardless of this list.
    blockedCategories: optional("MODERATION_BLOCKED_CATEGORIES", "S1,S2,S3,S4,S9,S10,S11")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // Per-message screening budget (chars sent to the classifier)
    maxScreenChars: parseInt(optional("MODERATION_MAX_CHARS", "48000")),
    // Verdict hash-cache TTL (seconds)
    verdictTtl: parseInt(optional("MODERATION_VERDICT_TTL", "86400")),
    // Severe hits within 30 days that auto-suspend a key pending review
    severeSuspendThreshold: parseInt(optional("MODERATION_SEVERE_SUSPEND_THRESHOLD", "3")),
  },

  guardrails: {
    maxTokensCeiling: parseInt(optional("MAX_TOKENS_CEILING", "4096")),
    signupsPerIpPerDay: parseInt(optional("SIGNUPS_PER_IP_PER_DAY", "3")),
    signupsPerDomainPerDay: parseInt(optional("SIGNUPS_PER_DOMAIN_PER_DAY", "20")),
    // Distinct IPs per key per day before the key is flagged (not banned)
    ipDiversityThreshold: parseInt(optional("IP_DIVERSITY_THRESHOLD", "10")),
  },

  topup: {
    stripePrice: optional("STRIPE_PRICE_TOPUP", ""),
    credits: parseInt(optional("TOPUP_CREDITS", "1000000")),
  },
};

// ── Credit metering ─────────────────────────────────────
// 1 credit = 1 budget-model token: the provider cost of one
// deepseek-v4-flash token at a 1:2 input:output blend.
//   ($0.14 + 2 × $0.28) / 3 per MTok = $0.2333/MTok → $2.3333e-7 per credit
// Every request burns credits = provider cost / CREDIT_UNIT_COST_USD,
// so COGS at full consumption is identical across models and I/O ratios.
export const CREDIT_UNIT_COST_USD = 0.7 / 3 / 1_000_000;

export function creditsForCost(costUsd: number): number {
  return costUsd / CREDIT_UNIT_COST_USD;
}

// Monthly credit allowances per tier (1 credit = 1 budget-model token,
// so the numbers match the previously advertised token allowances)
export const TIER_LIMITS: Record<string, number> = {
  free: 100_000,
  creator: 1_000_000,
  creator_pro: 5_000_000,
  creator_ultra: 15_000_000,
};

// Concurrent in-flight requests per key, by tier
export const CONCURRENCY_LIMITS: Record<string, number> = {
  free: 2,
  creator: 4,
  creator_pro: 8,
  creator_ultra: 16,
};