'use client';

import { useActionState } from 'react';
import { setupAction, type SetupState } from './actions';

export function SetupForm() {
  const [state, action, pending] = useActionState<SetupState, FormData>(setupAction, null);
  if (state && 'issued' in state) {
    return (
      <div className="panel">
        <h2>Admin PINs</h2>
        <p>Write these down now. They are not stored anywhere and won&rsquo;t be shown again.</p>
        <table>
          <tbody>
            {state.issued.map((i) => (
              <tr key={i.displayName}><td>{i.displayName}</td><td className="pin-reveal">{i.pin}</td></tr>
            ))}
          </tbody>
        </table>
        <p className="small muted" style={{ marginTop: 16 }}>Next: remove ADMIN_SETUP_TOKEN from Vercel, log in, then go to Admin → Members to issue everyone else&rsquo;s PINs.</p>
        <a className="btn btn-red" href="/login">Log in</a>
      </div>
    );
  }
  return (
    <form action={action}>
      {state && 'error' in state && <div className="alert alert-error">{state.error}</div>}
      <div className="field">
        <label htmlFor="token">Setup token</label>
        <input id="token" name="token" type="password" required autoComplete="off" />
      </div>
      <button className="btn btn-red" disabled={pending}>{pending ? 'Issuing…' : 'Issue admin PINs'}</button>
    </form>
  );
}
