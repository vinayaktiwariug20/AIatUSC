// The attendee link for an event. Everything the attendee needs travels in the
// link itself: nothing is stored, and there is no account. Pure, so it is tested
// (tests/create.test.mjs).
//
//   to          building id (required)
//   event       event name shown to attendees (optional, <= 80 chars)
//   room        indoor room id, for buildings with an indoor map (optional)
//   room_label  what the flyer calls the room or meeting point (optional, <= 40)
//   anchor      where indoor directions start, instead of the door (optional)

export const LIMITS = {event: 80, room_label: 40};

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// How long attendees park, in hours: the values of the map page's "How long will you stay?" list.
export const STAYS = ['2', '4', '10'];

export function eventLink(base, {building, event = '', room = '', roomLabel = '', anchor = '', stay = ''} = {}) {
  const id = clean(building, 200);
  if (!id) throw new Error('Choose a building first.');
  const url = new URL('/', base);
  url.searchParams.set('to', id);
  const name = clean(event, LIMITS.event);
  if (name) url.searchParams.set('event', name);
  const r = clean(room, 40);
  if (r) url.searchParams.set('room', r);
  const label = clean(roomLabel, LIMITS.room_label);
  if (label) url.searchParams.set('room_label', label);
  const a = clean(anchor, 60);
  if (a) url.searchParams.set('anchor', a);
  if (STAYS.includes(String(stay))) url.searchParams.set('stay', String(stay));
  return url.toString();
}

/** The short code people use for a building ("DMC", "TCC"), if it has one. */
export function buildingCode(b) {
  return (b.aliases || []).find(a => /^[A-Z]{2,4}$/.test(a)) || '';
}

/** "Ronald Tutor Campus Center (TCC)": what the organizer sees in suggestions. */
export function buildingLabel(b) {
  const code = buildingCode(b);
  return code ? `${b.name} (${code})` : b.name;
}

/** Resolve what was typed (label, name, id or code) to a building, or null. */
export function findBuilding(buildings, text) {
  const t = clean(text, 200).toLowerCase();
  if (!t) return null;
  return buildings.find(b => buildingLabel(b).toLowerCase() === t)
    || buildings.find(b => b.id === t || b.name.toLowerCase() === t)
    || buildings.find(b => (b.aliases || []).some(a => a.toLowerCase() === t))
    || null;
}
