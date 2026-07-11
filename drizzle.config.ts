import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit runs outside Next.js and doesn't read .env.local on its own.
// Load it here (no-op when the file doesn't exist, e.g. in CI/Render where
// DATABASE_URL is a real environment variable).
config({ path: ".env.local", quiet: true });

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Define it in .env.local (dev) or the environment (CI/Render).",
  );
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
