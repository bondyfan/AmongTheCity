// ---- airport-boards.js: the departure screens of the terminal ----
// Main thread only. Each board of js/airport-plan.js BOARDS is one plane with a
// CanvasTexture of its own size, drawn in dark glass with yellow and white
// letters. A texture is redrawn only when the rows change (setBoard), never per
// frame, and the three boards are the only draw calls this module adds.

import * as THREE from 'three';
import { BOARDS, FRAME, toWorld } from './airport-plan.js';

const PX = 260;                 // canvas pixels per metre of board
const BG = '#0f1418', HEAD = '#1b2f55', INK = '#ffd23f', WHITE = '#eef2f4', RULE = '#3d4a55';
const COLUMNS = { time: 0.02, no: 0.19, to: 0.4, gate: 0.78, status: 0.85 };

/** Paint one board: a header, a rule, and as many rows as fit. */
function paint(g, W, H, rows) {
  g.fillStyle = BG;
  g.fillRect(0, 0, W, H);
  const head = H * 0.2, lineH = H * 0.17;
  g.fillStyle = HEAD;
  g.fillRect(0, 0, W, head);
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.fillStyle = WHITE;
  g.font = `600 ${Math.round(head * 0.5)}px system-ui, sans-serif`;
  g.fillText('ODLETY', W * COLUMNS.time, head / 2);
  g.fillStyle = RULE;
  g.fillRect(0, head, W, Math.max(2, H * 0.01));
  // the letters are sized to the board's width as much as to its rows: the
  // totem by the doors is narrow, and five columns must not run into each other
  const fs = Math.round(Math.min(lineH * 0.62, W * 0.045));
  const n = Math.max(1, Math.floor((H - head) / lineH) - 1);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    if (!r) break;
    const y = head + lineH * (i + 0.6);
    g.fillStyle = INK;
    g.font = `bold ${fs}px monospace`;
    g.fillText(r.time, W * COLUMNS.time, y, W * (COLUMNS.no - COLUMNS.time - 0.02));
    g.fillText(r.no, W * COLUMNS.no, y, W * (COLUMNS.to - COLUMNS.no - 0.02));
    g.fillText(r.gate ?? '', W * COLUMNS.gate, y, W * (COLUMNS.status - COLUMNS.gate - 0.01));
    g.fillStyle = WHITE;
    g.font = `${fs}px system-ui, sans-serif`;
    g.fillText(r.to, W * COLUMNS.to, y, W * (COLUMNS.gate - COLUMNS.to - 0.02));
    g.fillText(r.status ?? '', W * COLUMNS.status, y, W * (0.99 - COLUMNS.status));
  }
}

/**
 * The boards of the plan, on the frame's plates. `base` is the landmark's ground.
 * Returns { set(rows), dispose() }; the rows are the departures the boards show.
 */
export function makeBoards(scene, base) {
  const list = BOARDS.map((b) => {
    const W = Math.round(b.w * PX), H = Math.round(b.h * PX);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const material = new THREE.MeshBasicMaterial({ map: texture });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(b.w, b.h), material);
    // the plate faces b.face (0 is landside, −v): the plan's own yaw convention
    const yaw = Math.PI - FRAME.theta + b.face;
    const nx = Math.sin(yaw), nz = Math.cos(yaw);
    // a small set-off in front of the wall or the pedestal it hangs from
    const off = b.id === 'totem' ? 0.22 : 0.12;
    const p = toWorld(b.u, b.v);
    mesh.position.set(p.x + nx * off, base + b.y, p.z + nz * off);
    mesh.rotation.y = yaw;
    scene.add(mesh);
    return { b, canvas, texture, material, mesh, W, H, key: '' };
  });
  return {
    /** Redraw every board from the departures rows, only where they changed. */
    set(rows) {
      const key = JSON.stringify(rows);
      for (const e of list) {
        if (key === e.key) continue;
        e.key = key;
        const g = e.canvas.getContext('2d');
        paint(g, e.W, e.H, rows);
        e.texture.needsUpdate = true;
      }
    },
    dispose() {
      for (const e of list) {
        e.mesh.removeFromParent();
        e.mesh.geometry.dispose();
        e.material.dispose();
        e.texture.dispose();
      }
    },
  };
}
