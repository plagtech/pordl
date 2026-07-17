/**
 * Auth routes — account management and API key generation.
 *
 * POST /auth/signup     — Create account
 * POST /auth/login      — Get session (returns API key)
 * POST /auth/keys       — Generate new API key
 * GET  /auth/keys       — List API keys
 * DELETE /auth/keys/:id — Revoke API key
 * GET  /auth/usage      — Get usage stats
 */

import { Router, Request, Response } from "express";
import { createHash } from "crypto";
import {
  createUser,
  getUserByEmail,
  createApiKey,
  getUsageStats,
  getMonthlyCreditsUsed,
  getMonthlyTopupCredits,
} from "../db/supabase";
import { generateApiKey, hashApiKey, authMiddleware } from "../middleware/auth";
import { getRedis } from "../services/cache";
import { config, TIER_LIMITS } from "../config";

const router = Router();

// ── Free-tier signup guardrails: per-IP and per-email-domain daily caps ──
// Best-effort (skipped without Redis); returns true when the signup is allowed.
async function checkSignupLimits(ip: string, email: string): Promise<boolean> {
  try {
    const client = await getRedis();
    if (!client) return true;

    const day = new Date().toISOString().slice(0, 10);
    const domain = (email.split("@")[1] || "unknown").toLowerCase();

    const ipKey = `pd:signup:ip:${ip}:${day}`;
    const domainKey = `pd:signup:domain:${domain}:${day}`;

    const [ipCount, domainCount] = await Promise.all([
      client.incr(ipKey),
      client.incr(domainKey),
    ]);
    await Promise.all([client.expire(ipKey, 86_400), client.expire(domainKey, 86_400)]);

    return (
      ipCount <= config.guardrails.signupsPerIpPerDay &&
      domainCount <= config.guardrails.signupsPerDomainPerDay
    );
  } catch {
    return true; // guardrail is best-effort
  }
}

// ── Signup ─────────────────────────────────────────────

router.post("/signup", async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, accepted_aup, confirmed_18_plus } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "email and password are required" });
      return;
    }

    if (password.length < 8) {
      res
        .status(400)
        .json({ error: "password must be at least 8 characters" });
      return;
    }

    // AUP acceptance and 18-or-older confirmation are required before any
    // key is issued. The acceptance timestamp is stored on the user record.
    if (accepted_aup !== true || confirmed_18_plus !== true) {
      res.status(400).json({
        error:
          "Signup requires accepted_aup: true and confirmed_18_plus: true. " +
          "Review the Acceptable Use Policy at https://api.pordl.dev/aup and " +
          "the Terms at https://api.pordl.dev/terms.",
        code: "aup_acceptance_required",
      });
      return;
    }

    // Free-tier abuse guardrail: per-IP / per-email-domain daily caps
    const allowed = await checkSignupLimits(req.ip || "unknown", email);
    if (!allowed) {
      res.status(429).json({
        error: "Too many signups from this network today. Try again tomorrow or contact support@pordl.dev.",
        code: "signup_limit_exceeded",
      });
      return;
    }

    // Check if email already exists
    const existing = await getUserByEmail(email);
    if (existing) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }

    // Create user (records AUP acceptance + 18+ confirmation timestamp)
    const passwordHash = createHash("sha256").update(password).digest("hex");
    const user = await createUser(
      email,
      passwordHash,
      new Date().toISOString(),
      true
    );

    // Generate first API key
    const rawKey = generateApiKey("live");
    const keyHash = hashApiKey(rawKey);
    const keyPrefix = rawKey.substring(0, 12) + "...";

    await createApiKey(user.id, keyHash, keyPrefix, "default", "free");

    res.status(201).json({
      message: "Account created",
      user: {
        id: user.id,
        email: user.email,
        tier: user.tier,
      },
      api_key: rawKey, // Only time the full key is shown!
      note: "Save this API key — it won't be shown again.",
      quickstart: {
        curl: `curl https://api.pordl.dev/v1/chat/completions -H "Authorization: Bearer ${rawKey}" -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"Hello"}]}'`,
        node: `import OpenAI from 'openai';\nconst client = new OpenAI({ apiKey: '${rawKey}', baseURL: 'https://api.pordl.dev/v1' });`,
        python: `from openai import OpenAI\nclient = OpenAI(api_key="${rawKey}", base_url="https://api.pordl.dev/v1")`,
      },
    });
  } catch (err: any) {
    console.error("[Auth] Signup error:", err);
    res.status(500).json({ error: "Failed to create account" });
  }
});

// ── Login ──────────────────────────────────────────────

router.post("/login", async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "email and password are required" });
      return;
    }

    const user = await getUserByEmail(email);
    if (!user) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const passwordHash = createHash("sha256").update(password).digest("hex");
    // Note: In production, use bcrypt. SHA256 is placeholder for speed.
    // TODO: Migrate to bcrypt before launch

    // Generate a new API key on login
    const rawKey = generateApiKey("live");
    const keyHash = hashApiKey(rawKey);
    const keyPrefix = rawKey.substring(0, 12) + "...";

    await createApiKey(user.id, keyHash, keyPrefix, `login-${Date.now()}`, user.tier);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        tier: user.tier,
      },
      api_key: rawKey,
    });
  } catch (err: any) {
    console.error("[Auth] Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// ── Generate new API key ───────────────────────────────

router.post(
  "/keys",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { label } = req.body;
      const user = req.auth!.user;

      const rawKey = generateApiKey("live");
      const keyHash = hashApiKey(rawKey);
      const keyPrefix = rawKey.substring(0, 12) + "...";

      await createApiKey(
        user.id,
        keyHash,
        keyPrefix,
        label || "unnamed",
        user.tier
      );

      res.status(201).json({
        api_key: rawKey,
        prefix: keyPrefix,
        label: label || "unnamed",
        note: "Save this API key — it won't be shown again.",
      });
    } catch (err: any) {
      console.error("[Auth] Key generation error:", err);
      res.status(500).json({ error: "Failed to generate key" });
    }
  }
);

// ── Usage stats ────────────────────────────────────────

router.get(
  "/usage",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const user = req.auth!.user;
      const days = parseInt(req.query.days as string) || 30;

      const [stats, creditsUsed, topupCredits] = await Promise.all([
        getUsageStats(user.id, days),
        getMonthlyCreditsUsed(user.id),
        getMonthlyTopupCredits(user.id),
      ]);

      const creditLimit = (TIER_LIMITS[user.tier] ?? TIER_LIMITS.free) + topupCredits;

      // Projected month-end usage: linear extrapolation of this month's burn
      const now = new Date();
      const dayOfMonth = now.getUTCDate();
      const daysInMonth = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)
      ).getUTCDate();
      const projected = Math.round((creditsUsed / dayOfMonth) * daysInMonth);

      res.json({
        tier: user.tier,
        period_days: days,
        credits: {
          used: Math.round(creditsUsed),
          limit: creditLimit,
          remaining: Math.max(0, Math.floor(creditLimit - creditsUsed)),
          topup_credits_this_month: topupCredits,
          projected_month_end: projected,
          note: "1 credit = 1 budget-model token; premium models burn credits faster (see /v1/models)",
        },
        ...stats,
      });
    } catch (err: any) {
      console.error("[Auth] Usage stats error:", err);
      res.status(500).json({ error: "Failed to get usage stats" });
    }
  }
);

export default router;
