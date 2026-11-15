// M4: keep Outdoor's four-parameter handoff intact. Never infer real room/door mappings.
const own = (object, key) => Object.hasOwn(object, key);
const find = (items, id) => items.find(item => item.id === id);

export function readContext(search, venue) {
  const query = new URLSearchParams(search);
  for (const key of ['building', 'entrance', 'anchor', 'room']) {
    if (query.getAll(key).length > 1) throw new Error(`Duplicate ${key} parameter.`);
  }
  const raw = Object.fromEntries(['building', 'entrance', 'anchor', 'room'].map(key => [key, query.get(key) || null]));
  if (raw.building && raw.building !== venue.buildingId && !venue.buildingAliases.includes(raw.building)) {
    throw new Error('Indoor navigation is available for JMC only. Return to the outdoor map.');
  }
  if (raw.entrance && !own(venue.entrances, raw.entrance)) throw new Error('This entrance is not registered for JMC.');
  const entrance = raw.entrance ? venue.entrances[raw.entrance] : null;
  const warnings = [];
  let start = null;
  if (entrance) {
    if (raw.anchor && raw.anchor !== entrance.outdoorAnchor) throw new Error('The entrance and start anchor do not match.');
    if (entrance.verified && entrance.source && entrance.anchorId) start = find(venue.anchors, entrance.anchorId);
    if (!start) warnings.push('This outdoor door has no confirmed indoor start mapping. Choose the Sample location that matches what you see.');
  } else if (raw.anchor) {
    start = find(venue.anchors, raw.anchor);
    if (!start) {
      const external = Object.values(venue.entrances).find(item => item.outdoorAnchor === raw.anchor);
      if (!external) throw new Error('Unknown start anchor. Return to the outdoor map or open the Sample test page.');
      if (external.verified && external.source) start = find(venue.anchors, external.anchorId);
      if (!start) warnings.push('The indoor start mapping is not confirmed. Choose your current Sample location.');
    }
  }
  let destination = null;
  if (raw.room) {
    destination = find(venue.destinations, raw.room);
    if (!destination) {
      const mapping = own(venue.rooms, raw.room) ? venue.rooms[raw.room] : null;
      if (mapping?.verified && mapping.source) destination = find(venue.destinations, mapping.destinationId);
      if (!destination) throw new Error(`Room "${raw.room}" has no verified indoor mapping. Your requested destination has been preserved; no substitute route was selected.`);
    }
  } else warnings.push('No room was supplied. Choose a Sample hallway to test navigation; these locations are not surveyed rooms.');
  return { buildingId: venue.buildingId, buildingName: venue.name, raw, start, destination, warnings };
}

export function resolveSelection(context, selection, venue, routing) {
  const start = context.start || find(venue.anchors, selection.anchorId);
  const destination = context.destination || find(venue.destinations, selection.destinationId);
  if (!start || !destination) throw new Error('Choose a start and a destination before navigating.');
  return {
    ...context, start, destination,
    startNodeId: routing.snap(start), destinationNodeId: routing.snap(destination),
    sample: start.kind === 'sample' || ['sample','demo'].includes(destination.kind),
    startSource: context.start ? 'handoff' : 'manual',
    destinationSource: context.destination ? 'event-link' : 'manual',
  };
}

export function outdoorLink(search, venue) {
  const incoming = new URLSearchParams(search), query = new URLSearchParams();
  query.set('to', incoming.get('building') || venue.buildingId);
  if (incoming.get('room')) query.set('room', incoming.get('room'));
  return '/?' + query;
}
