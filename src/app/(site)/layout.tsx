import { after } from 'next/server';
import { requireMember } from '@/lib/session';
import { SiteHeader } from '@/components/SiteHeader';
import { resultsCheckDue, syncResults } from '@/lib/sync';

export const dynamic = 'force-dynamic';

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const me = await requireMember();

  // Opportunistic results check after the response is sent (cheap DB check first; at most every 15 min).
  // The scheduled jobs remain the primary mechanism; this just means results arrive sooner on the free plan.
  after(async () => {
    try {
      if (await resultsCheckDue()) await syncResults();
    } catch (e) {
      console.error('[after] results check failed', e);
    }
  });

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <SiteHeader isAdmin={me.role === 'admin'} />
      <main id="main" className="wrap">{children}</main>
      <footer className="site-footer">
        <div className="wrap">
          <span>Knighty&rsquo;s Sports Bar &middot; Arsenal Men&rsquo;s Prediction League</span>
          <span>All times are UK time</span>
        </div>
      </footer>
    </>
  );
}
