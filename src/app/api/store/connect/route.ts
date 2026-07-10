import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { syncJob } from "@/db/schema";
import { normalizeShopDomain, shopifyGraphql, ShopifyApiError } from "@/lib/shopify/client";
import { WEBHOOK_CREATE_MUTATION } from "@/lib/shopify/queries";
import { createConnection, getConnectionForUser } from "@/lib/shopify/store";

const bodySchema = z.object({
  shopDomain: z.string().min(1),
  accessToken: z.string().trim().min(10),
  webhookSecret: z.string().trim().min(10),
  backfillStartDate: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date"),
});

const WEBHOOK_TOPICS = ["ORDERS_CREATE", "ORDERS_UPDATED"] as const;

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  if (await getConnectionForUser(session.user.id)) {
    return NextResponse.json(
      { error: "You already have a connected store. Disconnect it first." },
      { status: 409 },
    );
  }

  let shopDomain: string;
  try {
    shopDomain = normalizeShopDomain(parsed.data.shopDomain);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    const conn = await createConnection({
      userId: session.user.id,
      shopDomain,
      accessToken: parsed.data.accessToken,
      webhookSecret: parsed.data.webhookSecret,
    });

    // Register webhooks so new orders arrive in real time.
    const callbackUrl = `${process.env.BETTER_AUTH_URL ?? "http://localhost:3000"}/api/webhooks/shopify`;
    const warnings: string[] = [];
    for (const topic of WEBHOOK_TOPICS) {
      const res = await shopifyGraphql<{
        webhookSubscriptionCreate: { userErrors: Array<{ message: string }> };
      }>(shopDomain, parsed.data.accessToken, WEBHOOK_CREATE_MUTATION, { topic, callbackUrl });
      for (const err of res.webhookSubscriptionCreate.userErrors) {
        warnings.push(`${topic}: ${err.message}`);
      }
    }

    const jobId = randomUUID();
    await db.insert(syncJob).values({
      id: jobId,
      connectionId: conn.id,
      startDate: new Date(parsed.data.backfillStartDate),
    });

    return NextResponse.json({ ok: true, shopName: conn.shopName, jobId, warnings });
  } catch (e) {
    if (e instanceof ShopifyApiError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json(
        { error: "Shopify rejected the access token — double-check it and the app's scopes." },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
