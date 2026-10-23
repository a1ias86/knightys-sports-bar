import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  scorePrediction,
  deriveOutcome,
  validateOutcome,
  isScoreable,
  competitionRank,
  type GoalEvent,
  type MatchOutcome,
  type PredictionInput,
} from '../../src/lib/scoring';

const A = 'player-a';
const B = 'player-b';
const C = 'player-c';
const D = 'player-d';

const player = (id: string) => ({ kind: 'player' as const, id });
const none = { kind: 'none' as const };

function outcome(ag: number, og: number, scorer: MatchOutcome['firstScorer'], assister: MatchOutcome['firstAssister'], ownGoal = false): MatchOutcome {
  return { arsenalGoals: ag, opponentGoals: og, firstScorer: scorer, firstAssister: assister, firstGoalWasOwnGoal: ownGoal };
}
function pred(ag: number, og: number, scorer: PredictionInput['scorer'], assister: PredictionInput['assister']): PredictionInput {
  return { arsenalGoals: ag, opponentGoals: og, scorer, assister };
}
function goal(seq: number, scorerId: string | null, assist: GoalEvent['assist'], side: GoalEvent['side'] = 'arsenal', type: GoalEvent['type'] = 'goal'): GoalEvent {
  return { seq, scorerId, assist, side, type };
}

// NOTE on the brief's Examples A and B: both use a 3-1 prediction against a 2-2 result and award the
// "correct result" point. Under the written rule (Arsenal win / draw / loss) a 3-1 prediction is an Arsenal
// win and 2-2 is a draw, so the result point is NOT earned. The engine follows the written rule; the tests
// below pin down both the examples as written and the intended full house. See docs/SCORING.md.
describe('Specified examples', () => {
  test('Example A as written (3-1 v 2-2, both picks right): 5 + 5 + total 1 = 11, no result point, no bonus', () => {
    const r = scorePrediction(pred(3, 1, player(A), player(B)), outcome(2, 2, player(A), player(B)));
    assert.deepEqual(
      [r.scorerPoints, r.assisterPoints, r.resultPoints, r.totalGoalsPoints, r.bonusPoints, r.totalPoints],
      [5, 5, 0, 1, 0, 11],
    );
  });

  test('Example A intent: both picks, result and total correct = 5+5+1+1+3 = 15', () => {
    const r = scorePrediction(pred(3, 1, player(A), player(B)), outcome(2, 0, player(A), player(B)));
    assert.equal(r.totalGoalsPoints, 0); // 2-0 has a different total: not a full house
    const fh = scorePrediction(pred(3, 1, player(A), player(B)), outcome(4, 0, player(A), player(B)));
    assert.deepEqual(
      [fh.scorerPoints, fh.assisterPoints, fh.resultPoints, fh.totalGoalsPoints, fh.bonusPoints, fh.totalPoints],
      [5, 5, 1, 1, 3, 15],
    );
  });

  test('Example B as written (3-1 v 2-2, no picks right): total-goals point only = 1', () => {
    const r = scorePrediction(pred(3, 1, player(C), player(D)), outcome(2, 2, player(A), player(B)));
    assert.equal(r.resultPoints, 0);
    assert.equal(r.totalGoalsPoints, 1);
    assert.equal(r.totalPoints, 1);
  });

  test('Example B intent: result and total right, no picks right = 2', () => {
    const r = scorePrediction(pred(3, 1, player(C), player(D)), outcome(4, 0, player(A), player(B)));
    assert.equal(r.totalPoints, 2);
  });

  test('Example C: crossover both ways = 3 + 3, no 5s', () => {
    const r = scorePrediction(pred(1, 0, player(A), player(B)), outcome(1, 0, player(B), player(A)));
    assert.equal(r.scorerPoints, 3);
    assert.equal(r.scorerOutcome, 'crossover');
    assert.equal(r.assisterPoints, 3);
    assert.equal(r.assisterOutcome, 'crossover');
    assert.equal(r.bonusPoints, 0, 'crossovers never count towards the full house');
    assert.equal(r.totalPoints, 3 + 3 + 1 + 1);
  });
});

describe('Result and total goals', () => {
  test('a 2-2 prediction for a 1-1 match earns the result point', () => {
    const r = scorePrediction(pred(2, 2, player(C), player(D)), outcome(1, 1, player(A), player(B)));
    assert.equal(r.resultPoints, 1);
    assert.equal(r.totalGoalsPoints, 0);
  });
  test('Arsenal win predicted and won', () => {
    assert.equal(scorePrediction(pred(2, 0, player(C), none), outcome(1, 0, player(A), none)).resultPoints, 1);
  });
  test('Arsenal loss predicted and lost', () => {
    assert.equal(scorePrediction(pred(0, 1, player(C), player(D)), outcome(1, 3, player(A), player(B))).resultPoints, 1);
  });
  test('Arsenal loss predicted but won', () => {
    const r = scorePrediction(pred(0, 2, player(C), player(D)), outcome(2, 0, player(A), player(B)));
    assert.equal(r.resultPoints, 0);
    assert.equal(r.totalGoalsPoints, 1);
  });
  test('total goals: 3-1 prediction v 0-4 actual (different result, same total)', () => {
    const r = scorePrediction(pred(3, 1, player(C), player(D)), outcome(0, 4, player(A), player(B)));
    assert.equal(r.resultPoints, 0);
    assert.equal(r.totalGoalsPoints, 1);
  });
});

describe('0-0 matches and "none" picks', () => {
  const nilNil = outcome(0, 0, none, none);
  test('0-0 with no scorer and no assister picks = 15', () => {
    const r = scorePrediction(pred(0, 0, none, none), nilNil);
    assert.equal(r.totalPoints, 15);
  });
  test('0-0 predicted with a player pick still gets result + total', () => {
    const r = scorePrediction(pred(0, 0, player(A), player(B)), nilNil);
    assert.equal(r.totalPoints, 2);
  });
  test('"No assister" pick is correct when every goal was unassisted', () => {
    const r = scorePrediction(pred(1, 0, player(A), none), outcome(1, 0, player(A), none));
    assert.equal(r.assisterPoints, 5);
    assert.equal(r.totalPoints, 15);
  });
  test('"No assister" pick is wrong when there was a credited assist', () => {
    const r = scorePrediction(pred(1, 0, player(A), none), outcome(1, 0, player(A), player(B)));
    assert.equal(r.assisterPoints, 0);
    assert.equal(r.bonusPoints, 0);
  });
});

describe('Crossover awards are replacements and evaluated independently', () => {
  test('scorer pick correct (5) and assister pick crossover (3)', () => {
    // First scorer A, first assister C. Scorer pick A = correct 5; assister pick A (who scored) = crossover 3.
    const r = scorePrediction(pred(2, 0, player(A), player(A)), outcome(2, 0, player(A), player(C)));
    assert.equal(r.scorerPoints, 5);
    assert.equal(r.assisterPoints, 3);
    assert.equal(r.bonusPoints, 0);
  });
  test('the same player as first scorer and first assister: both primary picks score 5', () => {
    const r = scorePrediction(pred(2, 0, player(A), player(A)), outcome(2, 0, player(A), player(A)));
    assert.equal(r.scorerPoints, 5);
    assert.equal(r.assisterPoints, 5);
    assert.equal(r.totalPoints, 15);
  });
  test('scorer pick provides the first assist (3), assister pick wrong (0)', () => {
    const r = scorePrediction(pred(1, 1, player(B), player(D)), outcome(1, 0, player(A), player(B)));
    assert.equal(r.scorerPoints, 3);
    assert.equal(r.assisterPoints, 0);
  });
  test('a crossover never stacks with a 5 in the same category', () => {
    const r = scorePrediction(pred(1, 0, player(A), player(B)), outcome(1, 0, player(A), player(B)));
    assert.equal(r.scorerPoints, 5);
    assert.equal(r.assisterPoints, 5);
  });
});

describe('Deriving the first scorer / assister from events', () => {
  test('multiple goals: first by seq order, even if supplied out of order', () => {
    const d = deriveOutcome(2, 1, [
      goal(3, C, { status: 'credited', playerId: D }),
      goal(1, A, { status: 'credited', playerId: B }),
      goal(2, 'opp-1', { status: 'unassisted' }, 'opponent'),
    ]);
    assert.deepEqual(d.issues, []);
    assert.deepEqual(d.outcome.firstScorer, player(A));
    assert.deepEqual(d.outcome.firstAssister, player(B));
  });

  test('unassisted first goal: first assister comes from a later goal', () => {
    const d = deriveOutcome(2, 0, [goal(1, A, { status: 'unassisted' }), goal(2, B, { status: 'credited', playerId: A })]);
    assert.deepEqual(d.outcome.firstScorer, player(A));
    assert.deepEqual(d.outcome.firstAssister, player(A), 'A scores then assists: allowed');
    assert.ok(isScoreable(d.outcome));
  });

  test('all goals unassisted: no first assister', () => {
    const d = deriveOutcome(1, 0, [goal(1, A, { status: 'unassisted' })]);
    assert.deepEqual(d.outcome.firstAssister, none);
  });

  test('missing assist information blocks scoring', () => {
    const d = deriveOutcome(1, 0, [goal(1, A, { status: 'unknown' })]);
    assert.deepEqual(d.outcome.firstAssister, { kind: 'unknown' });
    assert.equal(isScoreable(d.outcome), false);
    assert.ok(d.issues.length > 0);
    assert.throws(() => scorePrediction(pred(1, 0, player(A), none), d.outcome));
  });

  test('missing scorer blocks scoring', () => {
    const d = deriveOutcome(1, 0, [goal(1, null, { status: 'unassisted' })]);
    assert.equal(isScoreable(d.outcome), false);
  });

  test('events not matching the final score (delayed/partial feed) block scoring', () => {
    const d = deriveOutcome(2, 0, [goal(1, A, { status: 'credited', playerId: B })]);
    assert.equal(isScoreable(d.outcome), false);
    assert.match(d.issues[0], /do not match/);
  });

  test('no events at all for a 1-0 (feed has score only) blocks scoring', () => {
    const d = deriveOutcome(1, 0, []);
    assert.equal(isScoreable(d.outcome), false);
  });

  test('duplicate events are ignored', () => {
    const e = goal(1, A, { status: 'credited', playerId: B });
    const d = deriveOutcome(1, 0, [{ ...e, dedupeKey: 'x1' }, { ...e, dedupeKey: 'x1' }]);
    assert.deepEqual(d.issues, []);
    assert.ok(isScoreable(d.outcome));
  });

  test('0-0: no scorer, no assister, scoreable', () => {
    const d = deriveOutcome(0, 0, []);
    assert.deepEqual(d.outcome.firstScorer, none);
    assert.deepEqual(d.outcome.firstAssister, none);
    assert.ok(isScoreable(d.outcome));
  });
});

describe('Own goals', () => {
  test('own goal first: named player is NOT credited; next real goal is the first qualifying goal; flagged', () => {
    const d = deriveOutcome(2, 0, [
      goal(1, 'opp-defender', { status: 'unknown' }, 'arsenal', 'own_goal'),
      goal(2, B, { status: 'credited', playerId: C }),
    ]);
    assert.deepEqual(d.outcome.firstScorer, player(B));
    assert.deepEqual(d.outcome.firstAssister, player(C));
    assert.equal(d.outcome.firstGoalWasOwnGoal, true);
    assert.ok(d.issues.some((i) => /own goal/.test(i)));
    // Somebody who picked the own-goal scorer gets nothing for the scorer category.
    const r = scorePrediction(pred(2, 0, player('opp-defender'), player(C)), d.outcome);
    assert.equal(r.scorerPoints, 0);
  });

  test('match won only by an own goal: no qualifying goal', () => {
    const d = deriveOutcome(1, 0, [goal(1, 'opp-defender', { status: 'unknown' }, 'arsenal', 'own_goal')]);
    assert.deepEqual(d.outcome.firstScorer, none);
    assert.deepEqual(d.outcome.firstAssister, none);
    assert.ok(isScoreable(d.outcome));
  });
});

describe('Outcome validation (manual entry)', () => {
  test('0-0 cannot have a scorer', () => {
    assert.ok(validateOutcome(outcome(0, 0, player(A), none)).length > 0);
  });
  test('goals scored but no scorer and no own-goal flag is rejected', () => {
    assert.ok(validateOutcome(outcome(1, 0, none, none)).length > 0);
  });
  test('negative scores are rejected', () => {
    assert.ok(validateOutcome(outcome(-1, 0, none, none)).length > 0);
  });
  test('assist without a qualifying goal is rejected', () => {
    assert.ok(validateOutcome(outcome(1, 0, none, player(A), true)).length > 0);
  });
});

describe('Repeatability', () => {
  test('scoring is deterministic (repeated recalculation gives identical results)', () => {
    const o = outcome(2, 1, player(A), player(B));
    const p = pred(2, 1, player(A), player(C));
    assert.deepEqual(scorePrediction(p, o), scorePrediction(p, o));
  });
  test('a corrected scorer changes the result', () => {
    const p = pred(1, 0, player(A), player(B));
    const before = scorePrediction(p, outcome(1, 0, player(C), player(B)));
    const after = scorePrediction(p, outcome(1, 0, player(A), player(B)));
    assert.equal(before.totalPoints, 7);
    assert.equal(after.totalPoints, 15);
  });
});

describe('Admin decision: player categories void', () => {
  test('unknown scorer/assister can be finalised with only result + total counting', () => {
    const unknown = outcome(1, 0, { kind: 'unknown' }, { kind: 'unknown' });
    const r = scorePrediction(pred(1, 0, player(A), player(B)), unknown, { playerCategoriesVoid: true });
    assert.equal(r.scorerOutcome, 'void');
    assert.equal(r.assisterOutcome, 'void');
    assert.equal(r.totalPoints, 2);
    assert.equal(r.bonusPoints, 0);
  });
});

describe('Competition ranking', () => {
  test('ties share a position and the next position is skipped', () => {
    const rows = [{ n: 'a', p: 10 }, { n: 'b', p: 8 }, { n: 'c', p: 8 }, { n: 'd', p: 5 }];
    assert.deepEqual(competitionRank(rows, (r) => r.p).map((r) => r.position), [1, 2, 2, 4]);
  });
});
