import Link from 'next/link';
import { currentMember } from '@/lib/session';
import { listHallOfFame } from '@/lib/hall-of-fame';
import { SiteHeader } from '@/components/SiteHeader';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Hall of Fame' };

/** Public: members and visitors can view. Entries are managed by admins in Admin → Hall of Fame. */
export default async function HallOfFamePage() {
  const [me, entries] = await Promise.all([currentMember(), listHallOfFame()]);
  const [champion, ...rest] = entries;

  return (
    <>
      {me ? (
        <SiteHeader isAdmin={me.role === 'admin'} />
      ) : (
        <header className="site-header">
          <div className="wrap">
            <Link href="/hall-of-fame" className="brand" aria-label="Knighty's Sports Bar">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/knightys-bar.webp" alt="" width={69} height={46} />
              <span>Knighty&rsquo;s Sports Bar<em>Arsenal Men&rsquo;s Prediction League</em></span>
            </Link>
            <nav className="nav" style={{ display: 'flex', position: 'static', flexDirection: 'row', padding: 0, background: 'none', border: 0 }}>
              <Link href="/login">Log in</Link>
            </nav>
          </div>
        </header>
      )}
      <main id="main" className="wrap hof">
        <section className="hof-hero">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/league-crest.webp" alt="" width={900} height={822} className="hof-crest" />
          <div>
            <h1>Hall of Fame</h1>
            <p className="muted">Every champion of the Arsenal Men&rsquo;s Prediction League, newest first.</p>
          </div>
        </section>

        {entries.length === 0 ? (
          <section className="panel empty hof-empty">
            <h2>No champions recorded yet</h2>
            <p style={{ margin: '0 auto' }}>Past winners will appear here once Jon or Knighty add them.</p>
          </section>
        ) : (
          <>
            <article className="hof-champion" aria-label={`${champion.seasonLabel} champion`}>
              <div className="hof-season">{champion.seasonLabel}</div>
              <div className="hof-label">Champion</div>
              <h2 className="hof-name">{champion.winnerName}</h2>
              {champion.points !== null && <div className="hof-points"><b className="num">{champion.points}</b> points</div>}
              {champion.summary && <p className="hof-summary">{champion.summary}</p>}
            </article>
            {rest.length > 0 && (
              <ol className="hof-grid" aria-label="Earlier champions">
                {rest.map((e) => (
                  <li key={e.id} className="hof-card">
                    <div className="hof-season">{e.seasonLabel}</div>
                    <h3 className="hof-name">{e.winnerName}</h3>
                    {e.points !== null && <div className="hof-points"><b className="num">{e.points}</b> points</div>}
                    {e.summary && <p className="hof-summary">{e.summary}</p>}
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </main>
      <footer className="site-footer">
        <div className="wrap">
          <span>Knighty&rsquo;s Sports Bar &middot; Arsenal Men&rsquo;s Prediction League</span>
          {!me && <Link href="/login">Log in to predict</Link>}
        </div>
      </footer>
    </>
  );
}
