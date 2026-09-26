// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CatalogSyncButton } from "./CatalogSyncButton";

/**
 * The catalog sync's entry point on /products: it starts a job, then hands over
 * to SyncProgress (which POSTs /api/store/sync-step per page).
 */

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const requests: string[] = [];
let start = { status: 200, body: {} as Record<string, unknown> };

beforeEach(() => {
  requests.length = 0;
  refresh.mockClear();
  start = { status: 200, body: { jobId: "job-new" } };
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    requests.push(String(url));
    if (String(url) === "/api/store/catalog-sync") {
      return new Response(JSON.stringify(start.body), { status: start.status });
    }
    return new Response(
      JSON.stringify({ status: "completed", kind: "products", itemsSynced: 4, error: null }),
      { status: 200 },
    );
  }) as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CatalogSyncButton", () => {
  it("starts a sync and shows its progress", async () => {
    const user = userEvent.setup();
    render(<CatalogSyncButton job={null} label="Sync catalog" />);
    await user.click(screen.getByRole("button", { name: /sync catalog/i }));

    expect(requests[0]).toBe("/api/store/catalog-sync");
    expect(
      await screen.findByText(/4 products synced/, undefined, { timeout: 2000 }),
    ).toBeDefined();
    // The page reloads so the newly synced products appear.
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("attaches to a sync that was already running when the page loaded", async () => {
    render(
      <CatalogSyncButton
        job={{ id: "job-running", status: "running", itemsSynced: 2, error: null }}
        label="Sync catalog"
      />,
    );
    expect(screen.queryByRole("button", { name: /sync catalog/i })).toBeNull();
    expect(screen.getByText(/2 products so far/)).toBeDefined();
  });

  it("attaches to the running job the API reports with a 409", async () => {
    start = { status: 409, body: { jobId: "job-already", alreadyRunning: true } };
    const user = userEvent.setup();
    render(<CatalogSyncButton job={null} label="Sync catalog" />);
    await user.click(screen.getByRole("button", { name: /sync catalog/i }));

    expect(
      await screen.findByText(/4 products synced/, undefined, { timeout: 2000 }),
    ).toBeDefined();
  });

  it("surfaces an error from the start route", async () => {
    start = { status: 404, body: { error: "No connected store" } };
    const user = userEvent.setup();
    render(<CatalogSyncButton job={null} label="Sync catalog" />);
    await user.click(screen.getByRole("button", { name: /sync catalog/i }));

    expect(await screen.findByText("No connected store")).toBeDefined();
    expect(screen.getByRole("button", { name: /sync catalog/i })).toBeDefined();
  });

  it("offers to start again after a previous sync finished", async () => {
    render(
      <CatalogSyncButton
        job={{ id: "job-old", status: "completed", itemsSynced: 9, error: null }}
        label="Re-sync catalog"
      />,
    );
    expect(screen.getByRole("button", { name: /re-sync catalog/i })).toBeDefined();
  });
});
