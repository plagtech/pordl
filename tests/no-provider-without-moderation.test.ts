/**
 * Section 6 test: no request reaches any provider without a moderation pass.
 *
 * 1. Integration: an express pipeline with the real moderation middleware in
 *    front of a stub provider route — flagged and gate-down requests must
 *    never reach the provider handler.
 * 2. Wiring: the production app mounts moderationMiddleware between the
 *    limits middleware and the chat route on /v1/chat/completions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";

vi.mock("../src/proxy/db/supabase", () => ({
  logKeyEvent: vi.fn(async () => {}),
  flagApiKeyForReview: vi.fn(async () => {}),
  suspendApiKey: vi.fn(async () => {}),
  countRecentSevereEvents: vi.fn(async () => 0),
}));

import { moderationMiddleware } from "../src/proxy/middleware/moderation";
import { _deps } from "../src/proxy/services/moderation";
import { guardResponse } from "./helpers";

function buildApp(providerSpy: () => void) {
  const app = express();
  app.use(express.json());
  app.post("/v1/chat/completions", moderationMiddleware, (_req, res) => {
    providerSpy(); // stands in for the provider call
    res.json({ ok: true });
  });
  return app;
}

async function post(app: express.Express, body: unknown) {
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  try {
    return await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } finally {
    server.close();
  }
}

beforeEach(() => vi.clearAllMocks());

describe("no provider call without moderation pass", () => {
  it("flagged request never reaches the provider", async () => {
    _deps.fetchFn = vi.fn(async () => guardResponse("unsafe\nS2")) as any;
    const provider = vi.fn();

    const res = await post(buildApp(provider), {
      messages: [{ role: "user", content: "flagged" }],
    });

    expect(res.status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it("gate outage (fail closed) never reaches the provider", async () => {
    _deps.fetchFn = vi.fn(async () => {
      throw new Error("network down");
    }) as any;
    const provider = vi.fn();

    const res = await post(buildApp(provider), {
      messages: [{ role: "user", content: "anything" }],
    });

    expect(res.status).toBe(503);
    expect(provider).not.toHaveBeenCalled();
  });

  it("clean request reaches the provider exactly once", async () => {
    _deps.fetchFn = vi.fn(async () => guardResponse("safe")) as any;
    const provider = vi.fn();

    const res = await post(buildApp(provider), {
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.status).toBe(200);
    expect(provider).toHaveBeenCalledOnce();
  });

  it("production app mounts the gate before the chat route", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../src/index.ts"),
      "utf-8"
    );
    expect(src).toMatch(
      /\/v1\/chat\/completions',\s*authMiddleware,\s*usageMiddleware,\s*moderationMiddleware,\s*chatRoutes/
    );
  });
});
