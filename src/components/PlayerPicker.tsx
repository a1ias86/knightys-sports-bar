'use client';

import { useMemo, useState } from 'react';

export interface PickerPlayer {
  id: string;
  name: string;
  team: string;
  isArsenal: boolean;
  position: string | null;
  lineupRole: 'starter' | 'substitute' | null;
}

/** Searchable single-choice player list (radio buttons, so it works with keyboards and screen readers). */
export function PlayerPicker({ name, players, value, onChange, noneLabel, noneEnabled, noneHint, lineupOut }: {
  name: string;
  players: PickerPlayer[];
  value: string;
  onChange: (v: string) => void;
  noneLabel: string;
  noneEnabled: boolean;
  noneHint?: string;
  lineupOut: boolean;
}) {
  const [q, setQ] = useState('');
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const filtered = useMemo(() => {
    const term = fold(q.trim());
    return term ? players.filter((p) => fold(p.name).includes(term)) : players;
  }, [q, players]);
  const groups = [
    { label: 'Arsenal', list: filtered.filter((p) => p.isArsenal) },
    { label: players.find((p) => !p.isArsenal)?.team ?? 'Opponent', list: filtered.filter((p) => !p.isArsenal) },
  ];
  const selected = players.find((p) => p.id === value);
  const tag = (p: PickerPlayer) => {
    if (!lineupOut) return p.position ? <span className="tag">{p.position}</span> : null;
    if (p.lineupRole === 'starter') return <span className="tag ok">Starting</span>;
    if (p.lineupRole === 'substitute') return <span className="tag warn">On the bench</span>;
    return <span className="tag warn">Not in squad</span>;
  };

  return (
    <div className="picker">
      <input type="search" placeholder="Search players" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search players" />
      <div className="picker-list" role="radiogroup">
        {!q && (
          <label className={`picker-option${value === 'none' ? ' selected' : ''}`} style={noneEnabled ? undefined : { opacity: 0.5 }}>
            <input type="radio" name={name} checked={value === 'none'} disabled={!noneEnabled} onChange={() => onChange('none')} />
            {noneLabel}
            {noneHint && <span className="tag">{noneHint}</span>}
          </label>
        )}
        {groups.map((g) => g.list.length > 0 && (
          <div key={g.label}>
            <div className="picker-group">{g.label}</div>
            {g.list.map((p) => (
              <label key={p.id} className={`picker-option${value === p.id ? ' selected' : ''}`}>
                <input type="radio" name={name} checked={value === p.id} onChange={() => onChange(p.id)} />
                {p.name}
                {tag(p)}
              </label>
            ))}
          </div>
        ))}
        {filtered.length === 0 && <div className="empty">No player matches &ldquo;{q}&rdquo;.</div>}
      </div>
      <div className="picker-selected" aria-live="polite">
        Selected: <strong>{value === 'none' ? noneLabel : selected ? `${selected.name} (${selected.team})` : 'nobody yet'}</strong>
      </div>
    </div>
  );
}
