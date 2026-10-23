import Link from 'next/link';
import type { Fixture, DisplayStatus } from '@/lib/fixtures';
import { formatKickoff, timeUntil, ukZoneLabel } from '@/lib/time';
import { StatusChip } from './bits';

/** The headline fixture panel: a floodlit scoreboard showing the member's own prediction (or blanks). */
export function Scoreboard({
  fixture, status, prediction, result, cta,
}: {
  fixture: Fixture;
  status: DisplayStatus;
  prediction?: { arsenalGoals: number; opponentGoals: number } | null;
  result?: { arsenalGoals: number; opponentGoals: number } | null;
  cta?: { href: string; label: string } | null;
}) {
  const home = fixture.venue !== 'A';
  const shown = result ?? prediction ?? null;
  const ars = shown?.arsenalGoals;
  const opp = shown?.opponentGoals;
  const left = home ? { name: 'Arsenal', score: ars } : { name: fixture.opponent, score: opp };
  const right = home ? { name: fixture.opponent, score: opp } : { name: 'Arsenal', score: ars };
  const caption = result ? 'Full time' : prediction ? 'Your prediction' : 'No prediction yet';
  const open = status === 'open' || status === 'submitted';
  return (
    <section className="scoreboard reveal" aria-label={`${left.name} v ${right.name}`}>
      <div className="sb-meta">
        <span>{fixture.competitionName}{fixture.round ? `, ${fixture.round}` : ''}</span>
        <StatusChip status={status} />
      </div>
      <div className="sb-teams">
        <div className="sb-team">{left.name}<small>{home ? 'Home' : 'Away'}</small></div>
        <div>
          <div className="sb-digits" aria-label={caption}>
            <span className={`digit${left.score == null ? ' blank' : ''}`}>{left.score ?? '?'}</span>
            <span className="sb-dash">–</span>
            <span className={`digit${right.score == null ? ' blank' : ''}`}>{right.score ?? '?'}</span>
          </div>
          <div className="small" style={{ textAlign: 'center', marginTop: 8, color: 'rgba(255,255,255,.75)' }}>{caption}</div>
        </div>
        <div className="sb-team right">{right.name}<small>{home ? 'Away' : 'Home'}</small></div>
      </div>
      <div className="sb-foot">
        <div className="countdown">
          {open ? (
            <>Predictions close in <strong>{timeUntil(fixture.kickoffAt)}</strong><br /><span className="small">Kick-off {formatKickoff(fixture.kickoffAt)} {ukZoneLabel(fixture.kickoffAt)}</span></>
          ) : (
            <>Kick-off {formatKickoff(fixture.kickoffAt)} {ukZoneLabel(fixture.kickoffAt)}</>
          )}
        </div>
        {cta && <Link className="btn" href={cta.href}>{cta.label}</Link>}
      </div>
    </section>
  );
}
