/**
 * API key authentication middleware.
 *
 * Keys follow the format: pd_live_<random> or pd_test_<random>
 * Stored as SHA-256 hashes in Supabase.
 */

import { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";
import { getApiKeyByHash, ApiKey, User } from "../db/supabase";

// Extend Express Request to include auth context
declare global {
  namespace Express {
    interface Request {
      auth?: {
        user: User;
        apiKey: ApiKey;
      };
    }
  }
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(env: "live" | "test" = "live"): string {
  const id = createHash("sha256")
    .update(Math.random().toString() + Date.now().toString())
    .digest("hex")
    .substring(0, 32);
  return `pd_${env}_${id}`;
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({
      error: {
        message: "Missing Authorization header. Use: Authorization: Bearer pd_live_...",
        type: "authentication_error",
        code: "missing_api_key",
      },
    });
    return;
  }

  const key = authHeader.replace("Bearer ", "").trim();

  if (!key.startsWith("pd_")) {
    res.status(401).json({
      error: {
        message: "Invalid API key format. Keys start with pd_live_ or pd_test_",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    });
    return;
  }

  try {
    const keyHash = hashApiKey(key);
    const record = await getApiKeyByHash(keyHash);

    if (!record) {
      res.status(401).json({
        error: {
          message: "Invalid API key",
          type: "authentication_error",
          code: "invalid_api_key",
        },
      });
      return;
    }

    // Attach auth context to request
    req.auth = {
      user: record.user,
      apiKey: record,
    };

    next();
  } catch (err) {
    console.error("[Auth] Error validating key:", err);
    res.status(500).json({
      error: {
        message: "Authentication service error",
        type: "server_error",
        code: "auth_error",
      },
    });
  }
}
