"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Drives the resumable backfill: while the job is running, repeatedly calls
 * /api/store/sync-step (each call syncs one page of 50 orders) and shows
 * progress. Survives page reloads — state lives server-side in sync_job.
 */
export function SyncProgress(props: {
  jobId: string;
  initialStatus: "running" | "completed" | "failed";
  initialCount: number;
  initialError: string | null;
}) {
  const [status, setStatus] = useState(props.initialStatus);
  const [count, setCount] = useState(props.initialCount);
  const [error, setError] = useState<string | null>(props.initialError);
  const stepping = useRef(false);

  const step = useCallback(async () => {
    if (stepping.current) return;
    stepping.current = true;
    try {
      const res = await fetch("/api/store/sync-step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: props.jobId }),
      });
      const body = await res.json();
      if (!res.ok) {
        setStatus("failed");
        setError(body.error ?? "Sync step failed");
      } else {
        setStatus(body.status);
        setCount(body.ordersSynced);
        setError(body.error);
      }
    } finally {
      stepping.current = false;
    }
  }, [props.jobId]);

  useEffect(() => {
    if (status !== "running") return;
    const t = setTimeout(step, 400);
    return () => clearTimeout(t);
  }, [status, count, step]);

  return (
    <div className="rounded-xl border border-gray-200 p-5">
      <p className="mb-1 text-sm font-medium">Order sync</p>
      {status === "running" && (
        <p className="text-sm text-gray-600">
          <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
          Syncing… {count} orders so far
        </p>
      )}
      {status === "completed" && (
        <p className="text-sm text-green-700">✓ Backfill complete — {count} orders synced</p>
      )}
      {status === "failed" && (
        <div className="text-sm text-red-600">
          Sync failed{error ? `: ${error}` : ""}.
          <button
            className="ml-2 underline"
            onClick={() => {
              setStatus("running");
              setError(null);
            }}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
