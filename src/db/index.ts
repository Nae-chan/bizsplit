import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});

// Neon ends idle connections when its compute restarts or scales to zero. An
// idle client's error surfaces on the pool, and an unhandled `error` event
// would take the whole process down.
pool.on("error", (err) => console.error("[db] idle client error:", err.message));

export const db = drizzle(pool, { schema });
