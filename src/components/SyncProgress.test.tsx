// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SyncProgress } from "./SyncProgress";

/**
 * The browser half of the resumable sync: it re-POSTs /api/store/sync-step
 * while the job runs, renders the counter the route sends back, and offers a
 * Retry that steps the same job again after a failure.
 */

type StepBody = { status: string; kind?: string; itemsSynced?: number; error?: string | null };
const steps: Array<{ body: StepBody; ok?: boolean }> = [];
const requests: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  steps.length = 0;
  requests.length = 0;
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const next = steps.shift();
    if (!next) throw new Error("Unexpected sync step — no queued response");
    return new Response(JSON.stringify(next.body), { status: next.ok === false ? 500 : 200 });
  }) as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SyncProgress", () => {
  it("renders a completed job without calling the step route", async () => {
    render(
      <SyncProgress
        jobId="job-1"
        initialStatus="completed"
        initialCount={7}
        initialError={null}
        label="Catalog sync"
        noun="products"
      />,
    );
    expect(screen.getByText("Catalog sync")).toBeDefined();
    expect(screen.getByText(/7 products synced/)).toBeDefined();
    await new Promise((r) => setTimeout(r, 500));
    expect(requests).toHaveLength(0);
  });

  it("steps a running job and shows the count the route reports", async () => {
    steps.push({ body: { status: "running", kind: "products", itemsSynced: 12, error: null } });
    steps.push({ body: { status: "completed", kind: "products", itemsSynced: 20, error: null } });
    render(
      <SyncProgress
        jobId="job-2"
        initialStatus="running"
        initialCount={0}
        initialError={null}
        label="Catalog sync"
        noun="products"
      />,
    );
    expect(screen.getByText(/0 products so far/)).toBeDefined();

    expect(
      await screen.findByText(/12 products so far/, undefined, { timeout: 2000 }),
    ).toBeDefined();
    expect(
      await screen.findByText(/20 products synced/, undefined, { timeout: 2000 }),
    ).toBeDefined();
    expect(requests[0].url).toBe("/api/store/sync-step");
    expect(requests[0].body).toEqual({ jobId: "job-2" });
  });

  it("uses the caller's noun for an order sync", async () => {
    steps.push({ body: { status: "completed", kind: "orders", itemsSynced: 3, error: null } });
    render(
      <SyncProgress
        jobId="job-3"
        initialStatus="running"
        initialCount={0}
        initialError={null}
        label="Order sync"
        noun="orders"
      />,
    );
    expect(await screen.findByText(/3 orders synced/, undefined, { timeout: 2000 })).toBeDefined();
  });

  it("retries a failed job by stepping the same job again", async () => {
    steps.push({ body: { status: "completed", kind: "products", itemsSynced: 25, error: null } });
    const user = userEvent.setup();
    render(
      <SyncProgress
        jobId="job-4"
        initialStatus="failed"
        initialCount={10}
        initialError="Shopify responded 500"
        label="Catalog sync"
        noun="products"
      />,
    );
    expect(screen.getByText(/Shopify responded 500/)).toBeDefined();

    await user.click(screen.getByRole("button", { name: /retry/i }));

    // The retry resumes the same job rather than doing nothing.
    await waitFor(() => expect(requests).toHaveLength(1), { timeout: 2000 });
    expect(requests[0].body).toEqual({ jobId: "job-4" });
    expect(
      await screen.findByText(/25 products synced/, undefined, { timeout: 2000 }),
    ).toBeDefined();
  });

  it("surfaces an error the step route rejects with", async () => {
    steps.push({ body: { status: "failed", error: "Sync job not found" }, ok: false });
    render(
      <SyncProgress
        jobId="job-5"
        initialStatus="running"
        initialCount={0}
        initialError={null}
        label="Catalog sync"
        noun="products"
      />,
    );
    expect(
      await screen.findByText(/Sync job not found/, undefined, { timeout: 2000 }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: /retry/i })).toBeDefined();
  });

  it("surfaces an error the step route reports on a failed job", async () => {
    steps.push({
      body: {
        status: "failed",
        kind: "products",
        itemsSynced: 2,
        error: "Shopify responded 403 Forbidden. Reinstall the app with read_products.",
      },
    });
    render(
      <SyncProgress
        jobId="job-6"
        initialStatus="running"
        initialCount={0}
        initialError={null}
        label="Catalog sync"
        noun="products"
      />,
    );
    expect(await screen.findByText(/read_products/, undefined, { timeout: 2000 })).toBeDefined();
  });
});
