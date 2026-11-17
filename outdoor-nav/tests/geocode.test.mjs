// The "From" box: campus places from our data, addresses from openrouteservice.
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../cloudflare/worker.mjs';

async function geocode(q, env = {}) {
  const r = await worker.fetch(new Request('https://x.test/api/geocode?q=' + encodeURIComponent(q)), env);
  return {status: r.status, data: await r.json()};
}

test('campus buildings match by code or name, code shown in the label', async () => {
  const {data} = await geocode('TCC');
  assert.equal(data.results[0].kind, 'building');
  assert.equal(data.results[0].label, 'Ronald Tutor Campus Center (TCC)');   // official code, not OSM's RTCC
  assert.ok(Number.isFinite(data.results[0].lat));
  const dmc = (await geocode('medicine crow')).data.results[0];
  assert.match(dmc.label, /Medicine Crow.*\(DMC\)/);
});

test('short text skips address search; no key means "unavailable", not an error', async () => {
  assert.equal((await geocode('TC')).data.address, 'skipped');
  const r = await geocode('3500 Figueroa');
  assert.equal(r.status, 200);
  assert.equal(r.data.address, 'unavailable');
});

test('addresses come from openrouteservice, near USC, with the key kept on the server', async () => {
  const real = globalThis.fetch; let asked = null;
  globalThis.fetch = async (url, init) => {
    asked = {url: new URL(url), auth: init.headers.Authorization};
    return new Response(JSON.stringify({features: [
      {geometry: {type: 'Point', coordinates: [-118.2827, 34.0256]}, properties: {label: '3500 S Figueroa St, Los Angeles, CA, USA'}},
      {geometry: {type: 'Point', coordinates: [-73.98, 40.75]}, properties: {label: 'Figueroa, New York'}},   // outside LA: dropped
    ]}), {headers: {'Content-Type': 'application/json'}});
  };
  try {
    const {data} = await geocode('3500 Figueroa', {ORS_API_KEY: 'k'});
    assert.equal(data.address, 'ok');
    const addr = data.results.filter(r => r.kind === 'address');
    assert.deepEqual(addr.map(a => a.label), ['3500 S Figueroa St, Los Angeles, CA, USA']);
    assert.equal(asked.auth, 'k');
    assert.equal(asked.url.searchParams.get('text'), '3500 Figueroa');
    assert.ok(asked.url.searchParams.get('focus.point.lat'));
  } finally { globalThis.fetch = real; }
});

test('a failing address service still returns campus places', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', {status: 503});
  try {
    const {data} = await geocode('Doheny', {ORS_API_KEY: 'k'});
    assert.equal(data.address, 'unavailable');
    assert.ok(data.results.some(r => /Doheny/.test(r.label)));
  } finally { globalThis.fetch = real; }
});

test('a house number openrouteservice lacks comes from the Census geocoder, first; the bare street is marked approximate', async () => {
  const real = globalThis.fetch; const hosts = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url); hosts.push(u.host);
    if (u.host === 'api.openrouteservice.org')
      return new Response(JSON.stringify({features: [{geometry: {type: 'Point', coordinates: [-118.3039, 34.0237]}, properties: {layer: 'street', label: 'West 36th Place, Los Angeles, CA, USA'}}]}));
    assert.equal(u.searchParams.get('address'), '1200 W 36th Pl, Los Angeles, CA');
    return new Response(JSON.stringify({result: {addressMatches: [{matchedAddress: '1200 W 36TH PL, LOS ANGELES, CA, 90007', coordinates: {x: -118.2905, y: 34.0219}}]}}));
  };
  try {
    const {data} = await geocode('1200 W 36th Pl', {ORS_API_KEY: 'k'});
    assert.deepEqual(hosts, ['api.openrouteservice.org', 'geocoding.geo.census.gov']);
    const addr = data.results.filter(r => r.kind === 'address' || r.kind === 'street');
    assert.deepEqual(addr.map(r => [r.kind, r.label]), [['address', '1200 W 36th Pl, Los Angeles, CA, 90007'], ['street', 'West 36th Place, Los Angeles, CA, USA']]);
  } finally { globalThis.fetch = real; }
});

test('no Census call without a house number, or when openrouteservice already found the address', async () => {
  const real = globalThis.fetch; const hosts = [];
  globalThis.fetch = async (url) => { hosts.push(new URL(url).host);
    return new Response(JSON.stringify({features: [{geometry: {type: 'Point', coordinates: [-118.2827, 34.0256]}, properties: {layer: 'address', label: '3500 S Figueroa St, Los Angeles, CA, USA'}}]})); };
  try {
    await geocode('3500 Figueroa', {ORS_API_KEY: 'k'});
    await geocode('Figueroa Street', {ORS_API_KEY: 'k'});
    assert.deepEqual(hosts, ['api.openrouteservice.org', 'api.openrouteservice.org']);
  } finally { globalThis.fetch = real; }
});
