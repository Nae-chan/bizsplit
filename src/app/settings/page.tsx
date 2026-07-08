import Link from "next/link";
import { requireSession } from "@/lib/session";
import { ProfileForm } from "@/components/ProfileForm";

export default async function SettingsPage() {
  const { user } = await requireSession();
  return (
    <main className="mx-auto max-w-xl p-8">
      <Link
        href="/dashboard"
        className="mb-4 inline-block text-sm text-gray-500 hover:text-gray-900"
      >
        ← Back to dashboard
      </Link>
      <h1 className="mb-6 text-2xl font-bold">Account settings</h1>
      <ProfileForm
        initialName={user.name}
        initialBrandName={user.brandName ?? ""}
        email={user.email}
      />
    </main>
  );
}
