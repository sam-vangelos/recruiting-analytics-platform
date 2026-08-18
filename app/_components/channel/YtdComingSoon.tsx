// app/_components/channel/YtdComingSoon.tsx (GREENFIELD)
//
// Honest empty state for a channel's YTD mode before its fact contract lands (W0 frozen spec
// :71, :104-107, :241-242). The referral toggle ships with its YTD half intentionally empty
// until W4a freezes the referral fact contract and the read API (lib/ytd-referral-dashboard.ts
// is built but referral.total=0 today). This is the Unknown-as-defect discipline applied to a
// whole mode: render an honest "being built" panel, NOT a fake table or zeroed-out metrics
// that read as real data. When W4a ships, this swaps for the real client behind the same
// `${base}/ytd` segment with zero route churn (:107).

export function YtdComingSoon({ channel }: { channel: "Referral" }) {
  return (
    <section className="flex min-h-[280px] w-full flex-col items-center justify-center gap-3 rounded border border-dashed border-border bg-card px-8 py-16 text-center">
      <span className="font-mono text-[11px] font-semibold tracking-[1.5px] text-ink-tertiary">
        {channel.toUpperCase()} YTD
      </span>
      <h2 className="text-base font-medium text-ink">{channel} YTD is being built</h2>
      <p className="max-w-[440px] text-sm font-normal leading-relaxed text-ink-secondary">
        The year-to-date view for this channel isn&apos;t live yet. Rather than show an empty or
        placeholder table, we&apos;re holding it back until the underlying data is ready. Switch
        to Live for current submissions in the meantime.
      </p>
    </section>
  );
}
