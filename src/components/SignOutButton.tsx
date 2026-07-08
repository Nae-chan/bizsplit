"use client";

import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
      onClick={async () => {
        await signOut();
        router.push("/login");
      }}
    >
      Sign out
    </button>
  );
}
