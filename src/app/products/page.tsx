import { Fragment } from "react";
import Link from "next/link";
import { requireSession } from "@/lib/session";
import { getConnectionForUser, latestSyncJob } from "@/lib/shopify/store";
import { listCatalog, resolveVariantCostsAt } from "@/lib/cogs/store";
import { CatalogSyncButton } from "@/components/CatalogSyncButton";
import { formatMoney, money } from "@/lib/money";

const PAGE_SIZE = 25;

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { user } = await requireSession();
  const connection = await getConnectionForUser(user.id);
  const { q, page } = await searchParams;

  const pageNumber = Math.max(1, Number(page) || 1);
  const catalog = connection
    ? await listCatalog({
        connectionId: connection.id,
        q,
        limit: PAGE_SIZE,
        offset: (pageNumber - 1) * PAGE_SIZE,
      })
    : { products: [], hasMore: false };

  // "Cost today", which is what the merchant is looking at now. Past orders
  // resolve against their own placed_at, not this.
  const costs = await resolveVariantCostsAt(
    catalog.products.flatMap((p) => p.variants.map((v) => v.id)),
    new Date(),
  );
  const catalogJob = connection ? await latestSyncJob(connection.id, "products") : null;

  return (
    <main className="mx-auto max-w-3xl p-8">
      <Link
        href="/dashboard"
        className="mb-4 inline-block text-sm text-gray-500 hover:text-gray-900"
      >
        ← Back to dashboard
      </Link>
      <h1 className="mb-6 text-2xl font-bold">Products &amp; costs</h1>

      {!connection ? (
        <div className="rounded-xl border border-dashed border-gray-300 p-6 text-center">
          <p className="mb-2 text-gray-600">No store connected yet.</p>
          <Link className="text-sm font-medium underline" href="/settings/store">
            Connect your Shopify store →
          </Link>
        </div>
      ) : (
        <>
          <div className="mb-4 flex items-center justify-between gap-4">
            <form action="/products" className="flex flex-1 gap-2">
              <input
                aria-label="Search products"
                name="q"
                defaultValue={q ?? ""}
                placeholder="Search title, handle or SKU"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
              />
              <button className="rounded-md border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50">
                Search
              </button>
            </form>
          </div>

          {catalog.products.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 p-6 text-center">
              {q ? (
                <p className="text-gray-600">No products match “{q}”.</p>
              ) : (
                <>
                  <p className="mb-3 text-gray-600">Catalog not synced yet.</p>
                  <CatalogSyncButton
                    label="Sync catalog"
                    job={
                      catalogJob && {
                        id: catalogJob.id,
                        status: catalogJob.status,
                        itemsSynced: catalogJob.itemsSynced,
                        error: catalogJob.error,
                      }
                    }
                  />
                </>
              )}
            </div>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-gray-500">
                    <th className="py-2 font-normal">Variant</th>
                    <th className="py-2 font-normal">SKU</th>
                    <th className="py-2 text-right font-normal">Price</th>
                    <th className="py-2 text-right font-normal">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {catalog.products.map(({ product, variants }) => (
                    <Fragment key={product.id}>
                      <tr className="border-b border-gray-100">
                        <td colSpan={4} className="pt-4 pb-1 font-medium">
                          {product.title}
                          <span className="ml-2 text-xs font-normal text-gray-400">
                            {product.status.toLowerCase()}
                          </span>
                        </td>
                      </tr>
                      {variants.length === 0 ? (
                        <tr className="border-b border-gray-100">
                          <td colSpan={4} className="py-2 text-gray-500">
                            No variants synced for this product.
                          </td>
                        </tr>
                      ) : (
                        variants.map((variant) => {
                          const cost = costs.get(variant.id) ?? null;
                          return (
                            <tr key={variant.id} className="border-b border-gray-100">
                              <td className="py-2">
                                <Link
                                  className="underline"
                                  href={`/products/${encodeURIComponent(variant.id)}`}
                                >
                                  {variant.title}
                                </Link>
                              </td>
                              <td className="py-2 text-gray-500">{variant.sku ?? "—"}</td>
                              <td className="py-2 text-right">
                                {formatMoney(money(variant.priceCents, connection.currency))}
                              </td>
                              <td className="py-2 text-right">
                                {cost === null ? (
                                  <span className="text-amber-600">Not set</span>
                                ) : (
                                  formatMoney(money(cost.unitCostCents, cost.currency))
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>

              <div className="mt-4 flex items-center justify-between text-sm">
                <div className="flex gap-4">
                  {pageNumber > 1 && (
                    <Link
                      className="underline"
                      href={pageHref({ q, page: pageNumber - 1 })}
                      rel="prev"
                    >
                      ← Previous
                    </Link>
                  )}
                  {catalog.hasMore && (
                    <Link
                      className="underline"
                      href={pageHref({ q, page: pageNumber + 1 })}
                      rel="next"
                    >
                      Next →
                    </Link>
                  )}
                </div>
                <CatalogSyncButton
                  label="Re-sync catalog"
                  job={
                    catalogJob && {
                      id: catalogJob.id,
                      status: catalogJob.status,
                      itemsSynced: catalogJob.itemsSynced,
                      error: catalogJob.error,
                    }
                  }
                />
              </div>
            </>
          )}
        </>
      )}
    </main>
  );
}

function pageHref({ q, page }: { q?: string; page: number }) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/products?${query}` : "/products";
}
