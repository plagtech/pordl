# pordl 🚪

**The open-knowledge read gateway.** One endpoint: hand it a URL from a
permitted open-content source, get back clean LLM-ready markdown. Metered per
call over x402, with a free rate-limited tier on top.

Clean by construction — pordl only reads sources whose license affirmatively
permits reuse (US-federal public domain, Creative Commons, permissive OSS docs;
see `src/allowlist.ts`). The ToS question doesn't get managed; it doesn't arise.

## Endpoints

| Method | Path | Tier | Body |
|---|---|---|---|
| POST | `/read` | x402-metered (~$0.005) | `{ "url": "...", "max_age"?: 300 }` |
| POST | `/free/read` | free, 10/min/IP | same |
| GET | `/health` | free | — |

Response carries `markdown`, `title`, `excerpt`, plus `source` + `license`
(attribution passthrough) and a short `_pordl` block.

## Layout

```
src/
  index.ts      entry: express app, tiers, health
  read.ts       fast-path handler: SSRF guard, rate limit, cache, extract
  allowlist.ts  curated open-content sources, grouped by license
  payment.ts    x402 metering (your pordl wallet)
```

## Local dev

```bash
npm install
cp .env.example .env      # leave PAY_TO_ADDRESS blank to run UNMETERED
npm run dev
# test:
curl -s -X POST localhost:3000/free/read \
  -H 'content-type: application/json' \
  -d '{"url":"https://docs.python.org/3/library/json.html"}' | jq .title
```

## Ship checklist

1. **Wallet** — create a new receiving wallet (separate from everything else).
   Put its address in `PAY_TO_ADDRESS`.
2. **x402** — align `@x402/*` package versions and the CDP facilitator config
   with your known-good Spraay setup. Test on Base Sepolia first
   (`X402_NETWORK=eip155:84532`, `FACILITATOR_URL=https://x402.org/facilitator`),
   then flip to mainnet.
3. **Push** — `git push` to your empty repo.
4. **Railway** — new **project** (not a service inside another). Connect the
   repo, set env vars from `.env.example`. `.npmrc` + tsx handle the build.
   Healthcheck path is `/health`.
5. **DNS** — in GoDaddy, CNAME a subdomain (e.g. `api.pordl.dev`) to the Railway
   target. Railway auto-issues the Let's Encrypt cert (free; required because
   `.dev` is HSTS-preloaded).
6. **Distribution** — stand up a separate MCP server exposing this one tool,
   a landing page, and list it on x402 discovery surfaces. Then your usual
   tweet + Dev.to launch.

## Notes

- Cache + rate-limit are in-memory: fine on one instance, move to Redis if you
  scale horizontally.
- For sources tagged `preferApi` in the allowlist (Wikipedia, arXiv), prefer a
  v1.1 that hits their official API. Consider commenting them out for the
  cleanest possible launch.
- The SSRF guard is duplicated here on purpose — do not refactor it into a
  package shared with other projects.
