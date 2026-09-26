import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { decimalToCents } from "@/lib/money";
import { shopDateToInstant } from "@/lib/cogs/resolve";
import { insertVariantCost, variantOwnedByUser } from "@/lib/cogs/store";

/**
 * Record a cost of goods for a variant. Append-only by design: there is no
 * PUT/PATCH/DELETE here, because correcting a cost means adding another
 * effective-dated row so past orders keep resolving to the cost in force then.
 */

/** Anything above this is a fat-fingered decimal, not a unit cost. */
const MAX_UNIT_COST_CENTS = 10_000_000;

const bodySchema = z.object({
  variantId: z.string().min(1),
  unitCost: z.string().min(1),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Effective date must be YYYY-MM-DD"),
  note: z.string().max(200).optional(),
});

export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  // The integer-cents boundary (ADR-0004): the decimal string stops here.
  let unitCostCents: number;
  try {
    unitCostCents = decimalToCents(parsed.data.unitCost);
  } catch {
    return NextResponse.json(
      { error: "Unit cost must be an amount like 12.34, with at most 2 decimal places" },
      { status: 400 },
    );
  }
  if (unitCostCents < 0) {
    return NextResponse.json({ error: "Unit cost cannot be negative" }, { status: 400 });
  }
  if (unitCostCents > MAX_UNIT_COST_CENTS) {
    return NextResponse.json({ error: "Unit cost is implausibly large" }, { status: 400 });
  }

  const owned = await variantOwnedByUser(session.user.id, parsed.data.variantId);
  if (!owned) return NextResponse.json({ error: "Variant not found" }, { status: 404 });

  const cost = await insertVariantCost({
    variantId: owned.variant.id,
    unitCostCents,
    // Currency is inherited from the connection: ADR-0004 makes cross-currency
    // arithmetic throw and there is no FX story yet.
    currency: owned.connection.currency,
    effectiveFrom: shopDateToInstant(parsed.data.effectiveFrom, owned.connection.ianaTimezone),
    note: parsed.data.note?.trim() || null,
    createdByUserId: session.user.id,
  });
  return NextResponse.json({ cost }, { status: 201 });
}
