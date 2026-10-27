import { requireAdmin } from '@/lib/session';
import { listMembers, listAdjustments } from '@/lib/members';
import { sql } from '@/lib/db';
import { formatDateTime } from '@/lib/time';
import { ActionForm } from '@/components/ActionForm';
import { adjustmentAction } from '../actions';

export const metadata = { title: 'Points' };

export default async function PointsAdmin() {
  await requireAdmin();
  const [members, adjustments, fixtures, check] = await Promise.all([
    listMembers(),
    listAdjustments(),
    sql<{ id: string; opponent: string }[]>`select id, opponent from fixtures where scoring_status = 'finalised' order by kickoff_at desc limit 40`,
    sql<{ bad: number }[]>`
      select count(*)::int as bad from member_totals t
      where t.total_points <> t.opening_points + t.match_points + t.adjustment_points`,
  ]);
  const active = members.filter((m) => m.isActive);
  const sum = (k: 'openingPoints' | 'matchPoints' | 'adjustmentPoints' | 'totalPoints') => members.reduce((a, m) => a + m[k], 0);

  return (
    <div className="stack">
      <h1>Points</h1>
      <div className="grid-2">
        <section className="panel">
          <h2>Manual adjustment</h2>
          <p className="small muted">Kept separate from match points, so rescoring a match never removes it. Use a negative number to take points away. To correct an opening balance, add an adjustment with the reason.</p>
          <ActionForm action={adjustmentAction} submitLabel="Record adjustment" submitClass="btn btn-red" confirm="Record this points adjustment?">
            <div className="form-grid">
              <div className="field"><label htmlFor="adj-member">Member</label><select id="adj-member" name="memberId" required>{active.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</select></div>
              <div className="field"><label htmlFor="adj-points">Points (+/-)</label><input id="adj-points" name="points" type="number" min={-100} max={100} step={1} required /></div>
              <div className="field"><label htmlFor="adj-fixture">Related match (optional)</label><select id="adj-fixture" name="fixtureId" defaultValue=""><option value="">None</option>{fixtures.map((f) => <option key={f.id} value={f.id}>{f.opponent}</option>)}</select></div>
            </div>
            <div className="field"><label htmlFor="adj-reason">Reason</label><input id="adj-reason" name="reason" type="text" required minLength={5} maxLength={300} /></div>
          </ActionForm>
        </section>
        <section className="panel">
          <h2>Checks</h2>
          {(check[0]?.bad ?? 0) === 0
            ? <p>Every member&rsquo;s total equals opening balance + match points + adjustments.</p>
            : <div className="alert alert-error">{check[0]?.bad} member total(s) don&rsquo;t reconcile. Export a backup and investigate.</div>}
          <div className="stat-strip" style={{ margin: '12px 0 20px' }}>
            <div><b className="num">{sum('openingPoints')}</b><span>opening</span></div>
            <div><b className="num">{sum('matchPoints')}</b><span>from matches</span></div>
            <div><b className="num">{sum('adjustmentPoints')}</b><span>adjustments</span></div>
            <div><b className="num">{sum('totalPoints')}</b><span>total</span></div>
          </div>
          <p className="small muted">There is no &ldquo;recalculate everything&rdquo; button: points for an already-scored match only change when an admin rescores that one match, with a reason.</p>
        </section>
      </div>

      <section className="panel">
        <h2>Adjustments</h2>
        {adjustments.length === 0 ? <p className="muted">No adjustments yet.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Member</th><th className="r">Points</th><th>Reason</th><th>Match</th><th>By</th></tr></thead>
              <tbody>
                {adjustments.map((a) => (
                  <tr key={a.id}>
                    <td className="small">{formatDateTime(a.createdAt)}</td>
                    <td>{a.memberName}</td>
                    <td className="r num"><strong>{a.points > 0 ? '+' : ''}{a.points}</strong></td>
                    <td>{a.reason}</td>
                    <td>{a.opponent ?? '–'}</td>
                    <td>{a.createdByName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Breakdown by member</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Member</th><th className="r">Opening</th><th className="r">Matches</th><th className="r">Adjustments</th><th className="r">Total</th></tr></thead>
            <tbody>
              {[...members].sort((a, b) => b.totalPoints - a.totalPoints).map((m) => (
                <tr key={m.id} style={m.isActive ? undefined : { opacity: 0.55 }}>
                  <td>{m.displayName}{!m.isActive && ' (inactive)'}</td>
                  <td className="r num">{m.openingPoints}</td>
                  <td className="r num">{m.matchPoints}</td>
                  <td className="r num">{m.adjustmentPoints}</td>
                  <td className="r num"><strong>{m.totalPoints}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
