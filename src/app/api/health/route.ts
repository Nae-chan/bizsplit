import { NextResponse } from "next/server";

/**
 * Health check used by Render and uptime monitoring.
 * Database connectivity check will be added once the app has real queries (Chunk 1).
 */
export function GET() {
  return NextResponse.json({ status: "ok", service: "bizsplit", time: new Date().toISOString() });
}
