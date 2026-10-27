import { resetDatabase } from './helpers';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql, closeDb } from '../../src/lib/db';
import { addHallOfFame, updateHallOfFame, deleteHallOfFame, listHallOfFame, parseSeason } from '../../src/lib/hall-of-fame';
import { setMemberActive } from '../../src/lib/members';
import type { Actor } from '../../src/lib/audit';

let jon: Actor;
let knighty: Actor;
let bob: Actor;
const member = async (n: string) => ({ id: (await sql<{ id: string }[]>`select id from members where display_name = ${n}`)[0].id, displayName: n });

before(async () => {
  await resetDatabase();
  jon = await member('Jon');
  knighty = await member('Knighty');
  bob = await member('Bob');
});
after(async () => { await closeDb(); });

describe('Season labels', () => {
  test('accepted formats normalise to 2025/26', () => {
    for (const s of ['2025/26', '2025-26', '2025/2026', ' 2025 – 2026 ']) assert.deepEqual(parseSeason(s), { label: '2025/26', start: 2025 });
    assert.deepEqual(parseSeason('1999/00'), { label: '1999/00', start: 1999 });
  });
  test('nonsense is rejected', () => {
    for (const s of ['2025', '2025/27', 'last year', '25/26', '']) assert.equal(parseSeason(s), null);
  });
});

describe('Hall of Fame', () => {
  test('starts empty', async () => {
    assert.deepEqual(await listHallOfFame(), []);
  });

  test('an admin can add entries; newest season is listed first', async () => {
    assert.ok((await addHallOfFame(jon, { season: '2023-24', winnerName: 'Margaret', memberId: (await member('Margaret')).id, points: '61', summary: 'Ran away with it.' })).ok);
    assert.ok((await addHallOfFame(knighty, { season: '2025/26', winnerName: 'James', memberId: null, points: null, summary: null })).ok);
    assert.ok((await addHallOfFame(jon, { season: '2024/25', winnerName: "Dave O'Leary", memberId: null, points: 58, summary: '' })).ok);
    const list = await listHallOfFame();
    assert.deepEqual(list.map((e) => e.seasonLabel), ['2025/26', '2024/25', '2023/24']);
    assert.equal(list[2].memberName, 'Margaret');
    assert.equal(list[1].winnerName, "Dave O'Leary", 'winners need not be members');
    assert.equal(list[0].points, null);
  });

  test('a second entry for the same season is refused', async () => {
    const r = await addHallOfFame(jon, { season: '2025-2026', winnerName: 'Someone Else', memberId: null, points: null, summary: null });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /already a champion for 2025\/26/);
    assert.equal((await listHallOfFame()).length, 3);
  });

  test('an admin can edit an entry (including renaming the winner)', async () => {
    const [e] = (await listHallOfFame()).filter((x) => x.seasonLabel === '2025/26');
    const r = await updateHallOfFame(jon, e.id, { season: '2025/26', winnerName: 'James P', memberId: (await member('James')).id, points: '73', summary: 'Won by two points.' });
    assert.ok(r.ok);
    const [after] = (await listHallOfFame()).filter((x) => x.id === e.id);
    assert.deepEqual([after.winnerName, after.points, after.memberName], ['James P', 73, 'James']);
    const clash = await updateHallOfFame(jon, e.id, { season: '2024/25', winnerName: 'James P', memberId: null, points: null, summary: null });
    assert.equal(clash.ok, false, 'moving it onto an existing season is refused');
  });

  test('ordinary members cannot add, edit or delete', async () => {
    const [e] = await listHallOfFame();
    await assert.rejects(addHallOfFame(bob, { season: '2019/20', winnerName: 'Bob', memberId: null, points: null, summary: null }), /Only an administrator/);
    await assert.rejects(updateHallOfFame(bob, e.id, { season: e.seasonLabel, winnerName: 'Bob', memberId: null, points: null, summary: null }), /Only an administrator/);
    await assert.rejects(deleteHallOfFame(bob, e.id), /Only an administrator/);
    assert.equal((await listHallOfFame()).length, 3);
  });

  test('a deactivated admin cannot make changes', async () => {
    await setMemberActive(jon, knighty.id, false);
    await assert.rejects(addHallOfFame(knighty, { season: '2018/19', winnerName: 'Knighty', memberId: null, points: null, summary: null }), /Only an administrator/);
    await setMemberActive(jon, knighty.id, true);
  });

  test('a linked member can be deactivated; the entry and name remain', async () => {
    const margaret = await member('Margaret');
    await setMemberActive(jon, margaret.id, false);
    const [e] = (await listHallOfFame()).filter((x) => x.seasonLabel === '2023/24');
    assert.deepEqual([e.winnerName, e.memberName], ['Margaret', 'Margaret']);
    await setMemberActive(jon, margaret.id, true);
  });

  test('entries persist (read through a separate connection)', async () => {
    const postgres = (await import('postgres')).default;
    const other = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      const rows = await other`select season_label from hall_of_fame order by season_start desc`;
      assert.deepEqual(rows.map((r) => r.season_label), ['2025/26', '2024/25', '2023/24']);
    } finally {
      await other.end();
    }
  });

  test('an admin can delete an entry; it is audited', async () => {
    const [e] = (await listHallOfFame()).filter((x) => x.seasonLabel === '2024/25');
    assert.ok((await deleteHallOfFame(jon, e.id)).ok);
    assert.equal((await deleteHallOfFame(jon, e.id)).ok, false, 'already gone');
    assert.deepEqual((await listHallOfFame()).map((x) => x.seasonLabel), ['2025/26', '2023/24']);
    const [a] = await sql<{ n: number }[]>`select count(*)::int as n from audit_log where action like 'hall_of_fame.%'`;
    assert.equal(a.n, 5);
  });

  test('validation: bad season, empty name and silly points are refused', async () => {
    for (const bad of [
      { season: 'next year', winnerName: 'X', memberId: null, points: null, summary: null },
      { season: '2017/18', winnerName: '   ', memberId: null, points: null, summary: null },
      { season: '2017/18', winnerName: 'X', memberId: null, points: '-4', summary: null },
      { season: '2017/18', winnerName: '<script>', memberId: null, points: null, summary: null },
    ]) assert.equal((await addHallOfFame(jon, bad)).ok, false, JSON.stringify(bad));
  });

  test('the Hall of Fame does not touch league data', async () => {
    const [t] = await sql<{ total: number }[]>`select sum(total_points)::int as total from member_totals`;
    assert.equal(t.total, 1012, 'opening points only; no match points or adjustments created');
  });
});
