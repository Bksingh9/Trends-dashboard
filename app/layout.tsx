import type { Metadata } from 'next';
import { Archivo, Inter_Tight, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

/** §10.2 — display: a wide-set grotesque, used only for module titles. */
const archivo = Archivo({
  subsets: ['latin'],
  variable: '--font-archivo',
  weight: ['500', '600', '700'],
  display: 'swap',
});

const interTight = Inter_Tight({
  subsets: ['latin'],
  variable: '--font-inter-tight',
  display: 'swap',
});

/** §10.2 — the one type choice to be dogmatic about: every numeral is mono. */
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  variable: '--font-plex-mono',
  weight: ['400', '500', '600'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Companion — Business & Health Dashboard',
  description:
    'Reliance Trends Companion App: business health, journey funnel, store adoption, catalogue health, tech health and issues, with an AI insight layer.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
     * §10.2 — the font variables belong on <html>, not <body>.
     *
     * Tailwind's `@theme` emits `--font-sans: var(--font-inter-tight), …` onto
     * `:root`, which is <html>. next/font's `.variable` classes were on <body>,
     * one level below. Custom properties inherit downward, so at `:root` the
     * `var(--font-inter-tight)` reference resolved to nothing and `--font-sans`
     * collapsed to its fallback stack — which <body> then inherited, already
     * resolved.
     *
     * The result was that not one custom font rendered anywhere. The visible
     * cost was `.num`: every figure in the product is meant to be IBM Plex Mono
     * for tabular numerals, and instead every column of orders, coverage
     * percentages and latencies was set in a proportional system font, so the
     * digits did not line up. §10.2 calls this the one type choice to be
     * dogmatic about, and it had never once applied.
     */
    <html
      lang="en"
      suppressHydrationWarning
      className={`${archivo.variable} ${interTight.variable} ${plexMono.variable}`}
    >
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
