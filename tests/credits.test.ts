/**
 * Section 6 tests: credit metering.
 *  - the credit decrement matches (actual provider cost × M), i.e.
 *    credits = cost / CREDIT_UNIT_COST_USD
 *  - zero-balance hard stop (429, request never proceeds)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/proxy/db/supabase", () => ({
  getMonthlyCreditsUsed: vi.fn(async () => 0),
  getMonthlyTopupCredits: vi.fn(async () => 0),
  logKeyEvent: vi.fn(async () => {}),
  flagApiKeyForReview: vi.fn(async () => {}),
}));

import { CREDIT_UNIT_COST_USD, creditsForCost, TIER_LIMITS } from "../src/proxy/config";
import { usageMiddleware } from "../src/proxy/middleware/usage";
import {
  getMonthlyCreditsUsed,
  getMonthlyTopupCredits,
} from "../src/proxy/db/supabase";
import { makeReq, makeRes, fakeAuth } from "./helpers";

beforeEach(() => vi.clearAllMocks());

// Provider cost of N tokens at an input:output ratio for given $/MTok prices
function cost(tokens: number, inShare: number, outShare: number, inPrice: number, outPrice: number) {
  return (tokens * inShare * inPrice + tokens * outShare * outPrice) / 1_000_000;
}

describe("credit decrement = cost-based metering", () => {
  it("1K budget-model tokens at the 1:2 reference blend burn exactly 1000 credits", () => {
    const c = cost(1000, 1 / 3, 2 / 3, 0.14, 0.28); // deepseek-v4-flash
    expect(creditsForCost(c)).toBeCloseTo(1000, 6);
  });

  it("credits scale linearly with provider cost (cost × M invariance)", () => {
    const c1 = creditsForCost(0.01);
    const c2 = creditsForCost(0.02);
    expect(c2 / c1).toBeCloseTo(2, 10);
    expect(creditsForCost(0.01)).toBeCloseTo(0.01 / CREDIT_UNIT_COST_USD, 10);
  });

  it("premium models burn proportionally faster (gpt-4o at 1:2 ≈ 32,143 credits/1K)", () => {
    const c = cost(1000, 1 / 3, 2 / 3, 2.5, 10.0); // gpt-4o
    expect(creditsForCost(c)).toBeCloseTo(32142.857, 1);
  });

  it("zero-cost cached responses burn zero credits", () => {
    expect(creditsForCost(0)).toBe(0);
  });
});

describe("zero-balance hard stop", () => {
  it("refuses with 429 credits_exhausted when the allowance is used up", async () => {
    vi.mocked(getMonthlyCreditsUsed).mockResolvedValueOnce(TIER_LIMITS.creator);

    const req = makeReq({ auth: fakeAuth });
    const res = makeRes();
    const next = vi.fn();

    await usageMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect((res.body as any).error.code).toBe("credits_exhausted");
    // "no surprise bills": the refusal points at explicit upgrade/top-up only
    expect((res.body as any).error.message).toContain("never auto-charges");
  });

  it("allows requests under the limit and reports remaining credits", async () => {
    vi.mocked(getMonthlyCreditsUsed).mockResolvedValueOnce(400_000);

    const req = makeReq({ auth: fakeAuth });
    const res = makeRes();
    const next = vi.fn();

    await usageMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.headers["x-pordl-credits-remaining"]).toBe(600_000);
    expect(res.headers["x-pordl-credits-limit"]).toBe(TIER_LIMITS.creator);
  });

  it("explicit top-ups extend the month's allowance", async () => {
    vi.mocked(getMonthlyCreditsUsed).mockResolvedValueOnce(TIER_LIMITS.creator);
    vi.mocked(getMonthlyTopupCredits).mockResolvedValueOnce(1_000_000);

    const req = makeReq({ auth: fakeAuth });
    const res = makeRes();
    const next = vi.fn();

    await usageMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.headers["x-pordl-credits-remaining"]).toBe(1_000_000);
  });
});
