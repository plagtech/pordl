---
name: pordl-app-setup
description: Connect any OpenAI-compatible application to PORDL as its model backend by setting a custom base URL. Use this skill when the user wants to point a chat UI, coding assistant, or writing tool (Open WebUI, LibreChat, Continue, Cline, Aider, Obsidian AI plugins, or anything built on the OpenAI SDK) at a custom OpenAI-compatible endpoint, or asks how to use PORDL inside an existing app.
version: 1.0.0
homepage: https://pordl.dev
metadata:
  openclaw:
    requires:
      bins:
        - curl
    envVars:
      - name: PORDL_API_KEY
        required: false
        description: PORDL API key from pordl.dev. This skill walks the user through creating one if missing.
---

# PORDL App Setup

Point any OpenAI-compatible app at PORDL in under five minutes. One key, flat monthly pricing, automatic model routing.

## Agent Instructions

Walk the user through one step at a time and confirm each step succeeded before continuing. Never ask the user to paste their API key into chat — have them enter it directly in the app's settings or set it as an environment variable. If the connection fails, work through the Troubleshooting section in order.

## The Universal Setup

Any app that supports a custom OpenAI endpoint works with PORDL:

- **Base URL:** `https://api.pordl.dev/v1`
- **API Key:** the user's `pd_live_` key from https://pordl.dev (free tier: 100K credits/month, no card required)
- **Model:** `auto` (PORDL picks the best model per request), or any model from `https://api.pordl.dev/v1/models`

## App-Specific Notes

### Open WebUI
Settings → Connections → OpenAI API → set the base URL and key above. Models populate automatically.

### LibreChat
Add a custom endpoint in `librechat.yaml` with `baseURL: https://api.pordl.dev/v1` and `apiKey: ${PORDL_API_KEY}`.

### Continue / Cline / Aider (coding assistants)
Configure an OpenAI-compatible provider with the base URL above. For coding, `routing_mode: "balanced"` (the default) sends simple completions to budget models and complex refactors to stronger ones.

### Anything on the OpenAI SDK
```python
from openai import OpenAI
client = OpenAI(api_key="pd_live_...", base_url="https://api.pordl.dev/v1")
```

## Recommended Settings

- **Streaming:** on — responses render as they generate.
- **Context size:** match the selected model's limit (see `/v1/models`); 8K–32K is practical for most chat sessions.
- **Max response length:** 400–600 tokens for chat pacing; 1500+ for long-form drafting.

## Troubleshooting

### "Could not connect" or "Invalid API key"
- Key should start with `pd_live_`
- Base URL must be exactly `https://api.pordl.dev/v1` (with `/v1`)
- Check account status at https://pordl.dev

### Responses are slow
- Use `auto` or a budget model; reduce context size if set very high
- Confirm streaming is enabled

### Hit the monthly credit limit
- PORDL tiers have a hard cap by default — no overage bills. Upgrade or buy a one-time top-up at https://pordl.dev/pricing.

## Content Policy

All requests pass an automated content-safety check; prohibited content is refused. See https://pordl.dev/aup.

## Links

- **Sign up**: https://pordl.dev
- **API docs**: https://api.pordl.dev/docs
- **Source code**: https://github.com/plagtech/pordl
