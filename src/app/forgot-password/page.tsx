"use client";

import { useState } from "react";
import { AuthCard, buttonCls, errorCls, inputCls } from "@/components/AuthCard";
import { authClient } from "@/lib/auth-client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error: apiError } = await authClient.requestPasswordReset({
      email,
      redirectTo: "/reset-password",
    });
    setBusy(false);
    if (apiError) setError(apiError.message ?? "Something went wrong");
    else setSent(true);
  }

  if (sent) {
    return (
      <AuthCard title="Check your email">
        <p className="text-sm text-gray-600">
          If an account exists for <strong>{email}</strong>, a reset link is on its way.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Reset your password">
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <input
          aria-label="Email"
          placeholder="Email"
          type="email"
          className={inputCls}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {error && <p className={errorCls}>{error}</p>}
        <button className={buttonCls} disabled={busy}>
          {busy ? "Sending…" : "Send reset link"}
        </button>
      </form>
    </AuthCard>
  );
}
