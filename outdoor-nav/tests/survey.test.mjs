// The team's door-recording page keeps points on the phone: it must never send them anywhere.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';

const html = readFileSync(new URL('../outdoor/static/survey/index.html', import.meta.url), 'utf8');
test('survey page: no network calls, not indexed, uses high-accuracy GPS', () => {
  for (const call of ['fetch(', 'sendBeacon', 'XMLHttpRequest', 'WebSocket', '/api/']) assert.ok(!html.includes(call), call);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /enableHighAccuracy:true/);
  assert.ok(!/\bconfirm\(|\balert\(/.test(html));   // no blocking dialogs
});

test('an offset moves the point the right way: metres along the bearing from true north', async () => {
  const vm = await import('node:vm');
  const src = html.match(/function moved\([^]*?\}\r?\n/)[0];
  const moved = vm.runInNewContext(src + ';moved');
  const m = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos(34.02 * Math.PI / 180));
  const at = {lat: 34.021, lon: -118.284};
  for (const [deg, dlat, dlon] of [[0, 1, 0], [90, 0, 1], [180, -1, 0], [270, 0, -1]]) {
    const p = moved(at.lat, at.lon, 8, deg);
    assert.ok(Math.abs(m(p, at) - 8) < 0.05, String(deg));
    assert.equal(Math.sign(Math.round((p.lat - at.lat) * 1e7)), dlat, deg + ' lat'); assert.equal(Math.sign(Math.round((p.lon - at.lon) * 1e7)), dlon, deg + ' lon');
  }
  assert.match(html, /const DECLINATION=11\.5/);   // compass headings are magnetic; LA is ~11.5° east
});
