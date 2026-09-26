import Link from "next/link";
import { requireSession } from "@/lib/session";
import { getConnectionForUser, latestSyncJob } from "@/lib/shopify/store";
import { ConnectStoreForm } from "@/components/ConnectStoreForm";
import { SyncProgress } from "@/components/SyncProgress";

export default async function StoreSettingsPage() {
  const { user } = await requireSession();
  const connection = await getConnectionForUser(user.id);
  const orderJob = connection ? await latestSyncJob(connection.id, "orders") : null;
  const catalogJob = connection ? await latestSyncJob(connection.id, "products") : null;

  return (
    <main className="mx-auto max-w-xl p-8">
      <Link
        href="/dashboard"
        className="mb-4 inline-block text-sm text-gray-500 hover:text-gray-900"
      >
        ← Back to dashboard
      </Link>
      <h1 className="mb-6 text-2xl font-bold">Store connection</h1>

      {connection ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-gray-200 p-5">
            <p className="font-medium">{connection.shopName}</p>
            <p className="text-sm text-gray-500">
              {connection.shopDomain} · {connection.currency} · connected{" "}
              {connection.createdAt.toLocaleDateString()}
            </p>
          </div>
          {orderJob && (
            <SyncProgress
              jobId={orderJob.id}
              initialStatus={orderJob.status}
              initialCount={orderJob.itemsSynced}
              initialError={orderJob.error}
              label="Order sync"
              noun="orders"
            />
          )}
          {catalogJob && (
            <SyncProgress
              jobId={catalogJob.id}
              initialStatus={catalogJob.status}
              initialCount={catalogJob.itemsSynced}
              initialError={catalogJob.error}
              label="Catalog sync"
              noun="products"
            />
          )}
        </div>
      ) : (
        <ConnectStoreForm />
      )}
    </main>
  );
}
