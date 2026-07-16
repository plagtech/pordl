# PORDL 🚪

**LLM proxy with smart routing and built-in cost tracking.**
One API key, one OpenAI-compatible endpoint. Automatic complexity detection routes each request to the cheapest model that can handle it.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Current provider:** OpenAI (GPT-4o-mini, GPT-4o, GPT-5.4).
> Anthropic, DeepSeek, and Google are wired in the provider layer — models shipping soon.

---

## What it does

PORDL sits between your app and LLM providers. Point any OpenAI-compatible
client at `api.pordl.dev` instead of `api.openai.com` — same request format,
same SDK, zero code changes.

**Smart routing** — every request gets classified by complexity (simple / moderate / complex) and routed to the cheapest model that meets the quality bar. Simple prompts go to GPT-4o-mini at $0.15/MTok input instead of GPT-4o at $2.50/MTok. You save money without thinking about it.

**Three routing modes:**

| Mode | Simple | Moderate | Complex |
|------|--------|----------|---------|
| `fast` | budget | budget | mid |
| `balanced` | budget | mid | frontier |
| `best` | mid | frontier | frontier |

Or skip routing entirely — request a specific model by name and PORDL honors it.

**What else you get:**
- **Usage tracking** — every request logged with model, tokens in/out, cost, and latency
- **Savings dashboard** — see what you spend vs. what you'd pay at direct OpenAI pricing
- **Unified billing** — Stripe subscription (Starter / Pro / Scale) with monthly token limits
- **Failover** — if a provider goes down, requests automatically reroute to the next available model in the same tier

---

## Quick start

### Use the hosted proxy

```bash
curl https://api.pordl.dev/v1/chat/completions \
  -H "Authorization: Bearer pd_live_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Use with Cursor

Settings → Models → OpenAI API Base → `https://api.pordl.dev/v1`

### Use with any OpenAI SDK

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'pd_live_your_key_here',
  baseURL: 'https://api.pordl.dev/v1',
});

const res = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Explain async/await in 3 sentences.' }],
});
```

### Let the router pick the model

```bash
# Send model: "auto" and PORDL picks the cheapest capable model
curl https://api.pordl.dev/v1/chat/completions \
  -H "Authorization: Bearer pd_live_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "What is 2+2?"}]
  }'
# → routes to gpt-4o-mini (budget tier, simple complexity)
```

Response headers tell you what happened:

```
x-pordl-model: gpt-4o-mini
x-pordl-complexity: simple
x-pordl-routing: balanced/simple → budget tier → gpt-4o-mini
x-pordl-cost: 0.000045
x-pordl-savings: 94
x-pordl-latency: 312
```

---

## Endpoints

### LLM Proxy

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/v1/chat/completions` | API key | Chat completions (OpenAI-compatible) |
| GET | `/v1/models` | — | List available models |
| POST | `/proxy/auth/signup` | — | Create account |
| GET | `/proxy/auth/usage` | API key | Usage stats |
| GET | `/proxy/billing/savings` | API key | Savings dashboard data |

### Read Gateway

PORDL also includes a clean-content reader: hand it a URL from a permitted
open-content source, get back LLM-ready markdown.

| Method | Path | Tier | Body |
|--------|------|------|------|
| POST | `/read` | x402-metered (~$0.005) | `{ "url": "...", "max_age"?: 300 }` |
| POST | `/free/read` | free, 10 req/min/IP | same |
| POST | `/watch` | x402-metered | `{ "url": "..." }` — change detection |
| GET | `/health` | — | Liveness check |

Clean by construction — only reads sources whose license permits reuse
(US federal public domain, Creative Commons, permissive OSS docs).
See `src/allowlist.ts` for the full list.

---

## Models

| Model | Tier | Input $/MTok | Output $/MTok | Context |
|-------|------|-------------|--------------|---------|
| `gpt-4o-mini` | budget | $0.15 | $0.60 | 128K |
| `gpt-4o` | mid | $2.50 | $10.00 | 128K |
| `gpt-5.4` | frontier | $2.50 | $15.00 | 256K |

> More providers coming. The provider layer already has connection stubs for
> Anthropic (with full request/response translation), DeepSeek, and Google.

---

## Project structure

```
src/
  index.ts                    Express app, routing, both products
  read.ts                     Read gateway — URL → clean markdown
  watch.ts                    Change detection endpoint
  allowlist.ts                Curated open-content sources by license
  payment.ts                  x402 metering for read gateway
  core.ts                     Shared utilities
  snapshot-store.ts           Snapshot storage for watch/diff
  proxy/
    config.ts                 Provider keys, tier limits, routing mode
    middleware/
      auth.ts                 API key validation + rate limiting
      usage.ts                Per-request usage logging
    routes/
      chat.ts                 POST /v1/chat/completions
      models.ts               GET /v1/models
      auth.ts                 Signup, login, key management
      billing.ts              Stripe checkout + webhooks
      savings.ts              Savings dashboard data
    services/
      providers.ts            Provider registry + model catalog
      router.ts               Smart routing (complexity → tier → model)
      billing.ts              Stripe subscription management
      cache.ts                Response caching
    utils/
      classifier.ts           Heuristic complexity classifier
public/
  index.html                  Landing page
  docs.html                   API documentation
  savings.html                Savings dashboard UI
  portal.png                  Branding asset
```

---

## Self-host

```bash
git clone https://github.com/plagtech/pordl.git
cd pordl
npm install
cp .env.example .env    # set OPENAI_API_KEY + Supabase/Stripe vars
npm run dev
```

Deploys to Railway — `railway.json` included. Healthcheck path: `/health`.

---

## Pricing

| Plan | Monthly | Token limit |
|------|---------|-------------|
| Free | $0 | 10,000 tokens |
| Starter | $29 | 50,000 tokens |
| Pro | $79 | 250,000 tokens |
| Scale | $199 | 1,000,000 tokens |

---

## Roadmap

- [x] OpenAI proxy with smart routing
- [x] Complexity classifier (heuristic)
- [x] Savings dashboard
- [x] Stripe billing (Starter / Pro / Scale)
- [x] Open-content read gateway + watch/diff
- [x] Provider failover
- [ ] Anthropic provider (translation layer built, needs model catalog)
- [ ] DeepSeek provider
- [ ] Google Gemini provider
- [ ] Streaming support
- [ ] npm SDK (`@plagtech/pordl`)

---

## Tech stack

TypeScript · Express · Supabase · Redis · Stripe · Railway

---

## Links

- **Website:** [pordl.dev](https://pordl.dev)
- **API docs:** [pordl.dev/docs](https://pordl.dev/docs)
- **npm:** [@plagtech/pordl](https://npmjs.com/package/@plagtech/pordl)

---

## License

[MIT](LICENSE)
