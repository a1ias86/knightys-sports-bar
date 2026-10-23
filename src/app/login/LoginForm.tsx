'use client';

import { useActionState } from 'react';
import { loginAction, type FormState } from '@/app/actions';

export function LoginForm({ names }: { names: { id: string; displayName: string }[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(loginAction, null);
  return (
    <form action={action} autoComplete="off">
      {state?.error && <div className="alert alert-error" role="alert">{state.error}</div>}
      <div className="field">
        <label htmlFor="member">Your name</label>
        {/* Remounted after each attempt so the chosen name is kept when a PIN is wrong (React resets forms after an action). */}
        <select key={state?.memberId ?? ''} id="member" name="member" required defaultValue={state?.memberId ?? ''}>
          <option value="" disabled>Choose your name</option>
          {names.map((n) => <option key={n.id} value={n.id}>{n.displayName}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="pin">PIN</label>
        <input
          id="pin" name="pin" type="password" inputMode="numeric" pattern="\d{4}" maxLength={4} minLength={4}
          required className="pin-input" autoComplete="off" aria-describedby="pin-hint"
        />
        <div id="pin-hint" className="hint">Four digits. Five wrong tries locks your name for a while.</div>
      </div>
      <button className="btn btn-red" type="submit" disabled={pending} style={{ width: '100%' }}>
        {pending ? 'Checking…' : 'Log in'}
      </button>
    </form>
  );
}
