import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { costHistoryForVariant, variantOwnedByUser } from "@/lib/cogs/store";
import { resolveCostAt, todayInShop } from "@/lib/cogs/resolve";
import { VariantCostForm } from "@/components/VariantCostForm";
import { formatMoney, money } from "@/lib/money";

export default async function VariantCostPage({
  params,
}: {
  params: Promise<{ variantId: string }>;
}) {
  const { user } = await requireSession();
  const { variantId } = await params;
  const owned = await variantOwnedByUser(user.id, decodeGid(variantId));
  // Same answer for "not yours" as for "does not exist".
  if (!owned) notFound();

  const { variant, product, connection } = owned;
  const history = await costHistoryForVariant(variant.id);
  const current = resolveCostAt(history, new Date());
  const dateFormat = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: connection.ianaTimezone ?? "UTC",
  });

  return (
    <main className="mx-auto max-w-2xl p-8">
      <Link
        href="/products"
        className="mb-4 inline-block text-sm text-gray-500 hover:text-gray-900"
      >
        ← Back to products
      </Link>
      <h1 className="text-2xl font-bold">{product.title}</h1>
      <p className="mb-6 text-sm text-gray-500">
        {variant.title}
        {variant.sku ? ` · ${variant.sku}` : ""} · price{" "}
        {formatMoney(money(variant.priceCents, connection.currency))}
      </p>

      <div className="mb-6 rounded-xl border border-gray-200 p-5">
        <p className="text-sm text-gray-500">Cost today</p>
        <p className="text-lg font-medium">
          {current === null ? (
            <span className="text-amber-600">Not set</span>
          ) : (
            formatMoney(money(current.unitCostCents, current.currency))
          )}
        </p>
      </div>

      <section className="mb-8">
        <h2 className="mb-1 text-lg font-semibold">Add a cost</h2>
        <p className="mb-3 text-sm text-gray-600">
          Costs are kept as a dated history rather than a single value: adding one never replaces an
          older record, so an order placed before this date still resolves to the cost that was in
          force when it was placed. Dates are read as midnight
          {connection.ianaTimezone ? ` in ${connection.ianaTimezone}` : " UTC"}.
        </p>
        <VariantCostForm
          variantId={variant.id}
          currency={connection.currency}
          defaultDate={todayInShop(connection.ianaTimezone)}
        />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Cost history</h2>
        {history.length === 0 ? (
          <p className="text-sm text-gray-500">No cost recorded for this variant yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="py-2 font-normal">Effective from</th>
                <th className="py-2 text-right font-normal">Unit cost</th>
                <th className="py-2 font-normal">Note</th>
                <th className="py-2 text-right font-normal">Entered on</th>
              </tr>
            </thead>
            <tbody>
              {history.map((cost) => (
                <tr key={cost.id} className="border-b border-gray-100">
                  <td className="py-2">{dateFormat.format(cost.effectiveFrom)}</td>
                  <td className="py-2 text-right">
                    {formatMoney(money(cost.unitCostCents, cost.currency))}
                  </td>
                  <td className="py-2 text-gray-500">{cost.note ?? "—"}</td>
                  <td className="py-2 text-right text-gray-500">
                    {dateFormat.format(cost.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

/**
 * The route segment is a Shopify GID ("gid://shopify/ProductVariant/1"), so the
 * link percent-encodes it. Decode defensively: already-decoded input comes back
 * unchanged, and a stray "%" is treated as a literal rather than throwing.
 */
function decodeGid(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
