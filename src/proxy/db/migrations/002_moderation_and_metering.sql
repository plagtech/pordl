/*
  MIGRATION 002 — moderation gate + credit metering.
  APPLIED to production (Supabase project "pordl") on 2026-07-16.
  Fresh installs: run schema.sql, then 001 and 002 in order.

  PRIVACY INVARIANT: no table here stores prompt or completion content —
  only timestamps, key IDs, categories, and actions.
*/

-- Key flags + suspension (severe moderation hits, IP-diversity heuristic)
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS flagged_for_review BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;

-- Metadata-only event log: moderation flags, severe hits, IP-diversity
-- flags, suspensions. NEVER add content columns to this table.
CREATE TABLE IF NOT EXISTS key_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  api_key_id UUID REFERENCES api_keys(id),
  type TEXT NOT NULL CHECK (type IN ('moderation_flag', 'moderation_severe', 'ip_diversity', 'suspension')),
  category TEXT,
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_key_events_key_type_date
  ON key_events(api_key_id, type, created_at DESC);

ALTER TABLE key_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service full access key_events" ON key_events FOR ALL USING (TRUE) WITH CHECK (TRUE);

-- Credit metering: cost-based credits + requested-model baseline
ALTER TABLE usage_logs
  ADD COLUMN IF NOT EXISTS requested_model TEXT,
  ADD COLUMN IF NOT EXISTS credits NUMERIC(14, 2) DEFAULT 0;

-- Explicit one-time credit top-ups (never auto-charged)
CREATE TABLE IF NOT EXISTS credit_topups (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  credits NUMERIC(14, 0) NOT NULL,
  stripe_session_id TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_topups_user_date ON credit_topups(user_id, created_at DESC);

ALTER TABLE credit_topups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service full access topups" ON credit_topups FOR ALL USING (TRUE) WITH CHECK (TRUE);
