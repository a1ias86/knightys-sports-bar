'use server';

import { bootstrapAdmins, tokenMatches } from '@/lib/setup';
import { env } from '@/lib/env';
import { clientIp } from '@/lib/session';
import { sql } from '@/lib/db';

export type SetupState = { error: string } | { issued: { displayName: string; pin: string }[] } | null;

export async function setupAction(_prev: SetupState, form: FormData): Promise<SetupState> {
  const ip = await clientIp();
  // Reuse the login limiter: repeated wrong tokens from one address are blocked.
  const [r] = await sql<{ n: number }[]>`
    select count(*)::int as n from login_attempts where ip = ${ip} and not success and created_at > now() - interval '1 hour'`;
  if (r.n >= 10) return { error: 'Too many attempts. Try again later.' };
  if (!tokenMatches(String(form.get('token') ?? ''), env.adminSetupToken)) {
    await sql`insert into login_attempts (member_id, ip, success) values (null, ${ip}, false)`;
    await new Promise((res) => setTimeout(res, 600));
    return { error: 'That token is not correct.' };
  }
  const issued = await bootstrapAdmins('web');
  if (!issued) return { error: 'Setup has already been completed.' };
  return { issued: issued.map((i) => ({ displayName: i.displayName, pin: i.pin })) };
}
