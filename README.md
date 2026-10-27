# Knighty's Sports Bar — Arsenal Men's Prediction League

A private prediction league for 32 Arsenal fans. Members log in with their name and a four-digit PIN, predict the score, first goalscorer and first assister for each Arsenal match, and climb a live table that continues from the league's existing standings. Jon and Knighty run it from a protected admin area.

**Beta 1.0.** Fully usable with no football data subscription: fixtures and results can be managed by hand. An automatic feed is an optional extra.

## What's in it

| Area | What it does |
|---|---|
| Login | Name dropdown + 4-digit PIN. Server-side checks, hashed PINs, lockouts, 30-day sessions (7 for admins). |
| Dashboard | Next fixture as a scoreboard, countdown to the deadline, your position and points, recent results, table preview. |
| Predictions | Score plus typed first goalscorer and first assister, confirmation step, editable until kick-off, locked on the server at kick-off. 20-point scoring (see docs/SCORING.md). |
| Table | Opening balances + match points + adjustments, competition ranking (1, 2, 2, 4), top-three podium, form and movement. |
| Hall of Fame | Public page of past season champions, managed by admins. |
| Match centre | Result, first scorer/assister, everyone's locked picks after kick-off with a points breakdown. |
| Admin | Members & PINs, fixtures, manual results, verification, recalculation, points adjustments, players, settings, feed status, audit log, JSON backup. |
| Automation | Provider adapter (API-Football or football-data.org), Vercel Cron daily job, frequent "matchday" endpoint, opportunistic result checks. |

## Stack

- **Next.js 16** (App Router, server actions) + React 19 + TypeScript, deployed on **Vercel**
- **PostgreSQL** on **Supabase** (any Postgres works), accessed with [`pg`](https://node-postgres.com) (node-postgres) through a small tagged-template helper in `src/lib/db.ts`: plain SQL, one query at a time per connection, which is what Supabase's transaction pooler needs. No ORM: the schema is small and the SQL is the clearest record of the rules.
- Plain SQL migrations in `db/migrations`, applied by `scripts/migrate.ts`
- Tests use Node's built-in test runner (`node:test`) via `tsx`: no test framework dependency
- Self-hosted fonts (Barlow / Barlow Condensed via Fontsource)

## Quick start (local)

Requires Node 20.9+ and a Postgres database.

```bash
npm install
cp .env.example .env.local        # fill in DATABASE_URL, DIRECT_URL, PIN_PEPPER, ADMIN_SETUP_TOKEN, CRON_SECRET
npm run db:setup                  # migrations + 32 members + opening balances (safe to re-run)
npm run dev                       # http://localhost:3000
```

Then open `/setup`, enter your `ADMIN_SETUP_TOKEN`, and note the PINs shown for Jon and Knighty. Log in as an admin and go to **Admin → Members & PINs → Issue missing PINs** to create everyone else's.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run lint` / `typecheck` | ESLint / TypeScript |
| `npm test` | Unit tests: scoring rules, name matching, result-form validation, UK time handling, provider parsing |
| `npm run test:db` | Database tests (needs `TEST_DATABASE_URL` pointing at a throwaway DB whose name contains "test"; it is wiped) |
| `npm run db:migrate` | Apply new migrations (refuses destructive SQL unless explicitly allowed) |
| `npm run db:seed` | Load members/opening balances (never overwrites existing data) |
| `npm run admin:setup` | CLI alternative to `/setup` |
| `npm run export` | JSON backup to `exports/` (no PINs or hashes) |
| `npm run league:snapshot` | Read-only baseline of the table and all protected records; `-- --compare <file>` checks nothing changed |

## Project layout

```
db/migrations/        SQL schema (tables, constraints, leaderboard view, RLS hardening)
db/seed.sql           32 members, Jon & Knighty as admins, opening balances, competitions
src/lib/scoring.ts    THE scoring engine (pure functions, fully unit-tested)
src/lib/results.ts    Persisting results, idempotent scoring, feed handling
src/lib/auth-core.ts  PIN login, lockouts, sessions
src/lib/sync.ts       Scheduled fixture/result/line-up/squad jobs
src/lib/providers/    Football data adapters (swap providers here)
src/app/              Pages, server actions, API routes (cron, export, health)
tests/unit, tests/db  Automated tests
docs/                 Deployment, security, scoring and integration notes
```

## Documentation

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — database choice, GitHub → Vercel workflow, environment variables, cron, backups, recovery, costs
- [docs/SCORING.md](docs/SCORING.md) — the exact rules and edge cases
- [docs/SECURITY.md](docs/SECURITY.md) — PIN limitations and safeguards
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) — football data providers and what has (not) been verified
