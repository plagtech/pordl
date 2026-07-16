# pordl 🚪

**The LLM proxy built for creators. Smart routing, streaming, zero markup on DeepSeek.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DeepSeek markup](https://img.shields.io/badge/DeepSeek_markup-0%25-brightgreen)](#supported-models)

One API key, one OpenAI-compatible endpoint. PORDL classifies every request
and routes it to the cheapest model that does the job well — and it passes
DeepSeek through at **0% markup** (OpenRouter charges 5.5%).

---

## Who it's for

**Developers — stop overpaying for API calls:**
- Point any OpenAI SDK at `api.pordl.dev` — same request format, zero code changes
- Smart routing classifies each request (simple / moderate / complex) and picks the cheapest capable model
- Usage tracking, savings dashboard, response caching, and automatic provider failover built in
- Request a specific model by name any time — routing only kicks in on `"auto"`

**Roleplay & creative writers — SillyTavern, RisuAI, and friends:**
- Connect in 2 minutes — it's just an OpenAI-compatible endpoint
- Cheapest DeepSeek access anywhere: **0% markup**, vs OpenRouter's 5.5%
- Full SSE streaming — tokens appear as they generate
- PORDL auto-detects roleplay requests (character cards, `{{char}}`/`{{user}}`, asterisk actions) and routes them for prose quality instead of burning money on frontier reasoning models
- 1M-token context on DeepSeek v4 — long chats and lorebooks stay in memory

---

## SillyTavern setup

1. **Sign up** — `POST https://api.pordl.dev/proxy/auth/signup` (or via [pordl.dev](https://pordl.dev)) and grab your API key (`pd_live_...`)
2. In SillyTavern, open **API Connections** and choose **Chat Completion** → **Custom (OpenAI-compatible)**
3. Set **Custom Endpoint (Base URL)** to `https://api.pordl.dev/v1`
4. Paste your **API key**
5. Pick a model from the dropdown — `deepseek-v4-flash` is the value pick — or use `auto` and let PORDL route each message

That's it. Streaming works out of the box, and roleplay-shaped requests are
automatically routed through the creative mode for the best prose per dollar.

Not sure which model to pick? Ask the API:

```
GET https://api.pordl.dev/v1/models/recommended/roleplay
```

Returns roleplay-suited models sorted cheapest-first, each with a note on why
it works well.

---

## Supported models

| Model | Tier | Input $/MTok | Output $/MTok | Context | Best for |
|-------|------|-------------|--------------|---------|----------|
| `deepseek-v4-flash` | budget | $0.14 | $0.28 | 1M | roleplay, chat, creative-writing, translation |
| `gpt-4o-mini` | budget | $0.15 | $0.60 | 128K | quick-tasks, summaries, code |
| `deepseek-v4-pro` | mid | $0.435 | $0.87 | 1M | roleplay, long-form-fiction, complex-characters, code |
| `gpt-4o` | mid | $2.50 | $10.00 | 128K | code, analysis, reasoning |
| `gpt-5.4` | frontier | $2.50 | $15.00 | 256K | complex-reasoning, research, code |

**DeepSeek models are passed through at provider list price — 0% markup.**
Anthropic and Google are wired in the provider layer; models shipping soon.

---

## Routing modes

Set `routing_mode` in the request body (or let PORDL pick):

| Mode | Simple | Moderate | Complex |
|------|--------|----------|---------|
| `fast` | budget | budget | mid |
| `balanced` | budget | mid | frontier |
| `best` | mid | frontier | frontier |
| `creative` | budget | mid | mid |

**`creative` (new)** routes for prose quality, not reasoning power. It prefers
DeepSeek models at every tier and never escalates to frontier — roleplay needs
good prose, not GPT-5.4-grade reasoning at GPT-5.4 prices. PORDL selects it
automatically when it detects roleplay/creative requests (character cards,
`{{char}}` variables, asterisk actions, narrative prompts) unless you set a
mode explicitly.

Or skip routing entirely — request a specific model by name and PORDL honors it.

---

## Quick start (developers)

```bash
curl https://api.pordl.dev/v1/chat/completions \
  -H "Authorization: Bearer pd_live_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "What is 2+2?"}]
  }'
# → routes to a budget model; response headers show the decision
```

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'pd_live_your_key_here',
  baseURL: 'https://api.pordl.dev/v1',
});

const res = await client.chat.completions.create({
  model: 'auto',            // or any model id from /v1/models
  stream: true,             // SSE streaming supported
  messages: [{ role: 'user', content: 'Continue the story...' }],
});
```

Response headers tell you what happened:

```
x-pordl-model: deepseek-v4-flash
x-pordl-complexity: moderate
x-pordl-routing: creative/moderate → mid tier → deepseek-v4-pro
x-pordl-cost: 0.000045
x-pordl-savings: 94
x-pordl-latency: 312
```

---

## API reference

### LLM proxy

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/v1/chat/completions` | API key | Chat completions (OpenAI-compatible, streaming via `"stream": true`) |
| GET | `/v1/models` | — | List available models with pricing + `recommended_for` tags |
| GET | `/v1/models/recommended/roleplay` | — | Roleplay-suited models, cheapest first, with notes |
| POST | `/proxy/auth/signup` | — | Create account |
| GET | `/proxy/auth/usage` | API key | Usage stats |
| GET | `/proxy/billing/savings` | API key | Savings dashboard data |

### Read gateway

PORDL also includes a clean-content reader: hand it a URL from a permitted
open-content source, get back LLM-ready markdown.

| Method | Path | Tier | Body |
|--------|------|------|------|
| POST | `/read` | x402-metered (~$0.005) | `{ "url": "...", "max_age"?: 300 }` |
| POST | `/free/read` | free, 10 req/min/IP | same |
| POST | `/watch` | x402-metered | `{ "url": "..." }` — change detection |
| GET | `/health` | — | Liveness check |

---

## Pricing

| Plan | Monthly | Tokens/mo | Rate limit |
|------|---------|-----------|-----------|
| Free | $0 | 100K | 10 req/min |
| Creator | $4.99 | 1M | 30 req/min |
| Creator Pro | $9.99 | 5M | 60 req/min |
| Creator Ultra | $19.99 | 15M | 120 req/min |

---

## Self-hosting

```bash
git clone https://github.com/plagtech/pordl.git
cd pordl
npm install
cp .env.example .env
npm run dev
```

Environment variables:

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENAI_API_KEY` | yes* | OpenAI provider |
| `DEEPSEEK_API_KEY` | yes* | DeepSeek provider (the value models) |
| `ANTHROPIC_API_KEY` | optional | Anthropic provider (wired, models pending) |
| `GOOGLE_API_KEY` | optional | Google provider (wired, models pending) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | yes | Auth, usage logging |
| `REDIS_URL` | optional | Response cache |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | optional | Billing |
| `STRIPE_PRICE_CREATOR` / `_PRO` / `_ULTRA` | optional | Subscription price IDs |
| `PORT` | optional | Defaults to 3000 |

\* At least one provider key is needed; set both for smart routing across providers.

Deploys to Railway — `railway.json` included. Healthcheck path: `/health`.

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
