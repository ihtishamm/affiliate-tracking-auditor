import type { Metadata } from 'next';
import { Fira_Code, Lora, Poppins } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

// next/font downloads these at build time and serves them from our own origin: no request to
// Google at runtime (one less third party on a page that is itself about third-party requests),
// and no flash of fallback text. Each exposes a CSS variable that globals.css maps onto
// --font-sans / --font-serif / --font-mono.
const poppins = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-poppins',
  display: 'swap',
});
const lora = Lora({ subsets: ['latin'], variable: '--font-lora', display: 'swap' });
const firaCode = Fira_Code({ subsets: ['latin'], variable: '--font-fira-code', display: 'swap' });

export const metadata: Metadata = {
  title: 'Affiliate Tracking Auditor',
  description:
    'Paste an affiliate funnel URL, get a pass/fail tracking report with the exact broken line.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${poppins.variable} ${lora.variable} ${firaCode.variable}`}>
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
