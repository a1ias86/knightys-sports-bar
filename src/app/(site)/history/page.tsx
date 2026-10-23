import Link from 'next/link';
import { requireMember } from '@/lib/session';
import { memberPredictionHistory } from '@/lib/predictions';
import { memberStanding } from '@/lib/leaderboard';
import { formatKickoff } from '@/lib/time';
import { venueText, ordinal } from '@/components/bits';

export const metadata = { title: 'My predictions' };

export default async function HistoryPage() {
  const me = await requireMember();
  const [history, { row }] = await Promise.all([memberPredictionHistory(me.id, 200), memberStanding(me.id)]);
  return (
    <div className="stack">
      <h1>My predictions</h1>
      {row && (
        <section className="panel">
          <div className="stat-strip">
            <div><b>{ordinal(row.position)}</b><span>position</span></div>
            <div><b className="num">{row.totalPoints}</b><span>total points</span></div>
            <div><b className="num">{row.openingPoints}</b><span>carried over</span></div>
            <div><b className="num">{row.matchPoints}</b><span>earned in the app</span></div>
            {row.adjustmentPoints !== 0 && <div><b className="num">{row.adjustmentPoints > 0 ? '+' : ''}{row.adjustmentPoints}</b><span>adjustments</span></div>}
          </div>
        </section>
      )}
      <section className="panel">
        {history.length === 0 ? (
          <div className="empty">You haven&rsquo;t made any predictions in the app yet. <Link href="/">Make your first one</Link>.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Match</th><th className="c">Your score</th><th>Scorer</th><th>Assist</th><th className="c">Result</th><th className="r">Points</th></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.fixtureId}>
                    <td><Link href={`/matches/${h.fixtureId}`}><strong>{venueText(h.venue, h.opponent)}</strong></Link><div className="small muted">{formatKickoff(h.kickoffAt)}</div></td>
                    <td className="c num">{h.arsenalGoals}–{h.opponentGoals}</td>
                    <td>{h.scorerNone ? 'None' : h.scorerName}</td>
                    <td>{h.assisterNone ? 'None' : h.assisterName}</td>
                    <td className="c num">{h.resultArsenal != null ? `${h.resultArsenal}–${h.resultOpponent}` : '–'}</td>
                    <td className="r points-cell">{h.totalPoints ?? <span className="small muted">pending</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
