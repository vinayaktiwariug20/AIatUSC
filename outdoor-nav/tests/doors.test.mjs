// Doors surveyed on site (TCC area, McCarthy structure), and "Avoid stairs" choosing a step-free door.
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../cloudflare/worker.mjs';

async function walk(to, from, stepFree = false) {
  const r = await worker.fetch(new Request('https://x.test/api/outdoor/route', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({mode: 'walking', from, to, step_free: stepFree, at: '2026-11-18T12:00:00'})}), {});
  return r.json();
}
const TROUSDALE = {lat: 34.0204, lon: -118.2852}, WEST = {lat: 34.0205, lon: -118.2885};

test('TCC, the Student Union and Sample Hall route to surveyed doors, not outline guesses', async () => {
  for (const [to, ids] of [['TCC', ['rtcc-main']], ["Tommy's Place", ['rtcc-lower']], ['Traditions', ['rtcc-lower']], ['Student Union', ['su-ramp', 'su-steps-north', 'su-steps-east']], ['Sample Hall', ['sample-plaza']]]) {
    const r = await walk(to, TROUSDALE);
    assert.equal(r.ok, true, to); assert.ok(ids.includes(r.handoff.entrance_id), to + ': ' + r.handoff.entrance_id);
    assert.equal(r.summary.entrance_source, 'surveyed');
  }
});

test('avoiding stairs picks the Student Union ramp, and says the door is step-free', async () => {
  for (const from of [TROUSDALE, WEST]) {
    const r = await walk('Student Union', from, true);
    assert.equal(r.handoff.entrance_id, 'su-ramp'); assert.equal(r.handoff.step_free_door, true);
  }
  const steps = await walk('Student Union', {lat: 34.0201, lon: -118.2852});
  if (steps.handoff.entrance_id !== 'su-ramp') assert.equal(steps.handoff.step_free_door, false);
});

test('McCarthy structure: one pedestrian exit, onto Hellman Way, at the surveyed spot', async () => {
  const p = (await (await worker.fetch(new Request('https://x.test/api/mobility?at=2026-11-18T12:00:00'), {})).json()).parking.find(x => x.id === 'mccarthy');
  assert.equal(p.exit_node.id, 'MCCARTHY.ped.hellman');
  assert.ok(Math.abs(p.exit_node.lat - 34.0201709) < 1e-7);
  assert.equal((await walk('TCC', {place: 'mccarthy', exit: 'MCCARTHY.ped.south'})).ok, false);   // no second exit
});

test('surveyed doors carry their photo for the arrival card', async () => {
  const r = await walk('Student Union', TROUSDALE, true);
  assert.equal(r.handoff.photo, '/doors/su-ramp.jpg');
});

test('DMC: the nearest surveyed door from each side; the east breezeway starts the indoor map at its right breezeway', async () => {
  for (const [from, door, indoor] of [[{lat: 34.0222, lon: -118.2845}, 'jmc-main', 'entrance'], [{lat: 34.0210, lon: -118.2826}, 'dmc-breezeway-east', 'breezeway-right'],
    [{lat: 34.0212, lon: -118.2852}, 'dmc-west', null], [{lat: 34.0200, lon: -118.2844}, 'dmc-southeast', null]]) {
    const r = await walk('DMC', from);
    assert.equal(r.handoff.entrance_id, door); assert.equal(r.handoff.indoor_node, indoor);
  }
});
