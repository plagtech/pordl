/**
 * GET /v1/models — List available models.
 * OpenAI-compatible format so existing tools work.
 */

import { Router, Request, Response } from "express";
import { getAllModels } from "../services/providers";

const router = Router();

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
      },
    })),
  };

  res.json(openaiFormat);
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
    },
  });
});

export default router;
