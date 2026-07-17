/**
 * GET /v1/models — List available models.
 * OpenAI-compatible format so existing tools work.
 */

import { Router, Request, Response } from "express";
import { getAllModels, ModelConfig } from "../services/providers";
import { CREDIT_UNIT_COST_USD } from "../config";

const router = Router();

// Credits burned per 1K tokens at a given input:output ratio.
// 1 credit = 1 budget-model token, so deepseek-v4-flash at 1:2 is exactly 1000.
function burnPer1K(m: ModelConfig, inputShare: number, outputShare: number): number {
  const costPer1K =
    (inputShare * m.inputCostPer1M + outputShare * m.outputCostPer1M) / 1_000_000 * 1000;
  return Math.round(costPer1K / CREDIT_UNIT_COST_USD);
}

function burnRates(m: ModelConfig) {
  return {
    // credits per 1K tokens
    "input_heavy_10_1": burnPer1K(m, 10 / 11, 1 / 11),
    "output_heavy_1_2": burnPer1K(m, 1 / 3, 2 / 3),
  };
}

// Use-case tags per model. Keyed by model id so entries for models not yet
// in the catalog (e.g. deepseek-v3) activate when the model ships.
const RECOMMENDED_FOR: Record<string, string[]> = {
  "deepseek-v4-flash": ["fiction", "drafting", "creative-writing", "translation"],
  "deepseek-v4-pro": ["fiction", "long-form-fiction", "creative-writing", "code"],
  "deepseek-v3": ["fiction", "drafting", "creative-writing"],
  "gpt-4o-mini": ["quick-tasks", "summaries", "code"],
  "gpt-4o": ["code", "analysis", "reasoning"],
  "gpt-5.4": ["complex-reasoning", "research", "code"],
};

// Why each fiction-recommended model works well for long-form drafting
const FICTION_NOTES: Record<string, string> = {
  "deepseek-v4-flash":
    "Best value for drafting: expressive prose at $0.14/MTok in, and the 1M context window keeps whole manuscripts and story bibles in memory.",
  "deepseek-v4-pro":
    "Stronger consistency across chapters and richer long-form fiction. Worth the step up for complex plots and multi-viewpoint scenes; still a fraction of GPT-4o pricing.",
  "deepseek-v3":
    "Solid drafting quality at rock-bottom cost — a good fallback when v4 models are unavailable.",
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
        credits_per_1k_tokens: burnRates(m),
      },
    })),
  };

  res.json(openaiFormat);
});

// GET /v1/models/recommended/fiction — models best suited for fiction
// drafting, cheapest first, with a note on why each works well.
router.get("/recommended/fiction", (_req: Request, res: Response): void => {
  const models = getAllModels()
    .filter((m) => (RECOMMENDED_FOR[m.id] ?? []).includes("fiction"))
    .sort((a, b) => a.inputCostPer1M - b.inputCostPer1M);

  res.json({
    object: "list",
    use_case: "fiction",
    description:
      "Models best suited for fiction drafting and long-form creative writing, sorted by value (cheapest first). Tip: set routing_mode to \"creative\" and PORDL routes here automatically.",
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
        credits_per_1k_tokens: burnRates(m),
      },
      why: FICTION_NOTES[m.id] ?? "Good prose quality at its price point.",
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
        "Optimized for fiction drafting and long-form creative writing — prefers DeepSeek models for prose quality, never pays frontier prices. Auto-selected when PORDL detects creative-writing requests.",
    },
  });
});

export default router;
