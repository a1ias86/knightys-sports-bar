import { requireAdmin } from '@/lib/session';
import { listPlayers } from '@/lib/fixtures';
import { ActionForm } from '@/components/ActionForm';
import { addPlayerAction, playerActiveAction } from '../actions';

export const metadata = { title: 'Players' };

export default async function PlayersAdmin() {
  await requireAdmin();
  const players = await listPlayers();
  const teams = [...new Set(players.map((p) => p.teamName))];
  return (
    <div className="stack">
      <h1>Players</h1>
      <section className="panel">
        <h2>Add a player</h2>
        <p className="small muted">Players appear in the pickers for Arsenal matches (Arsenal) or matches against their team. With a data feed, squads are loaded automatically; add players here if the feed misses someone or there is no feed.</p>
        <ActionForm action={addPlayerAction} submitLabel="Add player" submitClass="btn">
          <div className="form-grid">
            <div className="field"><label htmlFor="pl-name">Name</label><input id="pl-name" name="name" type="text" required maxLength={60} /></div>
            <div className="field"><label htmlFor="pl-team">Team</label><input id="pl-team" name="team" type="text" required defaultValue="Arsenal" list="teams" maxLength={60} /><datalist id="teams">{teams.map((t) => <option key={t} value={t} />)}</datalist><div className="hint">Use the same spelling as the fixture&rsquo;s opponent.</div></div>
            <div className="field"><label htmlFor="pl-pos">Position (optional)</label><input id="pl-pos" name="position" type="text" maxLength={30} /></div>
          </div>
        </ActionForm>
      </section>
      <section className="panel">
        {players.length === 0 ? <p className="muted">No players yet.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Team</th><th>Position</th><th>Source</th><th></th></tr></thead>
              <tbody>
                {players.map((p) => (
                  <tr key={p.id} style={p.active ? undefined : { opacity: 0.5 }}>
                    <td><strong>{p.name}</strong></td>
                    <td>{p.teamName}</td>
                    <td>{p.position ?? '–'}</td>
                    <td className="small">{p.provider === 'manual' ? 'Added by admin' : p.provider}</td>
                    <td>
                      <form action={playerActiveAction}>
                        <input type="hidden" name="playerId" value={p.id} />
                        <input type="hidden" name="active" value={p.active ? '0' : '1'} />
                        <button className="btn btn-ghost btn-small">{p.active ? 'Hide from picks' : 'Show in picks'}</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
