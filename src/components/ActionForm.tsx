'use client';

import { useActionState, useState } from 'react';
import type { AdminState } from '@/app/(site)/admin/actions';

/** Form wrapper for admin actions: shows success/error messages and any newly issued PINs (once). */
export function ActionForm({
  action, children, confirm, className, style, submitLabel, submitClass = 'btn btn-small',
}: {
  action: (prev: AdminState, form: FormData) => Promise<AdminState>;
  children?: React.ReactNode;
  confirm?: string;
  className?: string;
  style?: React.CSSProperties;
  submitLabel?: string;
  submitClass?: string;
}) {
  const [state, run, pending] = useActionState<AdminState, FormData>(action, null);
  return (
    <form
      action={run}
      className={className}
      style={style}
      onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}
    >
      {state?.error && <div className="alert alert-error" role="alert">{state.error}</div>}
      {state?.ok && <div className="alert alert-ok" role="status">{state.ok}</div>}
      {state?.pins && state.pins.length > 0 && <PinReveal pins={state.pins} />}
      {children}
      {submitLabel && <button className={submitClass} disabled={pending}>{pending ? 'Working…' : submitLabel}</button>}
    </form>
  );
}

function PinReveal({ pins }: { pins: { displayName: string; pin: string }[] }) {
  const [copied, setCopied] = useState(false);
  const text = pins.map((p) => `${p.displayName}: ${p.pin}`).join('\n');
  return (
    <div className="alert alert-warn">
      <p style={{ marginBottom: 8 }}><strong>New PIN{pins.length > 1 ? 's' : ''}: shown once only.</strong> Copy them now and send each member their own PIN privately. They are not stored and can&rsquo;t be looked up later.</p>
      <div className="pin-list">{text}</div>
      <button
        type="button" className="btn btn-small" style={{ marginTop: 10 }}
        onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } }}
      >
        {copied ? 'Copied' : 'Copy list'}
      </button>
    </div>
  );
}
