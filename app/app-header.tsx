"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

interface AppHeaderProps {
  latestSweep: string | null;
}

// YTD is a per-channel mode (the Live|YTD toggle inside each channel layout), not a standalone tab.
const navItems = [
  { label: "REFERRALS", href: "/referrals" },
  { label: "AGENCY", href: "/agency" },
  { label: "RECOPS", href: "/recruiting-ops" },
];

function formatSweepTimestamp(timestamp: string | null, now: number): string {
  if (!timestamp) return "PREVIEW";

  const sweepTime = new Date(timestamp).getTime();
  if (Number.isNaN(sweepTime)) return "PREVIEW";

  const diffMinutes = Math.max(0, Math.round((now - sweepTime) / 60000));
  if (diffMinutes < 60) return diffMinutes < 1 ? "JUST NOW" : `${diffMinutes}M AGO`;

  const diffHours = Math.round(diffMinutes / 60);
  return `${diffHours}H AGO`;
}

function subscribeClock(onStoreChange: () => void) {
  const interval = window.setInterval(onStoreChange, 60000);
  return () => window.clearInterval(interval);
}

function getClockSnapshot() {
  return Date.now();
}

function getServerClockSnapshot() {
  return 0;
}

export function AppHeader({ latestSweep }: AppHeaderProps) {
  const pathname = usePathname();

  // The relative-time label depends on the live wall clock, so computing it during render makes the
  // server HTML and the first client render disagree on the minute boundary (a hydration mismatch).
  // useSyncExternalStore supplies a server-safe placeholder snapshot, then updates from the client
  // clock without a synchronous setState in an effect.
  const now = useSyncExternalStore(
    subscribeClock,
    getClockSnapshot,
    getServerClockSnapshot
  );
  const sweepLabel =
    now === 0 ? "—" : formatSweepTimestamp(latestSweep, now);

  return (
    <header className="flex min-h-16 w-full flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border bg-background px-5 py-2 md:h-16 md:flex-nowrap md:px-12 md:py-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1 md:flex-nowrap md:gap-7">
        <Link href="/referrals" className="flex items-center gap-3">
          <span className="h-3.5 w-3.5 rounded-[2px] bg-ink" aria-hidden="true" />
          <span className="text-sm font-medium text-ink">TA Ops Analytics</span>
        </Link>
        <nav className="flex min-w-0 flex-wrap items-center gap-x-[14px] gap-y-1 md:flex-nowrap md:gap-[18px]" aria-label="Primary">
          {navItems.map((item, index) => {
            // Light the tab on its base AND any descendant (so AGENCY lights on /agency and
            // /agency/ytd) — the trailing slash avoids a false match on /agency-foo. Mirrors
            // ChannelModeToggle's own active rule.
            const active =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <div key={item.href} className="flex items-center gap-x-[14px] md:gap-[18px]">
                {index > 0 ? (
                  <span className="font-mono text-[11px] font-normal text-ink-tertiary">
                    ·
                  </span>
                ) : null}
                <Link
                  href={item.href}
                  className={`flex h-9 items-center px-1.5 font-mono text-[11px] font-medium tracking-[1.5px] md:h-16 md:px-2 ${
                    active
                      ? "border-b-2 border-ink text-ink"
                      : "text-ink-tertiary hover:text-ink-secondary"
                  }`}
                >
                  {item.label}
                </Link>
              </div>
            );
          })}
        </nav>
      </div>
      <span className="hidden font-mono text-[11px] font-medium tracking-[1.5px] text-ink-tertiary sm:block">
        LAST SWEEP · {sweepLabel}
      </span>
    </header>
  );
}
