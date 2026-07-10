import Link from "next/link";
import { requireSession } from "@/lib/session";
import { getConnectionForUser, latestSyncJob } from "@/lib/shopify/store";
import { ConnectStoreForm } from "@/components/ConnectStoreForm";
import { SyncProgress } from "@/components/SyncProgress";

export default async function StoreSettingsPage() {
  const { user } = await requireSession();
  const connection = await getConnectionForUser(user.id);
  const job = connection ? await latestSyncJob(connection.id) : null;

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
          {job && (
            <SyncProgress
              jobId={job.id}
              initialStatus={job.status}
              initialCount={job.ordersSynced}
              initialError={job.error}
            />
          )}
        </div>
      ) : (
        <ConnectStoreForm />
      )}
    </main>
  );
}
