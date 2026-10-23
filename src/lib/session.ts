import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { getSessionMember, type SessionMember } from './auth-core';

export const SESSION_COOKIE = 'ksb_session';

export async function clientIp(): Promise<string> {
  const h = await headers();
  // On Vercel, x-forwarded-for is set by the platform (first entry = client).
  const fwd = h.get('x-forwarded-for');
  return (fwd?.split(',')[0]?.trim() || h.get('x-real-ip') || 'unknown').slice(0, 64);
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Current member for this request (cached per request). */
export const currentMember = cache(async (): Promise<SessionMember | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return getSessionMember(token);
});

export async function requireMember(): Promise<SessionMember> {
  const m = await currentMember();
  if (!m) redirect('/login');
  return m;
}

/** Server-side role check. Every admin page AND every admin action calls this. */
export async function requireAdmin(): Promise<SessionMember> {
  const m = await currentMember();
  if (!m) redirect('/login');
  if (m.role !== 'admin') redirect('/');
  return m;
}
