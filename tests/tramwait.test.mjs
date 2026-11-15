// ---- people at the tram stops, rockets at the trams, Prague's city buses -------
// js/tramwait.js gives the crowd the three answers it already asks of a bus
// (when is the next one due here, which one stands here with its doors open,
// is a late one coming) for the tram platforms, and the platforms as STOP
// sites. js/trams.js blast() stops a tram caught in a rocket's blast. And
// js/realines.js headwayOf runs Prague's PID city buses as town buses.
//
//   every built line puts its platforms down as STOP sites, off the rail;
//   the next tram due at a platform is a pure function of the timetable (the
//     same from two fleets that read the files in opposite order), never in
//     the past, and a tram does call then;
//   a tram standing at its platform with the doors open is handed out as a
//     stand-in on one of its doors, still, and not once the doors close;
//   a blast stops a tram where it is for its stun, then it drives on;
//   PID city buses (100 to 299) run as town buses, suburban ones do not.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register(new URL('./three-alias.mjs', import.meta.url));

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROUTES = path.join(ROOT, 'public/data/routes');
const T = await import('../js/tramlines.js');
const { Trams } = await import('../js/trams.js');
const { TramWait } = await import('../js/tramwait.js');
const { SiteIndex, SITE } = await import('../js/crowdsites.js');
const { headwayOf } = await import('../js/realines.js');
const files = readdirSync(ROUTES).map((f) => JSON.parse(readFileSync(path.join(ROUTES, f), 'utf8')));
const T0 = 17_899_320 + 1800;
const OLD_TOWN = { x: -95636, z: -6206 };

function setup(order = 1) {
  let wt = T0;
  const trams = new Trams({ clock: () => wt });
  const peds = { sites: new SiteIndex(), drive: null };
  const wait = new TramWait(trams, peds);
  for (const file of order > 0 ? files : [...files].reverse()) for (const r of file.routes) trams.addRoute(file, r);
  for (let i = 0; i < 16; i++) { trams._t = 0; trams.update(0, OLD_TOWN, 0.5); }
  // the platforms within reach of the player are put down (there is no ground to wait for here)
  for (const at of [OLD_TOWN, { x: -95330, z: -5590 }, { x: -95035, z: -6337 }, { x: -96140, z: -5530 }]) { wait._placeN = 0; wait.update(at); }
  return { trams, peds, wait, step(dt) { wt += dt; trams.update(dt, OLD_TOWN, 0.5); wait.update(OLD_TOWN); }, now: () => wt };
}

const sitesOf = (peds) => { const out = []; for (const a of peds.sites.m.values()) for (const s of a) if (s.tram) out.push(s); return out; };

test('the platforms of the built lines are STOP sites beside the rail, and the next tram due is pure', () => {
  const a = setup(1), b = setup(-1);
  const sa = sitesOf(a.peds);
  assert.ok(sa.length >= 20, `${sa.length} tram platforms`);
  assert.deepEqual(sa.map((s) => s.sid).sort(), sitesOf(b.peds).map((s) => s.sid).sort(), 'the same platforms in the same places, whichever order the lines were built in');
  assert.ok(sa.every((s) => s.kind === SITE.STOP && s.spot), 'a STOP site with its spot');
  // off the rail they serve: a step to the right, or the mapped platform
  let near = 0, n = 0;
  for (const p of a.wait.plat.values()) {
    if (!p.site) continue;
    if (p.ax === p.px && p.az === p.pz) continue;          // (a platform mapped alone: it is the place itself)
    const d = Math.hypot(p.ax - p.site.x, p.az - p.site.z);
    n++;
    if (d > 1.6 && d < 14) near++;
  }
  assert.ok(near / n > 0.95, `${near} of ${n} platforms off the rail and near it`);
  let served = 0;
  for (const s of sa) {
    const e1 = a.wait.eta(s.x, s.z, T0), e2 = b.wait.eta(s.x, s.z, T0);
    assert.equal(e1, e2, 'the same next tram from either fleet');
    assert.equal(a.wait.eta(s.x, s.z, T0), e1, 'and every time it is asked');
    if (e1 < Infinity) { served++; assert.ok(e1 >= T0 && e1 < T0 + 1800, `due in ${e1 - T0} s`); }
  }
  assert.ok(served > sa.length * 0.8, `${served} of ${sa.length} platforms with a tram due`);
  assert.equal(a.wait.eta(OLD_TOWN.x, OLD_TOWN.z, T0), Infinity, 'no platform on the square');
});

test('a tram standing at its platform is handed out on a door while the doors are open', () => {
  const w = setup(1);
  let found = null;
  for (let i = 0; i < 600 && !found; i++) {
    w.step(0.25);
    for (const tr of w.trams.list) {
      if (!tr.stop || tr.hidden || tr.i === 0) continue;
      const p = w.wait.plat.get(tr.line.stops[tr.i].wk);
      if (!p?.site) continue;
      const c = w.wait.standingAt(p.site.x, p.site.z);
      if (c) { found = { tr, p, c }; break; }
    }
  }
  assert.ok(found, 'some tram stood at a platform with its doors open');
  const { tr, p, c } = found;
  assert.equal(c.speed, 0);
  assert.ok(Math.hypot(c.x - tr.x, c.z - tr.z) < tr.len + 1, 'the stand-in is on the tram');
  // the door it stands for: on the rail, within the body
  const q = { d: 0, a: 0 };
  T.pathAtExt(tr.line.P, tr.sr - c.door, q);
  assert.ok(Math.hypot(q.x - c.x, q.z - c.z) < 0.05);
  // once it has gone, nobody is handed it
  for (let i = 0; i < 400 && tr.stop; i++) w.step(0.25);
  for (let i = 0; i < 12; i++) w.step(0.25);
  const c2 = w.wait.standingAt(p.site.x, p.site.z);
  assert.ok(!c2 || !tr._stand.includes(c2), 'the tram that left is not standing there');
  if (!w.trams.live.has(tr.key)) assert.equal(c.speed, 99, 'a stand-in of a tram that is gone tells a boarder to give up');
});

test('a rocket blast stops a tram where it is, and it drives on afterwards', () => {
  const w = setup(1);
  for (let i = 0; i < 40; i++) w.step(0.25);
  const tr = w.trams.list.find((t) => !t.hidden && t.v > 4 && t.line.P.L - t.sr > 1500);
  assert.ok(tr, 'a tram under way');
  w.trams.blast(tr.x, tr.z, 6);
  const s0 = tr.sr;
  for (let i = 0; i < 40; i++) w.step(0.25);           // 10 s
  assert.ok(tr.sr - s0 < 0.01, `it moved ${(tr.sr - s0).toFixed(2)} m while stunned`);
  for (let i = 0; i < 160; i++) w.step(0.25);          // 40 s more
  assert.ok(tr.sr - s0 > 20, 'it drives on');
  // a tram well away from the blast is not stopped
  const other = w.trams.list.find((t) => !t.hidden && Math.hypot(t.x - tr.x, t.z - tr.z) > 300);
  w.trams.blast(tr.x, tr.z, 6);
  assert.ok(!(other.stunT > 0));
});

test('Prague city buses run as town buses, the suburban PID lines do not', () => {
  let city = 0, sub = 0;
  for (const f of files) for (const r of f.routes) {
    if (r.m !== 0 || !/Pražsk/.test(r.nw ?? '')) continue;
    const n = +r.ref, h = headwayOf(r);
    if (n >= 100 && n < 300 && (r.L ?? 0) <= 26000) { city++; assert.equal(h, 900, `line ${r.ref}`); }
    if (n >= 300 && n < 600) { sub++; assert.equal(h, 1800, `line ${r.ref}`); }
  }
  assert.ok(city > 250 && sub > 250, `${city} city and ${sub} suburban routes`);
  // nothing changes outside Prague: an MHD town bus and a regional coach
  assert.equal(headwayOf({ nw: 'MHD Pardubice', m: 0, L: 9000, ref: '3' }), 900);
  assert.equal(headwayOf({ nw: 'IDS Pardubického kraje', m: 0, L: 40000, ref: '650' }), 1800);
});
