# Deployment: GitHub → Vercel → Supabase

## 1. Database recommendation: Supabase PostgreSQL

| | Supabase (recommended) | Neon / other managed Postgres | Redis / key-value store |
|---|---|---|---|
| Cost for 32 members | Free plan is enough for data volume (500 MB; this app uses a few MB a season). Pro $25/month adds backups. | Comparable free tiers | Not suitable |
| Durability & integrity | Full Postgres: constraints, transactions, foreign keys | Same | No relational constraints or multi-row transactions for safe rescoring |
| Vercel compatibility | Built-in pooler (port 6543) designed for serverless | Serverless driver / pooler | n/a |
| Admin & tooling | Table editor, SQL editor, logs | SQL console | n/a |
| Backups | Free: none managed. Pro: daily, 7-day retention; point-in-time recovery is a paid add-on | Varies by plan | n/a |
| Migrations | Plain SQL files in this repo | Same | n/a |

**Why Supabase:** it's your stated preference, works with plain Postgres (no lock-in: the app uses a standard connection string, so moving to Neon later is a `DATABASE_URL` change), has a London region, and its dashboard is the easiest for a non-specialist to inspect data. The app only uses Supabase as a database; it doesn't use Supabase Auth or the client-side API, which is why RLS is enabled with no policies (nothing in the browser talks to the database).

**Caveat on the free plan:** free projects pause after about a week of inactivity and must be restored from the dashboard. During the season the daily cron job and members' visits keep it active; over the summer break it may pause. The free plan also has **no managed backups**, so use the app's export (Admin → Overview → Download backup) weekly, or upgrade to Pro ($25/month) for daily backups. Confirm current terms at supabase.com/pricing.

## 2. Create the databases

Create **two** Supabase projects (the free plan allows two): `knightys-prod` and `knightys-preview`. Region: **London (eu-west-2)**.

For each, from **Project Settings → Database → Connection string**:
- **Transaction pooler** URI (port 6543) → `DATABASE_URL`
- **Session pooler** URI (port 5432) → `DIRECT_URL`

Then, from your computer with the repository cloned:

```bash
npm install
DIRECT_URL="<prod session pooler URI>" npm run db:setup
DIRECT_URL="<preview session pooler URI>" npm run db:setup
```

(After this, the Vercel build applies new migrations automatically; see §6.)

## 3. GitHub

```bash
# in the project folder
git remote add origin https://github.com/<you>/knightys-sports-bar.git
git push -u origin main
```

Create the repository as **private** on github.com first (empty, no README). Work on feature branches (`git checkout -b feature/xyz`), open a pull request, check the preview, then merge to `main`.

## 4. Vercel

1. vercel.com → **Add New → Project** → import `knightys-sports-bar` from GitHub. Framework: Next.js (detected). Leave build settings: `vercel.json` sets the build command.
2. **Settings → Environment Variables**: add each variable below, choosing **Production** or **Preview** scope.
3. Deploy. Every push to a branch creates a Preview deployment; every merge to `main` deploys Production.
4. Open `https://<your-app>.vercel.app/setup`, enter `ADMIN_SETUP_TOKEN`, save Jon's and Knighty's PINs, then **delete `ADMIN_SETUP_TOKEN`** from Vercel and redeploy.
5. Log in as Jon or Knighty → Admin → Members & PINs → **Issue missing PINs** → copy the list and send each member theirs privately.

Changing an environment variable needs a redeploy (Deployments → ⋯ → Redeploy) to take effect.

## 5. Environment variables

| Variable | Production | Preview | Notes |
|---|---|---|---|
| `APP_ENV` | `production` | `preview` | |
| `DATABASE_URL` | prod transaction pooler (6543) | preview DB | Server only |
| `DIRECT_URL` | prod session pooler (5432) | preview DB | Used for migrations at build time |
| `PIN_PEPPER` | random 64 hex | different random 64 hex | `openssl rand -hex 32`. **Never change in production**: it invalidates every PIN |
| `ADMIN_SETUP_TOKEN` | random, then delete after setup | random | |
| `CRON_SECRET` | random 64 hex | random | Vercel Cron sends it automatically |
| `FOOTBALL_PROVIDER` | `none` (or `api-football` / `football-data`) | `none` | |
| `API_FOOTBALL_KEY` / `FOOTBALL_DATA_TOKEN` | if used | leave empty | |
| `ARSENAL_TEAM_ID` | `42` (API-Football) / `57` (football-data.org) | | |
| `FOOTBALL_SEASON` | `2026` | | Start year of the season |

Preview deployments point at the preview database, so testing never touches live competition data. Preview PINs are separate (different pepper and database).

## 6. Migrations

- Schema changes are new files in `db/migrations/` (`0002_...sql`). Never edit an applied migration.
- The Vercel build runs `tsx scripts/migrate.ts --if-configured && next build`, so a deployment applies pending migrations to *its* database (preview → preview DB, production → production DB) before building. If a migration fails, the build fails and the previous deployment keeps serving.
- The runner refuses `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DELETE FROM` unless the file is named `*.destructive.sql` **and** `ALLOW_DESTRUCTIVE_MIGRATIONS=1` is set for that one run. Take a backup first and run those by hand.

## 7. Scheduled jobs

`vercel.json` defines one cron: `/api/cron/daily` at 06:00 UTC (fixtures, squads, missed results).

**Vercel Hobby only allows daily cron jobs, with ±59 min timing.** That is enough for fixtures, but results would take up to a day. Two mitigations are built in:
- Whenever anyone loads a page, the app checks (cheaply) whether a finished match is waiting and, at most every 15 minutes, fetches it in the background.
- `/api/cron/matchday` (results + line-ups) is safe to call every 15 minutes: it does nothing unless a match is in its window. Either upgrade to **Vercel Pro** and add `{ "path": "/api/cron/matchday", "schedule": "*/15 * * * *" }` to `vercel.json`, or use a free external scheduler (e.g. cron-job.org) calling it with header `Authorization: Bearer <CRON_SECRET>`.

With `FOOTBALL_PROVIDER=none` the jobs just record "skipped".

## 8. Verifying a deployment

- `/api/health` returns `{"ok":true,"db":"ok"}`
- Log in as an admin; Admin → Points shows "Every member's total equals…"
- Table matches the opening standings (James 55 … Jake 1)

## 9. Recovering from a bad deployment

- **Code:** Vercel → Deployments → pick the last good one → **Promote to Production** (instant). Then fix forward on a branch.
- **Data mistake (wrong result, wrong adjustment):** correct it in the admin area; everything is audited and recalculation is safe.
- **Lost or corrupted database:** restore from Supabase backup (Pro), or create a new project, run `npm run db:migrate`, and import your latest JSON export (see below).

## 10. Backups

- **App export** (any plan): Admin → Overview → Download backup, or `DATABASE_URL=... npm run export`. JSON with members, opening balances, fixtures, predictions, results, scores, adjustments, settings and the audit log. PINs and hashes are excluded, so after a restore from export everyone needs new PINs (Issue missing PINs).
- **Full database dump:** `pg_dump "<session pooler URI>" -Fc -f knightys.dump` and `pg_restore -d "<new db URI>" knightys.dump`. This includes PIN hashes: keep it private.
- Supabase Pro: daily automatic backups, 7 days.

## 11. Recurring costs

| Item | Cost |
|---|---|
| Vercel Hobby | Free (personal, non-commercial use; daily crons only) |
| Vercel Pro (optional, frequent crons) | $20/month per member |
| Supabase Free | Free (2 projects, pauses after inactivity, no managed backups) |
| Supabase Pro (optional, backups) | $25/month |
| API-Football Pro (optional) | ~$19/month |
| GitHub private repo | Free |

Minimum to run the league: **£0** (manual results, free plans, weekly export).
