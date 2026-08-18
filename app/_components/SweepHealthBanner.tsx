import type { SweepHealth } from "@/lib/sweep-types";
import { buildSweepHealthNotice } from "@/lib/sweep-health";

// Health banner for the referral and agency trackers. Renders nothing when the
// lane is healthy; a warning or danger notice otherwise, so a failing or stalled
// sweep can never present as green behind the last successful run's figures.
// Mirrors the YTD NoticeBanner tone contract for design-system consistency.
export function SweepHealthBanner({ health }: { health: SweepHealth }) {
  const notice = buildSweepHealthNotice(health);
  if (!notice) return null;

  const tone =
    notice.tone === "danger"
      ? "border-danger-rule bg-danger-bg text-danger-fg"
      : "border-warning-rule bg-warning-bg text-warning-fg";

  return (
    <section role="status" className={`rounded border px-4 py-3 ${tone}`}>
      <div className="font-mono text-[10px] font-semibold tracking-[1.4px]">{notice.headline}</div>
      <div className="mt-1 text-[13px] leading-5 opacity-90">{notice.detail}</div>
    </section>
  );
}
