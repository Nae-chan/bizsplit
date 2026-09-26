// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VariantCostForm } from "./VariantCostForm";

/**
 * Client-side guard rails on cost entry and the payload the form posts:
 * the decimal string is sent verbatim (the server owns the cents conversion)
 * and the date is sent as YYYY-MM-DD for the shop's timezone to interpret.
 */

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
let response = { status: 201, body: {} as Record<string, unknown> };

beforeEach(() => {
  requests.length = 0;
  refresh.mockClear();
  response = { status: 201, body: { cost: { id: "cost-1", unitCostCents: 1234 } } };
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(response.body), { status: response.status });
  }) as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderForm() {
  render(
    <VariantCostForm
      variantId="gid://shopify/ProductVariant/101"
      currency="USD"
      defaultDate="2026-09-09"
    />,
  );
}

describe("VariantCostForm", () => {
  it("blocks submit with an inline error when the cost is empty", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole("button", { name: /add cost/i }));
    expect(await screen.findByText(/enter a cost like 12\.34/i)).toBeDefined();
    expect(requests).toHaveLength(0);
  });

  it("blocks submit when the cost is not a 2-decimal amount", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText("Unit cost"), "12.345");
    await user.click(screen.getByRole("button", { name: /add cost/i }));
    expect(await screen.findByText(/at most 2 decimal places/i)).toBeDefined();
    expect(requests).toHaveLength(0);
  });

  it("blocks submit on a negative or non-numeric cost", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText("Unit cost"), "-1.00");
    await user.click(screen.getByRole("button", { name: /add cost/i }));
    expect(await screen.findByText(/enter a cost like 12\.34/i)).toBeDefined();
    expect(requests).toHaveLength(0);
  });

  it("blocks submit when the effective date has been cleared", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText("Unit cost"), "12.34");
    await user.clear(screen.getByLabelText("Effective from"));
    await user.click(screen.getByRole("button", { name: /add cost/i }));
    expect(await screen.findByText(/effective date is required/i)).toBeDefined();
    expect(requests).toHaveLength(0);
  });

  it("posts the decimal cost and the ISO date, then refreshes", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText("Unit cost"), "12.34");
    await user.clear(screen.getByLabelText("Effective from"));
    await user.type(screen.getByLabelText("Effective from"), "2026-07-01");
    await user.type(screen.getByLabelText("Note"), "supplier increase");
    await user.click(screen.getByRole("button", { name: /add cost/i }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].url).toBe("/api/costs");
    expect(requests[0].body).toEqual({
      variantId: "gid://shopify/ProductVariant/101",
      unitCost: "12.34",
      effectiveFrom: "2026-07-01",
      note: "supplier increase",
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("defaults the effective date to the shop's today and omits an empty note", async () => {
    const user = userEvent.setup();
    renderForm();
    expect((screen.getByLabelText("Effective from") as HTMLInputElement).value).toBe("2026-09-09");

    await user.type(screen.getByLabelText("Unit cost"), "8");
    await user.click(screen.getByRole("button", { name: /add cost/i }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].body).toEqual({
      variantId: "gid://shopify/ProductVariant/101",
      unitCost: "8",
      effectiveFrom: "2026-09-09",
    });
  });

  it("surfaces the server's error and does not refresh", async () => {
    response = { status: 400, body: { error: "Unit cost cannot be negative" } };
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText("Unit cost"), "12.34");
    await user.click(screen.getByRole("button", { name: /add cost/i }));

    expect(await screen.findByText("Unit cost cannot be negative")).toBeDefined();
    expect(refresh).not.toHaveBeenCalled();
  });
});
