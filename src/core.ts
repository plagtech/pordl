/**
 * core.ts — shared read engine used by both /read and /watch.
 * ---------------------------------------------------------------------------
 * Extracted so /watch reuses the exact SSRF guard + fetch + extract pipeline
 * instead of duplicating it. read() does the whole pipeline and throws
 * ReadError on any failure.
 *
 * INTEGRATION: this duplicates the guard/fetch logic currently inlined in your
 * deployed read.ts. To keep prod stable, leave read.ts as-is for now and just
 * add this for /watch. Later cleanup: refactor read.ts to import read() from
 * here so there's one engine. (Don't split the SSRF guard across files long-term.)
 */

import { Agent, fetch as uFetch } from 'undici';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { isAllowedHost, matchSource } from './allowlist';

export class ReadError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}
export type ReadResult = {
  url: string; title: string | null; byline: string | null; excerpt: string | null;
  markdown: string; length: number; source: string | null; license: string | null;
};

// --- SSRF: connect-time IP validation (defeats DNS rebind + redirect-to-private)
function isPublicIpv4(ip: string): boolean {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 192 && b === 0 && o[2] === 0) return false;
  if (a >= 224) return false;
  return true;
}
function isPublicIpv6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return false;
  if (s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return false;
  if (s.startsWith('fc') || s.startsWith('fd')) return false;
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
        for (const a of list) if (!isPublicIp(a.address)) return cb(new Error(`SSRF blocked: ${a.address}`), '', 0);
        cb(null, options?.all ? list : list[0].address, options?.all ? undefined : list[0].family);
      });
    },
  },
});

// --- per-domain rate limit (in-memory; Redis if you scale horizontally)
const CAP = 10, REFILL = 1;
const buckets = new Map<string, { tokens: number; last: number }>();
function takeToken(domain: string): boolean {
  const now = Date.now();
  const b = buckets.get(domain) ?? { tokens: CAP, last: now };
  b.tokens = Math.min(CAP, b.tokens + ((now - b.last) / 1000) * REFILL);
  b.last = now;
  if (b.tokens < 1) { buckets.set(domain, b); return false; }
  b.tokens -= 1; buckets.set(domain, b); return true;
}

const TIMEOUT_MS = 10_000, MAX_BYTES = 5 * 1024 * 1024, MAX_REDIRECTS = 5;
const UA = 'PordlBot/1.0 (+https://pordl.dev)';

async function readBodyCapped(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
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
        method: 'GET', redirect: 'manual', signal: ctrl.signal, dispatcher: safeDispatcher,
        headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      });
    } catch (e: any) { throw new ReadError(502, `Upstream fetch failed: ${e?.message ?? 'error'}`); }
    finally { clearTimeout(t); }
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) throw new ReadError(502, 'Redirect without Location');
      current = new URL(loc, current).toString();
      continue;
    }
    if (!resp.ok) throw new ReadError(502, `Upstream ${resp.status}`);
    const ct = resp.headers.get('content-type') ?? '';
    if (!ct.includes('text/html') && !ct.includes('text/plain') && !ct.includes('xml'))
      throw new ReadError(415, `Unsupported content-type: ${ct || 'unknown'}`);
    return { html: await readBodyCapped(resp.body as any), finalUrl: current };
  }
  throw new ReadError(508, 'Too many redirects');
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
function extract(html: string, url: string) {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  if (!article?.content) return null;
  const markdown = turndown.turndown(article.content).trim();
  if (!markdown) return null;
  return {
    url, title: article.title ?? null, byline: article.byline ?? null,
    excerpt: article.excerpt ?? null, markdown, length: markdown.length,
  };
}

/** Full pipeline: parse -> scheme -> allowlist -> rate-limit -> fetch -> extract -> attribute. */
export async function read(rawUrl: string): Promise<ReadResult> {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { throw new ReadError(400, 'Malformed URL.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ReadError(400, 'Only http(s) URLs are supported.');
  if (!isAllowedHost(parsed.hostname)) throw new ReadError(403, `Host not on pordl's allowlist: ${parsed.hostname}`);
  if (!takeToken(parsed.hostname)) throw new ReadError(429, `Rate limit for ${parsed.hostname}. Slow down.`);
  const { html, finalUrl } = await safeFetchHtml(parsed.toString());
  const base = extract(html, finalUrl);
  if (!base) throw new ReadError(422, 'Could not extract readable content (likely a JS-rendered page).');
  const src = matchSource(new URL(finalUrl).hostname);
  return { ...base, source: src?.attribution ?? null, license: src?.license ?? null };
}
