import * as THREE from 'three';
import { EXPOSURE_DAY, EXPOSURE_NIGHT } from './sky.js';

// Building blocks for the permanent station furniture (the Pardubice
// underpasses, platforms and footbridge): boxes and drums instanced per
// finish, every sign drawn into one shared atlas, and the pools of light that
// come up at night. One draw call per finish, one for all the signs.
//
// A finish is a colour and, where it says so, a pattern laid in metres on the
// faces of the box (tiles, bricks, roof seams), so nothing here needs a UV.
//   lit    how much of its colour it shows without any sun (0..1): the
//          underpass is lit by its own strips at every hour
//   night  the same, but only after dark (a canopy's soffit over its lamps)
export const FINISH = {
  tile: { color: 0xe9e4d2, grid: [0.2, 0.2], grout: 0xbdb6a3, lit: 0.62 },
  blacktile: { color: 0x23262b, grid: [0.2, 0.1], grout: 0x3a3e45, lit: 0.5 },
  floor: { color: 0xa5583c, grid: [0.3, 0.3], grout: 0x6f3a29, lit: 0.55 },
  skirt: { color: 0x5b2f25, lit: 0.5 },
  ceiling: { color: 0xe8e6de, lit: 0.6 },
  step: { color: 0x9a9b95, lit: 0.5 },
  nosing: { color: 0xe2c63a, lit: 0.6 },
  brick: { color: 0x9c4f37, grid: [0.25, 0.075], grout: 0xc9b9a3, bond: true },
  wood: { color: 0x8b6a47 },
  paving: { color: 0xa3a39d, grid: [0.4, 0.2], grout: 0x8c8c86, bond: true },
  concrete: { color: 0xb9b6ad },
  steel: { color: 0x8d9698 },
  dark: { color: 0x2a2f33 },
  teal: { color: 0x1f8f86 },
  red: { color: 0xd1241f },
  roof: { color: 0xe07a68, grid: [8, 40], grout: 0xf6e9e2, night: 0 },
  soffit: { color: 0xc9cdca, grid: [0.5, 40], grout: 0xa8aeaa, lit: 0.22, night: 0.2 },
  yellow: { color: 0xf2c230 },
  white: { color: 0xe6e3da },
  navy: { color: 0x1b2f55, lit: 0.4 },
  lamp: { color: 0xfff3dc, glow: true },
  led: { color: 0xf6fbff, glow: true },
  screen: { color: 0x1f5fd0, glow: true },
  glass: { color: 0xa9c4cc, glass: true },
};

function material(name) {
  const f = FINISH[name];
  if (f.glow) return new THREE.MeshBasicMaterial({ color: f.color });
  const mat = new THREE.MeshLambertMaterial({ color: f.color });
  if (f.glass) {
    mat.transparent = true;
    mat.opacity = 0.22;
    mat.depthWrite = false;
    return mat;
  }
  const lit = f.lit ?? 0;
  mat.emissive = new THREE.Color(f.color).multiplyScalar(lit);
  if (lit) mat.color.multiplyScalar(1 - lit * 0.75);
  mat.userData.night = f.night ?? 0;
  mat.userData.hex = f.color;
  mat.userData.lit = lit;
  const grid = f.grid,
    grout = new THREE.Color(f.grout ?? f.color);
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'varying vec3 vPlace, vFace;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n vFace=normal; vPlace=(instanceMatrix*vec4(position,1.)).xyz;',
      );
    const pattern = grid
      ? `vec3 fa=abs(vFace);
         vec2 uv=fa.y>.5?vPlace.xz:(fa.x>.5?vPlace.zy:vPlace.xy);
         vec2 cell=uv/vec2(${grid[0].toFixed(3)},${grid[1].toFixed(3)});
         ${f.bond ? 'cell.x+=.5*mod(floor(cell.y),2.);' : ''}
         vec2 edge=abs(fract(cell)-.5);
         vec2 wide=fwidth(cell);
         float line=max(smoothstep(.5-.035-wide.x,.5-.035,edge.x),smoothstep(.5-.035-wide.y,.5-.035,edge.y));
         line*=1.-smoothstep(.25,.9,max(wide.x,wide.y));
         float tone=fract(sin(dot(floor(cell),vec2(12.98,78.23)))*437.54);
         vec3 groutColour=vec3(${grout.r.toFixed(3)},${grout.g.toFixed(3)},${grout.b.toFixed(3)});
         float k=mix(1.,.94+.1*tone,1.-smoothstep(.25,.9,max(wide.x,wide.y)));`
      : 'float line=0.; float k=1.; vec3 groutColour=vec3(0.);';
    shader.fragmentShader =
      'varying vec3 vPlace, vFace;\n' +
      shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           ${pattern}
           float mixLine=line*.8;
           diffuseColor.rgb=mix(diffuseColor.rgb*k,groutColour*${(1 - lit * 0.75).toFixed(3)},mixLine);`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           totalEmissiveRadiance=mix(totalEmissiveRadiance*k,groutColour*${lit.toFixed(3)},mixLine);`,
        );
  };
  mat.customProgramCacheKey = () => 'station:' + name;
  return mat;
}

// Signs: every plate is a rectangle of one canvas. `draw(ctx, w, h)` paints
// it with the origin at the plate's corner; `px` is its width in pixels.
// Plates are only collected by add(); finish() packs them tallest first into
// a canvas just high enough, so a late big board never finds the sheet full.
function atlas(parent, width = 2048) {
  const slots = new Map(), // key -> { w, h, draw, x, y }
    plates = [];
  let unnamed = 0;
  // A plate centred on (cx, cy, cz), facing +z turned by yaw.
  function add(cx, cy, cz, w, h, yaw, px, draw, key = null) {
    key ??= 'plate' + unnamed++;
    if (!slots.has(key)) slots.set(key, { w: px, h: Math.max(8, Math.round((px * h) / w)), draw });
    plates.push({ cx, cy, cz, w, h, yaw, slot: slots.get(key) });
  }
  let mesh = null,
    map = null;
  function finish() {
    if (!plates.length) return;
    let x = 0,
      y = 0,
      row = 0;
    for (const slot of [...slots.values()].sort((a, b) => b.h - a.h)) {
      if (x + slot.w > width) {
        x = 0;
        y += row + 2;
        row = 0;
      }
      Object.assign(slot, { x, y });
      x += slot.w + 2;
      row = Math.max(row, slot.h);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.min(4096, 2 ** Math.ceil(Math.log2(y + row + 2)));
    const ctx = canvas.getContext('2d');
    for (const slot of slots.values()) {
      ctx.save();
      ctx.translate(slot.x, slot.y);
      ctx.beginPath();
      ctx.rect(0, 0, slot.w, slot.h);
      ctx.clip();
      slot.draw(ctx, slot.w, slot.h);
      ctx.restore();
    }
    const position = [],
      uv = [],
      index = [];
    for (const { cx, cy, cz, w, h, yaw, slot } of plates) {
      const c = Math.cos(yaw),
        s = Math.sin(yaw),
        base = position.length / 3;
      for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        position.push(cx + (dx * w * c) / 2, cy + (dy * h) / 2, cz - (dx * w * s) / 2);
        uv.push((slot.x + (dx > 0 ? slot.w : 0)) / width, 1 - (slot.y + (dy > 0 ? 0 : slot.h)) / canvas.height);
      }
      index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setIndex(index);
    map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 4;
    mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map }));
    mesh.frustumCulled = false;
    parent.add(mesh);
    return canvas.height;
  }
  function dispose() {
    mesh?.geometry.dispose();
    mesh?.material.dispose();
    map?.dispose();
  }
  const dim = (k) => mesh?.material.color.setScalar(k);
  return { add, finish, dim, dispose };
}

// A plate of text: lines of equal height, centred.
export function plate(lines, bg = '#1b2f55', ink = '#ffffff', weight = 700) {
  return (ctx, w, h) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    const row = h / lines.length;
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((line, i) => {
      ctx.font = weight + ' ' + Math.round(row * 0.66) + 'px system-ui, sans-serif';
      ctx.fillText(line, w / 2, (i + 0.53) * row, w * 0.94);
    });
  };
}

export function stationKit(parent) {
  const batches = new Map(),
    pose = new THREE.Object3D(),
    signs = atlas(parent),
    spots = [];
  const cube = new THREE.BoxGeometry(),
    drum = new THREE.CylinderGeometry(0.5, 0.5, 1, 20);
  const meshes = [],
    nightly = [];
  let pool = null;
  // A box centred on (x, y, z); rot turns it about x, y, z (radians).
  function box(x, y, z, w, h, d, finish, rot = null, shape = 'cube') {
    const key = finish + '/' + shape;
    if (!batches.has(key)) batches.set(key, { finish, shape, matrices: [] });
    pose.position.set(x, y, z);
    pose.scale.set(w, h, d);
    pose.rotation.set(rot?.x ?? 0, rot?.y ?? 0, rot?.z ?? 0);
    pose.updateMatrix();
    batches.get(key).matrices.push(pose.matrix.clone());
  }
  const round = (x, y, z, across, h, finish) => box(x, y, z, across, h, across, finish, null, 'drum');
  // A plate seen from both sides (yaw is the first face's).
  function both(x, y, z, w, h, yaw, px, draw, key, gap = 0.035) {
    const nx = Math.sin(yaw),
      nz = Math.cos(yaw);
    signs.add(x + nx * gap, y, z + nz * gap, w, h, yaw, px, draw, key);
    signs.add(x - nx * gap, y, z - nz * gap, w, h, yaw + Math.PI, px, draw, key);
  }
  function light(x, y, z, long, wide, colour = 0xffe2b8) {
    spots.push([x, y, z, long, wide, colour]);
  }
  function finish() {
    for (const { finish: name, shape, matrices } of batches.values()) {
      const mat = material(name);
      const mesh = new THREE.InstancedMesh(shape === 'drum' ? drum : cube, mat, matrices.length);
      matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.frustumCulled = false;
      if (FINISH[name].glass) mesh.renderOrder = 2;
      parent.add(mesh);
      meshes.push(mesh);
      if (mat.userData?.night || mat.userData?.lit) nightly.push(mat);
    }
    batches.clear();
    signs.finish();
    if (spots.length) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d'),
        g = ctx.createRadialGradient(32, 32, 1, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.45, 'rgba(255,255,255,.42)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
      const map = new THREE.CanvasTexture(canvas);
      const mat = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
      const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat, spots.length);
      const colour = new THREE.Color();
      spots.forEach(([x, y, z, long, wide, hex], i) => {
        pose.position.set(x, y + 0.03 + (i % 7) * 0.0006, z);
        pose.scale.set(long, 1, wide);
        pose.rotation.set(0, 0, 0);
        pose.updateMatrix();
        mesh.setMatrixAt(i, pose.matrix);
        mesh.setColorAt(i, colour.setHex(hex));
      });
      mesh.renderOrder = 1;
      mesh.frustumCulled = false;
      parent.add(mesh);
      pool = { mesh, mat, map };
    }
  }
  // 0 by day, 1 at night: the pools on the paving and whatever the lamps reach.
  // The game opens its exposure after dark (js/sky.js), which would blow out
  // anything that lights itself, so that is turned down by as much.
  function night(k) {
    const dim = Math.pow(EXPOSURE_DAY / EXPOSURE_NIGHT, k);
    if (pool) pool.mat.opacity = 0.5 * k;
    for (const mat of nightly) mat.emissive.setHex(mat.userData.hex).multiplyScalar((mat.userData.lit + mat.userData.night * k) * dim);
    signs.dim(dim);
  }
  function dispose() {
    for (const m of meshes) {
      m.material.dispose();
      m.dispose();
    }
    if (pool) {
      pool.mesh.geometry.dispose();
      pool.mat.dispose();
      pool.map.dispose();
      pool.mesh.dispose();
    }
    signs.dispose();
    cube.dispose();
    drum.dispose();
    parent.removeFromParent();
    parent.clear();
  }
  return { box, round, sign: signs.add, both, light, finish, night, dispose };
}
