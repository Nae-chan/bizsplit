import { db } from "@/db";
import { sendEmail } from "@/lib/email";
import { createAuth } from "@/lib/auth-config";

export const auth = createAuth(
  db,
  sendEmail,
  process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
);
