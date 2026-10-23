import { requireAdmin } from '@/lib/session';
import { getSettings } from '@/lib/settings';
import { listCompetitions } from '@/lib/fixtures';
import { getProvider } from '@/lib/providers';
import { env } from '@/lib/env';
import { ActionForm } from '@/components/ActionForm';
import { settingsAction } from '../actions';

export const metadata = { title: 'Settings' };

export default async function SettingsAdmin() {
  await requireAdmin();
  const [settings, comps] = await Promise.all([getSettings(), listCompetitions()]);
  const provider = getProvider();
  return (
    <div className="stack" style={{ maxWidth: 780 }}>
      <h1>Settings</h1>
      <section className="panel">
        <ActionForm action={settingsAction} submitLabel="Save settings" submitClass="btn btn-red">
          <h2>Predictions</h2>
          <div className="field">
            <label className="checkbox"><input type="checkbox" name="reveal" defaultChecked={settings.revealPredictionsAfterKickoff} /> Show everyone&rsquo;s locked predictions in the match centre after kick-off</label>
            <div className="hint">Predictions are always hidden from other members before kick-off.</div>
          </div>
          <h2 style={{ marginTop: 24 }}>Competitions in the league</h2>
          <p className="small muted">Only matches in ticked competitions can be predicted. Changing this doesn&rsquo;t affect matches already scored.</p>
          {comps.map((c) => (
            <div className="field" key={c.code}><label className="checkbox"><input type="checkbox" name={`comp_${c.code}`} defaultChecked={c.enabled} /> {c.name}</label></div>
          ))}
        </ActionForm>
      </section>
      <section className="panel">
        <h2>Environment</h2>
        <dl className="confirm-list">
          <dt>Environment</dt><dd>{env.appEnv}</dd>
          <dt>Football data</dt><dd>{provider.configured ? provider.name : `Not configured: ${provider.reason}`}</dd>
          <dt>Scheduled jobs</dt><dd>{env.cronSecret ? 'Secured with CRON_SECRET' : 'CRON_SECRET not set: scheduled jobs are refused'}</dd>
          <dt>Setup token</dt><dd>{env.adminSetupToken ? 'Still set. Remove ADMIN_SETUP_TOKEN from Vercel now that setup is done.' : 'Removed'}</dd>
        </dl>
      </section>
    </div>
  );
}
