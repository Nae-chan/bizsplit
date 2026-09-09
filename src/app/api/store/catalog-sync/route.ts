import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getConnectionForUser, latestSyncJob } from "@/lib/shopify/store";
import { lastCompletedCatalogSyncAt, startCatalogSync } from "@/lib/shopify/catalog";

/**
 * Start (or re-run) the product catalog sync. The browser then drives it one
 * page at a time through /api/store/sync-step, same as the order backfill.
 * A re-run is incremental: it only asks Shopify for products updated since the
 * last completed catalog sync.
 */
export async function POST() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const conn = await getConnectionForUser(session.user.id);
  if (!conn) return NextResponse.json({ error: "No connected store" }, { status: 404 });

  const existing = await latestSyncJob(conn.id, "products");
  if (existing?.status === "running") {
    // Hand back the running job so the UI can attach to it rather than start a second.
    return NextResponse.json({ jobId: existing.id, alreadyRunning: true }, { status: 409 });
  }

  const since = await lastCompletedCatalogSyncAt(conn.id);
  const job = await startCatalogSync(conn.id, since);
  return NextResponse.json({ jobId: job.id });
}
