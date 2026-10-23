# Scoring rules

All points come from one function: `scorePrediction` in `src/lib/scoring.ts`. Manual results, automatic results and recalculations all call it.

| Category | Points |
|---|---:|
| Correct first goalscorer | 5 |
| Correct first assister | 5 |
| Goalscorer pick made the first assist instead (crossover) | 3, replacing the 5 |
| Assister pick scored the first goal instead (crossover) | 3, replacing the 5 |
| Correct result (Arsenal win / draw / Arsenal loss) | 1 |
| Correct combined total of goals | 1 |
| Full house: scorer 5 + assister 5 + result + total all correct | +3 (max 15) |

## Definitions used by the engine

- **Qualifying goal**: any goal except an own goal.
- **First goalscorer**: scorer of the first qualifying goal, either team. If the first goal of the match is an own goal, the next non-own goal decides it, and an automatically-imported result is held for an admin to confirm.
- **First assister**: the first player credited with an assist on a qualifying goal, in match order. Unassisted goals are skipped, so the first assist can come on a later goal than the first goal, and the same player can be both first scorer and first assister.
- **"No goalscorer"** pick: correct when there is no qualifying goal (0–0, or own goals only). Only allowed with a 0–0 score prediction.
- **"No assister"** pick: correct when no qualifying goal has a credited assist.
- **Crossovers** are evaluated per category, never stack with a 5, and never count towards the full house.
- **Unknown data** (missing scorer, missing assist information, events that don't add up to the final score) makes a match unscoreable. It waits for an admin; no points are guessed.
- **Admin ruling for unavailable data**: an admin can finalise with "player picks not scored". Goalscorer and assister score 0 for everyone; result and total goals still count. Recorded in the audit log and shown in the match centre.
- **Abandoned / cancelled** matches score nothing. **Postponed** matches close predictions and reopen when rescheduled.
- Picks are never changed after kick-off, whatever happens to the player.

## Note on the brief's examples A and B

The brief's Examples A and B both predict Arsenal 3–1 against an actual 2–2 and award the result point. Under the written result rule, 3–1 (Arsenal win) and 2–2 (draw) are different results, so the engine does **not** award it: Example A scores 11 (not 15) and Example B scores 1 (not 2). Both readings are covered by tests in `tests/unit/scoring.test.ts`. If the league wants a different rule, it is a one-line change in `scorePrediction` followed by **Admin → Points → Recalculate every scored match**.

## Persistence guarantees

- One prediction per member per fixture (unique constraint); edits update the same row and keep the first submission time.
- Scoring a fixture runs in one transaction with the fixture row locked: old awards for that fixture are deleted and replaced. Running it again produces identical totals.
- Opening balances (`opening_balances`) and manual adjustments (`point_adjustments`) are separate tables that scoring never touches.
- `member_totals` view: total = opening + finalised match points + adjustments. Admin → Points shows a live reconciliation check.
