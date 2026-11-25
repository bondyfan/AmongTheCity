// ---- the HUD disc: crisp tiles, a turning map, the route ahead ------------------
// Frank, 25 Nov 2026: "Minimapa je teďka taková rozmazaná, hnusná." The disc
// is now painted per chunk cell at its real resolution (js/maptiles.js),
// turns with the camera, zooms with speed and draws the route still ahead.
import test from 'node:test';
import assert from 'node:assert';

// A 2D context that records what is done to it and draws nothing.
function recCtx(log) {
  const o = { _log: log };
  return new Proxy(o, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return (s) => ({ width: String(s).length * 6 });
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop() {} });
      return (...a) => { log.push([k, t.strokeStyle, t.lineWidth, t.fillStyle, a]); };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
const logs = [];
globalThis.document ??= {
  createElement: () => {
    const log = [];
    logs.push(log);
    const ctx = recCtx(log);
    return { width: 0, height: 0, getContext: () => ctx, _log: log };
  },
};

const { viewRadiusFor, tilePpm, roadStyle, roadWidthM, VIEW_NEAR, VIEW_FAR, MAP } = await import('../js/mapstyle.js');
const { gatherTile, paintTile, MapTiles, TILE_M, tilePx, bleedPx } = await import('../js/maptiles.js');
const { MapWindow } = await import('../js/mapwindow.js');
const { uprightAngle } = await import('../js/minimaplabels.js');
const { Minimap } = await import('../js/minimap.js');
const { laneHalf, Navigation } = await import('../js/navigation.js');

// ---- a tiny city with a chunk index -----------------------------------------------
function cityOf(feats) {
  const city = { roads: [], buildings: [], green: [], water: [], paved: [], rails: [], waterways: [], chunkIndex: new Map() };
  let id = 1;
  const cell = (k) => {
    let c = city.chunkIndex.get(k);
    if (!c) city.chunkIndex.set(k, c = { roads: [], buildings: [], green: [], water: [], paved: [], rails: [] });
    return c;
  };
  for (const [kind, f] of feats) {
    f._id = id++;
    city[kind].push(f);
    const pts = f.p ?? f.o;
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
    for (const [x, z] of pts) { a = Math.min(a, x); c = Math.max(c, x); b = Math.min(b, z); d = Math.max(d, z); }
    for (let cx = Math.floor(a / TILE_M); cx <= Math.floor(c / TILE_M); cx++)
      for (let cz = Math.floor(b / TILE_M); cz <= Math.floor(d / TILE_M); cz++) cell(cx + ',' + cz)[kind].push(f);
  }
  return city;
}

test('the view widens with speed, smoothly, between its two radii', () => {
  assert.equal(viewRadiusFor(0), VIEW_NEAR);
  assert.equal(viewRadiusFor(5), VIEW_NEAR, 'walking and parking stay close');
  assert.equal(viewRadiusFor(60), VIEW_FAR);
  let last = 0;
  for (let v = 0; v <= 40; v += 0.5) {
    const r = viewRadiusFor(v);
    assert.ok(r >= last, 'never shrinks as speed grows');
    last = r;
  }
});

test('tile resolution follows the disc, quantised', () => {
  // a 220 css px disc on a Retina screen: ~218 device px of radius
  assert.equal(tilePpm(218), 2.25);
  assert.equal(tilePpm(109), 1.25);
  assert.equal(tilePpm(1), 0.75, 'floor');
  assert.equal(tilePpm(1e5), 3.25, 'ceiling');
});

test('roads are graded by class and drawn near their real width', () => {
  assert.ok(roadStyle('motorway').rank > roadStyle('primary').rank);
  assert.ok(roadStyle('primary').rank > roadStyle('residential').rank);
  assert.equal(roadStyle('primary_link').fill, roadStyle('primary').fill);
  assert.equal(roadStyle('nonsense'), roadStyle('residential'));
  assert.equal(roadWidthM({ t: 'residential', w: 7 }), 7);
  assert.equal(roadWidthM({ t: 'motorway' }), 22);
  assert.equal(roadWidthM({ t: 'service', w: 0.5 }), 3, 'clamped');
});

test('street names stay upright on a turning map', () => {
  for (let a = -Math.PI; a <= Math.PI; a += 0.3)
    for (let r = -Math.PI; r <= Math.PI; r += 0.4) {
      const t = uprightAngle(a, r);
      assert.ok(t >= -Math.PI / 2 - 1e-9 && t <= Math.PI / 2 + 1e-9, `${t}`);
      // the same line: differs from a + r by a multiple of π
      const d = (t - (a + r)) / Math.PI;
      assert.ok(Math.abs(d - Math.round(d)) < 1e-9);
    }
});

test('a tile gathers its neighbours\' lines and nothing far away', () => {
  const near = { d: 1, t: 'primary', w: 12, p: [[-50, 125], [-5, 125]] };     // stroke reaches in
  const far = { d: 1, t: 'primary', w: 12, p: [[-300, 300], [-250, 300]] };
  const inside = { d: 1, t: 'residential', p: [[10, 130], [100, 200]] };
  const house = { o: [[20, 140], [30, 140], [30, 150], [20, 150]] };
  const city = cityOf([['roads', near], ['roads', far], ['roads', inside], ['buildings', house]]);
  const L = gatherTile(city, 0, 1);
  assert.ok(L.roads.includes(near), 'a road just outside the cell is painted where it overlaps');
  assert.ok(L.roads.includes(inside));
  assert.ok(!L.roads.includes(far));
  assert.deepStrictEqual(L.buildings, [house]);
  assert.equal(new Set(L.roads).size, L.roads.length, 'each feature once');
});

test('casings first, fills by rank, bridges last', () => {
  const minor = { d: 1, t: 'residential', w: 6, p: [[0, 60], [120, 60]] };
  const major = { d: 1, t: 'primary', w: 12, p: [[60, 0], [60, 120]] };
  const bridge = { d: 1, t: 'secondary', w: 10, br: 1, p: [[0, 20], [120, 20]] };
  const city = cityOf([['roads', minor], ['roads', major], ['roads', bridge]]);
  const log = [];
  paintTile(recCtx(log), city, 0, 0, 2);
  const strokes = log.filter((e) => e[0] === 'stroke').map((e) => e[1]);
  const cas = MAP.casing, fills = [roadStyle('residential').fill, roadStyle('primary').fill];
  assert.deepStrictEqual(strokes.slice(0, 4), [cas, cas, fills[0], fills[1]]);
  assert.deepStrictEqual(strokes.slice(4), [MAP.bridgeCasing, roadStyle('secondary').fill]);
});

test('the tile cache paints missing before stale, nearest first, within budget', () => {
  const city = cityOf([['roads', { d: 1, t: 'residential', p: [[0, 0], [500, 0]] }]]);
  let t = 0;
  const tiles = new MapTiles(city, { ppm: 1, now: () => t, makeCanvas: (n) => ({ width: n, height: n, getContext: () => recCtx([]) }) });
  // every paint "costs" 1 ms on this clock
  const paint = tiles._paint.bind(tiles);
  tiles._paint = (...a) => { t += 1; paint(...a); };
  tiles.want(0, 0, 50); tiles.want(1, 0, 10); tiles.want(2, 0, 30);
  assert.equal(tiles.pump(0.5), 1, 'a budget under one tile still paints one');
  assert.ok(tiles.get(1, 0) && !tiles.get(0, 0), 'the nearest went first');
  tiles.want(0, 0, 50); tiles.want(1, 0, 10); tiles.want(2, 0, 30);
  assert.equal(tiles.pump(10), 2);
  // new data in cell 5,0 touches nothing cached; data in cell 1,0 makes 0..2 stale
  tiles.invalidateCells(new Set(['5,0']));
  assert.ok([...tiles.tiles.values()].every((x) => x.gen === tiles.gen));
  tiles.invalidateCells(['1,0']);
  assert.equal([...tiles.tiles.values()].filter((x) => x.gen !== tiles.gen).length, 3);
  // stale tiles stay drawable while they wait
  assert.ok(tiles.get(0, 0).cv);
  tiles.want(7, 7, 99); tiles.want(0, 0, 1);
  tiles.pump(0.5);
  assert.ok(tiles.get(7, 7), 'a MISSING tile beats a nearer stale one');
});

test('the cache evicts what nobody wants, never what is wanted now', () => {
  const city = cityOf([]);
  const tiles = new MapTiles(city, { ppm: 1, max: 4, makeCanvas: (n) => ({ width: n, height: n, getContext: () => recCtx([]) }) });
  for (let i = 0; i < 6; i++) { tiles.want(i, 0, i); tiles.pump(1e9); }
  assert.ok(tiles.tiles.size <= 4);
  assert.ok(tiles.get(5, 0), 'the newest is kept');
  tiles.setPpm(2);
  assert.equal(tiles.tiles.size, 0, 'a new resolution drops every canvas');
});

test('lane offsets ride along the route, one per point', () => {
  assert.equal(laneHalf({ ow: 1, w: 12 }), 0, 'a oneway carriageway is driven on its centre');
  assert.equal(laneHalf({ w: 8 }), 2);
  assert.equal(laneHalf({ w: 30 }), 4, 'capped');
  assert.equal(laneHalf({}), 1.5);
  const listeners = [];
  const city = { roads: [], onTileLoaded: (cb) => listeners.push(cb) };
  const nav = new Navigation(city);
  const roads = [
    { d: 1, t: 'residential', w: 8, v: 50, n: 'A', p: [[0, 0], [100, 0], [200, 0]] },
    { d: 1, t: 'primary', w: 12, ow: 1, v: 50, n: 'B', p: [[200, 0], [200, 150]] },
  ];
  for (const r of roads) city.roads.push(r);
  for (const cb of listeners) cb({ roads });
  nav.setDestination(200, 140);
  assert.ok(nav.reroute(10, 0));
  assert.equal(nav.routeOff.length, nav.route.length, 'aligned with the polyline');
  assert.equal(nav.routeOff[0], 2);
  assert.equal(nav.routeOff[nav.route.length - 1], 0);
  assert.equal(nav.routeCum.length, nav.route.length);
  assert.ok(Math.abs(nav.routeS) < 1e-6);
});

// ---- the whole disc, headless -------------------------------------------------------
test('the disc draws tiles, the route ahead and the turn arrow without throwing', () => {
  const roads = [
    { d: 1, t: 'secondary', w: 10, n: 'Hlavní', p: [[0, 0], [0, -300]] },
    { d: 1, t: 'residential', w: 7, n: 'Boční', p: [[0, -150], [200, -150]] },
  ];
  const city = cityOf(roads.map((r) => ['roads', r]));
  const log = [];
  const canvas = { width: 220, height: 220, clientWidth: 0, getContext: () => recCtx(log) };
  const mm = new Minimap(canvas, city);
  const route = [[0, 0], [0, -150], [200, -150]];
  const cum = new Float64Array([0, 150, 350]);
  mm.setRoute({ route, routeCum: cum, routeS: 70, routeI: 0, nextTurn: { dist: 80, dir: 'right' } });
  for (let i = 0; i < 30; i++) mm.update(0, -70, 0, [{ x: 5, z: -90 }], null, { body: 0, speed: 14 });
  assert.ok(mm.tiles.tiles.size > 0, 'tiles were painted');
  assert.ok(mm.win.copies > 0, 'and laid into the map picture');
  // the per-frame canvas never blits the map: the compositor moves the picture
  const mapCanvases = new Set([...mm.tiles.tiles.values()].map((t) => t.cv).concat(mm.win.cv));
  assert.equal(log.filter((e) => e[0] === 'drawImage' && mapCanvases.has(e[4][0])).length, 0,
    'no map blit on the frame canvas (only name sprites may be drawn there)');
  const copiesAfter = mm.win.copies;
  mm.update(0, -71, 0.2, [], null, { body: 0, speed: 14 });
  assert.equal(mm.win.copies, copiesAfter, 'a metre and a turn later nothing is copied again');
  // the route: glow, edge, blue, core; then the white arrow
  const strokes = log.filter((e) => e[0] === 'stroke').map((e) => e[1]);
  assert.ok(strokes.includes('#2f8cff'), 'the route blue was stroked');
  // (only the turn arrow's shaft is STROKED white; the player arrow is filled)
  assert.ok(strokes.includes('#ffffff'), 'the turn arrow was drawn');
  // backing store follows CSS size × DPR (no window here: DPR 1, size 220)
  assert.equal(canvas.width, 220);
});

test('nothing of the route behind the car reaches the disc', () => {
  const city = cityOf([]);
  const log = [];
  const canvas = { width: 200, height: 200, getContext: () => recCtx(log) };
  const mm = new Minimap(canvas, city);
  // a straight route north; the car is 100 m along it
  const route = [[0, 0], [0, -400]];
  mm.setRoute({ route, routeCum: new Float64Array([0, 400]), routeS: 100, routeI: 0, nextTurn: null });
  log.length = 0;
  mm.update(0, -100, 0, [], null, null);
  // heading 0 = north up, so the car sits at the centre and "behind" is BELOW it
  const pts = log.filter((e) => e[0] === 'moveTo' || e[0] === 'lineTo').map((e) => e[4]);
  const cy = 100;
  const routePts = pts.filter((p) => Math.abs(p[0] - 100) < 0.01);   // on the route's screen column
  assert.ok(routePts.length > 0);
  for (const p of routePts) assert.ok(p[1] <= cy + 0.01, `a route point at y ${p[1]} is behind the car`);
});

// ---- the map picture the compositor moves -------------------------------------------
function fakeTiles(ppm) {
  const map = new Map();
  return {
    ppm, map,
    get(tx, tz) { return map.get(tx + ',' + tz); },
    put(tx, tz) { const t = { cv: { id: tx + ',' + tz }, ver: 1 }; map.set(tx + ',' + tz, t); return t; },
  };
}
function fakeCanvas(log) {
  const ctx = recCtx(log);
  return { width: 0, height: 0, getContext: () => ctx };
}

test('tiles are laid 1:1 on whole pixels, and only again when repainted', () => {
  const ft = fakeTiles(2.25);
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) ft.put(i, j);
  const log = [];
  const cv = fakeCanvas(log);
  const w = new MapWindow(ft, cv, 5);
  assert.equal(w.update(10, 10), true);
  assert.equal(cv.width, Math.round(5 * TILE_M * 2.25), 'five cells at the tiles\' resolution');
  const draws = log.filter((e) => e[0] === 'drawImage');
  assert.equal(draws.length, 25);
  for (const d of draws) {
    const [, x, y, sw, sh] = d[4];
    assert.ok(Number.isInteger(x) && Number.isInteger(y), `copied at ${x}, ${y}`);
    assert.equal(sw, tilePx(2.25)); assert.equal(sh, tilePx(2.25));
  }
  // the centre cell lands in the middle slot, its bleed overlapping the neighbours
  const mid = draws.find((d) => d[4][0].id === '0,0');
  assert.deepStrictEqual(mid[4].slice(1, 3), [2 * 270 - bleedPx(2.25), 2 * 270 - bleedPx(2.25)]);
  log.length = 0;
  assert.equal(w.update(50, 60), false, 'same cell, nothing new: no work');
  assert.equal(log.length, 0);
  ft.get(1, 1).ver++;
  assert.equal(w.update(50, 60), true);
  assert.equal(log.filter((e) => e[0] === 'drawImage').length, 1, 'one repainted tile, one copy');
  log.length = 0;
  w.update(130, 10);                                  // into the next cell east
  assert.equal(w.tx0, -1, 're-laid around the new cell');
  assert.equal(log.filter((e) => e[0] === 'drawImage').length, 20, 'every cached tile of the new block');
});

test('the CSS transform puts the player at the centre, turned and zoomed', () => {
  const ft = fakeTiles(2);
  const w = new MapWindow(ft, fakeCanvas([]), 5);
  w.update(37, -55);
  // parse translate(c) rotate(r) scale(s) translate(-u) and apply it to the
  // player's own pixel in the picture: it must land on the centre
  const tr = w.cssTransform(37, -55, 0.7, 1.6, 2, 110);
  const num = tr.match(/-?\d+(\.\d+)?/g).map(Number);
  const [cx, cy, rot, sc, ux, uy] = num;
  const lx = (37 - w.x0) * 2 / 2, lz = (-55 - w.z0) * 2 / 2;   // CSS px in the picture
  const ax = (lx + ux) * sc, az = (lz + uy) * sc;
  const X = cx + ax * Math.cos(rot) - az * Math.sin(rot), Y = cy + ax * Math.sin(rot) + az * Math.cos(rot);
  assert.ok(Math.abs(X - 110) < 0.02 && Math.abs(Y - 110) < 0.02, `${X}, ${Y}`);
  assert.equal(sc, 0.8, 'scale = shown px per metre / painted px per metre');
  // a point 10 m north of the player, with the map turned by 0: straight up
  const t0 = w.cssTransform(37, -55, 0, 2, 2, 110).match(/-?\d+(\.\d+)?/g).map(Number);
  const nx = ((37 - w.x0) + t0[4]) * t0[3], nz = ((-65 - w.z0) + t0[5]) * t0[3];
  assert.ok(Math.abs(t0[0] + nx - 110) < 0.02 && Math.abs(t0[1] + nz - 100) < 0.02, '10 m north is 10 CSS px up at 2 px/m, dpr 2');
});
