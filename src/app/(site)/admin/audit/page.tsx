import { requireAdmin } from '@/lib/session';
import { sql } from '@/lib/db';
import { formatDateTime } from '@/lib/time';

export const metadata = { title: 'Audit log' };

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  await requireAdmin();
  const { before } = await searchParams;
  const beforeId = before && /^\d+$/.test(before) ? Number(before) : null;
  const rows = await sql<{ id: number; actorLabel: string; action: string; entityType: string | null; entityId: string | null; details: unknown; createdAt: Date }[]>`
    select id, actor_label, action, entity_type, entity_id, details, created_at from audit_log
    ${beforeId ? sql`where id < ${beforeId}` : sql``}
    order by id desc limit 100`;
  return (
    <div className="stack">
      <h1>Audit log</h1>
      <p className="muted">Every important change, newest first. PINs are never recorded.</p>
      <section className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>{formatDateTime(r.createdAt)}</td>
                  <td>{r.actorLabel}</td>
                  <td><strong>{r.action}</strong>{r.entityType && <div className="small muted">{r.entityType}</div>}</td>
                  <td className="small"><code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(r.details)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 100 && <p><a className="btn btn-ghost btn-small" href={`/admin/audit?before=${rows[rows.length - 1].id}`}>Older entries</a></p>}
      </section>
    </div>
  );
}
