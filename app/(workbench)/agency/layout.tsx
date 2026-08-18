import { ChannelModeToggle } from "@/app/_components/channel/ChannelModeToggle";

// Per-channel chrome. The toggle is mounted in the LAYOUT (not the page) so it stays mounted across
// the Live<->YTD switch — Next 16 nested layouts don't re-render on navigation, giving an instant
// toggle. Wraps both /agency (live) and /agency/ytd (YTD).
export default function AgencyLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <div className="w-full border-b border-border bg-background px-12 pt-5">
        <ChannelModeToggle base="/agency" />
      </div>
      {children}
    </>
  );
}
