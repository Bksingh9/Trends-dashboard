'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';

/** §4.4 / §4.10 — copy actions on deep links, identifiers and generated SQL. */
export function CopyButton({
  value,
  label = 'copy',
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch {
          setCopied(false);
        }
      }}
      title={value}
      className={cn(
        'rounded border border-[var(--color-edge)] px-1.5 py-0.5 text-2xs text-[var(--text-muted)] transition-colors hover:border-[var(--color-ion)] hover:text-[var(--text)]',
        copied && 'border-[var(--color-scan)] text-[var(--color-scan)]',
        className,
      )}
    >
      {copied ? 'copied' : label}
    </button>
  );
}
