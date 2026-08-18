import { ChannelModeToggle } from "@/app/_components/channel/ChannelModeToggle";

// Per-channel chrome — see app/agency/layout.tsx. Wraps both /referrals (live) and /referrals/ytd.
export default function ReferralsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <div className="w-full border-b border-border bg-background px-12 pt-5">
        <ChannelModeToggle base="/referrals" />
      </div>
      {children}
    </>
  );
}
