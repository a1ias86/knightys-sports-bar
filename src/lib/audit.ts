import type { Db } from './db';

export interface Actor {
  id: string;
  displayName: string;
}

const FORBIDDEN_KEYS = /pin|token|secret|password|hash/i;

/** Strip anything that looks like a credential before it is written to the log. */
function scrub(details: unknown): unknown {
  if (Array.isArray(details)) return details.map(scrub);
  if (details && typeof details === 'object' && !(details instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(details)) {
      if (FORBIDDEN_KEYS.test(k) && !/^pin_?reset|pinIssued|pinsIssued/i.test(k)) continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return details;
}

export async function audit(
  db: Db,
  actor: Actor | null,
  action: string,
  entityType: string | null,
  entityId: string | null,
  details: Record<string, unknown> = {},
) {
  await db`
    insert into audit_log (actor_member_id, actor_label, action, entity_type, entity_id, details)
    values (${actor?.id ?? null}, ${actor?.displayName ?? 'system'}, ${action}, ${entityType}, ${entityId},
            ${db.json(scrub(details) as never)})`;
}
