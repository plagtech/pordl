/**
 * Usage tracking middleware.
 *
 * Checks if the user has exceeded their tier's monthly request limit.
 * Also enforces per-minute rate limits via Redis.
 */

import { Request, Response, NextFunction } from "express";
import { TIER_LIMITS } from "../config";
import { getMonthlyUsage } from "../db/supabase";
import { checkRateLimit } from "../services/cache";

// Rate limits per minute by tier
const RATE_LIMITS: Record<string, number> = {
  free: 10,
  starter: 60,
  pro: 120,
  scale: 300,
  enterprise: 1000,
};

export async function usageMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.auth) {
    next();
    return;
  }

  const { user, apiKey } = req.auth;
  const tier = user.tier || "free";

  try {
    // Check per-minute rate limit (Redis-backed)
    const rateLimit = await checkRateLimit(
      apiKey.id,
      RATE_LIMITS[tier] || 10
    );

    // Set rate limit headers (OpenAI convention)
    res.setHeader("x-ratelimit-limit-requests", RATE_LIMITS[tier] || 10);
    res.setHeader("x-ratelimit-remaining-requests", rateLimit.remaining);
    res.setHeader("x-ratelimit-reset-requests", `${Math.ceil(rateLimit.resetMs / 1000)}s`);

    if (!rateLimit.allowed) {
      res.status(429).json({
        error: {
          message: `Rate limit exceeded. ${tier} tier allows ${RATE_LIMITS[tier]} requests/min. Upgrade at https://pordl.dev/pricing`,
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      });
      return;
    }

    // Check monthly usage limit
    const monthlyUsage = await getMonthlyUsage(user.id);
    const monthlyLimit = TIER_LIMITS[tier] || 10_000;

    res.setHeader("x-monthly-limit", monthlyLimit);
    res.setHeader("x-monthly-used", monthlyUsage);
    res.setHeader("x-monthly-remaining", Math.max(0, monthlyLimit - monthlyUsage));

    if (monthlyUsage >= monthlyLimit) {
      res.status(429).json({
        error: {
          message: `Monthly limit of ${monthlyLimit.toLocaleString()} requests reached. Upgrade at https://pordl.dev/pricing`,
          type: "rate_limit_error",
          code: "monthly_limit_exceeded",
          usage: {
            used: monthlyUsage,
            limit: monthlyLimit,
            tier,
          },
        },
      });
      return;
    }

    next();
  } catch (err) {
    console.error("[Usage] Error checking limits:", err);
    // Fail open — don't block requests if usage check fails
    next();
  }
}
