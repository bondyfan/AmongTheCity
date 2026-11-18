// The terrain survey follows the hill over a railway tunnel. The vector tiles
// omit the tunnel itself but sometimes retain a short piece between its mouth
// and the viaduct. Carry the viaduct's bank level through that piece.
import { geomOf, pointOn } from './corridorgeom.js';
import { CHUNK } from './config.js';

const indexed = new WeakMap();

export function forgetPortal(deck, end) {
  const old = indexed.get(deck)?.get(end);
  if (!old) return;
  for (const way of old.ways) if (way._portal === old.profile) {
    delete way._portal;
    way._prof = undefined;
  }
  indexed.get(deck).delete(end);
  if (deck._chain) deck._chain.profile = null;
}

export function indexPortalApproach(city, deck, end, approach, at) {
  if (deck.t !== 'rail' || approach.t !== 'rail') return;
  const L = geomOf(deck).L;
  if (L < 40) return;
  const ways = [];
  let way = approach, entry = at, length = 0, mouth;
  while (way) {
    const d = geomOf(way).L;
    length += d;
    if (length > 80 || (entry > 0.1 && entry < d - 0.1)) break;
    ways.push(way);
    mouth = entry < d / 2 ? way.p.at(-1) : way.p[0];
    const key = Math.floor(mouth[0] / CHUNK) + ',' + Math.floor(mouth[1] / CHUNK);
    const others = (city.chunkIndex.get(key)?.rails ?? []).filter(other => other !== way &&
      other.t === 'rail' && other.p?.some(p => p[0] === mouth[0] && p[1] === mouth[1]));
    if (!others.length) { way = null; break; }
    if (others.length !== 1 || others[0].br || ways.includes(others[0])) break;
    way = others[0];
    const i = way.p.findIndex(p => p[0] === mouth[0] && p[1] === mouth[1]);
    entry = geomOf(way).cum[i];
  }
  const previous = indexed.get(deck)?.get(end);
  if (!way && previous && previous.ways.length === ways.length && previous.ways.every((w, i) => w === ways[i])) return;
  forgetPortal(deck, end);
  if (way) return;
  const probe = pointOn(deck, end === 0 ? 40 : L - 40);
  const bank = end === 0 ? deck.p.at(-1) : deck.p[0];
  const profile = { bank, probe: [probe.x, probe.z], joint: deck.p[end], mouth };
  const item = { ways, profile };
  if (!indexed.has(deck)) indexed.set(deck, new Map());
  indexed.get(deck).set(end, item);
  for (const w of ways) { w._portal = profile; w._prof = undefined; }
  if (deck._chain) deck._chain.profile = null;
}

export function portalLevel(approach, terrain) {
  const p = approach?._portal;
  if (!p || !terrain) return null;
  const survey = q => terrain.heightAt(q[0], q[1]);
  if (terrain.ready && (!terrain.ready(...p.bank) || !terrain.ready(...p.probe) ||
      !terrain.ready(...p.joint) || !terrain.ready(...p.mouth))) return null;
  const bank = survey(p.bank), edge = survey(p.joint);
  return edge - survey(p.probe) > 6 && survey(p.mouth) > bank + 6 ? bank : null;
}
