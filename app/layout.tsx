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
    <html lang="en" suppressHydrationWarning>
      <body className={`${archivo.variable} ${interTight.variable} ${plexMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
