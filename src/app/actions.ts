'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { attemptLogin, revokeSession } from '@/lib/auth-core';
import { clientIp, setSessionCookie, clearSessionCookie, SESSION_COOKIE, requireMember } from '@/lib/session';
import { sql } from '@/lib/db';
import { savePrediction, parseGoals } from '@/lib/predictions';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

export type FormState = { error?: string; ok?: string; memberId?: string } | null;

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  const memberId = String(form.get('member') ?? '');
  const pin = String(form.get('pin') ?? '').trim();
  if (!memberId) return { error: 'Choose your name.' };
  if (!/^\d{4}$/.test(pin)) return { error: 'Your PIN is four digits.', memberId };
  const ua = (await headers()).get('user-agent');
  const result = await attemptLogin(memberId, pin, await clientIp(), ua);
  if (!result.ok) return { error: result.error, memberId };
  await setSessionCookie(result.token, result.expiresAt);
  redirect('/');
}

export async function logoutAction() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(sql, token);
  await clearSessionCookie();
  redirect('/login');
}

export async function predictionAction(_prev: FormState, form: FormData): Promise<FormState> {
  const me = await requireMember();
  const fixtureId = String(form.get('fixtureId') ?? '');
  const ag = parseGoals(form.get('arsenalGoals'));
  const og = parseGoals(form.get('opponentGoals'));
  if (ag === null || og === null) return { error: 'Enter both scores as whole numbers from 0 to 20.' };
  const r = await savePrediction(me.id, fixtureId, {
    arsenalGoals: ag,
    opponentGoals: og,
    // A typed name, or null only when the member explicitly ticked "No goalscorer" / "No assister".
    scorer: form.get('scorerNone') === 'on' ? null : String(form.get('scorer') ?? ''),
    assister: form.get('assisterNone') === 'on' ? null : String(form.get('assister') ?? ''),
  });
  if (!r.ok) return { error: r.error };
  revalidatePath('/');
  redirect(`/predict/${fixtureId}?saved=${r.created ? 'new' : 'edit'}`);
}
