import Link from "next/link";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";

export default async function Home() {
  const session = await auth.api.getSession({ headers: await headers() });
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-4xl font-bold tracking-tight">BizSplit</h1>
      <p className="max-w-md text-center text-lg text-gray-500">
        Partner revenue sharing with transparent math. Agreements, splits, and settlements — every
        dollar explainable.
      </p>
      {session ? (
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm text-gray-600">
            Signed in as <strong>{session.user.name}</strong>
          </p>
          <Link
            href="/dashboard"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            Go to your dashboard →
          </Link>
        </div>
      ) : (
        <div className="flex gap-3">
          <Link
            href="/signup"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          >
            Get started
          </Link>
          <Link
            href="/login"
            className="rounded-md border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
          >
            Log in
          </Link>
        </div>
      )}
      <p className="rounded-full border px-4 py-1 text-sm text-gray-400">
        Under construction — Chunk 1 of 10
      </p>
    </main>
  );
}
