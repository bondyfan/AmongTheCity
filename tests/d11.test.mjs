// js/d11.js: the D11 / D35 facts every round 8 package reads. What no
// screenshot shows:
//   · a baked line a metre off the tile ribbon puts every sign, barrier and
//     AI lane a metre off the road;
//   · a km that runs backwards for 50 m makes "exit in 400 m" count up;
//   · an exit whose number disagrees with the km board beside it;
//   · a table row twice (two gantries, two rest areas);
//   · anything in the import graph that touches three or the DOM kills the
//     mesh worker.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const M = await import('../js/d11.js');
const { d11At, d11Locate, d11Line, kmRange, exitAhead, exitNear, restAhead, onBridge,
  EXITS, REST, ECODUCTS, D35_SHARED, D11_WORLD_END_KM, UP, ROAD, LOCATE_R } = M;
const roadpatches = await import('../js/roadpatches.js');

const tile = (k) => JSON.parse(readFileSync(new URL(`../public/data/tiles/${k}.json`, import.meta.url), 'utf8'));
// Beranka, Kluk / the Labe, ecoduct Žehuň, ecoduct Voleč (two tiles), Sedlice,
// Kukleny, the D35 at Časy
const TILES = ['-17_-2', '-10_-3', '-7_-3', '-4_-3', '-3_-3', '-1_-3', '0_-4', '2_-1'];
const tiles = Object.fromEntries(TILES.map((k) => [k, tile(k)]));
const CWS = ['E', 'W', 'S', 'N'];

// distance from (x, z) to carriageway cw, brute force
function distTo(cw, x, z) {
  const q = d11Line(cw);
  let best = Infinity, bk = 0;
  for (let i = 0; i + 1 < q.n; i++) {
    const ax = q.x[i], az = q.z[i], ex = q.x[i + 1] - ax, ez = q.z[i + 1] - az, L2 = ex * ex + ez * ez || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2));
    const d = Math.hypot(x - ax - ex * t, z - az - ez * t);
    if (d < best) { best = d; bk = q.km[i] + (q.km[i + 1] - q.km[i]) * t; }
  }
  return { d: best, km: bk };
}
const segDist = (x, z, a, b) => {
  const ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez || 1e-9;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L2));
  return Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t);
};

test('the module and its data import nothing that touches three or the DOM', () => {
  for (const f of ['d11.js', 'd11lines.js', 'd11data.js']) {
    const src = readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    // the lines live apart from the tables (400 line rule): both plain data
    assert.deepEqual(imports, f === 'd11.js' ? ['./d11lines.js', './d11data.js'] : [], `${f} imports ${imports}`);
    assert.ok(!/\b(document|window|THREE|OffscreenCanvas|Math\.random|Date\.now|performance\.now)\b/.test(src.replace(/\/\/.*$/gm, '')),
      `${f} touches the DOM, three, randomness or the clock`);
    assert.ok(!src.includes('\u2014'), `${f} has an em dash`);
  }
});

test('every tile motorway way on a carriageway lies within 0.5 m of the baked line, and the line on the tile ways', () => {
  let ways = 0;
  for (const [k, T] of Object.entries(tiles)) {
    const mw = T.roads.filter((r) => r.t === 'motorway');
    for (const r of mw) {
      // which line is this way on (all its vertices within 3 m of one)?
      const cw = CWS.find((c) => r.p.every((q) => distTo(c, q[0], q[1]).d < 3));
      if (!cw) continue;
      ways++;
      for (const q of r.p) assert.ok(distTo(cw, q[0], q[1]).d <= 0.5, `${k}: a ${cw} vertex ${q} is off the line`);
    }
    // the other way round: the line inside this tile follows a tile way of
    // the SAME carriageway (a way of a neighbour tile may reach into this
    // square: such points are > 5 m from this tile's own ways and skipped,
    // but most must be covered, and none may be 0.5 to 5 m off)
    for (const cw of CWS) {
      const own = mw.filter((r) => r.p.every((q) => distTo(cw, q[0], q[1]).d < 3));
      if (!own.length) continue;
      const q = d11Line(cw);
      let seen = 0, hit = 0;
      for (let i = 0; i + 1 < q.n; i++) {
        const L = Math.hypot(q.x[i + 1] - q.x[i], q.z[i + 1] - q.z[i]);
        for (let s = 0; s < L; s += 25) {
          const x = q.x[i] + (q.x[i + 1] - q.x[i]) * s / L, z = q.z[i] + (q.z[i + 1] - q.z[i]) * s / L;
          if (Math.floor(x / 4800) + '_' + Math.floor(z / 4800) !== k) continue;
          seen++;
          let d = Infinity;
          for (const r of own) for (let j = 0; j + 1 < r.p.length; j++) d = Math.min(d, segDist(x, z, r.p[j], r.p[j + 1]));
          if (d > 5) continue;
          // just past the end of this tile's way the next one (of a tile not
          // loaded here) carries on: the gap between them is that way's job
          if (d > 0.5 && own.some((r) => [r.p[0], r.p[r.p.length - 1]].some((e) => Math.hypot(e[0] - x, e[1] - z) < 5))) continue;
          assert.ok(d <= 0.5, `${k}: the ${cw} line at ${x.toFixed(1)},${z.toFixed(1)} is ${d.toFixed(2)} m from its tile way`);
          hit++;
        }
      }
      assert.ok(hit >= 0.6 * seen, `${k} ${cw}: only ${hit} of ${seen} points on this tile's ways`);
    }
  }
  assert.ok(ways > 60, `only ${ways} tile ways matched`);
});

test('km runs one way on every carriageway: up on E and S, down on W and N', () => {
  for (const cw of CWS) {
    const q = d11Line(cw);
    for (let i = 1; i < q.n; i++) {
      if (q.s[i] === q.s[i - 1]) continue;
      assert.ok((q.km[i] - q.km[i - 1]) * UP[cw] > 0, `${cw} km goes back at vertex ${i} (${q.km[i - 1]} -> ${q.km[i]})`);
    }
  }
  const [e0, e1] = kmRange('E'), [w0, w1] = kmRange('W');
  assert.ok(e0 > -0.6 && e0 < 0, `E starts at km ${e0}`);
  assert.ok(w0 > 0 && w0 < 1 && e1 > 110 && w1 > 110);
  // (exit numbers are the km rounded to the nearest since round 8: Sedlice 127 at km 126.9)
  assert.ok(kmRange('S')[0] > 126.0 && kmRange('S')[0] < 126.7, 'the D35 leaves the D11 at its km 127');
});

test('W and N take their km from the nearest point of E and S', () => {
  for (const [cw, ref] of [['W', 'E'], ['N', 'S']]) {
    const q = d11Line(cw);
    for (let i = 0; i < q.n; i += 7) {
      const r = distTo(ref, q.x[i], q.z[i]);
      if (r.d > 60) continue;   // far apart (the ends); the windowed walk is then only approximately nearest
      assert.ok(Math.abs(r.km - q.km[i]) < 0.002, `${cw} vertex ${i}: ${q.km[i]} vs nearest ${ref} ${r.km}`);
    }
  }
});

// Round 8 (SIGNS) settled the exit number as the km rounded to the NEAREST
// (js/d11.js D11_KM says why), which moved every anchor 0.5 km down: the
// window that was [N - 0.2, N + 1.0] under "rounded down" is the same set of
// diverges as [N - 0.7, N + 0.5] now.
test('each exit diverges between km N - 0.7 and N + 0.5 (the exit number is the km)', () => {
  for (const e of EXITS) {
    for (const cw of ROAD.E === e.road ? ['E', 'W'] : ['S', 'N']) {
      const s = e[cw];
      if (!s) continue;
      // exit 1 is the D0 interchange the motorway begins in: its slips straddle km 0
      if (e.road === 'D11' && e.n === 1) { assert.ok(s.div.km > -0.6 && s.div.km < 1); continue; }
      assert.ok(s.div.km >= e.n - 0.7 && s.div.km <= e.n + 0.5, `${e.id} ${cw} diverges at km ${s.div.km}`);
      if (s.mer) assert.ok(Math.abs(s.mer.km - e.km) < 1.2, `${e.id} ${cw} merges at ${s.mer.km}, far from its centre`);
    }
  }
});

test('every table point lies on its own carriageway at the km the table gives', () => {
  const pts = [];
  for (const e of EXITS) for (const cw of CWS) if (e[cw]) for (const k of ['div', 'mer', 'alt']) if (e[cw][k]) pts.push([e.id, cw, e[cw][k]]);
  for (const r of REST) for (const cw of CWS) if (r[cw]) for (const k of ['div', 'mer']) if (r[cw][k]) pts.push([r.id, cw, r[cw][k]]);
  assert.ok(pts.length > 100);
  for (const [id, cw, p] of pts) {
    const r = distTo(cw, p.x, p.z);
    assert.ok(r.d < 0.3, `${id} ${cw}: ${p.x},${p.z} is ${r.d.toFixed(2)} m off its line`);
    assert.ok(Math.abs(r.km - p.km) < 0.002, `${id} ${cw}: km ${p.km} but the line says ${r.km}`);
  }
  for (const e of ECODUCTS) for (const cw of ['E', 'W']) {
    for (const p of [e[cw].a, e[cw].b]) assert.ok(distTo(cw, p[0], p[1]).d < 0.05, `${e.id} ${cw} hole end off the line`);
    assert.ok(e[cw].km0 < e[cw].km1 && Math.abs((e[cw].km0 + e[cw].km1) / 2 - e.km) < 0.01);
  }
});

test('the ecoduct hole ends are the tile way ends, and any ecoduct patch runs along the line', () => {
  const ends = [];
  for (const k of ['-7_-3', '-4_-3', '-3_-3']) for (const r of tiles[k].roads) if (r.t === 'motorway') ends.push(r.p[0], r.p[r.p.length - 1]);
  for (const e of ECODUCTS) for (const cw of ['E', 'W']) {
    for (const p of [e[cw].a, e[cw].b]) assert.ok(ends.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.05), `${e.id} ${cw}: ${p} is no tile way end`);
    assert.ok(Math.abs(Math.hypot(e[cw].b[0] - e[cw].a[0], e[cw].b[1] - e[cw].a[1]) - e.deck) < 5, `${e.id}: the hole is not the deck`);
  }
  // js/roadpatches.js (LANES) fills the holes; when its patches are there they
  // must lie on these lines (both packages describe the same carriageway)
  for (const { road } of roadpatches.roadPatches()) {
    if (road.t !== 'motorway') continue;
    const cw = ['E', 'W'].find((c) => road.p.every((q) => distTo(c, q[0], q[1]).d < 3));
    assert.ok(cw, 'a motorway patch is on neither carriageway');
    for (const q of road.p) assert.ok(distTo(cw, q[0], q[1]).d < 0.5, `patch vertex ${q} is off the ${cw} line`);
  }
});

test('d11Locate round-trips d11At, and off is + to the right of travel', () => {
  const out = {};
  for (const cw of CWS) {
    const [k0, k1] = kmRange(cw);
    for (let km = Math.ceil(k0 * 4) / 4; km < k1; km += 0.25) {
      const p = d11At(km, cw);
      assert.ok(p, `${cw} ${km}`);
      assert.ok(Math.abs(Math.hypot(p.dx, p.dz) - 1) < 1e-9);
      const L = d11Locate(p.x, p.z, out);
      assert.equal(L, out, 'out is filled, not a new object');
      if (L.cw !== cw) {
        // only where two lines share a point (the D35 split, the D35 joining E)
        assert.ok(distTo(L.cw, p.x, p.z).d < 0.01, `${cw} km ${km} located on ${L.cw}`);
        continue;
      }
      assert.equal(L.road, ROAD[cw]);
      assert.ok(Math.abs(L.km - km) < 1e-3, `${cw} km ${km} came back as ${L.km}`);
      assert.ok(Math.abs(L.off) < 1e-6);
      // 3 m to the right of travel is the right (-dz, dx); heading east the right is south (+z)
      const R = d11Locate(p.x - p.dz * 3, p.z + p.dx * 3);
      if (R && R.cw === cw) assert.ok(Math.abs(R.off - 3) < 0.05, `${cw} ${km}: off ${R.off}`);
    }
  }
  // eastbound near Kostelní Lhota the motorway runs east: right is +z
  const p = d11At(30, 'E');
  assert.ok(p.dx > 0.9);
  assert.ok(d11Locate(p.x, p.z + 2).off > 0);
  assert.equal(d11Locate(p.x, p.z - LOCATE_R - 20), null, 'far from every line is null');
  assert.equal(d11Locate(-95270, -5517), null, 'Václavské náměstí is not the D11');
  assert.equal(d11At(-5, 'E'), null);
  assert.equal(d11At(200, 'W'), null);
});

test('exitAhead, restAhead, exitNear and onBridge', () => {
  assert.equal(exitAhead(60, 'E').n, 62);
  assert.equal(exitAhead(60, 'W').n, 50);
  assert.equal(exitAhead(67.5, 'E').n, 68, 'the gore of 68 eastbound is at 67.75');
  assert.equal(exitAhead(140, 'S').n, 144, 'the Pardubice exit');
  assert.equal(exitAhead(140, 'N').n, 139);
  assert.equal(restAhead(30, 'E').id, 'vrbova-lhota');
  assert.equal(restAhead(85, 'W').id, 'osice');
  const e68 = EXITS.find((e) => e.id === 'd11-68');
  assert.equal(exitNear(e68.E.div.x + 5, e68.E.div.z, 50), e68);
  assert.equal(exitNear(-95270, -5517, 150), null);
  // (km 0.5 lower than in wave 0: nearest-rounded exit numbers, see above)
  assert.ok(onBridge(60.0, 'E') && !onBridge(58.5, 'E'), 'the 566 m Cidlina bridge between 50 and 62');
  assert.ok(onBridge(41.7, 'W'), 'the Labe bridge at Poděbrady');
});

test('tables: unique ids, km order, sane fields', async () => {
  for (const list of [EXITS, REST, ECODUCTS]) {
    const ids = list.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate id');
    assert.ok(Object.isFrozen(list) && Object.isFrozen(list[0]));
  }
  for (const road of ['D11', 'D35']) {
    const ex = EXITS.filter((e) => e.road === road);
    for (let i = 1; i < ex.length; i++) assert.ok(ex[i].km > ex[i - 1].km && ex[i].n > ex[i - 1].n, `${road} exits out of order at ${ex[i].id}`);
    const rs = REST.filter((r) => r.road === road);
    for (let i = 1; i < rs.length; i++) assert.ok(rs[i].km > rs[i - 1].km);
  }
  assert.deepEqual(EXITS.filter((e) => e.road === 'D11' && !e.outside).map((e) => e.n), [1, 8, 18, 25, 35, 39, 42, 50, 62, 68, 76, 84, 90, 95]);
  assert.deepEqual(EXITS.filter((e) => e.road === 'D35').map((e) => e.n), [127, 131, 139, 144, 148, 157]);
  for (const e of EXITS) {
    if (e.id !== 'd11-1') assert.ok(e.km >= e.n - 0.6 && e.km <= e.n + 0.5, `${e.id} centre at ${e.km}`);
    assert.equal(!!e.outside, e.road === 'D11' && e.km > D11_WORLD_END_KM);
    for (const cw of CWS) if (e[cw]) {
      assert.ok(e[cw].to.length && e[cw].thru.length, `${e.id} ${cw} has no text`);
      for (const r of e[cw].refs) assert.match(r, /^(D\d+|I{1,3}\/\d+)$/);
    }
  }
  const { BRIDGES } = await import('../js/d11data.js');
  for (const cw of CWS) {
    const b = BRIDGES[cw];
    assert.ok(b.length > 25, `${cw}: ${b.length} bridges`);
    for (let i = 0; i < b.length; i++) {
      assert.ok(b[i][1] > b[i][0]);
      if (i) assert.ok(b[i][0] > b[i - 1][1], `${cw} bridges overlap at ${b[i]}`);
    }
  }
  assert.ok(D35_SHARED[0] > 84 && D35_SHARED[1] < 95.5 && D35_SHARED[1] > 94.5);
  const end = d11At(D11_WORLD_END_KM, 'E');
  assert.ok(Math.abs(end.z + 28800) < 0.5, 'the world ends at the edge of tile 1_-6');
});
