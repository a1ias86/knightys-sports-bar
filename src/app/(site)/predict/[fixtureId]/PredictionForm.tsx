'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { predictionAction, type FormState } from '@/app/actions';

interface Initial { arsenalGoals: number; opponentGoals: number; scorer: string | null; assister: string | null }

const NAME_OK = /^[\p{L}\p{M}][\p{L}\p{M}'’ .\-–]*$/u;

function countdown(ms: number) {
  if (ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function PredictionForm({ fixtureId, opponent, initial, kickoffAt, serverNow }: {
  fixtureId: string; opponent: string; initial: Initial | null; kickoffAt: string; serverNow: number;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(predictionAction, null);
  const [ag, setAg] = useState(initial ? String(initial.arsenalGoals) : '');
  const [og, setOg] = useState(initial ? String(initial.opponentGoals) : '');
  const [scorer, setScorer] = useState(initial?.scorer ?? '');
  const [scorerNone, setScorerNone] = useState(initial ? initial.scorer === null : false);
  const [assister, setAssister] = useState(initial?.assister ?? '');
  const [assisterNone, setAssisterNone] = useState(initial ? initial.assister === null : false);
  const [confirming, setConfirming] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Lock the page at kick-off using the SERVER's clock (corrected for the device clock).
  // The server re-checks on every save, so this is only for clarity.
  const offset = useRef(0);
  const [msLeft, setMsLeft] = useState(() => new Date(kickoffAt).getTime() - serverNow);
  useEffect(() => {
    offset.current = serverNow - Date.now();
    const tick = () => setMsLeft(new Date(kickoffAt).getTime() - (Date.now() + offset.current));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [kickoffAt, serverNow]);
  const locked = msLeft <= 0;

  const nilNil = ag === '0' && og === '0';
  // "No goalscorer" only counts while the prediction is 0-0.
  const noScorer = scorerNone && nilNil;

  function review() {
    const valid = (v: string) => /^\d{1,2}$/.test(v) && Number(v) <= 20;
    if (!valid(ag) || !valid(og)) return setLocalError('Enter both scores as whole numbers (0 to 20).');
    if (!noScorer && !scorer.trim()) return setLocalError('Type your first goalscorer, or tick "No goalscorer" for a 0–0.');
    if (!noScorer && !NAME_OK.test(scorer.trim())) return setLocalError('The goalscorer name can only use letters, spaces, apostrophes and hyphens.');
    if (!assisterNone && !assister.trim()) return setLocalError('Type your first assister, or tick "No assister".');
    if (!assisterNone && !NAME_OK.test(assister.trim())) return setLocalError('The assister name can only use letters, spaces, apostrophes and hyphens.');
    setLocalError(null);
    setConfirming(true);
  }

  if (locked) {
    return (
      <section className="panel" role="status">
        <h2>Predictions are locked</h2>
        <p>It&rsquo;s kick-off, so predictions for this match can no longer be changed.{initial ? ' Your last saved prediction stands.' : ''}</p>
        <a className="btn btn-ghost" href={`/matches/${fixtureId}`}>Go to the match centre</a>
      </section>
    );
  }

  return (
    <form action={action} className="panel">
      <input type="hidden" name="fixtureId" value={fixtureId} />
      <input type="hidden" name="arsenalGoals" value={ag} />
      <input type="hidden" name="opponentGoals" value={og} />
      <input type="hidden" name="scorer" value={scorer} />
      <input type="hidden" name="assister" value={assister} />
      {noScorer && <input type="hidden" name="scorerNone" value="on" />}
      {assisterNone && <input type="hidden" name="assisterNone" value="on" />}

      <p className="countdown" style={{ marginTop: 0 }} aria-live="polite">
        Locks at kick-off: <strong>{countdown(msLeft)}</strong> left. You can change your prediction as often as you like until then.
      </p>
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

          <div className="field">
            <label htmlFor="scorer-name"><span className="pick-title">First goalscorer</span></label>
            <p className="hint" style={{ marginTop: 0 }}>The first player to score for either side (own goals don&rsquo;t count). A surname is fine, e.g. Saka.</p>
            <input
              id="scorer-name" type="text" value={scorer} maxLength={60} autoComplete="off" spellCheck={false}
              placeholder="e.g. Saka" disabled={noScorer} onChange={(e) => setScorer(e.target.value)}
            />
            <label className="checkbox" style={{ marginTop: 10, opacity: nilNil ? 1 : 0.5 }}>
              <input type="checkbox" checked={noScorer} disabled={!nilNil} onChange={(e) => setScorerNone(e.target.checked)} />
              No goalscorer {nilNil ? '' : '(only with a 0–0 prediction)'}
            </label>
          </div>

          <div className="field" style={{ marginTop: 24 }}>
            <label htmlFor="assister-name"><span className="pick-title">First assister</span></label>
            <p className="hint" style={{ marginTop: 0 }}>The first player credited with an assist. Can be the same player as your goalscorer.</p>
            <input
              id="assister-name" type="text" value={assister} maxLength={60} autoComplete="off" spellCheck={false}
              placeholder="e.g. Ødegaard" disabled={assisterNone} onChange={(e) => setAssister(e.target.value)}
            />
            <label className="checkbox" style={{ marginTop: 10 }}>
              <input type="checkbox" checked={assisterNone} onChange={(e) => setAssisterNone(e.target.checked)} />
              No assister (I think no goal will have an assist)
            </label>
          </div>

          <div className="row" style={{ marginTop: 28 }}>
            <button type="button" className="btn btn-red" onClick={review}>Review prediction</button>
          </div>
        </>
      ) : (
        <>
          <h2>Check your prediction</h2>
          <dl className="confirm-list">
            <dt>Score</dt><dd>Arsenal {ag}–{og} {opponent}</dd>
            <dt>First goalscorer</dt><dd>{noScorer ? 'No goalscorer' : scorer.trim()}</dd>
            <dt>First assister</dt><dd>{assisterNone ? 'No assister' : assister.trim()}</dd>
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
