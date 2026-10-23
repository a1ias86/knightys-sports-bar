import { FIXTURE_STATUSES, type Fixture } from '@/lib/fixtures';
import { utcToUkInputs } from '@/lib/time';

export function FixtureFields({ competitions, fixture }: { competitions: { code: string; name: string; enabled: boolean }[]; fixture?: Fixture }) {
  const when = fixture ? utcToUkInputs(new Date(fixture.kickoffAt)) : { date: '', time: '15:00' };
  return (
    <div className="form-grid">
      <div className="field">
        <label htmlFor="opponent">Opponent</label>
        <input id="opponent" name="opponent" type="text" required defaultValue={fixture?.opponent} maxLength={60} />
      </div>
      <div className="field">
        <label htmlFor="venue">Venue</label>
        <select id="venue" name="venue" defaultValue={fixture?.venue ?? 'H'}>
          <option value="H">Home (Emirates)</option>
          <option value="A">Away</option>
          <option value="N">Neutral</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="competition">Competition</label>
        <select id="competition" name="competition" defaultValue={fixture?.competitionCode ?? 'PL'}>
          {competitions.map((c) => <option key={c.code} value={c.code}>{c.name}{c.enabled ? '' : ' (not in league)'}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="date">Date (UK)</label>
        <input id="date" name="date" type="date" required defaultValue={when.date} />
      </div>
      <div className="field">
        <label htmlFor="time">Kick-off (UK time)</label>
        <input id="time" name="time" type="time" required defaultValue={when.time} />
        <div className="hint">Predictions lock at this time. GMT/BST is handled for you.</div>
      </div>
      <div className="field">
        <label htmlFor="status">Status</label>
        <select id="status" name="status" defaultValue={fixture?.status ?? 'scheduled'}>
          {FIXTURE_STATUSES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="round">Round (cups only)</label>
        <input id="round" name="round" type="text" defaultValue={fixture?.round} maxLength={40} placeholder="e.g. Fourth round" />
      </div>
      <div className="field">
        <label htmlFor="season">Season</label>
        <input id="season" name="season" type="text" defaultValue={fixture?.season} placeholder="Worked out from the date" pattern="\d{4}-\d{2}" />
      </div>
    </div>
  );
}
