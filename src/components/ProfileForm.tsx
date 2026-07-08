"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { buttonCls, errorCls, inputCls } from "@/components/AuthCard";

export function ProfileForm(props: {
  initialName: string;
  initialBrandName: string;
  email: string;
}) {
  const [name, setName] = useState(props.initialName);
  const [brandName, setBrandName] = useState(props.initialBrandName);
  const [status, setStatus] = useState<"idle" | "busy" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      setStatus("error");
      return;
    }
    setStatus("busy");
    setError(null);
    const { error: apiError } = await authClient.updateUser({
      name: name.trim(),
      brandName: brandName.trim() || undefined,
    });
    if (apiError) {
      setError(apiError.message ?? "Update failed");
      setStatus("error");
    } else {
      setStatus("saved");
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-sm flex-col gap-3">
      <label className="text-sm text-gray-600">
        Email (can&apos;t be changed here)
        <input
          className={`${inputCls} mt-1 bg-gray-50 text-gray-400`}
          value={props.email}
          disabled
        />
      </label>
      <label className="text-sm text-gray-600">
        Your name
        <input
          aria-label="Your name"
          className={`${inputCls} mt-1`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="text-sm text-gray-600">
        Brand name
        <input
          aria-label="Brand name"
          className={`${inputCls} mt-1`}
          value={brandName}
          onChange={(e) => setBrandName(e.target.value)}
        />
      </label>
      {error && <p className={errorCls}>{error}</p>}
      <button className={buttonCls} disabled={status === "busy"}>
        {status === "busy" ? "Saving…" : "Save changes"}
      </button>
      {status === "saved" && <p className="text-sm text-green-700">Saved ✓</p>}
    </form>
  );
}
