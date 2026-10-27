import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireMember } from '@/lib/session';
import { getFixture, displayStatus, hasKickedOff } from '@/lib/fixtures';
import { predictionsForFixture, getPrediction } from '@/lib/predictions';
import { getResult, fixtureScores, matchEvents } from '@/lib/results';
import { getSettings } from '@/lib/settings';
import { formatKickoff, ukZoneLabel } from '@/lib/time';
import { Scoreboard } from '@/components/Scoreboard';
import { SourceChip, Alert } from '@/components/bits';

export const metadata = { title: 'Match centre' };

const OUTCOME_CLASS: Record<string, string> = { correct: 'correct', crossover: 'crossover', void: 'void', incorrect: '' };

export default async function MatchCentre({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireMember();
  const { id } = await params;
  const fixture = await getFixture(id);
  if (!fixture) notFound();
  const [settings, result, mine] = await Promise.all([getSettings(), getResult(id), getPrediction(id, me.id)]);
  const kicked = hasKickedOff(fixture);
  const reveal = kicked && settings.revealPredictionsAfterKickoff;
  const [preds, scores, events] = await Promise.all([
    reveal ? predictionsForFixture(id) : Promise.resolve([]),
    fixtureScores(id),
    matchEvents(id),
  ]);
  const scoreBy = new Map(scores.map((s) => [s.memberId, s]));
  // Breakdowns are shown exactly as stored: matches scored before the 20-point rules have no exact-score column.
  const twentyPoint = scores.some((s) => s.rulesVersion === 2);
  const status = displayStatus(fixture, !!mine);
  const finalised = fixture.scoringStatus === 'finalised';
  const goalEvents = events.filter((e) => e.eventType !== 'substitution');
  const subs = events.filter((e) => e.eventType === 'substitution');
  const showResult = result && (finalised || fixture.status === 'finished' || fixture.status === 'live');
  const rows = reveal
    ? [...preds].sort((a, b) => (scoreBy.get(b.memberId)?.totalPoints ?? -1) - (scoreBy.get(a.memberId)?.totalPoints ?? -1) || a.displayName.localeCompare(b.displayName))
    : [];

  return (
    <div className="stack">
      <p className="muted" style={{ marginBottom: 0 }}><Link href="/matches">All matches</Link></p>
      <Scoreboard fixture={fixture} status={status} result={showResult ? result : null} prediction={showResult ? null : mine} cta={null} />

      {(status === 'awaiting' || status === 'review') && (
        <Alert kind="warn">The score is in, but the first goalscorer or assist still needs checking. Points will appear once Jon or Knighty confirm it.</Alert>
      )}

      {showResult && result && (
        <section className="panel">
          <div className="panel-head">
            <h2>The result</h2>
            <SourceChip source={result.source} verified={result.verified} />
          </div>
          <dl className="confirm-list">
            <dt>First goalscorer</dt>
            <dd>{result.firstScorerKind === 'player' ? `${result.firstScorerName}${result.firstScorerReplacedName ? ` (came on for ${result.firstScorerReplacedName})` : ''}` : result.firstScorerKind === 'none' ? 'No qualifying goal' : 'Not confirmed yet'}</dd>
            <dt>First assist</dt>
            <dd>{result.firstAssisterKind === 'player' ? `${result.firstAssisterName}${result.firstAssisterReplacedName ? ` (came on for ${result.firstAssisterReplacedName})` : ''}` : result.firstAssisterKind === 'none' ? 'No assisted goal' : 'Not confirmed yet'}</dd>
            {result.firstGoalOwnGoal && (<><dt>Note</dt><dd>The first goal was an own goal, which doesn&rsquo;t count for goalscorer picks.</dd></>)}
            {result.playerCategoriesVoid && (<><dt>Ruling</dt><dd>Goalscorer and assist picks were not scored for this match: {result.voidReason}</dd></>)}
            {result.publicNote && (<><dt>Note</dt><dd>{result.publicNote}</dd></>)}
          </dl>
          {goalEvents.length > 0 && (
            <details className="inline">
              <summary>Goals and substitutions</summary>
              <ul>
                {goalEvents.map((e, i) => (
                  <li key={i}>{e.minute != null ? `${e.minute}${e.extraMinute ? `+${e.extraMinute}` : ''}′ ` : ''}{e.playerName ?? 'Unknown'}{e.eventType === 'own_goal' ? ' (own goal)' : ''}{e.side === 'arsenal' ? ' for Arsenal' : ` for ${fixture.opponent}`}{e.assistStatus === 'credited' ? `, assist ${e.assistName}` : e.assistStatus === 'unknown' ? ', assist not recorded' : ''}</li>
                ))}
                {subs.map((e, i) => <li key={`s${i}`} className="muted">{e.minute}′ substitution: {e.playerName} on for {e.assistName}</li>)}
              </ul>
            </details>
          )}
        </section>
      )}

      <section className="panel">
        <h2>Everyone&rsquo;s predictions</h2>
        {!kicked ? (
          <p className="muted">Predictions are hidden until kick-off ({formatKickoff(fixture.kickoffAt)} {ukZoneLabel(fixture.kickoffAt)}). Then everyone&rsquo;s locked picks appear here.</p>
        ) : !reveal ? (
          <p className="muted">Other members&rsquo; predictions are hidden for this competition.</p>
        ) : rows.length === 0 ? (
          <p className="muted">Nobody predicted this match.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Member</th><th className="c">Score</th><th>First scorer</th><th>First assist</th>
                  {finalised && <>{twentyPoint && <th className="r">Exact</th>}<th className="r">Scorer</th><th className="r">Assist</th><th className="r">Result</th><th className="r">Goals</th><th className="r">Bonus</th><th className="r">Total</th></>}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const s = scoreBy.get(p.memberId);
                  return (
                    <tr key={p.memberId} style={p.memberId === me.id ? { background: 'rgba(219,0,7,.09)' } : undefined}>
                      <td><strong>{p.displayName}</strong></td>
                      <td className="c num">{p.arsenalGoals}–{p.opponentGoals}</td>
                      <td>{p.scorerNone ? 'None' : p.scorerName}</td>
                      <td>{p.assisterNone ? 'None' : p.assisterName}</td>
                      {finalised && (
                        <>
                          {twentyPoint && <td className={`r cat ${s?.exactScorePoints ? 'correct' : ''}`}>{s?.exactScorePoints ?? 0}</td>}
                          <td className={`r cat ${OUTCOME_CLASS[s?.scorerOutcome ?? ''] ?? ''}`}>{s?.scorerPoints ?? 0}</td>
                          <td className={`r cat ${OUTCOME_CLASS[s?.assisterOutcome ?? ''] ?? ''}`}>{s?.assisterPoints ?? 0}</td>
                          <td className="r">{s?.resultPoints ?? 0}</td>
                          <td className="r">{s?.totalGoalsPoints ?? 0}</td>
                          <td className="r">{s?.bonusPoints ? <strong style={{ color: 'var(--gold)' }}>+{s.bonusPoints}</strong> : 0}</td>
                          <td className="r points-cell">{s?.totalPoints ?? 0}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {finalised && rows.length > 0 && (
          <p className="small muted" style={{ marginTop: 12 }}>
            Scored with the {twentyPoint ? '20' : '15'}-point rules{twentyPoint ? '' : ' (this match was scored before the 20-point rules started)'}.
            Green = correct (5). Amber = crossover: your scorer made the first assist, or your assister scored first (3).
          </p>
        )}
      </section>
    </div>
  );
}
