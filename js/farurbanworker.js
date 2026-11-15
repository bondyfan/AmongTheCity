// ---- farurbanworker.js: the overview's built-up cells, off the main thread ----
// WORKER (js/farlightsland.js starts it). public/data/overview.json is 9.9 MB
// and parsing it is 100 to 300 ms: here that is nobody's frame. What comes
// back is only its `urban` layer, the 200 m built-up rectangles, as one
// transferable Float32Array of [x0, z0, x1, z1] boxes (44 597 of them, 0.7 MB).

self.onmessage = async (e) => {
  try {
    const res = await fetch(e.data.url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ov = await res.json();
    const urban = ov.urban ?? [];
    const out = new Float32Array(urban.length * 4);
    let n = 0;
    for (const u of urban) {
      const o = u.o;
      if (!o || o.length < 3) continue;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [x, z] of o) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
      out[n++] = x0; out[n++] = z0; out[n++] = x1; out[n++] = z1;
    }
    const boxes = out.slice(0, n);
    self.postMessage({ boxes }, [boxes.buffer]);
  } catch (err) {
    self.postMessage({ error: String(err) });
  }
};
