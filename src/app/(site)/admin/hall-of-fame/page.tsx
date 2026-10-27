import Link from 'next/link';
import { requireAdmin } from '@/lib/session';
import { listHallOfFame, type HallOfFameEntry } from '@/lib/hall-of-fame';
import { sql } from '@/lib/db';
import { formatDateTime } from '@/lib/time';
import { ActionForm } from '@/components/ActionForm';
import { addHallOfFameAction, updateHallOfFameAction, deleteHallOfFameAction } from '../actions';

export const metadata = { title: 'Hall of Fame' };

type MemberOption = { id: string; displayName: string; isActive: boolean };

function EntryFields({ entry, members, prefix }: { entry?: HallOfFameEntry; members: MemberOption[]; prefix: string }) {
  return (
    <>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${prefix}-season`}>Season</label>
          <input id={`${prefix}-season`} name="season" type="text" required placeholder="2025/26" defaultValue={entry?.seasonLabel} maxLength={9} />
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-winner`}>Winner&rsquo;s name</label>
          <input id={`${prefix}-winner`} name="winnerName" type="text" required maxLength={60} defaultValue={entry?.winnerName} />
          <div className="hint">Type any name: winners don&rsquo;t need to be current members.</div>
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-points`}>Final points (optional)</label>
          <input id={`${prefix}-points`} name="points" type="number" min={0} max={10000} step={1} defaultValue={entry?.points ?? ''} />
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-member`}>Link to a member (optional)</label>
          <select id={`${prefix}-member`} name="memberId" defaultValue={entry?.memberId ?? ''}>
            <option value="">Not linked</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}{m.isActive ? '' : ' (inactive)'}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-summary`}>Season summary (optional)</label>
        <textarea id={`${prefix}-summary`} name="summary" maxLength={500} defaultValue={entry?.summary ?? ''} placeholder="e.g. Clinched it on the final day with a Saka first goal." />
      </div>
    </>
  );
}

export default async function HallOfFameAdmin({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  await requireAdmin();
  const { deleted } = await searchParams;
  const [entries, members] = await Promise.all([
    listHallOfFame(),
    sql<MemberOption[]>`select id, display_name, is_active from members order by is_active desc, lower(display_name)`,
  ]);
  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Hall of Fame</h1>
        <Link className="btn btn-ghost btn-small" href="/hall-of-fame">View the public page</Link>
      </div>
      {deleted && <div className="alert alert-ok" role="status">Entry deleted.</div>}

      <section className="panel">
        <h2>Add a champion</h2>
        <p className="small muted">One champion per season. Everyone, including people who aren&rsquo;t logged in, can see the Hall of Fame.</p>
        <ActionForm action={addHallOfFameAction} submitLabel="Add champion" submitClass="btn btn-red">
          <EntryFields members={members} prefix="new" />
        </ActionForm>
      </section>

      <section className="panel">
        <h2>Champions ({entries.length})</h2>
        {entries.length === 0 ? (
          <p className="muted">No champions yet. Add the first one above.</p>
        ) : (
          <ul className="fixture-list">
            {entries.map((e) => (
              <li key={e.id} style={{ display: 'block' }}>
                <div className="row between">
                  <div>
                    <span className="hof-season">{e.seasonLabel}</span>{' '}
                    <strong style={{ fontSize: '1.15rem' }}>{e.winnerName}</strong>
                    {e.points !== null && <span className="muted"> &middot; {e.points} pts</span>}
                    {e.memberName && e.memberName !== e.winnerName && <span className="muted"> &middot; linked to {e.memberName}</span>}
                    <div className="small muted">Last changed {formatDateTime(e.updatedAt)}</div>
                  </div>
                </div>
                <details className="inline" style={{ marginTop: 10 }}>
                  <summary>Edit</summary>
                  <ActionForm action={updateHallOfFameAction} submitLabel="Save changes" submitClass="btn btn-small">
                    <input type="hidden" name="id" value={e.id} />
                    <EntryFields entry={e} members={members} prefix={`e-${e.id}`} />
                  </ActionForm>
                </details>
                <details className="inline" style={{ marginTop: 6 }}>
                  <summary>Delete</summary>
                  <ActionForm action={deleteHallOfFameAction} submitLabel="Delete this entry" submitClass="btn btn-danger btn-small" confirm={`Delete the ${e.seasonLabel} entry for ${e.winnerName}? This can't be undone.`}>
                    <input type="hidden" name="id" value={e.id} />
                    <div className="field"><label className="checkbox"><input type="checkbox" name="confirm" value="yes" required /> Yes, delete {e.seasonLabel} ({e.winnerName})</label></div>
                  </ActionForm>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
