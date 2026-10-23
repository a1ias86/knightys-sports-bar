import { sql, type Db } from './db';
import { audit, type Actor } from './audit';

export interface CompetitionSettings {
  revealPredictionsAfterKickoff: boolean;
}

const DEFAULTS: CompetitionSettings = { revealPredictionsAfterKickoff: true };

const KEYS: Record<keyof CompetitionSettings, string> = {
  revealPredictionsAfterKickoff: 'reveal_predictions_after_kickoff',
};

export async function getSettings(db: Db = sql): Promise<CompetitionSettings> {
  const rows = await db<{ key: string; value: unknown }[]>`select key, value from settings`;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    revealPredictionsAfterKickoff:
      typeof map.get(KEYS.revealPredictionsAfterKickoff) === 'boolean'
        ? (map.get(KEYS.revealPredictionsAfterKickoff) as boolean)
        : DEFAULTS.revealPredictionsAfterKickoff,
  };
}

export async function updateSetting<K extends keyof CompetitionSettings>(actor: Actor, key: K, value: CompetitionSettings[K]) {
  await sql.begin(async (tx) => {
    const [before] = await tx<{ value: unknown }[]>`select value from settings where key = ${KEYS[key]}`;
    await tx`
      insert into settings (key, value, updated_by, updated_at) values (${KEYS[key]}, ${tx.json(value as never)}, ${actor.id}, now())
      on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
    await audit(tx, actor, 'settings.updated', 'setting', KEYS[key], { before: before?.value ?? null, after: value });
  });
}
