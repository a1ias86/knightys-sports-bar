'use client';

import { useActionState, useState } from 'react';
import { predictionAction, type FormState } from '@/app/actions';
import { PlayerPicker, type PickerPlayer } from '@/components/PlayerPicker';

interface Initial { arsenalGoals: number; opponentGoals: number; scorer: string; assister: string }

export function PredictionForm({ fixtureId, opponent, players, initial, lineupOut }: {
  fixtureId: string; opponent: string; players: PickerPlayer[]; initial: Initial | null; lineupOut: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(predictionAction, null);
  const [ag, setAg] = useState(initial ? String(initial.arsenalGoals) : '');
  const [og, setOg] = useState(initial ? String(initial.opponentGoals) : '');
  const [scorer, setScorer] = useState(initial?.scorer ?? '');
  const [assister, setAssister] = useState(initial?.assister ?? '');
  const [confirming, setConfirming] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const nilNil = ag === '0' && og === '0';
  const nameOf = (id: string, noneLabel: string) => (id === 'none' ? noneLabel : players.find((p) => p.id === id)?.name ?? '');

  function review() {
    const valid = (v: string) => /^\d{1,2}$/.test(v) && Number(v) <= 20;
    if (!valid(ag) || !valid(og)) return setLocalError('Enter both scores as whole numbers (0 to 20).');
    if (!scorer) return setLocalError('Choose a first goalscorer.');
    if (scorer === 'none' && !nilNil) return setLocalError('"No goalscorer" only works with a 0–0 prediction.');
    if (!assister) return setLocalError('Choose a first assister.');
    setLocalError(null);
    setConfirming(true);
  }

  return (
    <form action={action} className="panel">
      <input type="hidden" name="fixtureId" value={fixtureId} />
      <input type="hidden" name="arsenalGoals" value={ag} />
      <input type="hidden" name="opponentGoals" value={og} />
      <input type="hidden" name="scorer" value={scorer} />
      <input type="hidden" name="assister" value={assister} />
      {(localError || state?.error) && <div className="alert alert-error" role="alert">{localError ?? state?.error}</div>}

      {!confirming ? (
        <>
          <h2>Score</h2>
          <div className="score-entry" style={{ marginBottom: 24 }}>
            <div>
              <label htmlFor="ag">Arsenal</label>
              <input id="ag" type="number" inputMode="numeric" min={0} max={20} step={1} value={ag} onChange={(e) => setAg(e.target.value)} required />
            </div>
            <span className="sb-dash" aria-hidden>–</span>
            <div>
              <label htmlFor="og">{opponent}</label>
              <input id="og" type="number" inputMode="numeric" min={0} max={20} step={1} value={og} onChange={(e) => setOg(e.target.value)} required />
            </div>
          </div>

          <h2>First goalscorer</h2>
          <p className="muted small">The first player to score a goal in the match, for either side. Own goals don&rsquo;t count.</p>
          <PlayerPicker
            name="scorer-picker" players={players} value={scorer} onChange={setScorer} lineupOut={lineupOut}
            noneLabel="No goalscorer (0–0)" noneEnabled={nilNil}
            noneHint={nilNil ? undefined : 'Only with a 0–0 prediction'}
          />

          <h2 style={{ marginTop: 28 }}>First assister</h2>
          <p className="muted small">The first player credited with an assist in the match. Can be the same player as your goalscorer.</p>
          <PlayerPicker
            name="assister-picker" players={players} value={assister} onChange={setAssister} lineupOut={lineupOut}
            noneLabel="No assister" noneEnabled
          />

          <div className="row" style={{ marginTop: 28 }}>
            <button type="button" className="btn btn-red" onClick={review}>Review prediction</button>
          </div>
        </>
      ) : (
        <>
          <h2>Check your prediction</h2>
          <dl className="confirm-list">
            <dt>Score</dt><dd>Arsenal {ag}–{og} {opponent}</dd>
            <dt>First goalscorer</dt><dd>{nameOf(scorer, 'No goalscorer')}</dd>
            <dt>First assister</dt><dd>{nameOf(assister, 'No assister')}</dd>
          </dl>
          <div className="row">
            <button type="submit" className="btn btn-red" disabled={pending}>{pending ? 'Saving…' : initial ? 'Save changes' : 'Save prediction'}</button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)} disabled={pending}>Change something</button>
          </div>
        </>
      )}
    </form>
  );
}
