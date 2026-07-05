import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BizSplit",
  description:
    "Partner revenue sharing with transparent math. Agreements, splits, and settlements — every dollar explainable.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
