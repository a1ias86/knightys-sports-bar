/**
 * Version 2 (20-point) rules. Version 1 is covered, unchanged, by scoring.test.ts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scorePrediction, type MatchOutcome, type PredictionInput, MAX_POINTS } from '../../src/lib/scoring';

const A = 'saka', B = 'odegaard', C = 'rice', D = 'havertz';
const player = (id: string) => ({ kind: 'player' as const, id });
const none = { kind: 'none' as const };
const outcome = (ag: number, og: number, s: MatchOutcome['firstScorer'], a: MatchOutcome['firstAssister'], og1 = false): MatchOutcome =>
  ({ arsenalGoals: ag, opponentGoals: og, firstScorer: s, firstAssister: a, firstGoalWasOwnGoal: og1 });
const pred = (ag: number, og: number, s: PredictionInput['scorer'], a: PredictionInput['assister']): PredictionInput =>
  ({ arsenalGoals: ag, opponentGoals: og, scorer: s, assister: a });
const v2 = (p: PredictionInput, o: MatchOutcome, extra = {}) => scorePrediction(p, o, { rulesVersion: 2, ...extra });
const parts = (r: ReturnType<typeof v2>) =>
  [r.exactScorePoints, r.scorerPoints, r.assisterPoints, r.totalGoalsPoints, r.resultPoints, r.bonusPoints, r.totalPoints];

describe('20-point rules', () => {
  test('maximum is 20', () => assert.equal(MAX_POINTS[2], 20));

  test('full house: exact score + scorer + assister + total + result + bonus = 20', () => {
    assert.deepEqual(parts(v2(pred(2, 1, player(A), player(B)), outcome(2, 1, player(A), player(B)))), [5, 5, 5, 1, 1, 3, 20]);
  });

  test('exact score right, scorer and assister wrong = 7', () => {
    assert.deepEqual(parts(v2(pred(2, 1, player(C), player(D)), outcome(2, 1, player(A), player(B)))), [5, 0, 0, 1, 1, 0, 7]);
  });

  test('exact score right, only the assister wrong: no bonus = 12', () => {
    assert.deepEqual(parts(v2(pred(2, 1, player(A), player(D)), outcome(2, 1, player(A), player(B)))), [5, 5, 0, 1, 1, 0, 12]);
  });

  test('scorer and assister right, scoreline wrong (same result, different total) = 11', () => {
    assert.deepEqual(parts(v2(pred(3, 1, player(A), player(B)), outcome(2, 1, player(A), player(B)))), [0, 5, 5, 0, 1, 0, 11]);
  });

  test('scorer and assister right, result and total right but not exact (3-1 v 4-0): no bonus = 12', () => {
    assert.deepEqual(parts(v2(pred(3, 1, player(A), player(B)), outcome(4, 0, player(A), player(B)))), [0, 5, 5, 1, 1, 0, 12]);
  });

  test('total goals right, scoreline wrong (Arsenal 2-1 v 1-2)', () => {
    const r = v2(pred(2, 1, player(C), player(D)), outcome(1, 2, player(A), player(B)));
    assert.deepEqual(parts(r), [0, 0, 0, 1, 0, 0, 1]);
  });

  test('result right, scoreline wrong (2-0 v 3-1)', () => {
    assert.deepEqual(parts(v2(pred(2, 0, player(C), player(D)), outcome(3, 1, player(A), player(B)))), [0, 0, 0, 0, 1, 0, 1]);
  });

  test('draw and loss results', () => {
    assert.equal(v2(pred(1, 1, player(C), player(D)), outcome(2, 2, player(A), player(B))).resultPoints, 1);
    assert.equal(v2(pred(0, 1, player(C), player(D)), outcome(1, 3, player(A), player(B))).resultPoints, 1);
    assert.equal(v2(pred(1, 0, player(C), player(D)), outcome(0, 1, player(A), player(B))).resultPoints, 0);
  });
});

describe('Crossovers under the 20-point rules', () => {
  test('both crossovers: 3 + 3, never 5, and no bonus even with the exact score', () => {
    const r = v2(pred(1, 0, player(A), player(B)), outcome(1, 0, player(B), player(A)));
    assert.equal(r.scorerOutcome, 'crossover');
    assert.equal(r.assisterOutcome, 'crossover');
    assert.deepEqual(parts(r), [5, 3, 3, 1, 1, 0, 13]);
  });

  test('assister pick scored first: 3 for the assister category only', () => {
    const r = v2(pred(2, 0, player(A), player(A)), outcome(2, 0, player(A), player(C)));
    assert.deepEqual([r.scorerPoints, r.assisterPoints, r.bonusPoints], [5, 3, 0]);
  });

  test('a category is never awarded twice', () => {
    const r = v2(pred(1, 0, player(A), player(B)), outcome(1, 0, player(A), player(B)));
    assert.equal(r.scorerPoints, 5);
    assert.equal(r.assisterPoints, 5);
  });
});

describe('Edge cases under the 20-point rules', () => {
  test('0-0 with "no goalscorer" and "no assister" = 20', () => {
    assert.equal(v2(pred(0, 0, none, none), outcome(0, 0, none, none)).totalPoints, 20);
  });

  test('confirmed no assist: "No assister" pick is correct and can complete a full house', () => {
    assert.deepEqual(parts(v2(pred(1, 0, player(A), none), outcome(1, 0, player(A), none))), [5, 5, 5, 1, 1, 3, 20]);
  });

  test('own goal first: the own-goal scorer is not credited', () => {
    const r = v2(pred(2, 0, player('defender'), player(C)), outcome(2, 0, player(B), player(C), true));
    assert.equal(r.scorerPoints, 0);
    assert.equal(r.exactScorePoints, 5);
  });

  test('incomplete result data cannot be scored', () => {
    assert.throws(() => v2(pred(1, 0, player(A), player(B)), outcome(1, 0, player(A), { kind: 'unknown' })));
  });

  test('player picks voided by admin ruling: exact, total and result still count, no bonus', () => {
    const r = v2(pred(1, 0, player(A), player(B)), outcome(1, 0, { kind: 'unknown' }, { kind: 'unknown' }), { playerCategoriesVoid: true });
    assert.deepEqual(parts(r), [5, 0, 0, 1, 1, 0, 7]);
  });

  test('deterministic: scoring the same prediction twice gives identical breakdowns', () => {
    const p = pred(2, 1, player(A), player(C));
    const o = outcome(2, 1, player(A), player(B));
    assert.deepEqual(v2(p, o), v2(p, o));
  });
});

describe('The original rules are untouched', () => {
  test('without asking for version 2 the original 15-point rules apply (no exact-score category)', () => {
    const r = scorePrediction(pred(2, 1, player(A), player(B)), outcome(2, 1, player(A), player(B)));
    assert.equal(r.rulesVersion, 1);
    assert.equal(r.exactScorePoints, null);
    assert.equal(r.totalPoints, 15);
  });
});
