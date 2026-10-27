'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { logoutAction } from '@/app/actions';

const LINKS = [
  { href: '/', label: 'Home' },
  { href: '/matches', label: 'Matches' },
  { href: '/table', label: 'Table' },
  { href: '/history', label: 'My predictions' },
  { href: '/hall-of-fame', label: 'Hall of Fame' },
  { href: '/rules', label: 'Rules' },
];

export function SiteHeader({ isAdmin }: { isAdmin: boolean }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const current = (href: string) => (href === '/' ? path === '/' : path.startsWith(href)) ? 'page' : undefined;
  return (
    <header className="site-header">
      <div className="wrap">
        <Link href="/" className="brand" aria-label="Knighty's Sports Bar home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/knightys-bar.webp" alt="" width={69} height={46} />
          <span>Knighty&rsquo;s Sports Bar<em>Arsenal Men&rsquo;s Prediction League</em></span>
        </Link>
        <button className="btn btn-ghost btn-small menu-toggle" aria-expanded={open} aria-controls="main-nav" onClick={() => setOpen(!open)}>
          Menu
        </button>
        <nav id="main-nav" className={`nav${open ? ' open' : ''}`} onClick={() => setOpen(false)}>
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} aria-current={current(l.href)}>{l.label}</Link>
          ))}
          {isAdmin && <Link href="/admin" className="admin-link" aria-current={current('/admin')}>Admin</Link>}
          <form action={logoutAction}>
            <button type="submit">Log out</button>
          </form>
        </nav>
      </div>
    </header>
  );
}
