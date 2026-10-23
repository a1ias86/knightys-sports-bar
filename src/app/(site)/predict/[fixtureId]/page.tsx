import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireMember } from '@/lib/session';
import { getFixture, isPredictionOpen, playersForFixture, hasLineup, displayStatus } from '@/lib/fixtures';
import { getPrediction } from '@/lib/predictions';
import { formatKickoff, formatDateTime, ukZoneLabel } from '@/lib/time';
import { Alert, StatusChip, venueText } from '@/components/bits';
import { PredictionForm } from './PredictionForm';

export const metadata = { title: 'Your prediction' };

export default async function PredictPage({ params, searchParams }: { params: Promise<{ fixtureId: string }>; searchParams: Promise<{ saved?: string }> }) {
  const me = await requireMember();
  const { fixtureId } = await params;
  const { saved } = await searchParams;
  const fixture = await getFixture(fixtureId);
  if (!fixture || !fixture.competitionEnabled) notFound();
  const [prediction, players, lineupOut] = await Promise.all([
    getPrediction(fixture.id, me.id),
    playersForFixture(fixture),
    hasLineup(fixture.id),
  ]);
  const open = isPredictionOpen(fixture);
  const status = displayStatus(fixture, !!prediction);
  const pickedNotStarting = lineupOut && prediction
    ? [prediction.scorerPlayerId, prediction.assisterPlayerId].filter((id) => id && players.find((p) => p.id === id)?.lineupRole !== 'starter')
    : [];

  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <div>
        <p className="muted" style={{ marginBottom: 6 }}><Link href="/">Home</Link></p>
        <h1>{venueText(fixture.venue, fixture.opponent)}</h1>
        <div className="row">
          <StatusChip status={status} />
          <span className="muted">{fixture.competitionName} &middot; Kick-off {formatKickoff(fixture.kickoffAt)} {ukZoneLabel(fixture.kickoffAt)}</span>
        </div>
      </div>

      {saved && (
        <Alert kind="ok">
          {saved === 'new' ? 'Prediction saved.' : 'Prediction updated.'} You can change it until kick-off.
        </Alert>
      )}
      {pickedNotStarting.length > 0 && open && (
        <Alert kind="warn">Line-ups are out and one of your picks isn&rsquo;t in the starting XI. You can swap them before kick-off.</Alert>
      )}

      {!open ? (
        <section className="panel">
          <h2>Predictions are closed</h2>
          {prediction ? (
            <>
              <p>Your locked prediction:</p>
              <dl className="confirm-list">
                <dt>Score</dt><dd>Arsenal {prediction.arsenalGoals}–{prediction.opponentGoals} {fixture.opponent}</dd>
                <dt>First goalscorer</dt><dd>{prediction.scorerNone ? 'No goalscorer' : prediction.scorerName}</dd>
                <dt>First assister</dt><dd>{prediction.assisterNone ? 'No assister' : prediction.assisterName}</dd>
                <dt>Saved</dt><dd>{formatDateTime(prediction.updatedAt)}</dd>
              </dl>
            </>
          ) : (
            <p>You didn&rsquo;t make a prediction for this match.</p>
          )}
          <Link className="btn btn-ghost" href={`/matches/${fixture.id}`}>Go to the match centre</Link>
        </section>
      ) : players.length === 0 ? (
        <section className="panel">
          <h2>Player list not ready</h2>
          <p>There are no players loaded for this match yet, so picks can&rsquo;t be made. Jon or Knighty can add them in Admin → Players.</p>
        </section>
      ) : (
        <PredictionForm
          fixtureId={fixture.id}
          opponent={fixture.opponent}
          lineupOut={lineupOut}
          players={players.map((p) => ({ id: p.id, name: p.name, team: p.isArsenal ? 'Arsenal' : p.teamName, isArsenal: p.isArsenal, position: p.position, lineupRole: p.lineupRole }))}
          initial={prediction ? {
            arsenalGoals: prediction.arsenalGoals,
            opponentGoals: prediction.opponentGoals,
            scorer: prediction.scorerNone ? 'none' : prediction.scorerPlayerId!,
            assister: prediction.assisterNone ? 'none' : prediction.assisterPlayerId!,
          } : null}
        />
      )}
    </div>
  );
}
