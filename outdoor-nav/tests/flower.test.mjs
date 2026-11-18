// Flower St structure (USC ID only, 24 h) and McClintock on foot (24 h, per Transportation staff).
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../cloudflare/worker.mjs';

const get = async p => (await worker.fetch(new Request('https://x.test' + p), {})).json();
const walk = async body => (await worker.fetch(new Request('https://x.test/api/outdoor/route', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({mode: 'walking', at: '2026-11-18T10:00:00', ...body})}), {})).json();

test('Flower St structure: offered only with a USC ID, any time of day', async () => {
  for (const at of ['2026-11-18T10:00:00', '2026-11-22T23:00:00']) {
    const guest = (await get('/api/mobility?at=' + at)).parking.find(p => p.id === 'flower');
    assert.equal(guest.eligible, false, at);
    const id = (await get('/api/mobility?at=' + at + '&usc_id=true')).parking.find(p => p.id === 'flower');
    assert.equal(id.eligible, true, at);
    assert.equal(id.exit_node.id, 'FLOWER.ped.double');
    assert.deepEqual(id.access.map(a => a.entrance.id), ['FLOWER.veh.flower', 'FLOWER.veh.west']);
  }
});

test('walking from Flower St structure reaches campus buildings', async () => {
  const fromDoors = await walk({from: {place: 'flower', exit: 'FLOWER.ped.double'}, to: 'TCC'});
  assert.equal(fromDoors.ok, true); assert.ok(fromDoors.summary.minutes < 10);
  const anyExit = await walk({from: {place: 'flower'}, to: 'Doheny'});
  assert.equal(anyExit.ok, true);
  assert.equal((await walk({from: {place: 'flower', exit: 'MCCARTHY.ped.hellman'}, to: 'TCC'})).ok, false);   // not Flower's exit
});

test('McClintock is open on foot around the clock, credited to Transportation staff (no "observed")', async () => {
  for (const at of ['2026-11-18T10:00:00', '2026-11-22T03:00:00']) {
    const ped = (await get('/api/gates?at=' + at)).gates.find(g => g.id === 'mcclintock').pedestrian;
    assert.equal(ped.status, 'open'); assert.equal(ped.source, 'USC Transportation staff'); assert.equal(ped.observed, undefined);
  }
});
