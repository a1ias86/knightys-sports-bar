# Football data integrations

**Status: adapters written and unit-tested against the providers' documented response formats. Neither has been tested against the live API** (no API key was available during the build). Treat the first few matches as a trial: compare the feed with what happened and use the admin verification tools.

The app never depends on a provider. With `FOOTBALL_PROVIDER=none`, fixtures and results are entered by Jon or Knighty and everything else works the same.

## Options assessed (October 2026)

| | API-Football (api-sports.io) | football-data.org |
|---|---|---|
| Arsenal fixtures / PL results | Yes | Yes (free plan, scores delayed) |
| Goal events, scorers | Yes | Paid "Deep Data" plans only |
| Credited assists | Yes, but a missing assist is ambiguous (none vs not recorded) | Deep Data only |
| Starting line-ups, substitutions | Yes | Deep Data only |
| Live status | Yes | Paid "livescores" add-on |
| Free plan | 100 requests/day, limited seasons (the current season normally needs a paid plan) | 10 requests/min, ~12 competitions, no scorers/assists/line-ups |
| Paid entry point | Pro ~$19/month (7,500 requests/day) | Deep Data ~€29/month |

Sources: provider pricing pages as summarised at [getbruin.com: API-Football](https://getbruin.com/docs/ingestr/soccer-sources/api-football.html) and [getbruin.com: football-data.org](https://getbruin.com/docs/ingestr/soccer-sources/football-data-org.html). Check the providers' own pricing pages before subscribing.

### Recommendation

1. **Start with no provider** (manual mode). Adding ~38 PL fixtures by hand once and entering one result per week takes minutes.
2. If you want automation, **API-Football Pro (~$19/month)** is the only option here that covers fixtures, scorers, assists and line-ups in one plan. Set `FOOTBALL_PROVIDER=api-football`, `API_FOOTBALL_KEY`, `ARSENAL_TEAM_ID=42`, `FOOTBALL_SEASON=2026`.
3. football-data.org free (`FOOTBALL_PROVIDER=football-data`, `ARSENAL_TEAM_ID=57`) can import fixtures and final scores for free, but every match will still need an admin to enter the first goalscorer and assister.

## Safety behaviour

- A missing assist is treated as **unknown**, never as "unassisted" (except penalties and own goals). If the first assist is unknown, the match waits for an admin.
- If the goal events don't add up to the final score, nothing is scored automatically.
- An own goal as the first goal is always held for admin confirmation.
- An admin-entered result is never overwritten by the feed; differences are flagged on the admin overview.
- A finalised match is never un-scored because a later feed response is less complete.
- Provider corrections to a finalised match are applied, recalculated and logged as `result.feed_correction`.
- Requests are bounded: results are only fetched for matches between 100 minutes and 10 days after kick-off that still need data, at most 4–6 per run; line-ups only in the 90 minutes before kick-off.

## Adding another provider

Implement `FootballProvider` in `src/lib/providers/types.ts`, register it in `src/lib/providers/index.ts`, and add parsing tests like `tests/unit/providers.test.ts`.
