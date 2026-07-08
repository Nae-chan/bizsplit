import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import * as schema from "@/db/schema";

type SendEmail = (opts: { to: string; subject: string; text: string }) => Promise<void>;
type AnyDrizzleDb = Parameters<typeof drizzleAdapter>[0];

/**
 * Auth configuration shared by production (src/lib/auth.ts) and tests.
 * Injecting db + email keeps the real config under test — the test suite
 * exercises the same options production runs with.
 */
export function createAuth(db: AnyDrizzleDb, sendEmail: SendEmail, baseURL: string) {
  return betterAuth({
    baseURL,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    user: {
      additionalFields: {
        brandName: { type: "string", required: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail({
          to: user.email,
          subject: "Reset your BizSplit password",
          text: `Hi ${user.name},\n\nReset your password here: ${url}\n\nIf you didn't request this, ignore this email.`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail({
          to: user.email,
          subject: "Verify your BizSplit email",
          text: `Hi ${user.name},\n\nWelcome to BizSplit! Verify your email here: ${url}`,
        });
      },
    },
  });
}
