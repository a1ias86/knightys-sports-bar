/** UK time helpers. Kickoffs are stored as UTC instants and always shown in Europe/London (GMT/BST). */

export const UK_TZ = 'Europe/London';

function parts(d: Date) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: UK_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return o;
}

/** Offset of UK local time from UTC at the given instant, in minutes (0 in GMT, 60 in BST). */
export function ukOffsetMinutes(d: Date): number {
  const p = parts(d);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}

/** Convert a UK wall-clock date ('2026-10-25') and time ('15:00') to a UTC Date. */
export function ukLocalToUtc(date: string, time: string): Date {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dm || !tm) throw new Error('Use a date like 2026-10-25 and a time like 15:00');
  const guess = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2]);
  let result = guess - ukOffsetMinutes(new Date(guess)) * 60000;
  // Re-check at the result in case the guess straddled a clock change.
  result = guess - ukOffsetMinutes(new Date(result)) * 60000;
  return new Date(result);
}

/** UK wall-clock values for a form input. */
export function utcToUkInputs(d: Date): { date: string; time: string } {
  const p = parts(d);
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export function formatKickoff(d: Date | string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: UK_TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(d));
}

export function formatDate(d: Date | string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: UK_TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(d));
}

export function formatDateTime(d: Date | string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: UK_TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(d));
}

export function ukZoneLabel(d: Date | string): 'GMT' | 'BST' {
  return ukOffsetMinutes(new Date(d)) === 60 ? 'BST' : 'GMT';
}

export function timeUntil(d: Date | string, now = new Date()): string {
  const ms = new Date(d).getTime() - now.getTime();
  if (ms <= 0) return 'now';
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${m}m`;
  return `${m}m`;
}

export function ukGreeting(now = new Date()): string {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: UK_TZ, hour: '2-digit', hourCycle: 'h23' }).format(now));
  return h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening';
}
