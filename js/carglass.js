// ---- carglass.js: what the body shader does for glass and for doors ----------
//
// Two things a car body needs that one opaque draw could not do, both written
// here as GLSL for js/carbodymat.js to splice into its single program:
//
// THE CABIN IN THE GLASS. A car is one mesh and its windows are dark patches
// laid on the paint, so there is nothing behind them and there never can be:
// up to five hundred cars are alive at once and none of them can afford a
// second draw for an interior. So the interior is not geometry. A fragment of
// glass follows its own view ray into the car's frame and finds what the ray
// meets there: the seats, the headrests, the dashboard, the steering wheel,
// the far door and the far windows, and a driver when the car is being
// driven. Every one is a box, a ball or a ring whose place is read from the
// same numbers the real cabin is built to (vehicles.js cabinSpec), so the
// seats seen through the screen are the seats the door opens onto. It costs a
// dozen slab tests on the pixels that are glass and no draw call at all.
//
// THE DOOR. js/cardoor.js opens a door by drawing the body twice: once with
// the door's region discarded (the hole the real cabin shows through) and once
// more, on a hinge, with everything BUT that region discarded (the leaf). The
// region is a drawing in side view: between two shut lines, from the rocker to
// the cant rail, behind the raked line of the windscreen.
//
// Uniforms only, never a define: every body material shares one program, so a
// door opening compiles nothing.

import * as THREE from 'three';

/** vertex: declarations, and the two varyings every fragment test reads */
export const GLASS_VERT_DECL = /* glsl */`
  varying vec3 vObj; varying vec3 vCamO;`;
export const GLASS_VERT = /* glsl */`
  vObj = position;
  // the camera in the car's own frame (the model matrix is a rigid motion)
  vCamO = (cameraPosition - modelMatrix[3].xyz) * mat3(modelMatrix);`;

export const GLASS_FRAG_DECL = /* glsl */`
  varying vec3 vObj; varying vec3 vCamO;
  uniform vec4 uDoorA, uDoorB, uDoorC;
  uniform vec4 uCabA, uCabB, uCabC, uCabW, uCabS, uCabD;

  // 1 inside the door's outline, drawn in side view
  float doorIn(vec3 p) {
    if (p.x * uDoorC.x < uDoorC.y) return 0.0;
    if (p.z < uDoorA.x || p.z > uDoorA.y || p.y < uDoorA.z || p.y > uDoorA.w) return 0.0;
    if (p.y > uDoorB.x && p.z < uDoorB.y + (p.y - uDoorB.z) * uDoorB.w) return 0.0;
    return 1.0;
  }

  // nearest hit of a ray with a box (centre c, half size h), or -1; n is the
  // face it came in through
  float cabBox(vec3 ro, vec3 rd, vec3 c, vec3 h, out vec3 n) {
    vec3 m = 1.0 / rd, o = m * (ro - c), k = abs(m) * h;
    vec3 t1 = -o - k, t2 = -o + k;
    float tn = max(max(t1.x, t1.y), t1.z), tf = min(min(t2.x, t2.y), t2.z);
    n = -sign(rd) * step(t1.yzx, t1.xyz) * step(t1.zxy, t1.xyz);
    return (tn > tf || tf < 0.0) ? -1.0 : max(tn, 0.0);
  }

  // the same for an ellipsoid (centre c, radii r): headrests and heads are not boxes
  float cabBall(vec3 ro, vec3 rd, vec3 c, vec3 r, out vec3 n) {
    vec3 o = (ro - c) / r, d = rd / r;
    float a = dot(d, d), b = dot(o, d), dd = b * b - a * (dot(o, o) - 1.0);
    if (dd < 0.0) return -1.0;
    float t = (-b - sqrt(dd)) / a;
    n = normalize((o + d * t) / r);
    return t;
  }
  #define CAB_BALL(c, r, col) { vec3 nn; float tt = cabBall(ro, rd, c, r, nn); if (tt >= 0.0 && tt < t) { t = tt; n = nn; alb = col; } }

  #define CAB_TRY(c, h, col) { vec3 nn; float tt = cabBox(ro, rd, c, h, nn); if (tt >= 0.0 && tt < t) { t = tt; n = nn; alb = col; } }

  // what a ray entering through the glass sees: linear albedo, already shaded
  vec3 cabinSeen(vec3 ro, vec3 rd, float driver, float night) {
    rd += vec3(1e-4) * (1.0 - abs(sign(rd)));
    float iw = uCabA.x, fy = uCabA.y, belt = uCabA.z, top = uCabA.w;
    float cowl = uCabB.x, dash = uCabB.y, back = uCabB.z, sz = uCabB.w;
    float sx = uCabC.x, cy = uCabC.y, hw = uCabC.z, rear = uCabS.w;
    const float RAKE = 0.38;                 // the wheel's, on every kind with a greenhouse
    vec3 trim = vec3(0.030, 0.033, 0.040), seat = uCabS.rgb;
    vec3 day = vec3(0.30, 0.36, 0.44) * (1.0 - 0.94 * night);

    // ---- the shell, from inside: where the ray would leave the cabin
    vec3 c0 = vec3(0.0, (fy + top) * 0.5, (cowl + back) * 0.5);
    vec3 h0 = vec3(iw, (top - fy) * 0.5, (back - cowl) * 0.5);
    vec3 m = 1.0 / rd, t2 = -m * (ro - c0) + abs(m) * h0;
    float t = max(min(min(t2.x, t2.y), t2.z), 0.0);
    vec3 n = -sign(rd) * step(t2.xyz, t2.yzx) * step(t2.xyz, t2.zxy);
    vec3 p = ro + rd * t;
    vec3 alb = trim;
    if (n.y > 0.5) alb = vec3(0.012);                                   // carpet
    else if (n.y < -0.5) alb = vec3(0.17, 0.18, 0.19);                  // headliner
    else if (p.y > belt) {
      // a window on the far side: daylight, with a pillar where the seat back is
      float pil = abs(n.x) * (1.0 - smoothstep(0.045, 0.07, abs(p.z - (sz + 0.33))));
      alb = mix(day, trim, pil);
      n = vec3(0.0, 1.0, 0.0);
    }

    // ---- the furniture
    CAB_TRY(vec3(0.0, (fy + belt) * 0.5 - 0.01, (cowl + dash) * 0.5 + 0.03),
      vec3(iw, (belt - fy) * 0.5 - 0.01, (dash - cowl) * 0.5 + 0.05), trim * 1.25)
    for (int i = 0; i < 2; i++) {
      float x = i == 0 ? -sx : sx;
      CAB_TRY(vec3(x, cy - 0.05, sz), vec3(hw, 0.06, 0.26), seat)
    }
    if (rear > 0.01) CAB_TRY(vec3(0.0, cy - 0.06, sz + 0.85), vec3(rear, 0.06, 0.26), seat)
    // the backs lean: shear the ray instead of the boxes
    {
      vec3 so = ro, sd = rd;
      so.z -= (ro.y - cy) * 0.2; sd.z -= rd.y * 0.2;
      vec3 keepO = ro, keepD = rd; ro = so; rd = sd;
      for (int i = 0; i < 2; i++) {
        float x = i == 0 ? -sx : sx;
        CAB_TRY(vec3(x, cy + 0.27, sz + 0.30), vec3(hw * 0.95, 0.29, 0.055), seat)
        CAB_BALL(vec3(x, cy + 0.65, sz + 0.285), vec3(hw * 0.56, 0.10, 0.06), seat * 0.92)
      }
      if (rear > 0.01) {
        CAB_TRY(vec3(0.0, cy + 0.26, sz + 1.15), vec3(rear, 0.28, 0.06), seat)
        for (int i = 0; i < 2; i++) {
          float x = (i == 0 ? -1.0 : 1.0) * rear * 0.64;
          CAB_BALL(vec3(x, cy + 0.61, sz + 1.14), vec3(0.13, 0.095, 0.055), seat * 0.92)
        }
      }
      if (driver > 0.5) {
        float bx = -sx;
        CAB_TRY(vec3(bx, cy + 0.30, sz + 0.20), vec3(min(0.19, hw * 0.85), 0.27, 0.10), uCabD.rgb)
        // the head: skin where it faces the screen, hair behind
        {
          vec3 nn; float tt = cabBall(ro, rd, vec3(bx, cy + 0.72, sz + 0.20), vec3(0.10, 0.12, 0.11), nn);
          if (tt >= 0.0 && tt < t) { t = tt; n = nn; alb = nn.z < -0.15 ? vec3(0.42, 0.29, 0.22) : vec3(0.05, 0.035, 0.03); }
        }
      }
      ro = keepO; rd = keepD;
    }
    // ---- the steering wheel: a ring, a boss and three spokes in a raked plane
    if (uCabW.w > 0.0) {
      vec3 wc = uCabW.xyz, wn = vec3(0.0, sin(RAKE), cos(RAKE));
      float den = dot(rd, wn), tw = dot(wc - ro, wn) / den;
      if (abs(den) > 1e-4 && tw > 0.0 && tw < t) {
        vec3 q = ro + rd * tw - wc;
        float u = q.x, v = dot(q, vec3(0.0, cos(RAKE), -sin(RAKE))), r = length(vec2(u, v)), R = uCabW.w;
        float on = step(abs(r - R), R * 0.13) + step(r, R * 0.30)
          + step(r, R) * (step(abs(v), R * 0.09) + step(abs(u), R * 0.09) * step(v, 0.0));
        if (on > 0.0) { t = tw; n = wn * -sign(den); alb = vec3(0.016); }
      }
    }
    // ---- light: from above and ahead, less of it below the belt
    p = ro + rd * t;
    float lit = 0.42 + 0.58 * max(dot(n, vec3(0.20, 0.87, -0.45)), 0.0);
    float ao = mix(0.50, 1.0, smoothstep(belt - 0.32, belt + 0.06, p.y));
    return alb * lit * ao;
  }`;

/**
 * The fragment's own lines, after the body colour is known (cBase written to
 * diffuseColor). LIT is the GLSL for "this car is being driven".
 */
export const glassFrag = (LIT) => /* glsl */`
  if (uDoorC.z > 0.5) {
    float din = doorIn(vObj);
    if (uDoorC.z < 1.5 ? din > 0.5 : din < 0.5) discard;
    // the leaf's own pane is simply clear: an open door is looked THROUGH, and
    // a dark sheet mirroring the street was the wrong thing to see there
    if (uDoorC.z > 1.5 && vPbr.z > 2.0) discard;
  }
  // glass is the one part whose environment gain is above 2 (carmerge.js PART)
  if (vPbr.z > 2.0 && uCabC.w > 0.5 && uDoorC.z < 1.5)
    diffuseColor.rgb = cabinSeen(vObj, normalize(vObj - vCamO), ${LIT} * uCabD.w, uCarNight) * 0.8;`;

// ---- the numbers --------------------------------------------------------------
// vehicles.js owns the cabin's dimensions and registers the reader here (it
// cannot be imported: vehicles.js already imports the material through
// carmesh.js). Asked once per material.
let _cabin = null;
/** fn(kind, hex) → { A, B, C, W, S } (five rows of four) or null:
 *  A half width, floor, belt, headliner · B cowl, dash, back, seat z ·
 *  C seat x, cushion y, seat half width, on · W wheel x, y, z, radius ·
 *  S upholstery rgb, rear bench half width (0: no rear seats) */
export function setCabinLookup(fn) { _cabin = fn; }

const V4 = (a) => ({ value: new THREE.Vector4(a[0], a[1], a[2], a[3]) });
const ZERO = [0, 0, 0, 0];

/**
 * The uniforms of one body material. key is 'kind|hex'; door is null or the
 * js/cardoor.js region { A, B, C } (C carries the mode: 1 hole, 2 leaf).
 */
// Who is at the wheel, as the glass draws them: a jacket colour, and whether
// anybody is there at all. By default a car that burns its lamps has a driver
// (that is what its lamps mean, vehicles.js); `tint` (js/cardoor.js setDriver)
// overrides it for a car the player has been in: their own jacket while they
// sit in it, nobody once they have left, lamps or no lamps.
const DRIVER = [0.035, 0.04, 0.06, 1];

export function glassUniforms(key, hex, door = null, tint = null) {
  const kind = String(key).split('|')[0];
  let cab = null;
  try { cab = _cabin ? _cabin(kind, hex) : null; } catch { cab = null; }
  return {
    uDoorA: V4(door?.A ?? ZERO), uDoorB: V4(door?.B ?? ZERO), uDoorC: V4(door?.C ?? ZERO),
    uCabA: V4(cab?.A ?? ZERO), uCabB: V4(cab?.B ?? ZERO), uCabC: V4(cab?.C ?? ZERO),
    uCabW: V4(cab?.W ?? ZERO), uCabS: V4(cab?.S ?? ZERO), uCabD: V4(tint?.D ?? DRIVER),
  };
}
