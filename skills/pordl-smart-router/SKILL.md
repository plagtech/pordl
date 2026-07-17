---
name: pordl-smart-router
description: Route LLM API calls through PORDL, an OpenAI-compatible proxy that automatically selects the cheapest viable model per request. Use this skill whenever the user wants to reduce their LLM API bill, set up smart model routing for an app or agent, swap between model providers without code changes, or mentions PORDL by name. Do not trigger for general AI questions that don't involve API cost, routing, or provider setup.
version: 1.1.0
homepage: https://pordl.dev
metadata:
  openclaw:
    requires:
      env:
        - PORDL_API_KEY
      bins:
        - curl
    primaryEnv: PORDL_API_KEY
---

# PORDL Smart Router

Cut LLM API costs 40–90% by routing through PORDL — smart model selection with zero markup on budget models.

## What This Does

PORDL sits between your code and LLM providers. It analyzes each request, determines complexity, and routes to the cheapest model that can handle it well. Simple tasks go to budget models; complex reasoning goes to frontier models. You don't change your code — just swap the base URL.

The savings come from the fact that most requests don't need a frontier model. PORDL's classifier catches that and routes accordingly.

## Getting Started

### Step 1: Get an API Key

Sign up at **https://pordl.dev** — the free tier includes 100K credits/month, no credit card required. Paid plans start at $4.99/mo.

Set the key as an environment variable (never paste API keys into chat):

```bash
export PORDL_API_KEY="pd_live_your-key-here"
```

### Step 2: Swap Your Base URL

```python
# Before — paying full price on every call
from openai import OpenAI
client = OpenAI(api_key="sk-your-openai-key")

# After — PORDL routes smart
client = OpenAI(
    api_key="pd_live_your-pordl-key",
    base_url="https://api.pordl.dev/v1"
)
```

Every existing OpenAI SDK call works unchanged.

### Step 3: Choose a Routing Mode

`routing_mode` is a top-level body parameter in raw HTTP requests; when using the OpenAI Python SDK, pass it via `extra_body`:

```python
response = client.chat.completions.create(
    model="auto",  # let PORDL pick
    messages=[{"role": "user", "content": "Summarize this paragraph"}],
    extra_body={"routing_mode": "fast"}
)
```

| Mode | Routing Logic | Best For |
|------|--------------|----------|
| `fast` | Everything → budget models | Bulk tasks, summaries, formatting |
| `balanced` | Simple → budget, complex → frontier | General use (default) |
| `best` | Everything → mid or frontier | When quality matters most |
| `creative` | Optimized for prose quality | Fiction drafting, long-form writing |

## Models

Query `https://api.pordl.dev/v1/models` for the current list — it is the source of truth. Use `auto` to let PORDL select the cheapest viable model per request.

## API Reference

### Chat Completions

```bash
curl -X POST https://api.pordl.dev/v1/chat/completions \
  -H "Authorization: Bearer $PORDL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Hello"}],
    "routing_mode": "balanced",
    "stream": true
  }'
```

### Response Headers

- `x-pordl-provider` — which provider handled the request
- `x-pordl-model` — which model was selected
- `x-pordl-cost` — actual cost of this request
- `x-pordl-savings` — percentage saved vs the model the client requested
- `x-pordl-cached` — whether this was a cache hit (free)
- `x-pordl-credits-remaining` — remaining monthly allowance

## Pricing

Flat monthly tiers with a hard cap — no surprise bills. Credits are measured in budget-model tokens; premium models draw credits faster because they cost more to run. Current tiers and per-model credit rates are listed at https://pordl.dev/pricing.

## Content Policy

All requests pass an automated content-safety check. Requests flagged for prohibited content are refused with a clear error rather than routed elsewhere. See https://pordl.dev/aup.

## Links

- **Sign up**: https://pordl.dev
- **API docs**: https://api.pordl.dev/docs
- **Source code**: https://github.com/plagtech/pordl
