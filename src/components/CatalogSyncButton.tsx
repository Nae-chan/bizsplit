"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonCls, errorCls } from "@/components/AuthCard";
import { SyncProgress } from "@/components/SyncProgress";

export interface CatalogJobSummary {
  id: string;
  status: "running" | "completed" | "failed";
  itemsSynced: number;
  error: string | null;
}

/**
 * Starts the product catalog sync and hands it to SyncProgress, which drives it
 * one page per request. A sync already running when the page loaded is attached
 * to rather than restarted, and so is one the API reports (409) as running.
 */
export function CatalogSyncButton(props: { job: CatalogJobSummary | null; label: string }) {
  const router = useRouter();
  const [job, setJob] = useState<CatalogJobSummary | null>(
    props.job?.status === "running" ? props.job : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setError(null);
    setBusy(true);
    const res = await fetch("/api/store/catalog-sync", { method: "POST" });
    setBusy(false);
    const body = await res.json();
    // 409 means a sync is already running: attach to it instead of failing.
    if (!res.ok && res.status !== 409) {
      setError(body.error ?? "Could not start the catalog sync");
      return;
    }
    setJob({ id: body.jobId, status: "running", itemsSynced: 0, error: null });
  }

  if (job) {
    return (
      <SyncProgress
        jobId={job.id}
        initialStatus={job.status}
        initialCount={job.itemsSynced}
        initialError={job.error}
        label="Catalog sync"
        noun="products"
        onComplete={() => router.refresh()}
      />
    );
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <button className={`${buttonCls} w-auto`} disabled={busy} onClick={start}>
        {busy ? "Starting…" : props.label}
      </button>
      {error && <p className={errorCls}>{error}</p>}
    </div>
  );
}
