import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ukLocalToUtc, utcToUkInputs, ukZoneLabel } from '../../src/lib/time';

test('BST kickoff: 15:00 UK on 18 Oct 2026 is 14:00 UTC', () => {
  assert.equal(ukLocalToUtc('2026-10-18', '15:00').toISOString(), '2026-10-18T14:00:00.000Z');
  assert.equal(ukZoneLabel('2026-10-18T14:00:00Z'), 'BST');
});

test('GMT kickoff: 15:00 UK on 1 Nov 2026 is 15:00 UTC', () => {
  assert.equal(ukLocalToUtc('2026-11-01', '15:00').toISOString(), '2026-11-01T15:00:00.000Z');
  assert.equal(ukZoneLabel('2026-11-01T15:00:00Z'), 'GMT');
});

test('clock-change day (25 Oct 2026, clocks go back at 02:00 BST)', () => {
  assert.equal(ukLocalToUtc('2026-10-25', '16:30').toISOString(), '2026-10-25T16:30:00.000Z');
  assert.equal(ukLocalToUtc('2026-10-25', '00:30').toISOString(), '2026-10-24T23:30:00.000Z');
});

test('spring clock change (29 Mar 2026)', () => {
  assert.equal(ukLocalToUtc('2026-03-29', '14:00').toISOString(), '2026-03-29T13:00:00.000Z');
});

test('round trip to form inputs', () => {
  assert.deepEqual(utcToUkInputs(new Date('2026-12-26T12:30:00Z')), { date: '2026-12-26', time: '12:30' });
  assert.deepEqual(utcToUkInputs(new Date('2026-08-22T11:30:00Z')), { date: '2026-08-22', time: '12:30' });
});
