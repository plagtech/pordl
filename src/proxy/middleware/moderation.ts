/**
 * Content-safety gate middleware.
 *
 * Mounted on /v1/chat/completions BEFORE the chat route, so no request can
 * reach a provider without passing the check. Flagged requests are refused
 * with a neutral 400 `content_policy` error — never rerouted to another
 * model, never silently degraded. Fails closed (503) if screening is
 * unavailable.
 *
 * Severe-category hits (sexual content involving minors) flag the API key
 * for review; repeated hits within 30 days auto-suspend the key pending
 * manual review.
 *
 * Logging is metadata only: timestamp, key ID, category, action taken.
 */

import { Request, Response, NextFunction } from "express";
import { config } from "../config";
import {
  screenMessages,
  ModerationUnavailableError,
  HAZARD_CATEGORIES,
} from "../services/moderation";
import {
  logKeyEvent,
  flagApiKeyForReview,
  countRecentSevereEvents,
  suspendApiKey,
} from "../db/supabase";

async function handleSevereHit(userId: string, keyId: string, category: string): Promise<void> {
  await logKeyEvent({
    user_id: userId,
    api_key_id: keyId,
    type: "moderation_severe",
    category,
    action: "refused_and_flagged",
  });
  await flagApiKeyForReview(keyId);

  const recent = await countRecentSevereEvents(keyId, 30);
  if (recent >= config.moderation.severeSuspendThreshold) {
    await suspendApiKey(keyId);
    await logKeyEvent({
      user_id: userId,
      api_key_id: keyId,
      type: "suspension",
      category,
      action: "auto_suspended_pending_review",
    });
    console.warn(
      `[Moderation] key=${keyId} auto-suspended pending review (${recent} severe hits/30d)`
    );
  }
}

export async function moderationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const messages = (req.body?.messages ?? []) as Array<{ role: string; content: string }>;
  if (!Array.isArray(messages) || messages.length === 0) {
    // Malformed request — let the route's own validation produce the error
    next();
    return;
  }

  try {
    const verdict = await screenMessages(messages);

    if (!verdict.flagged) {
      next();
      return;
    }

    const categoryNames = verdict.categories
      .map((c) => HAZARD_CATEGORIES[c] ?? c)
      .join(",");

    if (req.auth) {
      // Metadata-only logging: timestamp, key ID, category, action
      console.warn(
        `[Moderation] refused key=${req.auth.apiKey.id} category=${categoryNames} severe=${verdict.severe}`
      );
      if (verdict.severe) {
        handleSevereHit(
          req.auth.user.id,
          req.auth.apiKey.id,
          categoryNames
        ).catch((err) => console.error("[Moderation] severe-hit handling error:", err));
      } else {
        logKeyEvent({
          user_id: req.auth.user.id,
          api_key_id: req.auth.apiKey.id,
          type: "moderation_flag",
          category: categoryNames,
          action: "refused",
        }).catch((err) => console.error("[Moderation] event log error:", err));
      }
    }

    res.status(400).json({
      error: {
        message:
          "This request was declined by PORDL's automated content-safety check. " +
          "See https://api.pordl.dev/aup for the Acceptable Use Policy.",
        type: "invalid_request_error",
        code: "content_policy",
      },
    });
  } catch (err) {
    if (err instanceof ModerationUnavailableError) {
      console.error(`[Moderation] gate unavailable: ${err.message}`);
      res.status(503).json({
        error: {
          message:
            "The content-safety check is temporarily unavailable. Requests cannot be processed without it — please retry shortly.",
          type: "server_error",
          code: "moderation_unavailable",
        },
      });
      return;
    }
    console.error("[Moderation] unexpected error:", err);
    // Unknown failure inside the gate — fail closed
    res.status(503).json({
      error: {
        message:
          "The content-safety check is temporarily unavailable. Requests cannot be processed without it — please retry shortly.",
        type: "server_error",
        code: "moderation_unavailable",
      },
    });
  }
}
