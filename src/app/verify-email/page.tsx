import Link from "next/link";
import { AuthCard } from "@/components/AuthCard";

export default function VerifyEmailPage() {
  return (
    <AuthCard title="Email verified 🎉">
      <p className="mb-4 text-sm text-gray-600">
        Your email is confirmed and you&apos;re signed in.
      </p>
      <Link className="underline" href="/dashboard">
        Go to your dashboard →
      </Link>
    </AuthCard>
  );
}
