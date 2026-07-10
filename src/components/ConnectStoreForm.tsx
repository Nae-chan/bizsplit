"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonCls, errorCls, inputCls } from "@/components/AuthCard";

export function ConnectStoreForm() {
  const router = useRouter();
  const [form, setForm] = useState({
    shopDomain: "",
    accessToken: "",
    webhookSecret: "",
    backfillStartDate: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await fetch("/api/store/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setBusy(false);
    const body = await res.json();
    if (!res.ok) setError(body.error ?? "Connection failed");
    else router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <p className="text-sm text-gray-600">
        In your Shopify admin, create a custom app (Settings → Apps and sales channels → Develop
        apps) with read access to orders (including all order history), products, and Shopify
        Payments. Paste its credentials here — they&apos;re stored encrypted.
      </p>
      <label className="text-sm text-gray-600">
        Shop domain
        <input
          aria-label="Shop domain"
          placeholder="your-store.myshopify.com"
          className={`${inputCls} mt-1`}
          value={form.shopDomain}
          onChange={(e) => setForm({ ...form, shopDomain: e.target.value })}
        />
      </label>
      <label className="text-sm text-gray-600">
        Admin API access token
        <input
          aria-label="Admin API access token"
          placeholder="shpat_…"
          type="password"
          className={`${inputCls} mt-1`}
          value={form.accessToken}
          onChange={(e) => setForm({ ...form, accessToken: e.target.value })}
        />
      </label>
      <label className="text-sm text-gray-600">
        API secret key (for webhook verification)
        <input
          aria-label="API secret key"
          placeholder="shpss_…"
          type="password"
          className={`${inputCls} mt-1`}
          value={form.webhookSecret}
          onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })}
        />
      </label>
      <label className="text-sm text-gray-600">
        Sync orders from
        <input
          aria-label="Sync orders from"
          type="date"
          className={`${inputCls} mt-1`}
          value={form.backfillStartDate}
          onChange={(e) => setForm({ ...form, backfillStartDate: e.target.value })}
        />
      </label>
      {error && <p className={errorCls}>{error}</p>}
      <button className={buttonCls} disabled={busy}>
        {busy ? "Connecting…" : "Connect store"}
      </button>
    </form>
  );
}
