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
    ttl: parseInt(optional("CACHE_TTL_SECONDS", "3600")),
    maxTokens: parseInt(optional("MAX_CACHE_ENTRY_TOKENS", "4000")),
  },
};

// Monthly token limits per tier
export const TIER_LIMITS: Record<string, number> = {
  free: 100_000,
  creator: 1_000_000,
  creator_pro: 5_000_000,
  creator_ultra: 15_000_000,
};