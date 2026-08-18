import type { Metadata } from "next";
import { Inter, Newsreader } from "next/font/google";
import "./exec.css";

/**
 * Exec root layout — a second root layout (route group), deliberately WITHOUT
 * the workbench AppHeader: execs bookmark /state-of-play and structurally never
 * see the REFERRALS · AGENCY · RECOPS operator chrome. The exec surface runs
 * its own design system (exec.css, generated from exec-design-tokens.json by
 * scripts/build-exec-css.mjs — never hand-edited): serif briefing masthead,
 * sans data grid, color only on dots and the single red lede phrase.
 */

const serif = Newsreader({
  variable: "--font-serif",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

const sans = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Recruiting — State of Play",
  description: "Org-wide open-role state of play for executives.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function ExecRootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable}`}>
      <body className="exec-body">
        <main>{children}</main>
      </body>
    </html>
  );
}
