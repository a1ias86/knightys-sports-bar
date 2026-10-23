import Link from 'next/link';
import { requireAdmin } from '@/lib/session';
import { listFixtures, listCompetitions, displayStatus } from '@/lib/fixtures';
import { sql } from '@/lib/db';
import { formatKickoff, ukZoneLabel } from '@/lib/time';
import { StatusChip, venueText } from '@/components/bits';
import { ActionForm } from '@/components/ActionForm';
import { FixtureFields } from '@/components/FixtureFields';
import { createFixtureAction } from '../actions';

export const metadata = { title: 'Fixtures' };

export default async function FixturesAdmin() {
  await requireAdmin();
  const [fixtures, competitions, counts] = await Promise.all([
    listFixtures({ includeDisabled: true, order: 'desc' }),
    listCompetitions(),
    sql<{ fixtureId: string; n: number }[]>`select fixture_id, count(*)::int as n from predictions group by fixture_id`,
  ]);
  const n = new Map(counts.map((c) => [c.fixtureId, c.n]));
  return (
    <div className="stack">
      <h1>Fixtures &amp; results</h1>
      <section className="panel">
        <details className="inline">
          <summary>Add a fixture by hand</summary>
          <ActionForm action={createFixtureAction} submitLabel="Add fixture" submitClass="btn btn-red">
            <FixtureFields competitions={competitions} />
          </ActionForm>
        </details>
      </section>
      <section className="panel">
        {fixtures.length === 0 ? (
          <p className="muted">No fixtures yet. Add one above, or configure a football data provider to import them.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Match</th><th>Kick-off (UK)</th><th>Status</th><th>Source</th><th className="r">Picks</th><th></th></tr></thead>
              <tbody>
                {fixtures.map((f) => (
                  <tr key={f.id} style={f.competitionEnabled ? undefined : { opacity: 0.6 }}>
                    <td><strong>{venueText(f.venue, f.opponent)}</strong><div className="small muted">{f.competitionName}{f.round ? `, ${f.round}` : ''}{f.competitionEnabled ? '' : ' (not in league)'}</div></td>
                    <td className="num">{formatKickoff(f.kickoffAt)} {ukZoneLabel(f.kickoffAt)}</td>
                    <td><StatusChip status={displayStatus(f, false)} /></td>
                    <td className="small">{f.dataSource === 'automatic' ? 'Feed' : 'Manual'}{f.manualOverride && f.provider ? ' (locked)' : ''}</td>
                    <td className="r num">{n.get(f.id) ?? 0}</td>
                    <td><Link className="btn btn-ghost btn-small" href={`/admin/fixtures/${f.id}`}>Manage</Link></td>
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
