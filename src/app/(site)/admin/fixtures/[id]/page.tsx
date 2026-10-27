import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/session';
import { getFixture, listCompetitions, displayStatus } from '@/lib/fixtures';
import { predictionsForFixture } from '@/lib/predictions';
import { getResult, getFeed, fixtureScores, matchEvents, checkPredictions, getScoringInfo } from '@/lib/results';
import { MAX_POINTS } from '@/lib/scoring';
import { OfficialPlayerField } from './OfficialPlayerField';
import { ScoringTable } from './ScoringTable';
import { sql } from '@/lib/db';
import { formatKickoff, formatDateTime, ukZoneLabel } from '@/lib/time';
import { StatusChip, SourceChip, venueText, Alert } from '@/components/bits';
import { ActionForm } from '@/components/ActionForm';
import { FixtureFields } from '@/components/FixtureFields';
import {
  updateFixtureAction, fixtureSyncToggleAction, manualResultAction, verifyResultAction, voidPlayerCategoriesAction,
  reopenAction, rescoreFixtureAction, overridePredictionAction, confirmNameReviewAction,
} from '../../actions';

export const metadata = { title: 'Manage fixture' };

export default async function FixtureAdmin({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const { created } = await searchParams;
  const fixture = await getFixture(id);
  if (!fixture) notFound();
  const [competitions, preds, result, feed, scores, events, members] = await Promise.all([
    listCompetitions(),
    predictionsForFixture(id),
    getResult(id),
    getFeed(id),
    fixtureScores(id),
    matchEvents(id),
    sql<{ id: string; displayName: string }[]>`select id, display_name from members where is_active order by lower(display_name)`,
  ]);
  const scoreBy = new Map(scores.map((s) => [s.memberId, s]));
  const scoring = await getScoringInfo(sql, id);
  const isFresh = scoring.state === 'fresh';
  const { rows: checks } = await checkPredictions(id);
  const reviewRows = fixture.scoringStatus === 'finalised' ? [] : checks.filter((c) => c.reviewNotes.length > 0);
  const overrides = new Map(preds.filter((p) => p.overrideReason).map((p) => [p.memberId, p.overrideReason!]));
  // Suggestions for the official name fields: the names members typed (admins only).
  const suggestions = [...new Set(checks.flatMap((c) => [c.scorerPick, c.assisterPick]).filter((n): n is string => !!n))]
    .sort((a, b) => a.localeCompare(b));
  const finalised = fixture.scoringStatus === 'finalised';
  const status = displayStatus(fixture, false);
  const r = result;

  return (
    <div className="stack">
      <p className="muted" style={{ marginBottom: 0 }}><Link href="/admin/fixtures">All fixtures</Link> · <Link href={`/matches/${id}`}>Member view</Link></p>
      <div>
        <h1>{venueText(fixture.venue, fixture.opponent)}</h1>
        <div className="row">
          <StatusChip status={status} />
          <span className="muted">{fixture.competitionName} · {formatKickoff(fixture.kickoffAt)} {ukZoneLabel(fixture.kickoffAt)} · scoring: {fixture.scoringStatus.replace(/_/g, ' ')}</span>
        </div>
      </div>
      {created && <Alert kind="ok">Fixture added. Members can predict until kick-off.</Alert>}
      <ScoringStatePanel state={scoring.state} rules={MAX_POINTS[scoring.rulesVersion]} note={scoring.note} />
      {fixture.reviewReason && !finalised && isFresh && <Alert kind="warn">{fixture.reviewReason}</Alert>}
      {feed?.discrepancy && <Alert kind="warn">Feed discrepancy: {feed.discrepancy} Your entered result has been kept. Correct it below if the feed is right, or press Verify to confirm yours.</Alert>}

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Result</h2>
            {r && <SourceChip source={r.source} verified={r.verified} />}
          </div>
          {!r ? (
            <p className="muted">No result yet. {fixture.provider ? 'The feed will add it after full time, or enter it below.' : 'Enter it below after the match.'}</p>
          ) : (
            <>
              <dl className="confirm-list">
                <dt>Score</dt><dd>Arsenal {r.arsenalGoals}–{r.opponentGoals} {fixture.opponent}</dd>
                <dt>First goalscorer</dt><dd>{r.firstScorerKind === 'player' ? `${r.firstScorerName}${r.firstScorerReplacedName ? ` (came on for ${r.firstScorerReplacedName})` : ''}` : r.firstScorerKind === 'none' ? 'None (no qualifying goal)' : <span className="chip chip-awaiting">Unknown</span>}</dd>
                <dt>First assister</dt><dd>{r.firstAssisterKind === 'player' ? `${r.firstAssisterName}${r.firstAssisterReplacedName ? ` (came on for ${r.firstAssisterReplacedName})` : ''}` : r.firstAssisterKind === 'none' ? 'None' : <span className="chip chip-awaiting">Unknown</span>}</dd>
                <dt>Own goal first</dt><dd>{r.firstGoalOwnGoal ? 'Yes' : 'No'}</dd>
                {r.verified && <><dt>Verified</dt><dd>{r.verifiedByName ?? 'admin'}, {r.verifiedAt ? formatDateTime(r.verifiedAt) : ''}</dd></>}
                {r.playerCategoriesVoid && <><dt>Ruling</dt><dd>Scorer/assist not scored: {r.voidReason}</dd></>}
                {r.notesPrivate && <><dt>Admin notes</dt><dd>{r.notesPrivate}</dd></>}
              </dl>
              {r.issues.length > 0 && <Alert kind="warn">{r.issues.join(' ')}</Alert>}
            </>
          )}
          {feed && (
            <p className="small muted">Feed ({feed.provider}) last checked {formatDateTime(feed.fetchedAt)}: {feed.arsenalGoals ?? '?'}–{feed.opponentGoals ?? '?'}, {feed.status}.</p>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            {r && isFresh && fixture.status === 'finished' && (
              <ActionForm action={verifyResultAction} submitLabel="Verify and score" submitClass="btn btn-red btn-small" confirm="Confirm this result is correct and publish the points?">
                <input type="hidden" name="fixtureId" value={id} />
              </ActionForm>
            )}
          </div>
          {!isFresh && (
            <details className="inline" style={{ marginTop: 16 }}>
              <summary>Rescore this match</summary>
              <p className="small muted">
                Only if this match&rsquo;s points are wrong. It recalculates this one match from the result above, using the
                {' '}{MAX_POINTS[scoring.rulesVersion]}-point rules it was {scoring.state === 'ambiguous' && scoring.successfulRuns === 0 ? 'set to use' : 'originally scored with'},
                and replaces its points in the table. Every change is recorded in the audit log with your reason.
              </p>
              <ActionForm action={rescoreFixtureAction} submitLabel="Rescore this match" submitClass="btn btn-danger btn-small" confirm="Recalculate this match's points and update the table?">
                <input type="hidden" name="fixtureId" value={id} />
                <div className="field"><label htmlFor="rescore-reason">Reason (at least 10 characters)</label><input id="rescore-reason" name="reason" type="text" required minLength={10} /></div>
                <div className="field"><label htmlFor="rescore-confirm">Type RESCORE to confirm</label><input id="rescore-confirm" name="confirm" type="text" required pattern="RESCORE" autoComplete="off" /></div>
              </ActionForm>
            </details>
          )}
          {finalised && (
            <details className="inline" style={{ marginTop: 16 }}>
              <summary>Withdraw this match&rsquo;s points</summary>
              <p className="small muted">Takes this match&rsquo;s points out of the table (for example, if it&rsquo;s later abandoned). They only come back with &ldquo;Rescore this match&rdquo;.</p>
              <ActionForm action={reopenAction} submitLabel="Withdraw points" submitClass="btn btn-danger btn-small" confirm="Take this match's points out of the table?">
                <input type="hidden" name="fixtureId" value={id} />
                <div className="field"><label htmlFor="reopen-reason">Reason (at least 10 characters)</label><input id="reopen-reason" name="reason" type="text" required minLength={10} /></div>
              </ActionForm>
            </details>
          )}
          {r && isFresh && fixture.status === 'finished' && (
            <details className="inline" style={{ marginTop: 16 }}>
              <summary>No reliable scorer/assist data anywhere?</summary>
              <p className="small muted">Competition ruling: finalise with goalscorer and assister picks scoring 0 for everyone. Result and total goals still count. Recorded in the audit log and shown to members.</p>
              <ActionForm action={voidPlayerCategoriesAction} submitLabel="Finalise without player picks" submitClass="btn btn-danger btn-small" confirm="Finalise this match without scoring goalscorer/assist picks?">
                <input type="hidden" name="fixtureId" value={id} />
                <div className="field"><label htmlFor="void-reason">Reason (shown to members)</label><input id="void-reason" name="reason" type="text" required minLength={10} /></div>
              </ActionForm>
            </details>
          )}
          {events.length > 0 && (
            <details className="inline" style={{ marginTop: 16 }}>
              <summary>Feed events ({events.length})</summary>
              <ol className="small">
                {events.map((e, i) => (
                  <li key={i}>{e.minute ?? '?'}′ {e.eventType.replace('_', ' ')} · {e.side} · {e.playerName ?? 'unknown'}{e.eventType === 'substitution' ? ` on for ${e.assistName}` : e.assistStatus === 'credited' ? ` · assist ${e.assistName}` : ` · assist ${e.assistStatus}`}</li>
                ))}
              </ol>
            </details>
          )}
        </section>

        <section className="panel">
          <h2>{r ? 'Correct the result' : 'Enter the result'}</h2>
          <p className="small muted">
            {isFresh
              ? `Publishing scores this match for the first time with the ${MAX_POINTS[scoring.rulesVersion]}-point rules. Your entry is treated as verified and won’t be overwritten by the feed.`
              : 'This match is already scored. Saving a correction here updates the result only: points stay as they are until you use “Rescore this match”.'}
          </p>
          <ActionForm action={manualResultAction} submitLabel="Publish result" submitClass="btn btn-red">
            <input type="hidden" name="fixtureId" value={id} />
            <div className="score-entry" style={{ marginBottom: 16 }}>
              <div><label htmlFor="mr-ag">Arsenal</label><input id="mr-ag" name="arsenalGoals" type="number" min={0} max={20} required defaultValue={r?.arsenalGoals} /></div>
              <span className="sb-dash" aria-hidden>–</span>
              <div><label htmlFor="mr-og">{fixture.opponent}</label><input id="mr-og" name="opponentGoals" type="number" min={0} max={20} required defaultValue={r?.opponentGoals} /></div>
            </div>
            <OfficialPlayerField
              role="scorer" legend="First goalscorer" hint="Scorer of the first goal that isn't an own goal, either team."
              kind={r?.firstScorerKind} name={r?.firstScorerName} replaced={r?.firstScorerReplacedName} listId="name-suggestions"
              noneLabel="No qualifying goal (0–0, or only own goals)"
            />
            <OfficialPlayerField
              role="assister" legend="First assister" hint="First player officially credited with an assist, in match order. Skip unassisted goals."
              kind={r?.firstAssisterKind} name={r?.firstAssisterName} replaced={r?.firstAssisterReplacedName} listId="name-suggestions"
              noneLabel="Confirmed: no credited assist in the match"
            />
            <datalist id="name-suggestions">{suggestions.map((n) => <option key={n} value={n} />)}</datalist>
            <div className="field"><label className="checkbox"><input type="checkbox" name="ownGoal" defaultChecked={r?.firstGoalOwnGoal} /> The first goal of the match was an own goal</label></div>
            <div className="field"><label className="checkbox"><input type="checkbox" name="unassisted" defaultChecked={r?.firstGoalUnassisted} /> The first qualifying goal was unassisted</label></div>
            <div className="field">
              <label htmlFor="mr-status">Match status</label>
              <select id="mr-status" name="status" defaultValue={fixture.status === 'abandoned' ? 'abandoned' : 'finished'}>
                <option value="finished">Finished: score the predictions</option>
                <option value="live">Live: save the score so far, don&rsquo;t score</option>
                <option value="abandoned">Abandoned: no points</option>
              </select>
            </div>
            <div className="field"><label htmlFor="mr-public">Note for members (optional)</label><input id="mr-public" name="publicNote" type="text" maxLength={500} defaultValue={r?.publicNote ?? ''} /></div>
            <div className="field"><label htmlFor="mr-private">Admin-only notes (optional)</label><textarea id="mr-private" name="notesPrivate" maxLength={2000} defaultValue={r?.notesPrivate ?? ''} /></div>
            <div className="field"><label className="checkbox"><input type="checkbox" name="confirm" value="yes" required /> I&rsquo;ve checked this and want to publish it</label></div>
          </ActionForm>
          <p className="small muted">Type the full official name, e.g. Bukayo Saka. Members&rsquo; picks are matched to it automatically, including surnames (Saka), missing accents (Odegaard) and small typos. A pick that could be either official player is flagged for you.</p>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Predictions and scoring ({preds.length})</h2><span className="small muted">Admins can always see these. Members see them after kick-off.</span></div>
        {reviewRows.length > 0 && (
          <div className="alert alert-warn">
            <p style={{ marginBottom: 8 }}><strong>Check these picks before points are given.</strong> Each one could be either official player:</p>
            <ul style={{ margin: '0 0 12px' }}>{reviewRows.flatMap((x) => x.reviewNotes.map((n, i) => <li key={x.memberId + i}>{x.displayName}: {n}</li>))}</ul>
            <p className="small" style={{ marginBottom: 10 }}>If you know who the member meant, set their prediction to the full name with the admin override below (the reason is logged), then publish again. Otherwise score these picks as no match:</p>
            <ActionForm action={confirmNameReviewAction} submitLabel="Score ambiguous picks as no match" submitClass="btn btn-small" confirm="Score these ambiguous picks as no match (0 for that category)?">
              <input type="hidden" name="fixtureId" value={id} />
            </ActionForm>
          </div>
        )}
        {checks.length === 0 ? <p className="muted">No predictions yet.</p> : (
          <ScoringTable checks={checks} scores={scoreBy} result={r} finalised={finalised} overrides={overrides} rulesVersion={scoring.rulesVersion} />
        )}
        <p className="small muted">Green = correct (5). Amber = crossover (3). Red = no match. &ldquo;Check&rdquo; = could be either official player, waiting for you. &ldquo;Waiting&rdquo; = the official answer isn&rsquo;t entered or is unknown. {finalised ? 'Points shown are the stored, published breakdown.' : 'No points are published until the match is scored.'}</p>
        <details className="inline" style={{ marginTop: 16 }}>
          <summary>Set a prediction for a member (admin override)</summary>
          <p className="small muted">Only for genuine cases, e.g. a member sent their prediction before kick-off but couldn&rsquo;t log in. The reason is recorded in the audit log. If the match is already scored it is rescored.</p>
          <ActionForm action={overridePredictionAction} submitLabel="Save override" submitClass="btn btn-small" confirm="Save this prediction on the member's behalf?">
            <input type="hidden" name="fixtureId" value={id} />
            <div className="form-grid">
              <div className="field"><label htmlFor="ov-member">Member</label><select id="ov-member" name="memberId" required>{members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</select></div>
              <div className="field"><label htmlFor="ov-ag">Arsenal</label><input id="ov-ag" name="arsenalGoals" type="number" min={0} max={20} required /></div>
              <div className="field"><label htmlFor="ov-og">{fixture.opponent}</label><input id="ov-og" name="opponentGoals" type="number" min={0} max={20} required /></div>
              <div className="field">
                <label htmlFor="ov-scorer">First goalscorer</label>
                <input id="ov-scorer" name="scorer" type="text" maxLength={60} autoComplete="off" />
                <label className="checkbox" style={{ marginTop: 8 }}><input type="checkbox" name="scorerNone" /> No goalscorer (0–0 only)</label>
              </div>
              <div className="field">
                <label htmlFor="ov-assister">First assister</label>
                <input id="ov-assister" name="assister" type="text" maxLength={60} autoComplete="off" />
                <label className="checkbox" style={{ marginTop: 8 }}><input type="checkbox" name="assisterNone" /> No assister</label>
              </div>
              <div className="field"><label htmlFor="ov-reason">Reason</label><input id="ov-reason" name="reason" type="text" required minLength={5} /></div>
            </div>
          </ActionForm>
        </details>
      </section>

      <section className="panel">
        <h2>Fixture details</h2>
        {fixture.provider && (
          <form action={fixtureSyncToggleAction} className="row" style={{ marginBottom: 16 }}>
            <input type="hidden" name="fixtureId" value={id} />
            <input type="hidden" name="allow" value={fixture.manualOverride ? '1' : '0'} />
            <span className="small muted">{fixture.manualOverride ? 'Locked: the feed won’t change kick-off time or status.' : `Synced from ${fixture.provider}${fixture.lastSyncedAt ? `, last ${formatDateTime(fixture.lastSyncedAt)}` : ''}.`}</span>
            <button className="btn btn-ghost btn-small">{fixture.manualOverride ? 'Let the feed update it' : 'Lock from feed changes'}</button>
          </form>
        )}
        <ActionForm action={updateFixtureAction} submitLabel="Save fixture" submitClass="btn" confirm="Save these fixture details? Changing kick-off moves the prediction deadline.">
          <input type="hidden" name="fixtureId" value={id} />
          <FixtureFields competitions={competitions} fixture={fixture} />
        </ActionForm>
      </section>
    </div>
  );
}

function ScoringStatePanel({ state, rules, note }: { state: 'fresh' | 'scored' | 'withdrawn' | 'ambiguous'; rules: number; note: string | null }) {
  if (state === 'fresh') {
    return <Alert kind="info">Not scored yet. This match will be scored with the <strong>{rules}-point rules</strong> when its result is published.</Alert>;
  }
  if (state === 'scored') {
    return <Alert kind="info"><strong>Protected:</strong> scored with the {rules}-point rules. Saving, verifying, the data feed and prediction overrides never change these points; only &ldquo;Rescore this match&rdquo; can.</Alert>;
  }
  if (state === 'withdrawn') {
    return <Alert kind="warn"><strong>Points withdrawn.</strong> This match was scored with the {rules}-point rules, then its points were taken out of the table. {note}</Alert>;
  }
  return <Alert kind="error"><strong>Needs checking.</strong> {note} Nothing will change this match automatically.</Alert>;
}
