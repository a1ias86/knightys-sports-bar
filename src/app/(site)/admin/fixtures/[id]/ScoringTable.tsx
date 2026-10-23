import type { PredictionCheck, PickVerdict, StoredResult, fixtureScores } from '@/lib/results';
import { resultCategory } from '@/lib/scoring';

type Score = Awaited<ReturnType<typeof fixtureScores>>[number];

const VERDICT: Record<PickVerdict, { label: string; cls: string }> = {
  correct: { label: 'Correct', cls: 'v-correct' },
  'none-correct': { label: 'Correct', cls: 'v-correct' },
  crossover: { label: 'Crossover', cls: 'v-cross' },
  wrong: { label: 'No match', cls: 'v-wrong' },
  review: { label: 'Check', cls: 'v-review' },
  pending: { label: 'Waiting', cls: 'v-pending' },
};

const RESULT_WORD = { win: 'Arsenal win', draw: 'Draw', loss: 'Arsenal loss' } as const;

function official(kind: StoredResult['firstScorerKind'] | undefined, name: string | null | undefined, none: string, replaced?: string | null) {
  if (kind === 'player') return replaced ? `${name} (on for ${replaced})` : name;
  if (kind === 'none') return none;
  if (kind === 'unknown') return 'Unknown';
  return 'Not entered';
}

/** Per-member comparison with the official result, plus the stored point breakdown once scored. */
export function ScoringTable({ checks, scores, result, finalised, overrides }: {
  checks: PredictionCheck[];
  scores: Map<string, Score>;
  result: StoredResult | null;
  finalised: boolean;
  overrides: Map<string, string>;
}) {
  const actualCat = result ? resultCategory(result.arsenalGoals, result.opponentGoals) : null;
  const actualTotal = result ? result.arsenalGoals + result.opponentGoals : null;
  return (
    <div className="table-wrap">
      <table className="scoring-table">
        <thead>
          <tr>
            <th>Member</th>
            <th>Predicted score</th>
            <th>First goalscorer</th>
            <th>First assister</th>
            <th className="r">Scorer</th>
            <th className="r">Assist</th>
            <th className="r">Result</th>
            <th className="r">Goals</th>
            <th className="r">Bonus</th>
            <th className="r">Total</th>
          </tr>
          <tr className="official-row">
            <td><strong>Official</strong></td>
            <td className="num">{result ? `${result.arsenalGoals}–${result.opponentGoals} (${RESULT_WORD[actualCat!]}, ${actualTotal} goals)` : 'Not entered'}</td>
            <td>{official(result?.firstScorerKind, result?.firstScorerName, 'No qualifying goal', result?.firstScorerReplacedName)}</td>
            <td>{official(result?.firstAssisterKind, result?.firstAssisterName, 'No credited assist', result?.firstAssisterReplacedName)}</td>
            <td colSpan={6} className="small muted">{result?.playerCategoriesVoid ? `Scorer/assist not scored: ${result.voidReason}` : ''}</td>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => {
            const s = scores.get(c.memberId);
            const cat = resultCategory(c.arsenalGoals, c.opponentGoals);
            const resultOk = actualCat ? cat === actualCat : null;
            const totalOk = actualTotal !== null ? c.arsenalGoals + c.opponentGoals === actualTotal : null;
            const pts = (n: number | undefined) => (finalised && s ? n : '–');
            return (
              <tr key={c.memberId}>
                <td>
                  <strong>{c.displayName}</strong>
                  {overrides.get(c.memberId) && <div className="small" style={{ color: 'var(--warn)' }}>Set by admin: {overrides.get(c.memberId)}</div>}
                </td>
                <td className="num">
                  {c.arsenalGoals}–{c.opponentGoals}
                  <div className="small muted">{RESULT_WORD[cat]}{resultOk === null ? '' : resultOk ? ' ✓' : ' ✗'}, {c.arsenalGoals + c.opponentGoals} goals{totalOk === null ? '' : totalOk ? ' ✓' : ' ✗'}</div>
                </td>
                <td>
                  {c.scorerPick ?? 'None'} <span className={`verdict ${VERDICT[c.scorerVerdict].cls}`}>{VERDICT[c.scorerVerdict].label}</span>
                  {c.scorerMatchNote && <div className="small muted">{c.scorerMatchNote}</div>}
                </td>
                <td>
                  {c.assisterPick ?? 'None'} <span className={`verdict ${VERDICT[c.assisterVerdict].cls}`}>{VERDICT[c.assisterVerdict].label}</span>
                  {c.assisterMatchNote && <div className="small muted">{c.assisterMatchNote}</div>}
                </td>
                <td className="r num">{pts(s?.scorerPoints)}</td>
                <td className="r num">{pts(s?.assisterPoints)}</td>
                <td className="r num">{pts(s?.resultPoints)}</td>
                <td className="r num">{pts(s?.totalGoalsPoints)}</td>
                <td className="r num">{finalised && s ? (s.bonusPoints ? <strong style={{ color: 'var(--gold)' }}>+{s.bonusPoints}</strong> : 0) : '–'}</td>
                <td className="r points-cell">{pts(s?.totalPoints)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
