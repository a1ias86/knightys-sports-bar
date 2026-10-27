'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  ['/admin', 'Overview'],
  ['/admin/fixtures', 'Fixtures & results'],
  ['/admin/members', 'Members & PINs'],
  ['/admin/points', 'Points'],
  ['/admin/hall-of-fame', 'Hall of Fame'],
  ['/admin/settings', 'Settings'],
  ['/admin/audit', 'Audit log'],
] as const;

export function AdminNav() {
  const path = usePathname();
  return (
    <nav className="admin-nav" aria-label="Admin">
      {LINKS.map(([href, label]) => (
        <Link key={href} href={href} aria-current={(href === '/admin' ? path === href : path.startsWith(href)) ? 'page' : undefined}>{label}</Link>
      ))}
    </nav>
  );
}
