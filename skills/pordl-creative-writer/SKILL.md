---
name: pordl-creative-writer
description: Route fiction drafting and long-form creative writing through PORDL's cost-optimized creative mode. Use this skill when the user is writing a novel, short story, screenplay, or game narrative and wants to draft chapters, develop characters, write dialogue, build scenes, or do worldbuilding through an affordable API — or when the user mentions PORDL for writing. Do not trigger for business copywriting, marketing copy, or general chat.
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

# PORDL Creative Writer

Draft fiction, develop characters, and build worlds using PORDL's creative routing mode — models selected for prose quality at a fraction of frontier-model cost.

## What This Does

PORDL's `creative` routing mode selects models optimized for narrative writing rather than reasoning benchmarks, prioritizing:

- **Prose quality** — vivid, natural writing over benchmark scores
- **Character consistency** across long drafting sessions
- **Context retention** for multi-chapter manuscripts
- **Natural dialogue** with distinct character voices

Built for novelists, short-fiction writers, screenwriters, and game-narrative designers who draft at volume and don't want frontier-model prices on every iteration.

## Getting Started

Sign up at **https://pordl.dev** (free tier: 100K credits/month, no card required), then set your key as an environment variable — never paste API keys into chat:

```bash
export PORDL_API_KEY="pd_live_your-key-here"
```

## How to Use This Skill

### Drafting

- "Write the opening chapter of a noir detective story set in 1940s Los Angeles"
- "Continue the scene where Elena discovers the hidden room"
- "Draft the confrontation between mother and daughter at the holiday dinner"

### Character Development

- "Create a character profile for a retired astronaut turned private investigator"
- "Develop the backstory for my protagonist — a marine biologist with a secret"

### Worldbuilding

- "Build the magic system for my fantasy world — it should be based on music"
- "Write a field guide entry for three creatures that inhabit the dark forest"

## Making API Calls

```bash
curl -X POST https://api.pordl.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PORDL_API_KEY" \
  -d '{
    "model": "auto",
    "routing_mode": "creative",
    "messages": [
      {"role": "system", "content": "You are a skilled fiction writer. Write vivid, immersive prose with strong character voices and sensory detail."},
      {"role": "user", "content": "Write the opening scene..."}
    ],
    "temperature": 0.9,
    "max_tokens": 2000,
    "stream": true
  }'
```

Query `https://api.pordl.dev/v1/models` for available models; `auto` with `routing_mode: "creative"` picks the best prose model for each request.

### Recommended Settings

- **temperature**: 0.85–1.0
- **max_tokens**: 1500–3000 (a full scene without cutoff)
- **stream**: true (see text as it's written)

## Tips for Better Results

1. **Give context** — a paragraph describing your world, characters, and tone produces immersive prose; a one-liner produces generic writing.
2. **Define recurring characters in the system prompt** — name, personality, speaking style, key relationships.
3. **Set the scene** — location, time of day, mood. Sensory context in produces sensory writing out.
4. **Don't over-instruct** — "write a sad scene" beats a paragraph of stage directions. Let the model make creative choices.
5. **Iterate, don't restart** — "make the dialogue sharper" beats regenerating from scratch.

## Pricing

Flat monthly tiers with a hard cap — draft as much as your allowance covers with no surprise bills. Current tiers at https://pordl.dev/pricing.

## Content Policy

All requests pass an automated content-safety check; prohibited content is refused. See https://pordl.dev/aup.

## Links

- **Sign up**: https://pordl.dev
- **API docs**: https://api.pordl.dev/docs
- **Source code**: https://github.com/plagtech/pordl
