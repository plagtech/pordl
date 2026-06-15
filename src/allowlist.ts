/**
 * allowlist.ts — clean-by-construction source list
 * ---------------------------------------------------------------------------
 * Every domain here is one whose license AFFIRMATIVELY PERMITS reading and
 * reuse: US-federal public domain, Creative Commons, or permissive OSS docs.
 * The ToS question doesn't get "managed" — it doesn't arise, because the
 * terms grant the use.
 *
 * RULES OF THE ROAD before you widen this list:
 *  - Verify the license yourself before adding anything. "Looks open" != open.
 *  - Where a source publishes an official API or dump (Wikipedia, arXiv),
 *    PREFER it over scraping HTML — it's the front door they built for machines.
 *  - US-federal works are public domain in the US (17 U.S.C. §105). That does
 *    NOT extend to: third-party content the gov licensed, state/local govs, or
 *    use outside the US. Treat federal .gov as safe-to-read; verify the rest.
 *  - Always pass through source URL + license in your response (attribution),
 *    so anything reusing CC BY / BY-SA content can comply.
 *
 * Each entry is an apex domain; exact host or any subdomain matches.
 */

export type LicenseTag =
  | 'us-federal-public-domain'
  | 'public-domain'
  | 'cc-by-sa'
  | 'cc-by'
  | 'permissive-oss'
  | 'open-access';

export interface AllowedSource {
  domain: string;
  license: LicenseTag;
  attribution: string;        // human-readable string to echo back in metadata
  preferApi?: string;         // if set, the official API is the cleaner path
  note?: string;
}

export const ALLOWED_SOURCES: readonly AllowedSource[] = [
  // ---- US federal / public domain (no copyright) -------------------------
  { domain: 'congress.gov',        license: 'us-federal-public-domain', attribution: 'congress.gov (US Gov, public domain)' },
  { domain: 'govinfo.gov',         license: 'us-federal-public-domain', attribution: 'govinfo.gov (US Gov, public domain)' },
  { domain: 'federalregister.gov', license: 'us-federal-public-domain', attribution: 'Federal Register (US Gov, public domain)', preferApi: 'https://www.federalregister.gov/developers/documentation/api/v1' },
  { domain: 'sec.gov',             license: 'us-federal-public-domain', attribution: 'sec.gov (US Gov, public domain)', note: 'EDGAR full-text has an API; respect their 10 req/s fair-access rule.' },
  { domain: 'nasa.gov',            license: 'us-federal-public-domain', attribution: 'nasa.gov (US Gov, public domain)' },
  { domain: 'nih.gov',             license: 'us-federal-public-domain', attribution: 'nih.gov (US Gov, public domain)' },
  { domain: 'cdc.gov',             license: 'us-federal-public-domain', attribution: 'cdc.gov (US Gov, public domain)' },
  { domain: 'weather.gov',         license: 'us-federal-public-domain', attribution: 'weather.gov / NWS (US Gov, public domain)', preferApi: 'https://www.weather.gov/documentation/services-web-api' },
  { domain: 'census.gov',          license: 'us-federal-public-domain', attribution: 'census.gov (US Gov, public domain)', preferApi: 'https://www.census.gov/data/developers.html' },
  { domain: 'bls.gov',             license: 'us-federal-public-domain', attribution: 'bls.gov (US Gov, public domain)', preferApi: 'https://www.bls.gov/developers/' },
  { domain: 'gutenberg.org',       license: 'public-domain',            attribution: 'Project Gutenberg (public domain)', note: 'They block aggressive crawling; keep rate low and cache.' },

  // ---- Creative Commons --------------------------------------------------
  { domain: 'wikipedia.org',       license: 'cc-by-sa', attribution: 'Wikipedia, CC BY-SA 4.0', preferApi: 'https://www.mediawiki.org/wiki/API:REST_API', note: 'Heavy users SHOULD use the API, not HTML. Attribution + share-alike required.' },
  { domain: 'wikimedia.org',       license: 'cc-by-sa', attribution: 'Wikimedia, CC BY-SA 4.0', preferApi: 'https://api.wikimedia.org/' },
  { domain: 'wikidata.org',        license: 'public-domain', attribution: 'Wikidata, CC0', preferApi: 'https://query.wikidata.org/' },
  { domain: 'developer.mozilla.org', license: 'cc-by-sa', attribution: 'MDN Web Docs, CC BY-SA 2.5', note: 'Code samples are CC0/MIT; prose is CC BY-SA.' },

  // ---- Permissive OSS documentation -------------------------------------
  { domain: 'docs.python.org',     license: 'permissive-oss', attribution: 'Python docs, PSF License' },
  { domain: 'docs.djangoproject.com', license: 'permissive-oss', attribution: 'Django docs, BSD' },
  { domain: 'pkg.go.dev',          license: 'permissive-oss', attribution: 'Go packages, BSD-style' },
  { domain: 'docs.rs',             license: 'permissive-oss', attribution: 'docs.rs (Rust crate docs)' },
  { domain: 'kubernetes.io',       license: 'cc-by',          attribution: 'Kubernetes docs, CC BY 4.0' },
  { domain: 'react.dev',           license: 'cc-by',          attribution: 'React docs, CC BY 4.0' },

  // ---- Open-access academic (prefer APIs; do NOT bulk-scrape) -----------
  { domain: 'arxiv.org',           license: 'open-access', attribution: 'arXiv', preferApi: 'https://info.arxiv.org/help/api/index.html', note: 'Per-paper license varies; metadata open. They explicitly ask you NOT to crawl the site — use the API or the AWS bulk-access dataset.' },
  { domain: 'plos.org',            license: 'cc-by',       attribution: 'PLOS, CC BY 4.0' },
  { domain: 'doaj.org',            license: 'open-access', attribution: 'DOAJ', preferApi: 'https://doaj.org/api/docs' },
  { domain: 'ncbi.nlm.nih.gov',    license: 'open-access', attribution: 'PubMed Central (OA subset)', preferApi: 'https://www.ncbi.nlm.nih.gov/home/develop/api/', note: 'Only the PMC Open Access subset is reusable; non-OA articles are NOT. The API distinguishes them — honor that.' },

  // ---- DELIBERATELY EXCLUDED (note for future-you) ----------------------
  // Stack Overflow: content is CC BY-SA, but their ToS/robots are hostile to
  //   scraping and AI reuse is contested. Only ever via their official API,
  //   and not in v1.
];

const DOMAINS = ALLOWED_SOURCES.map((s) => s.domain);

export function matchSource(hostname: string): AllowedSource | null {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  for (const s of ALLOWED_SOURCES) {
    if (h === s.domain || h.endsWith('.' + s.domain)) return s;
  }
  return null;
}

export function isAllowedHost(hostname: string): boolean {
  return matchSource(hostname) !== null;
}

export { DOMAINS };
