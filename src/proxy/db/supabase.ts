import { createClient } from "@supabase/supabase-js";
import { config, creditsForCost } from "../config";

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
  aup_accepted_at: string | null;
  confirmed_18_plus: boolean;
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
  flagged_for_review: boolean;
  suspended_at: string | null;
  created_at: string;
}

// PRIVACY INVARIANT: usage logs are metadata only — never add prompt or
// completion content fields to this interface.
export interface UsageLog {
  id?: string;
  user_id: string;
  api_key_id: string;
  provider: string;
  model: string;
  requested_model: string | null; // what the client asked for ("auto" → null)
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  credits: number; // cost-based credits burned (cost / CREDIT_UNIT_COST_USD)
  cached: boolean;
  latency_ms: number;
  created_at?: string;
}

// Key events: moderation flags, IP-diversity flags, suspensions.
// PRIVACY INVARIANT: metadata only — timestamp, key, category, action.
export interface KeyEvent {
  id?: string;
  user_id: string;
  api_key_id: string;
  type: "moderation_flag" | "moderation_severe" | "ip_diversity" | "suspension";
  category: string | null;
  action: string;
  created_at?: string;
}

// ── User queries ───────────────────────────────────────

export async function createUser(
  email: string,
  passwordHash: string,
  aupAcceptedAt: string,
  confirmed18Plus: boolean
): Promise<User> {
  const { data, error } = await supabase
    .from("users")
    .insert({
      email,
      password_hash: passwordHash,
      tier: "free",
      aup_accepted_at: aupAcceptedAt,
      confirmed_18_plus: confirmed18Plus,
    })
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

// ── Key events (moderation / abuse flags) ──────────────

export async function logKeyEvent(event: KeyEvent): Promise<void> {
  const { error } = await supabase.from("key_events").insert(event);
  if (error) console.error("[KeyEvents] insert failed:", error.message);
}

export async function flagApiKeyForReview(keyId: string): Promise<void> {
  await supabase
    .from("api_keys")
    .update({ flagged_for_review: true })
    .eq("id", keyId);
}

export async function suspendApiKey(keyId: string): Promise<void> {
  await supabase
    .from("api_keys")
    .update({ suspended_at: new Date().toISOString() })
    .eq("id", keyId);
}

export async function countRecentSevereEvents(
  keyId: string,
  days: number = 30
): Promise<number> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { count } = await supabase
    .from("key_events")
    .select("id", { count: "exact", head: true })
    .eq("api_key_id", keyId)
    .eq("type", "moderation_severe")
    .gte("created_at", since);
  return count ?? 0;
}

// ── Usage queries ──────────────────────────────────────

export async function logUsage(log: UsageLog): Promise<void> {
  await supabase.from("usage_logs").insert(log);
}

// Credits used this calendar month. Derived from actual provider cost
// (credits = cost / CREDIT_UNIT_COST_USD), so the decrement is exact even
// if per-row credit values drift from rounding.
export async function getMonthlyCreditsUsed(userId: string): Promise<number> {
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const { data } = await supabase
    .from("monthly_usage")
    .select("total_cost")
    .eq("user_id", userId)
    .gte("month", startOfMonth.toISOString());

  if (!data) return 0;
  const totalCost = data.reduce((sum, row) => sum + (Number(row.total_cost) || 0), 0);
  return creditsForCost(totalCost);
}

// One-time top-up credits purchased this calendar month (explicit purchases
// only — never auto-charged). They extend the month's allowance.
export async function getMonthlyTopupCredits(userId: string): Promise<number> {
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const { data } = await supabase
    .from("credit_topups")
    .select("credits")
    .eq("user_id", userId)
    .gte("created_at", startOfMonth.toISOString());

  if (!data) return 0;
  return data.reduce((sum, row) => sum + (Number(row.credits) || 0), 0);
}

export async function recordTopup(
  userId: string,
  credits: number,
  stripeSessionId: string
): Promise<void> {
  const { error } = await supabase.from("credit_topups").insert({
    user_id: userId,
    credits,
    stripe_session_id: stripeSessionId,
  });
  if (error) console.error("[Topup] insert failed:", error.message);
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
