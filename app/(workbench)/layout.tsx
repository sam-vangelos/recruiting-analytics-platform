import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppHeader } from "../app-header";
import "../globals.css";
import { hasEnv } from "@/lib/env";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TA Ops Analytics",
  description: "Referral and agency sweep trackers for recruiting operations.",
  robots: {
    index: false,
    follow: false,
  },
};

async function getLatestSweepTimestamp(): Promise<string | null> {
  if (!hasEnv("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")) {
    return null;
  }

  try {
    const { supabase } = await import("@/lib/supabase");
    const { data } = await supabase
      .from("sweep_runs")
      .select("started_at")
      .eq("status", "completed")
      .order("started_at", { ascending: false })
      .limit(1)
      .single();

    return data?.started_at ?? null;
  } catch {
    return null;
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const latestSweep = await getLatestSweepTimestamp();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full`}
    >
      <body className="min-h-full bg-background font-sans text-ink antialiased">
        <AppHeader latestSweep={latestSweep} />
        <main>{children}</main>
      </body>
    </html>
  );
}
