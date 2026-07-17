/**
 * Section 6 tests: the content-safety gate.
 *  - flagged requests return the policy error and are never forwarded
 *  - severe-category (sexual/minors) hits flag the key; repeats suspend it
 *  - the gate fails closed when screening is unavailable
 *  - permitted categories are not refused
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/proxy/db/supabase", () => ({
  logKeyEvent: vi.fn(async () => {}),
  flagApiKeyForReview: vi.fn(async () => {}),
  suspendApiKey: vi.fn(async () => {}),
  countRecentSevereEvents: vi.fn(async () => 1),
}));

import { moderationMiddleware } from "../src/proxy/middleware/moderation";
import { _deps } from "../src/proxy/services/moderation";
import {
  logKeyEvent,
  flagApiKeyForReview,
  suspendApiKey,
  countRecentSevereEvents,
} from "../src/proxy/db/supabase";
import { makeReq, makeRes, fakeAuth, guardResponse } from "./helpers";

const flush = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("moderation gate", () => {
  it("refuses flagged requests with 400 content_policy and never calls next()", async () => {
    _deps.fetchFn = vi.fn(async () => guardResponse("unsafe\nS1")) as any;

    const req = makeReq({
      auth: fakeAuth,
      body: { messages: [{ role: "user", content: "flagged content" }] },
    });
    const res = makeRes();
    const next = vi.fn();

    await moderationMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error.code).toBe("content_policy");
    // The refusal must not echo the request content back
    expect(JSON.stringify(res.body)).not.toContain("flagged content");
  });

  it("passes clean requests through to the route", async () => {
    _deps.fetchFn = vi.fn(async () => guardResponse("safe")) as any;

    const req = makeReq({
      auth: fakeAuth,
      body: { messages: [{ role: "user", content: "write a chapter about sailing" }] },
    });
    const res = makeRes();
    const next = vi.fn();

    await moderationMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("does not refuse permitted categories (e.g. S12 adult fiction)", async () => {
    _deps.fetchFn = vi.fn(async () => guardResponse("unsafe\nS12")) as any;

    const req = makeReq({
      auth: fakeAuth,
      body: { messages: [{ role: "user", content: "romance scene" }] },
    });
    const res = makeRes();
    const next = vi.fn();

    await moderationMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("severe category (S4) flags the API key for review", async () => {
    _deps.fetchFn = vi.fn(async () => guardResponse("unsafe\nS4")) as any;

    const req = makeReq({
      auth: fakeAuth,
      body: { messages: [{ role: "user", content: "x" }] },
    });
    const res = makeRes();
    const next = vi.fn();

    await moderationMiddleware(req, res, next);
    await flush();

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(flagApiKeyForReview).toHaveBeenCalledWith("key-1");
    expect(logKeyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "moderation_severe", api_key_id: "key-1" })
    );
    // Below the repeat threshold — not suspended
    expect(suspendApiKey).not.toHaveBeenCalled();
  });

  it("repeated severe hits auto-suspend the key pending review", async () => {
    vi.mocked(countRecentSevereEvents).mockResolvedValueOnce(3);
    _deps.fetchFn = vi.fn(async () => guardResponse("unsafe\nS4")) as any;

    const req = makeReq({
      auth: fakeAuth,
      body: { messages: [{ role: "user", content: "x" }] },
    });
    const res = makeRes();

    await moderationMiddleware(req, res, vi.fn());
    await flush();

    expect(suspendApiKey).toHaveBeenCalledWith("key-1");
    expect(logKeyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "suspension" })
    );
  });

  it("fails closed with 503 when the moderation provider errors", async () => {
    _deps.fetchFn = vi.fn(async () => new Response("boom", { status: 500 })) as any;

    const req = makeReq({
      auth: fakeAuth,
      body: { messages: [{ role: "user", content: "anything" }] },
    });
    const res = makeRes();
    const next = vi.fn();

    await moderationMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect((res.body as any).error.code).toBe("moderation_unavailable");
  });

  it("fails closed on unparseable classifier output", async () => {
    _deps.fetchFn = vi.fn(async () => guardResponse("garbage output")) as any;

    const req = makeReq({
      auth: fakeAuth,
      body: { messages: [{ role: "user", content: "anything" }] },
    });
    const res = makeRes();
    const next = vi.fn();

    await moderationMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });

  it("moderation-flag logging is metadata only (no message content)", async () => {
    _deps.fetchFn = vi.fn(async () => guardResponse("unsafe\nS1,S2")) as any;

    const req = makeReq({
      auth: fakeAuth,
      body: { messages: [{ role: "user", content: "super secret prompt text" }] },
    });
    const res = makeRes();

    await moderationMiddleware(req, res, vi.fn());
    await flush();

    for (const call of vi.mocked(logKeyEvent).mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain("super secret prompt text");
    }
  });
});
