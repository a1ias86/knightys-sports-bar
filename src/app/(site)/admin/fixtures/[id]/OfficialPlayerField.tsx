import type { FirstKind } from '@/lib/results';

/**
 * Official first goalscorer / first assister entry. Four explicit states, nothing pre-selected for a new
 * result, so "no assister", "unknown" and "not entered yet" can never be confused with each other.
 */
export function OfficialPlayerField({ role, legend, hint, kind, name, listId, noneLabel }: {
  role: 'scorer' | 'assister';
  legend: string;
  hint: string;
  kind?: FirstKind;
  name?: string | null;
  listId: string;
  noneLabel: string;
}) {
  const state = kind === 'player' ? 'named' : kind;
  const id = (s: string) => `${role}-${s}`;
  return (
    <fieldset className="field official-field">
      <legend>{legend}</legend>
      <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>{hint}</div>
      <div className="official-named">
        <label className="checkbox" htmlFor={id('named')}>
          <input type="radio" id={id('named')} name={`${role}State`} value="named" defaultChecked={state === 'named'} required />
          Named player
        </label>
        <input
          type="text" name={`${role}Name`} list={listId} defaultValue={name ?? ''} maxLength={60}
          autoComplete="off" spellCheck={false} aria-label={`${legend} name`} placeholder="e.g. Bukayo Saka"
        />
      </div>
      <label className="checkbox" htmlFor={id('none')}>
        <input type="radio" id={id('none')} name={`${role}State`} value="none" defaultChecked={state === 'none'} />
        {noneLabel}
      </label>
      <label className="checkbox" htmlFor={id('unknown')}>
        <input type="radio" id={id('unknown')} name={`${role}State`} value="unknown" defaultChecked={state === 'unknown'} />
        Unknown: the information isn&rsquo;t available
      </label>
      <label className="checkbox" htmlFor={id('pending')}>
        <input type="radio" id={id('pending')} name={`${role}State`} value="pending" defaultChecked={state === 'pending'} />
        Not entered yet: I&rsquo;ll add it later
      </label>
    </fieldset>
  );
}
