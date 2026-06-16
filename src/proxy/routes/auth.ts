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
} from "../db/supabase";
import { generateApiKey, hashApiKey, authMiddleware } from "../middleware/auth";

const router = Router();

// ── Signup ─────────────────────────────────────────────

router.post("/signup", async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

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

    // Check if email already exists
    const existing = await getUserByEmail(email);
    if (existing) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }

    // Create user
    const passwordHash = createHash("sha256").update(password).digest("hex");
    const user = await createUser(email, passwordHash);

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

      const stats = await getUsageStats(user.id, days);

      res.json({
        tier: user.tier,
        period_days: days,
        ...stats,
      });
    } catch (err: any) {
      console.error("[Auth] Usage stats error:", err);
      res.status(500).json({ error: "Failed to get usage stats" });
    }
  }
);

export default router;
