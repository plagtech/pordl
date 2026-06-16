/**
 * snapshot-store.ts — persistence for /watch.
 * ---------------------------------------------------------------------------
 * /watch compares a page now against the last time it was seen, so it MUST
 * persist snapshots across calls. The in-memory default below works for local
 * testing but does NOT survive redeploys or span instances — for a real
 * monitoring product, use the Supabase implementation (sketch at the bottom).
 */

export type Snapshot = { url: string; hash: string; markdown: string; checkedAt: string };

// ---- In-memory default (testing only) ------------------------------------
const mem = new Map<string, Snapshot>();
export async function getSnapshot(url: string): Promise<Snapshot | null> {
  return mem.get(url) ?? null;
}
export async function setSnapshot(url: string, snap: Snapshot): Promise<void> {
  mem.set(url, snap);
}

/* ---- Supabase production version (recommended for /watch) ----------------
   1) Create a SEPARATE Supabase project for pordl (don't reuse Spraay's).
   2) Run this SQL:
        create table watch_snapshots (
          url        text primary key,
          hash       text        not null,
          markdown   text        not null,
          checked_at timestamptz not null default now()
        );
   3) npm i @supabase/supabase-js  and set SUPABASE_URL + SUPABASE_SERVICE_KEY.
   4) Replace the in-memory functions above with:

   import { createClient } from '@supabase/supabase-js';
   const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

   export async function getSnapshot(url: string): Promise<Snapshot | null> {
     const { data } = await sb.from('watch_snapshots').select('*').eq('url', url).maybeSingle();
     return data ? { url: data.url, hash: data.hash, markdown: data.markdown, checkedAt: data.checked_at } : null;
   }
   export async function setSnapshot(url: string, snap: Snapshot): Promise<void> {
     await sb.from('watch_snapshots').upsert({
       url: snap.url, hash: snap.hash, markdown: snap.markdown, checked_at: snap.checkedAt,
     });
   }
*/
