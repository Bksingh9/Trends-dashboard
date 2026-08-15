'use client';

/**
 * §3.1 — Auth-gated shell with a persistent module rail.
 *
 * Domains are named in the business's own vernacular — retail-floor language,
 * not generic BI language: Sales, Journey, Stores, Catalogue, App Health,
 * Issues.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

export interface NavItem {
  href: string;
  label: string;
  hint: string;
  group: 'domains' | 'intelligence' | 'system';
  /** Hidden unless the named module flag is on. */
  flag?: 'loyalty';
}

export const NAV: NavItem[] = [
  { href: '/', label: 'Hub', hint: 'Is Companion healthy today', group: 'domains' },
  { href: '/sales', label: 'Sales', hint: 'Orders, GMV, AOV, customers', group: 'domains' },
  { href: '/journey', label: 'Journey', hint: 'Scan → bag → pay → de-tag', group: 'domains' },
  { href: '/stores', label: 'Stores', hint: 'Adoption, dark stores, NOC', group: 'domains' },
  { href: '/catalogue', label: 'Catalogue', hint: 'Coverage, missing EANs', group: 'domains' },
  { href: '/app-health', label: 'App Health', hint: 'Crashes, latency, payments', group: 'domains' },
  { href: '/issues', label: 'Issues', hint: 'P0/P1, escalations', group: 'domains' },
  // ADR-001 — rendered only when MODULE_LOYALTY is on, since §0 excludes it.
  { href: '/loyalty', label: 'Loyalty', hint: 'Reliance One 2.0', group: 'domains', flag: 'loyalty' },
  { href: '/insights', label: 'AI Insights', hint: 'Brief, anomalies, ask the data', group: 'intelligence' },
  { href: '/connectors', label: 'Connectors', hint: 'Status, lineage, run log', group: 'system' },
  { href: '/connectors/sources', label: 'Data sources', hint: 'Add or change a connection', group: 'system' },
  { href: '/reference', label: 'Reference', hint: 'Deep links, test EANs, docs', group: 'system' },
  { href: '/settings', label: 'Settings', hint: 'Thresholds, SLOs, flags', group: 'system' },
];

const GROUP_LABEL: Record<NavItem['group'], string> = {
  domains: 'Domains',
  intelligence: 'Intelligence',
  system: 'System',
};

export function Nav({ enabledFlags = [] }: { enabledFlags?: string[] } = {}) {
  const pathname = usePathname();
  const groups: NavItem['group'][] = ['domains', 'intelligence', 'system'];

  return (
    <nav aria-label="Modules" className="flex h-full flex-col gap-5 p-3">
      {groups.map((g) => (
        <div key={g}>
          <div className="label mb-1.5 px-2">{GROUP_LABEL[g]}</div>
          <ul className="space-y-0.5">
            {NAV.filter((n) => n.group === g && (!n.flag || enabledFlags.includes(n.flag))).map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    title={item.hint}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'block rounded px-2 py-1.5 text-sm transition-colors',
                      active
                        ? 'bg-[var(--color-ion)]/15 text-[var(--text)] shadow-[inset_2px_0_0_var(--color-ion)]'
                        : 'text-[var(--text-muted)] hover:bg-[var(--color-slab)] hover:text-[var(--text)]',
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Mobile gets the hub and /stores only — a 12-column store matrix does not
    work on a phone, and pretending otherwise helps nobody (§10.4). */
export function MobileNav() {
  const pathname = usePathname();
  const items = NAV.filter((n) => n.href === '/' || n.href === '/stores');
  return (
    <nav
      // Distinct from the desktop rail's label: two navigation landmarks with
      // the same accessible name are ambiguous to a screen reader, and they
      // make role-based selectors resolve to both.
      aria-label="Modules (compact)"
      className="flex gap-1 border-b border-[var(--color-edge)] bg-[var(--surface)] p-2 md:hidden"
    >
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          className={cn(
            'rounded px-3 py-1.5 text-sm',
            pathname === i.href ? 'bg-[var(--color-ion)]/15' : 'text-[var(--text-muted)]',
          )}
        >
          {i.label}
        </Link>
      ))}
      <span className="ml-auto self-center pr-2 text-2xs text-[var(--text-muted)]">
        Full dashboard on tablet or desktop
      </span>
    </nav>
  );
}
