import { describe, test, expect, vi, beforeEach } from "vitest";
import { jwtVerify } from "jose";

// vi.hoisted ensures these run before vi.mock factories (which are hoisted)
const { mockCookieSet, mockCookieGet, mockCookieDelete, mockCookies } =
  vi.hoisted(() => {
    const mockCookieSet = vi.fn();
    const mockCookieGet = vi.fn();
    const mockCookieDelete = vi.fn();
    const mockCookieStore = {
      set: mockCookieSet,
      get: mockCookieGet,
      delete: mockCookieDelete,
    };
    const mockCookies = vi.fn().mockResolvedValue(mockCookieStore);
    return { mockCookieSet, mockCookieGet, mockCookieDelete, mockCookies };
  });

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  cookies: mockCookies,
}));

import { createSession } from "../auth";

const JWT_SECRET = new TextEncoder().encode("development-secret-key");

describe("createSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookies.mockResolvedValue({
      set: mockCookieSet,
      get: mockCookieGet,
      delete: mockCookieDelete,
    });
  });

  test("sets the auth-token cookie", async () => {
    await createSession("user-123", "user@example.com");

    expect(mockCookieSet).toHaveBeenCalledOnce();
    const [cookieName] = mockCookieSet.mock.calls[0];
    expect(cookieName).toBe("auth-token");
  });

  test("cookie value is a valid signed JWT", async () => {
    await createSession("user-123", "user@example.com");

    const [, token] = mockCookieSet.mock.calls[0];
    const { payload } = await jwtVerify(token, JWT_SECRET);
    expect(payload).toBeDefined();
  });

  test("JWT payload contains userId and email", async () => {
    await createSession("user-123", "user@example.com");

    const [, token] = mockCookieSet.mock.calls[0];
    const { payload } = await jwtVerify(token, JWT_SECRET);
    expect(payload.userId).toBe("user-123");
    expect(payload.email).toBe("user@example.com");
  });

  test("cookie is httpOnly", async () => {
    await createSession("user-123", "user@example.com");

    const [, , options] = mockCookieSet.mock.calls[0];
    expect(options.httpOnly).toBe(true);
  });

  test("cookie is not secure outside production", async () => {
    // NODE_ENV is 'test' in vitest, not 'production'
    await createSession("user-123", "user@example.com");

    const [, , options] = mockCookieSet.mock.calls[0];
    expect(options.secure).toBe(false);
  });

  test("cookie sameSite is lax and path is /", async () => {
    await createSession("user-123", "user@example.com");

    const [, , options] = mockCookieSet.mock.calls[0];
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
  });

  test("cookie expires approximately 7 days from now", async () => {
    const before = Date.now();
    await createSession("user-123", "user@example.com");
    const after = Date.now();

    const [, , options] = mockCookieSet.mock.calls[0];
    const expiresMs = options.expires.getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    expect(expiresMs).toBeGreaterThanOrEqual(before + sevenDaysMs);
    expect(expiresMs).toBeLessThanOrEqual(after + sevenDaysMs);
  });
});
