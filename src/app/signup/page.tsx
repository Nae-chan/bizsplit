"use client";

import { useState } from "react";
import Link from "next/link";
import { AuthCard, buttonCls, errorCls, inputCls } from "@/components/AuthCard";
import { PasswordInput } from "@/components/PasswordInput";
import { signUp } from "@/lib/auth-client";
import { signUpSchema } from "@/lib/validation";

export default function SignUpPage() {
  const [form, setForm] = useState({ name: "", brandName: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = signUpSchema.safeParse({ ...form, brandName: form.brandName || undefined });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setBusy(true);
    const { error: apiError } = await signUp.email({
      name: parsed.data.name,
      email: parsed.data.email,
      password: parsed.data.password,
      brandName: parsed.data.brandName,
      callbackURL: "/verify-email",
    });
    setBusy(false);
    if (apiError) setError(apiError.message ?? "Something went wrong");
    else setSent(true);
  }

  if (sent) {
    return (
      <AuthCard title="Check your email">
        <p className="text-sm text-gray-600">
          We sent a verification link to <strong>{form.email}</strong>. Click it to activate your
          account.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Create your account">
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <input
          aria-label="Your name"
          placeholder="Your name"
          className={inputCls}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <input
          aria-label="Brand name (optional)"
          placeholder="Brand name (optional)"
          className={inputCls}
          value={form.brandName}
          onChange={(e) => setForm({ ...form, brandName: e.target.value })}
        />
        <input
          aria-label="Email"
          placeholder="Email"
          type="email"
          className={inputCls}
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <PasswordInput
          placeholder="Password (10+ characters)"
          value={form.password}
          onChange={(v) => setForm({ ...form, password: v })}
        />
        {error && <p className={errorCls}>{error}</p>}
        <button className={buttonCls} disabled={busy}>
          {busy ? "Creating…" : "Sign up"}
        </button>
      </form>
      <p className="mt-4 text-sm text-gray-500">
        Already have an account?{" "}
        <Link className="underline" href="/login">
          Log in
        </Link>
      </p>
    </AuthCard>
  );
}
