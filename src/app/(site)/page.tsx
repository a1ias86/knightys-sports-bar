import Link from 'next/link';
import { requireMember } from '@/lib/session';
import { nextFixture, displayStatus, isPredictionOpen, listFixtures } from '@/lib/fixtures';
import { getPrediction } from '@/lib/predictions';
import { memberStanding } from '@/lib/leaderboard';
import { sql } from '@/lib/db';
import { formatKickoff, ukGreeting } from '@/lib/time';
import { Scoreboard } from '@/components/Scoreboard';
import { Scoreline, ordinal, venueText, FormPips } from '@/components/bits';

export const metadata = { title: 'Home' };

export default async function Dashboard() {
  const me = await requireMember();
  const [next, standing, recent, upcoming] = await Promise.all([
    nextFixture(),
    memberStanding(me.id),
    sql<{ id: string; opponent: string; venue: string; kickoffAt: Date; arsenalGoals: number; opponentGoals: number; myPoints: number | null; predicted: boolean }[]>`
      select f.id, f.opponent, f.venue, f.kickoff_at, r.arsenal_goals, r.opponent_goals,
             s.total_points as my_points, (p.id is not null) as predicted
      from fixtures f
      join match_results r on r.fixture_id = f.id
      left join fixture_scores s on s.fixture_id = f.id and s.member_id = ${me.id}
      left join predictions p on p.fixture_id = f.id and p.member_id = ${me.id}
      where f.scoring_status = 'finalised'
      order by f.kickoff_at desc limit 5`,
    listFixtures({ from: new Date(), limit: 4 }),
  ]);
  const prediction = next ? await getPrediction(next.id, me.id) : null;
  const status = next ? displayStatus(next, !!prediction) : null;
  const open = next ? isPredictionOpen(next) : false;
  const row = standing.row;
  const preview = standing.board.slice(0, 5);
  const meInPreview = preview.some((r) => r.memberId === me.id);

  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>{ukGreeting()}, {me.displayName}</h1>
        {row && (
          <div className="stat-strip" aria-label="Your standing">
            <div><b>{ordinal(row.position)}</b><span>of {standing.size}</span></div>
            <div><b className="num">{row.totalPoints}</b><span>points</span></div>
            {row.form.length > 0 && <div><FormPips form={row.form} /><span>last {row.form.length} scored</span></div>}
          </div>
        )}
      </div>

      {next && status ? (
        <Scoreboard
          fixture={next}
          status={status}
          prediction={prediction}
          cta={open ? { href: `/predict/${next.id}`, label: prediction ? 'Edit prediction' : 'Make your prediction' } : { href: `/matches/${next.id}`, label: 'Match centre' }}
        />
      ) : (
        <section className="panel empty">
          <h2>No upcoming fixture yet</h2>
          <p style={{ margin: '0 auto' }}>The next Arsenal match will appear here as soon as it&rsquo;s been added.</p>
        </section>
      )}

      {next && prediction && (
        <p className="muted small" style={{ marginTop: 10 }}>
          Your picks: first goalscorer <strong>{prediction.scorerNone ? 'no goalscorer' : prediction.scorerName}</strong>, first assist <strong>{prediction.assisterNone ? 'no assister' : prediction.assisterName}</strong>.
          {open && ' You can change them until kick-off.'}
        </p>
      )}

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Recent results</h2>
            <Link href="/history">Your history</Link>
          </div>
          {recent.length === 0 ? (
            <p className="muted">No matches have been scored in the app yet. Your points so far carry over from the old table.</p>
          ) : (
            <ul className="fixture-list">
              {recent.map((f) => (
                <li key={f.id}>
                  <div>
                    <Link className="opp" href={`/matches/${f.id}`}>{venueText(f.venue, f.opponent)}</Link>
                    <div className="meta">{formatKickoff(f.kickoffAt)}</div>
                  </div>
                  <div className="side">
                    <Scoreline a={f.venue === 'A' ? f.opponentGoals : f.arsenalGoals} b={f.venue === 'A' ? f.arsenalGoals : f.opponentGoals} />
                    <span className={`points-cell${f.myPoints ? '' : ' zero'}`}>{f.predicted ? `${f.myPoints ?? 0} pts` : 'No pick'}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {upcoming.length > 1 && (
            <>
              <h3 style={{ marginTop: 24 }}>Coming up</h3>
              <ul className="fixture-list">
                {upcoming.slice(next ? 1 : 0).map((f) => (
                  <li key={f.id}>
                    <div>
                      <span className="opp">{venueText(f.venue, f.opponent)}</span>
                      <div className="meta">{f.competitionName}, {formatKickoff(f.kickoffAt)}</div>
                    </div>
                    <div className="side">
                      {isPredictionOpen(f) && <Link className="btn btn-ghost btn-small" href={`/predict/${f.id}`}>Predict</Link>}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>The table</h2>
            <Link href="/table">Full table</Link>
          </div>
          <table className="league">
            <tbody>
              {preview.map((r) => (
                <tr key={r.memberId} className={`${r.memberId === me.id ? 'me ' : ''}${r.position <= 3 ? `top-${r.position}` : ''}`}>
                  <td className="pos">{r.position}</td>
                  <td className="name">{r.displayName}</td>
                  <td className="pts">{r.totalPoints}</td>
                </tr>
              ))}
              {!meInPreview && row && (
                <tr className="me">
                  <td className="pos">{row.position}</td>
                  <td className="name">{row.displayName}</td>
                  <td className="pts">{row.totalPoints}</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
