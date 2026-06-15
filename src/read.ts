/**
 * pordl 🚪 — /read  (Fast-path v1)
 * ---------------------------------------------------------------------------
 * The open-knowledge read gateway. One endpoint: fetch a permitted source and
 * return it as clean LLM-ready markdown. Clean by construction — it only reads
 * sources whose license affirmatively permits reuse (see allowlist.ts), so the
 * ToS question doesn't get managed, it doesn't arise.
 *
 * Standalone product. No shared deployment, wallet, or revenue path with
 * anything else — the SSRF guard below is duplicated into this repo on purpose
 * (no shared package = no coupling). x402 + the Coinbase CDP facilitator are
 * open rails, like Stripe; using them mingles nothing.
 *
 * Mount behind your x402 metering middleware (its own wallet), e.g.:
 *   app.use('/read', x402Meter({ price: '0.005', payTo: PORDL_WALLET }), readRouter)
 *
 * Deps:  npm i undici jsdom @mozilla/readability turndown
 *        (.npmrc: legacy-peer-deps=true)
 */

import { Router, type Request, type Response } from 'express';
import { Agent, fetch as uFetch } from 'undici';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { isAllowedHost, matchSource } from './allowlist';

// ---------------------------------------------------------------------------
// 1. SSRF — IP classification (one source of truth; do not also keep a copy
//    elsewhere). The important part is connect-time validation (the custom
//    `lookup` below): a guard that only checks the URL before fetching is
//    defeated by DNS rebinding between check and connect, and by a redirect
//    into a private range. Validating at connect closes both.
// ---------------------------------------------------------------------------
function isPublicIpv4(ip: string): boolean {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = o;
  if (a === 0) return false;                        // 0.0.0.0/8
  if (a === 10) return false;                       // private
  if (a === 127) return false;                      // loopback
  if (a === 169 && b === 254) return false;         // link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false;         // private
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 192 && b === 0 && o[2] === 0) return false; // 192.0.0.0/24
  if (a >= 224) return false;                       // multicast + reserved
  return true;
}
function isPublicIpv6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return false;
  if (s.startsWith('fe80') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return false; // fe80::/10
  if (s.startsWith('fc') || s.startsWith('fd')) return false; // ULA fc00::/7
  const m = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isPublicIpv4(m[1]);
  return true;
}
function isPublicIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPublicIpv4(ip);
  if (v === 6) return isPublicIpv6(ip);
  return false;
}

const safeDispatcher = new Agent({
  connect: {
    lookup: (hostname: string, options: any, cb: any) => {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses: any) => {
        if (err) return cb(err, '', 0);
        const list = Array.isArray(addresses) ? addresses : [addresses];
        for (const a of list) {
          if (!isPublicIp(a.address)) return cb(new Error(`SSRF blocked: non-public IP ${a.address}`), '', 0);
        }
        cb(null, options?.all ? list : list[0].address, options?.all ? undefined : list[0].family);
      });
    },
  },
});

// ---------------------------------------------------------------------------
// 2. PER-DOMAIN RATE LIMIT — protects you from a CALLER trying to bulk-extract
//    one source through you. In-memory = single instance; Redis if you scale.
// ---------------------------------------------------------------------------
const CAP = 10;
const REFILL_PER_SEC = 1;
const buckets = new Map<string, { tokens: number; last: number }>();
function takeToken(domain: string): boolean {
  const now = Date.now();
  const b = buckets.get(domain) ?? { tokens: CAP, last: now };
  b.tokens = Math.min(CAP, b.tokens + ((now - b.last) / 1000) * REFILL_PER_SEC);
  b.last = now;
  if (b.tokens < 1) { buckets.set(domain, b); return false; }
  b.tokens -= 1;
  buckets.set(domain, b);
  return true;
}

// ---------------------------------------------------------------------------
// 3. CACHE — short-TTL, per-URL. Bill full price, serve at ~zero marginal cost.
//    Per-URL and short-lived: NOT an accumulating corpus.
// ---------------------------------------------------------------------------
const DEFAULT_TTL = 300;
const MAX_TTL = 3600;
const CACHE_MAX_ENTRIES = 5000;
type ReadResult = {
  url: string; title: string | null; byline: string | null; excerpt: string | null;
  markdown: string; length: number; source: string | null; license: string | null;
};
const cache = new Map<string, { value: ReadResult; expires: number }>();
function cacheGet(key: string): ReadResult | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { cache.delete(key); return null; }
  return e.value;
}
function cacheSet(key: string, value: ReadResult, ttlSec: number) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + ttlSec * 1000 });
}

// ---------------------------------------------------------------------------
// 4. FETCH — capped, timed, manual redirects re-validated against the allowlist
// ---------------------------------------------------------------------------
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const UA = 'PordlBot/1.0 (+https://pordl.dev)';

class ReadError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

async function readBodyCapped(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { reader.cancel(); throw new ReadError(413, 'Response too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function safeFetchHtml(startUrl: string): Promise<{ html: string; finalUrl: string }> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ReadError(400, 'Only http(s) URLs');
    if (!isAllowedHost(u.hostname)) throw new ReadError(403, `Host not on allowlist: ${u.hostname}`);

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let resp;
    try {
      resp = await uFetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        dispatcher: safeDispatcher,
        headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      });
    } catch (e: any) {
      throw new ReadError(502, `Upstream fetch failed: ${e?.message ?? 'error'}`);
    } finally {
      clearTimeout(t);
    }

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) throw new ReadError(502, 'Redirect without Location');
      current = new URL(loc, current).toString();   // loop re-validates scheme + allowlist
      continue;
    }
    if (!resp.ok) throw new ReadError(502, `Upstream ${resp.status}`);

    const ct = resp.headers.get('content-type') ?? '';
    if (!ct.includes('text/html') && !ct.includes('text/plain') && !ct.includes('xml'))
      throw new ReadError(415, `Unsupported content-type: ${ct || 'unknown'}`);

    const html = await readBodyCapped(resp.body as any);
    return { html, finalUrl: current };
  }
  throw new ReadError(508, 'Too many redirects');
}

// ---------------------------------------------------------------------------
// 5. EXTRACT — Readability -> markdown. jsdom runs NO scripts and loads NO
//    subresources by default; do NOT enable runScripts/resources.
// ---------------------------------------------------------------------------
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
function extract(html: string, url: string): Omit<ReadResult, 'source' | 'license'> | null {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  if (!article?.content) return null;
  const markdown = turndown.turndown(article.content).trim();
  if (!markdown) return null;
  return {
    url,
    title: article.title ?? null,
    byline: article.byline ?? null,
    excerpt: article.excerpt ?? null,
    markdown,
    length: markdown.length,
  };
}

// ---------------------------------------------------------------------------
// 6. ROUTE
// ---------------------------------------------------------------------------
export const readRouter = Router();

readRouter.get('/health', (_req, res) => res.json({ ok: true, service: 'pordl', tier: 'fast' }));

readRouter.post('/', async (req: Request, res: Response) => {
  const { url, max_age } = (req.body ?? {}) as { url?: string; max_age?: number };

  if (typeof url !== 'string' || !url) return res.status(400).json({ error: 'Body must include "url" (string).' });

  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return res.status(400).json({ error: 'Malformed URL.' }); }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return res.status(400).json({ error: 'Only http(s) URLs are supported.' });
  if (!isAllowedHost(parsed.hostname))
    return res.status(403).json({ error: `Host not on pordl's open-content allowlist: ${parsed.hostname}` });
  if (!takeToken(parsed.hostname))
    return res.status(429).json({ error: `Rate limit for ${parsed.hostname}. Slow down.` });

  const ttl = Math.min(MAX_TTL, Math.max(0, typeof max_age === 'number' ? max_age : DEFAULT_TTL));
  const key = parsed.toString();

  if (ttl > 0) {
    const hit = cacheGet(key);
    if (hit) return res.json(envelope(hit, true));
  }

  try {
    const { html, finalUrl } = await safeFetchHtml(parsed.toString());
    const base = extract(html, finalUrl);
    if (!base)
      return res.status(422).json({
        error: 'Could not extract readable content (likely a JS-rendered page).',
        hint: 'A render tier is not enabled in v1.',
      });
    const src = matchSource(new URL(finalUrl).hostname);  // attribution passthrough
    const result: ReadResult = { ...base, source: src?.attribution ?? null, license: src?.license ?? null };
    if (ttl > 0) cacheSet(key, result, ttl);
    return res.json(envelope(result, false));
  } catch (e) {
    if (e instanceof ReadError) return res.status(e.status).json({ error: e.message });
    return res.status(500).json({ error: 'Internal error.' });
  }
});

// Attribution is part of the product, not an afterthought: every response
// carries the source + license so anything reusing CC content can comply.
function envelope(r: ReadResult, cached: boolean) {
  return {
    ...r,
    cached,
    _pordl: { tier: 'fast', docs: 'https://pordl.dev/docs' },
  };
}
