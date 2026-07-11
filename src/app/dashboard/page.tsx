import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { shopifyOrder } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getConnectionForUser } from "@/lib/shopify/store";
import { SignOutButton } from "@/components/SignOutButton";
import { formatMoney, money } from "@/lib/money";

export default async function DashboardPage() {
  const { user } = await requireSession();
  const connection = await getConnectionForUser(user.id);
  const orders = connection
    ? await db
        .select()
        .from(shopifyOrder)
        .where(eq(shopifyOrder.connectionId, connection.id))
        .orderBy(desc(shopifyOrder.placedAt))
        .limit(10)
    : [];

  return (
    <main className="mx-auto max-w-3xl p-8">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold">
          Welcome, {user.name}
          {user.brandName ? (
            <span className="ml-2 text-base font-normal text-gray-500">({user.brandName})</span>
          ) : null}
        </h1>
        <SignOutButton />
      </div>

      {!connection ? (
        <div className="mb-6 rounded-xl border border-dashed border-gray-300 p-6 text-center">
          <p className="mb-2 text-gray-600">No store connected yet.</p>
          <Link className="text-sm font-medium underline" href="/settings/store">
            Connect your Shopify store →
          </Link>
        </div>
      ) : (
        <section className="mb-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">
              Recent orders{" "}
              <span className="font-normal text-gray-400">· {connection.shopName}</span>
            </h2>
            <Link className="text-sm text-gray-500 underline" href="/settings/store">
              Manage store
            </Link>
          </div>
          {orders.length === 0 ? (
            <p className="text-sm text-gray-500">No orders synced yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="py-2 font-normal">Order</th>
                  <th className="py-2 font-normal">Date</th>
                  <th className="py-2 text-right font-normal">Total</th>
                  <th className="py-2 text-right font-normal">Fees</th>
                  <th className="py-2 text-right font-normal">Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-b border-gray-100">
                    <td className="py-2 font-medium">{o.orderNumber}</td>
                    <td className="py-2 text-gray-500">{o.placedAt.toLocaleDateString()}</td>
                    <td className="py-2 text-right">
                      {formatMoney(money(o.totalCents, o.currency))}
                    </td>
                    <td className="py-2 text-right">
                      {o.feesCents === null ? (
                        <span title="Waiting on Shopify fee data" className="text-amber-600">
                          pending
                        </span>
                      ) : (
                        formatMoney(money(o.feesCents, o.currency))
                      )}
                    </td>
                    <td className="py-2 text-right text-gray-500">
                      {o.financialStatus.toLowerCase()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <div className="flex gap-4 text-sm">
        <Link className="underline" href="/settings">
          Account settings
        </Link>
        <Link className="underline" href="/settings/store">
          Store connection
        </Link>
      </div>
    </main>
  );
}
