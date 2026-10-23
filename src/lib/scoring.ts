/**
 * Knighty's Sports Bar: the single, centralised scoring engine.
 *
 * Pure functions only: no database, no clock, no I/O. Every route that awards points
 * (manual results, automatic results, recalculation) goes through `scorePrediction`.
 *
 * Competition rules (beta):
 *  - Correct first goalscorer ............................ 5
 *  - Correct first assister .............................. 5
 *  - Picked goalscorer instead made the first assist ..... 3 (replaces the 5, never added to it)
 *  - Picked assister instead scored the first goal ....... 3 (replaces the 5, never added to it)
 *  - Correct result (Arsenal win / draw / loss) .......... 1
 *  - Correct combined total of goals ..................... 1
 *  - Full house (all four primary categories correct) .... +3  (max 15)
 *
 * Event definitions (documented competition treatment):
 *  - A "qualifying goal" is any goal except an own goal. Own goals are never credited to
 *    a named first-goalscorer pick.
 *  - The first goalscorer is the scorer of the first qualifying goal, by either team.
 *    If an own goal is the first goal of the match, the first qualifying goal is the next
 *    non-own goal; the fixture is flagged for an admin to confirm before finalising.
 *  - The first assister is the first player credited with an assist on a qualifying goal,
 *    in match order. Unassisted goals are skipped. The first assist may therefore come on a
 *    later goal than the first goal, and the same player can be both first scorer and
 *    first assister.
 *  - "No goalscorer" is correct when the match has no qualifying goal.
 *    "No assister" is correct when no qualifying goal has a credited assist.
 *  - Crossover 3-point awards do not count towards the full house.
 *  - If the data needed to settle a category is unknown, the outcome is not scoreable and
 *    the fixture waits for verification. Points are never guessed.
 */

export type Side = 'arsenal' | 'opponent';

export type AssistInfo =
  | { status: 'credited'; playerId: string }
  | { status: 'unassisted' }
  | { status: 'unknown' };

export interface GoalEvent {
  /** 1-based chronological order. */
  seq: number;
  type: 'goal' | 'own_goal';
  /** Team credited with the goal. */
  side: Side;
  /** Player who scored (for own goals: the player who put it in their own net). Null = not known. */
  scorerId: string | null;
  /** Ignored for own goals. */
  assist: AssistInfo;
  /** Used to drop duplicate events from a feed. */
  dedupeKey?: string;
}

export type FirstPlayer = { kind: 'player'; id: string } | { kind: 'none' } | { kind: 'unknown' };

export interface MatchOutcome {
  arsenalGoals: number;
  opponentGoals: number;
  firstScorer: FirstPlayer;
  firstAssister: FirstPlayer;
  /** True when the first goal of the match was an own goal (fixture needs admin confirmation). */
  firstGoalWasOwnGoal: boolean;
}

export type Pick = { kind: 'player'; id: string } | { kind: 'none' };

export interface PredictionInput {
  arsenalGoals: number;
  opponentGoals: number;
  scorer: Pick;
  assister: Pick;
}

export type PlayerAwardOutcome = 'correct' | 'crossover' | 'incorrect' | 'void';

export interface ScoreOptions {
  /**
   * Admin decision when reliable scorer/assister data does not exist: both player categories
   * score 0 for every member (no full house possible); result and total goals still count.
   */
  playerCategoriesVoid?: boolean;
}

export interface ScoreBreakdown {
  scorerPoints: number;
  scorerOutcome: PlayerAwardOutcome;
  assisterPoints: number;
  assisterOutcome: PlayerAwardOutcome;
  resultPoints: number;
  totalGoalsPoints: number;
  bonusPoints: number;
  totalPoints: number;
}

export const POINTS = {
  scorer: 5,
  assister: 5,
  crossover: 3,
  result: 1,
  totalGoals: 1,
  fullHouseBonus: 3,
} as const;

export type ResultCategory = 'win' | 'draw' | 'loss';

export function resultCategory(arsenal: number, opponent: number): ResultCategory {
  if (arsenal > opponent) return 'win';
  if (arsenal < opponent) return 'loss';
  return 'draw';
}

function assertGoals(n: number, label: string) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`${label} must be a non-negative whole number`);
}

/** Remove duplicate feed events (same dedupe key, or same seq/type/side/scorer) and sort by seq. */
export function normaliseGoalEvents(events: GoalEvent[]): GoalEvent[] {
  const seen = new Set<string>();
  const out: GoalEvent[] = [];
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const key = e.dedupeKey ?? `${e.seq}|${e.type}|${e.side}|${e.scorerId ?? '?'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export interface DerivedOutcome {
  outcome: MatchOutcome;
  /** Human-readable reasons the outcome cannot be finalised automatically. Empty = scoreable. */
  issues: string[];
}

/**
 * Work out the first goalscorer / first assister from an ordered list of goal events.
 * Used for automatic feed data; manual results supply a MatchOutcome directly.
 */
export function deriveOutcome(arsenalGoals: number, opponentGoals: number, rawEvents: GoalEvent[]): DerivedOutcome {
  assertGoals(arsenalGoals, 'Arsenal goals');
  assertGoals(opponentGoals, 'Opponent goals');
  const events = normaliseGoalEvents(rawEvents);
  const issues: string[] = [];

  const arsenalEvents = events.filter((e) => e.side === 'arsenal').length;
  const opponentEvents = events.filter((e) => e.side === 'opponent').length;
  const complete = arsenalEvents === arsenalGoals && opponentEvents === opponentGoals;
  if (!complete) {
    issues.push(
      `Goal events (${arsenalEvents}-${opponentEvents}) do not match the final score (${arsenalGoals}-${opponentGoals}).`,
    );
  }

  let firstScorer: FirstPlayer = { kind: 'none' };
  let firstAssister: FirstPlayer = { kind: 'none' };
  let scorerSettled = false;
  let assisterSettled = false;

  for (const e of events) {
    if (e.type === 'own_goal') continue;
    if (!scorerSettled) {
      firstScorer = e.scorerId ? { kind: 'player', id: e.scorerId } : { kind: 'unknown' };
      scorerSettled = true;
      if (!e.scorerId) issues.push(`The scorer of the first qualifying goal is not known.`);
    }
    if (!assisterSettled) {
      if (e.assist.status === 'credited') {
        firstAssister = { kind: 'player', id: e.assist.playerId };
        assisterSettled = true;
      } else if (e.assist.status === 'unknown') {
        firstAssister = { kind: 'unknown' };
        assisterSettled = true;
        issues.push(`Assist information for goal ${e.seq} is missing.`);
      }
    }
    if (scorerSettled && assisterSettled) break;
  }

  // If events are incomplete we cannot rule out an earlier (missing) goal or assist.
  if (!complete) {
    firstScorer = { kind: 'unknown' };
    firstAssister = { kind: 'unknown' };
  }

  const firstGoalWasOwnGoal = events.length > 0 && events[0].type === 'own_goal';
  if (firstGoalWasOwnGoal) issues.push('The first goal of the match was an own goal: confirm the first qualifying goal.');

  return {
    outcome: { arsenalGoals, opponentGoals, firstScorer, firstAssister, firstGoalWasOwnGoal },
    issues,
  };
}

/** Validate a manually entered / verified outcome. Returns a list of problems (empty = valid). */
export function validateOutcome(o: MatchOutcome): string[] {
  const errors: string[] = [];
  try {
    assertGoals(o.arsenalGoals, 'Arsenal goals');
    assertGoals(o.opponentGoals, 'Opponent goals');
  } catch (e) {
    errors.push((e as Error).message);
    return errors;
  }
  const total = o.arsenalGoals + o.opponentGoals;
  if (total === 0) {
    if (o.firstScorer.kind === 'player') errors.push('A 0-0 match cannot have a first goalscorer.');
    if (o.firstAssister.kind === 'player') errors.push('A 0-0 match cannot have a first assister.');
    if (o.firstGoalWasOwnGoal) errors.push('A 0-0 match cannot have an own goal.');
  } else if (o.firstScorer.kind === 'none' && !o.firstGoalWasOwnGoal) {
    errors.push('Goals were scored, so choose the first goalscorer (or mark the first goal as an own goal if every goal was an own goal).');
  }
  if (o.firstScorer.kind === 'none' && o.firstAssister.kind === 'player') {
    errors.push('There cannot be a credited assist when there was no qualifying goal.');
  }
  return errors;
}

export function isScoreable(o: MatchOutcome): boolean {
  return o.firstScorer.kind !== 'unknown' && o.firstAssister.kind !== 'unknown' && validateOutcome(o).length === 0;
}

function samePlayer(pick: Pick, actual: FirstPlayer): boolean {
  return pick.kind === 'player' && actual.kind === 'player' && pick.id === actual.id;
}

/** Score one member's prediction against a settled outcome. Throws if the outcome is not scoreable. */
export function scorePrediction(p: PredictionInput, o: MatchOutcome, opts: ScoreOptions = {}): ScoreBreakdown {
  const playerVoid = opts.playerCategoriesVoid === true;
  if (playerVoid) {
    assertGoals(o.arsenalGoals, 'Arsenal goals');
    assertGoals(o.opponentGoals, 'Opponent goals');
  } else if (!isScoreable(o)) {
    throw new Error('Match outcome is incomplete or invalid; it cannot be scored yet.');
  }
  assertGoals(p.arsenalGoals, 'Predicted Arsenal goals');
  assertGoals(p.opponentGoals, 'Predicted opponent goals');

  // First goalscorer pick
  let scorerPoints = 0;
  let scorerOutcome: PlayerAwardOutcome = 'incorrect';
  if (p.scorer.kind === 'none') {
    if (o.firstScorer.kind === 'none') { scorerPoints = POINTS.scorer; scorerOutcome = 'correct'; }
  } else if (samePlayer(p.scorer, o.firstScorer)) {
    scorerPoints = POINTS.scorer; scorerOutcome = 'correct';
  } else if (samePlayer(p.scorer, o.firstAssister)) {
    scorerPoints = POINTS.crossover; scorerOutcome = 'crossover';
  }

  // First assister pick
  let assisterPoints = 0;
  let assisterOutcome: PlayerAwardOutcome = 'incorrect';
  if (playerVoid) {
    scorerPoints = 0; scorerOutcome = 'void'; assisterOutcome = 'void';
  } else if (p.assister.kind === 'none') {
    if (o.firstAssister.kind === 'none') { assisterPoints = POINTS.assister; assisterOutcome = 'correct'; }
  } else if (samePlayer(p.assister, o.firstAssister)) {
    assisterPoints = POINTS.assister; assisterOutcome = 'correct';
  } else if (samePlayer(p.assister, o.firstScorer)) {
    assisterPoints = POINTS.crossover; assisterOutcome = 'crossover';
  }

  const resultCorrect =
    resultCategory(p.arsenalGoals, p.opponentGoals) === resultCategory(o.arsenalGoals, o.opponentGoals);
  const totalCorrect = p.arsenalGoals + p.opponentGoals === o.arsenalGoals + o.opponentGoals;
  const resultPoints = resultCorrect ? POINTS.result : 0;
  const totalGoalsPoints = totalCorrect ? POINTS.totalGoals : 0;

  const fullHouse = scorerOutcome === 'correct' && assisterOutcome === 'correct' && resultCorrect && totalCorrect;
  const bonusPoints = fullHouse ? POINTS.fullHouseBonus : 0;

  return {
    scorerPoints,
    scorerOutcome,
    assisterPoints,
    assisterOutcome,
    resultPoints,
    totalGoalsPoints,
    bonusPoints,
    totalPoints: scorerPoints + assisterPoints + resultPoints + totalGoalsPoints + bonusPoints,
  };
}

/** Competition ranking ("1224"): tied totals share a position; the next position skips. */
export function competitionRank<T>(rows: T[], points: (r: T) => number): Array<T & { position: number }> {
  const sorted = [...rows].sort((a, b) => points(b) - points(a));
  let lastPoints: number | null = null;
  let lastPos = 0;
  return sorted.map((r, i) => {
    const pts = points(r);
    const position = lastPoints !== null && pts === lastPoints ? lastPos : i + 1;
    lastPoints = pts;
    lastPos = position;
    return { ...r, position };
  });
}
