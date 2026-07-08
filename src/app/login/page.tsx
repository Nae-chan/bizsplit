"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthCard, buttonCls, errorCls, inputCls } from "@/components/AuthCard";
import { PasswordInput } from "@/components/PasswordInput";
import { signIn } from "@/lib/auth-client";

export default function LoginPage() {
  const router = useRouter();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error: apiError } = await signIn.email({
      email: form.email,
      password: form.password,
    });
    setBusy(false);
    if (apiError) {
      setError(
        apiError.status === 403
          ? "Please verify your email first — check your inbox."
          : (apiError.message ?? "Invalid email or password"),
      );
    } else {
      router.push("/dashboard");
    }
  }

  return (
    <AuthCard title="Log in">
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <input
          aria-label="Email"
          placeholder="Email"
          type="email"
          className={inputCls}
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <PasswordInput value={form.password} onChange={(v) => setForm({ ...form, password: v })} />
        {error && <p className={errorCls}>{error}</p>}
        <button className={buttonCls} disabled={busy}>
          {busy ? "Logging in…" : "Log in"}
        </button>
      </form>
      <div className="mt-4 flex flex-col gap-1 text-sm text-gray-500">
        <Link className="underline" href="/forgot-password">
          Forgot password?
        </Link>
        <span>
          New here?{" "}
          <Link className="underline" href="/signup">
            Create an account
          </Link>
        </span>
      </div>
    </AuthCard>
  );
}
