import * as THREE from 'three';

// The things the campaign's films put in a hand or on a table, modelled as
// what they are (Frank, 21 Nov 2026: "Lahve opravdu jako lahve a kukla opravdu
// jako kukla"): turned bottles, a knitted balaclava, a kitchen chair with legs
// and spindles, a briefcase, a bundle of banknotes. Every maker returns a
// Group; `props()` keeps what it made and frees it in one call.
export function props() {
  const made = [],
    textures = [];
  const keep = (group) => {
    made.push(group);
    return group;
  };
  const mesh = (geometry, material, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    return m;
  };
  function canvas(w, h, paint) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    paint(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    textures.push(t);
    return t;
  }
  // rib knit: columns of little V stitches, light on dark
  let knit = null;
  const wool = () =>
    (knit ??= canvas(64, 64, (g, w, h) => {
      g.fillStyle = '#2a2a30';
      g.fillRect(0, 0, w, h);
      g.lineWidth = 1.8;
      for (let x = 0; x < w; x += 8)
        for (let y = -4; y < h; y += 6) {
          g.strokeStyle = (x / 8) % 2 ? '#55555f' : '#474750';
          g.beginPath();
          g.moveTo(x, y);
          g.lineTo(x + 4, y + 5);
          g.lineTo(x + 8, y);
          g.stroke();
        }
    }));

  return {
    // A half-litre beer bottle, 24.5 cm: turned glass, a paper label, a crown
    // cap (or an open neck). `glass` is its colour, `label` the paper's.
    bottle({ glass = 0x5a3414, label = '#e9dfc4', band = '#a3261c', cap = true } = {}) {
      const g = keep(new THREE.Group());
      const profile = [[0, 0], [0.029, 0], [0.0325, 0.006], [0.0325, 0.128], [0.031, 0.142], [0.024, 0.165], [0.0155, 0.19], [0.0135, 0.2], [0.013, 0.232], [0.0148, 0.235], [0.0148, 0.243], [0.0105, 0.245]];
      const body = mesh(
        new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 20),
        new THREE.MeshPhongMaterial({ color: glass, shininess: 110, specular: 0x9a9a8a, transparent: true, opacity: 0.9 }),
      );
      // what is left in it shows darker through the glass
      const beer = mesh(new THREE.CylinderGeometry(0.0295, 0.0295, 0.075, 16), new THREE.MeshLambertMaterial({ color: 0x24140a }), 0, 0.045, 0);
      const paper = canvas(128, 64, (c, w, h) => {
        c.fillStyle = label;
        c.fillRect(0, 0, w, h);
        c.fillStyle = band;
        c.fillRect(0, h * 0.62, w, h * 0.2);
        c.beginPath();
        c.ellipse(w / 2, h * 0.34, 15, 13, 0, 0, 6.3);
        c.fill();
        c.fillStyle = label;
        c.font = '700 13px system-ui, sans-serif';
        c.textAlign = 'center';
        c.fillText('12°', w / 2, h * 0.41);
      });
      const wrap = mesh(new THREE.CylinderGeometry(0.0331, 0.0331, 0.062, 20, 1, true, -1.25, 2.5), new THREE.MeshLambertMaterial({ map: paper }), 0, 0.075, 0);
      g.add(beer, body, wrap);
      if (cap) g.add(mesh(new THREE.CylinderGeometry(0.0152, 0.0158, 0.009, 14), new THREE.MeshPhongMaterial({ color: 0xc9a13c, shininess: 80 }), 0, 0.2475, 0));
      return g;
    },
    // A small glass with a finger of something in it.
    shot() {
      const g = keep(new THREE.Group());
      const side = [[0.019, 0], [0.024, 0.062]].map(([r, y]) => new THREE.Vector2(r, y));
      g.add(
        mesh(new THREE.LatheGeometry(side, 14), new THREE.MeshPhongMaterial({ color: 0xdfeaea, shininess: 120, transparent: true, opacity: 0.35, side: THREE.DoubleSide })),
        mesh(new THREE.CylinderGeometry(0.0205, 0.0188, 0.018, 14), new THREE.MeshLambertMaterial({ color: 0x9a6a24 }), 0, 0.011, 0),
      );
      return g;
    },
    // The balaclava as it lies on a table: a knitted hood on its side, the
    // eye opening up, the ribbed hem towards whoever it is pushed at (−z).
    // Its origin is 3.5 cm above the table, where the old placeholder had it.
    balaclava() {
      const g = keep(new THREE.Group());
      const yarn = wool().clone();
      textures.push(yarn);
      yarn.wrapS = yarn.wrapT = THREE.RepeatWrapping;
      yarn.repeat.set(7, 5);
      const cloth = new THREE.MeshLambertMaterial({ map: yarn, color: 0xffffff, emissive: 0x16161a });
      // a sock of a shape: wide at the crown, a little waist at the neck
      const profile = [[0.001, 0.25], [0.05, 0.243], [0.085, 0.222], [0.1, 0.19], [0.104, 0.15], [0.1, 0.105], [0.09, 0.07], [0.087, 0.03], [0.09, 0]];
      const hood = mesh(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 22), cloth);
      hood.material.side = THREE.DoubleSide;
      // laid down: crown to +z, hem to −z, and pressed flat by its own weight
      const lying = new THREE.Group();
      lying.add(hood);
      hood.rotation.x = Math.PI / 2;
      hood.position.set(0, 0, -0.125);
      lying.scale.set(1.05, 0.34, 1);
      // the hem: three ribs of thicker knit round the neck
      const rib = new THREE.MeshLambertMaterial({ color: 0x4a4a54, emissive: 0x101014 });
      for (let i = 0; i < 3; i++) {
        const ring = mesh(new THREE.TorusGeometry(0.0885 + i * 0.0006, 0.0055, 6, 22), rib, 0, 0, -0.119 + i * 0.012);
        lying.add(ring);
      }
      // the eye opening, on top: through it the dark of the inside, round it a rolled edge
      const slot = mesh(new THREE.CircleGeometry(1, 24), new THREE.MeshBasicMaterial({ color: 0x030304 }), 0, 0.0368, 0.04);
      slot.rotation.x = -Math.PI / 2;
      slot.scale.set(0.066, 0.027, 1);
      const edge = mesh(new THREE.TorusGeometry(1, 0.13, 8, 26), rib, 0, 0.0372, 0.04);
      edge.rotation.x = -Math.PI / 2;
      edge.scale.set(0.068, 0.029, 0.035);
      // the neck is shut by its own shadow, not by what lies under it
      const mouth = mesh(new THREE.CircleGeometry(0.086, 20), new THREE.MeshBasicMaterial({ color: 0x030304, side: THREE.DoubleSide }), 0, 0, -0.1235);
      mouth.scale.y = 0.34;
      // a fold where the crown flops over
      const fold = mesh(new THREE.SphereGeometry(0.06, 12, 8), cloth, 0.02, 0.012, 0.1);
      fold.scale.set(1.2, 0.3, 0.55);
      fold.rotation.y = 0.4;
      g.add(lying, slot, edge, fold, mouth);
      return g;
    },
    // A kitchen chair: turned legs a little splayed, stretchers, a shaped
    // seat, and a back of two posts, a curved rail and four spindles. `yaw`
    // turns its back: 0 has the back at +z. Seat top 0.4725 m, as the films sit.
    chair({ wood = 0x6b4a2e, dark = 0x54381f } = {}) {
      const g = keep(new THREE.Group());
      const pale = new THREE.MeshLambertMaterial({ color: wood }),
        deep = new THREE.MeshLambertMaterial({ color: dark });
      const leg = new THREE.CylinderGeometry(0.019, 0.014, 0.45, 8),
        bar = new THREE.CylinderGeometry(0.009, 0.009, 1, 6);
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          const l = mesh(leg, deep, sx * 0.175, 0.225, sz * 0.175);
          l.rotation.z = -sx * 0.06;
          l.rotation.x = sz * 0.06;
          g.add(l);
        }
      // stretchers: two along the sides, one across between them
      for (const sx of [-1, 1]) {
        const s = mesh(bar, deep, sx * 0.181, 0.16, 0);
        s.rotation.x = Math.PI / 2;
        s.scale.y = 0.36;
        g.add(s);
      }
      const cross = mesh(bar, deep, 0, 0.16, 0);
      cross.rotation.z = Math.PI / 2;
      cross.scale.y = 0.36;
      g.add(cross);
      // the seat: a board with a worn edge, a shade thinner at the front
      const seat = mesh(new THREE.CylinderGeometry(0.235, 0.225, 0.034, 4, 1), pale, 0, 0.4555, 0);
      seat.rotation.y = Math.PI / 4;
      seat.scale.set(1.28, 1, 1.28);
      g.add(seat, mesh(new THREE.BoxGeometry(0.39, 0.012, 0.39), pale, 0, 0.4665, 0));
      // the back, leaning 7 degrees
      const back = new THREE.Group();
      back.position.set(0, 0.47, 0.19);
      back.rotation.x = 0.12;
      const post = new THREE.CylinderGeometry(0.014, 0.017, 0.46, 8);
      for (const sx of [-1, 1]) back.add(mesh(post, deep, sx * 0.19, 0.23, 0));
      for (let i = 0; i < 4; i++) {
        const s = mesh(bar, deep, -0.114 + i * 0.076, 0.21, 0.006);
        s.scale.y = 0.4;
        back.add(s);
      }
      // top rail and a lower one, bowed back to fit a spine
      for (const [y, h] of [[0.43, 0.075], [0.03, 0.03]]) {
        const piece = new THREE.BoxGeometry(0.106, h, 0.018);
        for (let i = -2; i <= 2; i++) {
          const a = i * 0.165,
            part = mesh(piece, pale, 0.62 * Math.sin(a), y, -0.59 + 0.62 * Math.cos(a));
          part.rotation.y = a;
          back.add(part);
        }
      }
      g.add(back);
      return g;
    },
    // A briefcase: two shells hinged along the bottom edge, a handle, two
    // catches, and the money in it. Origin at the handle's grip, so it hangs
    // from a hand; the lid is the +z shell. `g.userData.open(k)` lifts the lid
    // (0 shut .. 1 wide) and shows what is inside.
    briefcase({ leather = 0x7a4a26 } = {}) {
      const g = keep(new THREE.Group());
      const hide = new THREE.MeshPhongMaterial({ color: leather, shininess: 22, emissive: leather, emissiveIntensity: 0.18 }),
        brass = new THREE.MeshPhongMaterial({ color: 0xc8a348, shininess: 90 }),
        lining = new THREE.MeshLambertMaterial({ color: 0x1c120b }),
        note = new THREE.MeshLambertMaterial({ color: 0x5f4f8c }),
        band = new THREE.MeshLambertMaterial({ color: 0xece4cf });
      const body = new THREE.Group();
      body.position.y = -0.2;
      const shell = new THREE.BoxGeometry(0.44, 0.3, 0.05);
      body.add(mesh(shell, hide, 0, 0, -0.025), mesh(new THREE.BoxGeometry(0.42, 0.28, 0.004), lining, 0, 0, -0.001));
      for (const x of [-0.22, 0.22]) for (const y of [-0.15, 0.15]) body.add(mesh(new THREE.SphereGeometry(0.013, 8, 6), brass, x * 0.97, y * 0.96, -0.025));
      // the money: two rows of banded bundles lying in the back shell
      const cash = new THREE.Group(),
        bundle = new THREE.BoxGeometry(0.15, 0.07, 0.03),
        strap = new THREE.BoxGeometry(0.03, 0.072, 0.032);
      for (let i = 0; i < 6; i++) {
        const x = i % 2 ? 0.105 : -0.105,
          y = 0.09 - Math.floor(i / 2) * 0.09;
        cash.add(mesh(bundle, note, x, y, 0.016), mesh(strap, band, x, y, 0.016));
      }
      cash.visible = false;
      body.add(cash);
      const lid = new THREE.Group();
      lid.position.set(0, -0.15, 0);
      lid.add(mesh(shell, hide, 0, 0.15, 0.025), mesh(new THREE.BoxGeometry(0.42, 0.28, 0.004), lining, 0, 0.15, 0.001));
      for (const x of [-0.13, 0.13]) lid.add(mesh(new THREE.BoxGeometry(0.035, 0.02, 0.012), brass, x, 0.28, 0.052));
      body.add(lid);
      const grip = mesh(new THREE.TorusGeometry(0.05, 0.009, 6, 14, Math.PI), hide, 0, -0.052, 0);
      g.add(body, grip);
      g.userData.open = (k) => {
        lid.rotation.x = k * 1.75;
        cash.visible = k > 0.02;
      };
      return g;
    },
    // A banded bundle of five-thousand-crown notes.
    notes() {
      const g = keep(new THREE.Group());
      g.add(
        mesh(new THREE.BoxGeometry(0.15, 0.022, 0.072), new THREE.MeshLambertMaterial({ color: 0x8fae8a })),
        mesh(new THREE.BoxGeometry(0.03, 0.0235, 0.074), new THREE.MeshLambertMaterial({ color: 0xece4cf })),
      );
      return g;
    },
    wool,
    dispose() {
      const seen = new Set();
      for (const group of made) {
        group.removeFromParent();
        group.traverse((o) => {
          if (!o.isMesh) return;
          if (!seen.has(o.geometry)) seen.add(o.geometry), o.geometry.dispose();
          for (const m of [].concat(o.material)) if (!seen.has(m)) seen.add(m), m.dispose();
        });
      }
      for (const t of textures) t.dispose();
    },
  };
}
