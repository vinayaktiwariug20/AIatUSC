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
