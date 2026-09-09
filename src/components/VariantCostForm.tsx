"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonCls, errorCls, inputCls } from "@/components/AuthCard";

/** A cost like "12.34": digits, optionally with 1-2 decimal places. */
const DECIMAL = /^\d+(\.\d{1,2})?$/;

/**
 * Records a cost of goods for one variant. Every submit appends a new
 * effective-dated row — nothing is overwritten — so past orders keep resolving
 * to the cost that was in force when they were placed.
 */
export function VariantCostForm(props: {
  variantId: string;
  currency: string;
  /** Today in the shop's timezone (YYYY-MM-DD): the date the merchant means. */
  defaultDate: string;
}) {
  const router = useRouter();
  const [unitCost, setUnitCost] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(props.defaultDate);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!DECIMAL.test(unitCost.trim())) {
      setError("Enter a cost like 12.34, using at most 2 decimal places.");
      return;
    }
    if (!effectiveFrom) {
      setError("An effective date is required.");
      return;
    }

    setBusy(true);
    const res = await fetch("/api/costs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        variantId: props.variantId,
        unitCost: unitCost.trim(),
        effectiveFrom,
        note: note.trim() || undefined,
      }),
    });
    setBusy(false);
    const body = await res.json();
    if (!res.ok) {
      setError(body.error ?? "Could not save the cost");
      return;
    }
    setUnitCost("");
    setNote("");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label className="text-sm text-gray-600">
        Unit cost ({props.currency})
        <input
          aria-label="Unit cost"
          inputMode="decimal"
          placeholder="12.34"
          className={`${inputCls} mt-1`}
          value={unitCost}
          onChange={(e) => setUnitCost(e.target.value)}
        />
      </label>
      <label className="text-sm text-gray-600">
        Effective from
        <input
          aria-label="Effective from"
          type="date"
          className={`${inputCls} mt-1`}
          value={effectiveFrom}
          onChange={(e) => setEffectiveFrom(e.target.value)}
        />
      </label>
      <label className="text-sm text-gray-600">
        Note (optional)
        <input
          aria-label="Note"
          placeholder="Supplier price increase"
          maxLength={200}
          className={`${inputCls} mt-1`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {error && <p className={errorCls}>{error}</p>}
      <button className={buttonCls} disabled={busy}>
        {busy ? "Saving…" : "Add cost"}
      </button>
    </form>
  );
}
