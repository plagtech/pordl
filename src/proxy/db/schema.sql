/*
  Run this SQL in your Supabase SQL Editor to create the schema.
  Dashboard → SQL Editor → New Query → Paste → Run
*/

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  tier TEXT DEFAULT 'free' CHECK (tier IN ('free', 'starter', 'pro', 'scale', 'enterprise')),
  stripe_customer_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- API Keys table
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  key_hash TEXT UNIQUE NOT NULL,
  key_prefix TEXT NOT NULL,
  label TEXT DEFAULT 'default',
  tier TEXT DEFAULT 'free',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Usage logs table (this is your money — tracks every request)
CREATE TABLE IF NOT EXISTS usage_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  api_key_id UUID REFERENCES api_keys(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd NUMERIC(10, 6) DEFAULT 0,
  cached BOOLEAN DEFAULT FALSE,
  latency_ms INTEGER DEFAULT 0,
  routing_mode TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_key_date ON usage_logs(api_key_id, created_at DESC);

-- Row Level Security (enable but allow service key full access)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;

-- Service role policies (your backend uses service key)
CREATE POLICY "Service full access users" ON users FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "Service full access keys" ON api_keys FOR ALL USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "Service full access logs" ON usage_logs FOR ALL USING (TRUE) WITH CHECK (TRUE);

-- Monthly usage view (useful for dashboard)
CREATE OR REPLACE VIEW monthly_usage AS
SELECT
  user_id,
  DATE_TRUNC('month', created_at) AS month,
  COUNT(*) AS total_requests,
  SUM(CASE WHEN cached THEN 1 ELSE 0 END) AS cached_requests,
  SUM(input_tokens) AS total_input_tokens,
  SUM(output_tokens) AS total_output_tokens,
  SUM(cost_usd) AS total_cost,
  AVG(latency_ms) AS avg_latency_ms
FROM usage_logs
GROUP BY user_id, DATE_TRUNC('month', created_at);
