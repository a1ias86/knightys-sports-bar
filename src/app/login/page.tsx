import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentMember } from '@/lib/session';
import { loginNames } from '@/lib/members';
import { setupAvailable } from '@/lib/setup';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Log in' };

export default async function LoginPage() {
  if (await currentMember()) redirect('/');
  const [names, needsSetup] = await Promise.all([loginNames(), setupAvailable()]);
  return (
    <div className="login-page">
      <div className="login-art">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/league-crest.webp" alt="Arsenal Men's Prediction League and Chat" width={900} height={822} />
      </div>
      <div className="login-side">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="bar-logo" src="/brand/knightys-bar.webp" alt="Knighty's Sports Bar" width={1200} height={800} />
        <div className="login-card">
          <h1>Get your predictions in</h1>
          <p className="muted">Pick your name and enter the four-digit PIN Jon or Knighty gave you.</p>
          {needsSetup ? (
            <div className="alert alert-info">
              The league hasn&rsquo;t been set up yet. Jon or Knighty: <Link href="/setup">run the first-time setup</Link>.
            </div>
          ) : (
            <LoginForm names={names} />
          )}
          <p className="small muted" style={{ marginTop: 20 }}>Forgotten your PIN? Ask Jon or Knighty for a new one.</p>
        </div>
      </div>
    </div>
  );
}
