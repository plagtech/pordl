import { createClient } from "@supabase/supabase-js";
import { config } from "../config";

export const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceKey
);

// ── Types ──────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  tier: string;
  stripe_customer_id: string | null;
  created_at: string;
}

export interface ApiKey {
  id: string;
  user_id: string;
  key_hash: string;
  key_prefix: string; // "pd_abc..." for display
  label: string;
  tier: string;
  is_active: boolean;
  created_at: string;
}

export interface UsageLog {
  id?: string;
  user_id: string;
  api_key_id: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cached: boolean;
  latency_ms: number;
  created_at?: string;
}

// ── User queries ───────────────────────────────────────

export async function createUser(
  email: string,
  passwordHash: string
): Promise<User> {
  const { data, error } = await supabase
    .from("users")
    .insert({ email, password_hash: passwordHash, tier: "free" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const { data } = await supabase
    .from("users")
    .select()
    .eq("email", email)
    .single();
  return data;
}

export async function updateUserTier(
  userId: string,
  tier: string,
  stripeCustomerId?: string
): Promise<void> {
  const update: Record<string, unknown> = { tier };
  if (stripeCustomerId) update.stripe_customer_id = stripeCustomerId;
  await supabase.from("users").update(update).eq("id", userId);
}

// ── API Key queries ────────────────────────────────────

export async function createApiKey(
  userId: string,
  keyHash: string,
  keyPrefix: string,
  label: string,
  tier: string
): Promise<ApiKey> {
  const { data, error } = await supabase
    .from("api_keys")
    .insert({
      user_id: userId,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      label,
      tier,
      is_active: true,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getApiKeyByHash(
  keyHash: string
): Promise<(ApiKey & { user: User }) | null> {
  const { data } = await supabase
    .from("api_keys")
    .select("*, user:users(*)")
    .eq("key_hash", keyHash)
    .eq("is_active", true)
    .single();
  return data;
}

export async function revokeApiKey(keyId: string): Promise<void> {
  await supabase.from("api_keys").update({ is_active: false }).eq("id", keyId);
}

// ── Usage queries ──────────────────────────────────────

export async function logUsage(log: UsageLog): Promise<void> {
  await supabase.from("usage_logs").insert(log);
}

// Total tokens (input + output) used this calendar month.
// Tier limits are token-based, so this must count tokens, not requests.
export async function getMonthlyUsage(userId: string): Promise<number> {
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const { data } = await supabase
    .from("monthly_usage")
    .select("total_input_tokens, total_output_tokens")
    .eq("user_id", userId)
    .gte("month", startOfMonth.toISOString());

  if (!data) return 0;
  return data.reduce(
    (sum, row) =>
      sum + (row.total_input_tokens || 0) + (row.total_output_tokens || 0),
    0
  );
}

export async function getUsageStats(
  userId: string,
  days: number = 30
): Promise<{
  totalRequests: number;
  totalCost: number;
  totalSaved: number;
  cacheHitRate: number;
  byProvider: Record<string, number>;
}> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data } = await supabase
    .from("usage_logs")
    .select("*")
    .eq("user_id", userId)
    .gte("created_at", since.toISOString());

  if (!data || data.length === 0) {
    return {
      totalRequests: 0,
      totalCost: 0,
      totalSaved: 0,
      cacheHitRate: 0,
      byProvider: {},
    };
  }

  const cached = data.filter((d) => d.cached).length;
  const byProvider: Record<string, number> = {};
  let totalCost = 0;

  for (const row of data) {
    totalCost += row.cost_usd;
    byProvider[row.provider] = (byProvider[row.provider] || 0) + 1;
  }

  return {
    totalRequests: data.length,
    totalCost,
    totalSaved: totalCost * 0.55, // estimated savings vs direct OpenAI pricing
    cacheHitRate: data.length > 0 ? cached / data.length : 0,
    byProvider,
  };
}
