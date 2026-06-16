/**
 * snapshot-store.ts — Supabase-backed persistence for /watch.
 * ---------------------------------------------------------------------------
 * Durable across redeploys and instances. Uses the SERVICE ROLE key, which
 * bypasses RLS — so RLS can stay enabled on the table with no policies, and
 * the public anon key still can't touch watch_snapshots.
 *
 * Required env:
 *   SUPABASE_URL          — Project URL (Settings → API)
 *   SUPABASE_SERVICE_KEY  — service_role secret key (NOT the anon key)
 *
 * Table (run in Supabase SQL editor, RLS enabled, no policies):
 *   create table watch_snapshots (
 *     url        text primary key,
 *     hash       text        not null,
 *     markdown   text        not null,
 *     checked_at timestamptz not null default now()
 *   );
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type Snapshot = { url: string; hash: string; markdown: string; checkedAt: string };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// In-memory fallback so the server still boots if Supabase env is missing
// (e.g. local dev). NOT durable — logs a clear warning so it's never a silent
// surprise in production.
const mem = new Map<string, Snapshot>();
let warned = false;
function memWarn() {
  if (!warned) {
    console.warn(
      '[pordl] WARNING: SUPABASE_URL / SUPABASE_SERVICE_KEY not set — /watch is ' +
      'using the in-memory store. Snapshots will NOT survive a redeploy. Set both ' +
      'vars for durable monitoring.'
    );
    warned = true;
  }
}

let sb: SupabaseClient | null = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
  console.log('[pordl] /watch persistence: Supabase (durable).');
} else {
  memWarn();
}

export async function getSnapshot(url: string): Promise<Snapshot | null> {
  if (!sb) {
    return mem.get(url) ?? null;
  }
  const { data, error } = await sb
    .from('watch_snapshots')
    .select('url, hash, markdown, checked_at')
    .eq('url', url)
    .maybeSingle();
  if (error) {
    // Don't crash a /watch call on a transient DB error — treat as "no prior"
    // but surface it in logs so you can see if Supabase is misconfigured.
    console.error('[pordl] getSnapshot error:', error.message);
    return null;
  }
  if (!data) return null;
  return {
    url: data.url,
    hash: data.hash,
    markdown: data.markdown,
    checkedAt: data.checked_at,
  };
}

export async function setSnapshot(url: string, snap: Snapshot): Promise<void> {
  if (!sb) {
    mem.set(url, snap);
    return;
  }
  const { error } = await sb.from('watch_snapshots').upsert(
    {
      url: snap.url,
      hash: snap.hash,
      markdown: snap.markdown,
      checked_at: snap.checkedAt,
    },
    { onConflict: 'url' }
  );
  if (error) {
    // Log but don't throw — a failed write shouldn't 500 the user's read.
    // (Trade-off: a dropped write means the next call re-baselines. Acceptable.)
    console.error('[pordl] setSnapshot error:', error.message);
  }
}
