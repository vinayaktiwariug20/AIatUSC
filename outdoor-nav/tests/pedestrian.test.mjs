// Gates on foot, from Transportation's gate schedule (data/gates.json pedestrian_hours).
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../cloudflare/worker.mjs';

async function onFoot(at) {
  const r = await worker.fetch(new Request('https://x.test/api/gates?at=' + encodeURIComponent(at)), {});
  const d = await r.json();
  return Object.fromEntries(d.gates.map(g => [g.id, g.pedestrian]));
}

test('Downey Way is closed on foot at weekends, and open until 11 pm on weekdays', async () => {
  assert.equal((await onFoot('2026-11-21T12:00:00'))['downey-way'].status, 'closed');     // a Saturday
  const tue = (await onFoot('2026-11-17T12:00:00'))['downey-way'];
  assert.equal(tue.status, 'open'); assert.equal(tue.until, '23:00');
  assert.match(tue.source, /Transportation/);
  assert.equal((await onFoot('2026-11-17T23:30:00'))['downey-way'].status, 'varies');      // DPS closes it in this hour
});

test('the hour DPS opens a gate is "varies", not open', async () => {
  const early = (await onFoot('2026-11-17T05:30:00'))['downey-way'];
  assert.equal(early.status, 'varies'); assert.match(early.note, /5 and 6 am/);
  assert.equal((await onFoot('2026-11-17T04:30:00'))['downey-way'].status, 'closed');
  assert.equal((await onFoot('2026-11-17T12:00:00')).pardee, undefined);                  // removed: special access only
});

test('Watt Way is open on foot around the clock, even when closed to cars', async () => {
  const r = await worker.fetch(new Request('https://x.test/api/gates?at=2026-11-21T03:00:00'), {});
  const watt = (await r.json()).gates.find(g => g.id === 'watt');
  assert.equal(watt.pedestrian.status, 'open'); assert.equal(watt.vehicle.status, 'closed');
});

test('gates the schedule does not list keep their old status', async () => {
  const all = await onFoot('2026-11-21T12:00:00');
  assert.equal(all.mcclintock.status, 'open');            // observed by parking staff
  assert.equal(all.royal.status, 'not_stated');
});
