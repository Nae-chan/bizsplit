import Link from "next/link";
import { requireSession } from "@/lib/session";
import { SignOutButton } from "@/components/SignOutButton";

export default async function DashboardPage() {
  const { user } = await requireSession();
  return (
    <main className="mx-auto max-w-3xl p-8">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold">
          Welcome, {user.name}
          {user.brandName ? (
            <span className="ml-2 text-base font-normal text-gray-500">({user.brandName})</span>
          ) : null}
        </h1>
        <SignOutButton />
      </div>
      <p className="mb-4 text-gray-600">
        Partnerships, agreements, and settlements will appear here as they&apos;re built (Chunks
        4-8).
      </p>
      <Link className="text-sm underline" href="/settings">
        Account settings
      </Link>
    </main>
  );
}
