import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getConnectionForUser, latestSyncJob, runSyncStep } from "@/lib/shopify/store";

const bodySchema = z.object({ jobId: z.string().min(1) });

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  // Ownership check: the job must belong to the caller's connection.
  const conn = await getConnectionForUser(session.user.id);
  const job = conn ? await latestSyncJob(conn.id) : null;
  if (!job || job.id !== parsed.data.jobId) {
    return NextResponse.json({ error: "Sync job not found" }, { status: 404 });
  }

  const updated = await runSyncStep(job.id);
  return NextResponse.json({
    status: updated.status,
    ordersSynced: updated.ordersSynced,
    error: updated.error ?? null,
  });
}
