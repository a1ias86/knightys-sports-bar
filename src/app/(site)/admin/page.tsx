import Link from 'next/link';
import { requireAdmin } from '@/lib/session';
import { sql } from '@/lib/db';
import { getProvider } from '@/lib/providers';
import { lastRuns, lastSuccessful, recentRuns } from '@/lib/sync';
import { formatKickoff, formatDateTime } from '@/lib/time';
import { venueText } from '@/components/bits';
import { ActionForm } from '@/components/ActionForm';
import { syncAction } from './actions';

export const metadata = { title: 'Admin' };

export default async function AdminHome() {
  await requireAdmin();
  const provider = getProvider();
  const [ambiguous, attention, discrepancies, locked, noPin, runs, okRuns, history] = await Promise.all([
    // Inconsistent scoring records: left untouched by every automatic process until an admin checks them.
    sql<{ id: string; opponent: string; venue: string; kickoffAt: Date; scoringStatus: string; rows: number; runs: number }[]>`
      select f.id, f.opponent, f.venue, f.kickoff_at, f.scoring_status,
        (select count(*)::int from fixture_scores s where s.fixture_id = f.id) as rows,
        (select count(*)::int from scoring_runs r where r.fixture_id = f.id and r.status = 'success') as runs
      from fixtures f
      where (f.scoring_status = 'finalised' and not exists (select 1 from scoring_runs r where r.fixture_id = f.id and r.status = 'success')
                                          and not exists (select 1 from fixture_scores s where s.fixture_id = f.id))
         or (f.scoring_status <> 'finalised' and exists (select 1 from fixture_scores s where s.fixture_id = f.id))
         or (select count(distinct coalesce(s.rules_version, 1)) from fixture_scores s where s.fixture_id = f.id) > 1
      order by f.kickoff_at`,
    sql<{ id: string; opponent: string; venue: string; kickoffAt: Date; status: string; scoringStatus: string; reviewReason: string | null }[]>`
      select id, opponent, venue, kickoff_at, status, scoring_status, review_reason from fixtures
      where (status = 'finished' and scoring_status in ('not_ready', 'awaiting_verification', 'review_required'))
         or (status in ('scheduled', 'live') and kickoff_at < now() - interval '150 minutes')
      order by kickoff_at`,
    sql<{ fixtureId: string; opponent: string; discrepancy: string }[]>`
      select fr.fixture_id, f.opponent, fr.discrepancy from feed_results fr join fixtures f on f.id = fr.fixture_id where fr.discrepancy is not null`,
    sql<{ displayName: string }[]>`select display_name from members where locked_until > now()`,
    sql<{ n: number }[]>`select count(*)::int as n from members where is_active and pin_hash is null`,
    lastRuns(),
    lastSuccessful(),
    recentRuns(12),
  ]);
  const okBy = new Map(okRuns.map((r) => [r.job, r.finishedAt]));
  const withoutPin = noPin[0]?.n ?? 0;

  return (
    <div className="stack">
      <h1>Admin</h1>

      <section className="panel">
        <h2>Needs attention</h2>
        {ambiguous.length > 0 && (
          <div className="alert alert-error">
            <p style={{ marginBottom: 8 }}><strong>Scoring records that need checking.</strong> These were left exactly as they are; nothing automatic will change them.</p>
            <ul style={{ margin: 0 }}>
              {ambiguous.map((a) => (
                <li key={a.id}>
                  <Link href={`/admin/fixtures/${a.id}`}>{venueText(a.venue, a.opponent)}</Link>, {formatKickoff(a.kickoffAt)}: status &ldquo;{a.scoringStatus.replace(/_/g, ' ')}&rdquo;, {a.rows} stored point row(s), {a.runs} scoring run(s)
                </li>
              ))}
            </ul>
          </div>
        )}
        {attention.length === 0 && discrepancies.length === 0 && locked.length === 0 && withoutPin === 0 ? (
          <p className="muted">Nothing waiting. All finished matches are scored.</p>
        ) : (
          <ul className="fixture-list">
            {attention.map((f) => (
              <li key={f.id}>
                <div>
                  <Link className="opp" href={`/admin/fixtures/${f.id}`}>{venueText(f.venue, f.opponent)}</Link>
                  <div className="meta">{formatKickoff(f.kickoffAt)} · {f.status === 'finished' ? (f.reviewReason ?? 'Needs a result or verification') : 'Kicked off over 2½ hours ago but not marked finished'}</div>
                </div>
                <div className="side"><Link className="btn btn-small btn-red" href={`/admin/fixtures/${f.id}`}>Enter or check result</Link></div>
              </li>
            ))}
            {discrepancies.map((d) => (
              <li key={d.fixtureId}>
                <div><Link className="opp" href={`/admin/fixtures/${d.fixtureId}`}>{d.opponent}</Link><div className="meta">{d.discrepancy}</div></div>
                <div className="side"><span className="chip chip-review">Feed discrepancy</span></div>
              </li>
            ))}
            {locked.length > 0 && (
              <li><div><Link className="opp" href="/admin/members">Locked out</Link><div className="meta">{locked.map((l) => l.displayName).join(', ')} hit too many wrong PINs.</div></div></li>
            )}
            {withoutPin > 0 && (
              <li><div><Link className="opp" href="/admin/members">{withoutPin} member(s) without a PIN</Link><div className="meta">They can&rsquo;t log in until you issue one.</div></div></li>
            )}
          </ul>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Football data</h2>
          <span className={`chip ${provider.configured ? 'chip-auto' : 'chip-manual'}`}>{provider.configured ? `Provider: ${provider.name}` : 'Manual mode'}</span>
        </div>
        {!provider.configured ? (
          <p className="muted">{provider.reason} Everything works without it: add fixtures and enter results from Fixtures &amp; results.</p>
        ) : (
          <>
            <p className="small muted">
              Expected coverage on the configured plan: {Object.entries(provider.provider.capabilities).filter(([, v]) => v).map(([k]) => k).join(', ')}.
              These are not guaranteed until confirmed with live matches.
            </p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Job</th><th>Last run</th><th>Result</th><th>Last success</th><th></th></tr></thead>
                <tbody>
                  {(['fixtures', 'results', 'squads', 'lineups'] as const).map((job) => {
                    const r = runs.find((x) => x.job === job);
                    return (
                      <tr key={job}>
                        <td><strong>{job}</strong></td>
                        <td>{r ? formatDateTime(r.startedAt) : 'Never'}</td>
                        <td className="small">{r ? <><span className={`chip ${r.status === 'error' ? 'chip-review' : r.status === 'success' ? 'chip-submitted' : ''}`}>{r.status}</span> {r.message}</> : '–'}</td>
                        <td>{okBy.get(job) ? formatDateTime(okBy.get(job)!) : '–'}</td>
                        <td><ActionForm action={syncAction} submitLabel="Run now" submitClass="btn btn-ghost btn-small"><input type="hidden" name="job" value={job} /></ActionForm></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        {history.length > 0 && (
          <details className="inline" style={{ marginTop: 16 }}>
            <summary>Recent sync history</summary>
            <ul className="small">
              {history.map((h) => <li key={h.id}>{formatDateTime(h.startedAt)}: {h.job} {h.status}. {h.message}</li>)}
            </ul>
          </details>
        )}
      </section>

      <section className="panel">
        <h2>Backup</h2>
        <p className="muted">Download everything (members, opening balances, fixtures, predictions, results, scores, adjustments and the audit log) as JSON. PINs and PIN hashes are never included.</p>
        <a className="btn btn-ghost" href="/api/admin/export">Download backup</a>
      </section>
    </div>
  );
}
