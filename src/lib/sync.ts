import { sql } from './db';
import { audit } from './audit';
import { getProvider } from './providers';
import { normaliseTeam, type FootballProvider, type ProviderPlayer } from './providers/types';
import { applyFeedMatch } from './results';

/**
 * Scheduled synchronisation. Every job:
 *  - takes a short database lease so overlapping runs (cron + admin button) can't double-process,
 *  - records a row in sync_runs (success / error / skipped) for the admin status page,
 *  - leaves existing data untouched on failure.
 */

type JobName = 'fixtures' | 'results' | 'lineups' | 'squads';

export interface JobOutcome { job: JobName; status: 'success' | 'error' | 'skipped'; message: string }

async function runJob(job: JobName, fn: (p: FootballProvider) => Promise<{ message: string; details?: unknown }>): Promise<JobOutcome> {
  const state = getProvider();
  if (!state.configured) {
    await sql`insert into sync_runs (job, provider, status, message, finished_at) values (${job}, ${state.name}, 'skipped', ${state.reason}, now())`;
    return { job, status: 'skipped', message: state.reason };
  }
  const holder = crypto.randomUUID();
  // Take a 5-minute lease on this job; a crashed run's lease simply expires.
  const got = await sql`
    insert into job_locks (job, locked_until, holder) values (${job}, now() + interval '5 minutes', ${holder})
    on conflict (job) do update set locked_until = excluded.locked_until, holder = excluded.holder
      where job_locks.locked_until < now()
    returning holder`;
  if (!got.length) return { job, status: 'skipped', message: 'Already running' };
  const [run] = await sql<{ id: string }[]>`insert into sync_runs (job, provider, status, message) values (${job}, ${state.name}, 'success', 'running') returning id`;
  try {
    const r = await fn(state.provider);
    await sql`update sync_runs set status = 'success', message = ${r.message}, details = ${sql.json((r.details ?? null) as never)}, finished_at = now() where id = ${run.id}`;
    return { job, status: 'success', message: r.message };
  } catch (e) {
    const msg = (e as Error).message?.slice(0, 500) || 'Unknown error';
    await sql`update sync_runs set status = 'error', message = ${msg}, finished_at = now() where id = ${run.id}`;
    return { job, status: 'error', message: msg };
  } finally {
    await sql`delete from job_locks where job = ${job} and holder = ${holder}`;
  }
}

// ─── Fixtures ─────────────────────────────────────────────────

export function syncFixtures() {
  return runJob('fixtures', async (p) => {
    const incoming = await p.fetchFixtures();
    const enabled = new Set((await sql<{ code: string }[]>`select code from competitions`).map((c) => c.code));
    let created = 0, updated = 0, linked = 0, ignored = 0;
    for (const f of incoming) {
      if (!enabled.has(f.competitionCode)) { ignored++; continue; }
      await sql.begin(async (tx) => {
        const [byId] = await tx<{ id: string; manualOverride: boolean; scoringStatus: string; status: string; kickoffAt: Date }[]>`
          select id, manual_override, scoring_status, status, kickoff_at from fixtures
          where provider = ${p.name} and provider_fixture_id = ${f.providerFixtureId} for update`;
        let target = byId;
        if (!target) {
          // Link a manually created fixture for the same match instead of creating a duplicate.
          const candidates = await tx<{ id: string; opponent: string; manualOverride: boolean; scoringStatus: string; status: string; kickoffAt: Date }[]>`
            select id, opponent, manual_override, scoring_status, status, kickoff_at from fixtures
            where provider_fixture_id is null and competition_code = ${f.competitionCode} and season = ${f.season}
              and venue = ${f.venue} and status <> 'cancelled'
              and (${f.competitionCode} = 'PL' or abs(extract(epoch from kickoff_at - ${f.kickoffAt}::timestamptz)) < 86400 * 21)
            for update`;
          const match = candidates.find((c) => normaliseTeam(c.opponent) === normaliseTeam(f.opponent));
          if (match) {
            await tx`update fixtures set provider = ${p.name}, provider_fixture_id = ${f.providerFixtureId}, opponent_provider_id = ${f.opponentProviderId}, last_synced_at = now() where id = ${match.id}`;
            await audit(tx, null, 'fixture.linked_to_feed', 'fixture', match.id, { provider: p.name, providerFixtureId: f.providerFixtureId });
            linked++;
            target = match;
          }
        }
        if (!target) {
          await tx`
            insert into fixtures (provider, provider_fixture_id, competition_code, season, round, opponent, opponent_provider_id, venue, kickoff_at, status, data_source, last_synced_at)
            values (${p.name}, ${f.providerFixtureId}, ${f.competitionCode}, ${f.season}, ${f.round}, ${f.opponent}, ${f.opponentProviderId}, ${f.venue}, ${f.kickoffAt}, ${f.status}, 'automatic', now())
            on conflict do nothing`;
          created++;
          return;
        }
        if (target.manualOverride || target.scoringStatus === 'finalised') {
          await tx`update fixtures set last_synced_at = now() where id = ${target.id}`;
          return;
        }
        // Results are handled by syncResults; here we only move schedule-related state.
        const statusChange = ['scheduled', 'postponed', 'cancelled'].includes(f.status) || target.status === 'postponed';
        const kickoffChanged = new Date(target.kickoffAt).getTime() !== f.kickoffAt.getTime();
        await tx`
          update fixtures set kickoff_at = ${f.kickoffAt}, opponent_provider_id = ${f.opponentProviderId},
            status = ${statusChange ? f.status : target.status},
            scoring_status = case when ${f.status} = 'cancelled' then 'void' else scoring_status end,
            data_source = 'automatic', last_synced_at = now(), updated_at = now()
          where id = ${target.id}`;
        if (kickoffChanged || (statusChange && f.status !== target.status)) {
          await audit(tx, null, 'fixture.rescheduled_by_feed', 'fixture', target.id, {
            fromKickoff: new Date(target.kickoffAt).toISOString(), toKickoff: f.kickoffAt.toISOString(), fromStatus: target.status, toStatus: f.status,
          });
          updated++;
        }
      });
    }
    return { message: `${incoming.length} from feed: ${created} new, ${linked} linked, ${updated} changed, ${ignored} other competitions`, details: { created, linked, updated, ignored } };
  });
}

// ─── Results ──────────────────────────────────────────────────

/** Fixtures that have kicked off recently and still need data. Bounded to protect the provider's rate limit. */
export function syncResults(opts: { limit?: number } = {}) {
  return runJob('results', async (p) => {
    const due = await sql<{ id: string; providerFixtureId: string; opponent: string }[]>`
      select id, provider_fixture_id, opponent from fixtures
      where provider = ${p.name} and provider_fixture_id is not null
        and kickoff_at < now() - interval '100 minutes' and kickoff_at > now() - interval '10 days'
        and (status in ('scheduled', 'live') or (status = 'finished' and scoring_status in ('not_ready', 'awaiting_verification')))
      order by kickoff_at
      limit ${opts.limit ?? 4}`;
    const outcomes: string[] = [];
    for (const f of due) {
      const feed = await p.fetchMatch(f.providerFixtureId);
      outcomes.push(`${f.opponent}: ${await applyFeedMatch(f.id, p.name, feed)}`);
    }
    return { message: due.length ? outcomes.join('; ') : 'Nothing to update', details: { checked: due.length } };
  });
}

// ─── Lineups ──────────────────────────────────────────────────

async function upsertPlayers(provider: string, team: string, isArsenal: boolean, list: ProviderPlayer[]) {
  const ids = new Map<string, string>();
  for (const pl of list) {
    const [row] = await sql<{ id: string }[]>`
      insert into players (provider, provider_player_id, name, team_name, is_arsenal, position, shirt_number, active)
      values (${provider}, ${pl.providerPlayerId}, ${pl.name}, ${team}, ${isArsenal}, ${pl.position}, ${pl.shirtNumber}, true)
      on conflict (provider, provider_player_id) where provider_player_id is not null
      do update set name = excluded.name, team_name = excluded.team_name, is_arsenal = excluded.is_arsenal,
        position = excluded.position, shirt_number = excluded.shirt_number, active = true, updated_at = now()
      returning id`;
    ids.set(pl.providerPlayerId, row.id);
  }
  return ids;
}

/** Official line-ups usually appear ~60 min before kickoff. Needs a frequent scheduler to be useful. */
export function syncLineups() {
  return runJob('lineups', async (p) => {
    const due = await sql<{ id: string; providerFixtureId: string; opponent: string }[]>`
      select f.id, f.provider_fixture_id, f.opponent from fixtures f
      where f.provider = ${p.name} and f.status = 'scheduled'
        and f.kickoff_at between now() and now() + interval '90 minutes'
        and (select count(*) from fixture_lineups l where l.fixture_id = f.id and l.role = 'starter') < 22
      limit 2`;
    let stored = 0;
    for (const f of due) {
      const lineup = await p.fetchLineups(f.providerFixtureId);
      if (!lineup) continue;
      for (const side of ['arsenal', 'opponent'] as const) {
        const entries = lineup.filter((l) => l.side === side);
        const ids = await upsertPlayers(p.name, side === 'arsenal' ? 'Arsenal' : f.opponent, side === 'arsenal', entries.map((e) => e.player));
        await sql.begin(async (tx) => {
          for (const e of entries) {
            await tx`
              insert into fixture_lineups (fixture_id, player_id, side, role, source)
              values (${f.id}, ${ids.get(e.player.providerPlayerId)!}, ${side}, ${e.role}, 'automatic')
              on conflict (fixture_id, player_id) do update set role = excluded.role, updated_at = now()`;
          }
        });
        stored += entries.length;
      }
    }
    return { message: due.length ? `Stored ${stored} line-up entries for ${due.length} fixture(s)` : 'No line-ups due' };
  });
}

// ─── Squads ───────────────────────────────────────────────────

/** Arsenal's squad, plus the opponents of fixtures in the next 8 days. */
export function syncSquads() {
  return runJob('squads', async (p) => {
    const arsenal = await p.fetchSquad(p.arsenalProviderId);
    let n = 0;
    if (arsenal?.length) {
      const ids = await upsertPlayers(p.name, 'Arsenal', true, arsenal);
      n += ids.size;
      // Players who have left Arsenal (no longer in the provider's squad) stop being selectable.
      await sql`update players set active = false, updated_at = now()
        where provider = ${p.name} and is_arsenal and active and not (provider_player_id = any(${[...ids.keys()]}))`;
    }
    const opps = await sql<{ opponent: string; opponentProviderId: string }[]>`
      select distinct opponent, opponent_provider_id from fixtures
      where provider = ${p.name} and opponent_provider_id is not null and status = 'scheduled'
        and kickoff_at between now() and now() + interval '8 days'`;
    for (const o of opps.slice(0, 2)) {
      const squad = await p.fetchSquad(o.opponentProviderId);
      if (squad?.length) n += (await upsertPlayers(p.name, o.opponent, false, squad)).size;
    }
    return { message: `Updated ${n} players (Arsenal${opps.length ? ` + ${opps.length} opponent(s)` : ''})` };
  });
}

export async function lastRuns() {
  return sql<{ job: string; provider: string | null; status: string; message: string | null; startedAt: Date; finishedAt: Date | null }[]>`
    select distinct on (job) job, provider, status, message, started_at, finished_at
    from sync_runs order by job, started_at desc`;
}

export async function lastSuccessful() {
  return sql<{ job: string; finishedAt: Date }[]>`
    select job, max(finished_at) as finished_at from sync_runs where status = 'success' group by job`;
}

export async function recentRuns(limit = 30) {
  return sql<{ id: string; job: string; provider: string | null; status: string; message: string | null; startedAt: Date }[]>`
    select id, job, provider, status, message, started_at from sync_runs order by started_at desc limit ${limit}`;
}

/**
 * Cheap check used when someone loads the site: is a finished match waiting for data and has it been
 * at least 15 minutes since the last results check? Lets the free Vercel plan (daily cron only) still
 * pick up results soon after full time without anyone keeping a tab open.
 */
export async function resultsCheckDue(): Promise<boolean> {
  if (!getProvider().configured) return false;
  const [r] = await sql<{ due: boolean }[]>`
    select exists (
      select 1 from fixtures
      where provider is not null and kickoff_at < now() - interval '100 minutes' and kickoff_at > now() - interval '10 days'
        and (status in ('scheduled', 'live') or (status = 'finished' and scoring_status in ('not_ready', 'awaiting_verification')))
    ) and not exists (
      select 1 from sync_runs where job = 'results' and started_at > now() - interval '15 minutes'
    ) as due`;
  return r.due;
}
