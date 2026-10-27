# Scoring rules

All points come from one function: `scorePrediction` in `src/lib/scoring.ts`. Manual results, the data feed and the explicit rescore all call it. It has **two rule versions**.

## Current rules: 20-point (version 2)

| Category | Points |
|---|---:|
| Correct exact scoreline | 5 |
| Correct first goalscorer | 5 |
| Correct first assister | 5 |
| Goalscorer pick made the first assist instead (crossover) | 3, replacing the 5 |
| Assister pick scored the first goal instead (crossover) | 3, replacing the 5 |
| Correct combined total of goals | 1 |
| Correct result (Arsenal win / draw / Arsenal loss) | 1 |
| Full house: exact score + scorer 5 + assister 5 + total + result | +3 (max **20**) |

Categories are scored independently: an exact score also earns the total-goals and result points. Crossovers never count towards the full house.

## Original rules: 15-point (version 1)

The same as above but with no exact-score category, and a full house of scorer 5 + assister 5 + result + total (max 15). **Every match scored before the 20-point rules keeps these rules and its stored points.** Version 1 is the engine's default, so the new rules can't be applied by accident.

## Which matches get which rules (protecting the existing league)

Each match's scoring state is derived from records that already existed: stored points (`fixture_scores`) and the permanent scoring history (`scoring_runs`). No dates, scores or flags are used, and existing rows were not updated to add this.

| State | How it's recognised | What happens |
|---|---|---|
| Never scored | no stored points, no successful scoring run | Scored once, automatically, with the **20-point** rules when its result is first published |
| Scored | has stored points (or a successful run and is finalised) | **Protected.** Never rescored automatically. |
| Withdrawn | was scored, points later withdrawn by an admin | **Protected.** Comes back only via "Rescore this match", with its original rules |
| Needs checking | inconsistent records, e.g. finalised with no scoring history, or points on a match not marked finalised | **Protected, flagged** on the admin overview; left untouched |

A match that already has predictions but has never been scored counts as "never scored": it uses the 20-point rules when its result is first published.

**Nothing automatic changes a protected match's points:** saving or correcting its result, Verify, the name-check confirmation, the "no reliable data" ruling, admin prediction overrides, the data feed and the scheduled fixture sync all leave them as they are. The only ways are explicit, single-match admin actions, both recorded in the audit log with a reason:
- **Withdraw points**: takes that match's points out of the table.
- **Rescore this match**: needs a reason and typing RESCORE. It recalculates that one match from its stored result with the rules it was originally scored with, and logs every member's change.

There is no "recalculate every match" button.

Each stored point row records `rules_version` (2 for new matches; blank for matches scored under the original rules) and `exact_score_points`.

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

## Entering official results (admin)

The official first goalscorer and first assister are typed as names (no dropdowns), and each has one of four explicit states. Nothing is pre-selected for a new result, and a blank field is never treated as "none".

| State | Meaning | Scoring |
|---|---|---|
| Named player | the name typed | scored by name match |
| No qualifying goal / Confirmed: no credited assist | the confirmed answer is "nobody" | "No goalscorer" / "No assister" picks win |
| Unknown | the information isn't available | match held, nothing scored |
| Not entered yet | to be filled in later | match held, nothing scored |

**Members type their picks** (no player list). Each typed pick is matched only against the two official names for that match (`matchPickToOfficial` in `src/lib/names.ts`):

1. **Exact** after ignoring capitals, extra spaces, curly v straight apostrophes and dash styles.
2. **Close:** accents/punctuation ignored (`Odegaard` = `Martin Ødegaard`), whole words either way round (`Saka` = `Bukayo Saka`), or a small typo in a longer word (1 letter from 5 letters, 2 from 9: `Havetz` = `Kai Havertz`). Words under 5 letters must be spelt right (`Sakka` ≠ `Saka`).
3. An exact match always beats a close one. A pick that is a close match for **both** official players (e.g. `Gabriel` when Martinelli scored and Magalhães assisted) holds the match for an admin, who either sets that member's pick to the full name (admin override, logged) or scores those picks as no match.

**Substitutions:** the admin can record that the official first goalscorer or first assister "came on as a substitute for" another player. Picks of the replaced player then count as the substitute, for the 5-point award and the 3-point crossover. Otherwise picks never change after kick-off.

**Kick-off lock:** members can edit as often as they like until the stored kick-off time. The server rejects any save at or after kick-off (database clock), and the prediction page switches to "locked" at kick-off using the server's time.

**Stored breakdown:** every member's row in `fixture_scores` records the points per category plus a snapshot of their predicted score and picks and the official score and names used, so any award can be audited later.

## Note on the original brief's examples A and B

The brief's Examples A and B both predict Arsenal 3–1 against an actual 2–2 and award the result point. Under the written result rule, 3–1 (Arsenal win) and 2–2 (draw) are different results, so the engine does **not** award it: Example A scores 11 (not 15) and Example B scores 1 (not 2). Both readings are covered by tests in `tests/unit/scoring.test.ts`. (This applies to both rule versions.)

## Persistence guarantees

- One prediction per member per fixture (unique constraint); edits update the same row and keep the first submission time.
- Scoring runs in one transaction with the fixture row locked; a failure leaves the table exactly as it was. Repeating it never adds points: automatic paths do nothing once a match is scored, and an explicit rescore replaces that one match's points.
- Opening balances (`opening_balances`) and manual adjustments (`point_adjustments`) are separate tables that scoring never touches.
- `member_totals` view: total = opening + finalised match points + adjustments. Admin → Points shows a live reconciliation check.
