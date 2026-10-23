import Link from 'next/link';
import { requireMember } from '@/lib/session';
import { listFixtures, displayStatus, isPredictionOpen, splitFixtures } from '@/lib/fixtures';
import { sql } from '@/lib/db';
import { formatKickoff, ukZoneLabel } from '@/lib/time';
import { StatusChip, Scoreline, venueText } from '@/components/bits';

export const metadata = { title: 'Matches' };

export default async function MatchesPage() {
  const me = await requireMember();
  const [fixtures, mine, results] = await Promise.all([
    listFixtures({ limit: 120 }),
    sql<{ fixtureId: string }[]>`select fixture_id from predictions where member_id = ${me.id}`,
    sql<{ fixtureId: string; arsenalGoals: number; opponentGoals: number }[]>`select fixture_id, arsenal_goals, opponent_goals from match_results`,
  ]);
  const predicted = new Set(mine.map((m) => m.fixtureId));
  const res = new Map(results.map((r) => [r.fixtureId, r]));
  const { upcoming, past } = splitFixtures(fixtures);

  const Row = ({ f }: { f: (typeof fixtures)[number] }) => {
    const r = res.get(f.id);
    const st = displayStatus(f, predicted.has(f.id));
    return (
      <li>
        <div>
          <Link className="opp" href={`/matches/${f.id}`}>{venueText(f.venue, f.opponent)}</Link>
          <div className="meta">
            {f.competitionName} · {formatKickoff(f.kickoffAt)} {ukZoneLabel(f.kickoffAt)}
            {isPredictionOpen(f) && <> · deadline is kick-off</>}
            {' · '}{predicted.has(f.id) ? 'Prediction in' : 'No prediction'}
          </div>
        </div>
        <div className="side">
          {r && <Scoreline a={f.venue === 'A' ? r.opponentGoals : r.arsenalGoals} b={f.venue === 'A' ? r.arsenalGoals : r.opponentGoals} />}
          <StatusChip status={st} />
          {isPredictionOpen(f) && <Link className="btn btn-small" href={`/predict/${f.id}`}>{predicted.has(f.id) ? 'Edit' : 'Predict'}</Link>}
        </div>
      </li>
    );
  };

  return (
    <div className="stack">
      <h1>Matches</h1>
      <section className="panel">
        <h2>Upcoming</h2>
        {upcoming.length ? <ul className="fixture-list">{upcoming.map((f) => <Row key={f.id} f={f} />)}</ul> : <p className="muted">No upcoming fixtures have been added yet.</p>}
      </section>
      <section className="panel">
        <h2>Played</h2>
        {past.length ? <ul className="fixture-list">{past.map((f) => <Row key={f.id} f={f} />)}</ul> : <p className="muted">No matches played in the app yet.</p>}
      </section>
    </div>
  );
}
