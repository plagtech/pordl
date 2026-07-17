import { vi } from "vitest";

// Minimal Express req/res fakes for middleware-level tests
export function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    body: {},
    headers: {},
    ip: "203.0.113.7",
    ...overrides,
  } as any;
}

export function makeRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, unknown>,
    body: undefined as unknown,
    headersSent: false,
    status: vi.fn(function (this: any, code: number) {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn(function (this: any, payload: unknown) {
      res.body = payload;
      return res;
    }),
    setHeader: vi.fn((k: string, v: unknown) => {
      res.headers[k.toLowerCase()] = v;
    }),
    getHeader: (k: string) => res.headers[k.toLowerCase()],
    once: vi.fn(),
    on: vi.fn(),
  };
  return res;
}

export const fakeAuth = {
  user: { id: "user-1", email: "t@example.com", tier: "creator" },
  apiKey: { id: "key-1" },
} as any;

// Llama Guard-shaped HTTP responses
export function guardResponse(verdictText: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: verdictText } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
