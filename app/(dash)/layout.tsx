import Link from 'next/link';
import { MobileNav, Nav } from '@/components/shell/Nav';
import { getSessionUser, isAuthConfigured } from '@/lib/auth';
import { config } from '@/lib/config';
import { todayIST } from '@/lib/format/dates';

export default function DashLayout({ children }: { children: React.ReactNode }) {
  const user = getSessionUser();

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      {!isAuthConfigured() && (
        // Honest about its own state, like every other surface here.
        <div className="border-b border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-4 py-1.5 text-2xs text-[var(--color-warn)]">
          Auth is not configured — the dashboard is running in open access mode. Set{' '}
          <code className="num">NEXTAUTH_SECRET</code> and <code className="num">AUTH_ALLOWLIST</code> to
          gate it (§9.4).
        </div>
      )}

      <MobileNav />

      <div className="flex">
        <aside className="sticky top-0 hidden h-screen w-52 shrink-0 flex-col border-r border-[var(--color-edge)] bg-[var(--surface)] md:flex">
          <Link href="/" className="block border-b border-[var(--color-edge)] px-4 py-3">
            <div className="display text-base leading-tight">Companion</div>
            <div className="text-2xs text-[var(--text-muted)]">Reliance Trends</div>
          </Link>

          <div className="flex-1 overflow-y-auto">
            <Nav />
          </div>

          {/* §0 — production only. Stated on every screen so nobody has to ask
              which environment they are looking at. */}
          <div className="border-t border-[var(--color-edge)] px-4 py-3 text-2xs text-[var(--text-muted)]">
            <div className="mb-1 flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-scan)]" />
              <span className="uppercase tracking-wider">Production only</span>
            </div>
            <div className="num truncate" title={config.companionProdAffiliateId}>
              app {config.companionProdAffiliateId.slice(0, 10)}…
            </div>
            <div className="num">GA4 {config.ga4PropertyId}</div>
            <div className="num">BQ {config.gcpProjectId}</div>
            <div className="mt-2 border-t border-[var(--color-edge)] pt-2">
              <div className="truncate" title={user.email}>
                {user.name}
              </div>
              <div className="uppercase tracking-wider">{user.role}</div>
            </div>
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <header className="flex items-center justify-between gap-4 border-b border-[var(--color-edge)] px-4 py-2.5 md:px-6">
            <div className="text-2xs text-[var(--text-muted)]">
              All times <span className="num">IST</span> · retail day is an IST day
            </div>
            <div className="num text-2xs text-[var(--text-muted)]">{todayIST()}</div>
          </header>
          <div className="p-4 md:p-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
