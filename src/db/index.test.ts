import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

/**
 * Imports the real pool, not the `vi.mock("@/db")` the integration tests use.
 * Constructing a Pool opens no connection, and nothing here queries, but the
 * URL is pinned to an unused local port anyway so this file can never reach
 * whatever database the environment points at.
 */

let pool: Pool;

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", "postgres://test:test@127.0.0.1:1/unused");
  ({ pool } = await import("./index"));
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("db pool", () => {
  it("logs an idle-client error instead of crashing the process", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(pool.listenerCount("error")).toBeGreaterThan(0);
    expect(() =>
      pool.emit("error", new Error("terminating connection due to administrator command")),
    ).not.toThrow();
    expect(logged.mock.calls.flat().join(" ")).toMatch(/terminating connection/);
  });

  it("is sized and timed out for a single long-lived process", () => {
    expect(pool.options).toMatchObject({
      max: 10,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
  });
});
