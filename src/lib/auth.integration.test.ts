import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import * as schema from "@/db/schema";
import { createAuth } from "./auth-config";

/**
 * Full auth-flow integration tests against an in-memory Postgres (PGlite).
 * Same migrations, same auth config as production; emails are captured
 * instead of sent so we can follow verification/reset links.
 */

type CapturedEmail = { to: string; subject: string; text: string };
const outbox: CapturedEmail[] = [];

function lastEmailTo(email: string): CapturedEmail {
  const found = [...outbox].reverse().find((e) => e.to === email);
  if (!found) throw new Error(`No email captured for ${email}`);
  return found;
}

function extractToken(text: string): string {
  const raw = text.match(/https?:\/\/\S+/)?.[0];
  if (!raw) throw new Error(`No URL in email body:\n${text}`);
  const url = new URL(raw);
  // Query style: /verify-email?token=abc — path style: /reset-password/abc
  const fromQuery = url.searchParams.get("token");
  if (fromQuery) return fromQuery;
  const lastSegment = url.pathname.split("/").filter(Boolean).pop();
  if (lastSegment && !["verify-email", "reset-password"].includes(lastSegment)) return lastSegment;
  throw new Error(`No token found in URL: ${raw}`);
}

let auth: ReturnType<typeof createAuth>;

beforeAll(async () => {
  const client = new PGlite();
  const db = drizzle(client, { schema });

  // Apply the real migration files, in order.
  const dir = path.resolve(__dirname, "../../drizzle");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(path.join(dir, file), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }

  auth = createAuth(
    db,
    async (opts) => {
      outbox.push(opts);
    },
    "http://localhost:3000",
  );
});

describe("auth flow", () => {
  const email = "nae@example.com";
  const password = "correct-horse-battery";

  it("signs up and sends a verification email", async () => {
    const res = await auth.api.signUpEmail({
      body: { name: "Nae", email, password, brandName: "Ripright" },
    });
    expect(res.user.email).toBe(email);
    expect(lastEmailTo(email).subject).toMatch(/verify/i);
  });

  it("blocks login before email verification", async () => {
    await expect(auth.api.signInEmail({ body: { email, password } })).rejects.toMatchObject({
      status: expect.stringMatching(/403|FORBIDDEN/),
    });
  });

  it("verifies email via the emailed token, then allows login", async () => {
    const token = extractToken(lastEmailTo(email).text);
    await auth.api.verifyEmail({ query: { token } });
    const res = await auth.api.signInEmail({ body: { email, password } });
    expect(res.user.email).toBe(email);
    expect(res.token).toBeTruthy();
  });

  it("rejects a wrong password", async () => {
    await expect(
      auth.api.signInEmail({ body: { email, password: "totally-wrong-pw" } }),
    ).rejects.toMatchObject({ status: expect.stringMatching(/401|UNAUTHORIZED/) });
  });

  it("resets password via the emailed token", async () => {
    await auth.api.requestPasswordReset({ body: { email, redirectTo: "/reset-password" } });
    const token = extractToken(lastEmailTo(email).text);
    const newPassword = "brand-new-secret-pw";
    await auth.api.resetPassword({ body: { newPassword, token } });

    await expect(auth.api.signInEmail({ body: { email, password } })).rejects.toBeTruthy(); // old password dead
    const res = await auth.api.signInEmail({ body: { email, password: newPassword } });
    expect(res.user.email).toBe(email); // new password works
  });

  it("stores the brandName additional field", async () => {
    const res = await auth.api.signInEmail({
      body: { email, password: "brand-new-secret-pw" },
    });
    expect((res.user as { brandName?: string }).brandName).toBe("Ripright");
  });
});
