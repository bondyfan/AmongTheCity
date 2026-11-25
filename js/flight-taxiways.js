// ---- flight-taxiways.js: a taxi route along the mapped taxiways ----
// Pure. At Pardubice the routes are written out vertex by vertex in
// js/airport-plan.js; at Seychelles International they are found in the Mahé
// region's own tile, so a narrowbody leaving the apron follows the taxiway OSM
// draws to the 13 end instead of cutting across the grass. The network is the
// tile's taxiway, taxilane and runway polylines: consecutive vertices are
// edges, vertices of two ways closer than a few metres are one junction, and a
// taxiway that stops short of the runway (OSM often ends it at the edge, not
// the centreline) is joined to the nearest point of the runway's line.
// Dijkstra over that is a few hundred nodes.

const KINDS = new Set(['taxiway', 'taxilane', 'runway']);
const JOIN = 4; // m: two vertices this close are one junction
const REACH = 40; // m: how far a taxiway's end may be from the runway line and still join it

export function taxiNetwork(roads) {
  const nodes = [], edges = [];
  const ways = roads.filter((r) => KINDS.has(r.t) && r.p?.length > 1);
  const nodeAt = (x, z, runway) => {
    // a junction is on the runway if ANY of its ways is (whichever way was read first)
    for (let i = 0; i < nodes.length; i++) if (Math.hypot(nodes[i].x - x, nodes[i].z - z) < JOIN) { if (runway) nodes[i].runway = true; return i; }
    nodes.push({ x, z, runway });
    edges.push([]);
    return nodes.length - 1;
  };
  const link = (a, b) => {
    if (a === b) return;
    const d = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].z - nodes[b].z);
    edges[a].push([b, d]);
    edges[b].push([a, d]);
  };
  const runwayIds = [];
  for (const w of ways) {
    const rw = w.t === 'runway';
    let prev = null;
    for (const [x, z] of w.p) {
      const id = nodeAt(x, z, rw);
      if (rw) runwayIds.push(id);
      if (prev !== null) link(prev, id);
      prev = id;
    }
  }
  // a taxiway end that stops at the runway's edge: a node on the runway's line, joined
  for (const w of ways) {
    if (w.t === 'runway') continue;
    for (const end of [w.p[0], w.p[w.p.length - 1]]) {
      const id = nodeAt(end[0], end[1], false);
      if (edges[id].some(([n]) => nodes[n].runway)) continue;
      const hit = nearestOnRunways(ways, end[0], end[1]);
      if (!hit || hit.d > REACH || hit.d < 1e-3) continue;
      const on = nodeAt(hit.x, hit.z, true);
      // split the runway segment the foot lies on, so the new node is on the runway's graph
      link(on, nodeAt(hit.a[0], hit.a[1], true));
      link(on, nodeAt(hit.b[0], hit.b[1], true));
      link(id, on);
    }
  }
  return { nodes, edges };
}

function nearestOnRunways(ways, x, z) {
  let best = null;
  for (const w of ways) {
    if (w.t !== 'runway') continue;
    for (let i = 1; i < w.p.length; i++) {
      const a = w.p[i - 1], b = w.p[i], ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L2));
      const px = a[0] + ex * t, pz = a[1] + ez * t, d = Math.hypot(x - px, z - pz);
      if (!best || d < best.d) best = { x: px, z: pz, d, a, b };
    }
  }
  return best;
}

export function nearestNode(net, x, z, filter = null) {
  let best = -1, bd = Infinity;
  net.nodes.forEach((n, i) => {
    if (filter && !filter(n, i)) return;
    const d = Math.hypot(n.x - x, n.z - z);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

/**
 * The shortest way along the network from node `a` to any node that `goal`
 * accepts (or to node index `goal`). → [[x, z], ...] or null.
 */
export function shortest(net, a, goal) {
  const n = net.nodes.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const isGoal = typeof goal === 'function' ? goal : (i) => i === goal;
  dist[a] = 0;
  for (;;) {
    let u = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u < 0) return null;
    if (isGoal(u)) {
      const out = [];
      for (let i = u; i >= 0; i = prev[i]) out.push([net.nodes[i].x, net.nodes[i].z]);
      return out.reverse();
    }
    done[u] = 1;
    for (const [v, w] of net.edges[u]) if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
  }
}
