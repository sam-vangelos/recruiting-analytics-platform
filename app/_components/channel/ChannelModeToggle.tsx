// app/_components/channel/ChannelModeToggle.tsx (GREENFIELD, 'use client')
//
// U0 toggle half (W0 frozen spec :140-152, :86, :95). Rendered INSIDE each channel's
// layout.tsx so it stays mounted across the Live<->YTD toggle (Next 16 layouts don't
// re-render on navigation — layouts-and-pages.md:43 — giving an instant switch).
//
// Active styling reuses the app-header treatment verbatim (app-header.tsx:52-56): a
// border-b-2 border-ink underline on the active link, tertiary ink with a hover lift on the
// inactive one. The YTD <Link> targets a CLEAN `${base}/ytd` — no useSearchParams, no stale
// filters carried into a fresh mode entry (frozen-spec open question default, :257-259).

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { ChannelBase } from "./types";

export function ChannelModeToggle({
  base,
  liveLabel = "LIVE",
  ytdLabel = "YTD",
}: {
  base: ChannelBase;
  liveLabel?: string;
  ytdLabel?: string;
}) {
  const pathname = usePathname();
  const ytdHref = `${base}/ytd`;
  // YTD is active on the bare ytd segment and any of its descendants; Live owns everything
  // else under the channel base (mirrors app-header.tsx:42 AGENCY-lights-on-both reasoning).
  const isYtd = pathname === ytdHref || pathname?.startsWith(`${ytdHref}/`) === true;

  const linkClass = (active: boolean) =>
    `flex h-10 items-center px-2 font-mono text-[11px] font-medium tracking-[1.5px] ${
      active
        ? "border-b-2 border-ink text-ink"
        : "text-ink-tertiary hover:text-ink-secondary"
    }`;

  return (
    <nav className="flex items-center gap-[18px]" aria-label="Channel mode">
      <Link href={base} className={linkClass(!isYtd)} aria-current={!isYtd ? "page" : undefined}>
        {liveLabel}
      </Link>
      <Link href={ytdHref} className={linkClass(isYtd)} aria-current={isYtd ? "page" : undefined}>
        {ytdLabel}
      </Link>
    </nav>
  );
}
