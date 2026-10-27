'use server';

/**
 * Admin server actions. EVERY action starts with requireAdmin(): the role is checked on the server
 * for each request, independent of which buttons the page shows.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/session';
import type { Actor } from '@/lib/audit';
import * as members from '@/lib/members';
import { createFixture, updateFixture, setFixtureAutoSync, seasonFor, type FixtureInput, type FixtureStatus } from '@/lib/fixtures';
import { saveManualResult, verifyResult, confirmNameReview, type EntryState, finaliseWithPlayerCategoriesVoid, reopenScoring, rescoreFixture, type FinaliseResult } from '@/lib/results';
import { adminOverridePrediction, parseGoals } from '@/lib/predictions';
import { updateSetting } from '@/lib/settings';
import { addHallOfFame, updateHallOfFame, deleteHallOfFame } from '@/lib/hall-of-fame';
import { syncFixtures, syncResults, syncSquads, syncLineups } from '@/lib/sync';
import { ukLocalToUtc } from '@/lib/time';
import { sql } from '@/lib/db';
import { audit } from '@/lib/audit';

export type AdminState = { error?: string; ok?: string; pins?: { displayName: string; pin: string }[] } | null;

async function actor(): Promise<Actor> {
  const m = await requireAdmin();
  return { id: m.id, displayName: m.displayName };
}
const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
function resultMessage(fin: FinaliseResult | null): string {
  if (!fin) return 'Result saved.';
  if (fin.status === 'finalised') return `Result published and ${fin.scored} prediction(s) scored with the ${fin.rulesVersion === 2 ? '20' : '15'}-point rules.`;
  if (fin.status === 'protected') return `Result saved. ${fin.reason}`;
  return `Result saved, but not scored: ${fin.reason}`;
}
const done = (ok: string, ...paths: string[]): AdminState => {
  for (const p of paths) revalidatePath(p);
  return { ok };
};

// ─── Members ──────────────────────────────────────────────────

export async function addMemberAction(_p: AdminState, f: FormData): Promise<AdminState> {
  const a = await actor();
  const pts = Number(str(f, 'opening') || '0');
  const r = await members.addMember(a, str(f, 'name'), pts);
  if (!r.ok) return { error: r.error };
  revalidatePath('/admin/members');
  return { ok: `${r.issued.displayName} added.`, pins: [{ displayName: r.issued.displayName, pin: r.issued.pin }] };
}

export async function issueMissingPinsAction(): Promise<AdminState> {
  const a = await actor();
  const issued = await members.issueMissingPins(a);
  revalidatePath('/admin/members');
  if (!issued.length) return { ok: 'Everyone active already has a PIN.' };
  return { ok: `Issued ${issued.length} PIN(s).`, pins: issued.map((i) => ({ displayName: i.displayName, pin: i.pin })) };
}

export async function resetPinAction(_p: AdminState, f: FormData): Promise<AdminState> {
  const a = await actor();
  const i = await members.resetPin(a, str(f, 'memberId'));
  revalidatePath('/admin/members');
  return { ok: `New PIN for ${i.displayName}. Their old PIN and sessions no longer work.`, pins: [{ displayName: i.displayName, pin: i.pin }] };
}

export async function memberUpdateAction(_p: AdminState, f: FormData): Promise<AdminState> {
  const a = await actor();
  const id = str(f, 'memberId');
  const op = str(f, 'op');
  try {
    if (op === 'rename') {
      const r = await members.renameMember(a, id, str(f, 'name'));
      if (!r.ok) return { error: r.error };
    } else if (op === 'deactivate' || op === 'activate') {
      const r = await members.setMemberActive(a, id, op === 'activate');
      if (!r.ok) return { error: r.error };
    } else if (op === 'unlock') {
      await members.unlockMember(a, id);
    } else if (op === 'make-admin' || op === 'make-member') {
      const r = await members.setMemberRole(a, id, op === 'make-admin' ? 'admin' : 'member');
      if (!r.ok) return { error: r.error };
    } else return { error: 'Unknown action' };
  } catch (e) {
    return { error: (e as Error).message };
  }
  return done('Saved.', '/admin/members');
}

// ─── Fixtures ─────────────────────────────────────────────────

function fixtureFromForm(f: FormData): FixtureInput | string {
  let kickoffAt: Date;
  try { kickoffAt = ukLocalToUtc(str(f, 'date'), str(f, 'time')); } catch (e) { return (e as Error).message; }
  return {
    competitionCode: str(f, 'competition'),
    season: str(f, 'season') || seasonFor(kickoffAt),
    round: str(f, 'round'),
    opponent: str(f, 'opponent'),
    venue: str(f, 'venue') as 'H' | 'A' | 'N',
    kickoffAt,
    status: (str(f, 'status') || 'scheduled') as FixtureStatus,
  };
}

export async function createFixtureAction(_p: AdminState, f: FormData): Promise<AdminState> {
  const a = await actor();
  const input = fixtureFromForm(f);
  if (typeof input === 'string') return { error: input };
  const r = await createFixture(a, input);
  if (!r.ok) return { error: r.error };
  revalidatePath('/admin/fixtures');
  redirect(`/admin/fixtures/${r.id}?created=1`);
}

export async function updateFixtureAction(_p: AdminState, f: FormData): Promise<AdminState> {
  const a = await actor();
  const input = fixtureFromForm(f);
  if (typeof input === 'string') return { error: input };
  const id = str(f, 'fixtureId');
  const r = await updateFixture(a, id, input);
  if (!r.ok) return { error: r.error };
  return done('Fixture saved. The feed will no longer change it unless you re-enable syncing.', `/admin/fixtures/${id}`, '/');
}

export async function fixtureSyncToggleAction(f: FormData) {
  const a = await actor();
  const id = str(f, 'fixtureId');
  await setFixtureAutoSync(a, id, str(f, 'allow') === '1');
  revalidatePath(`/admin/fixtures/${id}`);
}

// ─── Results & scoring ────────────────────────────────────────

export async function manualResultAction(_p: AdminState, f: FormData): Promise<AdminState> {
  const a = await actor();
  const id = str(f, 'fixtureId');
  const ag = parseGoals(str(f, 'arsenalGoals'));
  const og = parseGoals(str(f, 'opponentGoals'));
  if (ag === null || og === null) return { error: 'Enter both scores as whole numbers.' };
  if (str(f, 'confirm') !== 'yes') return { error: 'Tick the box to confirm you want to publish this result.' };
  const r = await saveManualResult(a, id, {
    arsenalGoals: ag, opponentGoals: og,
    // No defaults: a blank or unselected choice is rejected by the server, never treated as "none".
    scorerState: str(f, 'scorerState') as EntryState,
    scorerName: String(f.get('scorerName') ?? ''),
    assisterState: str(f, 'assisterState') as EntryState,
    assisterName: String(f.get('assisterName') ?? ''),
    scorerReplaced: String(f.get('scorerReplaced') ?? ''),
    assisterReplaced: String(f.get('assisterReplaced') ?? ''),
    firstGoalOwnGoal: f.get('ownGoal') === 'on',
    firstGoalUnassisted: f.get('unassisted') === 'on',
    status: (str(f, 'status') || 'finished') as FixtureStatus,
    notesPrivate: str(f, 'notesPrivate').slice(0, 2000),
    publicNote: str(f, 'publicNote').slice(0, 500),
  });
  if (!r.ok) return { error: r.error };
  const msg = resultMessage(r.finalise);
  return done(msg, `/admin/fixtures/${id}`, '/', '/table');
}

export async function confirmNameReviewAction(_p: AdminState, f: FormData): Promise<AdminState> {
  const a = await actor();
  const id = str(f, 'fixtureId');
  const r = await confirmNameReview(a, id);
  if (r.status === 'finalised') return done(`Confirmed. Only exact name matches scored: ${r.scored} prediction(s).`, `/admin/fixtures/${id}`, '/', '/table');
  return { error: r.reason };
}

export async function verifyResultAction(_p: AdminState, f: FormData): Promise<AdminState> {
  const a = await actor();
  const id = str(f, 'fixtureId');
  const r = await verifyResult(a, id);
  if (r.status === 'finalised') return done(`Verified. ${r.scored} prediction(s) scored.`, `/admin/fixtures/${id}`, '/', '/table');
  return { error: r.reason };
}

export async function voidPlayerCategoriesAction(_p: AdminState, f: FormData): Promise<AdminState> {
  const a = await actor();
  const id = str(f, 'fixtureId');
  const r = await finaliseWithPlayerCategoriesVoid(a, id, str(f, 'reason'));
  if (r.status === 'finalised') return done(`Finalised with goalscorer/assist picks not scored. ${r.scored} prediction(s) scored.`, `/admin/fixtures/${id}`, '/table');
  return { error: r.reason };
}

export async function reopenAction(_p: AdminState, f: FormData): Promise<AdminState> {
  const a = await actor();
  const id = str(f, 'fixtureId');
  const r = await reopenScoring(a, id, str(f, 'reason'));
  if (!r.ok) return { error: r.error };
  return done('Scoring reopened. Points for this match are withdrawn until it is finalised again.', `/admin/fixtures/${id}`, '/table');
}

/** Explicit, audited rescore of ONE match (the only way an already-scored match's points change). */
export async function rescoreFixtureAction(_p: AdminState, f: FormData): Promise<AdminState> {
  const a = await actor();
  const id = str(f, 'fixtureId');
  if (str(f, 'confirm') !== 'RESCORE') return { error: 'Type RESCORE to confirm.' };
  const r = await rescoreFixture(a, id, str(f, 'reason'));
  if (r.status === 'finalised') return done(`Rescored ${r.scored} prediction(s) with the ${r.rulesVersion === 2 ? '20' : '15'}-point rules this match was originally scored with. Logged in the audit log.`, `/admin/fixtures/${id}`, '/', '/table');
  return { error: r.reason };
}

export async function overridePredictionAction(_p: AdminState, f: FormData): Promise<AdminState> {
  const a = await actor();
  const id = str(f, 'fixtureId');
  const ag = parseGoals(str(f, 'arsenalGoals'));
  const og = parseGoals(str(f, 'opponentGoals'));
  if (ag === null || og === null) return { error: 'Enter both scores.' };
  const r = await adminOverridePrediction(a, str(f, 'memberId'), id, {
    arsenalGoals: ag, opponentGoals: og,
    scorer: f.get('scorerNone') === 'on' ? null : String(f.get('scorer') ?? ''),
    assister: f.get('assisterNone') === 'on' ? null : String(f.get('assister') ?? ''),
  }, str(f, 'reason'));
  if (!r.ok) return { error: r.error };
  // Never rescored automatically: an already-scored match keeps its points until an admin rescores it.
  return done(r.needsRescore ? 'Prediction set. This match is already scored, so points did not change: use "Rescore this match" if they should.' : 'Prediction set.', `/admin/fixtures/${id}`);
}

// ─── Points ───────────────────────────────────────────────────

export async function adjustmentAction(_p: AdminState, f: FormData): Promise<AdminState> {
  const a = await actor();
  const r = await members.addAdjustment(a, str(f, 'memberId'), Number(str(f, 'points')), str(f, 'reason'), str(f, 'fixtureId') || null);
  if (!r.ok) return { error: r.error };
  return done('Adjustment recorded.', '/admin/points', '/table');
}

// ─── Settings & sync ──────────────────────────────────────────

export async function settingsAction(_p: AdminState, f: FormData): Promise<AdminState> {
  const a = await actor();
  await updateSetting(a, 'revealPredictionsAfterKickoff', f.get('reveal') === 'on');
  const comps = await sql<{ code: string; enabled: boolean }[]>`select code, enabled from competitions`;
  for (const c of comps) {
    const want = f.get(`comp_${c.code}`) === 'on';
    if (want !== c.enabled) {
      await sql.begin(async (tx) => {
        await tx`update competitions set enabled = ${want} where code = ${c.code}`;
        await audit(tx, a, 'settings.competition_toggled', 'competition', c.code, { enabled: want });
      });
    }
  }
  return done('Settings saved.', '/admin/settings', '/');
}

export async function syncAction(_p: AdminState, f: FormData): Promise<AdminState> {
  await actor();
  const job = str(f, 'job');
  const fn = { fixtures: syncFixtures, results: syncResults, squads: syncSquads, lineups: syncLineups }[job];
  if (!fn) return { error: 'Unknown job' };
  const r = await fn();
  revalidatePath('/admin');
  return r.status === 'error' ? { error: `Sync failed: ${r.message}` } : { ok: `${job}: ${r.message}` };
}

// ─── Hall of Fame ─────────────────────────────────────────────

function hofInput(f: FormData) {
  return {
    season: str(f, 'season'),
    winnerName: String(f.get('winnerName') ?? ''),
    memberId: str(f, 'memberId') || null,
    points: str(f, 'points') || null,
    summary: String(f.get('summary') ?? ''),
  };
}

export async function addHallOfFameAction(_p: AdminState, f: FormData): Promise<AdminState> {
  const a = await actor();
  const r = await addHallOfFame(a, hofInput(f));
  if (!r.ok) return { error: r.error };
  return done('Champion added to the Hall of Fame.', '/admin/hall-of-fame', '/hall-of-fame');
}

export async function updateHallOfFameAction(_p: AdminState, f: FormData): Promise<AdminState> {
  const a = await actor();
  const r = await updateHallOfFame(a, str(f, 'id'), hofInput(f));
  if (!r.ok) return { error: r.error };
  return done('Entry updated.', '/admin/hall-of-fame', '/hall-of-fame');
}

export async function deleteHallOfFameAction(_p: AdminState, f: FormData): Promise<AdminState> {
  const a = await actor();
  if (str(f, 'confirm') !== 'yes') return { error: 'Tick the box to confirm the deletion.' };
  const r = await deleteHallOfFame(a, str(f, 'id'));
  if (!r.ok) return { error: r.error };
  revalidatePath('/admin/hall-of-fame');
  revalidatePath('/hall-of-fame');
  // The deleted entry's form disappears with it, so confirm on the page instead.
  redirect('/admin/hall-of-fame?deleted=1');
}
