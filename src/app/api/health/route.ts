import { NextResponse } from "next/server";

/**
 * Railway deploy health check and uptime monitoring; DB-free on purpose.
 * Pre-deploy migrations already prove the database is reachable, and a query
 * here would wake Neon's idle compute on every check (ADR-0008).
 */
export function GET() {
  return NextResponse.json({ status: "ok", service: "bizsplit", time: new Date().toISOString() });
}
