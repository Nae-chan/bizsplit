"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonCls, errorCls, inputCls } from "@/components/AuthCard";

export function ConnectStoreForm() {
  const router = useRouter();
  const [form, setForm] = useState({
    shopDomain: "",
    clientId: "",
    clientSecret: "",
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
        In Shopify&apos;s Dev Dashboard (Settings → Apps and sales channels → Develop apps → Build
        apps in Dev Dashboard), create an app with read access to orders (including all order
        history), products, and Shopify Payments, then install it on your store. Paste its client
        credentials here — they&apos;re stored encrypted, and BizSplit exchanges them for
        short-lived access tokens automatically.
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
        Client ID
        <input
          aria-label="Client ID"
          placeholder="Client ID from the app's settings"
          className={`${inputCls} mt-1`}
          value={form.clientId}
          onChange={(e) => setForm({ ...form, clientId: e.target.value })}
        />
      </label>
      <label className="text-sm text-gray-600">
        Client secret
        <input
          aria-label="Client secret"
          placeholder="Client secret from the app's settings"
          type="password"
          className={`${inputCls} mt-1`}
          value={form.clientSecret}
          onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
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
