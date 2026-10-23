import { requireMember } from '@/lib/session';
import { getLeaderboard } from '@/lib/leaderboard';
import { FormPips, Movement } from '@/components/bits';

export const metadata = { title: 'League table' };

export default async function TablePage() {
  const me = await requireMember();
  const board = await getLeaderboard();
  const leaders = board.filter((r) => r.position === 1);
  const top = board.slice(0, 3);
  const hasHistory = board.some((r) => r.form.length > 0);

  return (
    <div className="stack">
      <div>
        <h1>League table</h1>
        <p className="muted">
          {leaders.length === 1 ? `${leaders[0].displayName} leads on ${leaders[0].totalPoints} points.` : `${leaders.map((l) => l.displayName).join(' and ')} share the lead on ${leaders[0]?.totalPoints} points.`}
          {' '}Totals include points carried over from the original league table.
        </p>
      </div>

      {top.length === 3 && (
        <div className="podium" aria-label="Top three">
          {top.map((r, i) => (
            <div key={r.memberId} className={`p${i + 1}`}>
              <div className="place">{r.position}</div>
              <div className="who">{r.displayName}</div>
              <div className="pts num">{r.totalPoints} pts</div>
            </div>
          ))}
        </div>
      )}

      <section className="panel">
        <div className="table-wrap">
          <table className="league">
            <thead>
              <tr>
                <th>Pos</th>
                <th>Name</th>
                {hasHistory && <th className="c">Move</th>}
                {hasHistory && <th>Form</th>}
                <th className="r">Pts</th>
              </tr>
            </thead>
            <tbody>
              {board.map((r) => (
                <tr key={r.memberId} className={`${r.memberId === me.id ? 'me ' : ''}${r.position <= 3 ? `top-${r.position}` : ''}`}>
                  <td className="pos">{r.position}</td>
                  <td className="name">{r.displayName}</td>
                  {hasHistory && <td className="c"><Movement m={r.movement} /></td>}
                  {hasHistory && <td><FormPips form={r.form} /></td>}
                  <td className="pts">{r.totalPoints}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 16 }}>
          Tied players share a position, and the next position is skipped (two players in 5th means the next player is 7th).
          {hasHistory && ' Form shows points from the last five scored matches, oldest first. Movement compares with the table before the latest scored match.'}
        </p>
      </section>
    </div>
  );
}
