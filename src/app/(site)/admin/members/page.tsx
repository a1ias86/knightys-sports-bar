import { requireAdmin } from '@/lib/session';
import { listMembers } from '@/lib/members';
import { formatDate, formatDateTime } from '@/lib/time';
import { ActionForm } from '@/components/ActionForm';
import { addMemberAction, issueMissingPinsAction, resetPinAction, memberUpdateAction } from '../actions';

export const metadata = { title: 'Members' };

export default async function MembersAdmin() {
  const me = await requireAdmin();
  const list = await listMembers();
  const withoutPin = list.filter((m) => m.isActive && !m.hasPin).length;

  return (
    <div className="stack">
      <h1>Members &amp; PINs</h1>

      <div className="grid-2">
        <section className="panel">
          <h2>Issue PINs</h2>
          <p className="muted">
            {withoutPin > 0
              ? `${withoutPin} active member(s) don't have a PIN yet. Issuing creates a unique four-digit PIN for each and shows the list once, ready to copy.`
              : 'Every active member has a PIN. To replace one, use Reset PIN below.'}
          </p>
          <ActionForm action={issueMissingPinsAction} submitLabel="Issue missing PINs" submitClass="btn btn-red" confirm={withoutPin ? `Issue PINs to ${withoutPin} member(s)? You'll need to copy the list straight away.` : undefined} />
        </section>
        <section className="panel">
          <h2>Add a member</h2>
          <ActionForm action={addMemberAction} submitLabel="Add member" submitClass="btn">
            <div className="form-grid">
              <div className="field"><label htmlFor="name">Name</label><input id="name" name="name" type="text" required maxLength={40} /></div>
              <div className="field"><label htmlFor="opening">Starting points</label><input id="opening" name="opening" type="number" min={0} max={1000} defaultValue={0} /></div>
            </div>
          </ActionForm>
        </section>
      </div>

      <section className="panel">
        <h2>All members</h2>
        <p className="small muted">PINs can&rsquo;t be viewed, only replaced. Resetting a PIN logs that member out everywhere.</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Role</th><th>Status</th><th className="r">Opening</th><th className="r">Earned</th><th className="r">Adj.</th><th className="r">Total</th><th className="r">Picks</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.id} style={m.isActive ? undefined : { opacity: 0.55 }}>
                  <td>
                    <details className="inline">
                      <summary><strong>{m.displayName}</strong></summary>
                      <ActionForm action={memberUpdateAction} submitLabel="Rename" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input type="hidden" name="memberId" value={m.id} />
                        <input type="hidden" name="op" value="rename" />
                        <input type="text" name="name" defaultValue={m.displayName} maxLength={40} aria-label={`New name for ${m.displayName}`} style={{ minWidth: 140 }} />
                      </ActionForm>
                    </details>
                  </td>
                  <td>{m.role === 'admin' ? <span className="chip chip-completed">Admin</span> : 'Member'}</td>
                  <td className="small">
                    {!m.isActive ? 'Inactive' : !m.hasPin ? <span className="chip chip-awaiting">No PIN</span> : m.lockedUntil ? <span className="chip chip-review">Locked until {formatDateTime(m.lockedUntil)}</span> : <span className="muted">PIN set {m.pinSetAt ? formatDate(m.pinSetAt) : ''}</span>}
                  </td>
                  <td className="r num">{m.openingPoints}</td>
                  <td className="r num">{m.matchPoints}</td>
                  <td className="r num">{m.adjustmentPoints}</td>
                  <td className="r num"><strong>{m.totalPoints}</strong></td>
                  <td className="r num">{m.predictions}</td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      {m.isActive && (
                        <ActionForm action={resetPinAction} submitLabel={m.hasPin ? 'Reset PIN' : 'Issue PIN'} submitClass="btn btn-ghost btn-small" confirm={m.hasPin ? `Give ${m.displayName} a new PIN? Their current PIN stops working immediately.` : undefined}>
                          <input type="hidden" name="memberId" value={m.id} />
                        </ActionForm>
                      )}
                      {m.lockedUntil && (
                        <ActionForm action={memberUpdateAction} submitLabel="Unlock" submitClass="btn btn-ghost btn-small">
                          <input type="hidden" name="memberId" value={m.id} /><input type="hidden" name="op" value="unlock" />
                        </ActionForm>
                      )}
                      {m.id !== me.id && (
                        <ActionForm action={memberUpdateAction} submitLabel={m.isActive ? 'Deactivate' : 'Reactivate'} submitClass={m.isActive ? 'btn btn-danger btn-small' : 'btn btn-ghost btn-small'} confirm={m.isActive ? `Deactivate ${m.displayName}? They won't be able to log in and will leave the table (their points are kept).` : undefined}>
                          <input type="hidden" name="memberId" value={m.id} /><input type="hidden" name="op" value={m.isActive ? 'deactivate' : 'activate'} />
                        </ActionForm>
                      )}
                      {m.id !== me.id && m.isActive && (
                        <ActionForm action={memberUpdateAction} submitLabel={m.role === 'admin' ? 'Remove admin' : 'Make admin'} submitClass="btn btn-ghost btn-small" confirm={`Change ${m.displayName}'s role?`}>
                          <input type="hidden" name="memberId" value={m.id} /><input type="hidden" name="op" value={m.role === 'admin' ? 'make-member' : 'make-admin'} />
                        </ActionForm>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
