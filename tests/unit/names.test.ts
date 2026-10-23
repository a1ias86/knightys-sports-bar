import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cleanName, nameKey, validateName, matchPickToOfficial } from '../../src/lib/names';
import { validateManualResult, type ManualResultForm } from '../../src/lib/results';

describe('Name normalisation', () => {
  test('case, surrounding and repeated spaces do not matter', () => {
    assert.equal(nameKey('Bukayo Saka'), nameKey('bukayo saka'));
    assert.equal(nameKey(' Bukayo Saka '), nameKey('Bukayo   Saka'));
    assert.equal(cleanName('  Bukayo   Saka '), 'Bukayo Saka');
  });
  test('composed and decomposed accents are the same name', () => {
    assert.equal(nameKey('Désiré Doué'), nameKey('Désiré Doué'));
  });
  test('curly and straight apostrophes, and dash variants, are the same', () => {
    assert.equal(nameKey('Kieran O’Brien'), nameKey("Kieran O'Brien"));
    assert.equal(nameKey('Myles Lewis–Skelly'), nameKey('Myles Lewis-Skelly'));
  });
  test('accents are NOT ignored for scoring', () => {
    assert.notEqual(nameKey('Martin Ødegaard'), nameKey('Martin Odegaard'));
  });
});

describe('Name validation', () => {
  for (const ok of ["Martin Ødegaard", "Kieran O'Brien", 'Myles Lewis-Skelly', 'Gabriel Jesus', 'N. Madueke', 'Gabriel Magalhães']) {
    test(`accepts ${ok}`, () => assert.equal(validateName(ok, 'Scorer'), null));
  }
  for (const bad of ['', '   ', '123', '<b>Saka</b>', 'Saka7', 'x'.repeat(61)]) {
    test(`rejects ${JSON.stringify(bad.slice(0, 12))}`, () => assert.notEqual(validateName(bad, 'Scorer'), null));
  }
});

describe('Matching a typed pick to an official name', () => {
  const m = matchPickToOfficial;
  test('exact after normalisation', () => {
    assert.equal(m(' bukayo SAKA', 'Bukayo Saka'), 'exact');
    assert.equal(m("Kieran O\u2019Brien", "kieran o'brien"), 'exact');
  });
  test('surname only, either way round', () => {
    assert.equal(m('Saka', 'Bukayo Saka'), 'close');
    assert.equal(m('Bukayo Saka', 'Saka'), 'close');
    assert.equal(m('martinelli', 'Gabriel Martinelli'), 'close');
  });
  test('missing accents and punctuation', () => {
    assert.equal(m('Odegaard', 'Martin Ødegaard'), 'close');
    assert.equal(m('Martin Odegaard', 'Martin Ødegaard'), 'close');
    assert.equal(m('Smith Rowe', 'Emile Smith-Rowe'), 'close');
    assert.equal(m('Magalhaes', 'Gabriel Magalhães'), 'close');
  });
  test('small typos in longer names', () => {
    assert.equal(m('Havetz', 'Kai Havertz'), 'close');
    assert.equal(m('Odegard', 'Martin Ødegaard'), 'close');
    assert.equal(m('Martinneli', 'Gabriel Martinelli'), 'close');
  });
  test('short names must be spelt right', () => {
    assert.equal(m('Sakka', 'Bukayo Saka'), 'none');
    assert.equal(m('Sala', 'Bukayo Saka'), 'none');
    assert.equal(m('Rise', 'Declan Rice'), 'none');
  });
  test('different players are not matched', () => {
    assert.equal(m('Gabriel Jesus', 'Gabriel Martinelli'), 'none');
    assert.equal(m('Jesus', 'Gabriel Martinelli'), 'none');
    assert.equal(m('White', 'Declan Rice'), 'none');
    assert.equal(m('', 'Bukayo Saka'), 'none');
  });
});

describe('Result form validation (server side)', () => {
  const base: ManualResultForm = {
    arsenalGoals: 1, opponentGoals: 0, scorerState: 'named', scorerName: 'Bukayo Saka',
    assisterState: 'named', assisterName: 'Martin Ødegaard', firstGoalOwnGoal: false, firstGoalUnassisted: false,
    status: 'finished', notesPrivate: '', publicNote: '',
  };
  test('a complete result is valid', () => assert.deepEqual(validateManualResult(base), []));
  test('no assister choice made is rejected (never defaults to "none")', () => {
    assert.ok(validateManualResult({ ...base, assisterState: '' as never }).length > 0);
  });
  test('"Named player" with an empty name is rejected', () => {
    assert.ok(validateManualResult({ ...base, assisterName: '   ' }).length > 0);
  });
  test('confirmed no assist, unknown and not-entered are all accepted as distinct choices', () => {
    for (const s of ['none', 'unknown', 'pending'] as const) assert.deepEqual(validateManualResult({ ...base, assisterState: s, assisterName: '' }), []);
  });
  test('0-0 cannot have a named scorer', () => {
    assert.ok(validateManualResult({ ...base, arsenalGoals: 0, assisterState: 'none' }).length > 0);
  });
  test('"No qualifying goal" with goals needs the own-goal box', () => {
    assert.ok(validateManualResult({ ...base, scorerState: 'none', assisterState: 'none' }).length > 0);
    assert.deepEqual(validateManualResult({ ...base, scorerState: 'none', assisterState: 'none', firstGoalOwnGoal: true }), []);
  });
});
