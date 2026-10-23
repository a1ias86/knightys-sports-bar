import Link from 'next/link';
import { setupAvailable } from '@/lib/setup';
import { env } from '@/lib/env';
import { SetupForm } from './SetupForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'First-time setup' };

export default async function SetupPage() {
  const available = await setupAvailable();
  return (
    <main className="wrap" style={{ maxWidth: 560, paddingTop: 48, paddingBottom: 48 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/knightys-bar.webp" alt="Knighty's Sports Bar" width={1200} height={800} style={{ width: 240, marginBottom: 24 }} />
      <h1>First-time setup</h1>
      {!available ? (
        <>
          <p>Setup is complete: the administrators already have PINs.</p>
          <Link className="btn" href="/login">Go to log in</Link>
        </>
      ) : !env.adminSetupToken ? (
        <div className="alert alert-warn">
          Set <code>ADMIN_SETUP_TOKEN</code> in the Vercel environment variables (a long random value), redeploy, then come back here.
        </div>
      ) : (
        <>
          <p className="muted">This issues the first PINs for the administrators (Jon and Knighty). It only works once. Enter the setup token from the Vercel environment settings.</p>
          <SetupForm />
        </>
      )}
    </main>
  );
}
