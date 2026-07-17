/**
 * Section 3 test: signup requires AUP acceptance + 18-or-older confirmation
 * before any key is issued, and records the acceptance timestamp.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";

vi.mock("../src/proxy/db/supabase", () => ({
  createUser: vi.fn(async () => ({
    id: "user-1",
    email: "new@example.com",
    tier: "free",
  })),
  getUserByEmail: vi.fn(async () => null),
  createApiKey: vi.fn(async () => ({ id: "key-1" })),
  getUsageStats: vi.fn(async () => ({})),
  getMonthlyCreditsUsed: vi.fn(async () => 0),
  getMonthlyTopupCredits: vi.fn(async () => 0),
}));

import authRoutes from "../src/proxy/routes/auth";
import { createUser, createApiKey } from "../src/proxy/db/supabase";

async function postSignup(body: unknown) {
  const app = express();
  app.use(express.json());
  app.use("/proxy/auth", authRoutes);
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/proxy/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  } finally {
    server.close();
  }
}

beforeEach(() => vi.clearAllMocks());

describe("signup AUP gating", () => {
  it("refuses signup without AUP acceptance — no key issued", async () => {
    const { status, json } = await postSignup({
      email: "new@example.com",
      password: "longenough",
    });

    expect(status).toBe(400);
    expect(json.code).toBe("aup_acceptance_required");
    expect(createUser).not.toHaveBeenCalled();
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it("refuses signup without the 18-or-older confirmation", async () => {
    const { status } = await postSignup({
      email: "new@example.com",
      password: "longenough",
      accepted_aup: true,
      confirmed_18_plus: false,
    });

    expect(status).toBe(400);
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it("accepts signup with both flags and stores the acceptance timestamp", async () => {
    const { status, json } = await postSignup({
      email: "new@example.com",
      password: "longenough",
      accepted_aup: true,
      confirmed_18_plus: true,
    });

    expect(status).toBe(201);
    expect(json.api_key).toMatch(/^pd_live_/);
    expect(createUser).toHaveBeenCalledOnce();
    const [, , aupAcceptedAt, confirmed] = vi.mocked(createUser).mock.calls[0];
    expect(new Date(aupAcceptedAt as string).getTime()).toBeGreaterThan(0);
    expect(confirmed).toBe(true);
  });
});
