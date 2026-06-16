/**
 * allowlist.ts — REGULATORY EDITION
 * ---------------------------------------------------------------------------
 * Drop-in replacement for the generic allowlist, narrowed to US-federal
 * regulatory / legal / filing sources. Every entry is public domain
 * (17 U.S.C. §105) — clean by construction, zero ToS exposure on reuse.
 *
 * This is the vertical: "watch these filings/rules and tell me what changed."
 * Swapping this in narrows BOTH /read and /watch to regulatory sources, which
 * is the point — a sharp, defensible story instead of "generic reader #47".
 *
 * Where a source has an official API, PREFER it (tagged preferApi). Some need a
 * free api.data.gov key (congress.gov, govinfo.gov, regulations.gov) — note it.
 * SEC EDGAR fair-access: declare a real User-Agent, cap ~10 req/s.
 */

export type LicenseTag = 'us-federal-public-domain' | 'public-domain';

export interface AllowedSource {
  domain: string;
  license: LicenseTag;
  attribution: string;
  preferApi?: string;
  note?: string;
}

export const ALLOWED_SOURCES: readonly AllowedSource[] = [
  // ---- Securities & derivatives markets ---------------------------------
  { domain: 'sec.gov',            license: 'us-federal-public-domain', attribution: 'U.S. SEC (public domain)', preferApi: 'https://www.sec.gov/search-filings/edgar-application-programming-interfaces', note: 'Covers data.sec.gov & efts.sec.gov. Declare a real User-Agent; cap ~10 req/s (fair access).' },
  { domain: 'cftc.gov',           license: 'us-federal-public-domain', attribution: 'U.S. CFTC (public domain)' },

  // ---- Rulemaking, rules & notices --------------------------------------
  { domain: 'federalregister.gov', license: 'us-federal-public-domain', attribution: 'Federal Register (public domain)', preferApi: 'https://www.federalregister.gov/developers/documentation/api/v1', note: 'Excellent free JSON API, no key. The cleanest regulatory-change source.' },
  { domain: 'regulations.gov',     license: 'us-federal-public-domain', attribution: 'Regulations.gov (public domain)', preferApi: 'https://open.gsa.gov/api/regulationsgov/', note: 'API needs a free api.data.gov key.' },

  // ---- Legislation -------------------------------------------------------
  { domain: 'congress.gov',       license: 'us-federal-public-domain', attribution: 'Congress.gov (public domain)', preferApi: 'https://api.congress.gov/', note: 'API needs a free api.data.gov key.' },
  { domain: 'govinfo.gov',        license: 'us-federal-public-domain', attribution: 'GovInfo / GPO (public domain)', preferApi: 'https://api.govinfo.gov/docs/', note: 'CFR, US Code, public laws. API needs a free api.data.gov key.' },

  // ---- Financial regulators (esp. crypto-relevant) ----------------------
  { domain: 'federalreserve.gov', license: 'us-federal-public-domain', attribution: 'Federal Reserve (public domain)' },
  { domain: 'treasury.gov',       license: 'us-federal-public-domain', attribution: 'U.S. Treasury (public domain)', note: 'Covers home.treasury.gov and OFAC sanctions pages.' },
  { domain: 'fincen.gov',         license: 'us-federal-public-domain', attribution: 'FinCEN (public domain)', note: 'AML/BSA guidance — high signal for crypto/fintech.' },
  { domain: 'occ.gov',            license: 'us-federal-public-domain', attribution: 'OCC (public domain)' },
  { domain: 'fdic.gov',           license: 'us-federal-public-domain', attribution: 'FDIC (public domain)' },
  { domain: 'consumerfinance.gov', license: 'us-federal-public-domain', attribution: 'CFPB (public domain)' },
  { domain: 'ftc.gov',            license: 'us-federal-public-domain', attribution: 'FTC (public domain)' },

  // ---- Courts ------------------------------------------------------------
  { domain: 'courtlistener.com',  license: 'public-domain', attribution: 'CourtListener / Free Law Project', preferApi: 'https://www.courtlistener.com/help/api/rest/', note: 'U.S. court opinions are public domain (not copyrightable). Heavy use → use the API with a free token.' },
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
