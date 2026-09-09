import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getSyncJobForUser, runOrderSyncStep } from "@/lib/shopify/store";
import { runProductSyncStep } from "@/lib/shopify/catalog";

const bodySchema = z.object({ jobId: z.string().min(1) });

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  // Ownership check: the job must hang off a connection the caller owns.
  const job = await getSyncJobForUser(session.user.id, parsed.data.jobId);
  if (!job) return NextResponse.json({ error: "Sync job not found" }, { status: 404 });

  const updated =
    job.kind === "products" ? await runProductSyncStep(job.id) : await runOrderSyncStep(job.id);
  return NextResponse.json({
    status: updated.status,
    kind: updated.kind,
    itemsSynced: updated.itemsSynced,
    error: updated.error ?? null,
  });
}
