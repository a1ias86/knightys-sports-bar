import { timingSafeEqual } from 'node:crypto';
import { env } from './env';

/** Scheduled endpoints accept only "Authorization: Bearer <CRON_SECRET>" (Vercel Cron sends this automatically). */
export function cronAuthorised(req: Request): boolean {
  const secret = env.cronSecret;
  if (!secret || secret.length < 16) return false;
  const given = req.headers.get('authorization') ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
