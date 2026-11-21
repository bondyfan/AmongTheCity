// js/regions.js: more than one world. What no screenshot shows:
//   · a Czech page that is not byte-for-byte the Czech world it always was
//     (another folder, another frame, another clock) breaks every save;
//   · a Mahé frame that overlaps the Czech one lets a hand-measured Pardubice
//     corner (the station hall, the D35) turn up in Victoria;
//   · a hand-over that survives a second reload drops a plane into a game that
//     was never flying, and one for the wrong region lands it in the sea;
//   · the build scripts and the runtime disagreeing on the frame put every
//     tile a few metres off its terrain.
import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const R = await import('../js/regions.js');
const { REGIONS, project, unproject, regionIdFrom, regionHref, enterRegion, takeArrival,
  laneSide, todShift, spawnPose, dataUrl, metresPerDegree, setCarryHook } = R;

test('the URL decides the region; anything else is the Czech world', () => {
  assert.equal(regionIdFrom(''), 'cz');
  assert.equal(regionIdFrom('?region=mahe'), 'mahe');
  assert.equal(regionIdFrom('?devmode&region=MAHE&x=1'), 'mahe');
  assert.equal(regionIdFrom('?region=atlantis'), 'cz');
  assert.equal(regionIdFrom('?regionx=mahe'), 'cz');
});

test('the Czech region is the world as it always was', () => {
  const cz = REGIONS.cz;
  assert.equal(cz.data, 'data/');
  assert.equal(dataUrl('terrain/0_0.bin', cz), 'data/terrain/0_0.bin');
  assert.equal(laneSide(cz), 1);
  assert.equal(todShift(cz), 0);
  assert.deepEqual(cz.sun, { rise: 5, set: 21, peak: 75, dip: 40 });   // sky.js's old constants
  // the frame of every Czech file: the committed manifest's own numbers
  const m = JSON.parse(readFileSync(new URL('../public/data/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(cz.origin, m.origin);
  const k = metresPerDegree(cz.origin.lat);
  assert.equal(+k.mPerLat.toFixed(1), m.mPerLat);
  assert.equal(+k.mPerLon.toFixed(1), m.mPerLon);
  const p = project(50.0317084, 15.7560881, cz);
  assert.ok(Math.abs(p.x) < 1e-9 && Math.abs(p.z) < 1e-9);
});

test('projection round-trips, and Mahé lies far from every Czech coordinate', () => {
  const mahe = REGIONS.mahe;
  for (const [lat, lon] of [[-4.62, 55.45], [-4.55, 55.40], [-4.81, 55.53], [-4.6742, 55.5219]]) {
    const p = project(lat, lon, mahe), q = unproject(p.x, p.z, mahe);
    assert.ok(Math.abs(q.lat - lat) < 1e-9 && Math.abs(q.lon - lon) < 1e-9);
  }
  // north tip, south tip, west and east coasts
  const n = project(-4.55, 55.45, mahe), s = project(-4.80, 55.50, mahe);
  const w = project(-4.65, 55.37, mahe), e = project(-4.65, 55.55, mahe);
  // the Czech world's tiles end at z -28.8 km: Mahé starts 50 km further north
  assert.ok(s.z < -28800 - 50000, 'south tip z ' + s.z);
  assert.ok(n.z > -130000, 'north tip within float32 7.8 mm precision');
  // and is the right size: about 27 km north to south, 20 km across here
  assert.ok(Math.abs((s.z - n.z) - 27645) < 300, 'length ' + (s.z - n.z));
  assert.ok(Math.abs((e.x - w.x) - 19970) < 300, 'width ' + (e.x - w.x));
  // a kilometre is a kilometre: 0.01 degree of latitude at 4.6 S
  const a = project(-4.60, 55.45, mahe), b = project(-4.61, 55.45, mahe);
  assert.ok(Math.abs((b.z - a.z) - 1105.8) < 1);
});

test('Mahé keeps left, runs on Seychelles time, and has its own folder and sun', () => {
  const mahe = REGIONS.mahe;
  assert.equal(laneSide(mahe), -1);
  assert.equal(todShift(mahe), 3 / 24);   // UTC+4 against the shared clock's UTC+1
  assert.equal(dataUrl('manifest.json', mahe), 'data/regions/mahe/manifest.json');
  assert.equal(mahe.czech, false);
  assert.equal(mahe.ortho, false);
  assert.ok(mahe.sun.set - mahe.sun.rise > 12 && mahe.sun.set - mahe.sun.rise < 12.6, 'an equatorial day');
});

test('the build scripts project exactly as the runtime does', () => {
  const src = `import('./scripts/lib/world-area.mjs').then((w) => console.log(JSON.stringify({
    o: w.ORIGIN, off: w.OFFSET, a: w.M_PER_LAT, b: w.M_PER_LON,
    p: [w.xOf(55.5219), w.zOf(-4.6742)], t: w.wantedTiles().length })))`;
  const cwd = new URL('..', import.meta.url);
  for (const id of ['cz', 'mahe']) {
    const out = JSON.parse(execFileSync(process.execPath, ['-e', src], { cwd, env: { ...process.env, ATC_REGION: id } }).toString());
    const r = REGIONS[id];
    assert.deepEqual(out.o, r.origin);
    assert.deepEqual(out.off, r.offset ?? { x: 0, z: 0 });
    const k = metresPerDegree(r.origin.lat);
    assert.equal(out.a, k.mPerLat);
    assert.equal(out.b, k.mPerLon);
    const p = project(-4.6742, 55.5219, r);
    assert.ok(Math.abs(out.p[0] - p.x) < 1e-6 && Math.abs(out.p[1] - p.z) < 1e-6);
    if (id === 'cz') assert.equal(out.t, 351);   // the committed world, unchanged
    else assert.ok(out.t > 20 && out.t < 60, 'Mahé tiles ' + out.t);
  }
});

// a page as enterRegion and takeArrival see it
function fakeEnv(href) {
  const store = new Map();
  return {
    assigned: null,
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    location: { href, assign(u) { this.owner.assigned = u; } },
    store,
  };
}

test('a crossing writes the hand-over, keeps the other parameters, and lands once', () => {
  const env = fakeEnv('https://amongthecity.pages.dev/?devmode&coop=1');
  env.location.owner = env;
  setCarryHook(() => ({ money: 1234 }));
  const h = enterRegion('mahe', 'sez-arrival', { flight: { no: 'OK 7400', tod: 0.6 } }, env);
  setCarryHook(null);
  const u = new URL(env.assigned);
  assert.equal(u.searchParams.get('region'), 'mahe');
  assert.ok(u.searchParams.has('devmode') && u.searchParams.get('coop') === '1');
  assert.deepEqual(h.pose, spawnPose('mahe', 'sez-arrival'));
  assert.equal(h.carry.live.money, 1234);
  assert.equal(h.carry.flight.no, 'OK 7400');
  // the page that loads is Mahé: it takes the hand-over once
  R._setRegionForTest('mahe');
  try {
    const a = takeArrival(env, h.t + 30000);
    assert.equal(a.to, 'mahe');
    assert.deepEqual(a.pose, h.pose);
    assert.equal(takeArrival(env, h.t + 30001), null, 'a second reload is an ordinary boot');
  } finally { R._setRegionForTest(null); }
});

test('a stale or misdirected hand-over is ignored', () => {
  const env = fakeEnv('https://x.test/');
  env.location.owner = env;
  const h = enterRegion('mahe', { x: 1, z: -100000, heading: 0 }, {}, env);
  R._setRegionForTest('mahe');
  try { assert.equal(takeArrival(env, h.t + 10 * 60000), null, 'ten minutes later'); }
  finally { R._setRegionForTest(null); }
  enterRegion('mahe', 'victoria', {}, env);
  R._setRegionForTest('cz');   // the back button: a Czech page finds Mahé's hand-over
  try { assert.equal(takeArrival(env), null); }
  finally { R._setRegionForTest(null); }
  assert.throws(() => enterRegion('mahe', 'nowhere', {}, env));
  assert.throws(() => enterRegion('atlantis', 'victoria', {}, env));
});

test('going home drops the region parameter', () => {
  assert.equal(regionHref('cz', 'https://x.test/?region=mahe&devmode'), 'https://x.test/?devmode');
  assert.equal(regionHref('mahe', 'https://x.test/'), 'https://x.test/?region=mahe');
});

test('the SEZ airport and the arrival spawn are on Mahé', () => {
  const a = REGIONS.mahe.airport, r = a.runway.ends;
  const len = Math.hypot(r['31'].x - r['13'].x, r['31'].z - r['13'].z);
  assert.ok(Math.abs(len - 2987) < 60, 'runway length ' + len);
  const arr = spawnPose('mahe', 'sez-arrival');
  // on the extended centreline, short of the 13 threshold, flying along it
  const dx = r['31'].x - r['13'].x, dz = r['31'].z - r['13'].z;
  const fx = -Math.sin(arr.heading), fz = -Math.cos(arr.heading);
  assert.ok((fx * dx + fz * dz) / len > 0.999, 'heading along the runway');
  const ax = r['13'].x - arr.x, az = r['13'].z - arr.z;
  assert.ok(Math.abs(ax * dz - az * dx) / len < 30, 'on the centreline');
  assert.ok(arr.y > 300 && arr.y < 900);
});

test('a death on Mahé wakes you in Victoria, a death in Pardubice in Pardubice', async () => {
  const { nearestHospital } = await import('../js/startplace.js');
  const cz = nearestHospital(100, 100);
  assert.equal(cz.name, 'Pardubická nemocnice');
  R._setRegionForTest('mahe');
  try {
    const h = nearestHospital(5000, -90000);
    assert.equal(h.name, 'Seychelles Hospital');
    assert.ok(Math.abs(h.z - -100000) < 15000, 'on the island');
  } finally { R._setRegionForTest(null); }
});
