/**
 * Smart Router — the core value proposition.
 *
 * Takes a classified request and picks the cheapest model
 * that meets the quality threshold for that complexity level.
 * Handles failover if a provider is down.
 */

import { Complexity } from "../utils/classifier";
import {
  ModelConfig,
  ProviderConfig,
  getAllModels,
  providers,
  findModel,
} from "./providers";

export type RoutingMode = "fast" | "balanced" | "best";

export interface RouteDecision {
  provider: string;
  model: ModelConfig;
  reason: string;
  estimatedSavingsVsOpenAI: number; // percentage
}

// ── Routing table ──────────────────────────────────────
// Maps (complexity, mode) → target tier

const ROUTE_TABLE: Record<RoutingMode, Record<Complexity, "budget" | "mid" | "frontier">> = {
  fast: {
    simple: "budget",
    moderate: "budget",
    complex: "mid",
  },
  balanced: {
    simple: "budget",
    moderate: "mid",
    complex: "frontier",
  },
  best: {
    simple: "mid",
    moderate: "frontier",
    complex: "frontier",
  },
};

// Preferred model order within each tier (cheapest first)
const TIER_PREFERENCES: Record<string, string[]> = {
  budget: ["gpt-4o-mini"],
  mid: ["gpt-4o"],
  frontier: ["gpt-5.4"],
};

// OpenAI GPT-4o pricing as baseline for savings calculation
const OPENAI_BASELINE_INPUT = 2.5; // $/MTok
const OPENAI_BASELINE_OUTPUT = 10.0;

// ── Main router ────────────────────────────────────────

export function routeRequest(
  complexity: Complexity,
  mode: RoutingMode,
  requestedModel?: string
): RouteDecision {
  // If user explicitly requests a specific model, honor it
  if (requestedModel && requestedModel !== "auto") {
    const found = findModel(requestedModel);
    if (found) {
      return {
        provider: found.provider.name,
        model: found.model,
        reason: `User requested ${requestedModel}`,
        estimatedSavingsVsOpenAI: calculateSavings(found.model),
      };
    }
    // Model not found — fall through to smart routing
  }

  // Look up target tier
  const targetTier = ROUTE_TABLE[mode][complexity];
  const preferredOrder = TIER_PREFERENCES[targetTier] || [];

  // Try each preferred model, skip unavailable providers
  for (const modelId of preferredOrder) {
    const found = findModel(modelId);
    if (found && found.provider.isAvailable) {
      return {
        provider: found.provider.name,
        model: found.model,
        reason: `${mode}/${complexity} → ${targetTier} tier → ${modelId}`,
        estimatedSavingsVsOpenAI: calculateSavings(found.model),
      };
    }
  }

  // Fallback: pick the cheapest available model overall
  const allModels = getAllModels();
  for (const model of allModels) {
    for (const [provName, prov] of providers) {
      if (prov.isAvailable && prov.models.some((m) => m.id === model.id)) {
        return {
          provider: provName,
          model,
          reason: `Fallback to cheapest available: ${model.id}`,
          estimatedSavingsVsOpenAI: calculateSavings(model),
        };
      }
    }
  }

  throw new Error("No available providers. All providers may be down or unconfigured.");
}

// ── Failover ───────────────────────────────────────────

export function getFailoverRoute(
  failedProvider: string,
  originalModel: ModelConfig
): RouteDecision | null {
  // Find a model in the same tier from a different provider
  const allModels = getAllModels().filter(
    (m) => m.tier === originalModel.tier
  );

  for (const model of allModels) {
    const found = findModel(model.id);
    if (found && found.provider.name !== failedProvider && found.provider.isAvailable) {
      return {
        provider: found.provider.name,
        model,
        reason: `Failover from ${failedProvider}: ${model.id}`,
        estimatedSavingsVsOpenAI: calculateSavings(model),
      };
    }
  }

  return null;
}

// ── Mark provider as down/up ───────────────────────────

const providerHealth = new Map<string, { downSince: number; retryAfter: number }>();

export function markProviderDown(providerName: string): void {
  const provider = providers.get(providerName);
  if (provider) {
    provider.isAvailable = false;
    providerHealth.set(providerName, {
      downSince: Date.now(),
      retryAfter: Date.now() + 60_000, // retry after 1 minute
    });
    console.warn(`[Router] Provider ${providerName} marked DOWN`);
  }
}

export function checkProviderHealth(): void {
  const now = Date.now();
  for (const [name, health] of providerHealth) {
    if (now > health.retryAfter) {
      const provider = providers.get(name);
      if (provider) {
        provider.isAvailable = true;
        providerHealth.delete(name);
        console.log(`[Router] Provider ${name} marked UP (retry window)`);
      }
    }
  }
}

// Run health check every 30 seconds
setInterval(checkProviderHealth, 30_000);

// ── Savings calculator ─────────────────────────────────

function calculateSavings(model: ModelConfig): number {
  const modelAvgCost = (model.inputCostPer1M + model.outputCostPer1M) / 2;
  const baselineAvgCost = (OPENAI_BASELINE_INPUT + OPENAI_BASELINE_OUTPUT) / 2;

  if (modelAvgCost >= baselineAvgCost) return 0;
  return Math.round(((baselineAvgCost - modelAvgCost) / baselineAvgCost) * 100);
}
