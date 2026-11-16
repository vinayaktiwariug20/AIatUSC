import assert from 'node:assert/strict';
import test from 'node:test';
import {eventLink, buildingCode, buildingLabel, findBuilding} from '../outdoor/static/create/link.mjs';

const BASE = 'https://doorstep.example/create/';
const buildings = [
  {id: 'ronald-tutor-campus-center', name: 'Ronald Tutor Campus Center', aliases: ['TCC']},
  {id: 'dr-joseph-medicine-crow-center-for-international-and-public-affairs', name: 'Dr. Joseph Medicine Crow Center for International and Public Affairs', aliases: ['Medicine Crow', 'JMC', 'DMC']},
  {id: 'edward-l-doheny-junior-memorial-library', name: 'Edward L Doheny Junior Memorial Library', aliases: []},
];

test('a link carries the building and only the fields that were filled in', () => {
  assert.equal(eventLink(BASE, {building: 'ronald-tutor-campus-center'}), 'https://doorstep.example/?to=ronald-tutor-campus-center');
  const u = new URL(eventLink(BASE, {building: buildings[1].id, event: '  AI@USC  Showcase ', room: '258', roomLabel: 'Room 258', anchor: 'left-stair-1'}));
  assert.equal(u.pathname, '/');
  assert.equal(u.searchParams.get('event'), 'AI@USC Showcase');
  assert.equal(u.searchParams.get('room'), '258');
  assert.equal(u.searchParams.get('room_label'), 'Room 258');
  assert.equal(u.searchParams.get('anchor'), 'left-stair-1');
});

test('event name and room label are trimmed to their limits; a building is required', () => {
  const u = new URL(eventLink(BASE, {building: 'x', event: 'e'.repeat(200), roomLabel: 'r'.repeat(99)}));
  assert.equal(u.searchParams.get('event').length, 80);
  assert.equal(u.searchParams.get('room_label').length, 40);
  assert.throws(() => eventLink(BASE, {building: ' '}), /Choose a building/);
});

test('special characters survive the round trip', () => {
  const u = new URL(eventLink(BASE, {building: 'x', event: 'Café & Code #3 / "Night"'}));
  assert.equal(u.searchParams.get('event'), 'Café & Code #3 / "Night"');
});

test('codes and labels: "Name (CODE)" when a building has a short code', () => {
  assert.equal(buildingCode(buildings[0]), 'TCC');
  assert.equal(buildingCode(buildings[1]), 'JMC');                    // first short code
  assert.equal(buildingLabel(buildings[2]), 'Edward L Doheny Junior Memorial Library');
  assert.equal(buildingLabel(buildings[0]), 'Ronald Tutor Campus Center (TCC)');
});

test('what an organizer types resolves to one building: label, name, id or code', () => {
  for (const t of ['Ronald Tutor Campus Center (TCC)', 'ronald tutor campus center', 'ronald-tutor-campus-center', 'tcc', ' TCC '])
    assert.equal(findBuilding(buildings, t)?.id, 'ronald-tutor-campus-center', t);
  assert.equal(findBuilding(buildings, 'DMC')?.id, buildings[1].id);
  assert.equal(findBuilding(buildings, 'Tutor'), null);                 // partial text is not a choice
});
