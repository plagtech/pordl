/*
  MIGRATION 001 — AUP-acceptance and age-confirmation tracking on users.
  APPLIED to production (Supabase project "pordl") on 2026-07-16.
  Fresh installs: run schema.sql, then 001 and 002 in order.
*/

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS aup_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmed_18_plus BOOLEAN DEFAULT FALSE;

-- Backfill note: existing users have NULL aup_accepted_at. They should be
-- prompted to accept the AUP on next login/dashboard visit; new signups
-- always have it set.
