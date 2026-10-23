import { STATUS_LABEL, type DisplayStatus } from '@/lib/fixtures';

export function StatusChip({ status }: { status: DisplayStatus }) {
  return <span className={`chip chip-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function SourceChip({ source, verified }: { source: 'automatic' | 'manual'; verified?: boolean }) {
  if (source === 'manual') return <span className="chip chip-manual">Entered by admin</span>;
  return <span className="chip chip-auto">{verified ? 'Automatic data, verified' : 'Automatic data'}</span>;
}

export function Scoreline({ a, b }: { a: number | null | undefined; b: number | null | undefined }) {
  return (
    <span className="scoreline" aria-label={a == null ? 'No score' : `${a} to ${b}`}>
      <b>{a ?? '–'}</b>
      <b>{b ?? '–'}</b>
    </span>
  );
}

export function venueText(venue: string, opponent: string) {
  return venue === 'A' ? `${opponent} v Arsenal` : venue === 'N' ? `Arsenal v ${opponent} (neutral)` : `Arsenal v ${opponent}`;
}

export function FormPips({ form }: { form: (number | null)[] }) {
  if (!form.length) return <span className="muted">–</span>;
  return (
    <span className="form-pips" aria-label={`Recent points: ${form.map((f) => f ?? 'none').join(', ')}`}>
      {form.map((p, i) => (
        <span key={i} className={p == null ? '' : p >= 10 ? 'hi' : p > 0 ? 'mid' : ''}>{p ?? '·'}</span>
      ))}
    </span>
  );
}

export function Movement({ m }: { m: number | null }) {
  if (m == null || m === 0) return <span className="move muted" aria-label="No change">–</span>;
  return m > 0
    ? <span className="move up" aria-label={`Up ${m}`}>▲{m}</span>
    : <span className="move down" aria-label={`Down ${-m}`}>▼{-m}</span>;
}

export function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function Alert({ kind, children }: { kind: 'error' | 'ok' | 'warn' | 'info'; children: React.ReactNode }) {
  return <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}
