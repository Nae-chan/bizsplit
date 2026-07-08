"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthCard, buttonCls, errorCls } from "@/components/AuthCard";
import { authClient } from "@/lib/auth-client";
import { passwordSchema } from "@/lib/validation";
import { PasswordInput } from "@/components/PasswordInput";

function ResetForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    if (!token) {
      setError("This reset link is invalid — request a new one.");
      return;
    }
    setBusy(true);
    const { error: apiError } = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (apiError) setError(apiError.message ?? "Reset failed — the link may have expired.");
    else router.push("/login");
  }

  return (
    <AuthCard title="Choose a new password">
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <PasswordInput
          ariaLabel="New password"
          placeholder="New password (10+ characters)"
          value={password}
          onChange={setPassword}
        />
        {error && <p className={errorCls}>{error}</p>}
        <button className={buttonCls} disabled={busy}>
          {busy ? "Saving…" : "Set new password"}
        </button>
      </form>
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
