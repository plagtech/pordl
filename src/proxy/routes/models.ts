/**
 * GET /v1/models — List available models.
 * OpenAI-compatible format so existing tools work.
 */

import { Router, Request, Response } from "express";
import { getAllModels } from "../services/providers";

const router = Router();

// Use-case tags per model. Keyed by model id so entries for models not yet
// in the catalog (e.g. deepseek-v3) activate when the model ships.
const RECOMMENDED_FOR: Record<string, string[]> = {
  "deepseek-v4-flash": ["roleplay", "chat", "creative-writing", "translation"],
  "deepseek-v4-pro": ["roleplay", "long-form-fiction", "complex-characters", "code"],
  "deepseek-v3": ["roleplay", "chat", "creative-writing"],
  "gpt-4o-mini": ["quick-tasks", "summaries", "code"],
  "gpt-4o": ["code", "analysis", "reasoning"],
  "gpt-5.4": ["complex-reasoning", "research", "code"],
};

// Why each roleplay-recommended model works well for roleplay
const ROLEPLAY_NOTES: Record<string, string> = {
  "deepseek-v4-flash":
    "Best value for character chat: expressive prose at $0.14/MTok in, and the 1M context window keeps long conversations and lorebooks in memory.",
  "deepseek-v4-pro":
    "Stronger character consistency and richer long-form fiction. Worth the step up for complex characters and multi-character scenes; still a fraction of GPT-4o pricing.",
  "deepseek-v3":
    "Solid conversational roleplay at rock-bottom cost — a good fallback when v4 models are unavailable.",
};

router.get("/", (_req: Request, res: Response): void => {
  const models = getAllModels();

  const openaiFormat = {
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "pordl",
      // Extra fields not in OpenAI spec but useful for our users
      pordl: {
        tier: m.tier,
        input_cost_per_1m: m.inputCostPer1M,
        output_cost_per_1m: m.outputCostPer1M,
        max_context: m.maxContext,
        capabilities: m.capabilities,
        recommended_for: RECOMMENDED_FOR[m.id] ?? [],
      },
    })),
  };

  res.json(openaiFormat);
});

// GET /v1/models/recommended/roleplay — models best suited for roleplay,
// cheapest first, with a note on why each works well.
router.get("/recommended/roleplay", (_req: Request, res: Response): void => {
  const models = getAllModels()
    .filter((m) => (RECOMMENDED_FOR[m.id] ?? []).includes("roleplay"))
    .sort((a, b) => a.inputCostPer1M - b.inputCostPer1M);

  res.json({
    object: "list",
    use_case: "roleplay",
    description:
      "Models best suited for roleplay and character chat, sorted by value (cheapest first). Tip: set routing_mode to \"creative\" (or just send roleplay-formatted messages) and PORDL routes here automatically.",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "pordl",
      pordl: {
        tier: m.tier,
        input_cost_per_1m: m.inputCostPer1M,
        output_cost_per_1m: m.outputCostPer1M,
        max_context: m.maxContext,
        capabilities: m.capabilities,
        recommended_for: RECOMMENDED_FOR[m.id] ?? [],
      },
      why: ROLEPLAY_NOTES[m.id] ?? "Good prose quality at its price point.",
    })),
  });
});

// Special model: "auto" (our default smart routing)
// GET /v1/models/auto
router.get("/auto", (_req: Request, res: Response): void => {
  res.json({
    id: "auto",
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "pordl",
    description:
      "PORDL automatically selects the optimal model based on request complexity and your routing_mode setting. This is the default when no model is specified.",
    routing_modes: {
      fast: "Routes to budget models. Best for simple tasks. Lowest cost.",
      balanced: "Routes simple→budget, moderate→mid, complex→frontier. Best value.",
      best: "Routes to mid or frontier models. Best quality.",
      creative:
        "Optimized for roleplay and creative writing — prefers DeepSeek models for prose quality, never pays frontier prices. Auto-selected when PORDL detects roleplay/creative requests.",
    },
  });
});

export default router;
