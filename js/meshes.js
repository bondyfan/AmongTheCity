// ---- Chunk mesh factory: the city's look, one merged mesh at a time ----
// buildChunkMeshes() turns one 120 m cell of the Pardubice data into as few
// Meshes as possible: ONE vertex-colored "flat" mesh (ground, water surface +
// bank skirts, road ribbons + bridge fascia/railings, rails, lane dashes),
// ONE building mesh and two InstancedMeshes for the trees. Most features live
// in every cell their bbox touches but render only in their _home chunk; the
// two exceptions are WATER and WATERWAYS, which are clipped to the cell rect
// instead — the river is kilometers long, and home-chunk rendering would pop
// the whole Labe in and out with one distant cell. Everything is emitted in
// world coordinates (the city sits ≤ ~2 km from origin, float32 is plenty),
// so the returned Group stays at the origin.
//
// v2 realism pass: water surfaces sink to WATER_Y with earthy bank walls cut
// through the ground plane (the ground is a rect-with-holes wherever water
// crosses it — an opaque quad at y=0 would simply hide a sunken river);
// bridges run flat at BRIDGE_Y behind geo.bridgeElevation and grow parapets;
// mats.ortho swaps the ground quad for a ČÚZK aerial photo; mats.facades
// swaps flat building walls for a shared procedural window atlas.
//
// v4: woods are no longer green paint — every wood/forest polygon (and every
// park big enough to have a canopy) scatters real trees into the chunk's tree
// InstancedMeshes, and its fill darkens to a forest floor so the gaps between
// the trunks read as shade instead of meadow.
//
// Color discipline: renderer output is sRGB with three's color management on,
// so every palette hex goes through Color.setHex() (sRGB → linear working
// space) BEFORE it lands in a vertex-color attribute.

import * as THREE from 'three';
import { mergeGeometries } from '../libs/BufferGeometryUtils.js';
import { CHUNK, LAYER_Y, COLORS, BUILDING_PALETTES, ROOF_DARKEN, WALL_AO,
  WATER_Y, BANK_DEPTH, BRIDGE_RAMP } from './config.js';
import { bridgeDeckHeight, bridgeElevation, polygonArea, pointInPolygon, chunkKey,
  junctionsIn, distPointToSegment, roadProfile, roadGradeY, junctionDeckY, junctionHull,
  clustersIn, clusterHull, clusterDeckY, streetOf,
  GRADE_CUT } from './geo.js';
import { JUNCTIONS, CLUSTERS, railGradeY } from './geo.js';
import { WIRE_H } from './trambody.js';
import { KERB_H, KERB_W, FOOT_LIFT, vergeAt, vergeLift, inZone, bayAt, roadRank, cornerLift } from './streets.js';
import { groundFor, fallFor } from './terrain.js';
import { SURF, surfaceMaterial } from './surfaces.js';
import { furnitureInto } from './furniture.js';
import { lampGeoms } from './streetlamps.js';
import { mastKind, mastsAlong } from './mastlamps.js';
import { DecoSink, drum as kitDrum, post as kitPost, bar as kitBar } from './propkit.js';
import { SIGN_M } from './signfaces.js';
import { streetDecoMaterial } from './signatlas.js';
import { plannedSigns, crossingSigns } from './streetsigns.js';
import { MwDecoSink, motorwaySignsInto } from './mwsignmesh.js';
import { motorwayDecoMaterial, motorwayNight } from './mwatlas.js';
import { terracesInto, terraceOpen } from './terraces.js';
import { signalNight } from './signalmodel.js';
import { atlasMark, releaseMark, paintMark, mergeMarks } from './wordmarkatlas.js';
import { BATCH } from './batchflags.js';
import { tod } from './worldclock.js';
import { sealedRects } from './sealed.js';
import { entranceOf, brandOf, signBrandOf, classify, storeyPlan } from './interiors.js';
import { INTERIOR } from './config.js';
import { ATLAS_N, BAYS, WIN_W, cellRect, PIN_U, PIN_V, typologyOf, roofOf, facadeRows,
  edgeRoles, rowFor, trimRect, TYPO_WALLS, PARTY_ROLE, litOf, litRow, litStart, LIT_N, signBand,
  signOverGround, roofPin, hasParapet, PARAPET_H } from './typology.js';
import { roofInto, roofCap, parapetInto, linRGB } from './roofs.js';
import { praguePlace, praguePlaster, PRAGUE_WALLS } from './praguezone.js';
import { wallTone } from './roofdata.js';
import { facadeAtlas, buildFacadeMaterial, facadeNight } from './facadeatlas.js';
import { landmarkOf, LandmarkBatch, landmarkBarrier, landmarkClear, SWITCH as LANDMARK_SWITCH } from './landmarks.js';
import { landmarkExtras, landmarkBridge, inLandmark } from './landmarks.js';
import { landmarkMaterial, landmarkNight } from './landmarksmat.js';
import { farTemplate, FAR_BOUND_PAD, farBoundPad, treeSpec, treeMatrices, crownColor, mappedTree } from './treeshapes.js';
import { farTreeMaterials } from './treeshader.js';
import { treePitsInto } from './treepits.js';
import { riverLevelAt, isPooled, isCulvert } from './riverpools.js';
import { quayPiece, balustradeInto, embankmentNear, QUAY_MIN } from './quaywall.js';
import { refineNearWeirs, paintFlow, weirSillsInto } from './weirs.js';
import { quaySnap, quayGroundY, GRID_SNAP, stampShaped } from './quayedge.js';
import { roadSegs } from './roadsegments.js';
import { roadCorr, railCorr, floorOf, vergeFaced, kerbedAt, vergeFacesInto, railShouldersInto, edgeNear } from './batter.js';
import { vysehradInto } from './vysehrad.js';
import { quayStairsInto } from './quaystairs.js';
import { balustradeAt, rasinovoParapet } from './quaybalustrade.js';
import { isQuayStairWay } from './quayflights.js';
import { forecourtFrame, islandsOf } from './forecourt.js';
import { quayRefine, quayRefineArray, quayLiftTriangles, quayDrape } from './quayground.js';
import { mwPainted, motorwayPaint } from './mwpaint.js';
import { cwOf, osmBarrierReplaced, mwPierStations, BRIDGE_KERB as MW_BRIDGE_KERB, BRIDGE_IN as MW_BRIDGE_IN } from './mwplan.js';
import { motorwayDressInto } from './mwdress.js';
import { roadsideLevel, wallRoads } from './mwroadside.js';
import { motorwayTallInto } from './mwtall.js';
import { endsIndex } from './lanes.js';
import { motorwayVerge, cutRects } from './mwground.js';

// geometry dimensions (meters) — construction sizes, not art direction
const CAP_SEGS = 8;                                  // endpoint disc fan
const DASH_LEN = 1.8, DASH_GAP = 2.6, DASH_HW = 0.09; // lane center dashes
const GAUGE_H = 1.435 / 2;                           // standard gauge, rail centerlines
const RAIL_HW = 0.09;                                // steel ribbon half-width
const SLEEPER_STEP = 0.8, SLEEPER_HL = 1.25, SLEEPER_HW = 0.12;
const FASCIA = 0.55;                                 // girder face below a bridge deck edge
// The kerb face along every drivable deck edge — light concrete, like the kerb
// stones it stands in for.
const KERB_HEX = 0x8d8a83;
const _kc = new THREE.Color(KERB_HEX);
const KERB_R = _kc.r, KERB_G = _kc.g, KERB_B = _kc.b;
const RAILING_H = 0.9, RAILING_COL = 0x2b2d31;       // bridge parapet strips
const TRENCH_D = 1.2;                                // a stream sits this far under its banks
const BANK_TOP = 0.05, BANK_COL = 0x6b5f4c;          // river bank walls: curb lip → just under water
const SKIRT_MAX = 30;                                // bank wall piece length — keeps chunk ownership local
// A centre line means "this road has two lanes", so it belongs on any street
// wide enough to have them — which in a Czech town is most of them. It used to
// stop at 'tertiary', which left every residential street in Pardubice as a
// featureless grey strip.
const DASH_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'residential', 'unclassified', 'living_street']);
// …and the EDGE lines, which nothing drew at all. Real roads are bounded by
// paint, not by where the asphalt happens to stop, and their absence is most of
// why the streets read as extruded polygons rather than as roads. Solid, both
// sides, inset from the kerb: 12 cm of paint 30 cm in, which is what the
// Czech standard actually specifies (V4, 0.125 m).
const EDGE_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'residential', 'unclassified', 'living_street', 'motorway_link', 'trunk_link',
  'primary_link', 'secondary_link', 'tertiary_link']);
const EDGE_INSET = 0.30, EDGE_HW = 0.0625;   // m from the kerb, half-width of the stripe
const EDGE_MIN_W = 4.0;                      // narrower than this and paint would meet in the middle
// Bare asphalt at each end, for the junction box. 5 m of it, on top of the
// junction trim that already shortened the way, left whole short links between
// two junctions with no paint at all — "silnicím občas chybí značení". A real
// give-way line sits a metre or two off the crossing, so that is what this is.
const EDGE_END = 2.2;
const FOOT_CLASSES = new Set(['footway', 'path', 'steps', 'cycleway', 'pedestrian', 'track']);
const _fdrv = [];   // scratch: drivable roads near the footway being ribboned

// Facade rhythm: one window bay per 2.7 m of wall, one atlas row per storey.
// The atlas grid, the cell families and where each family's window sits live in
// typology.js (pure data, shared with pieces.js and with the painter in
// facadeatlas.js). A cell holds a BAND of 4 window bays, because an atlas cell
// cannot wrap-repeat: walls subdivide into runs of at most 4 bays instead.
const LIT_PIN = 0.5 / LIT_N;                         // the night texture's always-dark texel

// module-level scratch — build-time only, but the loops shouldn't churn
const _c = new THREE.Color();
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion();
const _v = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _WA = { x: 0, z: 0, dx: 0, dz: 0 }, _WB = { x: 0, z: 0, dx: 0, dz: 0 };

// deterministic per-feature jitter — the same building keeps the same tint
// across chunk rebuilds and across machines (no Math.random in geometry)
function rnd(id, salt) {
  let t = (id * 374761393 + salt * 668265263) >>> 0;
  t = Math.imul(t ^ (t >>> 13), 1274126177) >>> 0;
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}
function hashStr(s) {
  let h = 9;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 387420489);
  return h >>> 0;
}

function makeWaterMaterial() {
  // Water is deliberately its own draw call. A vertex-coloured Lambert patch
  // can only ever read as blue asphalt; this surface has moving geometry,
  // two crossing ripple scales, view-angle reflection and a tight sun glint.
  return new THREE.ShaderMaterial({
    // ShaderMaterial does not inject the standard fog uniforms merely because
    // `fog: true` is set. WebGLRenderer nevertheless tries to refresh them,
    // so omitting this block crashes on uniforms.fogColor.value before the
    // first water frame can render.
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        // Water shows almost no colour of its own — it shows the sky, the sun
        // and how dark it is. The first version of this shader was handed none
        // of those: a constant sun direction and constant blues, so the river
        // lay there at midnight glowing the same turquoise it had at noon, with
        // a sun glint on it that no sun in the sky could account for. sky.js
        // already publishes exactly what is needed (sky.sunDir, sky.nightK) and
        // clouds.js already reads it; main.js now feeds it here too.
        uSun: { value: new THREE.Vector3(-0.38, 0.82, -0.27) },
        uNight: { value: 0 },
        uSky: { value: new THREE.Color(0x9fb6cc) },
        // The sky's prefiltered reflection map, the same texture every PBR
        // material in the scene reflects (envmap.js, scene.environment). It
        // arrives late: SkyEnv.bindWater() sets this and the three CUBEUV
        // defines after the first bake, and until then the shader below
        // compiles without ENVMAP_TYPE_CUBE_UV and reflects flat uSky.
        envMap: { value: null },
      },
    ]),
    fog: true,
    side: THREE.DoubleSide,
    // the colour attribute is not a colour here: weirs.js paintFlow packs the
    // downstream direction into r, g and the weir foam into b
    vertexColors: true,
    vertexShader: `
      uniform float uTime;
      varying vec3 vWorld;
      varying vec3 vWaveNormal;
      varying vec3 vFlow;
      #include <fog_pars_vertex>

      void main() {
        vec4 baseWorld = modelMatrix * vec4(position, 1.0);
        vec3 p = position;
        float t = uTime;
        // World coordinates keep the phase continuous across 120 m chunks.
        // Local coordinates would restart every tile and draw a visible seam
        // down the middle of a river.
        //
        // A RIVER IS NOT AN OCEAN. This field used to run at 12.7 cm amplitude
        // over 45–55 m wavelengths, which on a 40 m wide river means the whole
        // surface heaves as one body: Atlantic swell in Pardubice. Shortening
        // the wavelength here cannot fix it either — the water mesh is
        // tessellated at 8 m, so nothing under about a 16 m wavelength survives
        // being sampled at the vertices and it would only alias. So the
        // geometry keeps a slow shallow breath, 1.8 cm at the crest, and every
        // ripple you can actually see is done per-pixel below, where the
        // resolution to carry it exists.
        float a = baseWorld.x * 0.115 + baseWorld.z * 0.071 + t * 0.55;
        float b = baseWorld.x * -0.047 + baseWorld.z * 0.132 - t * 0.41;
        p.y += sin(a) * 0.011 + sin(b) * 0.007;

        float dx = cos(a) * 0.011 * 0.115 + cos(b) * 0.007 * -0.047;
        float dz = cos(a) * 0.011 * 0.071 + cos(b) * 0.007 * 0.132;
        vWaveNormal = normalize(mat3(modelMatrix) * vec3(-dx, 1.0, -dz));

        #ifdef USE_COLOR
          vFlow = vec3(color.rg * 2.0 - 1.0, color.b);
        #else
          vFlow = vec3(0.0);
        #endif
        vec4 world = modelMatrix * vec4(p, 1.0);
        vWorld = world.xyz;
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uSun;
      uniform float uNight;
      uniform vec3 uSky;
      varying vec3 vWorld;
      varying vec3 vWaveNormal;
      varying vec3 vFlow;
      #include <fog_pars_fragment>
      #ifdef ENVMAP_TYPE_CUBE_UV
        uniform sampler2D envMap;
      #endif
      #include <cube_uv_reflection_fragment>

      // The ripples, per PIXEL, and SMALL. This used to be three crossing
      // wavelets of 7 m, 5.5 m and 2.8 m with a slope of 4 % each: on the
      // Vltava, seen from Charles Bridge, that is a sea swell rolling under the
      // arches. A river in a town is a mirror broken by fine ripples: catspaws
      // a metre or less across, drifting downstream, in patches where a breeze
      // touches the surface and glassy in between. Only the SLOPE is wanted, so
      // the analytic derivative goes straight into the normal; each octave fades
      // out once a pixel covers its wavelength (it would only alias).
      float hash21(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 q) {
        vec2 i = floor(q), f = fract(q);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
                   mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      vec2 wavelet(vec2 p, vec2 k, float w, float a, float px) {
        float lam = 6.2832 / length(k);
        float fade = 1.0 - smoothstep(lam * 0.35, lam * 1.1, px);
        return cos(dot(p, k) + w) * a * k * fade;
      }
      vec3 rippleNormal(vec2 p, vec2 flow, float t, float px) {
        // drift: ripples ride the current (0.35 m/s, a pooled Vltava's pace)
        vec2 q = p - flow * t * 0.35;
        // patches of breeze and glassy calm, drifting with the water
        float gust = smoothstep(0.25, 0.85, vnoise(q * 0.045 + vec2(t * 0.02, -t * 0.015)));
        float amp = 0.35 + 0.65 * gust;
        // 2.9 m, 2.1 m, 1.2 m and 0.7 m; the fifth is a long slow undulation
        // that is NOT a swell: 1 cm over 9.5 m, just enough to bend
        // reflections the way a current does
        vec2 k1 = vec2(1.9, 1.1);
        vec2 k2 = vec2(-1.4, 2.6);
        vec2 k3 = vec2(4.3, -3.1);
        vec2 k4 = vec2(-6.8, -5.2);
        vec2 k5 = vec2(0.52, 0.41);
        vec2 d = vec2(0.0);
        d += wavelet(q, k1, t * 2.1, 0.0060, px);
        d += wavelet(q, k2, -t * 2.6, 0.0042, px);
        d += wavelet(q, k3, t * 3.9 + sin(q.x * 0.7) * 0.8, 0.0019, px);
        d += wavelet(q, k4, t * 5.1, 0.0011, px);
        d += wavelet(q, k5, t * 0.6, 0.010, px);
        return vec3(-d.x * amp, 1.0, -d.y * amp);
      }

      void main() {
        vec3 base = normalize(gl_FrontFacing ? vWaveNormal : -vWaveNormal);
        float px = max(length(fwidth(vWorld.xz)), 1e-3);
        vec3 rip = rippleNormal(vWorld.xz, vFlow.xy, uTime, px);
        vec3 n = normalize(base + vec3(rip.x, 0.0, rip.z));
        vec3 viewDir = normalize(cameraPosition - vWorld);

        float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 5.0);
        // A lowland Czech river is green-brown and it is MURKY. The turquoise
        // this used to be belongs to eighteen metres of clear tropical water
        // over white sand, and it read as a lit sign rather than a river.
        float bands = sin(vWorld.x * 0.061 + vWorld.z * 0.043 + uTime * 0.31)
          * sin(vWorld.x * -0.037 + vWorld.z * 0.052 - uTime * 0.22);
        // (and greener-browner still: the Vltava carries peat from the Šumava)
        vec3 deep = vec3(0.020, 0.026, 0.019);
        vec3 body = vec3(0.056, 0.071, 0.048);
        vec3 colour = mix(deep, body, 0.55 + bands * 0.14);

        // EVERYTHING water shows is borrowed. Its own body darkens with the
        // day, and what it reflects is the sky's real colour this minute — so
        // it goes orange at sunset and near-black at midnight for free, instead
        // of holding one hardcoded blue around the clock.
        float day = 1.0 - uNight;
        colour *= 0.055 + 0.945 * day;
        // WHAT THE SURFACE MIRRORS. This used to be one flat colour (the fog's),
        // and because a flat colour taken to the physical limit turns a wide
        // river into a sheet of pale concrete, the reflection was held at 55 %.
        // It now looks the mirrored ray up in the sky's own reflection map: pale
        // at the far bank where the ray grazes the horizon, deep blue under
        // your feet, the sunset band lying across it in the evening, the cloud
        // deck broken up by the ripples. With something real to reflect, the
        // Fresnel term can run close to what water actually does.
        vec3 refl = reflect(-viewDir, n);
        // a ripple can tip the mirrored ray below the horizon, where the map
        // holds the ground tone; water facing itself shows sky, so fold it up
        refl.y = abs(refl.y) + 0.02;
        #ifdef ENVMAP_TYPE_CUBE_UV
          vec3 skyRefl = textureCubeUV(envMap, normalize(refl), 0.16).rgb;
        #else
          vec3 skyRefl = uSky;
        #endif
        // THE BANKS IN THE WATER. A ray that leaves the surface almost level
        // does not reach the sky at all: it hits the far bank, its trees and
        // its houses. Reflecting the pale horizon there instead is what made
        // the far shore dissolve into one white haze with the river. There is
        // no mirror pass, so the low band reflects a dim shore tone (the sky's
        // own colour, darkened and greened, so it follows the time of day).
        vec3 shore = skyRefl * vec3(0.30, 0.34, 0.28);
        skyRefl = mix(shore, skyRefl, smoothstep(0.035, 0.20, refl.y));
        colour = mix(colour, skyRefl, clamp(0.03 + fresnel * 0.97, 0.0, 0.88));

        // the sun, and only while there is one above the horizon
        float above = clamp(uSun.y * 5.0, 0.0, 1.0);
        vec3 halfDir = normalize(uSun + viewDir);
        float glint = pow(max(dot(n, halfDir), 0.0), 140.0) * 0.95
          + pow(max(dot(n, halfDir), 0.0), 30.0) * 0.05;
        colour += vec3(1.0, 0.93, 0.74) * glint * above;
        colour += vec3(0.022, 0.032, 0.027) * max(dot(n, uSun), 0.0) * above;

        // white water below a weir: churned foam, broken into flecks that
        // stream away downstream, lit by the sky (dim at night)
        if (vFlow.z > 0.01) {
          vec2 q = vWorld.xz - vFlow.xy * uTime * 1.1;
          float fleck = vnoise(q * 1.7) * 0.6 + vnoise(q * 4.3 + 7.0) * 0.4;
          float cover = smoothstep(0.75 - 0.75 * vFlow.z, 0.95 - 0.6 * vFlow.z, fleck);
          // far off the flecks are smaller than a pixel: show their average,
          // so the weir still reads as a white line from the next bridge
          cover = mix(cover, smoothstep(0.1, 0.8, vFlow.z), smoothstep(0.25, 1.2, px));
          cover *= smoothstep(0.0, 0.2, vFlow.z);
          vec3 foamCol = vec3(0.80, 0.82, 0.80) * (0.06 + 0.94 * day) + uSky * 0.08;
          colour = mix(colour, foamCol, cover * 0.92);
        }

        // and at night the moon does the same trick, faintly, from the other
        // side of the sky — the one thing that should still catch the eye on
        // black water
        vec3 moonDir = normalize(vec3(-uSun.x, abs(uSun.y) + 0.22, -uSun.z));
        vec3 moonHalf = normalize(moonDir + viewDir);
        colour += vec3(0.40, 0.46, 0.60)
          * pow(max(dot(n, moonHalf), 0.0), 110.0) * 0.30 * uNight;

        gl_FragColor = vec4(colour, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  });
}

export function makeMaterials() {
  // Street dressing. streetDeco: every textured thing on a street (sign faces,
  // shelter glass and posters), one atlas, alpha to MSAA coverage. terrace:
  // café tables, a material of their own only so that ONE switch puts every
  // terrace in the city out in the morning and takes it in at night.
  const streetDeco = streetDecoMaterial();
  // the D11 / D35 signs' faces (js/mwatlas.js): one atlas, painted on first sight
  const motorwayDeco = motorwayDecoMaterial();
  const terrace = new THREE.MeshLambertMaterial({ vertexColors: true });
  // callers may attach mats.ortho (manager from ortho.js) and mats.facades
  // (bool) after the fact — buildChunkMeshes reads both, and lazily caches a
  // textured wall material as mats._facadeMat so the atlas is built once
  const tree = farTreeMaterials();
  return {
    streetDeco, terrace, motorwayDeco,
    // Not a material: once a frame from main.js updateNightLights. Shelter
    // posters light up with the street lamps, signal lenses hold one
    // brightness to the eye as the exposure opens, terraces follow the clock.
    streetNight(nightK, exposure) {
      let on = (nightK - 0.2) / 0.4;
      on = on < 0 ? 0 : on > 1 ? 1 : on;
      // 0.42 under the 2.5 night exposure is a lit poster, not a white slab
      streetDeco.emissiveIntensity = 0.42 * on;
      motorwayNight(motorwayDeco, nightK);
      terrace.visible = terraceOpen(tod());
      signalNight(exposure);
    },
    // Every flat surface in the world — ground, lawns, car parks, carriageways,
    // kerbs, lane paint, riverbanks — is one mesh with one material, and now
    // that material is PBR with a synthesised albedo/normal/roughness per
    // surface class (surfaces.js). One draw call still, because the classes
    // live in a texture ARRAY indexed by a per-vertex attribute.
    flat: surfaceMaterial(),
    water: makeWaterMaterial(),
    building: new THREE.MeshLambertMaterial({ vertexColors: true }),
    // trees: js/treeshader.js owns both far materials (wind, the swap to the
    // near models, leaf noise); the colours are per instance
    trunk: tree.trunk,
    // far tier fallback when a chunk has no aerial tile yet: plain terrain
    // colour, no vertex colours (the far quad carries none)
    flatFar: new THREE.MeshLambertMaterial({ color: 0x8a9182 }),
    lampPost: new THREE.MeshLambertMaterial({ color: 0x7e8388 }),   // galvanised steel
    // emissiveIntensity is driven from main at dusk (0 by day, ~2.6 at night)
    lampHead: new THREE.MeshLambertMaterial({ color: 0x2e3033, emissive: 0xffdc96, emissiveIntensity: 0, toneMapped: false }),
    crown: tree.crown,
    // door dressing: matte surround/canopy, and a sign board that is always a
    // touch overbright so the bloom pass finds every entrance in the city
    doorTrim: new THREE.MeshLambertMaterial({ vertexColors: true }),
    // Illuminated signage: FULL BRIGHT, never shaded, never tone-mapped — which
    // is exactly how a backlit retail fascia behaves, and lets the vertex colour
    // carry each chain's own red/blue/yellow straight past the lighting.
    doorSign: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    // the hand-made landmarks (js/landmarks.js): one mesh in a chunk that has one
    landmark: landmarkMaterial(),
    // Not a material: the dev switch that turns every landmark back into its
    // generic building (the "before" of a before and after measurement).
    landmarkSwitch: LANDMARK_SWITCH,
    // Not a material: the one switch for every lit window in the city (the far
    // facades and the near shells' glass share one uniform, facadeatlas.js).
    // main.js calls it once a frame with sky.nightK, beside the lamp heads.
    // (The landmarks ride on the same call: how far their own fog wall stands
    // depends on the hour, js/landmarksmat.js.)
    facadeNight(k) { facadeNight(k); landmarkNight(k); },
  };
}

// ---- triangle sink: hand-built geometry with winding-derived normals ----
// Optional uv mode (facade walls): plain tris pin to the neutral plaster cell
// so ridge prisms and roof caps sample "nothing", wallUV maps real sub-rects.
class TriSink {
  // `surf` off for anything that is not ground: a building carries a hundred
  // thousand vertices per chunk and a class index it never reads is 400 kB of
  // nothing. The merges are per-material anyway, so the two never meet.
  constructor(uv = false, surf = true) {
    this.pos = []; this.nrm = []; this.col = []; this.uv = uv ? [] : null;
    // Which material every following triangle is made of — see surfaces.js.
    // A mutable cursor rather than an argument on twenty call sites: the
    // emitters here are already carrying a colour, a terrain and a cell, and
    // threading a thirteenth parameter through capDisc and wallQuad would bury
    // the thing it is trying to say.
    this.sf = surf ? [] : null;
    this.layer = SURF.concrete;
    // The ground sink also carries a LANE coordinate per vertex, in the uv slot
    // (js/surfaces.js reads it): where across the lanes of a carriageway this
    // point lies, and how worn the surface is there. Zero everywhere except on
    // a road deck, which patches the six values of its own quad after emitting
    // it (see roadRibbon), so no other emitter has to know this exists.
    this.ln = surf ? [] : null;
    // Ranges of this.pos that are ALREADY at their absolute height and must not
    // be draped again. Two things need it: a bridge deck, which spans a valley
    // and has to stay level rather than dive into the river, and a riverbank
    // skirt, whose top follows the land while its foot stays at the water.
    this.fixed = [];
  }
  mark() { return this.pos.length; }
  /** Every triangle from here on is made of this. Returns the sink, so it chains. */
  at(layer) { this.layer = layer; return this; }
  fixFrom(start) { if (this.pos.length > start) this.fixed.push(start, this.pos.length); }
  tri(ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b) {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    this.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.col.push(r, g, b, r, g, b, r, g, b);
    if (this.sf) this.sf.push(this.layer, this.layer, this.layer);
    if (this.ln) this.ln.push(0, 0, 0, 0, 0, 0);
    if (this.uv) this.uv.push(PIN_U, PIN_V, PIN_U, PIN_V, PIN_U, PIN_V);
  }
  quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, r, g, b) {
    this.tri(ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b);
    this.tri(ax, ay, az, cx, cy, cz, dx, dy, dz, r, g, b);
  }
  // tri that must face a rough outside direction g* (roof prisms come from an
  // OBB whose axis sign is arbitrary — flip winding when the normal disagrees)
  triFacing(ax, ay, az, bx, by, bz, cx, cy, cz, gx, gy, gz, r, g, b) {
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (nx * gx + ny * gy + nz * gz < 0) this.tri(ax, ay, az, cx, cy, cz, bx, by, bz, r, g, b);
    else this.tri(ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b);
  }
  // textured vertical wall a→b: winding chosen so the derived normal points
  // toward (fx,fz); per-corner colors let the fake-AO gradient ride the storey
  // grid; uvs map one atlas sub-rect (u along the run, v bottom→top).
  // Derivation: quad(aT,bT,bB,aB) has normal ∝ (dz, −dx) of the a→b direction.
  wallUV(ax, az, bx, bz, yB, yT, fx, fz, u0, v0, u1, v1, rB, gB, bB, rT, gT, bT) {
    const dx = bx - ax, dz = bz - az;
    let Ax = ax, Az = az, Bx = bx, Bz = bz, ua = u0, ub = u1, nx = dz, nz = -dx;
    if (nx * fx + nz * fz < 0) { Ax = bx; Az = bz; Bx = ax; Bz = az; ua = u1; ub = u0; nx = -nx; nz = -nz; }
    const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
    this.pos.push(Ax, yT, Az, Bx, yT, Bz, Bx, yB, Bz, Ax, yT, Az, Bx, yB, Bz, Ax, yB, Az);
    for (let k = 0; k < 6; k++) this.nrm.push(nx, 0, nz);
    this.col.push(rT, gT, bT, rT, gT, bT, rB, gB, bB, rT, gT, bT, rB, gB, bB, rB, gB, bB);
    if (this.sf) for (let k = 0; k < 6; k++) this.sf.push(this.layer);
    this.uv.push(ua, v1, ub, v1, ub, v0, ua, v1, ub, v0, ua, v0);
  }
  geo() {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    if (this.sf) g.setAttribute('surf', new THREE.BufferAttribute(new Float32Array(this.sf), 1));
    if (this.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    else if (this.ln) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.ln), 2));
    return g;
  }
}

// ---- what a feature is MADE of -------------------------------------------
// OSM says what a thing IS; these say what it is made of. The mapping is the
// obvious one everywhere it can be, and where OSM is vague the tie is broken
// towards what the Czech Republic actually builds: a `path` is gravel, a
// `pedestrian` street is paving, a `track` between fields is dirt with stone in
// it. Anything unknown falls to grass, because unknown ground in this country
// is a field.
const WOOD_SURF = new Set(['wood', 'forest', 'scrub', 'nature_reserve']);
const FARM_SURF = new Set(['farmland', 'farmyard', 'orchard', 'vineyard', 'allotments', 'greenhouse_horticulture']);
const MEADOW_SURF = new Set(['meadow', 'grassland', 'heath', 'village_green', 'recreation_ground']);
// a clay court and a running track are not grass underfoot
const HARD_SPORT = new Set(['tennis', 'basketball', 'volleyball', 'handball',
  'athletics', 'hockey', 'multi']);
const surfOfGreen = (f) => (f.sp && HARD_SPORT.has(f.sp) ? SURF.paving
  : WOOD_SURF.has(f.t) ? SURF.forest
  : FARM_SURF.has(f.t) ? SURF.farm
  : MEADOW_SURF.has(f.t) ? SURF.meadow
  : SURF.grass);

// …and when OSM SAYS what it is paved with, that beats every guess below. The
// tag is on 1 600 features in the Pardubice tile alone — a surveyor who stood
// on the ground, against a table that infers concrete from the word "parking".
const TAGGED = {
  asphalt: SURF.asphalt, concrete: SURF.concrete, paving: SURF.paving,
  cobble: SURF.cobble, gravel: SURF.gravel, dirt: SURF.dirt, grass: SURF.grass,
};
const surfOfPaved = (f) => TAGGED[f.s]
  ?? (f.t === 'plaza' || f.t === 'pedestrian' || f.t === 'platform' ? SURF.paving
    : f.t === 'yard' ? SURF.gravel : SURF.concrete);
// A way that is WALKED on is laid in small pavers (the 20 x 10 cm concrete block
// of every Czech pavement), where a square is laid in slabs: the same tag in
// OSM, two different floors underfoot.
const ROAD_TAGGED = { ...TAGGED, paving: SURF.pavers };
const ROAD_SURF = {
  pedestrian: SURF.paving, footway: SURF.pavers, cycleway: SURF.asphalt, steps: SURF.concrete,
  path: SURF.gravel, track: SURF.dirt, bridleway: SURF.dirt,
  runway: SURF.concrete, taxiway: SURF.concrete, taxilane: SURF.concrete, airstrip: SURF.gravel,
};
const surfOfRoad = (f) => (f.d ? TAGGED[f.s] : ROAD_TAGGED[f.s]) ?? ROAD_SURF[f.t] ?? SURF.asphalt;
// A town SQUARE is the second fill worth more than its photograph (the car
// park is the first, see the paved fills in buildChunkMeshes). Seen from the
// ground the photo of Staroměstské náměstí is a grey haze with the morning's
// tourists in it as dark blots, patched with the derived paving wherever
// sealed.js closed a footway loop: three surfaces on one square. The data says
// what it is laid with (a plaza tagged sett, a pedestrian street of slabs), so
// that is what is laid, whole, as one surface. Any other paved area keeps the
// photo, which js/orthodetail.js now sharpens up close.
const SQUARE_KINDS = new Set(['plaza', 'pedestrian']);
const laidUnderPhoto = (f) => SQUARE_KINDS.has(f.t) || f.s === 'cobble';
// Is the walked network round this chunk mostly sett? Counted over the ways
// that are walked AND hard-surfaced (a residential street in asphalt says
// nothing about the square beside it), over the 3 x 3 chunks round it and not
// the chunk alone: a square spans several chunks, and a vote per chunk laid
// setts on one side of a chunk border and slabs on the other wherever the edge
// chunk caught only two paths. The 3 x 3 is exactly what the mesh worker's
// spec carries (chunkspec neededKeys), so both sides count the same ways; a
// way listed in several of the nine cells is the same object there (one
// structured clone) and is counted once.
const WALKED = new Set(['footway', 'pedestrian', 'path', 'steps', 'living_street']);
function settSquare(city, cx, cz) {
  let sett = 0, hard = 0;
  const seen = new Set();
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const c = city.chunkIndex.get((cx + dx) + ',' + (cz + dz));
    if (!c) continue;
    for (const r of c.roads) {
      if (!WALKED.has(r.t) || !r.s || seen.has(r)) continue;
      seen.add(r);
      if (r.s === 'cobble') { sett++; hard++; }
      else if (r.s === 'paving' || r.s === 'concrete' || r.s === 'asphalt') hard++;
    }
  }
  return hard >= 3 && sett * 2 > hard;
}

// ---- shared small helpers ----

// uniform-color a stock geometry and strip what mergeGeometries would trip on
function colorize(gIn, hex, layer = SURF.grass) {
  const g = gIn.index ? gIn.toNonIndexed() : gIn;
  g.deleteAttribute('uv');
  _c.setHex(hex);
  const n = g.attributes.position.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('surf', new THREE.BufferAttribute(new Float32Array(n).fill(layer), 1));
  return g;
}

// (x,z) rings → THREE.Shape in the XY plane with y = −z, so that after
// rotateX(−π/2) shape-space lands on world (x, z) facing UP with the winding
// intact — the one mapping needing no post-fixes
function ringShape(outer, holes) {
  const s = new THREE.Shape(outer.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const h of holes ?? []) if (h.length >= 3)
    s.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, -z))));
  return s;
}

// flat colored polygon at height y, or null when triangulation degenerates
function shapePoly(ring, holes, y, hex, layer = SURF.grass) {
  if (!ring || ring.length < 3) return null;
  const g = new THREE.ShapeGeometry(ringShape(ring, holes)).rotateX(-Math.PI / 2);
  if (!g.attributes.position.count) return null;
  if (y) g.translate(0, y, 0);
  return colorize(g, hex, layer);
}

// ---- draping ------------------------------------------------------------
// Everything flat that used to live at a fixed y now has to lie ON the ground.
// That is one operation — take a geometry authored at some height above zero
// and push every vertex up by the terrain under it, keeping the offset — so it
// is one function, used by the ground fills, the road ribbons, the rails and
// the painted markings alike. Vertices are in WORLD coordinates at this point
// (the chunk is rebased later), which is what makes the sampling trivial.
function drape(geo, terrain, fixed = null) {
  if (!terrain || !geo) return geo;
  const p = geo.attributes.position;
  const a = p.array;
  if (!fixed || !fixed.length) {
    for (let i = 0; i < a.length; i += 3) a[i + 1] += terrain.heightAt(a[i], a[i + 2]);
  } else {
    // walk the gaps between the fixed ranges, which are recorded in order
    let at = 0;
    for (let k = 0; k < fixed.length; k += 2) {
      for (let i = at; i < fixed[k]; i += 3) a[i + 1] += terrain.heightAt(a[i], a[i + 2]);
      at = fixed[k + 1];
    }
    for (let i = at; i < a.length; i += 3) a[i + 1] += terrain.heightAt(a[i], a[i + 2]);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

// A chunk-sized ground quad subdivided to the TERRAIN's own grid and displaced.
// The subdivision is not a guess: chunks are 120 m and samples are 20 m apart,
// so six cells a side lands every vertex exactly on a sample and the mesh is
// the height map rather than an approximation of it. Chunk corners are samples
// too, so neighbouring chunks share their edge vertices by construction and no
// crack can open between them.
function terrainQuad(x0, z0, terrain, hex, y = 0, layer = SURF.grass) {
  // 4 m, not 20. The height field is C1-smooth now (terrain.js), and a smooth
  // function drawn with 20 m triangles is faceted right back into the creases
  // the smoothing removed. 4 m is chosen against the road headroom: a chord
  // over a smooth curve stands proud by curvature·step²/8, and at 4 m that
  // stays under the 6 cm a cut road keeps above the ground even on curvature
  // no Czech hillside reaches. 30×30 per chunk is 1 800 ground triangles.
  const SEG = 30;
  const step = CHUNK / SEG;
  const pos = [], idx = [];
  for (let j = 0; j <= SEG; j++) {
    for (let i = 0; i <= SEG; i++) {
      const x = x0 + i * step, z = z0 + j * step;
      // (a vertex by a Prague quay wall is drawn on the wall's line, at its
      // own side's height, instead of as a wedge beside it: quayedge.js)
      const q = terrain ? quaySnap(terrain, x, z, GRID_SNAP) : null;
      if (q) pos.push(q[0], y + q[1], q[2]);
      else pos.push(x, y + (terrain ? quayGroundY(terrain, x, z) : 0), z);
    }
  }
  for (let j = 0; j < SEG; j++) {
    for (let i = 0; i < SEG; i++) {
      const a = j * (SEG + 1) + i, b = a + 1, c = a + SEG + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return colorize(g, hex, layer);
}

// ---- following the ground along a line -----------------------------------
// A road ribbon has vertices only where OSM put them, and OSM puts them where
// the road BENDS — a straight is two points however long it is. Measured on
// Pardubice: the median segment is 17 m but 45 % are longer than the terrain's
// own 20 m spacing and the longest is 615 m. Draping such a segment moves its
// two ends onto the ground and leaves everything between them on the straight
// line joining them, so the road sails over every dip and buries itself in
// every rise — which is how a car ends up hidden UNDER the road it is on.
//
// So the line is resampled first, and adaptively: split a segment only while
// the ground at its midpoint disagrees with the chord by more than TOL. Flat
// country adds no points at all and pays nothing; a hillside gets as many as
// its shape actually needs.
// ---- roads follow the ground EXACTLY, by cutting where the ground bends -----
// A road ribbon is straight between its vertices; the terrain is two flat
// triangles per 20 m cell. Those disagree wherever a road segment crosses a
// break line, and the road is only lifted 20 cm, so where the disagreement
// exceeds that the ground comes through the tarmac and you are looking at an
// aerial photograph of a field laid across your lane.
//
// The first attempt was a uniform 10 m split, which narrows the gap without
// closing it: measured on real height maps, a 10 m chord still broke through at
// 0.34 % of points in Pardubice and 0.90 % in the Zlín hills, by up to 1.32 m.
// Halving the step again would have halved the number and kept the class.
//
// So: cut the road WHERE THE GROUND BENDS, not at a step that hopes to be
// smaller. Terrain.heightAt is planar inside one triangle, so a segment that
// lies inside one triangle is planar too, and road = ground + LAYER holds
// exactly. The break lines are three families of parallel lines —
//
//     x = k·RES        the cell edges running north–south
//     z = k·RES        the cell edges running east–west
//     x + z = k·RES    the diagonal each cell is split on (fx + fz = 1)
//
// — so the split points are just the crossings of a segment with three rulings.
// At most six per 10 m of road, and after them the ribbon cannot break through
// the ground anywhere, by construction rather than by tolerance.
const TERRAIN_MAXSTEP = 12;   // …plus a ceiling, for the far side of a NoData hole
function terrainResample(pts, terrain) {
  // UNIFORM 4 m, and the break-line hunting is gone. It existed for a faceted
  // world: the ground used to bend only on the survey grid's rulings, so
  // cutting a ribbon exactly there made road-above-ground hold by construction.
  // The ground is C1-SMOOTH now (terrain.js) — it bends everywhere and creases
  // nowhere — so the rulings mean nothing, and the segments between the old cut
  // points were straight chords up to 12 m long under a surface that now CURVES
  // over them: on every crest the ground bulged above the chord by
  // curvature·L²/8 and the road sank into the hill. 4 m is the same step the
  // ground mesh itself draws at, so ribbon and ground approximate the same
  // curve with the same error and neither can duck under the other.
  if (!terrain || pts.length < 2) return pts;
  const STEP = 4;
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(L / STEP));
    for (let k = 1; k < n; k++) {
      out.push([ax + (bx - ax) * (k / n), az + (bz - az) * (k / n)]);
    }
    out.push(pts[i + 1]);
  }
  return out;
}


// A bridge deck is straight and level by definition, so it needs no break-line
// cutting — but it still needs VERTICES, because its fascia and parapet are
// extruded per segment and a 200 m span rendered as one quad has nowhere to
// hang them. A fixed step is exactly right here, and it is the ramp length that
// sets it: half a ramp is the longest piece that can still describe the climb.
export function bridgeResample(pts) {
  if (pts.length < 2) return pts;
  const step = Math.max(1, BRIDGE_RAMP / 2);
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push(k === n ? pts[i + 1] : [ax + (bx - ax) * t, az + (bz - az) * t]);
    }
  }
  return out;
}

// ---- terrainTess: give a flat polygon enough vertices to BE a hillside ------
// shapePoly() triangulates a ring with earcut, so the only vertices it produces
// are the ring's own corners. drape() then lifts each of them onto the ground —
// which is exactly right for a 6 m traffic island and a lie for a 300 m park,
// because between four lifted corners lies one enormous flat plane that the
// terrain wanders in and out of. That plane is what you see cutting under the
// road at a kerb, and standing proud of the grass on the far side.
//
// The cure is vertices. This bisects the longest edge of every triangle until
// none is longer than `edge`, which is half the height map's 20 m sample
// spacing — past that point extra vertices buy nothing, because the height map
// has nothing more to say. No terrain sampling happens here: at this stage y is
// still the constant LAYER_Y offset, and drape() does the lifting afterwards.
//
// The colour is read from the first vertex and reused, which is exact for these
// fills (colorize paints one hex across the whole geometry) and is why the
// output can be rebuilt as a plain triangle soup.
// 6 m, against the same chord bound as everything else: a fill sits 5–10 cm
// over the smooth ground, and curvature·6²/8 stays under that on any curvature
// a Czech landscape reaches. The old 10 let the ground bulge through the fills.
const TESS_EDGE = 6;
const TESS_MAX = 6000;      // triangles per polygon — a runaway backstop

/**
 * Triangle soup in, finer triangle soup out: bisect the longest edge until none
 * is longer than `edge`. Longest-edge bisection terminates, and unlike splitting
 * toward the centroid it does not manufacture slivers.
 *
 * Positions only. The two callers want opposite things from the extra vertices —
 * terrainTess() repeats one flat colour, carveOrtho() recomputes UVs from x/z —
 * and both are cheaper to derive from the finished positions than to interpolate
 * through the recursion.
 *
 * The work order is a max-heap on longest edge, not a stack. With a stack the
 * TESS_MAX budget was spent depth-first: one corner of a big meadow ground to
 * 6 m while the rest stayed exactly as earcut left it — and earcut leaves
 * slivers hundreds of metres long, which drape() then lifts at their three
 * corners only. One of those stood out of a Polabiny field as a leaning green
 * wall taller than the player. Splitting the globally longest triangle first
 * means an exhausted budget leaves the whole polygon uniformly as fine as the
 * budget could afford, and the final worst edge is as short as it can be.
 * When the budget is never hit the output set is identical either way —
 * bisecting a triangle depends on nothing outside that triangle.
 */
function tessTriangles(src, triCount, edge) {
  // heap entries: [d2 of longest ground-plane edge, its corner index k, ...tri]
  // (y is a constant layer offset at this stage, so edges are measured in XZ)
  const heap = [];
  const measure = (t) => {
    const d0 = (t[3] - t[0]) ** 2 + (t[5] - t[2]) ** 2;
    const d1 = (t[6] - t[3]) ** 2 + (t[8] - t[5]) ** 2;
    const d2 = (t[0] - t[6]) ** 2 + (t[2] - t[8]) ** 2;
    const k = d0 >= d1 && d0 >= d2 ? 0 : d1 >= d2 ? 1 : 2;
    t[9] = k === 0 ? d0 : k === 1 ? d1 : d2;
    t[10] = k;
    return t;
  };
  const push = (t) => {
    let i = heap.length;
    heap.push(t);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][9] >= t[9]) break;
      heap[i] = heap[p]; heap[p] = t; i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][9] > heap[m][9]) m = l;
        if (r < heap.length && heap[r][9] > heap[m][9]) m = r;
        if (m === i) break;
        heap[i] = heap[m]; heap[m] = last; i = m;
      }
    }
    return top;
  };
  for (let i = 0; i < triCount; i++) {
    const o = i * 9;
    push(measure([src[o], src[o + 1], src[o + 2], src[o + 3], src[o + 4],
      src[o + 5], src[o + 6], src[o + 7], src[o + 8], 0, 0]));
  }
  const e2 = edge * edge;
  let budget = TESS_MAX;
  while (heap.length && heap[0][9] > e2 && budget > 0) {
    budget--;
    const t = pop();
    const k = t[10];
    const a = k * 3, b = ((k + 1) % 3) * 3, c = ((k + 2) % 3) * 3;
    const mx = (t[a] + t[b]) / 2, my = (t[a + 1] + t[b + 1]) / 2, mz = (t[a + 2] + t[b + 2]) / 2;
    push(measure([t[a], t[a + 1], t[a + 2], mx, my, mz, t[c], t[c + 1], t[c + 2], 0, 0]));
    push(measure([mx, my, mz, t[b], t[b + 1], t[b + 2], t[c], t[c + 1], t[c + 2], 0, 0]));
  }
  const p = new Float32Array(heap.length * 9);
  for (let i = 0; i < heap.length; i++) p.set(heap[i].slice(0, 9), i * 9);
  return p;
}

function terrainTess(geo, edge = TESS_EDGE) {
  if (!geo) return geo;
  // ShapeGeometry is indexed (a four-corner quad has four positions plus six
  // indices), while the splitter below consumes an explicit triangle list.
  // Treating those four positions as if they were six produced undefined
  // vertices and, eventually, NaNs in large parks and water polygons.
  const work = geo.index ? geo.toNonIndexed() : geo;
  if (work !== geo) geo.dispose();
  const pos = work.attributes.position;
  const n = pos.count;
  if (n < 3) return work;
  const cSrc = work.attributes.color?.array;
  // The SURFACE CLASS has to survive the subdivision, and for a long time it did
  // not: this function rebuilt a geometry out of position and colour alone, the
  // merge downstream found no `surf` attribute and helpfully filled one in with
  // SURF.grass, and so every polygon fill in the world — every park, every car
  // park, every plaza, every station platform, every square inferred from the
  // photograph — was drawn with the grass TEXTURE. The colour was right, which
  // is exactly what made it hard to see: a grey car park times a green grass
  // texture is a green car park, and it reads as a lawn somebody has parked on.
  // Uniform per geometry, like the colour, so one value is copied out.
  const sSrc = work.attributes.surf?.array;
  const p = tessTriangles(pos.array, n / 3, edge);
  if (p.length === n * 3) {
    // Flat/water shaders do not use ShapeGeometry's UVs. Removing them keeps
    // this unsplit result merge-compatible with split results and TriSink,
    // which both intentionally carry only position/normal/colour.
    work.deleteAttribute('uv');
    return work;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  if (cSrc) {
    const col = new Float32Array(p.length);
    for (let i = 0; i < col.length; i += 3) { col[i] = cSrc[0]; col[i + 1] = cSrc[1]; col[i + 2] = cSrc[2]; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  if (sSrc) {
    g.setAttribute('surf', new THREE.BufferAttribute(new Float32Array(p.length / 3).fill(sSrc[0]), 1));
  }
  g.computeVertexNormals();
  work.dispose();
  return g;
}

// Ground recipes mix ShapeGeometry (indexed, with UVs), terrain grids
// (indexed) and TriSink (non-indexed, no UVs). BufferGeometryUtils correctly
// refuses to merge that mismatch, so normalize the three sources at the one
// boundary where they become a shared flat/water draw call.
function mergeSurfaceGeometries(geometries) {
  const normalized = [];
  for (const source of geometries) {
    const g = source.index ? source.toNonIndexed() : source;
    if (g !== source) source.dispose();
    g.deleteAttribute('uv');
    // Anything that reached here without a class is ground: terrainTess and the
    // stock geometries hand back what colorize gave them, but a merge is a
    // union of ATTRIBUTES and one missing buffer takes the whole chunk out.
    // A geometry with no class is ground — the stock quads and the far tier.
    // This default was a trap once: terrainTess used to DROP the class, and
    // silently defaulting every polygon fill in the world to grass turned a
    // real bug into an invisible one. It is kept because a merge is a union of
    // attributes and one missing buffer takes the whole chunk out, but the
    // producers all carry the class now — see tests/surface-class.test.mjs.
    if (!g.attributes.surf) {
      const n = g.attributes.position.count;
      g.setAttribute('surf', new THREE.BufferAttribute(new Float32Array(n).fill(SURF.grass), 1));
    }
    normalized.push(g);
  }
  return mergeGeometries(normalized, false);
}

// Polyline frame for ribbon extrusion: deduped points, cumulative distance,
// per-point miter perpendicular pre-scaled by 1/cos(halfTurn) (clamped so
// hairpins don't shoot kilometer spikes) — parallel edges through bends.
function ribbonFrame(pts) {
  const q = [];
  for (const pt of pts) {
    const l = q[q.length - 1];
    if (!l || Math.hypot(pt[0] - l[0], pt[1] - l[1]) > 0.01) q.push(pt);
  }
  const n = q.length;
  if (n < 2) return null;
  const along = [0], per = [];
  for (let i = 1; i < n; i++)
    along.push(along[i - 1] + Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]));
  for (let i = 0; i < n; i++) {
    const a = q[Math.max(0, i - 1)], b = q[i], c = q[Math.min(n - 1, i + 1)];
    let p1x = b[0] - a[0], p1z = b[1] - a[1];
    let p2x = c[0] - b[0], p2z = c[1] - b[1];
    if (i === 0) { p1x = p2x; p1z = p2z; }
    if (i === n - 1) { p2x = p1x; p2z = p1z; }
    const l1 = Math.hypot(p1x, p1z) || 1, l2 = Math.hypot(p2x, p2z) || 1;
    p1x /= l1; p1z /= l1; p2x /= l2; p2z /= l2;
    let mx = p1x + p2x, mz = p1z + p2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-4) { mx = p2x; mz = p2z; } else { mx /= ml; mz /= ml; } // 180° U-turn fallback
    const s = 1 / Math.max(0.35, mx * p2x + mz * p2z);
    per.push([mz * s, -mx * s]); // (dz,−dx): the perp whose +side quads wind CCW from above
  }
  return { q, along, per, len: along[n - 1] };
}

// point + direction at distance d along a frame (build-time linear scan)
function walkAt(fr, d, out) {
  const { q, along } = fr;
  let i = 0;
  while (i < q.length - 2 && along[i + 1] < d) i++;
  const t = Math.min(1, Math.max(0, (d - along[i]) / ((along[i + 1] - along[i]) || 1)));
  out.x = q[i][0] + (q[i + 1][0] - q[i][0]) * t;
  out.z = q[i][1] + (q[i + 1][1] - q[i][1]) * t;
  const dx = q[i + 1][0] - q[i][0], dz = q[i + 1][1] - q[i][1];
  const l = Math.hypot(dx, dz) || 1;
  out.dx = dx / l; out.dz = dz / l;
}

// flat disc fan — road endpoints read round instead of chopped
function capDisc(sink, x, y, z, r, cr, cg, cb) {
  for (let k = 0; k < CAP_SEGS; k++) {
    const a0 = (k / CAP_SEGS) * Math.PI * 2, a1 = ((k + 1) / CAP_SEGS) * Math.PI * 2;
    sink.tri(x, y, z,
      x + Math.cos(a1) * r, y, z + Math.sin(a1) * r,
      x + Math.cos(a0) * r, y, z + Math.sin(a0) * r, cr, cg, cb);
  }
}

// vertical wall a→b whose face points toward (fx,fz) — quad(aT,bT,bB,aB)
// faces (dz,−dx) of the run, so flip the run when that disagrees
function wallQuad(sink, ax, az, bx, bz, yT, yB, fx, fz, r, g, b) {
  const dx = bx - ax, dz = bz - az;
  if (dz * fx - dx * fz >= 0) sink.quad(ax, yT, az, bx, yT, bz, bx, yB, bz, ax, yB, az, r, g, b);
  else sink.quad(bx, yT, bz, ax, yT, az, ax, yB, az, bx, yB, bz, r, g, b);
}

// wallQuad with its own top height at each end, for walls that follow ground
function wallQuad2(sink, ax, az, bx, bz, yTa, yTb, yB, fx, fz, r, g, b) {
  const dx = bx - ax, dz = bz - az;
  if (dz * fx - dx * fz >= 0) sink.quad(ax, yTa, az, bx, yTb, bz, bx, yB, bz, ax, yB, az, r, g, b);
  else sink.quad(bx, yTb, bz, ax, yTa, az, ax, yB, az, bx, yB, bz, r, g, b);
}

// Sutherland–Hodgman ring ∩ axis-aligned rect. Earcut (behind ShapeGeometry /
// triangulateShape) is robust to the touching-hole degeneracies this can emit
// where adjacent riverbank polygons share an edge, so results feed it as-is.
function clipRingToRect(ring, x0, z0, x1, z1) {
  let out = ring;
  for (const [axis, lim, sgn] of [[0, x0, 1], [0, x1, -1], [1, z0, 1], [1, z1, -1]]) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i], b = src[(i + 1) % src.length];
      const da = (a[axis] - lim) * sgn, db = (b[axis] - lim) * sgn; // ≥0 = inside this half-plane
      if (da >= 0) out.push(a);
      if ((da < 0) !== (db < 0)) {
        const t = da / (da - db);
        out.push(axis === 0 ? [lim, a[1] + (b[1] - a[1]) * t] : [a[0] + (b[0] - a[0]) * t, lim]);
      }
    }
    if (out.length < 3) return null;
  }
  return out;
}

// Liang–Barsky segment ∩ rect → param window {t0,t1} or null
function clipSeg(ax, az, bx, bz, x0, z0, x1, z1) {
  const P = [ax - bx, bx - ax, az - bz, bz - az], Q = [ax - x0, x1 - ax, az - z0, z1 - az];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (P[i] === 0) { if (Q[i] < 0) return null; }
    else {
      const r = Q[i] / P[i];
      if (P[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
  }
  return { t0, t1 };
}

// ---- no fill may rise above a carriageway that runs over it ---------------
// Fills are draped on the raw terrain; carriageways are LEVELLED, and a
// levelled road may cut up to GRADE_CUT below the terrain. So over any road in
// cutting, a green median at terrain + 0.05 or a car park at terrain + 0.10
// sits ABOVE the deck at grade + 0.20 − cut — which is grass growing out of
// the middle of Palackého třída with the lane dashes floating over it.
//
// The rule that fixes it is the physical one: a surface under a road is under
// the road. Every fill vertex that lies within a drivable corridor is pushed
// down to just below that deck; vertices outside the corridor keep their
// height, so the fill dives under the ribbon's edge the way ground under a
// kerb actually does. min() only — a road on an embankment is ABOVE the fill
// already, and under a bridge the deck is metres up, where min() changes
// nothing.
const _cl = { x: 0, z: 0, t: 0 };      // distPointToSegment's reusable answer
// A GENERATOR, because this is the single most expensive loop of a chunk
// build: every vertex tests every corridor's every segment, and one big park
// fill against a downtown 3×3's roads was 96 ms in a single call — the
// worst of the driving stutter after the builds themselves were sliced. The
// vertex loop carries no cross-vertex state, so it can pause anywhere;
// buildChunkMeshesGen delegates with yield* and the streamer's budget does
// the rest. clampUnderRoads below stays as the drain-it-all wrapper.
function* clampUnderRoadsGen(geo, drv, terrain, offX = 0, offZ = 0) {
  if (!geo || !drv?.length || !terrain) return geo;
  const a = geo.attributes.position.array;
  // corridors that cannot touch this geometry are dropped ONCE, not per
  // vertex, and the per-segment test is squared distance with no allocation —
  // this runs for every fill and every ground quad of every chunk build.
  // offX/offZ translate a LOCAL-frame geometry (the uncarved photo quad,
  // built around its own centre) into world space for the tests.
  let gx0 = 1e9, gz0 = 1e9, gx1 = -1e9, gz1 = -1e9;
  for (let i = 0; i < a.length; i += 3) {
    const x = a[i] + offX, z = a[i + 2] + offZ;
    if (x < gx0) gx0 = x; if (x > gx1) gx1 = x;
    if (z < gz0) gz0 = z; if (z > gz1) gz1 = z;
  }
  const use = drv.filter(({ bb, hw, flare }) => {
    const rc = hw + (flare ?? 0);
    return !(gx1 < bb[0] - rc || gx0 > bb[2] + rc || gz1 < bb[1] - rc || gz0 > bb[3] + rc);
  });
  if (!use.length) return geo;
  const segs = use.map((u) => roadSegs(u.r));     // once per call, not per vertex
  let sinceYield = 0;
  for (let i = 0; i < a.length; i += 3) {
    if (++sinceYield >= 200) { sinceYield = 0; yield; }
    const x = a[i] + offX, z = a[i + 2] + offZ;
    // TWO-PHASE, because corridors overlap: the tightest ceiling over all
    // roads, the tallest embankment floor over all roads — and the floor may
    // never outgrow the ceiling. Applied sequentially, a HIGH road processed
    // after a LOW one raised the ground with its embankment body right back
    // OVER the low road's asphalt — a bridge ramp beside the Labe stood the
    // photograph 3 m above a primary's lanes, and every dual carriageway on
    // a cross-slope grew the reported green tongue out of its median.
    let minCap = Infinity, maxFloor = -Infinity;
    for (let ui = 0; ui < use.length; ui++) {
      const ent = use[ui], { r, bb, hw, lay, flare } = ent;
      const reach = hw + (flare ?? 0);
      if (x < bb[0] - reach || x > bb[2] + reach || z < bb[1] - reach || z > bb[3] + reach) continue;
      const rc2 = reach * reach;
      const sg = segs[ui];
      for (let o = 0; o < sg.length; o += 10) {
        // the nearest point of a segment lies inside the segment's own box, so
        // a vertex further than `reach` from the box is further from the line
        if (x < sg[o + 6] - reach || x > sg[o + 7] + reach
          || z < sg[o + 8] - reach || z > sg[o + 9] + reach) continue;
        const ax = sg[o], az = sg[o + 1], dx = sg[o + 2], dz = sg[o + 3], L = sg[o + 4];
        const L2 = L * L || 1e-9;
        let t = ((x - ax) * dx + (z - az) * dz) / L2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const px = ax + dx * t, pz = az + dz * t;
        const ex = x - px, ez = z - pz;
        const d2 = ex * ex + ez * ez;
        if (d2 < rc2) {
          const s2 = sg[o + 5] + L * t;
          const gy = r.br ? bridgeDeckHeight(r, s2, terrain) : roadGradeY(r, s2, terrain);
          if (gy !== null && gy !== undefined) {
            // flat within the corridor; beyond it the cap RISES at 55 % so
            // the bench meets the hillside as a bank, not as a one-step
            // cliff of stretched grass ("a co toto?")
            // (a track's ceiling climbs at the 1:1.5 batter past its bed,
            // js/batter.js: a lower track beside it no longer pulls it down)
            const d = Math.sqrt(d2);
            const over = d > hw ? (d - hw) * (ent.rise ?? 0.55) : 0;
            const top = gy + (lay ?? LAYER_Y.road);
            const cap = top - 0.05 + over;
            if (cap < minCap) minCap = cap;
            // …and the same shape works UPWARD: where the terrain fell away
            // under an embanked road, the deck floated on a metre of striped
            // kerb wall. The ground now rises to an embankment body — snug
            // under the deck edge, falling away at the same 55 % — exactly
            // the earthwork a real road stands on. Only for flared entries
            // (the ground quad); bridges never enter this list.
            // (outside the streets the body falls at the 1:1.5 batter from
            // just under the deck edge, the slope the verge face is drawn
            // at: js/batter.js floorOf)
            if (flare) {
              const floor = ent.bat === undefined ? top - 0.45 - (d > hw ? (d - hw) * 0.55 : 0)
                : floorOf(ent, gy, d);
              if (floor > maxFloor) maxFloor = floor;
            }
          }
        }
      }
    }
    // apply: ceiling first, and the embankment floor is itself CEILINGED by
    // every other road's cap — ground rises into a bank only where no lower
    // carriageway needs the space
    const floor2 = Math.min(maxFloor, minCap);
    if ((a[i + 1] > minCap || a[i + 1] < floor2) && stampShaped(terrain, x, z)) continue;
    if (a[i + 1] > minCap) a[i + 1] = minCap;
    // (…except onto ground a stamp shaped: the quay floor at the foot of a
    // Prague embankment is not a hollow under the street above it, and the
    // street's embankment body stood up out of it as a row of sails along
    // the wall, and over the stairs built up against it (js/naplavky.js).
    // city.heightAt offers no bank there either. And a vertex drawn metres
    // under the ground at its x/z is the foot of a quay wall that
    // js/quayground.js put on the wall's line, a hair behind it.)
    if (floor2 > -Infinity && a[i + 1] < floor2
      && !(a[i + 1] < terrain.heightAt(x, z) - 1)) a[i + 1] = floor2;
  }
  geo.attributes.position.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}
function clampUnderRoads(geo, drv, terrain, offX = 0, offZ = 0) {
  const g = clampUnderRoadsGen(geo, drv, terrain, offX, offZ);
  let it;
  do { it = g.next(); } while (!it.done);
  return it.value;
}

// ---- water: sunken surface + earthy bank walls cut through the ground ----

// Vertical bank wall along a water outline ring, from the 5 cm curb lip down
// to just under the water. Emitted piece by piece into whichever chunk owns
// the piece midpoint — global dedupe with no second index. `inward` walls the
// ring interior (river outer ring); false faces away (island: into the water).
// Interior of a positive-area ring lies on (−dz,dx) — see wallQuad's note.
// The surface height of one body of water, cached on the feature. DMR 5G is
// LiDAR and light does not go through water, so what the model records over a
// river IS the river's surface — which means the LOWEST ground the outline
// touches is the water, and the higher samples are the banks it is cut into.
// Cached because a river is one feature crossing dozens of chunks and every one
// of them must agree, or the Vltava gets a staircase at each cell border.
// ---- a river FLOWS, so its surface cannot be one number --------------------
// The level used to be a single global minimum over the whole outline, shared
// by every chunk the body touches, "or the Vltava gets a staircase at each cell
// border". That is right for a pond and badly wrong for a river: a watercourse
// mapped as ONE polygon runs downhill, and the minimum is its lowest point
// anywhere. Swept over all 342 shipped tiles, 95 bodies ended up with their
// surface more than 3 m under their own typical bank and the worst sat 29 m
// down — a canyon with a blue floor, which is exactly what the player
// photographed.
//
// So the level is a FIELD instead: a soft minimum of the ground along the
// nearby outline, weighted by distance. Soft, because a hard minimum over a
// moving window is a staircase again; it is smooth in x and z, so two chunks
// meeting at a border compute the same number from the same samples and no
// seam can open. It follows the water downhill, it stays flat across a lake,
// and it turns a weir into a ramp rather than a cliff.
const LEVEL_SIGMA = 95;      // m — how far along the bank a level looks
const LEVEL_TAU = 0.7;       // m — how sharply the soft minimum bites
const LEVEL_STEP = 28;       // m — spacing of the samples along the outline

/**
 * Ground samples along a body's outline, cached per feature and BUCKETED by
 * LEVEL_SIGMA. The bucketing is not an optimisation, it is the difference
 * between working and not: a query that scanned every sample cost O(vertices ×
 * samples), and the Labe carries ~1 400 outline vertices, so one chunk of it
 * measured 369 ms — a third of a second of frozen main thread, inside a single
 * un-yielded slice. Only the samples within a couple of windows can carry any
 * weight anyway, since the kernel is a Gaussian.
 */
function waterSamples(f, terrain) {
  // Cached until the ground CHANGES. A partial profile — the normal case while
  // a chunk is meshed ahead of its height map — used to be refused by the
  // cache, so the whole outline was re-walked on every single query, i.e. per
  // water vertex and per skirt piece. On the Labe that is 1 447 vertices
  // re-sampled tens of thousands of times for one chunk, and it is the stall
  // you feel driving into ground that has not landed yet. Keying on the
  // terrain's load counter keeps the incomplete answer for exactly as long as
  // it is the best one available, and recomputes once when a tile arrives.
  const loads = terrain._loads ?? 0;
  if (f._ws && (f._wsFull || f._wsLoads === loads)) return f._ws;
  const out = [];
  let missing = false;
  for (const ring of [f.o, ...(f.i ?? [])]) {
    if (!ring || ring.length < 2) continue;
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(L / LEVEL_STEP));
      for (let k = 0; k < n; k++) {
        const x = ax + (bx - ax) * (k / n), z = az + (bz - az) * (k / n);
        // an unmeasurable sample must RAISE THE FLAG — skipping it silently
        // let a chunk finish "clean" and never rebuild, with the river's
        // level measured on half its outline
        if (!terrain.ready(x, z)) {
          missing = true;
          terrain.missed = true;
          terrain._missTiles?.add(Math.floor(x / terrain.tile) + ',' + Math.floor(z / terrain.tile));
          continue;
        }
        out.push(x, z, terrain.heightAt(x, z));
      }
    }
  }
  // index them: cell key -> flat sample offsets that fall in it
  const grid = new Map();
  for (let i = 0; i < out.length; i += 3) {
    const k = Math.floor(out[i] / LEVEL_SIGMA) + ',' + Math.floor(out[i + 1] / LEVEL_SIGMA);
    let a = grid.get(k);
    if (!a) grid.set(k, a = []);
    a.push(i);
  }
  f._ws = { s: out, grid };
  f._wsLoads = loads;
  // …and a profile measured on half a river is still thrown away once the rest
  // of the ground arrives: `missing` is what makes the chunk rebuild, and the
  // load counter above is what makes this recompute when it does.
  f._wsFull = !missing;
  return f._ws;
}

/**
 * The surface height of one body of water AT A POINT. Callers that only need
 * one number for a whole body (the tree scatter's "is this wet") can pass the
 * body's own centre.
 */
const _wsHit = [];       // scratch: sample offsets in reach of one query
function waterLevelAt(f, x, z, terrain) {
  if (!terrain) return WATER_Y;
  // the Prague Vltava is a staircase of weir-held pools, authored (riverpools.js)
  const pooled = riverLevelAt(f, x, z);
  if (pooled !== null) return pooled;
  const { s, grid } = waterSamples(f, terrain);
  if (!s.length) return 0 - 0.35;
  // widen until something is in reach — a chunk in the middle of a lake can be
  // further from the outline than one window
  for (let r = LEVEL_SIGMA; ; r *= 2) {
    const r2 = r * r, s2 = (r / 2) ** 2;
    const c = Math.ceil(r / LEVEL_SIGMA);
    const cx = Math.floor(x / LEVEL_SIGMA), cz = Math.floor(z / LEVEL_SIGMA);
    _wsHit.length = 0;
    let lo = Infinity;
    for (let dx2 = -c; dx2 <= c; dx2++) for (let dz2 = -c; dz2 <= c; dz2++) {
      const a = grid.get((cx + dx2) + ',' + (cz + dz2));
      if (!a) continue;
      for (const i of a) {
        const d2 = (s[i] - x) ** 2 + (s[i + 1] - z) ** 2;
        if (d2 > r2) continue;
        _wsHit.push(i, d2);
        if (s[i + 2] < lo) lo = s[i + 2];
      }
    }
    if (!Number.isFinite(lo)) {
      if (r > 40000) return 0 - 0.35;
      continue;
    }
    // log-sum-exp soft minimum, offset by `lo` so the exponentials cannot
    // overflow; weights fall off with distance so the field is smooth
    let wsum = 0, esum = 0;
    for (let k = 0; k < _wsHit.length; k += 2) {
      const w = Math.exp(-_wsHit[k + 1] / s2);
      wsum += w;
      esum += w * Math.exp(-(s[_wsHit[k] + 2] - lo) / LEVEL_TAU);
    }
    return lo - LEVEL_TAU * Math.log(esum / wsum) - 0.35;
  }
}

function skirtRing(sink, ring, key, inward, r, g, b, terrain, wyAt, quayRoads, fine = true) {
  const sgn = (polygonArea(ring) > 0 ? 1 : -1) * (inward ? 1 : -1);
  // The ring is the WHOLE body — the Labe carries 1 447 vertices running for
  // kilometres — and every chunk it touches used to subdivide all of them just
  // to throw away the pieces that landed elsewhere. Measured at 377 ms for one
  // chunk, in a single un-yielded slice: a third of a second of frozen frame.
  // A segment that cannot reach this cell is rejected by four comparisons.
  const [kcx, kcz] = key.split(',').map(Number);
  const bx0 = kcx * CHUNK, bz0 = kcz * CHUNK, bx1 = bx0 + CHUNK, bz1 = bz0 + CHUNK;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    if (Math.max(ax, bx) < bx0 || Math.min(ax, bx) > bx1
      || Math.max(az, bz) < bz0 || Math.min(az, bz) > bz1) continue;
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-6) continue;
    const n = Math.ceil(L / SKIRT_MAX), fx = -sgn * (bz - az), fz = sgn * (bx - ax);
    for (let k = 0; k < n; k++) {
      const p0x = ax + (bx - ax) * k / n, p0z = az + (bz - az) * k / n;
      const p1x = ax + (bx - ax) * (k + 1) / n, p1z = az + (bz - az) * (k + 1) / n;
      if (chunkKey((p0x + p1x) / 2, (p0z + p1z) / 2) !== key) continue;
      // The bank runs from the GROUND at this point down to just under the
      // water. On a flat world both ends were constants; on terrain the top
      // follows the land and only the bottom is shared, which is what makes a
      // cutting look like a cutting instead of a trench of fixed depth.
      // Absolute heights, so the chunk-wide drape must skip them.
      if (terrain) {
        // one height per END — a single midpoint sample across a 30 m piece
        // left the wall top a metre off the draped ground at both ends on any
        // sloping bank, a slit at one end and a buried lip at the other.
        // The water level is read at the PIECE, from the same field the
        // surface uses, so the foot of the wall meets the water all the way
        // along a river that is running downhill.
        const wy = wyAt((p0x + p1x) / 2, (p0z + p1z) / 2);
        const t0 = Math.max(terrain.heightAt(p0x, p0z) + BANK_TOP, wy + 0.05);
        const t1 = Math.max(terrain.heightAt(p1x, p1z) + BANK_TOP, wy + 0.05);
        // a pooled Prague body's high bank is a built quay (quaywall.js)
        if (quayRoads && Math.max(t0, t1) - wy > QUAY_MIN) {
          const par = embankmentNear(quayRoads, (p0x + p1x) / 2, (p0z + p1z) / 2,
            Math.max(t0, t1), (x, z) => terrain.heightAt(x, z));
          sink.at(SURF.paving);
          // (a balustrade where the real embankment has one; the far shell
          // keeps the solid wall, which reads the same from up there)
          const bal = par && fine && balustradeAt((p0x + p1x) / 2, (p0z + p1z) / 2);
          quayPiece(sink, p0x, p0z, p1x, p1z, t0, t1, wy, fx, fz, par, bal ? 'balustrade' : null);
          sink.at(SURF.dirt);
        } else wallQuad2(sink, p0x, p0z, p1x, p1z, t0, t1, wy - 0.4, fx, fz, r, g, b);
      } else wallQuad(sink, p0x, p0z, p1x, p1z, BANK_TOP, BANK_DEPTH, fx, fz, r, g, b);
    }
  }
}

// every road of the 3x3 chunk neighbourhood: an embankment street can run
// just across the border from the bank it owns
function nearRoads(city, cell, cx, cz) {
  // (a Set, in insertion order: a dense Prague neighbourhood is a thousand
  // roads, and an includes() per road was a million compares per river chunk)
  const out = new Set();
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const c2 = dx === 0 && dz === 0 ? cell : city.chunkIndex.get((cx + dx) + ',' + (cz + dz));
    if (c2) for (const r of c2.roads) out.add(r);
  }
  return [...out];
}

function inWater(x, z, waters) {
  for (const w of waters)
    if (pointInPolygon(x, z, w.o) && !(w.i ?? []).some((h) => pointInPolygon(x, z, h))) return true;
  return false;
}

// waterway polylines aren't in geo's chunk index — bucket them once, lazily,
// by bbox inflated by their half-width, and cache the map on the city object
function wwBuckets(city) {
  let m = city._wwChunks;
  if (m) return m;
  m = city._wwChunks = new Map();
  for (const f of city.waterways ?? []) {
    if (!f.p || f.p.length < 2 || isCulvert(f)) continue;   // underground, not a trench
    const r = (f.w ?? 2) / 2 + 1;
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const [x, z] of f.p) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    for (let cx = Math.floor((minX - r) / CHUNK); cx <= Math.floor((maxX + r) / CHUNK); cx++)
      for (let cz = Math.floor((minZ - r) / CHUNK); cz <= Math.floor((maxZ + r) / CHUNK); cz++) {
        const key = cx + ',' + cz;
        (m.get(key) ?? m.set(key, []).get(key)).push(f);
      }
  }
  return m;
}

/** The waterways one chunk draws — the same bucket the builder reads, so a
 *  worker handed only these gets the identical trench. */
export function waterwaysIn(city, key) { return wwBuckets(city).get(key) ?? null; }

// One continuous in-chunk piece of a waterway trench: hole ring for the
// ground carve, sunken surface, and bank walls facing the centreline. End
// caps only where the stream truly begins/ends — chunk-border cuts stay open
// so the neighbour's piece continues seamlessly.
function emitTrench(sink, water, holes, run, hw, x0, z0, x1, z1, kr, kg, kb, cap1, terrain) {
  const n = run.length, ring = [];
  for (let i = 0; i < n; i++) ring.push([run[i].x + run[i].px * hw, run[i].z + run[i].pz * hw]);
  for (let i = n - 1; i >= 0; i--) ring.push([run[i].x - run[i].px * hw, run[i].z - run[i].pz * hw]);
  // miter offsets can poke past the rect at border cuts; a hole partly outside
  // the ground outline upsets earcut, so clip the ring like the water polys
  const clip = clipRingToRect(ring, x0, z0, x1, z1);
  if (clip && Math.abs(polygonArea(clip)) > 0.5) {
    holes.push(clip);
    // A stream is a local cut, not a body with a level of its own: it runs
    // downhill with the land. So its surface is a fixed depth BELOW the ground
    // it crosses, which drape() produces for free — and which is what lets a
    // brook descend a hillside instead of pooling at one absolute height.
    const g = drape(terrainTess(shapePoly(clip, null, -TRENCH_D, COLORS.water), 8), terrain);
    if (g) water.push(g);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = run[i], b = run[i + 1], fx = -(a.px + b.px), fz = -(a.pz + b.pz);
    wallQuad(sink, a.x + a.px * hw, a.z + a.pz * hw, b.x + b.px * hw, b.z + b.pz * hw,
      BANK_TOP, BANK_DEPTH, fx, fz, kr, kg, kb);
    wallQuad(sink, a.x - a.px * hw, a.z - a.pz * hw, b.x - b.px * hw, b.z - b.pz * hw,
      BANK_TOP, BANK_DEPTH, -fx, -fz, kr, kg, kb);
  }
  if (run.cap0) {
    const a = run[0], b = run[1];
    wallQuad(sink, a.x + a.px * hw, a.z + a.pz * hw, a.x - a.px * hw, a.z - a.pz * hw,
      BANK_TOP, BANK_DEPTH, b.x - a.x, b.z - a.z, kr, kg, kb);
  }
  if (cap1) {
    const a = run[n - 1], b = run[n - 2];
    wallQuad(sink, a.x + a.px * hw, a.z + a.pz * hw, a.x - a.px * hw, a.z - a.pz * hw,
      BANK_TOP, BANK_DEPTH, b.x - a.x, b.z - a.z, kr, kg, kb);
  }
}

// Walk one waterway through this chunk: clip every segment to the cell rect
// (NOT home-chunk dedupe — trench pieces must tile exactly across borders),
// drop legs already inside a mapped water polygon (double-carved overlapping
// holes are the one thing earcut genuinely hates, and mid-river trench walls
// would look absurd), and stitch surviving stretches into runs.
function trenchInto(sink, water, holes, f, cell, x0, z0, x1, z1, kr, kg, kb, terrain) {
  const fr = (f._fr ??= ribbonFrame(f.p));
  if (!fr) return;
  const { q, per } = fr;
  const hw = Math.max(0.5, (f.w ?? 2) / 2);
  let run = null;
  const flush = (cap1) => {
    if (run && run.length > 1) emitTrench(sink, water, holes, run, hw, x0, z0, x1, z1, kr, kg, kb, cap1, terrain);
    run = null;
  };
  for (let i = 0; i < q.length - 1; i++) {
    const ax = q[i][0], az = q[i][1], bx = q[i + 1][0], bz = q[i + 1][1];
    const c = clipSeg(ax, az, bx, bz, x0, z0, x1, z1);
    if (!c) { flush(false); continue; }
    if (run && c.t0 > 0) flush(false); // the previous segment's end isn't shared — gap
    // cut ends use the plain segment perp — both neighbours derive it from the
    // same segment, so the trench edge matches exactly across the border; miter
    // perps only apply at true polyline joints (ta 0 / tb 1)
    const L = Math.hypot(bx - ax, bz - az) || 1, spx = (bz - az) / L, spz = -(bx - ax) / L;
    // walk the in-rect window in ≤6 m pieces so a stream MOUTH only pokes a
    // couple of meters into the river's own carve hole before the in-water
    // test drops it — overlapping holes confuse earcut, and trench walls
    // across the junction would dam the confluence
    const steps = Math.max(1, Math.ceil(L * (c.t1 - c.t0) / 6));
    for (let k = 0; k < steps; k++) {
      const ta = k === 0 ? c.t0 : c.t0 + (c.t1 - c.t0) * k / steps;
      const tb = k + 1 === steps ? c.t1 : c.t0 + (c.t1 - c.t0) * (k + 1) / steps;
      const sx = ax + (bx - ax) * ta, sz = az + (bz - az) * ta;
      const ex = ax + (bx - ax) * tb, ez = az + (bz - az) * tb;
      if (inWater((sx + ex) / 2, (sz + ez) / 2, cell.water)) { flush(false); continue; }
      if (!run) {
        run = [{ x: sx, z: sz, px: ta === 0 ? per[i][0] : spx, pz: ta === 0 ? per[i][1] : spz }];
        run.cap0 = i === 0 && ta === 0;
      }
      run.push({ x: ex, z: ez, px: tb === 1 ? per[i + 1][0] : spx, pz: tb === 1 ? per[i + 1][1] : spz });
    }
    if (c.t1 < 1) flush(false); // cut at the cell border — neighbour continues it
  }
  flush(true); // a run still open here reached the polyline's true end uncut
}

// ---- roads: mitered ribbon + caps + bridge fascia/parapets + dashes ----
/**
 * Is (x, z) on some OTHER drivable road's carriageway? `grow` widens or narrows
 * the test against each road's own half-width.
 *
 * Two callers, one question. Edge lines use it so four overlapping ways do not
 * paint four sets of white lines on the same tarmac; footpaths use it because a
 * path crossing a road is a CROSSING, not a beige strip laid over the asphalt.
 */
// Like onCarriageway, but only counts a road CROSSING this one — the segment
// under (x,z) has to run at a real angle (>~26°) to `self`'s direction there.
// A parallel dual-carriageway twin or a merging slip overlaps for hundreds of
// metres, and treating that as "covered" erased every dash on Palackého.
function crossedBy(cell, self, x, z, dirX, dirZ, grow = 0) {
  for (const o of cell.roads) {
    if (o === self || !o.d) continue;
    const half = (o.w ?? 3) / 2 + grow;
    if (half <= 0) continue;
    const bb = bboxOfLine(o);
    if (x < bb[0] - half || x > bb[2] + half || z < bb[1] - half || z > bb[3] + half) continue;
    for (let k = 0; k < o.p.length - 1; k++) {
      const [ax, az] = o.p[k], [bx, bz] = o.p[k + 1];
      if (distPointToSegment(x, z, ax, az, bx, bz, null) >= half) continue;
      const ex = bx - ax, ez = bz - az;
      const L = Math.hypot(ex, ez) || 1e-9;
      const cross = Math.abs(dirX * (ez / L) - dirZ * (ex / L));
      if (cross > 0.22) return true;
    }
  }
  return false;
}

function onCarriageway(cell, self, x, z, grow = 0) {
  for (const o of cell.roads) {
    if (o === self || !o.d) continue;
    const half = (o.w ?? 3) / 2 + grow;
    if (half <= 0) continue;
    const bb = bboxOfLine(o);
    if (x < bb[0] - half || x > bb[2] + half || z < bb[1] - half || z > bb[3] + half) continue;
    for (let k = 0; k < o.p.length - 1; k++) {
      if (distPointToSegment(x, z, o.p[k][0], o.p[k][1], o.p[k + 1][0], o.p[k + 1][1], null) < half) return true;
    }
  }
  return false;
}

// ---- streets: the things beside and on a carriageway ------------------------
// Tints are sRGB hex like every other colour here. The kerb stone is a shade
// lighter than the old concrete road edge so the kerb LINE reads from a car;
// the pavement is the small grey concrete paver most Czech towns are laid in.
const KERBTOP_HEX = 0xa9a69f, WALK_HEX = 0x9c9992, VERGE_HEX = 0x52683f;
const IRON_HEX = 0x33353a, COLLAR_HEX = 0x5b5c5e;
// A higher road class lies a few millimetres OVER a lower one. Ways overlap
// all over the data (a service road along a kerb, a slip road over its own
// main road), and since they stopped being one grey an overlap at one height
// is two tints fighting for the same pixels. Three millimetres a rank settles
// who is on top, and it is the road that carries on.
const RANK_LIFT = 0.003;
// paint above its own deck: what LAYER_Y gives it, measured from the asphalt
const MARK = LAYER_Y.marking - LAYER_Y.road;
// How worn a carriageway looks, by class: the lane coordinate's second half.
const WEAR = {
  motorway: 0.72, trunk: 0.7, primary: 0.68, secondary: 0.62, tertiary: 0.56,
  motorway_link: 0.6, trunk_link: 0.6, primary_link: 0.58, secondary_link: 0.55,
  tertiary_link: 0.5, unclassified: 0.42, residential: 0.4, living_street: 0.26, service: 0.22,
};

/** The junction or cluster whose pad (x, z) lies on, from a way's nearby list. */
function inPads(js, x, z) {
  for (const j of js) {
    // a member answers through its cluster, a roundabout node has no pad.
    // (`_ring` is that flag on a NODE and the outline itself on a CLUSTER:
    // tested bare, it threw every cluster out of this list, and lane lines
    // ran on past the mouth of every big crossing.)
    if (j._cluster || (!j.members && j._ring)) continue;
    const R = j.padR ?? j.pad;
    if ((x - j.x) ** 2 + (z - j.z) ** 2 > R * R) continue;
    const ring = j.members ? clusterHull(j) : junctionHull(j);
    if (ring && pointInPolygon(x, z, ring)) return j;
  }
  return null;
}

// a wall between two posts with its own top and bottom at each, facing (fx, fz)
function wallQuad4(sink, ax, az, bx, bz, yTa, yTb, yBa, yBb, fx, fz, r, g, b) {
  const dx = bx - ax, dz = bz - az;
  if (dz * fx - dx * fz >= 0) sink.quad(ax, yTa, az, bx, yTb, bz, bx, yBb, bz, ax, yBa, az, r, g, b);
  else sink.quad(bx, yTb, bz, ax, yTa, az, ax, yBa, az, bx, yBb, bz, r, g, b);
}

/**
 * One stretch of kerb and pavement between two cross-sections.
 * A and B: { x, z (the kerb line), nx, nz (unit-ish, out from the road),
 *            y (the carriageway deck there), w, drop }.
 * `t` is the surface behind the kerb: 1 paving, 2 lawn.
 */
function kerbRun(sink, A, B, t, terrain, c) {
  const wa = A.w, wb = B.w;
  if (wa < 0.05 && wb < 0.05) return;
  // a band that ends tapers to nothing at that end: every offset collapses
  // onto the kerb line there
  const ka = wa < 0.05 ? 0 : Math.min(KERB_W, wa), kb = wb < 0.05 ? 0 : Math.min(KERB_W, wb);
  const IN = 0.03;                               // the face stands this far IN from the line
  const a0x = A.x - A.nx * IN * (wa < 0.05 ? 0 : 1), a0z = A.z - A.nz * IN * (wa < 0.05 ? 0 : 1);
  const b0x = B.x - B.nx * IN * (wb < 0.05 ? 0 : 1), b0z = B.z - B.nz * IN * (wb < 0.05 ? 0 : 1);
  const a1x = A.x + A.nx * ka, a1z = A.z + A.nz * ka, b1x = B.x + B.nx * kb, b1z = B.z + B.nz * kb;
  const a2x = A.x + A.nx * wa, a2z = A.z + A.nz * wa, b2x = B.x + B.nx * wb, b2z = B.z + B.nz * wb;
  const la = wa < 0.05 ? 0 : 1, lb = wb < 0.05 ? 0 : 1;
  const ya0 = A.y + vergeLift(wa, A.drop, 0) * la, yb0 = B.y + vergeLift(wb, B.drop, 0) * lb;
  const ya1 = A.y + vergeLift(wa, A.drop, ka) * la, yb1 = B.y + vergeLift(wb, B.drop, kb) * lb;
  const ya2 = A.y + vergeLift(wa, A.drop, wa) * la, yb2 = B.y + vergeLift(wb, B.drop, wb) * lb;
  const fx = -(A.nx + B.nx), fz = -(A.nz + B.nz);
  sink.at(SURF.concrete);
  // the face, down past the deck so no chord of the ribbon can show under it
  wallQuad4(sink, a0x, a0z, b0x, b0z, ya0, yb0, A.y - 0.06, B.y - 0.06, fx, fz, c.fr, c.fg, c.fb);
  // the stone
  paintQuad(sink, a0x, ya0, a0z, b0x, yb0, b0z, b1x, yb1, b1z, a1x, ya1, a1z, c.kr, c.kg, c.kb);
  // what lies behind it
  if (t === 2) { sink.at(SURF.grass); paintQuad(sink, a1x, ya1, a1z, b1x, yb1, b1z, b2x, yb2, b2z, a2x, ya2, a2z, c.gr, c.gg, c.gb); }
  else { sink.at(SURF.pavers); paintQuad(sink, a1x, ya1, a1z, b1x, yb1, b1z, b2x, yb2, b2z, a2x, ya2, a2z, c.wr, c.wg, c.wb); }
  // …and the back edge. The band stands a foot over the ground it was laid on
  // (the deck's 20 cm of build-up plus the kerb), and closing it with a
  // vertical edge left a 30 cm cliff along the back of every pavement in town.
  // So it is GRADED instead: a strip that falls from the band's level to the
  // ground's, in the band's own surface, with a short toe into the ground so
  // no chord of the terrain can show under its outer edge. Where the ground is
  // drawn follows clampUnderRoads: the terrain, capped by a bank rising at
  // 55 % from just under the deck edge.
  if (terrain) {
    const BW = t === 2 ? 0.85 : 0.55;
    const a3x = a2x + A.nx * BW * la, a3z = a2z + A.nz * BW * la;
    const b3x = b2x + B.nx * BW * lb, b3z = b2z + B.nz * BW * lb;
    const ya3 = Math.min(Math.min(terrain.heightAt(a3x, a3z), A.y - 0.05 + 0.55 * (wa + BW)) + 0.035, ya2);
    const yb3 = Math.min(Math.min(terrain.heightAt(b3x, b3z), B.y - 0.05 + 0.55 * (wb + BW)) + 0.035, yb2);
    const k = t === 2 ? 0.92 : 0.9;
    const r3 = (t === 2 ? c.gr : c.wr) * k, g3 = (t === 2 ? c.gg : c.wg) * k, b3 = (t === 2 ? c.gb : c.wb) * k;
    sink.at(t === 2 ? SURF.grass : SURF.pavers);
    paintQuad(sink, a2x, ya2, a2z, b2x, yb2, b2z, b3x, yb3, b3z, a3x, ya3, a3z, r3, g3, b3);
    sink.at(SURF.concrete);
    wallQuad4(sink, a3x, a3z, b3x, b3z, ya3, yb3, ya3 - 0.14, yb3 - 0.14, -fx, -fz, r3 * 0.8, g3 * 0.8, b3 * 0.8);
  }
}

// the verge face of a road outside the streets (js/batter.js): the grass of an
// embankment, a shade drier than a town verge
let _faceCol = null;
const faceCol = () => _faceCol ??= (_c.setHex(0x5f6a45), [_c.r, _c.g, _c.b]);
let _kerbCols = null;
function kerbCols() {
  if (_kerbCols) return _kerbCols;
  const c = {};
  _c.setHex(KERB_HEX); c.fr = _c.r; c.fg = _c.g; c.fb = _c.b;
  _c.setHex(KERBTOP_HEX); c.kr = _c.r; c.kg = _c.g; c.kb = _c.b;
  _c.setHex(WALK_HEX); c.wr = _c.r; c.wg = _c.g; c.wb = _c.b;
  _c.setHex(VERGE_HEX); c.gr = _c.r; c.gg = _c.g; c.gb = _c.b;
  return (_kerbCols = c);
}

/**
 * The kerb and pavement along both sides of a kerbed way, from its verge
 * arrays. Its own stations (the way's vertices, one every couple of metres
 * between them, and exactly on every junction-mouth boundary), so a dropped
 * kerb gets the vertices it needs and the band stops precisely where the
 * junction's own kerb takes over. `deckAt(s)` is the carriageway deck there.
 */
function vergeInto(sink, f, vg, terrain, deckAt) {
  const p = f.p, len = f._len ?? 0;
  if (!(len > 0)) return;
  // arclengths wanted: every vertex, a station every vg.ds, every zone edge
  const want = [];
  let run = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const L = Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
    const n = Math.max(1, Math.ceil(L / vg.ds));
    for (let k = 0; k < n; k++) want.push(run + L * (k / n));
    run += L;
  }
  want.push(run);
  for (const z of f._jz ?? []) if (z > 0.05 && z < run - 0.05) want.push(z);
  want.sort((a, b) => a - b);
  const pts = [], at = [];
  let seg = 0, acc = 0, L = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]) || 1e-6, lastS = -1;
  for (const s of want) {
    if (s - lastS < 0.04) continue;
    while (s > acc + L + 1e-6 && seg < p.length - 2) {
      acc += L; seg++;
      L = Math.hypot(p[seg + 1][0] - p[seg][0], p[seg + 1][1] - p[seg][1]) || 1e-6;
    }
    const t = Math.max(0, Math.min(1, (s - acc) / L));
    pts.push([p[seg][0] + (p[seg + 1][0] - p[seg][0]) * t, p[seg][1] + (p[seg + 1][1] - p[seg][1]) * t]);
    at.push(s);
    lastS = s;
  }
  if (pts.length < 2) return;
  // the mitred frame of the ribbon itself, so the kerb line runs parallel to
  // the asphalt edge through every bend
  const n = pts.length, per = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[i], c2 = pts[Math.min(n - 1, i + 1)];
    let p1x = b[0] - a[0], p1z = b[1] - a[1], p2x = c2[0] - b[0], p2z = c2[1] - b[1];
    if (i === 0) { p1x = p2x; p1z = p2z; }
    if (i === n - 1) { p2x = p1x; p2z = p1z; }
    const l1 = Math.hypot(p1x, p1z) || 1, l2 = Math.hypot(p2x, p2z) || 1;
    p1x /= l1; p1z /= l1; p2x /= l2; p2z /= l2;
    let mx = p1x + p2x, mz = p1z + p2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-4) { mx = p2x; mz = p2z; } else { mx /= ml; mz /= ml; }
    const sc = 1 / Math.max(0.5, mx * p2x + mz * p2z);
    per[i] = [mz * sc, -mx * sc];
  }
  const hw = (f.w ?? 3) / 2, cols = kerbCols();
  const A = { x: 0, z: 0, nx: 0, nz: 0, y: 0, w: 0, drop: 0 }, B = { x: 0, z: 0, nx: 0, nz: 0, y: 0, w: 0, drop: 0 };
  const fill = (o, i, e, side) => {
    const s = at[i], v = vergeAt(f, s, side), off = hw + bayAt(f, s, e);
    o.nx = per[i][0] * e; o.nz = per[i][1] * e;
    o.x = pts[i][0] + o.nx * off; o.z = pts[i][1] + o.nz * off;
    o.w = v.w; o.drop = v.drop; o.y = deckAt(s);
    return v.t;
  };
  for (let side = 0; side < 2; side++) {
    const e = side ? 1 : -1;
    for (let i = 0; i < n - 1; i++) {
      if (inZone(f, (at[i] + at[i + 1]) / 2)) continue;
      const ta = fill(A, i, e, side), tb = fill(B, i + 1, e, side);
      if (A.w < 0.05 && B.w < 0.05) continue;
      kerbRun(sink, A, B, ta || tb, terrain, cols);
    }
  }
}

/** The kerb round a junction outline: the same band, along the corner radii. */
function ringKerbInto(sink, o, deckY, terrain) {
  const cols = kerbCols();
  const A = { x: 0, z: 0, nx: 0, nz: 0, y: 0, w: 0, drop: 0 }, B = { x: 0, z: 0, nx: 0, nz: 0, y: 0, w: 0, drop: 0 };
  for (const pc of o._edge ?? []) {
    if (!pc.any || !pc.w) continue;
    const p = pc.p, m = p.length / 8;
    const fill = (q, i) => {
      q.x = p[i * 8]; q.z = p[i * 8 + 1]; q.nx = p[i * 8 + 2]; q.nz = p[i * 8 + 3];
      q.w = pc.w[i]; q.drop = pc.d[i]; q.y = deckY(q.x, q.z);
    };
    for (let i = 0; i < m - 1; i++) {
      fill(A, i); fill(B, i + 1);
      if (A.w < 0.05 && B.w < 0.05) continue;
      kerbRun(sink, A, B, pc.t[i] || pc.t[i + 1], terrain, cols);
    }
  }
}

// a cast-iron cover in its concrete collar, flat on the deck
function lidInto(sink, x, y, z, r) {
  sink.at(SURF.concrete);
  _c.setHex(COLLAR_HEX);
  const cr = _c.r, cg = _c.g, cb = _c.b;
  _c.setHex(IRON_HEX);
  const ir = _c.r, ig = _c.g, ib = _c.b;
  const N = 10;
  for (let k = 0; k < N; k++) {
    const a0 = (k / N) * Math.PI * 2, a1 = ((k + 1) / N) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    sink.tri(x, y, z, x + c1 * (r + 0.07), y, z + s1 * (r + 0.07), x + c0 * (r + 0.07), y, z + s0 * (r + 0.07), cr, cg, cb);
    sink.tri(x, y + 0.008, z, x + c1 * r, y + 0.008, z + s1 * r, x + c0 * r, y + 0.008, z + s0 * r, ir, ig, ib);
  }
}

// a gully grate at the kerb: a dark frame with its slots across the flow
function grateInto(sink, x, y, z, ux, uz) {
  sink.at(SURF.concrete);
  _c.setHex(IRON_HEX);
  const ir = _c.r, ig = _c.g, ib = _c.b;
  _c.setHex(0x17181a);
  const sr = _c.r, sg = _c.g, sb = _c.b;
  const px = -uz, pz = ux;
  const P = (a, c) => [x + ux * a + px * c, z + uz * a + pz * c];
  const q = (a0, a1, c0, c1, yy, r, g, b) => {
    const p0 = P(a0, c0), p1 = P(a1, c0), p2 = P(a1, c1), p3 = P(a0, c1);
    paintQuad(sink, p0[0], yy, p0[1], p1[0], yy, p1[1], p2[0], yy, p2[1], p3[0], yy, p3[1], r, g, b);
  };
  q(-0.27, 0.27, -0.18, 0.18, y, ir, ig, ib);
  for (const a of [-0.16, 0, 0.16]) q(a - 0.04, a + 0.04, -0.13, 0.13, y + 0.008, sr, sg, sb);
}

// ---- the middle of a roundabout (geo.indexRoundabouts) ------------------------
// What a Czech roundabout has in it: a kerb, a ring of granite setts a lorry's
// trailer may run over, and a planted mound that stops you seeing straight
// across. A mini-roundabout too small to plant is a low dome of setts.
function roundIslandInto(sink, x, z, R, deck, terrain) {
  if (!(R > 0.8)) return;
  const N = Math.max(12, Math.min(28, Math.round(R * 2.2)));
  const cols = kerbCols();
  _c.setHex(0x8a8781);
  const ar = _c.r, ag = _c.g, ab = _c.b;
  _c.setHex(VERGE_HEX);
  const gr = _c.r, gg = _c.g, gb = _c.b;
  _c.setHex(COLORS.green.bush);
  const br = _c.r, bg = _c.g, bb = _c.b;
  const small = R < 2.6;
  const apron = small ? R : Math.min(1.4, R * 0.3);
  const top = deck + (small ? 0.04 : KERB_H);
  const mound = small ? 0.05 : Math.min(0.7, 0.12 * R);
  const P = (k, r) => { const a = (k / N) * Math.PI * 2; return [x + Math.cos(a) * r, z + Math.sin(a) * r]; };
  // (No fixFrom of its own: this is emitted INSIDE the owner ribbon's range,
  // which the ribbon marks fixed when it ends. The drape walks the gaps between
  // ranges in the order they were recorded, so a range nested in a later one
  // made it drape the ribbon's deck a second time: 220 m into the sky.)
  for (let k = 0; k < N; k++) {
    const a0 = P(k, R), a1 = P(k + 1, R), b0 = P(k, R - KERB_W), b1 = P(k + 1, R - KERB_W);
    const c0 = P(k, R - apron), c1 = P(k + 1, R - apron);
    // kerb face (out toward the carriageway) and stone
    sink.at(SURF.concrete);
    wallQuad4(sink, a0[0], a0[1], a1[0], a1[1], top, top, deck - 0.06, deck - 0.06,
      a0[0] + a1[0] - 2 * x, a0[1] + a1[1] - 2 * z, cols.fr, cols.fg, cols.fb);
    paintQuad(sink, a0[0], top, a0[1], a1[0], top, a1[1], b1[0], top, b1[1], b0[0], top, b0[1], cols.kr, cols.kg, cols.kb);
    if (small) {
      sink.at(SURF.cobble);
      sink.triFacing(b0[0], top, b0[1], b1[0], top, b1[1], x, top + mound, z, 0, 1, 0, ar, ag, ab);
      continue;
    }
    // the sett apron, rising a little to the planting
    sink.at(SURF.cobble);
    paintQuad(sink, b0[0], top, b0[1], b1[0], top, b1[1], c1[0], top + 0.05, c1[1], c0[0], top + 0.05, c0[1], ar, ag, ab);
    // lawn up the mound, and the shrubbery on its crown
    const d0 = P(k, (R - apron) * 0.55), d1 = P(k + 1, (R - apron) * 0.55);
    sink.at(SURF.grass);
    paintQuad(sink, c0[0], top + 0.05, c0[1], c1[0], top + 0.05, c1[1], d1[0], top + mound, d1[1], d0[0], top + mound, d0[1], gr, gg, gb);
    sink.at(SURF.forest);
    const e0 = P(k, (R - apron) * 0.5), e1 = P(k + 1, (R - apron) * 0.5);
    wallQuad4(sink, d0[0], d0[1], d1[0], d1[1], top + mound + 0.55, top + mound + 0.55, top + mound, top + mound,
      d0[0] + d1[0] - 2 * x, d0[1] + d1[1] - 2 * z, br * 0.8, bg * 0.8, bb * 0.8);
    paintQuad(sink, d0[0], top + mound + 0.55, d0[1], d1[0], top + mound + 0.55, d1[1],
      e1[0], top + mound + 0.7, e1[1], e0[0], top + mound + 0.7, e0[1], br, bg, bb);
    sink.triFacing(e0[0], top + mound + 0.7, e0[1], e1[0], top + mound + 0.7, e1[1], x, top + mound + 0.8, z, 0, 1, 0, br, bg, bb);
  }
}

// ---- what a bench stands on ---------------------------------------------------
// Street furniture is placed at "the ground", and beside a kerbed street the
// ground a bin stands on is the pavement, 12 cm over the carriageway and a
// hand more over the grass behind it. This answers heightAt() the way
// js/furniture.js asks it, with the pavement where there is one: the generated
// band, a mapped footway lifted to the street's level, the corner round a
// junction. The same numbers city.js heightAt gives the player's feet.
function standingOn(cell, key, terrain) {
  if (!terrain || !cell) return terrain;
  const pads = [...(junctionsIn(key) ?? []), ...(clustersIn(key) ?? [])];
  return {
    heightAt(x, z) {
      const ground = terrain.heightAt(x, z);
      let best = ground, footOwn = -Infinity, upW = 0, upT = 0, upX = 0, upB = 0, onRoad = false;
      for (const r of cell.roads) {
        if (r.br || !r.p || r.p.length < 2) continue;
        const half = (r.w ?? 3) / 2, vg = r.d ? streetOf(r) : null;
        const reach = half + (vg ? 10.5 : r.d ? 0 : 0.35);
        if (!vg && r.d) continue;
        const bb = bboxOfLine(r);
        if (x < bb[0] - reach || x > bb[2] + reach || z < bb[1] - reach || z > bb[3] + reach) continue;
        // the NEAREST segment speaks for the way (see city.js surfaceY on why)
        let run = 0, bd = Infinity, bs = 0, be = 1;
        for (let i = 0; i < r.p.length - 1; i++) {
          const ax = r.p[i][0], az = r.p[i][1], bx = r.p[i + 1][0], bz = r.p[i + 1][1];
          const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9, L = Math.sqrt(L2);
          let t = ((x - ax) * ex + (z - az) * ez) / L2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(x - (ax + ex * t), z - (az + ez * t));
          if (d < bd) { bd = d; bs = run + L * t; be = (x - ax) * ez - (z - az) * ex >= 0 ? 1 : -1; }
          run += L;
        }
        if (bd >= reach) continue;
        const gy = roadGradeY(r, bs, terrain);
        if (gy === null || gy === undefined) continue;
        if (!r.d) { footOwn = Math.max(footOwn, gy + LAYER_Y.footway); continue; }
        const xo = bd - half - bayAt(r, bs, be), v = vergeAt(r, bs, be > 0 ? 1 : 0);
        if (xo < 0.3) onRoad = true;
        if (v.u) {
          if (xo > 0 && v.w > 0.05 && xo <= v.w && !inZone(r, bs)) best = Math.max(best, gy + LAYER_Y.road + vergeLift(v.w, v.drop, xo));
          const w = xo <= 6 ? 1 : xo >= 10 ? 0 : 1 - (xo - 6) / 4;
          if (w > upW) { upW = w; upT = gy + LAYER_Y.road + vergeLift(v.w, v.drop, xo) + FOOT_LIFT; upX = xo; upB = v.w; }
        }
      }
      // (capped as the slab itself is: a bench on a path at the foot of an
      // embankment stands on the path, not at the street's level over it)
      if (footOwn > -Infinity && !onRoad) {
        const pw = stampShaped(terrain, x, z) ? 0 : footPullW(upW, upT - footOwn, upX, upB);
        best = Math.max(best, footOwn + (upT - footOwn) * pw);
      }
      for (const o of pads) {
        if (o._cluster || (!o.members && o._ring) || !o._edge) continue;
        if ((x - o.x) ** 2 + (z - o.z) ** 2 > ((o.padR ?? 6) + 7) ** 2) continue;
        const up = cornerLift(o, x, z);
        if (up >= 0) best = Math.max(best, (o.members ? clusterDeckY(o, x, z, terrain) : junctionDeckY(o, x, z, terrain)) + LAYER_Y.road + up);
      }
      return best;
    },
  };
}

// ---- what holds a bridge up ----------------------------------------------------
// A deck used to be a strip with a fascia, hanging in the air from bank to
// bank. Two things carry a real one, and both are derived from the deck's own
// height over the ground beneath it: where it is still LOW (the ramps at each
// end) it stands on solid abutment walls, and where it is high it stands on
// piers, spaced like a girder bridge's, set clear of whatever road or railway
// the bridge is there to cross (geo.indexBridgeCrossings found those).
const PIER_STEP = 22, PIER_OPEN = 2.4;
// What a pier stands on. In a pooled Prague body that is the riverbed under
// the flat pool, not the DMR, which over water records a surface up to 5 m
// above the pool: piers standing on it would end in mid air over the water.
function supportFloor(cell, x, z, terrain) {
  const g = terrain.heightAt(x, z);
  if (!cell?.water) return g;
  for (const w of cell.water) {
    if (!w.o || !isPooled(w)) continue;
    const lv = riverLevelAt(w, x, z);
    if (lv === null || !pointInPolygon(x, z, w.o) || (w.i ?? []).some((h) => pointInPolygon(x, z, h))) continue;
    return Math.min(g, lv - 1.5);
  }
  return g;
}

function bridgeSupports(sink, f, fr, ys, hw, cell, terrain, slim) {
  if (!terrain) return;
  const { q, per, along, len } = fr;
  const n = q.length;
  _c.setHex(0x8f8c86);
  const cr = _c.r, cg = _c.g, cb = _c.b;
  const drop = slim ? 0.25 : FASCIA;
  const clear = new Float32Array(n), gnd = new Float32Array(n);
  for (let i = 0; i < n; i++) { gnd[i] = supportFloor(cell, q[i][0], q[i][1], terrain); clear[i] = ys[i] - drop - gnd[i]; }
  sink.at(SURF.concrete);
  // abutments: the low ends are walled in, both faces, and closed off across
  // the deck where the open span begins
  for (let i = 0; i < n - 1; i++) {
    const lowA = clear[i] < PIER_OPEN, lowB = clear[i + 1] < PIER_OPEN;
    if (lowA && lowB && (clear[i] > 0.15 || clear[i + 1] > 0.15)) {
      for (const e of [-1, 1]) {
        const o = (hw - 0.05) * e;
        const X0 = q[i][0] + per[i][0] * o, Z0 = q[i][1] + per[i][1] * o;
        const X1 = q[i + 1][0] + per[i + 1][0] * o, Z1 = q[i + 1][1] + per[i + 1][1] * o;
        wallQuad4(sink, X0, Z0, X1, Z1, ys[i] - drop + 0.02, ys[i + 1] - drop + 0.02,
          Math.min(terrain.heightAt(X0, Z0), gnd[i]) - 0.3, Math.min(terrain.heightAt(X1, Z1), gnd[i + 1]) - 0.3,
          per[i][0] * e, per[i][1] * e, cr, cg, cb);
      }
    }
    if (lowA !== lowB) {
      const k = lowA ? i : i + 1;                 // the last low station: the wall stands here
      const o = hw - 0.05;
      const X0 = q[k][0] - per[k][0] * o, Z0 = q[k][1] - per[k][1] * o;
      const X1 = q[k][0] + per[k][0] * o, Z1 = q[k][1] + per[k][1] * o;
      const dx = q[i + 1][0] - q[i][0], dz = q[i + 1][1] - q[i][1];
      const sgn = lowA ? 1 : -1;                  // facing out into the span
      wallQuad4(sink, X0, Z0, X1, Z1, ys[k] - drop + 0.02, ys[k] - drop + 0.02,
        gnd[k] - 0.3, gnd[k] - 0.3, dx * sgn, dz * sgn, cr * 0.9, cg * 0.9, cb * 0.9);
    }
  }
  // piers under the open span
  const pw = slim ? 0.35 : Math.min(hw * 0.62, 3.2), pt = slim ? 0.22 : 0.5;
  let i0 = -1;
  for (let i = 0; i <= n; i++) {
    const open = i < n && clear[i] >= PIER_OPEN;
    if (open && i0 < 0) i0 = i;
    if (!open && i0 >= 0) {
      const sA = along[i0], sB = along[i - 1], span = sB - sA;
      if (span > PIER_STEP * 0.8) {
        // a D11 viaduct's two decks stand their piers side by side: the
        // stations come from the official km both lines share (js/mwplan.js)
        const mwS = mwPierStations(f, fr, sA, sB, PIER_STEP);
        const cnt = mwS ? mwS.length : Math.max(1, Math.round(span / PIER_STEP) - 1);
        for (let k = 1; k <= cnt; k++) {
          let s = mwS ? mwS[k - 1] : sA + (span * k) / (cnt + 1);
          // not in the lane or on the track it is there to cross: try a few
          // metres either way, and leave it out rather than stand it in traffic
          let ok = false;
          for (const shift of [0, 5, -5, 9, -9]) {
            walkAt(fr, Math.max(sA, Math.min(sB, s + shift)), _WA);
            let hit = cell ? onCarriageway(cell, f, _WA.x, _WA.z, pw + 0.8) : false;
            if (!hit && cell) for (const rl of cell.rails ?? []) {
              if (rl.br || !rl.p) continue;
              for (let m = 0; m < rl.p.length - 1 && !hit; m++) {
                if (distPointToSegment(_WA.x, _WA.z, rl.p[m][0], rl.p[m][1], rl.p[m + 1][0], rl.p[m + 1][1], null) < pw + 2.6) hit = true;
              }
              if (hit) break;
            }
            if (!hit) { ok = true; s = Math.max(sA, Math.min(sB, s + shift)); break; }
          }
          if (!ok) continue;
          walkAt(fr, s, _WA);
          let j = 0;
          while (j < n - 2 && along[j + 1] < s) j++;
          const t = (s - along[j]) / ((along[j + 1] - along[j]) || 1);
          const top = ys[j] + (ys[j + 1] - ys[j]) * t - drop + 0.02;
          const base = supportFloor(cell, _WA.x, _WA.z, terrain) - 1.2;
          const ux = _WA.dx * pt, uz = _WA.dz * pt, px = _WA.dz * pw, pz = -_WA.dx * pw;
          const c0 = [_WA.x - ux - px, _WA.z - uz - pz], c1 = [_WA.x + ux - px, _WA.z + uz - pz];
          const c2 = [_WA.x + ux + px, _WA.z + uz + pz], c3 = [_WA.x - ux + px, _WA.z - uz + pz];
          const ring = [c0, c1, c2, c3];
          for (let m = 0; m < 4; m++) {
            const a = ring[m], b = ring[(m + 1) % 4];
            wallQuad4(sink, a[0], a[1], b[0], b[1], top, top, base, base,
              (a[0] + b[0]) / 2 - _WA.x, (a[1] + b[1]) / 2 - _WA.z, cr, cg, cb);
          }
        }
      }
      i0 = -1;
    }
  }
}

// ---- what a footway is levelled against, and cut at ---------------------------
// A footway is drawn whole from the chunk its first point lies in, but it is
// WALKED cell by cell: city.heightAt asks the cell under the feet which streets
// are near. Levelling and cutting it against its home cell's roads alone left
// every stretch past the first chunk border at ground level beside a kerbed
// street the home cell had never heard of (feet 18 cm over the paving), or
// laid as a slab straight across that street's asphalt. So the candidates come
// from every cell the way passes through, plus FOOT_REACH either side, which
// is how far a kerbed street pulls a footway (half a carriageway, a lay-by,
// and the 10 m of flat and blend). The cut reads all of them; each station's
// level reads the ones its own cell lists (stationRoads, below).
const FOOT_REACH = 20;
/**
 * The chunk cells a ground footway reads its streets from, into `out` (a Set of
 * keys). Pure in f.p, because js/chunkspec.js has to ship exactly these cells
 * to the mesh worker or the two builds of one chunk would differ.
 */
export function footCellKeys(f, out) {
  const p = f.p, m = FOOT_REACH;
  const add = (x, z) => {
    const i0 = Math.floor((x - m) / CHUNK), i1 = Math.floor((x + m) / CHUNK);
    const j0 = Math.floor((z - m) / CHUNK), j1 = Math.floor((z + m) / CHUNK);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.add(i + ',' + j);
  };
  add(p[0][0], p[0][1]);
  for (let i = 0; i < p.length - 1; i++) {
    const ax = p[i][0], az = p[i][1], bx = p[i + 1][0], bz = p[i + 1][1];
    // a sample every half FOOT_REACH at most: no point of the way is then
    // more than 5 m from one, so its own cell is among those just added, and
    // so is the cell of any centreline within 15 m of it (a street is listed
    // where its centreline runs, and the widest in the data, 22 m, with a
    // lay-by on it reaches 14 m from that)
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (m / 2)));
    for (let k = 1; k <= n; k++) add(ax + (bx - ax) * (k / n), az + (bz - az) * (k / n));
  }
  return out;
}
/** Is footway `f` one whose streets come from footCellKeys (not a bridge)? */
export const footReaches = (f) => FOOT_CLASSES.has(f.t) && !f.br && !!f.p && f.p.length >= 2;
const _fkeys = new Set(), _fseen = new Set();
/** The drivable ways near footway f, as the { roads } the tests below read. */
function footRoads(city, f, cell) {
  if (!city?.chunkIndex || !footReaches(f)) return cell;
  _fkeys.clear(); _fseen.clear();
  footCellKeys(f, _fkeys);
  const roads = [], fb = bboxOfLine(f);
  for (const k of _fkeys) {
    const c = city.chunkIndex.get(k);
    if (!c) continue;
    for (const r of c.roads) {
      if (!r.d || !r.p || r.p.length < 2) continue;
      // only what can reach the footway at all: every test below runs per
      // sample over this list, and a cell holds a few hundred ways
      const rb = bboxOfLine(r), m = (r.w ?? 6) / 2 + FOOT_REACH;
      if (rb[2] < fb[0] - m || rb[0] > fb[2] + m || rb[3] < fb[1] - m || rb[1] > fb[3] + m) continue;
      if (_fseen.has(r)) continue;       // a way is listed in every cell it touches
      _fseen.add(r);
      roads.push(r);
    }
  }
  _fseen.clear();
  return { roads };
}
// The CUT wants every street that can reach the way (no paving on asphalt,
// whichever cell lists it). The LEVEL is a different question: feet are put on
// a footway by city.heightAt, which asks only the cell UNDER them which
// streets pull it up to a pavement. A station levelled against a street its own
// cell does not list is paving the walker is not on (measured: a slab 38 cm
// under the feet, 6 m from a street in the next cell), so each station is
// levelled against the streets of the cell it lies in, and no others.
const _fhere = new Map();   // cell key -> Set of the candidates that cell lists
function stationRoads(city, drv, x, z) {
  const k = chunkKey(x, z);
  let s = _fhere.get(k);
  if (s === undefined) {
    const c = city.chunkIndex.get(k);
    s = new Set();
    if (c) for (const r of drv) if (c.roads.includes(r)) s.add(r);
    _fhere.set(k, s);
  }
  return s;
}
/**
 * onCarriageway for a footway: a bus lay-by is carriageway too. The bay is
 * generated, the footway beside the street is mapped, and where the bay was
 * dug the mapped footway still ran straight through it, a paving slab 14 cm
 * over the bay's asphalt with the bus standing in it. city.heightAt already
 * counts the bay as road (xo = d - half - bayAt); this is the same test.
 */
function onDeck(fc, self, x, z, grow = 0) {
  for (const o of fc.roads) {
    if (o === self || !o.d) continue;
    const half = (o.w ?? 3) / 2 + grow;
    if (half <= 0) continue;
    const bays = o._bays, reach = bays ? half + BAY_W : half;
    const bb = bboxOfLine(o);
    if (x < bb[0] - reach || x > bb[2] + reach || z < bb[1] - reach || z > bb[3] + reach) continue;
    let al = 0;
    for (let k = 0; k < o.p.length - 1; k++) {
      const ax = o.p[k][0], az = o.p[k][1], ex = o.p[k + 1][0] - ax, ez = o.p[k + 1][1] - az;
      const L2 = ex * ex + ez * ez || 1e-9;
      let t = ((x - ax) * ex + (z - az) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - (ax + ex * t), z - (az + ez * t));
      if (d < half) return true;
      if (bays) {
        const L = Math.sqrt(L2);
        if (d < reach && d < half + bayAt(o, al + L * t, (x - ax) * ez - (z - az) * ex >= 0 ? 1 : -1)) return true;
        al += L;
      }
    }
  }
  return false;
}

// ---- how hard a street may pull a footway off its own level ---------------------
// The pull below (roadRibbon, and city._footPull for the feet) takes a footway
// to the level of the street it runs beside, and it asked only how FAR the
// street was, never how much higher or lower. Beside a street on an embankment
// that dragged the path up the full height of the fill, six metres out from
// the kerb: the cycleway under the flyover by Kaufland was drawn on a ramp
// 4.8 m over the ground it lies on, and 1.6 km of footway within 2.4 km of the
// spawn stood more than a metre off its own level.
//
// How much higher or lower can a path beside a street really be? A few steps
// from the kerb, hardly at all: no bank is steep enough, and what the path's
// own profile says there (PULL_SMEAR) is the survey's 20 m grid smearing the
// street's embankment across it. On the street's own band (the pavement, or
// the lawn it draws out to a mapped footway, `band` wide) the path is part of
// that surface by construction. Only a WALL puts a path right beside a kerb on
// another level: the abutment of a bridge, with the path passing under the
// deck, and that is more than PULL_WALL. Further out the path may just as
// well be at the foot of the bank, and its own levelled profile, which has the
// real earthworks in it, is what says which: PULL_FADE past the band the pull
// is whole only while street and path are within PULL_LEVEL of each other, and
// gone by PULL_OFF. Between the two distances the two answers are blended.
// (The lawn itself stops reaching for a footway more than a metre off the
// street's level: geo.levelVerge.) One function, because the paving and the
// feet on it have to get the same number.
const PULL_NEAR = 2.5, PULL_FADE = 2;        // m past the kerb line (or the asphalt edge)
const PULL_LEVEL = 0.5, PULL_OFF = 1.5;      // m between the street's level and the path's own
const PULL_SMEAR = 2, PULL_WALL = 3;         // …and the same right beside the kerb
/**
 * The weight `w` of a street's pull on a footway, capped: `dy` is the level it
 * pulls toward less the footway's own, `xo` the metres past its kerb line,
 * `band` the width of the street's own band there (0: no kerb).
 */
export function footPullW(w, dy, xo, band = 0) {
  const a = dy < 0 ? -dy : dy;
  if (a <= PULL_LEVEL) return w;
  const near = band + 0.3 > PULL_NEAR ? band + 0.3 : PULL_NEAR;
  const kn = a <= PULL_SMEAR ? 1 : a >= PULL_WALL ? 0 : (PULL_WALL - a) / (PULL_WALL - PULL_SMEAR);
  if (xo <= near) return w * kn;
  const kf = a >= PULL_OFF ? 0 : (PULL_OFF - a) / (PULL_OFF - PULL_LEVEL);
  const kx = xo >= near + PULL_FADE ? 0 : (near + PULL_FADE - xo) / PULL_FADE;
  return w * (kf + (kn - kf) * kx);
}

/**
 * One edge of a slab that stands over the ground (a footway lifted to its
 * street's pavement level): from (X0, Z0, y0) to (X1, Z1, y1), with the outward
 * normal at each end. It used to be closed with a vertical face down to the
 * terrain, a 30 cm cliff in kerb grey along every such path. Now the edge is
 * GRADED: a strip in the slab's own surface falling to the ground over half a
 * metre, with a toe into it. Where that strip would land on a carriageway the
 * edge IS a kerb, and stays a vertical face.
 */
const SLAB_GRADE = 0.55;
function slabEdge(sink, cell, f, X0, Z0, X1, Z1, y0, y1, n0x, n0z, n1x, n1z, terrain, surf, r, g, b) {
  const O0x = X0 + n0x * SLAB_GRADE, O0z = Z0 + n0z * SLAB_GRADE;
  const O1x = X1 + n1x * SLAB_GRADE, O1z = Z1 + n1z * SLAB_GRADE;
  if (onDeck(cell, f, O0x, O0z, 0.1) || onDeck(cell, f, O1x, O1z, 0.1)) {
    sink.at(SURF.concrete);
    wallQuad4(sink, X0, Z0, X1, Z1, y0, y1, Math.min(terrain.heightAt(X0, Z0) - 0.05, y0 - 0.02),
      Math.min(terrain.heightAt(X1, Z1) - 0.05, y1 - 0.02), n0x, n0z, KERB_R, KERB_G, KERB_B);
    return;
  }
  const g0 = Math.min(terrain.heightAt(O0x, O0z) + 0.035, y0), g1 = Math.min(terrain.heightAt(O1x, O1z) + 0.035, y1);
  sink.at(surf);
  paintQuad(sink, X0, y0, Z0, X1, y1, Z1, O1x, g1, O1z, O0x, g0, O0z, r * 0.9, g * 0.9, b * 0.9);
  sink.at(SURF.concrete);
  wallQuad4(sink, O0x, O0z, O1x, O1z, g0, g1, g0 - 0.14, g1 - 0.14, n0x, n0z, r * 0.72, g * 0.72, b * 0.72);
}

function roadRibbon(sink, f, terrain, cell, key, city) {
  // a bridge is straight by definition and its deck is level, so it
  // gains nothing from following ground it is not touching
  const pts = trimEnds(f.p, f._j0, f._j1);
  if (!pts) return;                       // eaten entirely by its own junctions
  const fr = ribbonFrame(f.br ? bridgeResample(pts) : terrainResample(pts, terrain));
  if (!fr) return;
  const { q, per, along, len } = fr;
  const hw = Math.max(0.8, (f.w ?? 3) / 2);
  const isFoot = FOOT_CLASSES.has(f.t);
  // a drivable deck rides a hair higher the more important it is (RANK_LIFT)
  const baseY = isFoot ? LAYER_Y.footway : LAYER_Y.road + (f.d ? roadRank(f) * RANK_LIFT : 0);
  // A bridge is the one road that does NOT follow the ground: it leaves one
  // bank and arrives at the other, straight and level. Its absolute deck
  // height is resolved from the two approaches right here, and the range is
  // flagged so the chunk-wide drape leaves it alone — otherwise Karlův most
  // would sink into the Vltava and climb out on the far side.
  const bridge = !!f.br && !!terrain;
  // A road is the HIGHER of two surfaces: the ground it lies on, and the graded
  // profile that keeps it to a road's grade. Neither alone works, and both have
  // been tried:
  //   · terrain alone dives into every dell (no embankment in the data);
  //   · the profile alone stops following the ground, so it sinks under the
  //     aerial photograph between its 5 m samples and inherits every wiggle of
  //     them as a step — which is the bumpy road with the little jumps.
  // max(ground, profile) is smooth where the ground is smooth, filled where the
  // ground dips, and cannot sink beneath the ground anywhere, because the ground
  // is one of the two things it is the maximum of. The drape adds the ground per
  // vertex, so what this contributes is the FILL — and it is computed against
  // that same vertex's ground, not an interpolated one, which is where the 18 %
  // kick came from.
  const graded = !f.br && !!terrain && !!roadProfile(f, terrain);
  const mark = bridge || graded ? sink.mark() : -1;
  // A graded road is ABSOLUTE, like a bridge: elev returns the levelled deck
  // itself and the drape is told to leave it alone. It used to return the
  // FILL (deck minus ground) sampled at the CENTRELINE, for the drape to add
  // the ground back per VERTEX — and on any cross-slope those are different
  // grounds, so the deck came out tilted sideways and bent by exactly the
  // terrain relief it was levelled to ignore: metres, beside a railway
  // cutting. The road the wheels ride (roadGradeY) and the road the eyes see
  // are now the same number by construction.
  // The frame starts its arclength at the TRIMMED mouth, but the profile is
  // parameterised over the whole way — every sample must be offset by the
  // trim, or the entire ribbon is drawn at profile(s − trim): a constant
  // grade × trim below (or above) the deck the wheels ride and the pad
  // continues, which was a ~30 cm step at the mouth of every sloping
  // junction road.
  const s0 = f._j0 ?? 0;
  const elev = (d, x, z) => {
    if (f.br) return bridge ? bridgeDeckHeight(f, d + s0, terrain) : bridgeElevation(d, len);
    if (!graded) return 0;
    const gy = roadGradeY(f, d + s0, terrain);
    return gy === null ? terrain.heightAt(x, z) : gy;
  };
  const surf = surfOfRoad(f);
  sink.at(surf);
  _c.setHex(COLORS.road[f.t] ?? COLORS.road.residential);
  const cr = _c.r, cg = _c.g, cb = _c.b;
  _c.setHex(RAILING_COL);
  const lr = _c.r, lg = _c.g, lb = _c.b;
  // A footpath crossing a road is a crossing, not a strip of gravel laid over
  // the tarmac. It sits 4 cm under the carriageway (LAYER_Y), which sounds like
  // enough until you remember both surfaces are draped independently onto real
  // terrain sampled every 10 m — the ground moves more than 4 cm between two
  // samples, so the path pokes through the asphalt in pale diagonal bands.
  // Epsilon cannot fix that; not drawing it there can.
  const foot = isFoot && cell;
  // …and what it is cut at is every street along its whole length (footRoads),
  // each station levelled against its own cell's, not the home cell's alone
  const fcell = foot ? footRoads(city, f, cell) : cell;
  // Sampling the segment's MIDPOINT alone is not enough and the arithmetic says
  // why: a path segment is up to 10 m long after terrainResample and a
  // residential road is 5.5 m wide, so a segment can cross the carriageway with
  // its midpoint comfortably outside it. Five samples put the spacing at 2.5 m
  // against a 6 m band, which cannot be stepped over.
  const crossesRoad = (ax, az, bx, bz) => {
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      if (onDeck(fcell, f, ax + (bx - ax) * t, az + (bz - az) * t, 0.3)) return true;
    }
    return false;
  };
  // A path MEETS a road, it does not step onto it. Both are draped onto their
  // own idea of the ground, so at the join the path ended a hand above or
  // below the asphalt lip — the "cesta jde prostě před tu vozovku" report.
  // Near a drivable carriageway every path vertex is blended toward that
  // road's own deck, which turns the last few metres of the path into a ramp
  // that lands exactly on the kerb line: on flats a no-op, on an embanked
  // road the path climbs to meet it. Bridges keep their absolute decks.
  //
  // Beside a KERBED street the target is not the asphalt but the pavement: the
  // path rides the street's own verge surface (kerb height, tilting down to
  // the lip where the kerb is dropped), so a mapped footway and the generated
  // band beside it are one walking surface, and a path arriving at a crossing
  // comes down the dropped kerb instead of ending in a 12 cm step.
  let footY = null, footUp = null;
  if (foot && !f.br && terrain) {
    // FLAT: how far out from a kerb everything walked on keeps the pavement's
    // level (a footway and the cycle path beside it are one surface, not a
    // step); BLEND: the run it then takes to come down to its own.
    const BLEND = 3.5, FLAT = 6, KBLEND = 4;
    const fb = bboxOfLine(f);
    _fdrv.length = 0;
    for (const r of fcell.roads) {
      if (!r.d || !r.p || r === f) continue;
      const rb2 = bboxOfLine(r), m = (r.w ?? 6) / 2 + KBLEND + FLAT + 3;
      if (rb2[2] < fb[0] - m || rb2[0] > fb[2] + m || rb2[3] < fb[1] - m || rb2[1] > fb[3] + m) continue;
      _fdrv.push(r);
    }
    if (_fdrv.length) {
      footY = new Array(q.length);
      const perCell = fcell !== cell;
      if (perCell) _fhere.clear();
      for (let i = 0; i < q.length; i++) {
        const X = q[i][0], Z = q[i][1];
        let y = baseY + elev(along[i], X, Z);
        let bestW = 0, bestT = 0, up = false;
        const here = perCell ? stationRoads(city, _fdrv, X, Z) : null;
        for (const r of _fdrv) {
          if (here && !here.has(r)) continue;
          const hwr = (r.w ?? 6) / 2;
          const vg = r.br ? null : streetOf(r);
          // the NEAREST segment speaks for the way: round a bend the next one
          // along, measured to its end, would answer for a kerb it is not at
          let al = 0, d = Infinity, s2 = 0, side = 0;
          for (let k2 = 0; k2 < r.p.length - 1; k2++) {
            const [ax2, az2] = r.p[k2], [bx2, bz2] = r.p[k2 + 1];
            const ex = bx2 - ax2, ez = bz2 - az2, L2 = ex * ex + ez * ez || 1e-9;
            let t = ((X - ax2) * ex + (Z - az2) * ez) / L2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const dk = Math.hypot(X - (ax2 + ex * t), Z - (az2 + ez * t));
            const L = Math.sqrt(L2);
            if (dk < d) { d = dk; s2 = al + L * t; side = (X - ax2) * ez - (Z - az2) * ex >= 0 ? 1 : 0; }
            al += L;
          }
          if (d >= hwr + (vg ? KBLEND + FLAT + BAY_W : BLEND)) continue;
          // is it a kerbed street just here?
          let lift = -0.04, w = d <= hwr ? 1 : 1 - (d - hwr) / BLEND, kerbed = false;
          let xo = d - hwr, band = 0;      // metres past the kerb line, and its band (footPullW)
          if (vg) {
            const v = vergeAt(r, s2, side);
            if (v.u) {
              const x = d - hwr - bayAt(r, s2, side ? 1 : -1);
              lift = vergeLift(v.w, v.drop, x) + FOOT_LIFT;
              w = x <= FLAT ? 1 : x >= FLAT + KBLEND ? 0 : 1 - (x - FLAT) / KBLEND;
              kerbed = true; xo = x; band = v.w;
            }
          }
          if (w <= bestW) continue;
          const gy2 = r.br ? bridgeDeckHeight(r, s2, terrain) : roadGradeY(r, s2, terrain);
          if (gy2 === null || gy2 === undefined) continue;
          // …and no further off the footway's own level than a street beside
          // it can be (both sides of the difference are in the ribbon's space,
          // see below)
          w = footPullW(w, gy2 + LAYER_Y.road + lift - (graded ? 0 : terrain.heightAt(X, Z)) - y, xo, band);
          // (a flight down to a Prague lower quay is built where the stamp put
          // it, not lifted toward the street over the wall: city._footPull)
          if (w > 0 && stampShaped(terrain, X, Z)) w = 0;
          if (w <= bestW) continue;
          // The target must live in the same space as the ribbon it is
          // blended into. A graded ribbon is ABSOLUTE, so the road's
          // deck height is the right target, but a way shorter than
          // two profile samples has no profile (levelWay returns null)
          // and its ribbon is RELATIVE, draped onto the ground later.
          // Blending the absolute deck into that mixed 221 m of
          // elevation into a 20 cm layer offset, and the chunk drape
          // then added the ground ON TOP: every short footway stub
          // beside a carriageway became a striped tower two hundred
          // metres tall ("ty věci vysoké ve vzduchu"). Visible only
          // since the carriageways widened (the stubs used to sit
          // outside the blend's reach).
          bestW = w; up = kerbed;
          bestT = gy2 + LAYER_Y.road + lift - (graded ? 0 : terrain.heightAt(X, Z));
        }
        if (bestW > 0) y += (bestT - y) * bestW;
        if (up && bestW > 0.5) (footUp ??= new Uint8Array(q.length))[i] = 1;
        footY[i] = y;
      }
    }
  }
  // ---- the lane coordinate (see TriSink.ln and js/surfaces.js) ---------------
  // Across: 0 at the left lane boundary, 1 per lane, so the shader finds the
  // wheel tracks at a quarter and three quarters of every lane and the drip
  // line down its middle. Along: how worn, by class, rising toward a junction
  // mouth where everything brakes and waits.
  const lanesN = !f.d ? 0 : f.ow ? Math.max(1, f.ln ?? Math.round((f.w ?? 6) / 3.4))
    : (f.lf && f.lb) ? f.lf + f.lb : Math.max((f.w ?? 6) < 5.5 ? 1 : 2, f.ln ?? 0);
  const usable = Math.max(2.4, (f.w ?? 6) - 1.2);
  const laneW = usable / (lanesN || 1);
  const uL = 0.25 + ((-hw + usable / 2) / laneW) / 16, uR = 0.25 + ((hw + usable / 2) / laneW) / 16;
  const wear0 = WEAR[f.t] ?? 0;
  const zones = f._jz;
  const wearAt = (d) => {
    if (!lanesN || !wear0) return 0;
    let w = wear0;
    if (zones) {
      const s = d + s0;
      let near = 1e9;
      for (let k = 0; k < zones.length; k++) near = Math.min(near, Math.abs(s - zones[k]));
      if (near < 18) w += 0.34 * (1 - near / 18);
    }
    return Math.min(1, w);
  };
  const ys = new Float32Array(q.length);      // the deck at every station, for what lies on it
  for (let i = 0; i < q.length; i++) ys[i] = footY ? footY[i] : baseY + elev(along[i], q[i][0], q[i][1]);
  const ln = sink.ln;
  // The stretches of footway piece i that are NOT on a carriageway: found on
  // eight samples, each boundary then bisected to a centimetre, and drawn as
  // the slab the whole piece would have been (deck, two edges, and a face
  // across the cut end, toward the road).
  const footPieces = (i) => {
    const ax = q[i][0], az = q[i][1], bx = q[i + 1][0], bz = q[i + 1][1];
    const [pax, paz] = per[i], [pbx, pbz] = per[i + 1];
    const sl = Math.hypot(bx - ax, bz - az) || 1e-6, ux = (bx - ax) / sl, uz = (bz - az) / sl;
    const on = (t) => onDeck(fcell, f, ax + (bx - ax) * t, az + (bz - az) * t, 0.02);
    const edge = (off, onT) => {
      for (let k = 0; k < 6; k++) { const m = (off + onT) / 2; if (on(m)) onT = m; else off = m; }
      return off;
    };
    const piece = (t0, t1) => {
      if ((t1 - t0) * sl < 0.08) return;
      const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
      const y0 = ys[i] + (ys[i + 1] - ys[i]) * t0, y1 = ys[i] + (ys[i + 1] - ys[i]) * t1;
      const p0x = (pax + (pbx - pax) * t0) * hw, p0z = (paz + (pbz - paz) * t0) * hw;
      const p1x = (pax + (pbx - pax) * t1) * hw, p1z = (paz + (pbz - paz) * t1) * hw;
      sink.at(surf);
      sink.quad(x0 - p0x, y0, z0 - p0z, x1 - p1x, y1, z1 - p1z, x1 + p1x, y1, z1 + p1z, x0 + p0x, y0, z0 + p0z, cr, cg, cb);
      const low = (x, z, y) => Math.min(terrain.heightAt(x, z) - 0.05, y - 0.02);
      for (const e of [-1, 1]) {
        const X0 = x0 + p0x * e, Z0 = z0 + p0z * e, X1 = x1 + p1x * e, Z1 = z1 + p1z * e;
        slabEdge(sink, fcell, f, X0, Z0, X1, Z1, y0, y1, pax * e, paz * e, pbx * e, pbz * e, terrain, surf, cr, cg, cb);
      }
      sink.at(SURF.concrete);
      if (t0 > 0) wallQuad4(sink, x0 - p0x, z0 - p0z, x0 + p0x, z0 + p0z, y0, y0,
        low(x0 - p0x, z0 - p0z, y0), low(x0 + p0x, z0 + p0z, y0), -ux, -uz, KERB_R, KERB_G, KERB_B);
      if (t1 < 1) wallQuad4(sink, x1 - p1x, z1 - p1z, x1 + p1x, z1 + p1z, y1, y1,
        low(x1 - p1x, z1 - p1z, y1), low(x1 + p1x, z1 + p1z, y1), ux, uz, KERB_R, KERB_G, KERB_B);
      sink.at(surf);
    };
    const N = 8;
    let start = on(0) ? -1 : 0;                  // where the stretch off the road began
    for (let k = 1; k <= N; k++) {
      const t = k / N, o = on(t);
      if (start < 0 && !o) start = edge(t, (k - 1) / N);
      else if (start >= 0 && o) { piece(start, edge((k - 1) / N, t)); start = -1; }
    }
    if (start >= 0) piece(start, 1);
  };
  // a D11 deck: concrete edge kerbs carry the steel rails js/mwdress.js draws
  const mwBr = f.br && !isFoot && !!cwOf(f);
  // outside the streets a road's edge is a sloped verge face, not the kerb body
  // below (js/batter.js; a kerbed street keeps its kerb, vergeInto)
  const faced = graded && vergeFaced(f);
  // which side of station i a point is on, as streets.vergeAt numbers it, and
  // whether the street is kerbed there (its kerb body below, no verge face)
  const sideAt = (i, x, z) => {
    const j = Math.min(i, q.length - 2);
    return (x - q[j][0]) * (q[j + 1][1] - q[j][1]) - (z - q[j][1]) * (q[j + 1][0] - q[j][0]) >= 0 ? 1 : 0;
  };
  const kerbedSide = faced ? (i, x, z) => kerbedAt(f, along[i] + s0, sideAt(i, x, z)) : null;
  for (let i = 0; i < q.length - 1; i++) {
    const y0 = ys[i], y1 = ys[i + 1];
    const [pax, paz] = per[i], [pbx, pbz] = per[i + 1];
    const ax = q[i][0], az = q[i][1], bx = q[i + 1][0], bz = q[i + 1][1];
    if (foot && crossesRoad(ax, az, bx, bz)) {
      // A LIFTED footway is a slab a hand over the ground, and dropping the
      // whole 4 m piece that touches a carriageway left the slab ending two
      // metres short of every crossing, with a step down into a hole and the
      // walker's feet on nothing. Only the part that is ON the asphalt goes.
      if (footUp && graded && !f.br && (footUp[i] || footUp[i + 1])) footPieces(i);
      continue;
    }
    sink.quad(
      ax - pax * hw, y0, az - paz * hw, bx - pbx * hw, y1, bz - pbz * hw,
      bx + pbx * hw, y1, bz + pbz * hw, ax + pax * hw, y0, az + paz * hw, cr, cg, cb);
    if (lanesN && ln) {
      // quad(a, b, c, d) is the triangles (a, b, c) and (a, c, d)
      const v0 = wearAt(along[i]), v1 = wearAt(along[i + 1]), o = ln.length - 12;
      ln[o] = uL; ln[o + 1] = v0; ln[o + 2] = uL; ln[o + 3] = v1; ln[o + 4] = uR; ln[o + 5] = v1;
      ln[o + 6] = uL; ln[o + 7] = v0; ln[o + 8] = uR; ln[o + 9] = v1; ln[o + 10] = uR; ln[o + 11] = v0;
    }
    // A footway lifted onto a kerbed street's level is a slab standing over
    // the ground beside it: give it its two edges, or it is a sheet of paving
    // hovering a hand above the grass.
    if (footUp && graded && (footUp[i] || footUp[i + 1])) {
      for (const e of [-1, 1]) {
        const X0 = ax + pax * hw * e, Z0 = az + paz * hw * e;
        const X1 = bx + pbx * hw * e, Z1 = bz + pbz * hw * e;
        slabEdge(sink, fcell, f, X0, Z0, X1, Z1, y0, y1, pax * e, paz * e, pbx * e, pbz * e, terrain, surf, cr, cg, cb);
      }
      sink.at(surf);
    }
    // ---- the kerb: a road has a BODY -------------------------------------
    // Until this existed a road was a floating sheet — a deck 6 to 180 cm
    // above the ground with daylight under its edges, so every gap between the
    // ribbon and the terrain read as torn paper, and "silnice nejsou rigid" is
    // exactly what that looks like. A road is a slab: from each deck edge a
    // face runs down INTO the ground (to 5 cm below it, so a terrain crease
    // between two vertices cannot open a slit). Concrete kerb colour, both
    // edges, drivable roads only — footways sit too low to show an edge, and
    // bridges already carry a fascia.
    if (f.d && !f.br && graded) {
      sink.at(SURF.concrete);
      for (const e of [-1, 1]) {
        const X0 = ax + pax * hw * e, Z0 = az + paz * hw * e;
        // (outside a kerbed stretch the edge is a sloped verge face instead)
        if (faced && !kerbedSide(i, X0, Z0) && !kerbedSide(i + 1, X0, Z0)) continue;
        const X1 = bx + pbx * hw * e, Z1 = bz + pbz * hw * e;
        // the ribbon is fixed (absolute), so the kerb bottom samples the
        // ground itself — 5 cm into it, so a crease cannot open a slit
        const g0 = Math.min(terrain.heightAt(X0, Z0) - 0.05, y0 - 0.02);
        const g1 = Math.min(terrain.heightAt(X1, Z1) - 0.05, y1 - 0.02);
        sink.quad(X0, y0, Z0, X1, y1, Z1, X1, g1, Z1, X0, g0, Z0, KERB_R, KERB_G, KERB_B);
        sink.quad(X0, g0, Z0, X1, g1, Z1, X1, y1, Z1, X0, y0, Z0, KERB_R, KERB_G, KERB_B);
      }
      sink.at(surf);
    }
    // Bridge edges: decks run FLAT at BRIDGE_Y now — what sells the bridge is
    // the river sunk below it, so v1's deep girder curtains are gone. A short
    // fascia below the deck edge and a 0.9 m parapet above, both double-sided
    // (seen from the bank AND from the deck), along the entire bridge way.
    // (Not on a bridge a landmark models itself: js/landmarks.js landmarkBridge.)
    if (f.br && !landmarkBridge(f)) {
      // A footbridge is not a motorway viaduct. Its girder face is a fraction
      // of a road bridge's, and its parapet is CONCRETE, not near-black steel
      // — the black was what turned the spiral ramp by the Pardubice flyover
      // into a charcoal wall you could see from the station.
      const b0 = Math.max(0.02, y0 - (isFoot ? 0.25 : FASCIA));
      const b1 = Math.max(0.02, y1 - (isFoot ? 0.25 : FASCIA));
      const t0 = y0 + (isFoot ? 1.05 : RAILING_H), t1 = y1 + (isFoot ? 1.05 : RAILING_H);
      const sr = cr * 0.72, sg = cg * 0.72, sb = cb * 0.72;
      let pr = lr, pg = lg, pb = lb;
      if (isFoot) { _c.setHex(0x93908a); pr = _c.r; pg = _c.g; pb = _c.b; }
      for (const e of [-1, 1]) {
        const X0 = ax + pax * hw * e, Z0 = az + paz * hw * e;
        const X1 = bx + pbx * hw * e, Z1 = bz + pbz * hw * e;
        sink.quad(X0, y0, Z0, X1, y1, Z1, X1, b1, Z1, X0, b0, Z0, sr, sg, sb);
        sink.quad(X0, b0, Z0, X1, b1, Z1, X1, y1, Z1, X0, y0, Z0, sr, sg, sb);
        if (mwBr) {
          // the motorway bridge's edge is a concrete kerb (římsa) with the
          // guard rail on it, not a dark parapet strip: on twin decks 12 m
          // apart that strip stood ON the neighbouring deck (41 % of them)
          const k0 = y0 + MW_BRIDGE_KERB, k1 = y1 + MW_BRIDGE_KERB;
          const IX0 = ax + pax * (hw - MW_BRIDGE_IN) * e, IZ0 = az + paz * (hw - MW_BRIDGE_IN) * e;
          const IX1 = bx + pbx * (hw - MW_BRIDGE_IN) * e, IZ1 = bz + pbz * (hw - MW_BRIDGE_IN) * e;
          sink.at(SURF.concrete);
          for (const [P0x, P0z, P1x, P1z] of [[IX0, IZ0, IX1, IZ1], [X0, Z0, X1, Z1]]) {
            sink.quad(P0x, k0, P0z, P1x, k1, P1z, P1x, y1, P1z, P0x, y0, P0z, KERB_R, KERB_G, KERB_B);
            sink.quad(P0x, y0, P0z, P1x, y1, P1z, P1x, k1, P1z, P0x, k0, P0z, KERB_R, KERB_G, KERB_B);
          }
          sink.quad(IX0, k0, IZ0, X0, k0, Z0, X1, k1, Z1, IX1, k1, IZ1, KERB_R * 1.08, KERB_G * 1.08, KERB_B * 1.08);
          sink.quad(IX1, k1, IZ1, X1, k1, Z1, X0, k0, Z0, IX0, k0, IZ0, KERB_R * 1.08, KERB_G * 1.08, KERB_B * 1.08);
          sink.at(surf);
          continue;
        }
        sink.quad(X0, t0, Z0, X1, t1, Z1, X1, y1, Z1, X0, y0, Z0, pr, pg, pb);
        sink.quad(X0, y0, Z0, X1, y1, Z1, X1, t1, Z1, X0, t0, Z0, pr, pg, pb);
      }
    }
  }
  // (a footway that ENDS on a carriageway, as most mapped crossings do, at the
  // street's centreline: its round end is cut away with the rest of it there,
  // or a disc of paving lies in the middle of the road at pavement height)
  const capOff = (i) => foot && !f.br && onDeck(fcell, f, q[i][0], q[i][1], 0.3);
  if (!capOff(0)) capDisc(sink, q[0][0], ys[0], q[0][1], hw, cr, cg, cb);
  if (!capOff(q.length - 1)) capDisc(sink, q[q.length - 1][0], ys[q.length - 1], q[q.length - 1][1], hw, cr, cg, cb);
  if (bridge && !landmarkBridge(f)) bridgeSupports(sink, f, fr, ys, hw, cell, terrain, isFoot);
  if (faced) {
    // the embankment's own slope, down to the ground drawn beside it, and
    // nothing where the edge lies on a sibling carriageway's deck
    sink.at(SURF.meadow);
    vergeFacesInto(sink, f, q, per, ys, hw, terrain, edgeNear(city, f, bboxOfLine), stampShaped, faceCol(), kerbedSide);
    sink.at(surf);
  }
  if (f._isl && graded) roundIslandInto(sink, f._isl[0], f._isl[1], f._isl[2], ys[0], terrain);
  // The deck at a distance along the frame, read off the ribbon's OWN stations.
  // The levelled profile is a curve and the ribbon is its chords: in a sag the
  // curve lies under the chord, so anything placed by the profile (a dash, a
  // manhole) sank into the asphalt by up to a centimetre there. Reading the
  // chord puts it on the surface that was actually drawn, which is what lets
  // paint lie 3.5 cm over its deck instead of 6.
  let yi = 0;
  const yAt = (d) => {
    if (d <= 0) return ys[0];
    if (d >= len) return ys[q.length - 1];
    if (along[yi] > d) yi = 0;
    while (yi < q.length - 2 && along[yi + 1] < d) yi++;
    const t = (d - along[yi]) / ((along[yi + 1] - along[yi]) || 1);
    return ys[yi] + (ys[yi + 1] - ys[yi]) * t;
  };
  const vg = f.d && !f.br && graded ? streetOf(f) : null;
  // ---- the street beside it: kerb, pavement, covers ---------------------------
  if (vg) {
    // (on the NOMINAL deck, without the class's hair of lift: a pavement is one
    // level round a corner whatever the two streets are)
    const rl = baseY - LAYER_Y.road;
    vergeInto(sink, f, vg, terrain, (s) => {
      const d = s - s0;
      // inside the trimmed mouth the ribbon has no stations: the profile itself
      return (d >= 0 && d <= len ? yAt(d) : baseY + (roadGradeY(f, s, terrain) ?? ys[0] - baseY)) - rl;
    });
    // …closed round a dead end: the asphalt ends in a half disc, and a street
    // that stops has its kerb carried round the end of it
    for (const end of [0, 1]) {
      if (!(end ? f._de1 : f._de0)) continue;
      const i = end ? q.length - 1 : 0, sEnd = end ? f._len : 0;
      const v0 = vergeAt(f, sEnd, 0), w0 = v0.w, t0 = v0.t;
      const v1 = vergeAt(f, sEnd, 1), w1 = v1.w, t1 = v1.t;
      if (w0 < 0.3 || w1 < 0.3) continue;
      const cx = q[i][0], cz = q[i][1], y = ys[i] - rl;
      // from the side-0 kerb (-per) round the far end to the side-1 kerb (+per)
      const a0 = Math.atan2(-per[i][1], -per[i][0]);
      const k2 = i === 0 ? 1 : i - 1;
      const fx = (q[i][0] - q[k2][0]), fz = (q[i][1] - q[k2][1]);   // outward along the way
      // sweep the half that faces outward
      const mid = Math.atan2(fz, fx);
      let da = mid - a0;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      const sweep = da > 0 ? Math.PI : -Math.PI;
      const N = 8, cols = kerbCols();
      const A = { x: 0, z: 0, nx: 0, nz: 0, y, w: 0, drop: 0 }, B = { x: 0, z: 0, nx: 0, nz: 0, y, w: 0, drop: 0 };
      const at = (o, k) => {
        const a = a0 + sweep * (k / N);
        o.nx = Math.cos(a); o.nz = Math.sin(a);
        o.x = cx + o.nx * hw; o.z = cz + o.nz * hw;
        o.w = w0 + (w1 - w0) * (k / N);
      };
      for (let k = 0; k < N; k++) {
        at(A, k); at(B, k + 1);
        // the asphalt out to the kerb line itself: the stock end cap is an
        // octagon, and its flats fall a hand short of a round kerb
        sink.at(surf);
        sink.triFacing(cx, ys[i], cz, A.x, ys[i], A.z, B.x, ys[i], B.z, 0, 1, 0, cr, cg, cb);
        kerbRun(sink, A, B, t0 === 2 && t1 === 2 ? 2 : 1, terrain, cols);
      }
    }
    // Manhole covers down the lane and gully grates at the kerb, where a town
    // has them: positions from the way's own id, so the same cover is in the
    // same place on every machine and every rebuild.
    if (surf === SURF.asphalt || surf === SURF.cobble || surf === SURF.paving) {
      const seed = f._id ?? 0;
      for (let s = 9 + rnd(seed, 71) * 30, k = 0; s < len - 6; s += 34 + rnd(seed, 80 + k) * 26, k++) {
        const sFull = s + s0;
        if (inZone(f, sFull) || !vergeAt(f, sFull, 0).u) continue;
        walkAt(fr, s, _WA);
        const off = (rnd(seed, 300 + k) < 0.5 ? -1 : 1) * Math.min(hw - 1.2, laneW * (0.5 + (rnd(seed, 500 + k) - 0.5) * 0.3));
        const x = _WA.x + _WA.dz * off, z = _WA.z - _WA.dx * off;
        if (onCarriageway(cell, f, x, z, 0.4)) continue;       // somebody else's asphalt lies over it
        lidInto(sink, x, yAt(s) + 0.006, z, 0.3);
      }
      for (let s = 5 + rnd(seed, 73) * 20, k = 0; s < len - 4; s += 24 + rnd(seed, 90 + k) * 12, k++) {
        const sFull = s + s0, side = (k + (seed & 1)) & 1, e = side ? 1 : -1;
        const v = vergeAt(f, sFull, side);
        if (inZone(f, sFull) || !v.u || v.w < 0.3 || v.drop > 0.3 || bayAt(f, sFull, e) > 0.05) continue;
        walkAt(fr, s, _WA);
        const off = (hw - 0.26) * e;
        grateInto(sink, _WA.x + _WA.dz * off, yAt(s) + 0.006, _WA.z - _WA.dx * off, _WA.dx, _WA.dz);
      }
    }
    sink.at(surf);
  }
  // ---- edge lines ----
  // Emitted from the SAME mitred frame as the deck, so they follow every bend
  // and every terrain split the ribbon does, and they sit at LAYER_Y.marking —
  // above the asphalt, below nothing. A bridge gets them too: its deck is paint
  // like any other, and `elev` already carries the span height.
  // a motorway and its slip roads are painted by their own rules, off the lane
  // layout the AI drives by (js/mwpaint.js); the town rules below skip them
  const mwp = mwPainted(f);
  if (mwp) {
    sink.at(SURF.paint);
    _c.setHex(COLORS.marking);
    motorwayPaint(sink, f, fr, { cell, city, js: junctionsNear(f), inPads, yAt, mark: MARK,
      col: [_c.r, _c.g, _c.b], s0, endsAt: endsIndex(cell.roads) });
  }
  if (!mwp && f.d && (f.w ?? 0) >= EDGE_MIN_W && EDGE_CLASSES.has(f.t)) {
    sink.at(SURF.paint);
    _c.setHex(COLORS.marking);
    const er = _c.r, eg = _c.g, eb = _c.b;
    const off = hw - EDGE_INSET;
    // Everything this line must NOT be painted over. OSM maps a dual
    // carriageway as two ways, a slip road as a third and the service road
    // beside it as a fourth, and every one of them used to lay down its own two
    // white lines — measured, 20 % of road midpoints in a Pardubice tile have
    // another drivable road lying across them, some of them five. Overlapping
    // TARMAC is harmless: it is the same colour at the same height and reads as
    // a wider road. Overlapping white LINES are a lattice, because a line is the
    // highest-contrast thing on the surface.
    const js = junctionsNear(f);
    const covered = (x, z, dx2, dz2) => crossedBy(cell, f, x, z, dx2, dz2, -0.4)
      // …and a road running THROUGH a junction stops its lines there, the way a
      // real one stops at the give-way line rather than painting over the box.
      // The test is the pad's own OUTLINE now that it has one worth the name:
      // the line stops exactly at the mouth, where the kerb radius begins.
      || !!inPads(js, x, z);
    for (const side of [-1, 1]) {
      // a kerbed street has no edge line: the kerb IS the edge. The white line
      // is what a road has where its edge is a verge.
      const sideIdx = side > 0 ? 1 : 0;
      for (let i = 0; i < q.length - 1; i++) {
        // Break the line short of each end. OSM splits a way at every junction,
        // so a stripe run right to the last vertex would meet the cross street's
        // stripe head-on and paint a white lattice over the intersection. Real
        // edge lines stop at the give-way line for the same reason.
        if (along[i] < EDGE_END || along[i + 1] > len - EDGE_END) continue;
        if (vg && vergeAt(f, (along[i] + along[i + 1]) / 2 + s0, sideIdx).w > 0.3) continue;
        const ya = ys[i] + MARK, yb = ys[i + 1] + MARK;
        const [pax, paz] = per[i], [pbx, pbz] = per[i + 1];
        const ax = q[i][0] + pax * off * side, az = q[i][1] + paz * off * side;
        const bx = q[i + 1][0] + pbx * off * side, bz = q[i + 1][1] + pbz * off * side;
        const sL = Math.hypot(bx - ax, bz - az) || 1e-9;
        if (covered((ax + bx) / 2, (az + bz) / 2, (bx - ax) / sL, (bz - az) / sL)
          || inPads(js, ax, az) || inPads(js, bx, bz)) continue;
        // the stripe's own width runs along the same perpendicular as the inset
        sink.quad(
          ax - pax * EDGE_HW, ya, az - paz * EDGE_HW,
          bx - pbx * EDGE_HW, yb, bz - pbz * EDGE_HW,
          bx + pbx * EDGE_HW, yb, bz + pbz * EDGE_HW,
          ax + pax * EDGE_HW, ya, az + paz * EDGE_HW, er, eg, eb);
      }
    }
  }
  if (mwp) { /* painted above */ } else if (f.d && (f.w ?? 0) >= 5.5 && DASH_CLASSES.has(f.t)) {
    sink.at(SURF.paint);
    _c.setHex(COLORS.marking);
    const mr = _c.r, mg = _c.g, mb = _c.b;
    const js2 = junctionsNear(f);
    // ---- how many lanes this carriageway carries -------------------------
    // OSM's lanes= when tagged, else one lane per ~3.4 m of oneway width. A
    // ONEWAY with N lanes paints N−1 separators at their real offsets — the
    // dual carriageways of Palackého are exactly this; a two-way keeps its
    // single centre line (per-direction splits need lanes:forward, later).
    const lanes = f.ln ?? (f.ow ? Math.max(1, Math.round((f.w ?? 6) / 3.4)) : 2);
    const seps = [];
    if (f.ow && lanes >= 2) {
      for (let k2 = 1; k2 < lanes; k2++) seps.push((k2 / lanes - 0.5) * usable);
    } else if (!f.ow && f.lf && f.lb && f.lf + f.lb >= 3) {
      // a two-way with an asymmetric split (Palackého: 3+2) paints EVERY
      // internal boundary. The DIRECTION divider (the one at k = lb,
      // counted from the left) is SOLID — drawn dashed it read as one more
      // lane of the same direction.
      const n = f.lf + f.lb;
      for (let k2 = 1; k2 < n; k2++) {
        seps.push({ off: (k2 / n - 0.5) * usable, solid: k2 === f.lb });
      }
    } else if (!f.ow) seps.push(0);
    for (const sep of seps) {
      const lo = typeof sep === 'object' ? sep.off : sep;
      const solid = typeof sep === 'object' && sep.solid;
      const step = solid ? DASH_LEN : DASH_LEN + DASH_GAP;
      const m0 = f.rb ? 0.2 : 1.2;
      // a roundabout's 3 m stubs between exits can't fit a full dash — they
      // draw one shortened dash instead of a permanent gap in the circle
      const dl = f.rb ? Math.max(1.0, Math.min(2.2, len - 2 * m0)) : DASH_LEN;
      const step2 = f.rb ? dl + 2.2 : step;
      for (let s = m0; s + dl <= len - m0 + 0.01; s += step2) {
      walkAt(fr, s, _WA); walkAt(fr, s + dl, _WB);
      const ox = _WA.dz * lo, oz = -_WA.dx * lo;    // this separator's offset
      // a centre line does not run through a junction either — tested at BOTH
      // ends against the pad's outline (and a little beyond it, along the
      // dash), and never painted onto another carriageway lying over this one:
      // the diagonal white chaos at every dual-carriageway crossing was exactly
      // these two leaks.
      // a junction only silences the dashes of roads that END there or pass
      // as strangers — a THROUGH arm keeps its line as the sparse guide
      // dashes every real signalised box paints across the middle
      const through = (j) => {
        const nodes = j.members ?? [j];
        for (const nd of nodes) {
          for (const a2 of nd.arms) if (a2.r === f && !a2.end) return true;
        }
        return false;
      };
      // a ROUNDABOUT ring is exempt from both silences: its lane line flows
      // continuously through every exit node (each exit is a junction, and
      // the ring's short segments fell entirely inside the blank radius —
      // the gaps in the circle), and nothing "crosses" a ring but its own
      // tangential exits
      const rj = (x, z, sgn) => {
        if (f.rb) return false;
        const j = inPads(js2, x, z) ?? inPads(js2, x + _WA.dx * 1.5 * sgn, z + _WA.dz * 1.5 * sgn);
        return !!j && !through(j);
      };
      if (rj(_WA.x + ox, _WA.z + oz, -1) || rj(_WB.x + ox, _WB.z + oz, 1)) continue;
      if (!f.rb && crossedBy(cell, f, (_WA.x + _WB.x) / 2 + ox, (_WA.z + _WB.z) / 2 + oz,
        _WA.dx, _WA.dz, -0.4)) continue;
      const ya = yAt(s) + MARK, yb = yAt(s + dl) + MARK;
      const px = _WA.dz * DASH_HW, pz = -_WA.dx * DASH_HW;
      sink.quad(
        _WA.x + ox - px, ya, _WA.z + oz - pz, _WB.x + ox - px, yb, _WB.z + oz - pz,
        _WB.x + ox + px, yb, _WB.z + oz + pz, _WA.x + ox + px, ya, _WA.z + oz + pz,
        mr, mg, mb);
      }
    }
  } else if (f.t === 'runway') runwayPaint(sink, fr, hw, yAt);
  else if (f.t === 'taxiway' || f.t === 'taxilane') taxiPaint(sink, fr, yAt);
  // everything this ribbon emitted — deck, kerbs, fascia, parapets, lane
  // paint — is already at its absolute height
  if (mark >= 0) sink.fixFrom(mark);
}

// Every junction whose pad could touch this way — gathered from the buckets
// of every chunk the way's bbox reaches (± one chunk), because junctions are
// bucketed by their centre and a pad happily straddles the border. Cached on
// the way: the list is asked for twice per ribbon, per rebuild.
function junctionsNear(f) {
  if (f._jsNear) return f._jsNear;
  const bb = bboxOfLine(f);
  const out = [];
  const c0x = Math.floor(bb[0] / CHUNK) - 1, c1x = Math.floor(bb[2] / CHUNK) + 1;
  const c0z = Math.floor(bb[1] / CHUNK) - 1, c1z = Math.floor(bb[3] / CHUNK) + 1;
  for (let cx = c0x; cx <= c1x; cx++) {
    for (let cz = c0z; cz <= c1z; cz++) {
      const js = junctionsIn(cx + ',' + cz);
      if (js) for (const j of js) out.push(j);
      // clusters carry x/z/padR like a node, so the same radius tests apply —
      // and they cover the space BETWEEN their member nodes, where orphaned
      // dashes used to survive
      const cls3 = clustersIn(cx + ',' + cz);
      if (cls3) for (const cl of cls3) out.push(cl);
    }
  }
  return (f._jsNear = out);
}

/**
 * Pull a polyline back from one or both ends by a distance, walking the real
 * geometry rather than moving the endpoint along the chord — a road that bends
 * in its last ten metres would otherwise be cut in the wrong direction.
 * Returns null if there is nothing left worth drawing.
 */
function trimEnds(p, t0 = 0, t1 = 0) {
  if (!t0 && !t1) return p;
  const walk = (pts, d) => {                 // trim `d` off the START of pts
    if (d <= 0) return pts;
    let left = d;
    for (let i = 0; i < pts.length - 1; i++) {
      const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      if (L < left) { left -= L; continue; }
      const t = left / L;
      return [[pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t,
        pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t], ...pts.slice(i + 1)];
    }
    return null;
  };
  let q = walk(p, t0);
  if (!q) return null;
  if (t1) { q = walk(q.slice().reverse(), t1); if (!q) return null; q.reverse(); }
  return q.length >= 2 ? q : null;
}

// ---- junction pads --------------------------------------------------------
// The surface a junction actually has. Its arms have been pulled back (geo.js
// marks the trim), leaving a hole; this fills it with ONE polygon built from
// the arms themselves rather than from a circle, so a crossroads comes out
// square-ish and a fork comes out like a fork.
//
// Convex hull of the arm mouths: for each arm, the two corners of its cross
// section at the pad radius. That is guaranteed simple — no self-intersection
// to check, no inset that can fold — and it covers every arm by construction
// because each arm's own corners are vertices of it.
// A flat paint quad whose normal ALWAYS points up, whatever order the
// caller derived its corners in. TriSink reads winding for the normal, so an
// ad-hoc frame with flipped handedness rendered its quad facing DOWN — the
// arrow shafts were there, backface-culled ("létající trojúhelníčky").
function paintQuad(sink, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, r, g, b) {
  const ny = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  if (ny <= 0) sink.quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, r, g, b);
  else sink.quad(dx, dy, dz, cx, cy, cz, bx, by, bz, ax, ay, az, r, g, b);
}

// ---- what is painted across a mouth ----------------------------------------
// A stop line where the approach is CONTROLLED (a stop sign or a signal), a row
// of give-way triangles where it yields, and nothing at all where nothing in
// the data says either: a bar on every arm of every junction said the whole
// town was signalised. The control of each leg is worked out in js/streets.js
// from the tiles' own sign and signal nodes.
//
// Both sit just OUTSIDE the mouth, on the approach side of the carriageway
// only: Czech V5 and V2 lines span the lanes that arrive, not the ones leaving.
function mouthMarks(sink, o, deckAt, cell) {
  const legs = o._legs;
  if (!legs) return;
  sink.at(SURF.paint);
  _c.setHex(COLORS.marking);
  const mr = _c.r, mg = _c.g, mb = _c.b;
  for (const lg of legs) {
    const r = lg.r;
    if (!lg.ctl || !r.d || r.rb || lg.hw < 2.2) continue;
    // a oneway flows p[0] to p[last]; dir > 0 means this leg LEAVES along it
    if (r.ow && lg.dir > 0) continue;
    const ux = lg.ux, uz = lg.uz;                 // away from the node
    const rx = uz, rz = -ux;                      // right of a driver coming in
    const c0 = r.ow ? -(lg.hw - 0.4) : 0.12, c1 = lg.hw - 0.4;
    if (c1 - c0 < 1.2) continue;
    const at = lg.m + 0.55;                       // metres out from the node
    const bx = lg.nx + ux * at, bz = lg.nz + uz * at;
    // A zebra often lies right at a side street's mouth, and the teeth were
    // painted over its stripes. The crossing already says who waits.
    let zebra = false;
    for (const c of cell?.crossings ?? []) {
      if ((c.p[0][0] - bx) ** 2 + (c.p[0][1] - bz) ** 2 < 12) { zebra = true; break; }
    }
    if (zebra) continue;
    const P = (a, c) => [bx + ux * a + rx * c, bz + uz * a + rz * c];
    if (lg.ctl === 'give') {
      // triangles pointing at whoever is arriving
      for (let c = c0 + 0.1; c + 0.5 <= c1; c += 0.75) {
        const p0 = P(0, c), p1 = P(0, c + 0.5), p2 = P(0.62, c + 0.25);
        const y = deckAt((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2) + MARK;
        sink.triFacing(p0[0], y, p0[1], p1[0], y, p1[1], p2[0], y, p2[1], 0, 1, 0, mr, mg, mb);
      }
    } else {
      const p0 = P(0, c0), p1 = P(0, c1), p2 = P(0.5, c1), p3 = P(0.5, c0);
      const y = deckAt(bx + rx * (c0 + c1) / 2, bz + rz * (c0 + c1) / 2) + MARK;
      paintQuad(sink, p0[0], y, p0[1], p1[0], y, p1[1], p2[0], y, p2[1], p3[0], y, p3[1], mr, mg, mb);
    }
  }
  sink.at(SURF.asphalt);
}

// ---- one pad, single node or cluster ------------------------------------------
// The outline is no longer convex (it has a kerb radius in every corner), so
// it is triangulated by ear clipping instead of fanned from its first corner,
// then subdivided so the pointwise deck has vertices to live on. Everything a
// junction is made of goes in here: the surface, the kerb round it, the paint.
function padInto(sink, o, ring, deckOf, terrain, big, cell) {
  if (!ring || ring.length < 3) return;
  sink.at(SURF.asphalt);
  // the widest drivable arm names the surface: a pad in residential grey in
  // the middle of a primary read as a patch of different tarmac at every
  // big crossing
  let padT = 'residential', padW = 0, rank = 0;
  for (const m of o.members ?? [o]) {
    for (const a of m.arms) {
      if (!a.r.d) continue;
      rank = Math.max(rank, roadRank(a.r));
      if ((a.r.w ?? 0) > padW && COLORS.road[a.r.t]) { padW = a.r.w; padT = a.r.t; }
    }
  }
  _c.setHex(COLORS.road[padT] ?? COLORS.road.residential);
  const pr = _c.r, pg = _c.g, pb = _c.b;
  // a hair above the ribbons, never fighting: over the highest-ranked arm's own lift
  const lift = LAYER_Y.road + 0.012 + rank * RANK_LIFT;
  const faces = THREE.ShapeUtils.triangulateShape(ring.map(([x, z]) => new THREE.Vector2(x, z)), []);
  const fan = [];
  for (const [a, b, c] of faces) {
    fan.push(ring[a][0], 0, ring[a][1], ring[b][0], 0, ring[b][1], ring[c][0], 0, ring[c][1]);
  }
  if (!fan.length) return;
  const tp = tessTriangles(fan, fan.length / 9, 4);
  // ---- the pad is the CONTINUATION of its arms, pointwise ------------------
  // One flat height was tried and looked like torn paper: the arms climb to
  // the node along their own levelled grades, so a pad at any single height
  // meets every one of them at a different step. What a junction's surface
  // actually is: at every point, the deck of the NEAREST arm. That lives
  // in geo.junctionDeckY, because the physics has to stand on the same numbers
  // this is drawn from.
  const deckAt = (x, z) => (terrain ? deckOf(x, z) : 0) + lift;
  const mark = sink.mark();
  for (let k = 0; k < tp.length; k += 9) {
    sink.triFacing(
      tp[k], deckAt(tp[k], tp[k + 2]), tp[k + 2],
      tp[k + 3], deckAt(tp[k + 3], tp[k + 5]), tp[k + 5],
      tp[k + 6], deckAt(tp[k + 6], tp[k + 8]), tp[k + 8],
      0, 1, 0, pr, pg, pb);
  }
  if (terrain) {
    // the kerb stands on the ARMS' level (what the ribbon bands either side of
    // each mouth stand on), not on the pad's hair of lift
    ringKerbInto(sink, o, (x, z) => deckOf(x, z) + LAYER_Y.road, terrain);
    mouthMarks(sink, o, deckAt, cell);
    if (big) boxFurniture(sink, o, ring, deckAt);
    sink.fixFrom(mark);
  }
}

// The pad of a whole CLUSTER: several nodes, one surface. What it buys is
// everything BETWEEN the member nodes: no slivers of ground, no mismatched
// shades, no orphaned paint inside the crossing.
function clusterPad(sink, cl, terrain, cell) {
  padInto(sink, cl, clusterHull(cl), (x, z) => clusterDeckY(cl, x, z, terrain), terrain, true, cell);
}

// ---- the paint INSIDE a big crossing --------------------------------------
// What the aerial photo of náměstí Jana Pernera actually shows on the box:
// thin GUIDE DASHES connecting each entry to its continuation across, and an
// ARROW on each approach lane before the stop line. Both are derived from the
// cluster's own legs: one generator, not per-road patches.
function boxFurniture(sink, cl, ring, deckAt) {
  sink.at(SURF.paint);
  _c.setHex(COLORS.marking);
  const mr = _c.r, mg = _c.g, mb = _c.b;
  // every drivable mouth: position on the outline + direction INTO the box
  const mouths = [];
  for (const lg of cl._legs ?? []) {
    const r = lg.r;
    if (!r.d || (r.w ?? 0) < 5 || r.rb) continue;
    const ix = -lg.ux, iz = -lg.uz;               // INTO the box
    // forward (p[0] to p[last]) traffic comes IN along a leg that runs against it
    const fwdIn = lg.dir < 0;
    mouths.push({
      x: lg.nx + lg.ux * lg.m, z: lg.nz + lg.uz * lg.m,
      ix, iz, w: r.w ?? 6, lg, used: false, fwdIn,
      // a oneway ENTERS the box at this mouth when its travel points in
      entering: !r.ow || fwdIn,
    });
  }
  // ---- guide dashes: LONGEST spans first --------------------------------
  // Greedy nearest-pairing ate the mouths on 7 m hops between neighbouring
  // member nodes — one faint dash each, invisible. The lines the aerial
  // photo shows are the LONG crossings (west entry to east exit), so gather
  // every admissible pair, sort by span, and let the long ones claim their
  // mouths first. Anything under 12 m is box-internal plumbing, not a lane.
  const pairs = [];
  for (let i2 = 0; i2 < mouths.length; i2++) {
    for (let j2 = i2 + 1; j2 < mouths.length; j2++) {
      const mo = mouths[i2], other = mouths[j2];
      const sx = other.x - mo.x, sz = other.z - mo.z;
      const L = Math.hypot(sx, sz);
      if (L < 12) continue;
      const along = (sx * mo.ix + sz * mo.iz) / L;      // line runs the way we enter
      const facing = -(other.ix * mo.ix + other.iz * mo.iz); // and they face each other
      if (along < 0.8 || facing < 0.7) continue;
      pairs.push([L, mo, other]);
    }
  }
  pairs.sort((p1, p2) => p2[0] - p1[0]);
  for (const [L, mo, best] of pairs) {
    if (mo.used || best.used) continue;
    mo.used = best.used = true;
    const sx = best.x - mo.x, sz = best.z - mo.z;
    const ux = sx / L, uz = sz / L;
    const px2 = -uz, pz2 = ux;
    const HW = 0.09;
    // one guide line per lane of the ENTERING side — the aerial photo shows
    // the lane separators continuing across the box, not one lone line
    const r2 = mo.lg.r;
    const lo2 = [];
    if (r2.ow && mo.entering) {
      const n = r2.ln ?? Math.max(1, Math.round((r2.w ?? 6) / 3.4));
      const usable = (r2.w ?? 6) - 1.2;
      for (let k = 1; k < n; k++) lo2.push((k / n - 0.5) * usable);
      if (!lo2.length) lo2.push(0);
    } else lo2.push(0);
    for (const off of lo2) for (let d = 1.2; d + 1.4 < L; d += 3.6) {
      const bx2 = mo.x + px2 * off, bz2 = mo.z + pz2 * off;
      const midx = bx2 + ux * (d + 0.7), midz = bz2 + uz * (d + 0.7);
      if (!pointInPolygon(midx, midz, ring)) continue;   // stay ON the box
      const y0 = deckAt(bx2 + ux * d, bz2 + uz * d) + MARK;
      const y1 = deckAt(bx2 + ux * (d + 1.4), bz2 + uz * (d + 1.4)) + MARK;
      paintQuad(sink,
        bx2 + ux * d - px2 * HW, y0, bz2 + uz * d - pz2 * HW,
        bx2 + ux * (d + 1.4) - px2 * HW, y1, bz2 + uz * (d + 1.4) - pz2 * HW,
        bx2 + ux * (d + 1.4) + px2 * HW, y1, bz2 + uz * (d + 1.4) + pz2 * HW,
        bx2 + ux * d + px2 * HW, y0, bz2 + uz * d + pz2 * HW,
        mr, mg, mb);
    }
  }
  // ---- arrows: where the DATA has them ------------------------------------
  // A real V9a arrow is ~5 m long and each approach lane wears its own. They
  // used to be painted on every approach of every big crossing, straight-ahead
  // by default, which is not what a street has: an arrow is there because the
  // lane is reserved for a movement. So they are drawn where OSM carries
  // turn:lanes, and on the multi-lane approaches of a signalled box (where the
  // lanes ARE sorted, tagged or not). Exits get none.
  for (const mo of mouths) {
    if (!mo.entering) continue;
    const r = mo.lg.r;
    const rx = -mo.iz, rz = mo.ix;                // right of travel-in
    const usable = (r.w ?? 6) - 1.2;
    // how many lanes ARRIVE at this mouth, where they sit, and their turns
    let nIn, offAt, turnsSpec = null;
    if (r.ow) {
      nIn = r.ln ?? Math.max(1, Math.round((r.w ?? 6) / 3.4));
      // count from the RIGHT edge in, matching the turn:lanes indexing — the
      // left-to-right offsets put the right-turn glyph in the LEFT lane
      offAt = (k) => (0.5 - (k + 0.5) / nIn) * usable;
      turnsSpec = r.tf ?? null;
    } else {
      const total = r.ln ?? ((r.lf ?? 1) + (r.lb ?? 1));
      // forward flows p[0]→p[last]; whichever direction ENTERS here owns the
      // right-hand block of the carriageway and its own turn:lanes
      nIn = mo.fwdIn ? (r.lf ?? Math.max(1, Math.floor(total / 2)))
        : (r.lb ?? Math.max(1, Math.floor(total / 2)));
      const N = Math.max(total, nIn);
      offAt = (k) => (0.5 - (k + 0.5) / N) * usable;   // from the right edge in
      turnsSpec = (mo.fwdIn ? r.tf : r.tb) ?? null;
    }
    if (!turnsSpec && !(mo.lg.ctl === 'signal' && nIn >= 2)) continue;
    const laneTurns = turnsSpec ? turnsSpec.split('|') : null;
    for (let k = 0; k < nIn; k++) {
      const off = offAt(k);
      const ax2 = mo.x - mo.ix * 6.4 + rx * off;  // stand clear of the stop line
      const az2 = mo.z - mo.iz * 6.4 + rz * off;
      if (pointInPolygon(ax2, az2, ring)) continue;  // clustered mouths overlap
      const y = deckAt(ax2, az2) + MARK;
      const S = (u, v) => [ax2 + mo.ix * u + rx * v, az2 + mo.iz * u + rz * v];
      const q5 = (a2, b2, c2, d2) => paintQuad(sink, a2[0], y, a2[1], b2[0], y, b2[1],
        c2[0], y, c2[1], d2[0], y, d2[1], mr, mg, mb);
      // turn:lanes lists left→right along travel; our k counts from the right
      const g = laneTurns
        ? (laneTurns[laneTurns.length - 1 - k] ?? 't') : 't';
      q5(S(-2.5, -0.14), S(1.0, -0.14), S(1.0, 0.14), S(-2.5, 0.14));   // shaft
      if (g.includes('t') || g === '') {
        const t0 = S(0.9, -0.48), t1 = S(0.9, 0.48), tip = S(2.5, 0);
        sink.triFacing(t0[0], y, t0[1], t1[0], y, t1[1], tip[0], y, tip[1], 0, 1, 0, mr, mg, mb);
      }
      // a turn head sits at the shaft top, pointing sideways off an elbow
      for (const [flag, side] of [['l', -1], ['r', 1]]) {
        if (!g.includes(flag)) continue;
        q5(S(0.7, -0.14), S(1.0, -0.14), S(1.0, 0.6 * side), S(0.7, 0.6 * side)); // elbow
        const h0 = S(0.4, 0.62 * side), h1 = S(1.3, 0.62 * side), hp = S(0.85, 1.35 * side);
        sink.triFacing(h0[0], y, h0[1], h1[0], y, h1[1], hp[0], y, hp[1], 0, 1, 0, mr, mg, mb);
      }
    }
  }
  sink.at(SURF.asphalt);
}

function junctionPad(sink, j, terrain, cell) {
  if (j._cluster) return;                   // drawn as one surface by clusterPad
  if (j._ring) return;                      // a roundabout node needs no pad
  // ---- the pad rides the JUNCTION'S grade, not the terrain -----------------
  // The roads arriving here are levelled: every arm is pinned to one agreed
  // height (junctionY) and may sit up to GRADE_CUT below the terrain. The pad
  // used to drape on the raw terrain instead, which put it up to 15 cm ABOVE
  // the decks it exists to join — it buried the ribbons, buried their give-way
  // markings ("silnicím chybí značení" was largely this), and its seams with
  // the differently-graded arms were the patchwork of shades all over every
  // big crossing.
  //
  // So the pad now lives at the same height the arms were pinned to, rising
  // only where the terrain forces it up by more than the cut budget — exactly
  // the bound the roads themselves obey. Absolute heights, marked fixed so the
  // final drape leaves them alone; tessellated so a bump between outline
  // corners cannot lift the ground through it.
  padInto(sink, j, junctionHull(j), (x, z) => junctionDeckY(j, x, z, terrain), terrain, false, cell);
}

// ---- runway paint ---------------------------------------------------------
// A runway is not a wide road, and the difference is entirely paint. Three
// marks carry it, in descending order of how much they matter from the air:
// the long dashed centreline that tells you where the middle is, the threshold
// "piano keys" that shout where the concrete starts, and the two edge stripes
// that give the strip its hard rectangular edge against the grass. Real ICAO
// dimensions: 30 m stripe / 20 m gap on the centreline, 0.9 m wide; threshold
// bars 30 m long and 1.8 m wide; edge stripes 0.9 m, set 3 m in from the lip.
const RW_DASH = 30, RW_GAP = 20, RW_HW = 0.45;
const RW_KEY_LEN = 30, RW_KEY_HW = 0.9, RW_KEY_GAP = 4.8, RW_KEY_START = 12;
const RW_EDGE_HW = 0.45, RW_EDGE_IN = 3;

// one flat stripe along the ribbon between arc lengths s0..s1, offset `off`
// metres to the right of the centreline and `hwid` half-width
// `yAt(d)` is the ribbon's own deck along the frame: a levelled runway is at
// its ABSOLUTE height like any graded way, and paint authored at a bare layer
// offset beside it was two hundred metres underground.
function stripe(sink, fr, s0, s1, off, hwid, r, g, b, yAt) {
  walkAt(fr, s0, _WA); walkAt(fr, s1, _WB);
  const y0 = yAt ? yAt(s0) + MARK : LAYER_Y.marking, y1 = yAt ? yAt(s1) + MARK : LAYER_Y.marking;
  const ax = _WA.x + _WA.dz * off, az = _WA.z - _WA.dx * off;
  const bx = _WB.x + _WB.dz * off, bz = _WB.z - _WB.dx * off;
  const p0x = _WA.dz * hwid, p0z = -_WA.dx * hwid;
  const p1x = _WB.dz * hwid, p1z = -_WB.dx * hwid;
  sink.quad(ax - p0x, y0, az - p0z, bx - p1x, y1, bz - p1z,
    bx + p1x, y1, bz + p1z, ax + p0x, y0, az + p0z, r, g, b);
}

function runwayPaint(sink, fr, hw, yAt) {
  sink.at(SURF.paint);
  const len = fr.len;
  if (len < 120) return;                       // a stub, not a strip
  _c.setHex(COLORS.runwayPaint);
  const r = _c.r, g = _c.g, b = _c.b;
  // centreline
  for (let s = RW_KEY_START + RW_KEY_LEN + 12; s + RW_DASH < len - (RW_KEY_START + RW_KEY_LEN + 12);
    s += RW_DASH + RW_GAP) stripe(sink, fr, s, s + RW_DASH, 0, RW_HW, r, g, b, yAt);
  // threshold keys at both ends, symmetric about the centreline. The count is
  // the real rule of thumb — a 45 m runway wears eight, a 60 m twelve.
  const keys = Math.max(4, Math.min(12, Math.round(hw * 2 / 7.5)) & ~1);
  for (const end of [0, 1]) {
    const s0 = end ? len - RW_KEY_START - RW_KEY_LEN : RW_KEY_START;
    for (let i = 0; i < keys; i++) {
      // lay them out in pairs either side of the middle, skipping the centre
      const k = i - (keys - 1) / 2;
      const off = k * (RW_KEY_HW * 2 + RW_KEY_GAP) + Math.sign(k) * RW_KEY_GAP * 0.5;
      if (Math.abs(off) + RW_KEY_HW > hw - 1) continue;
      stripe(sink, fr, s0, s0 + RW_KEY_LEN, off, RW_KEY_HW, r, g, b, yAt);
    }
  }
  // edge stripes down both lips
  for (const side of [-1, 1])
    stripe(sink, fr, 2, len - 2, side * (hw - RW_EDGE_IN), RW_EDGE_HW, r, g, b, yAt);
}

// Taxiways get the one mark that matters: a continuous yellow centreline. It
// is the thread that visibly ties the apron to the runway threshold.
function taxiPaint(sink, fr, yAt) {
  sink.at(SURF.paint);
  if (fr.len < 20) return;
  _c.setHex(COLORS.taxiPaint);
  stripe(sink, fr, 1, fr.len - 1, 0, 0.3, _c.r, _c.g, _c.b, yAt);
}

// ---- rails: a bed, sleepers on it, steel standing on them ------------------
// The steel used to be two flat strips over whatever ground the map gave:
// rails floating on grass, and tram rails standing 6 cm proud of the asphalt
// they are supposed to be set into. A track is built from the bottom up, so:
//
//   heavy rail   a crowned BALLAST bed 2.7 m wide on top with shoulders falling
//                into the ground, sleepers lying on it, and the rails as steel
//                with a HEIGHT (a head and two webs) standing on the sleepers.
//                Parallel tracks pour their beds into one another, which is
//                what a station throat looks like.
//   tram         a concrete track panel set in the street, a couple of
//                centimetres over the carriageway with chamfered edges, and
//                the rails as steel let flush into it.
//
// The rail HEAD stays at LAYER_Y.rail + 0.04: trains.js stands its wheels there.
const BED_HW = 1.35, BED_FOOT = 2.25;          // ballast: half width of the top, of the foot
const TRAM_HW = 1.2, TRAM_UP = 0.03;           // tram panel: half width, lift over the road deck
const TRAM_WIRE_H = WIRE_H;                    // contact wire over the panel (js/trambody.js)
function railWay(sink, f, terrain, cell, masts = true, city = null) {
  const railBridge = !!f.br && !!terrain;
  const fr = ribbonFrame(f.br ? bridgeResample(f.p) : terrainResample(f.p, terrain));
  if (!fr) return;
  const { q, per, along, len } = fr;
  const tram = f.t === 'tram';
  // A railway is LEVELLED like a road — flatter, in fact: real rail holds
  // 1–2 %. Draped raw it kinked at every terrain crease, and the sleepers
  // showed each fold as a visible corner. The earthworks pull the ground to
  // this same line, so the ballast sits ON its bed instead of over a crack.
  const railGraded = !f.br && !!terrain && !!roadProfile(f, terrain);
  // Absolute, like the graded roads: the old fill-then-drape round trip
  // sampled the ground at the centreline and re-added it at each vertex, so
  // on a cross-slope one rail rode higher than the other — the thing a real
  // track never does and the reason trains here would derail.
  const railMark = railGraded || railBridge ? sink.mark() : -1;
  const elev = (d, x2, z2) => {
    // A rail BRIDGE deck is absolute too: the legacy relative arc left the
    // whole track to the chunk drape, which re-added the valley under every
    // sleeper — sleepers metres below their own rails over the Labe.
    if (f.br) return railBridge ? bridgeDeckHeight(f, d, terrain) : bridgeElevation(d, len);
    if (!railGraded) return 0;
    // (a tram: the deck of the street it is set into, see geo.railGradeY)
    const gy = railGradeY(f, d, terrain);
    return gy === null ? terrain.heightAt(x2, z2) : gy;
  };
  const n = q.length;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) g[i] = elev(along[i], q[i][0], q[i][1]);
  // the level everything stands on: the sleeper tops, or the tram panel
  const base = tram ? LAYER_Y.road + TRAM_UP : LAYER_Y.rail;
  const headY = tram ? base + 0.004 : LAYER_Y.rail + 0.04;
  const strip = (o1, y1o, o2, y2o, r, gg, b, foot) => {
    for (let i = 0; i < n - 1; i++) {
      const [pax, paz] = per[i], [pbx, pbz] = per[i + 1];
      const ax = q[i][0], az = q[i][1], bx = q[i + 1][0], bz = q[i + 1][1];
      let ya2 = g[i] + y2o, yb2 = g[i + 1] + y2o;
      if (foot && railGraded) {
        // a shoulder's foot goes INTO the ground it meets, wherever that is
        ya2 = Math.min(terrain.heightAt(ax + pax * o2, az + paz * o2) - 0.04, g[i] + y1o - 0.08);
        yb2 = Math.min(terrain.heightAt(bx + pbx * o2, bz + pbz * o2) - 0.04, g[i + 1] + y1o - 0.08);
      }
      paintQuad(sink,
        ax + pax * o1, g[i] + y1o, az + paz * o1, bx + pbx * o1, g[i + 1] + y1o, bz + pbz * o1,
        bx + pbx * o2, yb2, bz + pbz * o2, ax + pax * o2, ya2, az + paz * o2, r, gg, b);
    }
  };
  if (tram) {
    sink.at(SURF.concrete);
    _c.setHex(0x7d7c78);
    const br2 = _c.r, bg2 = _c.g, bb2 = _c.b;
    strip(-TRAM_HW, base, TRAM_HW, base, br2, bg2, bb2, false);
    // chamfered edges down under the asphalt either side
    strip(-TRAM_HW - 0.22, LAYER_Y.road - 0.03, -TRAM_HW, base, br2 * 0.8, bg2 * 0.8, bb2 * 0.8, false);
    strip(TRAM_HW, base, TRAM_HW + 0.22, LAYER_Y.road - 0.03, br2 * 0.8, bg2 * 0.8, bb2 * 0.8, false);
    // the contact wire (trolejové vedení): one 600 V wire over the middle of
    // the track, TRAM_WIRE_H over the panel, which is exactly where the
    // pantographs of js/trammesh.js reach. Absolute heights only (railMark):
    // a relative wire would be draped onto the ground under it.
    if (railMark >= 0) {
      // (steel, with the rail heads: the concrete layer is the panel's alone)
      sink.at(SURF.paint);
      _c.setHex(0x2a2c30);
      const cr = _c.r, cg = _c.g, cb = _c.b;
      for (let i = 0; i < n - 1; i++) {
        const ax = q[i][0], az = q[i][1], bx = q[i + 1][0], bz = q[i + 1][1];
        const ya = g[i] + base + TRAM_WIRE_H, yb = g[i + 1] + base + TRAM_WIRE_H;
        // a thin double-sided ribbon, as the trolleybus wire (trolleyInto)
        sink.quad(ax, ya - 0.03, az, bx, yb - 0.03, bz, bx, yb + 0.03, bz, ax, ya + 0.03, az, cr, cg, cb);
        sink.quad(ax, ya + 0.03, az, bx, yb + 0.03, bz, bx, yb - 0.03, bz, ax, ya - 0.03, az, cr, cg, cb);
      }
    }
    if (railMark >= 0 && cell && masts) tramMastsInto(sink, f, fr, g, base, terrain, cell);
  } else if (f.br) {
    // A rail bridge had no deck at all: sleepers and steel crossing the Labe
    // on nothing. A concrete trough under the track, a girder face down each
    // side, and the same abutments and piers a road bridge stands on.
    sink.at(SURF.concrete);
    _c.setHex(0x8f8c86);
    const dr = _c.r, dg = _c.g, db = _c.b;
    const DHW = 2.3;
    strip(-DHW, base - 0.03, DHW, base - 0.03, dr, dg, db, false);
    for (let i = 0; i < n - 1; i++) {
      for (const e of [-1, 1]) {
        const X0 = q[i][0] + per[i][0] * DHW * e, Z0 = q[i][1] + per[i][1] * DHW * e;
        const X1 = q[i + 1][0] + per[i + 1][0] * DHW * e, Z1 = q[i + 1][1] + per[i + 1][1] * DHW * e;
        wallQuad4(sink, X0, Z0, X1, Z1, g[i] + base + 0.25, g[i + 1] + base + 0.25,
          g[i] + base - FASCIA, g[i + 1] + base - FASCIA, per[i][0] * e, per[i][1] * e, dr * 0.72, dg * 0.72, db * 0.72);
        wallQuad4(sink, X0, Z0, X1, Z1, g[i] + base + 0.25, g[i + 1] + base + 0.25,
          g[i] + base - 0.03, g[i + 1] + base - 0.03, -per[i][0] * e, -per[i][1] * e, dr * 0.72, dg * 0.72, db * 0.72);
      }
    }
    if (railBridge) {
      const ysB = new Float32Array(n);
      for (let i = 0; i < n; i++) ysB[i] = g[i] + base;
      bridgeSupports(sink, f, fr, ysB, DHW, cell, terrain, false);
    }
  } else {
    // Crushed stone under the whole of it.
    sink.at(SURF.ballast);
    _c.setHex(COLORS.railBed);
    const br2 = _c.r, bg2 = _c.g, bb2 = _c.b;
    strip(-BED_HW, base - 0.025, BED_HW, base - 0.025, br2, bg2, bb2, false);
    if (railGraded) {
      // sloped shoulders down to the drawn ground, and one bed with a track
      // beside it (js/batter.js): no inner shoulders between them
      railShouldersInto(sink, f, q, per, g, terrain, edgeNear(city, f, bboxOfLine), stampShaped,
        [br2 * 0.86, bg2 * 0.86, bb2 * 0.86]);
    } else {
      strip(-BED_HW, base - 0.025, -BED_FOOT, 0, br2 * 0.86, bg2 * 0.86, bb2 * 0.86, true);
      strip(BED_HW, base - 0.025, BED_FOOT, 0, br2 * 0.86, bg2 * 0.86, bb2 * 0.86, true);
    }
  }
  if (!tram) {
    sink.at(SURF.concrete);
    _c.setHex(COLORS.sleeper);
    const sr = _c.r, sg = _c.g, sb = _c.b;
    for (let s = SLEEPER_STEP / 2; s < len; s += SLEEPER_STEP) {
      walkAt(fr, s, _WA);
      const y = LAYER_Y.rail + elev(s, _WA.x, _WA.z);
      const ux = _WA.dx * SLEEPER_HW, uz = _WA.dz * SLEEPER_HW;
      const px = _WA.dz * SLEEPER_HL, pz = -_WA.dx * SLEEPER_HL;
      sink.quad(
        _WA.x - ux - px, y, _WA.z - uz - pz, _WA.x + ux - px, y, _WA.z + uz - pz,
        _WA.x + ux + px, y, _WA.z + uz + pz, _WA.x - ux + px, y, _WA.z - uz + pz, sr, sg, sb);
    }
  }
  // the steel: a polished head, and on heavy rail a web either side so it has
  // a height from the platform edge
  sink.at(SURF.paint);
  _c.setHex(tram ? 0x55575b : 0x6a6d72);
  const hr = _c.r, hg = _c.g, hb = _c.b;
  _c.setHex(COLORS.rail);
  const wr = _c.r, wg = _c.g, wb = _c.b;
  const HEAD = tram ? 0.035 : 0.045;
  for (const side of [-1, 1]) {
    const o1 = side * GAUGE_H - HEAD, o2 = side * GAUGE_H + HEAD;
    strip(o1, headY, o2, headY, hr, hg, hb, false);
    if (!tram) {
      for (let i = 0; i < n - 1; i++) {
        const [pax, paz] = per[i], [pbx, pbz] = per[i + 1];
        const ax = q[i][0], az = q[i][1], bx = q[i + 1][0], bz = q[i + 1][1];
        for (const [o, fs] of [[o1, -1], [o2, 1]]) {
          wallQuad4(sink, ax + pax * o, az + paz * o, bx + pbx * o, bz + pbz * o,
            g[i] + headY, g[i + 1] + headY, g[i] + base - 0.03, g[i + 1] + base - 0.03,
            pax * fs, paz * fs, wr, wg, wb);
        }
      }
    }
  }
  if (railMark >= 0) sink.fixFrom(railMark);
}

// The masts that carry a tram's contact wire. OSM maps 36 of the network's
// thousands, so they are placed: one every TRAM_MAST_STEP along each tram rail
// (from the way's first vertex, drawn whole from its home chunk with its wire),
// on whichever side has room. Room means: not on a carriageway (a street-running
// track has its masts at the kerb, on a longer arm), not on another tram track
// (the other direction usually runs 3 m away), not inside a house. Where neither
// side has room within TRAM_MAST_REACH there is no mast and the wire spans the
// gap, as it does over a junction. Absolute heights, inside railWay's fixFrom.
const TRAM_MAST_STEP = 34, TRAM_MAST_OFFS = [2.6, 3.6, 5, 6.5, 8];
// Every spot a mast tries (up to ten a mast, a mast every 34 m of every tram
// rail) asked three questions of the WHOLE cell: is it on a carriageway, on
// another tram track, inside a house. That walked every road, rail and house
// of a Prague cell per spot, 3 to 11 ms a chunk. The same questions are now
// asked of a coarse grid of those features, built once per cell (and again
// only if the cell's lists change length): a feature whose box is nowhere near
// the spot is skipped, every other one is tested exactly as before, so the
// answers, the geometry and the worker/main-thread parity are unchanged.
// (WeakMap, never a field on the cell: js/chunkspec.js copies cells to the
// workers and refuses anything with a live object on it.)
const MAST_G = 16, MAST_GROW = 0.4, MAST_RAIL = 2.0;
const _mastGrids = new WeakMap();
export const _mastDebug = { grid: true };      // (tests: false asks the old way, for the equivalence check)
const mgKey = (i, j) => (i + 32768) * 65536 + (j + 32768);
function mgPut(m, x0, z0, x1, z1, v) {
  for (let i = Math.floor(x0 / MAST_G), i1 = Math.floor(x1 / MAST_G); i <= i1; i++) {
    for (let j = Math.floor(z0 / MAST_G), j1 = Math.floor(z1 / MAST_G); j <= j1; j++) {
      const k = mgKey(i, j);
      const a = m.get(k);
      if (a) a.push(v); else m.set(k, [v]);
    }
  }
}
function mastGrid(cell) {
  const sig = (cell.roads?.length ?? 0) * 1e6 + (cell.rails?.length ?? 0) * 1e3 + (cell.buildings?.length ?? 0);
  let G = _mastGrids.get(cell);
  if (G && G.sig === sig) return G;
  G = { sig, roads: new Map(), rails: new Map(), houses: new Map() };
  for (const o of cell.roads ?? []) {
    if (!o.d) continue;
    const half = (o.w ?? 3) / 2 + MAST_GROW;
    if (half <= 0) continue;
    const bb = bboxOfLine(o);
    mgPut(G.roads, bb[0] - half, bb[1] - half, bb[2] + half, bb[3] + half, o);
  }
  for (const o of cell.rails ?? []) {
    if (o.t !== 'tram' || !(o.p?.length > 1)) continue;
    for (let k = 0; k < o.p.length - 1; k++) {
      const [ax, az] = o.p[k], [bx, bz] = o.p[k + 1];
      mgPut(G.rails, Math.min(ax, bx) - MAST_RAIL, Math.min(az, bz) - MAST_RAIL, Math.max(ax, bx) + MAST_RAIL, Math.max(az, bz) + MAST_RAIL, { o, k });
    }
  }
  for (const b of cell.buildings ?? []) {
    if (!b.o || b.o.length < 3) continue;
    const bb = bboxOfRing(b);
    mgPut(G.houses, bb[0], bb[1], bb[2], bb[3], b);
  }
  _mastGrids.set(cell, G);
  return G;
}
// onCarriageway(cell, null, x, z, MAST_GROW), of the roads near (x, z) only
function mastOnRoad(G, x, z) {
  for (const o of G.roads.get(mgKey(Math.floor(x / MAST_G), Math.floor(z / MAST_G))) ?? []) {
    const half = (o.w ?? 3) / 2 + MAST_GROW;
    const bb = bboxOfLine(o);
    if (x < bb[0] - half || x > bb[2] + half || z < bb[1] - half || z > bb[3] + half) continue;
    for (let k = 0; k < o.p.length - 1; k++) {
      if (distPointToSegment(x, z, o.p[k][0], o.p[k][1], o.p[k + 1][0], o.p[k + 1][1], null) < half) return true;
    }
  }
  return false;
}
function mastOnRail(G, f, x, z) {
  for (const { o, k } of G.rails.get(mgKey(Math.floor(x / MAST_G), Math.floor(z / MAST_G))) ?? []) {
    if (o === f) continue;
    if (distPointToSegment(x, z, o.p[k][0], o.p[k][1], o.p[k + 1][0], o.p[k + 1][1], null) < MAST_RAIL) return true;
  }
  return false;
}
function tramMastsInto(sink, f, fr, g, base, terrain, cell) {
  const { q, per, along, len } = fr;
  _c.setHex(0x6f7378);
  const mr = _c.r, mg = _c.g, mb = _c.b;
  const G = _mastDebug.grid ? mastGrid(cell) : null;
  const others = G ? null : (cell.rails ?? []).filter((o) => o !== f && o.t === 'tram' && o.p?.length > 1);
  const onRail = G ? (x, z) => mastOnRail(G, f, x, z) : (x, z) => others.some((o) => {
    for (let k = 0; k < o.p.length - 1; k++) {
      if (distPointToSegment(x, z, o.p[k][0], o.p[k][1], o.p[k + 1][0], o.p[k + 1][1], null) < MAST_RAIL) return true;
    }
    return false;
  });
  const onRoad = G ? (x, z) => mastOnRoad(G, x, z) : (x, z) => onCarriageway(cell, null, x, z, MAST_GROW);
  const inHouse = G ? (x, z) => lampInHouse(G.houses.get(mgKey(Math.floor(x / MAST_G), Math.floor(z / MAST_G))) ?? [], x, z)
    : (x, z) => lampInHouse(cell.buildings ?? [], x, z);
  let i = 0;
  for (let s = TRAM_MAST_STEP * 0.5 + (f._id ?? 0) % 9; s < len - 4; s += TRAM_MAST_STEP) {
    while (i < q.length - 2 && along[i + 1] < s) i++;
    const L = along[i + 1] - along[i] || 1, u = (s - along[i]) / L;
    const cx = q[i][0] + (q[i + 1][0] - q[i][0]) * u, cz = q[i][1] + (q[i + 1][1] - q[i][1]) * u;
    const wy = g[i] + (g[i + 1] - g[i]) * u + base + TRAM_WIRE_H;
    const px = per[i][0], pz = per[i][1], pl = Math.hypot(px, pz) || 1;
    const first = ((f._id ?? 0) + Math.round(s / TRAM_MAST_STEP)) & 1 ? 1 : -1;
    let mx = 0, mz = 0, ok = false;
    find: for (const off of TRAM_MAST_OFFS) {
      for (const side of [first, -first]) {
        mx = cx + px / pl * off * side; mz = cz + pz / pl * off * side;
        if (onRoad(mx, mz) || onRail(mx, mz) || inHouse(mx, mz)) continue;
        ok = true; break find;
      }
    }
    if (!ok) continue;
    const gy = Math.min(terrain.heightAt(mx, mz), g[i] + base) - 0.1, top = wy + 0.75;
    kitDrum(sink, mx, mz, gy, gy + 0.05, 0.19, 0.19, 8, mr * 0.8, mg * 0.8, mb * 0.8, 1);
    kitDrum(sink, mx, mz, gy + 0.05, top, 0.1, 0.075, 8, mr, mg, mb, 1);
    // the bracket over the track, its stay, and the dropper to the wire
    const ay = wy + 0.42, ex = cx - (mx - cx) * 0.06, ez = cz - (mz - cz) * 0.06;
    kitBar(sink, mx, ay, mz, ex, ay, ez, 0.045, mr, mg, mb);
    kitBar(sink, mx, top - 0.05, mz, mx + (ex - mx) * 0.6, ay + 0.03, mz + (ez - mz) * 0.6, 0.025, mr, mg, mb);
    kitBar(sink, cx, ay, cz, cx, wy + 0.03, cz, 0.02, mr, mg, mb);
  }
}

// ---- buildings ----

// ---- buildings ----

// The building batch's sink: a TriSink with two extra jobs.
//  · uv1, a second uv set that addresses the NIGHT texture (one texel per window
//    bay, facadeatlas.js). Every wall run names four neighbouring texels, so
//    which windows are lit is decided here, per run, by typology's hash, and
//    the near shell can ask the same hash and light the same panes.
//  · pinTo(u, v): the atlas texel every plain triangle samples from now on. A
//    roof pins to its ROOF cell (the wall shader tiles that in metres), plain
//    plaster pins to the PIN cell.
// It subclasses rather than edits TriSink because every other mesh in the
// chunk shares that class, and none of them wants either job.
class BuildingSink extends TriSink {
  constructor() {
    super(true, false);
    this.uv1 = [];
    this.pu = PIN_U; this.pv = PIN_V;
  }
  pinTo(u, v) { this.pu = u; this.pv = v; }
  tri(ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b) {
    super.tri(ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b);
    if (this.pu !== PIN_U) {
      const uv = this.uv, n = uv.length, u = this.pu, v = this.pv;
      uv[n - 6] = uv[n - 4] = uv[n - 2] = u; uv[n - 5] = uv[n - 3] = uv[n - 1] = v;
    }
    this.uv1.push(LIT_PIN, LIT_PIN, LIT_PIN, LIT_PIN, LIT_PIN, LIT_PIN);
  }
  // wallUV plus the run's lit texels: l0..l1 along the run, on texture row lv
  wallLit(ax, az, bx, bz, yB, yT, fx, fz, u0, v0, u1, v1, rB, gB, bB, rT, gT, bT, l0, l1, lv) {
    this.wallUV(ax, az, bx, bz, yB, yT, fx, fz, u0, v0, u1, v1, rB, gB, bB, rT, gT, bT);
    let la = l0, lb = l1;
    if ((bz - az) * fx - (bx - ax) * fz < 0) { la = l1; lb = l0; }   // wallUV's own flip
    this.uv1.push(la, lv, lb, lv, lb, lv, la, lv, lb, lv, la, lv);
  }
  geo() {
    const g = super.geo();
    if (g) g.setAttribute('uv1', new THREE.BufferAttribute(new Float32Array(this.uv1), 2));
    return g;
  }
}

// Facade walls are hand-built per ring edge instead of ExtrudeGeometry: an
// atlas cell cannot wrap-repeat, so each wall splits into ≤4-bay pieces per
// storey row, every piece sampling a sub-range of its variant cell. u maps
// one window per ~2.7 m (cols rounded, so windows stretch a touch to fit the
// run), v maps one cell height per storey. This is also why no UVGenerator
// post-pass on extrude uvs would do — no shader-free way to fold u back into
// a cell across a 30 m wall.
//
// Everything here is counted in BAYS from the start of the edge, and a piece's
// u is its bay PHASE inside the cell. That is the same arithmetic the near
// shell does (bay i of an edge samples column i % 4), so a window, a blank bay
// or a balcony sits on the same bay in both tiers, and so does its light.
const PLAIN_UV = [PIN_U, PIN_V, PIN_U, PIN_V];
function ringFacade(sink, ring, isHole, P, edgeBase = 0) {
  // outer walls face away from the ring interior, courtyard walls into it;
  // positive-area rings keep their interior on (−dz,dx) (see wallQuad)
  const S = (polygonArea(ring) > 0 ? 1 : -1) * (isHole ? -1 : 1);
  const aoH = Math.min(4, P.top - P.y0);
  const ao = (y) => WALL_AO + (1 - WALL_AO) * Math.min(1, Math.max(0, (y - P.y0) / aoH));
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const ex = bx - ax, ez = bz - az, L = Math.hypot(ex, ez);
    if (L < 0.02) continue;
    const fx = S * ez, fz = -S * ex;
    const cols = Math.max(1, Math.round(L / WIN_W)), bayT = 1 / cols;
    const role = isHole ? 0 : P.roles[i];
    const edge = edgeBase + i;
    // A party wall (js/partywalls.js): the blank firewall over a lower house,
    // one plain quad from foot to coping. It is built even behind a taller
    // neighbour: each house stands on its own footprint's ground, so on a
    // slope a "taller" neighbour downhill can still top out lower, and a
    // skipped wall was a see-through hole into the house (Mala Strana and
    // Hradcany, measured). Two triangles is all the cull ever saved.
    if (role === PARTY_ROLE) {
      const yT = P.top + P.parapet;
      sink.wallLit(ax, az, bx, bz, P.y0, yT, fx, fz, PIN_U, PIN_V, PIN_U, PIN_V,
        P.wr * ao(P.y0), P.wg * ao(P.y0), P.wb * ao(P.y0), P.wr, P.wg, P.wb,
        LIT_PIN, LIT_PIN, LIT_PIN);
      continue;
    }
    // v5: the street door. Its span is skipped on the ground storey and a
    // header emitted over it, so the facade grows a REAL opening at exactly
    // the place interiors.js told pieces.js to leave a gap in the lining.
    const door = (!isHole && P.door && P.door.i === i) ? P.door : null;

    // Bays [p0,p1] of the edge on storey row `s`, chunked at every fourth bay
    // so each piece samples a sub-range of one atlas cell. v0f/v1f pick how much
    // of the cell's height the band covers (a door header takes the top slice).
    // `dark` pins the night lookup to the unlit texel: trims, headers and the
    // bays the near shell builds solid have no pane to light.
    const run = (p0, p1, yB, yT, uv, v0f, v1f, s, store, dark) => {
      if (p1 - p0 < 1e-4) return;
      const v0 = uv[1] + (uv[3] - uv[1]) * v0f, v1 = uv[1] + (uv[3] - uv[1]) * v1f;
      const kB = ao(yB), kT = ao(yT);
      const lv = dark ? LIT_PIN : (litRow(P.lit, P.id, s, store) + 0.5) / LIT_N;
      // One bay of u, taken from the rect itself: a cell or a trim band is one
      // atlas column wide (1/32 a bay), but PLAIN_UV is a single pinned texel
      // with no width. A constant step walked that pin out of the plaster cell
      // into the roof tile column next door, and the shader tiled the wall.
      const du = (uv[2] - uv[0]) / BAYS;
      let a = p0;
      while (a < p1 - 1e-6) {
        const k = Math.floor(a / BAYS + 1e-9), b = Math.min(p1, (k + 1) * BAYS);
        const ph = a - k * BAYS;
        const l0 = dark ? LIT_PIN : (litStart(P.id, s, edge, k) + ph) / LIT_N;
        sink.wallLit(ax + ex * a * bayT, az + ez * a * bayT, ax + ex * b * bayT, az + ez * b * bayT,
          yB, yT, fx, fz, uv[0] + ph * du, v0, uv[0] + (ph + b - a) * du, v1,
          P.wr * kB, P.wg * kB, P.wb * kB, P.wr * kT, P.wg * kT, P.wb * kT,
          l0, dark ? LIT_PIN : l0 + (b - a) / LIT_N, lv);
        a = b;
      }
    };

    for (let s = 0; s < P.storeys; s++) {
      const yB = P.y0 + s * P.sH, yT = yB + P.sH;
      const row = rowFor(P.rows, s, P.storeys, role);
      const dk = !!row.plain;                     // a stub wall has no window to light
      const ent = s === 0 && !isHole && P.ent && P.ent.i === i ? P.ent : null;
      if (!ent) { run(0, cols, yB, yT, row.uv, 0, 1, s, row.store, dk); continue; }
      // the doorway, in bays. The near shell turns every bay the opening touches
      // into a solid lintel with no pane, so those bays carry no light here.
      const c = ent.t * cols, hw = ent.w / 2 / L * cols;
      const d0 = Math.max(0, c - hw), d1 = Math.min(cols, c + hw);
      const z0 = Math.min(d0, Math.max(0, Math.floor(c - hw - 1 + 1e-9) + 1));
      const z1 = Math.max(d1, Math.min(cols, Math.ceil(c + hw - 1e-9)));
      const cutDoor = door && P.sH > INTERIOR.entryH + 0.35;
      if (!cutDoor) {
        run(0, z0, yB, yT, row.uv, 0, 1, s, row.store, dk);
        run(z0, z1, yB, yT, row.uv, 0, 1, s, row.store, true);
        run(z1, cols, yB, yT, row.uv, 0, 1, s, row.store, dk);
        continue;
      }
      run(0, z0, yB, yT, row.uv, 0, 1, s, row.store, dk);
      run(z0, d0, yB, yT, row.uv, 0, 1, s, row.store, true);
      run(d0, d1, yB + INTERIOR.entryH, yT, row.uv, INTERIOR.entryH / P.sH, 1, s, row.store, true);
      run(d1, z1, yB, yT, row.uv, 0, 1, s, row.store, true);
      run(z1, cols, yB, yT, row.uv, 0, 1, s, row.store, dk);
    }
    // Above the storey grid: plain wall up to the roof build-up, then the trim
    // band (cornice, coping or eave shadow), carried on up as the outer face of
    // the parapet where the roof has one.
    const fB = Math.max(P.gridTop, P.top - 0.5), fT = P.top + P.parapet;
    if (fB - P.gridTop > 0.04) run(0, cols, P.gridTop, fB, PLAIN_UV, 0, 1, 0, false, true);
    if (fT - fB > 0.04) run(0, cols, fB, fT, P.trimUV, 0, 1, 0, false, true);
  }
}

// The doorway behind the hole. Three things, all cheap, and the third is the
// one that matters: jambs and a soffit turn the opening into a REVEAL (a flat
// hole in a flat wall reads as a texture error), and a dark leaf set back at
// the interior's own wall depth stops you seeing clean through the building
// when its interior has not been streamed in yet. The leaf faces outward only,
// so from inside it is back-face culled and the doorway is simply open — and
// once a missile promotes the building to boxes, the whole chunk mesh stops
// drawing it and the opening becomes a real hole in real geometry.
const DOOR_DEPTH = INTERIOR.extT + INTERIOR.linT;   // = the interior wall face
// A doorway you cannot find is a doorway that does not exist, and the first
// version's was a dark rectangle in a dark reveal — technically there, visually
// absent from ten metres. So the opening now gets the three things that make a
// real Czech street door readable at a glance: a light SURROUND standing proud
// of the plaster, a CANOPY over the pavement, and a lit SIGN board on its face.
// The surround and canopy go into the facade mesh; the sign board goes into its
// own emissive batch, so it glows at dusk exactly like the street lamps.
const CANOPY_D = 1.15, CANOPY_T = 0.2, SURROUND = 0.26;
function doorInto(sink, trim, sign, ring, P) {
  const d = P.door;
  const [ax, az] = ring[d.i], [bx, bz] = ring[(d.i + 1) % ring.length];
  const ex = bx - ax, ez = bz - az, L = Math.hypot(ex, ez);
  if (L < 0.05) return;
  const ux = ex / L, uz = ez / L;
  const inx = -d.nx, inz = -d.nz;                    // into the building
  const c = L * d.t, hw = Math.min(d.w, L * 0.9) / 2;
  const yB = P.y0 + 0.02, yT = P.y0 + Math.min(INTERIOR.entryH, P.sH - 0.3);
  const jr = P.wr * 0.42, jg = P.wg * 0.42, jb = P.wb * 0.42;   // shaded reveal
  const at = (s, o) => [ax + ux * s + d.nx * (o ?? 0), az + uz * s + d.nz * (o ?? 0)];

  for (const sgn of [-1, 1]) {
    const px = ax + ux * (c + sgn * hw), pz = az + uz * (c + sgn * hw);
    // the jamb faces the middle of the opening
    wallQuad(sink, px, pz, px + inx * DOOR_DEPTH, pz + inz * DOOR_DEPTH,
      yT, yB, -sgn * ux, -sgn * uz, jr, jg, jb);
  }
  const A = at(c - hw), B = at(c + hw);
  sink.triFacing(A[0], yT, A[1], B[0], yT, B[1],
    B[0] + inx * DOOR_DEPTH, yT, B[1] + inz * DOOR_DEPTH, 0, -1, 0, jr, jg, jb);
  sink.triFacing(A[0], yT, A[1], B[0] + inx * DOOR_DEPTH, yT, B[1] + inz * DOOR_DEPTH,
    A[0] + inx * DOOR_DEPTH, yT, A[1] + inz * DOOR_DEPTH, 0, -1, 0, jr, jg, jb);
  // the leaf: dark, single-sided, standing where the interior wall's inner
  // face is, so stepping through it is stepping through the wall plane
  wallQuad(sink, A[0] + inx * DOOR_DEPTH, A[1] + inz * DOOR_DEPTH,
    B[0] + inx * DOOR_DEPTH, B[1] + inz * DOOR_DEPTH, yT, yB, d.nx, d.nz,
    P.wr * 0.16, P.wg * 0.15, P.wb * 0.14);

  if (!trim) return;
  // ---- the surround: a pale frame 6 cm proud of the wall ----
  const fr = 0.93, fg = 0.92, fb = 0.88;
  const O = 0.06;                                  // how far it stands out
  const box = (s0, s1, y0, y1) => {
    const p0 = at(s0), p1 = at(s1), q0 = at(s0, O), q1 = at(s1, O);
    // face, two returns and a top/bottom — a slab, cheaply
    trim.quad(q0[0], y1, q0[1], q1[0], y1, q1[1], q1[0], y0, q1[1], q0[0], y0, q0[1], fr, fg, fb);
    trim.quad(p0[0], y1, p0[1], q0[0], y1, q0[1], q0[0], y0, q0[1], p0[0], y0, p0[1], fr, fg, fb);
    trim.quad(q1[0], y1, q1[1], p1[0], y1, p1[1], p1[0], y0, p1[1], q1[0], y0, q1[1], fr, fg, fb);
  };
  box(c - hw - SURROUND, c - hw, yB, yT + SURROUND);
  box(c + hw, c + hw + SURROUND, yB, yT + SURROUND);
  box(c - hw - SURROUND, c + hw + SURROUND, yT, yT + SURROUND);

  // ---- the canopy: a slab over the pavement, and its underside ----
  const cy = yT + SURROUND + 0.16;
  if (cy + CANOPY_T < P.y0 + P.sH - 0.15) {
    const w0 = c - hw - SURROUND - 0.2, w1 = c + hw + SURROUND + 0.2;
    const p0 = at(w0), p1 = at(w1);
    const o0 = at(w0, CANOPY_D), o1 = at(w1, CANOPY_D);
    const cr = fr * 0.8, cg = fg * 0.8, cb = fb * 0.8;
    // top, front edge, and the underside (which is what you see from below)
    trim.triFacing(p0[0], cy + CANOPY_T, p0[1], p1[0], cy + CANOPY_T, p1[1],
      o1[0], cy + CANOPY_T, o1[1], 0, 1, 0, cr, cg, cb);
    trim.triFacing(p0[0], cy + CANOPY_T, p0[1], o1[0], cy + CANOPY_T, o1[1],
      o0[0], cy + CANOPY_T, o0[1], 0, 1, 0, cr, cg, cb);
    trim.triFacing(p0[0], cy, p0[1], p1[0], cy, p1[1], o1[0], cy, o1[1],
      0, -1, 0, cr * 0.7, cg * 0.7, cb * 0.7);
    trim.triFacing(p0[0], cy, p0[1], o1[0], cy, o1[1], o0[0], cy, o0[1],
      0, -1, 0, cr * 0.7, cg * 0.7, cb * 0.7);
    trim.quad(o0[0], cy + CANOPY_T, o0[1], o1[0], cy + CANOPY_T, o1[1],
      o1[0], cy, o1[1], o0[0], cy, o0[1], cr, cg, cb);
    // ---- the sign board, on the canopy's front edge, lit ----
    if (sign) {
      const s0 = at(w0 + 0.15, CANOPY_D + 0.03), s1 = at(w1 - 0.15, CANOPY_D + 0.03);
      const [sr, sg, sb] = P.signRGB ?? [1, 0.86, 0.62];
      sign.quad(s0[0], cy + CANOPY_T - 0.03, s0[1], s1[0], cy + CANOPY_T - 0.03, s1[1],
        s1[0], cy + 0.03, s1[1], s0[0], cy + 0.03, s0[1], sr, sg, sb);
    }
  }
}

// flat cap via earcut straight into the sink — keeps every facade-mode
// triangle in one uv-bearing stream and supplies the down-facing skyway
// underside ExtrudeGeometry used to give us. sink.tri()'s ny = −cross2D, so
// order per triangle to match the requested face direction.
function capInto(sink, outer, holes, y, up, r, g, b) {
  const pts = outer.map(([x, z]) => new THREE.Vector2(x, z));
  const hpts = (holes ?? []).filter((h) => h.length >= 3)
    .map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
  let tris;
  try { tris = THREE.ShapeUtils.triangulateShape(pts, hpts); } catch { return; }
  const all = pts.concat(...hpts);
  for (const [ia, ib, ic] of tris) {
    const pa = all[ia], pb = all[ib], pc = all[ic]; // p-prefixed: r/g/b already name the color
    const cross = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y);
    if (up === cross > 0) sink.tri(pa.x, y, pa.y, pc.x, y, pc.y, pb.x, y, pb.y, r, g, b);
    else sink.tri(pa.x, y, pa.y, pb.x, y, pb.y, pc.x, y, pc.y, r, g, b);
  }
}

// The one true wall colour of a building — explicit OSM colour if it has one,
// else the palette for its type; unnamed stock gets a light tint jitter so
// shared footprints don't read as copy-paste, while NAMED landmarks keep the
// pure palette hue so they pop.
//
// EXPORTED and cached on the feature because pieces.js needs the same answer.
// When a rocket promotes a building from this facade mesh to its own box model,
// the boxes must come out the colour the facade already was — otherwise the
// building visibly changes identity at the instant you hit it, which reads as a
// bug rather than as damage.
export function buildingWallHex(f) {
  if (f._wallHex !== undefined) return f._wallHex;
  // a chain paints its own boxes: a Kaufland is not "commercial beige"
  const brand = brandOf(f);
  if (brand?.wall !== undefined) return (f._wallHex = brand.wall);
  // The plaster comes from what the building is BUILT like (a pastel panelak,
  // an ochre tenement, a silver hall), not from its OSM tag, which for a third
  // of the country is just "residential". classify() runs first on purpose: it
  // may stamp f.c (novostavby, offices), and an explicit colour always wins.
  const typ = typologyOf(f, classify(f));
  const pal = TYPO_WALLS[typ] ?? BUILDING_PALETTES[f.t] ?? BUILDING_PALETTES.default;
  // ...then what the wall is MADE of where a mapper wrote it down (the tile's
  // `bm`: brick, concrete, glass, wood, stone, metal), and only then the palette.
  // In Prague the old houses wear Prague's pastels (praguezone.js), and keep
  // their saturation: the jitter's greying is what made the city read beige.
  const prague = !f.c && praguePlaster(typ, !!f.r && f.r !== 'flat') && praguePlace(f);
  const pal2 = prague ? PRAGUE_WALLS : pal;
  // (the sections of one panel slab share one colour: js/partywalls.js names
  // the slab, and its name is what the pick and the jitter are hashed from)
  const cid = typ === 'panel' && f._slab ? f._slab : f._id;
  const hex = f.c ? parseInt(f.c.slice(1), 16)
    : wallTone(f, rnd(cid, 0)) ?? pal2[Math.floor(rnd(cid, 0) * pal2.length)];
  _c.setHex(hex);
  if (!f.n) _c.offsetHSL((rnd(cid, 1) - 0.5) * 0.02, prague ? 0 : -0.06 * rnd(cid, 2),
    (rnd(cid, 3) - 0.5) * 0.07);
  return (f._wallHex = _c.getHex());
}

// Which atlas cells this building's facade is painted from, and the bay pitch.
// EXPORTED because the destructible shell has to sample the SAME cells: that is
// the only way a building can stop being a textured quad and start being a pile
// of boxes without visibly changing. See pieces.js emitPerimeter('ext').
//
// The rule itself is typology.facadeRows: one full hash of the id into the
// typology's own family of cells, with separate ground, top, gable and
// shopfront rows. This function only turns its cell indices into uv rectangles
// and hangs the textures on. `mats` false skips the textures (a mesh worker
// has no canvas to paint them on and never reads them).
const _rowUV = (r) => { if (r) r.uv = cellRect(r.cell[0], r.cell[1]); return r; };
export function facadeRows_(f, use) {
  const office = use === 'office' ? (rnd(f._id, 80) < 0.5 ? 'bands' : 'grid') : null;
  const rows = facadeRows(f, use, office);
  for (const k of ['mid', 'ground', 'top', 'gable', 'door', 'store']) _rowUV(rows[k]);
  return rows;
}
export function facadeCells(f) {
  const use = classify(f);
  const rows = facadeRows_(f, use);
  return {
    rows,
    lit: litOf(f, rows.typ),
    trimUV: trimRect(rows.trim),
    // the old two-cell contract, kept for anything that still reads it
    cellA: rows.mid.uv, storeC: rows.store?.uv ?? null,
    bayW: WIN_W, bays: BAYS, atlasN: ATLAS_N,
    band: rows.mid.band ?? [0.29, 0.74], frac: rows.mid.frac || 0.54,
    pin: [PIN_U, PIN_V],
    atlas: facadeAtlas(),
    // the shared wall material: a shell's pitched roof wears it, so the tiles
    // the far mesh showed are still there when the building turns to boxes
    roofMat: buildFacadeMaterial(),
  };
}

// ---- brand signage, far tier ---------------------------------------------
// The chunk-mesh twin of pieces.js brandSigns(). The near LOD builds a chain's
// fascia and totem out of boxes on the destructible shell; this is the SAME
// geometry for the merged far mesh, and the numbers are copied digit for digit
// — fascia H = 0.22·height clamped 0.7–1.6 m, hung 0.4 m below the parapet on
// the two LONGEST edges (a supermarket signs its front and its flank, never
// its bin store), run inset 6 % from each corner, front face 0.24 m proud
// (the near box: centre +0.12, half-depth 0.12); totem 5.5 m out from the
// entrance, 4.6 × 2.6 m panel centred at max(y0+5.4, top+1.5) on a 0.44 m
// steel pole. pieces.js is a pure-data module the headless tests import, so
// the agreement is a contract like WIN_BAND, not a shared function: change
// one side and every Kaufland morphs the instant its near-LOD boxes take over.
//
// On top of the flat colour the far tier adds the one thing boxes cannot do:
// WORDMARK quads (brandMarkMat below) centred on each fascia run and on the
// totem face, so the chain is legible from 300 m, long before the facade
// atlas resolves. They vanish into plain brand colour at the LOD swap — by
// which point you are standing at the door and the building says its name
// on the canopy sign anyway.

// One 1024×256 CanvasTexture + full-bright material per chain, module-cached
// (chunk unload disposes geometries only, so these live for the session and
// every chunk shares them — a cell with three brands costs three draw calls).
// The key both sides of a worker build agree to call this material. The chunk
// mesher may run where there is no <canvas>, so the wordmark material cannot be
// built there — the geometry goes out naming its chain and the main thread
// resolves the name against this cache (geomcodec's `mats.codecMats`).
export const brandMatKey = (brand) => 'brand:' + (brand.label ?? 'Obchod');

// Since the batch package the label is a slot of a shared page instead
// (js/wordmarkatlas.js), and a chunk's quads draw as one mesh. The canvas of
// its own below is the fallback: the pages are full, there is no 2D context,
// or the A/B flag says so (`__batch.marks = false`, js/batchflags.js).
const _brandMats = new Map();
export function brandMarkMat(brand) {
  const label = brand.label ?? 'Obchod';
  let m = _brandMats.get(label);
  // a build is about to wear it, and may not land before the next sweep (a
  // paused synchronous build): an atlas slot freed under it would come back
  // with another chain's name, where a freed canvas only uploaded again
  if (m) { m.userData.idle = 0; return m; }
  m = BATCH.marks ? atlasMark(brand, label) : null;
  if (m) { _brandMats.set(label, m); return m; }
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 256;
  const g = cv.getContext('2d');
  // null context under memory pressure → unpainted canvas → solid black quad;
  // fall back to flat brand colour rather than upload the void
  if (!g) {
    m = new THREE.MeshBasicMaterial({ color: brand.sign & 0xffffff, toneMapped: false });
    _brandMats.set(label, m);
    return m;
  }
  // the panel itself (fascia colour, ink rule, the type fitted to 920 px)
  // is js/wordmarkatlas.js paintMark, the one the atlas slots are painted by
  paintMark(g, brand, label);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;                  // fascias are read at grazing angles
  m = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  _brandMats.set(label, m);
  return m;
}

/**
 * Give back the brand wordmarks no built chunk draws any more: the far-tier
 * twin of destructible.sweepWordmarks, same two-sweep rule. Returns the
 * materials it freed, so the streamer can forget them in `mats.codecMats`
 * (a worker chunk names its brands and the name is resolved again on arrival).
 */
export function sweepBrandMats(inUse) {
  let gone = null;
  for (const [label, m] of _brandMats) {
    if (inUse.has(m)) { m.userData.idle = 0; continue; }
    if ((m.userData.idle = (m.userData.idle ?? 0) + 1) < 2) continue;
    // an atlas label gives its slot back to the page (and frees only its
    // windowed clone of the page texture); a canvas of its own goes whole
    if (!releaseMark(m)) { m.map?.dispose(); m.dispose(); }
    _brandMats.delete(label);
    (gone ??= []).push(m);
  }
  return gone;
}
/** How many brand wordmarks are cached (diagnostics). */
export const brandMatCount = () => _brandMats.size;

// per-chunk wordmark quad stream, one per brand so the chunk batches per label
function markStream(marks, brand) {
  const label = brand.label ?? 'Obchod';
  let mk = marks.get(label);
  if (!mk) marks.set(label, mk = { brand, pos: [], uv: [] });
  return mk;
}

// A textured vertical quad a→b facing (fx,fz), full 0..1 uv window. Mind the
// u DIRECTION: for the winding whose derived normal is (dz,−dx), the viewer's
// screen-right is up × n = −(a→b), so u must DESCEND along the run or every
// wordmark comes out mirrored (the window atlas gets away with this in
// wallUV because windows are symmetric; text is not).
function markWall(mk, ax, az, bx, bz, yB, yT, fx, fz) {
  const dx = bx - ax, dz = bz - az;
  let Ax = ax, Az = az, Bx = bx, Bz = bz;
  if (dz * fx - dx * fz < 0) { Ax = bx; Az = bz; Bx = ax; Bz = az; }
  mk.pos.push(Ax, yT, Az, Bx, yT, Bz, Bx, yB, Bz, Ax, yT, Az, Bx, yB, Bz, Ax, yB, Az);
  mk.uv.push(1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0);
}

// OBB centre by interiors.frameOf's own rule (axis = longest edge) — the totem
// skip test below must agree with the near model's `fr.cx/cz` or the two LODs
// could disagree about whether a degenerate totem exists at all.
const _ct = { x: 0, z: 0 };
function obbCentre(ring, out) {
  let best = 0, ux = 1, uz = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    if (L2 > best) { best = L2; const L = Math.sqrt(L2); ux = dx / L; uz = dz / L; }
  }
  const vx = uz, vz = -ux;
  let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
  for (const [x, z] of ring) {
    const pu = x * ux + z * uz, pv = x * vx + z * vz;
    if (pu < u0) u0 = pu; if (pu > u1) u1 = pu;
    if (pv < v0) v0 = pv; if (pv > v1) v1 = pv;
  }
  out.x = ux * (u0 + u1) / 2 + vx * (v0 + v1) / 2;
  out.z = uz * (u0 + u1) / 2 + vz * (v0 + v1) / 2;
}

function brandSignage(f, y0, top, brand, cell, trim, sign, marks, sH = 0, over = false, totem = true) {
  const ring = f.o;
  _c.setHex(brand.sign);
  const sr = _c.r, sg = _c.g, sb = _c.b;
  const sgn = polygonArea(ring) > 0 ? 1 : -1;
  const mk = markStream(marks, brand);

  // ---- fascia band: the ENTRANCE edge first, then the longest flank ----
  // The sign belongs over the doors, facing the car park — two-longest alone
  // put both bands on the service side of a deep box. Same rule as the near
  // LOD in pieces.js brandSigns; change one, change both.
  // RESOLVED here, not read off `f._ent`: on a fresh feature that cache is
  // still empty at this point, so the first build would pick different edges
  // than a rebuild — or than a worker handed the cache in its spec.
  const ent = entranceOf(f, cell?.roads, cell?.buildings);
  const edges = [];
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    edges.push({ i, L: Math.hypot(bx - ax, bz - az) });
  }
  edges.sort((a, b) => b.L - a.L);
  const entI = ent?.i;
  if (entI !== undefined) {
    const k = edges.findIndex((e) => e.i === entI);
    if (k > 0 && edges[k].L >= 8) edges.unshift(edges.splice(k, 1)[0]);
  }
  // Under the parapet on a shed; over the ground floor when the shop is only
  // the bottom of a taller building (typology.signBand, shared with pieces.js).
  const { H, yT, yB } = signBand(y0, top, sH, over);
  for (const e of edges.slice(0, over ? 1 : 2)) {
    if (e.L < 8) continue;
    const [ax, az] = ring[e.i], [bx, bz] = ring[(e.i + 1) % ring.length];
    const ux = (bx - ax) / e.L, uz = (bz - az) / e.L;
    const nx = sgn * uz, nz = -sgn * ux;   // outward, entranceOf's convention
    const at = (s, o) => [ax + ux * s + nx * o, az + uz * s + nz * o];
    const F0 = at(e.L * 0.06, 0.24), F1 = at(e.L * 0.94, 0.24);
    const K0 = at(e.L * 0.06, 0.02), K1 = at(e.L * 0.94, 0.02);
    wallQuad(sign, F0[0], F0[1], F1[0], F1[1], yT, yB, nx, nz, sr, sg, sb);
    wallQuad(sign, K0[0], K0[1], K1[0], K1[1], yT, yB, -nx, -nz, sr * 0.5, sg * 0.5, sb * 0.5);
    // a lid, so the band reads as the near model's solid box from a helicopter
    sign.triFacing(K0[0], yT, K0[1], K1[0], yT, K1[1], F1[0], yT, F1[1], 0, 1, 0, sr, sg, sb);
    sign.triFacing(K0[0], yT, K0[1], F1[0], yT, F1[1], F0[0], yT, F0[1], 0, 1, 0, sr, sg, sb);
    // the wordmark, ONCE, centred: a Czech retail shed signs its frontage with
    // one logo, not a repeating banner. Aspect-true (canvas is 4:1), a whisker
    // inside the band and 1 cm proud of its face.
    const hm = H * 0.94, wm = hm * 4;
    if (e.L * 0.88 > wm + 1) {
      const W0 = at(e.L / 2 - wm / 2, 0.25), W1 = at(e.L / 2 + wm / 2, 0.25);
      const mid = (yB + yT) / 2;
      markWall(mk, W0[0], W0[1], W1[0], W1[1], mid - hm / 2, mid + hm / 2, nx, nz);
    }
  }

  // ---- the totem by the entrance ----
  // A pylon is what a chain or a supermarket plants by its car park. A corner
  // shop has a fascia and nothing else: giving every named boutique one stood a
  // row of 5 m poles down the middle of Pernštýnská.
  if (!ent || over || !totem) return;
  const px = ent.x + ent.nx * 5.5, pz = ent.z + ent.nz * 5.5;
  obbCentre(ring, _ct);
  if (Math.hypot(px - _ct.x, pz - _ct.z) < 2) return;   // stands inside the shed
  const yaw = Math.atan2(ent.nz, -ent.nx) + Math.PI / 2; // face the street
  const aX = Math.cos(yaw), aZ = -Math.sin(yaw);         // panel's long axis
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);        // panel's face normal
  const P4 = (da, df) => [px + aX * da + fx * df, pz + aZ * da + fz * df];
  const PW = 2.3, PH = 2.6;
  const panelY = Math.max(y0 + 5.4, top + 1.5);
  const pT = panelY + PH / 2, pB = panelY - PH / 2;
  // the pole wears the near model's own dark steel, and it is LIT (the near
  // piece is kind 'ext'), so it goes into the trim batch, not the sign one
  _c.setHex(0x4a4d52);
  const pr = _c.r, pg = _c.g, pbl = _c.b;
  const c00 = P4(-0.22, -0.22), c10 = P4(0.22, -0.22);
  const c11 = P4(0.22, 0.22), c01 = P4(-0.22, 0.22);
  wallQuad(trim, c01[0], c01[1], c11[0], c11[1], pB, y0, fx, fz, pr, pg, pbl);
  wallQuad(trim, c00[0], c00[1], c10[0], c10[1], pB, y0, -fx, -fz, pr, pg, pbl);
  wallQuad(trim, c10[0], c10[1], c11[0], c11[1], pB, y0, aX, aZ, pr, pg, pbl);
  wallQuad(trim, c00[0], c00[1], c01[0], c01[1], pB, y0, -aX, -aZ, pr, pg, pbl);
  // the panel: brand colour on every face, backlit-bright like the fascia
  const e0 = P4(-PW, -0.16), e1 = P4(PW, -0.16), e2 = P4(PW, 0.16), e3 = P4(-PW, 0.16);
  wallQuad(sign, e3[0], e3[1], e2[0], e2[1], pT, pB, fx, fz, sr, sg, sb);
  wallQuad(sign, e0[0], e0[1], e1[0], e1[1], pT, pB, -fx, -fz, sr, sg, sb);
  wallQuad(sign, e1[0], e1[1], e2[0], e2[1], pT, pB, aX, aZ, sr, sg, sb);
  wallQuad(sign, e0[0], e0[1], e3[0], e3[1], pT, pB, -aX, -aZ, sr, sg, sb);
  sign.triFacing(e0[0], pT, e0[1], e1[0], pT, e1[1], e2[0], pT, e2[1], 0, 1, 0, sr, sg, sb);
  sign.triFacing(e0[0], pT, e0[1], e2[0], pT, e2[1], e3[0], pT, e3[1], 0, 1, 0, sr, sg, sb);
  // the wordmark strip across the face — one-sided at +0.18, matching the near
  // model's glyphs, which stand only on the street side of the panel
  const hm = 4.3 / 4;                                    // aspect-true on 4.3 m
  const W0 = P4(-2.15, 0.18), W1 = P4(2.15, 0.18);
  markWall(mk, W0[0], W0[1], W1[0], W1[1], panelY - hm / 2, panelY + hm / 2, fx, fz);
}

// The ear clipper roofs.js needs for a courtyard roof's top (it is three-free
// and cannot cut a polygon with holes itself). Index triples into
// outer.concat(...holes), the convention THREE.ShapeUtils already uses.
const _v2 = (r) => r.map(([x, z]) => new THREE.Vector2(x, z));
const roofTri = (outer, holes) => THREE.ShapeUtils.triangulateShape(_v2(outer), holes.map(_v2));
const ROOF_FULL = { tri: roofTri }, ROOF_BARE = { bare: true, tri: roofTri };

function buildingInto(f, geos, sink, facades, cell, trim, sign, marks, terrain, lite = false) {
  if (!f.o || f.o.length < 3) return;
  // WHERE THE BUILDING STANDS. On flat ground this was zero and there was
  // nothing to decide. On a slope there is: found it at the LOWEST ground under
  // its footprint and it floats at the high corner; found it at the highest and
  // it is buried at the low one. Real buildings are cut into the slope, so the
  // floor goes near the low end — but not AT it, or every house on a hillside
  // grows a plinth. The low point plus a fifth of the fall is what stops both
  // failure modes, and the footing below fills whatever gap is left.
  const ground = terrain ? groundFor(f, terrain) : 0;
  const fall = terrain ? fallFor(f) : 0;
  const y0 = ground + (f.y ?? 0);
  // `f.y` (a skyway's underside) stays RELATIVE to its own ground, and the
  // height stays the height — a five-storey house is five storeys whether it
  // stands in Polabí or on Petřín.
  const depth = Math.max(1, Math.max(2.2, f.h ?? 6) - (f.y ?? 0));
  // …and the footing: a skirt from the floor down past the lowest corner, so a
  // building cut into a hillside meets the ground instead of hovering over it.
  // Only where there is a real drop — on flat ground it is not built at all.
  // (never under a lifted footprint, a skyway or a forecourt canopy: its
  // underside is open, and the skirt hung a wall down into the lanes below)
  const footing = fall > 0.35 && !((f.y ?? 0) > 0.5) ? Math.min(fall + 0.6, 14) : 0;
  // The name and the trade both ride on the feature straight out of the tile
  // (scripts/lib/venues.mjs hangs OSM's named shop/eatery nodes onto the
  // footprint they stand in), so a McDonald's is branded on its very first
  // mesh with nothing to re-decide later. signBrandOf falls back to a plain
  // Czech fascia (OBCHOD / POTRAVINY, or the shop's own OSM name) so that
  // retail OSM genuinely left unnamed is not the only thing on the street with
  // nothing written on it.
  const use = classify(f);
  const brand = signBrandOf(f, use);
  _c.setHex(buildingWallHex(f));
  const wr = _c.r, wg = _c.g, wb = _c.b;
  // What it is BUILT like decides the roof: clay or concrete tile on a pitched
  // house, felt or gravel on a flat block, each in its own colour off a Czech
  // palette (typology.roofOf). It used to be the wall colour times 0.62, which
  // is how a town of pale plaster came out with a town of grey-beige roofs.
  const typ = typologyOf(f, use), roof = roofOf(f, typ);
  const [rr, rg, rb] = linRGB(roof.hex);
  // …and the storey grid is interiors.storeyPlan, the same one the near shell
  // stands its boxes on, so a window is at the same height in both tiers.
  const sp = storeyPlan(f, use);
  const top = y0 + depth;
  const area = Math.abs(polygonArea(f.o));
  const parapet = facades && hasParapet(typ, roof, area) ? PARAPET_H : 0;

  if (facades) {
    const rows = facadeRows_(f, use);
    const sH = Math.min(sp.sH, depth / sp.storeys);
    // The street entrance: which edge wears the shopfront or the garage doors,
    // and which bays the near shell will turn into its doorway (they carry no
    // window light here either). Same guard as interiors.hasInterior, because
    // only a building that can have a shell has a doorway to agree with.
    const ent = (f.y ?? 0) < 0.5 && area >= 14
      ? entranceOf(f, cell?.roads, cell?.buildings) : null;
    const P = {
      y0, top, sH, storeys: sp.storeys, gridTop: y0 + sH * sp.storeys, wr, wg, wb,
      rows, id: f._id, lit: litOf(f, typ), trimUV: trimRect(rows.trim), parapet, ent,
      // v5: every building that has an inside gets a front door in its facade.
      // entranceOf caches its answer on the feature, so the hole never moves
      // between rebuilds and always matches the gap pieces.js leaves in the
      // interior lining.
      // (NOTE: `y0 < 0.5` has been false on every real building since the
      // terrain arrived, y0 being metres above sea level, so the far mesh cuts
      // no doors today. Left exactly as found: the near shell has no canopy or
      // sign board to match, so switching it back on would add a tier pop.)
      door: y0 < 0.5 && ent ? ent : null,
    };
    // shopfront, blank gable or garage doors, per edge
    P.roles = edgeRoles(f.o, rows, ent?.i);
    // a chain's fascia colour rides on the plan, so the canopy sign comes out
    // Kaufland red / Lidl blue rather than generic amber
    if (brand?.sign !== undefined) {
      _c.setHex(brand.sign);
      P.signRGB = [_c.r, _c.g, _c.b];
    }
    ringFacade(sink, f.o, false, P);
    if (P.door && P.sH > INTERIOR.entryH + 0.35) doorInto(sink, trim, sign, f.o, P);
    const holes = f.i ?? [];
    for (let k = 0; k < holes.length; k++)
      if (holes[k].length >= 3) ringFacade(sink, holes[k], true, P, 1000 * (k + 1));
    // skyway underside — tested against the building's own offset now that y0
    // carries the ground height, or every house on a hill would grow a lid
    if ((f.y ?? 0) > 0.5) capInto(sink, f.o, f.i, y0, false, wr * 0.5, wg * 0.5, wb * 0.5);
  } else {
    // v1 flat-color path: one extrude, painted vertices, no uv anywhere
    const g = new THREE.ExtrudeGeometry(ringShape(f.o, f.i), { depth, bevelEnabled: false, steps: 1 });
    g.rotateX(-Math.PI / 2);
    if (y0) g.translate(0, y0, 0);
    g.deleteAttribute('uv');
    const pos = g.attributes.position, nrm = g.attributes.normal, n = pos.count;
    const aoH = Math.min(4, depth);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      if (Math.abs(nrm.getY(i)) > 0.6) {          // roof (and unseen floor) cap
        col[i * 3] = rr; col[i * 3 + 1] = rg; col[i * 3 + 2] = rb;
      } else {                                    // wall, darkened toward the ground edge
        const t = Math.min(1, Math.max(0, (pos.getY(i) - y0) / aoH));
        const k = WALL_AO + (1 - WALL_AO) * t;
        col[i * 3] = wr * k; col[i * 3 + 1] = wg * k; col[i * 3 + 2] = wb * k;
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geos.push(g);
  }
  // chain signage in BOTH wall modes — a Lidl is a Lidl with facades toggled
  // off, and the fascia/totem must match pieces.js regardless of the atlas
  if (brand?.sign !== undefined && sign && trim && marks)
    brandSignage(f, y0, top, brand, cell, trim, sign, marks,
      Math.min(sp.sH, depth / sp.storeys), signOverGround(use, sp.storeys),
      !!brandOf(f) || use === 'supermarket' || use === 'mall');
  // The footing. A plain skirt in the wall colour, darkened, from the floor
  // down past the lowest ground the footprint touches — what a real building
  // shows as a plinth where the pavement falls away from it.
  if (footing > 0) {
    const fr2 = wr * 0.72, fg2 = wg * 0.72, fb2 = wb * 0.72;
    const n = f.o.length;
    const sgn = polygonArea(f.o) > 0 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const [ax, az] = f.o[i], [bx, bz] = f.o[(i + 1) % n];
      const ex = bx - ax, ez = bz - az;
      const L = Math.hypot(ex, ez);
      if (L < 1e-6) continue;
      const ox = ez / L * sgn, oz = -ex / L * sgn;      // outward horizontal
      sink.quad(ax, y0, az, bx, y0, bz, bx, y0 - footing, bz, ax, y0 - footing, az,
        fr2, fg2, fb2);
      // …and the same wall facing the other way, because a plinth seen from
      // below the slope is looked at from outside, from above from inside
      sink.quad(ax, y0 - footing, az, bx, y0 - footing, bz, bx, y0, bz, ax, y0, az,
        fr2, fg2, fb2);
    }
  }

  // The roof (roofs.js): a ridge with eaves and plaster gables over anything
  // like a rectangle, an inward-offset cap that follows an L or a courtyard
  // block, and the furniture standing on it. The same call builds the near
  // shell's roof (roofGeometry below), so the two tiers cannot disagree.
  const covered = roofInto(sink, f, typ, roof, top, [wr, wg, wb], sp.storeys,
    lite ? ROOF_BARE : ROOF_FULL);
  if (facades) {
    // the deck: only where no pitched roof covers it (a ridge closes its own
    // ends, so the cap underneath was 120 000 triangles a tile nobody could see)
    if (!covered) {
      sink.pinTo(...roofPin(roof.style));
      capInto(sink, f.o, f.i, top, true, rr, rg, rb);
      sink.pinTo(PIN_U, PIN_V);
    }
    if (parapet) parapetInto(sink, f.o, top, parapet, 0.3, [wr, wg, wb]);
  }
}

/**
 * The roof of ONE building as a standalone geometry, in world space: the same
 * roofInto() the chunk mesh runs, pitched shape, eaves, chimneys, lift houses
 * and all.
 *
 * It exists because interiorsim REPLACES a nearby building with its box shell,
 * and the shell's roof was a flat slab with a parapet. So every building you
 * actually walked up to lost its roof and became an office block, however
 * carefully the chunk mesh had built one 450 m further away. The model owns
 * this geometry, so it dies with the model and a blast takes the roof off.
 *
 * Carries the facade uvs, so the shell can draw it with the wall material and
 * keep its tiles. Returns null for a building with nothing at all on its deck.
 */
export function roofGeometry(f, topY, wallHex) {
  if (!f?.o || f.o.length < 3) return null;
  const use = classify(f), typ = typologyOf(f, use), roof = roofOf(f, typ);
  _c.setHex(wallHex ?? buildingWallHex(f));
  const sink = new BuildingSink();             // a roof is a building, not ground
  roofInto(sink, f, typ, roof, topY, [_c.r, _c.g, _c.b], storeyPlan(f, use).storeys,
    { soffit: true, tri: roofTri });
  return sink.geo();
}
// the cap roof lives in roofs.js now; kept importable from here
export { roofCap };

// ---- ortho ground: carve the aerial photo quad around sunken water ----
// The photo mesh arrives as an opaque quad; wherever water crosses the cell
// it must grow the same holes as the flat ground or it would roof the river.
// The original quad's planar uv mapping is recovered as an affine (x,z)→(u,v)
// fit from its first three vertices (in world space, in case ortho.js baked
// its placement into mesh.position), then re-applied to the carved outline.
export function carveOrtho(mesh, x0, z0, x1, z1, holes, terrain = null) {
  const p = mesh.geometry.attributes.position, uv = mesh.geometry.attributes.uv;
  if (!p || !uv || p.count < 3) return;
  mesh.updateMatrix();
  const V = [];
  // PlaneGeometry is a 6×6 terrain grid. Its first three vertices all belong
  // to the same row, so fitting an affine map from exactly [0,1,2] has a zero
  // determinant and used to abort every carve. Pick the first three points
  // that actually span an area instead.
  for (let i = 0; i < p.count && V.length < 3; i++) {
    _v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrix);
    const q = [_v.x, _v.z, uv.getX(i), uv.getY(i)];
    if (!V.length) { V.push(q); continue; }
    if (V.length === 1) {
      if (Math.hypot(q[0] - V[0][0], q[1] - V[0][1]) > 1e-6) V.push(q);
      continue;
    }
    const cross = (V[1][0] - V[0][0]) * (q[1] - V[0][1])
      - (q[0] - V[0][0]) * (V[1][1] - V[0][1]);
    if (Math.abs(cross) > 1e-6) V.push(q);
  }
  if (V.length < 3) return;
  const d1x = V[1][0] - V[0][0], d1z = V[1][1] - V[0][1];
  const d2x = V[2][0] - V[0][0], d2z = V[2][1] - V[0][1];
  const det = d1x * d2z - d2x * d1z;
  if (Math.abs(det) < 1e-9) return;
  const du1 = V[1][2] - V[0][2], du2 = V[2][2] - V[0][2];
  const dv1 = V[1][3] - V[0][3], dv2 = V[2][3] - V[0][3];
  const au = (du1 * d2z - du2 * d1z) / det, bu = (d1x * du2 - d2x * du1) / det;
  const av = (dv1 * d2z - dv2 * d1z) / det, bv = (d1x * dv2 - d2x * dv1) / det;
  const rect = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  let ng = new THREE.ShapeGeometry(ringShape(rect, holes)).rotateX(-Math.PI / 2);
  // The carve throws away the 6×6 grid ortho.js handed us — including the fact
  // that it had been DISPLACED onto the terrain — and replaces it with a fresh
  // outline triangulation at y = 0. For the whole life of the terrain that was
  // the end of it: every chunk a river ran through had its photographic ground
  // left at sea level, which in Pardubice is 221 m below the road you are
  // driving on and in Prague up to 380. The ground did not go missing, it went
  // to the bottom of the world.
  //
  // So the carved outline is re-tessellated (it has only its corners, and a
  // 120 m triangle cannot follow a hillside) and then lifted, exactly as
  // ortho.js lifts the uncarved quad. UVs are derived from x/z through the
  // affine map, so they must be computed AFTER the split and BEFORE the lift.
  if (terrain) {
    const nonIdx = ng.index ? ng.toNonIndexed() : ng;
    if (nonIdx !== ng) ng.dispose();
    const src = nonIdx.attributes.position;
    // (finer by a Prague quay wall, and lifted with the vertices there on the
    // wall's line: js/quayground.js; the UVs follow the moved x/z)
    const p = quayRefineArray(tessTriangles(src.array, src.count / 3, TESS_EDGE));
    ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.BufferAttribute(p, 3));
    ng.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((p.length / 3) * 2), 2));
    nonIdx.dispose();
    quayLiftTriangles(p, terrain);
  }
  const np = ng.attributes.position, nuv = ng.attributes.uv;
  for (let i = 0; i < np.count; i++) {
    const dx = np.getX(i) - V[0][0], dz = np.getZ(i) - V[0][1];
    nuv.setXY(i, V[0][2] + au * dx + bu * dz, V[0][3] + av * dx + bv * dz);
  }
  if (terrain) np.needsUpdate = true;
  ng.computeVertexNormals();
  mesh.geometry = ng; // the quad geometry may be an ortho.js cache — leave it undisposed
  mesh.position.set(0, 0, 0); mesh.rotation.set(0, 0, 0); mesh.scale.set(1, 1, 1);
  mesh.updateMatrix();
}

// ---- one chunk's buildings, as a single mesh ----
// Split out of buildChunkMeshes so ONE building can leave the batch without
// paying for a whole chunk rebuild: when a missile promotes a building to its
// own box model (destructible.js), city.js adds the id to `mats.hidden` and
// re-runs just this function for that cell. Roads are handed through so the
// front door can be aimed at the street (entranceOf caches the answer, so the
// scan happens once per building for the life of the session).
// mesh.name = 'buildings' is how city.js finds the old one to swap out.
// Garden sheds and garages, and nothing more. The first pass at this was
// 220 m² / 9 m, which sounded like "only the skyline survives" and turned out to
// mean "the village does not exist": measured over 900 m of Březůvky it threw
// away 57 % of the buildings, and over a Pardubice suburb — 185 of whose
// buildings are garages — 85 %. A Czech village IS its small houses; the median
// footprint in Březůvky is 148 m². 60 m² and 5 m keeps 96 % there and 68 % in
// the suburb, which is the garages and the sheds and nothing that reads as a
// house from the air.
const SHELL_MIN_AREA = 60;       // m² of footprint bbox
const SHELL_MIN_H = 5;           // …or this tall, and it is kept regardless
function bboxArea(ring) {
  if (!ring || ring.length < 3) return 0;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return (x1 - x0) * (z1 - z0);
}

/**
 * The textured wall material, built (with its 2048×1024 window atlas) the first
 * time anything asks. Exported because the atlas is the one <canvas> a chunk
 * build needs: a mesher running in a worker parks a sentinel on mats._facadeMat
 * so this never runs there, and the main thread calls it before decoding the
 * first chunk whose walls name the 'facade' material. Facades are never off —
 * the geometry carries its atlas uvs either way.
 */
export function facadeMaterial(mats) {
  return (mats._facadeMat ??= buildFacadeMaterial());
}

export function buildBuildingsMesh(city, cx, cz, mats) {
  const key = cx + ',' + cz;
  const cell = city.chunkIndex.get(key);
  if (!cell) return null;
  const facades = !!mats.facades;
  const hidden = mats.hidden;
  const bGeos = [], bSink = facades ? new BuildingSink() : new TriSink(false, false);
  // door dressing lives in its own two batches: the surround/canopy carry no
  // atlas uv, and the sign board needs an emissive material main.js can turn up
  // at dusk. Two extra draw calls per chunk buys a city where you can see which
  // buildings you can walk into. Brand WORDMARKS batch per chain on top —
  // a cell holding a Lidl and two Kauflands adds two meshes, not six.
  const trim = new TriSink(false, false), sign = new TriSink(false, false);
  const marks = new Map();
  // SHELL tier drops the small stuff. From 300 m up a garden shed is two pixels,
  // and a Czech village is mostly garden sheds: skipping everything under
  // SHELL_MIN_AREA that is also shorter than SHELL_MIN_H keeps the skyline —
  // the church, the school, the blocks, the barns — for a fraction of the
  // triangles. Without it the shell ring is 83 % of full detail, which is not
  // a level of detail at all.
  const small = mats.shellLod
    ? (f) => bboxArea(f.o) < SHELL_MIN_AREA && (f.h ?? 6) < SHELL_MIN_H
    : () => false;
  let lmBatch = null;
  for (const f of cell.buildings) {
    if (f._home !== key) continue;
    // A landmark is modelled by hand (js/landmarks.js) and is the same model in
    // every tier: never hidden behind a shell, never dropped as small.
    const lm = landmarkOf(f);
    if (lm) {
      (lmBatch ??= new LandmarkBatch()).add(lm, f, mats.terrain ? groundFor(f, mats.terrain) : 0, mats.terrain ?? null, cell.roads);
      continue;
    }
    if (hidden && hidden.has(f._id)) continue;   // now made of boxes instead
    if (small(f)) continue;
    buildingInto(f, bGeos, bSink, facades, cell, trim, sign, marks, mats.terrain,
      !!mats.shellLod);
  }
  // the landmarks with no footprint of their own (a monument, Charles Bridge):
  // whatever pieces of them this chunk owns
  for (const e of landmarkExtras(cx, cz, CHUNK))
    (lmBatch ??= new LandmarkBatch()).extra(e, { key, cx, cz, roads: cell.roads, terrain: mats.terrain ?? null, chunkOf: chunkKey });
  const pg = bSink.geo();
  if (pg) bGeos.push(pg);
  const lmGeo = lmBatch?.geo() ?? null;
  if (!bGeos.length && !lmGeo) return null;
  const mat = facades ? facadeMaterial(mats) : mats.building;
  const group = new THREE.Group();
  group.name = 'buildings';
  // A merge is a union of attributes, so one geometry arriving with a ground
  // class index would take the whole chunk's buildings out. Nothing here reads
  // it; strip it rather than depend on every producer remembering.
  for (const g of bGeos) g.deleteAttribute('surf');
  if (bGeos.length) {
    const m = new THREE.Mesh(mergeGeometries(bGeos, false), mat);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }
  if (lmGeo) {
    const lmMesh = new THREE.Mesh(lmGeo, mats.landmark);
    lmMesh.castShadow = lmMesh.receiveShadow = true;
    group.add(lmMesh);
  }
  const tg = trim.geo();
  if (tg) {
    const t = new THREE.Mesh(tg, mats.doorTrim);
    t.castShadow = t.receiveShadow = true;
    group.add(t);
  }
  const sg2 = sign.geo();
  if (sg2) group.add(new THREE.Mesh(sg2, mats.doorSign));
  // the wordmark quads, one Mesh per chain present in the cell. No normals —
  // brandMarkMat is a MeshBasicMaterial and never shades. Geometry is owned by
  // the group (disposed on rebuild/unload); the material and its texture are
  // module-cached and shared city-wide.
  // …and `mats.brandMat` is the seam a DOM-less mesher hooks: the canvas that
  // paints a wordmark cannot exist in a worker, so the worker hands back a
  // placeholder the codec can name and the main thread resolves it to the real
  // texture. Everything else about the quad is the same geometry either way.
  const brandMat = mats.brandMat ?? brandMarkMat;
  for (const mk of marks.values()) {
    if (!mk.pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mk.pos), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(mk.uv), 2));
    group.add(new THREE.Mesh(g, brandMat(mk.brand)));
  }
  // on the main thread (no mats.brandMat seam) the chains' quads become one
  // mesh on the shared wordmark page; a worker's go out per chain as before
  // and js/meshpool.js merges them the same way after the decode
  if (!mats.brandMat && BATCH.marks) mergeMarks(group);
  return group;
}

// ---- street lamps: the detail that makes a road read as a street ----
// A plain post with a short arm and a lamp head, placed along the drivable
// carriageway every LAMP_STEP meters and alternating sides. Two instanced
// meshes per chunk (post + head); the head material is emissive so dusk turns
// the whole city on for free — no lights, no shadow cost.
// One zebra: white longitudinal bars side by side across the carriageway,
// centred on the OSM crossing node, at the road's own absolute deck height.
function zebraInto(sink, cr, cell, terrain, signsOut = null, offRoad = null) {
  const [x, z] = cr.p[0];
  // the crossing belongs to the road it plausibly CROSSES — scored by
  // distance over half-width, so a wide main street beats a narrow service
  // lane that happens to pass a metre closer (the broken diagonal zebras)
  // FIRST: the road whose polyline actually CONTAINS this node. An OSM
  // crossing node lies ON its road's way, so a vertex within arm's reach is
  // the ground truth — proximity scoring (below, as fallback for simplified
  // polylines) sometimes bound the zebra to a parallel street and painted the
  // bars at that street's angle, which is the "zebra at a weird angle in a
  // weird place" report. The axis at a vertex averages the two adjacent
  // segments, so a crossing on a gentle bend gets the tangent, not a kink.
  let bestScore = 2.2, road = null, ux = 0, uz = 1, s0 = 0, vBest = 0.5 * 0.5, vW = 0;
  for (const r of cell.roads) {
    if (!r.d || !r.p || (r.w ?? 0) < 3) continue;
    let along = 0;
    for (let i = 0; i < r.p.length; i++) {
      const [vx, vz] = r.p[i];
      if (i > 0) along += Math.hypot(vx - r.p[i - 1][0], vz - r.p[i - 1][1]);
      const d2 = (x - vx) ** 2 + (z - vz) ** 2;
      if (d2 > vBest) continue;
      const w = r.w ?? 6;
      if (d2 === vBest && w <= vW) continue;      // ties: the wider road wins
      const [px0, pz0] = r.p[Math.max(0, i - 1)], [px1, pz1] = r.p[Math.min(r.p.length - 1, i + 1)];
      const ex = px1 - px0, ez = pz1 - pz0, L = Math.hypot(ex, ez);
      if (L < 1e-6) continue;
      vBest = d2; vW = w; road = r; ux = ex / L; uz = ez / L; s0 = along; bestScore = 0;
    }
  }
  // FALLBACK: nearest plausible carriageway, scored by distance over half-width
  if (!road) for (const r of cell.roads) {
    if (!r.d || !r.p || (r.w ?? 0) < 3) continue;
    const hw2 = (r.w ?? 6) / 2;
    let along = 0;
    for (let i = 0; i < r.p.length - 1; i++) {
      const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
      const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
      let t = ((x - ax) * ex + (z - az) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + ex * t, qz = az + ez * t;
      const score = Math.sqrt((x - qx) ** 2 + (z - qz) ** 2) / hw2;
      const L = Math.sqrt(L2);
      if (score < bestScore) { bestScore = score; road = r; ux = ex / L; uz = ez / L; s0 = along + L * t; }
      along += L;
    }
  }
  if (!road || !terrain) return;
  const gy = road.br ? bridgeDeckHeight(road, s0, terrain) : roadGradeY(road, s0, terrain);
  if (gy === null || gy === undefined) return;
  // a crossing INSIDE a junction (every OSM zebra at a big box is) must ride
  // ABOVE the pad, whose deck comes from the NEAREST arm — a few cm higher
  // than this crossing's own road, and the pad swallowed the stripes whole
  let y = gy + LAYER_Y.marking + 0.02;
  const ck = chunkKey(x, z);
  // (the pad stands a hair over its highest-ranked arm: 3.5 cm clears any of
  // them). Asked of the pad's own OUTLINE, at the band's middle and both ends.
  const pads = [...(junctionsIn(ck) ?? []), ...(clustersIn(ck) ?? [])];
  const pad = pads.length ? (inPads(pads, x, z) ?? inPads(pads, x + ux * 1.8, z + uz * 1.8)
    ?? inPads(pads, x - ux * 1.8, z - uz * 1.8)) : null;
  if (pad) {
    const dy = pad.members ? clusterDeckY(pad, x, z, terrain) : junctionDeckY(pad, x, z, terrain);
    y = Math.max(y, dy + LAYER_Y.road + 0.012 + 0.035 + MARK);
  }
  // IP 6 on each approach, where the zebra crosses a real street on its own
  // (inside a junction box the signals or the junction's own signs speak)
  if (signsOut && offRoad && !pad && (road.w ?? 0) >= 5) crossingSigns(x, z, ux, uz, road, offRoad, signsOut);
  sink.at(SURF.paint);
  _c.setHex(COLORS.marking);
  const mr = _c.r, mg = _c.g, mb = _c.b;
  const px2 = -uz, pz2 = ux;                    // across the road
  const hw = (road.w ?? 6) / 2 - 0.25;
  const HB = 1.8;                               // half band length along the road
  const mark = sink.mark();
  // a refuge island in the middle, where OSM says the crossing has one: the
  // zebra then starts beyond it rather than painting stripes over a kerb
  const island = cr.p[0].length > 2;
  const iw = island ? 1.15 : 0;
  // bars 0.55 m wide with 0.5 m gaps, mirrored out from the centreline
  for (let o = 0.2 + iw; o + 0.55 <= hw; o += 1.05) {
    for (const side of [-1, 1]) {
      const c0 = o * side, c1 = (o + 0.55) * side;
      paintQuad(sink,
        x + px2 * c0 - ux * HB, y, z + pz2 * c0 - uz * HB,
        x + px2 * c1 - ux * HB, y, z + pz2 * c1 - uz * HB,
        x + px2 * c1 + ux * HB, y, z + pz2 * c1 + uz * HB,
        x + px2 * c0 + ux * HB, y, z + pz2 * c0 + uz * HB,
        mr, mg, mb);
    }
  }
  sink.fixFrom(mark);
  // …and the refuge island the stripes were kept clear of. This call used to
  // sit at the tail of wireSpan(), where `island` does not exist — so every
  // chunk carrying a power line threw ReferenceError and stopped building
  // halfway, which is a whole missing neighbourhood per bad pylon.
  if (island) islandInto(sink, x, z, ux, uz, terrain, y - LAYER_Y.marking + LAYER_Y.road);
}

// ---- transmission lines: a pylon at every vertex, wires sagging between ----
// Absolute heights + fixFrom: a wire must hang on ITS towers' tops, not ride
// whatever the ground under each sampled point happens to do.
function pylonInto(sink, x, z, minor, kV, terrain) {
  const g = terrain.heightAt(x, z);
  const H = minor ? 10 : kV >= 200 ? 42 : kV >= 100 ? 32 : 25;
  const mark = sink.mark();
  sink.at(SURF.concrete);
  _c.setHex(minor ? 0x6d6257 : 0x8a8d92);       // wood pole vs galvanised steel
  const r = _c.r, gg = _c.g, b = _c.b;
  const wB = minor ? 0.16 : H * 0.055;          // tapering mast, crossed fins
  const wT = minor ? 0.12 : 0.5;
  for (const [ox, oz] of [[1, 0], [0, 1]]) {
    for (const flip of [1, -1]) {
      sink.quad(
        x - ox * wB * flip, g - 0.4, z - oz * wB * flip,
        x + ox * wB * flip, g - 0.4, z + oz * wB * flip,
        x + ox * wT * flip, g + H, z + oz * wT * flip,
        x - ox * wT * flip, g + H, z - oz * wT * flip, r, gg, b);
    }
  }
  if (!minor) {
    // one crossarm, both windings, 2 m under the peak
    const aw = kV >= 200 ? 9 : 6.5;
    const ay = g + H - 2;
    for (const flip of [1, -1]) {
      sink.quad(x - aw / 2, ay - 0.3 * flip, z, x + aw / 2, ay - 0.3 * flip, z,
        x + aw / 2, ay + 0.3 * flip, z, x - aw / 2, ay + 0.3 * flip, z, r, gg, b);
      sink.quad(x, ay - 0.3 * flip, z - aw / 2, x, ay - 0.3 * flip, z + aw / 2,
        x, ay + 0.3 * flip, z + aw / 2, x, ay + 0.3 * flip, z - aw / 2, r, gg, b);
    }
  } else {
    const ay = g + H - 0.6;
    for (const flip of [1, -1]) {
      sink.quad(x - 1.2, ay - 0.08 * flip, z, x + 1.2, ay - 0.08 * flip, z,
        x + 1.2, ay + 0.08 * flip, z, x - 1.2, ay + 0.08 * flip, z, r, gg, b);
    }
  }
  sink.fixFrom(mark);
}

// one span of conductors between two towers: thin vertical ribbons with a
// catenary sag, drawn double-sided so they read from below and from the bank
function wireSpan(sink, ax, az, bx, bz, minor, kV, terrain) {
  const span = Math.hypot(bx - ax, bz - az);
  if (span < 4 || span > 900) return;            // a broken vertex is not a span
  const Ha = (minor ? 10 : kV >= 200 ? 42 : kV >= 100 ? 32 : 25);
  const yA = terrain.heightAt(ax, az) + Ha - (minor ? 0.7 : 2.1);
  const yB = terrain.heightAt(bx, bz) + Ha - (minor ? 0.7 : 2.1);
  const sag = Math.min(9, Math.max(0.7, span * (minor ? 0.02 : 0.032)));
  const ux = (bx - ax) / span, uz = (bz - az) / span;
  const px = -uz, pz = ux;                       // across the span
  const offs = minor ? [-1.0, 0, 1.0] : (kV >= 200 ? [-3.6, -1.9, 1.9, 3.6] : [-2.6, 0, 2.6]);
  const N = Math.max(4, Math.min(16, Math.round(span / 18)));
  const mark = sink.mark();
  sink.at(SURF.concrete);
  _c.setHex(0x33363b);
  const r = _c.r, g = _c.g, b = _c.b;
  const W = 0.05;                                // ribbon half-height
  for (const o of offs) {
    let lx = ax + px * o, lz = az + pz * o, ly = yA;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const cx = ax + (bx - ax) * t + px * o, cz = az + (bz - az) * t + pz * o;
      const cy = yA + (yB - yA) * t - sag * 4 * t * (1 - t);
      sink.quad(lx, ly - W, lz, cx, cy - W, cz, cx, cy + W, cz, lx, ly + W, lz, r, g, b);
      sink.quad(lx, ly + W, lz, cx, cy + W, cz, cx, cy - W, cz, lx, ly - W, lz, r, g, b);
      lx = cx; lz = cz; ly = cy;
    }
  }
  sink.fixFrom(mark);
}

// ---- trolejbusy: masts along the kerb, a pair of wires over each direction --
// OSM tags the wire on the WAY (trolley_wire=yes), so the geometry is the road
// centreline and the rest is Czech practice: contact wire 5.5 m up, two wires
// 0.6 m apart per direction, masts every 32 m alternating kerbs with a span
// bracket reaching over. Absolute heights (fixFrom), like every other fixture.
//
// The WIRES of a way are drawn whole from its home chunk, like its ribbon. The
// MASTS belong to the cell they stand in, like the lamps: a mast has to know
// what it would be standing in, and only the cell it is in (with the eight
// round it) holds the carriageways, crossings and houses that can answer.
// Drawn whole from the home chunk they were placed half a width and 0.8 m off
// the centreline and nothing else was asked: of the 1 316 masts of Pardubice
// 214 stood in another carriageway, 39 in a bus lay-by, 25 on the asphalt of a
// junction (the Palackého crossing had them in its middle) and 3 in a house.
const TW_H = 5.5, TW_GAP = 0.6, TW_STEP = 32;
const TW_OUT = 0.8;             // m behind the kerb line a mast stands
const TW_SLIDE = 6;             // m a mast may be moved along the street to find a place
const TW_ZEBRA = 4;             // m of kerb either side of a crossing kept clear

/**
 * "May a mast stand at (x, z)?" for cell `key`, as a function that answers
 * true when it may NOT: on a carriageway or in a lay-by (lampInRoad), on the
 * asphalt of a junction, or inside a house. The same lists, from the same nine
 * cells, as the lamps are tested against (lampGround, lampHouses), so the mesh
 * worker has every one of them. `self` is the mast's own way when it stands
 * inside that way's width on purpose (a bridge deck).
 */
function mastGuard(cell, key, city) {
  const c = key.indexOf(','), x0 = +key.slice(0, c) * CHUNK, z0 = +key.slice(c + 1) * CHUNK;
  const { roads, pads } = lampGround(city, cell, key);
  const over = new Map();
  return (x, z, self) => {
    if (lampInRoad(roads, self, x, z, LAMP_CLEAR)) return true;
    if (self) return false;
    const j = inPads(pads, x, z);
    if (j && cornerLift(j, x, z) < 0) return true;
    const k = chunkKey(x, z);
    if (k === key) return lampInHouse(cell.buildings ?? [], x, z);
    let hs = over.get(k);
    if (hs === undefined) {
      const nb = city?.chunkIndex?.get(k);
      over.set(k, hs = nb?.houses ?? lampHouses(nb, x0, z0, x0 + CHUNK, z0 + CHUNK));
    }
    return lampInHouse(hs, x, z);
  };
}

/**
 * Where the masts of trolley way `f` stand in cell `key`, as
 * [x, z, cx, cz, side, seg, t, s]: the mast, the point of the centreline it
 * serves, which kerb (+1 / -1 along the segment's left normal), and where that
 * point is (segment index, 0..1 along it, arclength along the way).
 *
 * One station every TW_STEP from the way's first vertex, whichever cell asks,
 * and a station is the business of the cell its centreline point is in. At
 * each: the kerb the alternation gives, 0.8 m behind the kerb line, and the
 * kerb line steps out round a bus lay-by. If that is no place for a mast
 * (`blocked`, a dropped kerb, a crossing) the far kerb; if that is none either
 * the same two a few metres up the street and then down it; and if nothing is
 * free there is no mast, and the wire spans the gap as it does over any big
 * crossing. On a bridge the mast stands on the deck's edge.
 */
export function trolleyMasts(f, key, cell, blocked, out = []) {
  const p = f.p;
  if (!p || p.length < 2) return out;
  const c = key.indexOf(','), x0 = +key.slice(0, c) * CHUNK, z0 = +key.slice(c + 1) * CHUNK;
  const x1 = x0 + CHUNK, z1 = z0 + CHUNK;
  const half = (f.w ?? 7) / 2, deck = !!f.br;
  const vg = deck ? null : streetOf(f);
  const zebra = (x, z) => {
    for (const cr of cell?.crossings ?? []) {
      if ((cr.p[0][0] - x) ** 2 + (cr.p[0][1] - z) ** 2 < TW_ZEBRA * TW_ZEBRA) return true;
    }
    return false;
  };
  let carry = (f._id % 13) * 2, run = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const ax = p[i][0], az = p[i][1];
    let dx = p[i + 1][0] - ax, dz = p[i + 1][1] - az;
    const L = Math.hypot(dx, dz);
    if (L < 0.01) continue;
    dx /= L; dz /= L;
    const px = -dz, pz = dx;
    for (let d = TW_STEP - carry; d < L; d += TW_STEP) {
      const sx = ax + dx * d, sz = az + dz * d;
      if (sx < x0 || sx >= x1 || sz < z0 || sz >= z1) continue;      // this cell only
      const first = ((f._id + Math.round(d / TW_STEP)) & 1) ? 1 : -1;
      place: for (let k = 0; k < 3; k++) {
        const dd = d + (k === 1 ? TW_SLIDE : k === 2 ? -TW_SLIDE : 0);
        if (dd < 0 || dd > L) continue;
        const cx = ax + dx * dd, cz = az + dz * dd;
        // (moved along, it stays this cell's: the lists it is tested against
        // reach 14 m past the cell, and a mast is up to 9 m off its station)
        if (k && (cx < x0 || cx >= x1 || cz < z0 || cz >= z1)) continue;
        if (!deck && zebra(cx, cz)) continue;
        for (let e = 0; e < 2; e++) {
          const side = e ? -first : first;
          // bayAt and the verge count sides by the ribbon's perpendicular, the
          // opposite of `side` here
          const off = deck ? half - 0.25 : half + TW_OUT + bayAt(f, run + dd, -side);
          const mx = cx + px * side * off, mz = cz + pz * side * off;
          if (vg) {
            const v = vergeAt(f, run + dd, side < 0 ? 1 : 0);
            if (v.u && v.drop > 0.25) continue;                       // a dropped kerb: somebody crosses here
          }
          if (blocked && blocked(mx, mz, deck ? f : null)) continue;
          out.push([mx, mz, cx, cz, side, i, dd / L, run + dd]);
          break place;
        }
      }
    }
    carry = (carry + L) % TW_STEP;
    run += L;
  }
  return out;
}

/** Every trolley mast of cell `key`, as trolleyMasts gives them: what js/trolleymasts.js plants. */
export function trolleyPlan(city, key, owners = null) {
  const cell = city?.chunkIndex?.get(key), out = [];
  if (!cell) return out;
  let guard = null;
  for (const r of cell.roads) {
    if (!r.tw || !r.p) continue;
    const n0 = out.length;
    trolleyMasts(r, key, cell, guard ??= mastGuard(cell, key, city), out);
    // (`owners`, when given, gets the way of each mast: what its bracket reaches over)
    if (owners) for (let k = n0; k < out.length; k++) owners.push(r);
  }
  return out;
}

function trolleyInto(sink, f, terrain, stand = null, key = null, blocked = null, cell = null) {
  if (!f.p || f.p.length < 2 || !terrain) return;
  const mark = sink.mark();
  sink.at(SURF.concrete);
  _c.setHex(0x2a2c30);
  const wr = _c.r, wg = _c.g, wb = _c.b;
  const half = (f.w ?? 7) / 2;
  // the wire pairs ride either side of the centreline (one per direction);
  // a narrow street carries a single pair down the middle
  const offs = half > 4.5 ? [-half * 0.5, half * 0.5] : [0];
  // What a wire is 5.5 m over. On a bridge that is the deck: over the ground
  // under it the pair dived into the valley and came up through the far
  // abutment. Anywhere else the ground the road was levelled into, as before.
  const lens = [0];
  for (let i = 0; i < f.p.length - 1; i++) lens.push(lens[i] + Math.hypot(f.p[i + 1][0] - f.p[i][0], f.p[i + 1][1] - f.p[i][1]));
  const under = (i, x, z) => (f.br ? bridgeDeckHeight(f, lens[i], terrain) + LAYER_Y.road : terrain.heightAt(x, z));
  if (key === null || f._home === key) for (let i = 0; i < f.p.length - 1; i++) {
    const [ax, az] = f.p[i], [bx, bz] = f.p[i + 1];
    let dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz);
    if (L < 0.01) continue;
    dx /= L; dz /= L;
    const px = -dz, pz = dx;
    // the wires themselves, one straight run per segment per direction
    for (const o of offs) {
      for (const w of [-TW_GAP / 2, TW_GAP / 2]) {
        const c = o + w;
        const x0w = ax + px * c, z0w = az + pz * c;
        const x1w = bx + px * c, z1w = bz + pz * c;
        const y0 = under(i, x0w, z0w) + TW_H;
        const y1 = under(i + 1, x1w, z1w) + TW_H;
        // a thin double-sided ribbon reads as a wire from the street
        sink.quad(x0w, y0 - 0.035, z0w, x1w, y1 - 0.035, z1w,
          x1w, y1 + 0.035, z1w, x0w, y0 + 0.035, z0w, wr, wg, wb);
        sink.quad(x0w, y0 + 0.035, z0w, x1w, y1 + 0.035, z1w,
          x1w, y1 - 0.035, z1w, x0w, y0 - 0.035, z0w, wr, wg, wb);
      }
    }
  }
  // The MASTS are not chunk geometry any more: a mast can be knocked down, and
  // one row of a merged chunk cannot be taken out of it. js/trolleymasts.js
  // plants the masts of the cells round the player from trolleyPlan, draws
  // each with trolleyMastInto below and hands it to js/poles.js. (`key`,
  // `blocked` and `cell` stay in the signature for the callers.)
  sink.fixFrom(mark);
}

/**
 * One trolley mast with the bracket that carries the wire, as trolleyMasts
 * planned it (`m` is one of its rows) for trolley way `f`, standing at height
 * `g`. The arm starts wherever the mast found room and ends over the far pair,
 * level with the wire AT THIS STATION (read off the same two segment ends the
 * wire was drawn between), and each pair hangs from it on a dropper. So a mast
 * moved behind a lay-by or across the street still holds the wire, on a
 * longer arm. Written into `sink` (anything with quad, tri and triFacing) at
 * absolute coordinates less (ox, oy, oz), so the same mast can be a row of a
 * batch and, felled, a mesh of its own about its foot.
 */
export function trolleyMastInto(sink, f, m, terrain, g, ox = 0, oy = 0, oz = 0) {
  const [mx, mz, cx, cz, side, i, t] = m;
  _c.setHex(0x6f7378);
  const mr = _c.r, mg = _c.g, mb = _c.b;
  const half = (f.w ?? 7) / 2;
  const offs = half > 4.5 ? [-half * 0.5, half * 0.5] : [0];
  const [ax, az] = f.p[i], [bx, bz] = f.p[i + 1];
  const L = Math.hypot(bx - ax, bz - az) || 1e-6;
  const px = -(bz - az) / L, pz = (bx - ax) / L;
  let l0 = 0;
  if (f.br) for (let k = 0; k < i; k++) l0 += Math.hypot(f.p[k + 1][0] - f.p[k][0], f.p[k + 1][1] - f.p[k][1]);
  const under = (k, x, z) => (f.br ? bridgeDeckHeight(f, l0 + (k ? L : 0), terrain) + LAYER_Y.road : terrain.heightAt(x, z));
  const wireY = (c) => {
    const y0 = under(0, ax + px * c, az + pz * c), y1 = under(1, bx + px * c, bz + pz * c);
    return y0 + (y1 - y0) * t + TW_H;
  };
  let hi = -Infinity;
  for (const o of offs) hi = Math.max(hi, wireY(o));
  const armY = hi + 0.34;
  const top = Math.max(armY + 0.6, g + 3);
  const X = mx - ox, Z = mz - oz, G = g - oy, A = armY - oy, Tp = top - oy;
  // a tapered steel mast on a flange, standing on the pavement (or the deck)
  kitDrum(sink, X, Z, G, G + 0.04, 0.2, 0.2, 8, mr * 0.8, mg * 0.8, mb * 0.8, 1);
  kitDrum(sink, X, Z, G + 0.04, Tp, 0.105, 0.07, 8, mr, mg, mb, 1);
  // the arm, 0.4 m past the far pair, and the stay that holds its end up
  const far = -side * (offs.length > 1 ? half * 0.5 : 0) - side * 0.4;
  const ex = cx + px * far - ox, ez = cz + pz * far - oz;
  kitBar(sink, X, A, Z, ex, A, ez, 0.07, mr, mg, mb);
  kitBar(sink, X, Tp - 0.03, Z, X + (ex - X) * 0.7, A + 0.03, Z + (ez - Z) * 0.7, 0.035, mr, mg, mb);
  for (const o of offs) {
    const wx = cx + px * o - ox, wz = cz + pz * o - oz, wy = wireY(o) - oy;
    // the dropper, and the spreader that holds the two wires of a pair apart
    kitBar(sink, wx, A, wz, wx, wy + 0.06, wz, 0.03, mr, mg, mb);
    kitBar(sink, wx - px * TW_GAP / 2, wy + 0.06, wz - pz * TW_GAP / 2,
      wx + px * TW_GAP / 2, wy + 0.06, wz + pz * TW_GAP / 2, 0.03, mr, mg, mb);
  }
}

// ---- refuge island: the kerbed slab a crossing splits around ---------------
// OSM says crossing:island=yes on the node; the shape is Czech practice — a
// 2 m wide, 5 m long paved slab on the centreline with a 12 cm kerb face.
function islandInto(sink, x, z, ux, uz, terrain, deckY) {
  const px2 = -uz, pz2 = ux;
  const HL = 2.6, HW = 1.0, KERB = 0.12;
  const top = deckY + KERB;
  const mark = sink.mark();
  sink.at(SURF.paving);
  _c.setHex(0xa8a49c);
  const r = _c.r, g = _c.g, b = _c.b;
  const P = (a, c) => [x + ux * a + px2 * c, z + uz * a + pz2 * c];
  const c0 = P(-HL, -HW), c1 = P(HL, -HW), c2 = P(HL, HW), c3 = P(-HL, HW);
  paintQuad(sink, c0[0], top, c0[1], c1[0], top, c1[1],
    c2[0], top, c2[1], c3[0], top, c3[1], r, g, b);
  _c.setHex(0x8e8a83);
  const kr = _c.r, kg = _c.g, kb = _c.b;
  const ring = [c0, c1, c2, c3];
  for (let i = 0; i < 4; i++) {
    const a = ring[i], c = ring[(i + 1) % 4];
    sink.quad(a[0], top, a[1], c[0], top, c[1], c[0], deckY - 0.02, c[1], a[0], deckY - 0.02, a[1], kr, kg, kb);
    sink.quad(a[0], deckY - 0.02, a[1], c[0], deckY - 0.02, c[1], c[0], top, c[1], a[0], top, a[1], kr, kg, kb);
  }
  sink.fixFrom(mark);
}

// the označník: a pole with the blue zastávka flag, facing the nearest road
// ---- zastávkový záliv ------------------------------------------------------
// OSM DOES NOT MAP THESE. Measured at Kpt. Bartoše in Polabiny, where the
// orthophoto plainly shows a lay-by: inside 45 m the data holds the street,
// some footways, a cycleway and TWO bus_stop nodes — and no area whatsoever.
// So a bay cannot be extracted, only generated, and it is generated from here
// because busStopInto has already found the carriageway and which way it runs.
//
// The shape is ČSN 73 6425-1 for one bus: ~3 m of extra width over ~13 m of
// standing length, with a 10 m taper at each end to swing in and out of.
//
// Heights come from roadGradeY — the ribbon's OWN deck — so the bay meets the
// carriageway with no step. Draping it on raw terrain instead would leave a
// lip along the kerb line on any road in cut or on fill, which is the whole
// reason the ribbon is levelled in the first place.
//
// The ground below needs no extra clamping: the corridor the terrain is
// already cut to reaches r.w / 2 + 4.5 m, which contains the entire 3 m bay.
const BAY_W = 3.0, BAY_FLAT = 6.5, BAY_TAPER = 10;
function bayInto(sink, r, along, offX, offZ, terrain) {
  // only on a real through street: a bay in a living street or on a track is
  // not a thing anybody builds, and a 5 m lane has no room to give one up
  if (!r || !terrain || !r.d || r.br || !(r.w >= 5.4)) return;
  const half = r.w / 2;
  // which kerb the shelter stands on — the sign of the stop's offset along the
  // road's left normal AT THE STOP. Taking it from the way's first segment
  // instead is only the same answer while the way runs straight: on a street
  // that turns, the bay lands on whichever kerb the far end of the way happens
  // to agree with. Measured on a way doubling back on itself: 70 triangles on
  // the kerb opposite the shelter against 48 on its own.
  const s0 = along - BAY_FLAT - BAY_TAPER, s1 = along + BAY_FLAT + BAY_TAPER;
  let tx = 1, tz = 0;
  for (let i = 0, run = 0; i < r.p.length - 1; i++) {
    const [px, pz] = r.p[i], [nx2, nz2] = r.p[i + 1];
    const ex = nx2 - px, ez = nz2 - pz, L = Math.hypot(ex, ez) || 1e-9;
    if (run + L >= along || i === r.p.length - 2) { tx = ex / L; tz = ez / L; break; }
    run += L;
  }
  const side = (offX * -tz + offZ * tx) >= 0 ? 1 : -1;
  if (s0 < 0 || s1 > (r._len ?? 1e9)) return;      // no room before the junction
  const widthAt = (s) => {
    const d = Math.abs(s - along);
    if (d <= BAY_FLAT) return BAY_W;
    return BAY_W * Math.max(0, 1 - (d - BAY_FLAT) / BAY_TAPER);
  };
  // walk the way itself rather than a straight line, so a bay on a bend
  // follows the kerb instead of cutting the corner
  const at = (s) => {
    let run = 0;
    for (let i = 0; i < r.p.length - 1; i++) {
      const [px, pz] = r.p[i], [nx2, nz2] = r.p[i + 1];
      const ex = nx2 - px, ez = nz2 - pz, L = Math.hypot(ex, ez) || 1e-9;
      if (run + L >= s || i === r.p.length - 2) {
        const t = Math.max(0, Math.min(1, (s - run) / L));
        return [px + ex * t, pz + ez * t, -ez / L * side, ex / L * side];
      }
      run += L;
    }
    return [r.p[0][0], r.p[0][1], 0, 0];
  };
  const mark = sink.mark();
  sink.at(SURF.asphalt);
  _c.setHex(COLORS.road[r.t] ?? 0x55585e);   // the carriageway's own grey
  const rr = _c.r, rg = _c.g, rb = _c.b;
  const STEP = 2.5;
  let prev = null;
  for (let s = s0; s <= s1 + 1e-6; s += STEP) {
    const [px, pz, nx2, nz2] = at(s);
    const y = roadGradeY(r, s, terrain) + LAYER_Y.road;
    const w = widthAt(s);
    const cur = { ix: px + nx2 * half, iz: pz + nz2 * half, y,
      ox: px + nx2 * (half + w), oz: pz + nz2 * (half + w) };
    if (prev) {
      // The kerb normal flips with `side`, so a fixed corner order winds the
      // quad backwards on one kerb and the whole bay is culled away — measured
      // as 25 triangles facing UP on the south kerb and 25 facing DOWN on the
      // north one, which is a lay-by that simply is not there on half the
      // stops in the city. Walk the corners the other way round instead.
      if (side > 0) {
        sink.quad(prev.ix, prev.y, prev.iz, prev.ox, prev.y, prev.oz,
          cur.ox, cur.y, cur.oz, cur.ix, cur.y, cur.iz, rr, rg, rb);
      } else {
        sink.quad(prev.ix, prev.y, prev.iz, cur.ix, cur.y, cur.iz,
          cur.ox, cur.y, cur.oz, prev.ox, prev.y, prev.oz, rr, rg, rb);
      }
    }
    prev = cur;
  }
  sink.fixFrom(mark);          // absolute deck heights: the drape must skip it
}

function busStopInto(sink, x, z, cell, terrain, stand = null, deco = null) {
  let dx = 0, dz = -1, best = 30 * 30;
  let bestR = null, bestAlong = 0, qx = x, qz = z;
  for (const r of cell.roads) {
    if (!r.d || !r.p) continue;
    let run = 0;
    for (let i = 0; i < r.p.length - 1; i++) {
      const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
      const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
      const L = Math.sqrt(L2);
      let t = ((x - ax) * ex + (z - az) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d2 = (x - (ax + ex * t)) ** 2 + (z - (az + ez * t)) ** 2;
      if (d2 < best) {
        best = d2; dx = ex / L; dz = ez / L;
        bestR = r; bestAlong = run + L * t;
        qx = ax + ex * t; qz = az + ez * t;
      }
      run += L;
    }
  }
  bayInto(sink, bestR, bestAlong, x - qx, z - qz, terrain);
  // the označník: a post on the pavement, the blue IJ 4b plate on top looking
  // both ways along the street, and the timetable case at reading height
  const y0 = (stand ?? terrain) ? (stand ?? terrain).heightAt(x, z) : 0;
  const mark = sink.mark();
  sink.at(SURF.concrete);
  _c.setHex(0x8a8d92);
  const pr = _c.r, pg = _c.g, pb = _c.b;
  kitDrum(sink, x, z, y0, y0 + 0.05, 0.09, 0.06, 6, pr * 0.8, pg * 0.8, pb * 0.8, 1);
  kitPost(sink, x, z, y0 + 0.05, y0 + 2.95, 0.032, pr, pg, pb);
  if (terrain) sink.fixFrom(mark);
  if (!deco) return;
  for (const flip of [1, -1]) {
    const fx = dx * flip, fz = dz * flip;
    deco.panel('bus', x + fx * 0.045, y0 + 2.58, z + fz * 0.045, 0.72, 0.72, fx, fz);
    deco.panel('timetable', x + fx * 0.045, y0 + 1.5, z + fz * 0.045, 0.34, 0.5, fx, fz);
  }
}

// ---- benzínka: canopy, pumps, totem ---------------------------------------
// 1 178 of them are in the shipped tiles as amenity=fuel nodes, most with the
// operator's name, and until now not one was drawn — the player crossed a
// region the size of Bohemia without passing a single petrol station. A Czech
// forecourt is a wide flat canopy on slim columns, two pump islands under it,
// and a totem out by the road: that silhouette is the whole recognition, so
// the shop is left to whatever building OSM already maps beside it.
// Absolute heights (one ground sample for the lot, like every other fixture),
// so the chunk drape must skip it.
const FUEL_BRANDS = [
  { re: /benzina|orlen/i, col: 0x1c9b4b, trim: 0xf4f6f5 },
  { re: /shell/i, col: 0xe4b024, trim: 0xd8261f },
  { re: /\bomv\b/i, col: 0x1f4b8e, trim: 0xf4f6f5 },
  { re: /\bmol\b/i, col: 0x18693c, trim: 0xe23b2e },
  { re: /euro ?oil|eurooil/i, col: 0x1d5aa8, trim: 0xf2c53d },
  { re: /\bono\b|globus|tank ?ono/i, col: 0xc8352a, trim: 0xf4f6f5 },
];
function fuelInto(sink, x, z, name, cell, terrain) {
  // face the forecourt along the nearest road, so the canopy sits across the
  // approach rather than skewed to it, and slide it off the kerb: the rule is
  // js/forecourt.js now, because the pump (main.js) measures from the same
  // frame and must stand where it is drawn.
  // A station is mapped as ONE node, and that node lands wherever the surveyor
  // put it — usually the shop, sometimes the entrance, often within a few
  // metres of the kerb. Built from there, a forecourt 11 m deep puts its apron,
  // a pump island and a canopy column out in the live carriageway. Nothing in
  // the data says where the plot ends, but a forecourt is beside a road and
  // never across it, so slide the whole thing back until it clears the kerb.
  const fr = forecourtFrame({ p: [x, z] }, cell.roads, _fuelFr);
  x = fr.x; z = fr.z;
  const dx = fr.rdx, dz = fr.rdz, qw = fr.qw, NEED = fr.need, gap = fr.gap;
  const near = fr.near, away = fr.away;
  const ux = -dz, uz = dx;                       // across the road
  const y0 = terrain ? terrain.heightAt(x, z) : 0;
  const mark = sink.mark();
  const brand = FUEL_BRANDS.find((b) => b.re.test(name ?? '')) ?? { col: 0x2f6ea8, trim: 0xf4f6f5 };
  const at = (u, v) => [x + ux * u + dx * v, z + uz * u + dz * v];
  _c.setHex(0xf0efe9); const cr = _c.r, cg = _c.g, cb = _c.b;      // canopy soffit
  _c.setHex(brand.col); const br2 = _c.r, bg2 = _c.g, bb2 = _c.b;  // the fascia band
  _c.setHex(0x9aa0a6); const sr = _c.r, sg = _c.g, sb = _c.b;      // columns, pumps
  sink.at(SURF.paving);
  // The apron the pumps stand on. As ONE quad it is a 22 × 16 m plate centred
  // on the OSM node — and that node marks the forecourt, which by definition
  // sits right against the road it serves, so the plate laid asphalt straight
  // over the carriageway and the road disappeared under it. Cut into cells and
  // drop the ones a road already covers: the forecourt now meets the kerb
  // instead of swallowing it, and the road keeps its own levelled deck.
  const A = 11, B = 8;                          // half-width across, half-depth along
  const CELL = 2;
  const onRoad = (px, pz) => {
    for (const r of cell.roads) {
      if (!r.d || !r.p) continue;
      const lim = (r.w / 2 + 0.4) ** 2;
      for (let i = 0; i < r.p.length - 1; i++) {
        const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
        const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
        let t = ((px - ax) * ex + (pz - az) * ez) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if ((px - (ax + ex * t)) ** 2 + (pz - (az + ez * t)) ** 2 < lim) return true;
      }
    }
    return false;
  };
  for (let u = -A; u < A - 1e-6; u += CELL) {
    for (let v = -B; v < B - 1e-6; v += CELL) {
      const u1 = Math.min(A, u + CELL), v1 = Math.min(B, v + CELL);
      const q0 = at(u, v), q1 = at(u1, v), q2 = at(u1, v1), q3 = at(u, v1);
      // every corner, not the centre: a cell whose middle clears the kerb can
      // still hang a corner over it, and the apron and the deck are close
      // enough in height to z-fight along that strip
      if (onRoad(q0[0], q0[1]) || onRoad(q1[0], q1[1])
        || onRoad(q2[0], q2[1]) || onRoad(q3[0], q3[1])) continue;
      sink.quad(q0[0], y0 + 0.02, q0[1], q1[0], y0 + 0.02, q1[1],
        q2[0], y0 + 0.02, q2[1], q3[0], y0 + 0.02, q3[1], 0.62, 0.62, 0.63);
    }
  }
  sink.at(SURF.concrete);
  // four columns
  const CH = 5.2;
  for (const [u, v] of [[-8.4, -4.6], [8.4, -4.6], [-8.4, 4.6], [8.4, 4.6]]) {
    const [px, pz] = at(u, v);
    for (const [ox, oz] of [[ux, uz], [dx, dz]]) {
      sink.quad(px - ox * 0.16, y0, pz - oz * 0.16, px + ox * 0.16, y0, pz + oz * 0.16,
        px + ox * 0.16, y0 + CH, pz + oz * 0.16, px - ox * 0.16, y0 + CH, pz - oz * 0.16,
        sr, sg, sb);
    }
  }
  // the canopy: a slab with a coloured fascia all the way round
  const CA = 10, CB = 6.4, FT = 0.9;
  const q = [at(-CA, -CB), at(CA, -CB), at(CA, CB), at(-CA, CB)];
  sink.quad(q[0][0], y0 + CH, q[0][1], q[1][0], y0 + CH, q[1][1],
    q[2][0], y0 + CH, q[2][1], q[3][0], y0 + CH, q[3][1], cr, cg, cb);      // soffit
  sink.quad(q[3][0], y0 + CH + FT, q[3][1], q[2][0], y0 + CH + FT, q[2][1],
    q[1][0], y0 + CH + FT, q[1][1], q[0][0], y0 + CH + FT, q[0][1], cr, cg, cb); // roof
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    sink.quad(a[0], y0 + CH, a[1], b[0], y0 + CH, b[1],
      b[0], y0 + CH + FT, b[1], a[0], y0 + CH + FT, a[1], br2, bg2, bb2);
    sink.quad(b[0], y0 + CH, b[1], a[0], y0 + CH, a[1],
      a[0], y0 + CH + FT, a[1], b[0], y0 + CH + FT, b[1], br2, bg2, bb2);
  }
  // two pump islands, two pumps each
  for (const v of [-2.6, 2.6]) {
    const i0 = at(-5.2, v), i1 = at(5.2, v);
    sink.quad(i0[0], y0 + 0.02, i0[1], i1[0], y0 + 0.02, i1[1],
      i1[0], y0 + 0.18, i1[1], i0[0], y0 + 0.18, i0[1], 0.78, 0.78, 0.76);
    for (const u of [-3.2, 3.2]) {
      const [px, pz] = at(u, v);
      for (const [ox, oz] of [[ux, uz], [dx, dz]]) {
        sink.quad(px - ox * 0.45, y0 + 0.18, pz - oz * 0.45, px + ox * 0.45, y0 + 0.18, pz + oz * 0.45,
          px + ox * 0.45, y0 + 1.9, pz + oz * 0.45, px - ox * 0.45, y0 + 1.9, pz - oz * 0.45,
          sr, sg, sb);
      }
      // the brand stripe across the pump's head
      const [hx, hz] = at(u, v);
      for (const [ox, oz] of [[ux, uz], [dx, dz]]) {
        sink.quad(hx - ox * 0.46, y0 + 1.5, hz - oz * 0.46, hx + ox * 0.46, y0 + 1.5, hz + oz * 0.46,
          hx + ox * 0.46, y0 + 1.85, hz + oz * 0.46, hx - ox * 0.46, y0 + 1.85, hz - oz * 0.46,
          br2, bg2, bb2);
      }
    }
  }
  // The totem, out at the kerb — a price pylon is read from the road, so it
  // belongs at the entrance rather than in the middle of the plot. Two things
  // it must not do: walk back into the carriageway the shift above just cleared,
  // and, when the node happened to sit on the far side, march off in the
  // opposite direction to the road it is advertising to.
  const stand = near
    ? Math.min(A + 1.4, Math.max(0, Math.max(gap, NEED) - qw / 2 - 1.6))
    : A + 1.4;
  const [tx2, tz2] = at(-stand * away, -B - 1.0);
  for (const [ox, oz] of [[ux, uz], [dx, dz]]) {
    sink.quad(tx2 - ox * 0.14, y0, tz2 - oz * 0.14, tx2 + ox * 0.14, y0, tz2 + oz * 0.14,
      tx2 + ox * 0.14, y0 + 5.4, tz2 + oz * 0.14, tx2 - ox * 0.14, y0 + 5.4, tz2 - oz * 0.14,
      sr, sg, sb);
  }
  for (const flip of [1, -1]) {
    sink.quad(tx2 - ux * 1.0 * flip, y0 + 4.0, tz2 - uz * 1.0 * flip,
      tx2 + ux * 1.0 * flip, y0 + 4.0, tz2 + uz * 1.0 * flip,
      tx2 + ux * 1.0 * flip, y0 + 6.2, tz2 + uz * 1.0 * flip,
      tx2 - ux * 1.0 * flip, y0 + 6.2, tz2 - uz * 1.0 * flip, br2, bg2, bb2);
  }
  if (terrain) sink.fixFrom(mark);
}

// ---- a forecourt under its MAPPED canopy (round 8) ------------------------
// When OSM maps the canopy (building=roof, the tile's t 'roof'), the tile hook
// (js/d11services.js liftCanopies) has lifted that roof onto clear height and
// framed the node on it (poi.cv, poi.cr its ring, poi.ch its underside). The
// real roof is drawn by the building mesher; this adds what stands under it:
// the apron, the pump islands along the lanes (js/forecourt.js islandsOf,
// the same spots the pump in main.js answers to), columns, a fascia in the
// brand's colour round the roof's own outline, and the totem.
function canopyFuelInto(sink, poi, cell, terrain) {
  const fr = forecourtFrame(poi, cell.roads, _fuelFr);
  const x = fr.x, z = fr.z, lx = fr.lx, lz = fr.lz, cx = fr.cx, cz = fr.cz;
  const y0 = terrain ? terrain.heightAt(x, z) : 0;
  const ch = poi.ch ?? 4.5, cd = poi.cd ?? 2.4;
  // the roof's own ground (terrain.groundFor, what the building mesher stands
  // it on), so the fascia meets its slab on a slope too
  const gb = terrain && poi.cr ? groundFor({ o: poi.cr }, terrain) : y0;
  const mark = sink.mark();
  const brand = FUEL_BRANDS.find((b) => b.re.test(poi.n ?? '')) ?? { col: 0x2f6ea8, trim: 0xf4f6f5 };
  const at = (a, b) => [x + lx * a + cx * b, z + lz * a + cz * b];
  _c.setHex(brand.col); const br2 = _c.r, bg2 = _c.g, bb2 = _c.b;
  _c.setHex(brand.trim); const tr2 = _c.r, tg2 = _c.g, tb2 = _c.b;
  _c.setHex(0x9aa0a6); const sr = _c.r, sg = _c.g, sb = _c.b;
  const ring = poi.cr;
  const inside = (px, pz) => {
    if (!ring) return true;
    let inn = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
      if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inn = !inn;
    }
    return inn;
  };
  const onRoad = (px, pz) => {
    for (const r of cell.roads) {
      if (!r.d || !r.p) continue;
      const lim = (r.w / 2 + 0.4) ** 2;
      for (let i = 0; i < r.p.length - 1; i++) {
        const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
        const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
        let t = ((px - ax) * ex + (pz - az) * ez) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if ((px - (ax + ex * t)) ** 2 + (pz - (az + ez * t)) ** 2 < lim) return true;
      }
    }
    return false;
  };
  // the apron: 2 m cells under the roof that no road already paves
  sink.at(SURF.paving);
  const CELL = 2, A = fr.LA, B = fr.LB;
  for (let a = -A; a < A - 1e-6; a += CELL) {
    for (let b = -B; b < B - 1e-6; b += CELL) {
      const a1 = Math.min(A, a + CELL), b1 = Math.min(B, b + CELL);
      const q0 = at(a, b), q1 = at(a1, b), q2 = at(a1, b1), q3 = at(a, b1);
      if (!inside((q0[0] + q2[0]) / 2, (q0[1] + q2[1]) / 2)) continue;
      if (onRoad(q0[0], q0[1]) || onRoad(q1[0], q1[1])
        || onRoad(q2[0], q2[1]) || onRoad(q3[0], q3[1])) continue;
      sink.quad(q0[0], y0 + 0.02, q0[1], q3[0], y0 + 0.02, q3[1],
        q2[0], y0 + 0.02, q2[1], q1[0], y0 + 0.02, q1[1], 0.62, 0.62, 0.63);
    }
  }
  sink.at(SURF.concrete);
  const post = (px, pz, y1, w, r, g, b) => {
    for (const [ox, oz] of [[lx, lz], [cx, cz]]) {
      sink.quad(px - ox * w, y0, pz - oz * w, px + ox * w, y0, pz + oz * w,
        px + ox * w, y1, pz + oz * w, px - ox * w, y1, pz - oz * w, r, g, b);
      sink.quad(px + ox * w, y0, pz + oz * w, px - ox * w, y0, pz - oz * w,
        px - ox * w, y1, pz - oz * w, px + ox * w, y1, pz + oz * w, r, g, b);
    }
  };
  // columns at the frame's corners, where the roof is over them
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const [px, pz] = at(a * Math.max(0, A - 1.6), b * Math.max(0, B - 1.4));
    if (inside(px, pz)) post(px, pz, gb + ch, 0.18, sr, sg, sb);
  }
  // the fascia: the brand's cladding round the roof's own outline, just proud
  // of the slab the building mesher draws (it would show a storey of windows),
  // both faces: a stripe of the trim colour along the bottom, the brand above
  if (ring) {
    const band = (ax, az, bx, bz, ya, yb, r, g, b) => {
      sink.quad(ax, ya, az, bx, ya, bz, bx, yb, bz, ax, yb, az, r, g, b);
      sink.quad(bx, ya, bz, ax, ya, az, ax, yb, az, bx, yb, bz, r, g, b);
    };
    let sx = 0, sz = 0;
    for (const q of ring) { sx += q[0]; sz += q[1]; }
    sx /= ring.length; sz /= ring.length;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const p0 = ring[j], p1 = ring[i];
      const o0 = Math.hypot(p0[0] - sx, p0[1] - sz) || 1, o1 = Math.hypot(p1[0] - sx, p1[1] - sz) || 1;
      const ax = p0[0] + (p0[0] - sx) / o0 * 0.06, az = p0[1] + (p0[1] - sz) / o0 * 0.06;
      const bx = p1[0] + (p1[0] - sx) / o1 * 0.06, bz = p1[1] + (p1[1] - sz) / o1 * 0.06;
      band(ax, az, bx, bz, gb + ch - 0.02, gb + ch + 0.4, tr2, tg2, tb2);
      band(ax, az, bx, bz, gb + ch + 0.4, gb + ch + cd + 0.03, br2, bg2, bb2);
    }
  }
  // the islands along the lanes, two pumps each with the brand stripe
  const isl = islandsOf(fr);
  for (const b of isl.across) {
    const i0 = at(-isl.half, b - 0.6), i1 = at(isl.half, b - 0.6);
    const i2 = at(isl.half, b + 0.6), i3 = at(-isl.half, b + 0.6);
    sink.quad(i0[0], y0 + 0.18, i0[1], i3[0], y0 + 0.18, i3[1],
      i2[0], y0 + 0.18, i2[1], i1[0], y0 + 0.18, i1[1], 0.78, 0.78, 0.76);
    for (const [e0, e1] of [[i0, i1], [i1, i2], [i2, i3], [i3, i0]]) {
      sink.quad(e0[0], y0 + 0.02, e0[1], e1[0], y0 + 0.02, e1[1],
        e1[0], y0 + 0.18, e1[1], e0[0], y0 + 0.18, e0[1], 0.72, 0.72, 0.7);
    }
    for (const a of [-isl.pump, isl.pump]) {
      const [px, pz] = at(a, b);
      for (const [ox, oz, w] of [[lx, lz, 0.45], [cx, cz, 0.3]]) {
        for (const s2 of [1, -1]) {
          sink.quad(px - ox * w * s2, y0 + 0.18, pz - oz * w * s2, px + ox * w * s2, y0 + 0.18, pz + oz * w * s2,
            px + ox * w * s2, y0 + 1.9, pz + oz * w * s2, px - ox * w * s2, y0 + 1.9, pz - oz * w * s2,
            sr, sg, sb);
          sink.quad(px - ox * (w + 0.01) * s2, y0 + 1.5, pz - oz * (w + 0.01) * s2,
            px + ox * (w + 0.01) * s2, y0 + 1.5, pz + oz * (w + 0.01) * s2,
            px + ox * (w + 0.01) * s2, y0 + 1.85, pz + oz * (w + 0.01) * s2,
            px - ox * (w + 0.01) * s2, y0 + 1.85, pz - oz * (w + 0.01) * s2, br2, bg2, bb2);
        }
      }
    }
  }
  // the totem, at the lane entrance off the roof's corner
  const [tx2, tz2] = at(-A - 3.0, -B - 1.5);
  post(tx2, tz2, y0 + 5.4, 0.14, sr, sg, sb);
  for (const flip of [1, -1]) {
    sink.quad(tx2 - cx * 1.0 * flip, y0 + 4.0, tz2 - cz * 1.0 * flip,
      tx2 + cx * 1.0 * flip, y0 + 4.0, tz2 + cz * 1.0 * flip,
      tx2 + cx * 1.0 * flip, y0 + 6.2, tz2 + cz * 1.0 * flip,
      tx2 - cx * 1.0 * flip, y0 + 6.2, tz2 - cz * 1.0 * flip, br2, bg2, bb2);
  }
  if (terrain) sink.fixFrom(mark);
}
const _fuelFr = {};

// ---- fences, walls, noise barriers: the lines that divide one plot ---------
// 88 200 of them across the world, and until now the world had none — every
// garden ran into its neighbour's and an industrial yard had no edge at all.
// Drawn as a double-sided ribbon standing on the ground, following the terrain
// at 2 m so a fence on a slope steps with the hill instead of floating off it.
// Posts every ~2.5 m on the solid kinds; the see-through ones (chain link,
// railings) are a thinner sheet in a paler tone, which reads correctly at the
// distance you ever see them from.
const BARRIER_SPEC = {
  fence:     { h: 1.7, col: 0x8a7a5f, post: 0x6e6047, step: 2.5 },
  wall:      { h: 2.0, col: 0x9a9489, post: null,     step: 0 },
  retaining: { h: 1.4, col: 0x8d8880, post: null,     step: 0 },
  citywall:  { h: 4.5, col: 0x8f8779, post: null,     step: 0 },
  noise:     { h: 3.2, col: 0x7d8288, post: 0x5a5f65, step: 4.0 },
  guard:     { h: 0.75, col: 0xa9adb2, post: 0x6f757b, step: 4.0 },
  jersey:    { h: 0.9, col: 0xb4b0a6, post: null,     step: 0 },
  handrail:  { h: 1.0, col: 0x9298a0, post: 0x6f757b, step: 2.0 },
};
// Bottom and top of a retaining wall at (x, z), its line's normal (nx, nz):
// the ground 1.5 m either side decides. A real step (over 0.4 m) gets the
// wall from the low side up to 0.9 m over the high side (a parapet); on level
// ground the tagged height stands, capped 1.4 m over the higher side.
const RETAIN_PROBE = 1.5;
function retainSpan(terrain, x, z, nx, nz, H, g) {
  const a = terrain.heightAt(x + nx * RETAIN_PROBE, z + nz * RETAIN_PROBE);
  const b = terrain.heightAt(x - nx * RETAIN_PROBE, z - nz * RETAIN_PROBE);
  const lo = Math.min(a, b, g), hi = Math.max(a, b);
  if (hi - lo >= 0.4) return [lo - 0.1, hi + 0.9];
  return [g - 0.1, Math.min(g - 0.1 + H, hi + 1.4)];
}
function barrierInto(sink, f, terrain, city) {
  const spec = BARRIER_SPEC[f.k];
  if (!spec || !f.p || f.p.length < 2 || !terrain) return;
  const H = f.h ?? spec.h;
  sink.at(SURF.concrete);
  _c.setHex(spec.col);
  const r = _c.r, g = _c.g, b = _c.b;
  const balustrade = rasinovoParapet(f);
  const roads = f.k === 'noise' ? wallRoads(city, f) : null;
  const base = (x, z, tx, tz) => roads?.size
    ? roadsideLevel(roads, x, z, tx, tz, terrain) : terrain.heightAt(x, z);
  const mark = sink.mark();
  const thin = f.se ? 0.02 : 0.06;          // see-through kinds are a sheet
  for (let i = 0; i < f.p.length - 1; i++) {
    const [ax, az] = f.p[i], [bx, bz] = f.p[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.2 || L > 400) continue;       // a broken vertex is not a fence
    const n = Math.max(1, Math.min(60, Math.ceil(L / 2)));
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    const px2 = -uz * thin, pz2 = ux * thin;
    for (let k = 0; k < n; k++) {
      const t0 = k / n, t1 = (k + 1) / n;
      const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0;
      const x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
      let g0 = base(x0, z0, ux, uz) - 0.1, g1 = base(x1, z1, ux, uz) - 0.1;
      let h0 = g0 + H, h1 = g1 + H;
      // A RETAINING wall holds ground up: it stands from the low side's
      // ground to just over the high side's. Drawn standing UP from the line
      // like a garden wall, the two h=8 quay walls under Rašínovo nábřeží
      // towered 8 m over the street; sampled either side, they are the 5 m
      // face of the embankment with a parapet on top.
      if (f.k === 'retaining') {
        [g0, h0] = retainSpan(terrain, x0, z0, -uz, ux, H, g0 + 0.1);
        [g1, h1] = retainSpan(terrain, x1, z1, -uz, ux, H, g1 + 0.1);
      }
      if (balustrade) {
        h0 -= 0.9; h1 -= 0.9;
        balustradeInto(sink, x0, z0, x1, z1, h0, h1, -uz, ux);
      }
      // both faces, so a fence reads from the garden as well as from the street
      for (const e of [1, -1]) {
        sink.quad(x0 + px2 * e, g0, z0 + pz2 * e, x1 + px2 * e, g1, z1 + pz2 * e,
          x1 + px2 * e, h1, z1 + pz2 * e, x0 + px2 * e, h0, z0 + pz2 * e, r, g, b);
        sink.quad(x0 + px2 * e, h0, z0 + pz2 * e, x1 + px2 * e, h1, z1 + pz2 * e,
          x1 + px2 * e, g1, z1 + pz2 * e, x0 + px2 * e, g0, z0 + pz2 * e, r, g, b);
      }
      // and a cap, so the top is not a paper edge seen from above
      sink.quad(x0 - px2, h0, z0 - pz2, x1 - px2, h1, z1 - pz2,
        x1 + px2, h1, z1 + pz2, x0 + px2, h0, z0 + pz2, r, g, b);
    }
    // posts, on the kinds that have them
    if (spec.post && spec.step) {
      _c.setHex(spec.post);
      const pr = _c.r, pg = _c.g, pb = _c.b;
      const np = Math.min(40, Math.floor(L / spec.step));
      for (let k2 = 0; k2 <= np; k2++) {
        const t = np ? k2 / np : 0;
        const x2 = ax + (bx - ax) * t, z2 = az + (bz - az) * t;
        const gy = base(x2, z2, ux, uz) - 0.1;
        const w = 0.05;
        for (const [ox, oz] of [[ux, uz], [-uz, ux]]) {
          for (const flip of [1, -1]) {
            sink.quad(x2 - ox * w * flip, gy, z2 - oz * w * flip,
              x2 + ox * w * flip, gy, z2 + oz * w * flip,
              x2 + ox * w * flip, gy + H + 0.06, z2 + oz * w * flip,
              x2 - ox * w * flip, gy + H + 0.06, z2 - oz * w * flip, pr, pg, pb);
          }
        }
      }
      _c.setHex(spec.col);
    }
  }
  sink.fixFrom(mark);
}

// ---- retardéry: a ridge across the carriageway -----------------------------
// A bump is 8 cm of asphalt and it changes how a residential street DRIVES,
// which is what makes it worth its four quads. Bound to the road the OSM node
// sits on so it spans the actual lanes and tilts with the deck.
function bumpInto(sink, node, cell, terrain) {
  const [x, z] = node.p[0];
  let road = null, ux = 0, uz = 1, s0 = 0, best = 6 * 6;
  for (const r of cell.roads) {
    if (!r.d || !r.p || r.p.length < 2) continue;
    let along = 0;
    for (let i = 0; i < r.p.length - 1; i++) {
      const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
      const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
      let t = ((x - ax) * ex + (z - az) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d2 = (x - (ax + ex * t)) ** 2 + (z - (az + ez * t)) ** 2;
      const L = Math.sqrt(L2);
      if (d2 < best) { best = d2; road = r; ux = ex / L; uz = ez / L; s0 = along + L * t; }
      along += L;
    }
  }
  if (!road || !terrain) return;
  const gy = road.br ? bridgeDeckHeight(road, s0, terrain) : roadGradeY(road, s0, terrain);
  if (gy === null || gy === undefined) return;
  const y = gy + LAYER_Y.road;
  const hw = (road.w ?? 6) / 2 - 0.1;
  const px2 = -uz, pz2 = ux;
  // a table is long and flat, a bump is short and abrupt
  const half = node.k === 'table' ? 2.2 : node.k === 'hump' ? 1.6 : 0.9;
  const rise = node.k === 'table' ? 0.10 : 0.08;
  sink.at(SURF.asphalt);
  _c.setHex(0x53565b);
  const r0 = _c.r, g0 = _c.g, b0 = _c.b;
  const mark = sink.mark();
  const P = (o, w) => [x + ux * o + px2 * w, z + uz * o + pz2 * w];
  for (const seg of [[-half, 0], [0, half]]) {
    const [a, b] = seg;
    const ya = a === 0 ? y + rise : y;
    const yb = b === 0 ? y + rise : y;
    const [ax0, az0] = P(a, -hw), [ax1, az1] = P(a, hw);
    const [bx0, bz0] = P(b, -hw), [bx1, bz1] = P(b, hw);
    paintQuad(sink, ax0, ya, az0, bx0, yb, bz0, bx1, yb, bz1, ax1, ya, az1, r0, g0, b0);
  }
  // the white warning chevrons Czech bumps carry
  sink.at(SURF.paint);
  _c.setHex(COLORS.marking);
  const mr = _c.r, mg = _c.g, mb = _c.b;
  for (let i = -2; i <= 2; i++) {
    const w0 = i * (hw / 2.6), w1 = w0 + hw / 5.5;
    if (Math.abs(w1) > hw) continue;
    const [q0x, q0z] = P(-0.25, w0), [q1x, q1z] = P(-0.25, w1);
    const [q2x, q2z] = P(0.25, w1), [q3x, q3z] = P(0.25, w0);
    paintQuad(sink, q0x, y + rise + 0.012, q0z, q1x, y + rise + 0.012, q1z,
      q2x, y + rise + 0.012, q2z, q3x, y + rise + 0.012, q3z, mr, mg, mb);
  }
  sink.fixFrom(mark);
}

// ---- road signs ---------------------------------------------------------------
// A sign is a round galvanised post standing on the pavement and one or two
// plates on it. The post is steel in the chunk sink; the plates are quads in
// the textured sink, showing a face of the street atlas (js/signatlas.js: real
// Czech signs, painted once) with the same plate's grey back behind it.
const SIGN_H = 2.3, SIGN_H2 = 2.72;       // centre of the top plate: one plate, two
function signInto(sink, deco, stand, px, pz, dx, dz, a, b) {
  const y0 = stand ? stand.heightAt(px, pz) : 0;
  const H = b ? SIGN_H2 : SIGN_H;
  // RIGID, like every other fixture (wireSpan, pylonInto, busStopInto): one
  // height for the whole sign, and the chunk-wide drape is told to skip it.
  const mark = sink.mark();
  sink.at(SURF.concrete);
  _c.setHex(0x8a8d92);                            // galvanised
  kitDrum(sink, px, pz, y0, y0 + 0.05, 0.075, 0.05, 6, _c.r * 0.8, _c.g * 0.8, _c.b * 0.8, 1);
  kitPost(sink, px, pz, y0 + 0.05, y0 + H + SIGN_M * 0.34, 0.03, _c.r, _c.g, _c.b);
  if (stand) sink.fixFrom(mark);                  // absolute heights: the drape must skip them
  if (!deco) return;
  // the plate looks AGAINST the travel it speaks to, a thumb proud of the post
  const fx = -dx, fz = -dz, o = 0.046;
  deco.panel(a, px + fx * o, y0 + H, pz + fz * o, SIGN_M, SIGN_M, fx, fz, 'back:' + a);
  if (b) deco.panel(b, px + fx * o, y0 + H - SIGN_M * 0.88, pz + fz * o, SIGN_M * 0.9, SIGN_M * 0.9, fx, fz, 'back:' + b);
}

// one SURVEYED sign (an OSM node, which sits on the way at the stop line):
// pushed to the right kerb of the travel it governs, facing the oncoming driver
function signPost(sink, deco, sg, cell, stand) {
  const [x, z] = sg.p[0];
  // face against the travel of the nearest drivable road, from its right kerb
  let dx = 0, dz = -1, hw = 3;
  let best = 36;                                  // (6 m)² — orphans face north
  for (const r of cell.roads) {
    if (!r.d || !r.p) continue;
    for (let i = 0; i < r.p.length - 1; i++) {
      const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
      const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
      let t = ((x - ax) * ex + (z - az) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + ex * t, qz = az + ez * t;
      const d2 = (x - qx) ** 2 + (z - qz) ** 2;
      if (d2 < best) {
        best = d2;
        const L = Math.sqrt(L2);
        dx = ex / L; dz = ez / L;
        hw = (r.w ?? 6) / 2;
      }
    }
  }
  const px = x - dz * (hw + 0.75), pz = z + dx * (hw + 0.75);   // right of travel
  signInto(sink, deco, stand, px, pz, dx, dz,
    sg.k === 'give_way' ? 'give_way' : sg.k === 'stop' ? 'stop' : 'main_road');
}

const LAMP_STEP = 34, LAMP_MIN_W = 5.4;
// clearance a mast keeps from any OTHER carriageway: its own base radius plus
// enough that a wing mirror does not find it
const LAMP_CLEAR = 0.45;
// A generated lamp this close to a surveyed one IS that lamp: where OSM has the
// columns, the every-34-metres rule stands down instead of doubling them.
const LAMP_NEAR = 18;
// Lanterns along a pedestrian street or an obytná zóna: lower, so closer.
const PARK_STEP = 26;
// How far from a kerb a surveyed lamp may stand and still be that street's lamp.
const LAMP_REACH = 5;

/**
 * What a mast placed from this cell could be standing in: every carriageway
 * and every junction pad of the 3x3 cells round it, not the cell's own lists.
 * A lamp is offset up to a road's half width from a point INSIDE the cell, so
 * it can land across the border, and roads are bucketed by bounding box and
 * pads by their node: the neighbour's tertiary and its crossing were in
 * neither of this cell's lists, and a column stood on that road's centreline
 * (chunk 9,-7; over the Pardubice tile 8 lamps in a carriageway and 15 on a
 * pad, every pad one from a neighbouring key). js/chunkspec.js ships the same
 * nine road lists and the same nine pad buckets, so the worker agrees.
 */
function lampGround(city, cell, key, raw = false) {
  const roads = [], pads = [], seen = new Set();
  const c = key.indexOf(','), cx = +key.slice(0, c), cz = +key.slice(c + 1);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const k = (cx + dx) + ',' + (cz + dz);
    const nb = k === key ? cell : city?.chunkIndex?.get(k);
    // one way lies in every cell its bbox touches: once is enough
    for (const r of nb?.roads ?? []) if (r.d && r.p && !seen.has(r)) { seen.add(r); roads.push(r); }
    // (`raw`: the buckets as they stand, see lampPlan)
    for (const j of (raw ? JUNCTIONS.get(k) : junctionsIn(k)) ?? []) pads.push(j);
    for (const j of (raw ? CLUSTERS.get(k) : clustersIn(k)) ?? []) pads.push(j);
  }
  return { roads, pads };
}

/**
 * Is (x, z) on the asphalt of a carriageway other than `self`: its lanes, grown
 * by `grow`, or a bus lay-by beside them. onCarriageway() knows the lanes only,
 * and a lay-by is three more metres of road where a bus pulls in.
 */
function lampInRoad(roads, self, x, z, grow) {
  for (const o of roads) {
    if (o === self) continue;
    const half = (o.w ?? 3) / 2 + grow, b = o._bays;
    if (half <= 0) continue;
    // the widest any of its lay-bys gets: bayAt at the middle of the first one
    const reach = half + (b?.length ? bayAt(o, b[0], b[1]) : 0);
    const bb = bboxOfLine(o);
    if (x < bb[0] - reach || x > bb[2] + reach || z < bb[1] - reach || z > bb[3] + reach) continue;
    let run = 0;
    for (let k = 0; k < o.p.length - 1; k++) {
      const ax = o.p[k][0], az = o.p[k][1], ex = o.p[k + 1][0] - ax, ez = o.p[k + 1][1] - az;
      const L2 = ex * ex + ez * ez || 1e-9;
      const tu = ((x - ax) * ex + (z - az) * ez) / L2, t = tu < 0 ? 0 : tu > 1 ? 1 : tu;
      const d = Math.hypot(x - ax - ex * t, z - az - ez * t);
      if (d < half) return true;
      if (reach > half) {
        const L = Math.sqrt(L2);
        // Only abreast of this segment, where d is a true distance off the
        // centreline: measured to a segment END it is a slant, and a mast
        // behind the taper of its own lay-by read as standing in it.
        if (tu >= 0 && tu <= 1 && d < reach
          && d < half + bayAt(o, run + L * t, (x - ax) * ez - (z - az) * ex >= 0 ? 1 : -1)) return true;
        run += L;
      }
    }
  }
  return false;
}

// How far past the edge of its cell a mast can be planted: half the widest
// carriageway, a lay-by and the kerb offset come to ten metres.
const LAMP_OVER = 14;
/**
 * The houses of a NEIGHBOURING cell that a mast planted from the cell
 * (x0, z0)-(x1, z1) could come up through, as bare outlines. A mast offset
 * across the border stands among the next cell's houses, and a house that
 * does not reach into this cell is in the next cell's list alone (19 masts in
 * the walls of one, the deepest 2.1 m, over the 53 000 cells of tile -24_2).
 * The worker is sent a neighbour's roads and not its buildings, so
 * js/chunkspec.js sends it this list as `houses`, and the main thread reads
 * the same list here: the two cannot plan different lamps.
 */
export function lampHouses(nb, x0, z0, x1, z1) {
  const out = [];
  for (const b of nb?.buildings ?? []) {
    if (!b.o || b.o.length < 3) continue;
    const bb = bboxOfRing(b);
    if (bb[2] < x0 - LAMP_OVER || bb[0] > x1 + LAMP_OVER
      || bb[3] < z0 - LAMP_OVER || bb[1] > z1 + LAMP_OVER) continue;
    out.push(b.i?.length ? { o: b.o, i: b.i } : { o: b.o });
  }
  return out;
}

/** Is (x, z) inside the footprint of one of these buildings (courtyards are not)? */
function lampInHouse(houses, x, z) {
  for (const b of houses) {
    if (!b.o || b.o.length < 3) continue;
    const bb = bboxOfRing(b);
    if (x < bb[0] || x > bb[2] || z < bb[1] || z > bb[3]) continue;
    if (!pointInPolygon(x, z, b.o)) continue;
    let yard = false;
    for (const h of b.i ?? []) if (pointInPolygon(x, z, h)) { yard = true; break; }
    if (!yard) return true;
  }
  return false;
}

/**
 * Every lamp this chunk owns, as lists of [x, z, rot]: STREET columns (rot
 * faces the carriageway, the arm reaches over it), PARK lanterns, and the
 * D11's interchange masts, MAST (two arms) and MAST1 (one; js/mastlamps.js).
 *
 * Three sources, in order of trust: the lamps OSM surveyed (cell.furniture,
 * which used to be drawn as bare unlit masts), the every-34-metres rule along
 * the wider carriageways, and lanterns along pedestrian and living streets.
 */
function lampSpots(cell, key, x0, z0, x1, z1, terrain, city, raw = false) {
  const street = [], park = [], mapped = [], mast = [], mast1 = [];
  for (const f of cell.furniture ?? []) if (f.k === 'lamp') mapped.push(f.p[0][0], f.p[0][1]);
  const nearMapped = (x, z) => {
    for (let i = 0; i < mapped.length; i += 2) {
      if ((mapped[i] - x) ** 2 + (mapped[i + 1] - z) ** 2 < LAMP_NEAR * LAMP_NEAR) return true;
    }
    return false;
  };
  // The asphalt of a junction is carriageway too, and no way's own half width
  // says so: a big crossing is one pad from kerb to kerb, and a column placed
  // off the edge of one arm stood in the middle of it (8 of the 504 lamps
  // around the old town and Palackého, base under the asphalt).
  // (And the pad may be a neighbouring cell's: see lampGround.)
  const { roads: near, pads } = lampGround(city, cell, key, raw);
  const onPad = (x, z) => { const j = inPads(pads, x, z); return !!j && cornerLift(j, x, z) < 0; };
  // A COLUMN DOES NOT COME UP THROUGH A HOUSE. The kerb offset knows nothing of
  // what stands behind the kerb, and where a facade is on the building line a
  // 7.5 m mast grew out of the roof of a 4.3 m house with its arm and its pool
  // of light over it (50 of 3 998 lamps on the Pardubice tile, 28 of them more
  // than half a metre inside the walls).
  // The houses of the cell the spot is IN: a building is listed in every cell
  // its outline reaches, so that one list holds every house the spot can be
  // inside. For a spot across the border it is the neighbour's (lampHouses).
  const over = new Map();
  const inHouse = (x, z) => {
    const k = chunkKey(x, z);
    if (k === key) return lampInHouse(cell.buildings ?? [], x, z);
    let hs = over.get(k);
    if (hs === undefined) {
      const nb = city?.chunkIndex?.get(k);
      over.set(k, hs = nb?.houses ?? lampHouses(nb, x0, z0, x1, z1));
    }
    return lampInHouse(hs, x, z);
  };
  // 1. surveyed lamps: a column where a carriageway is within reach, turned to
  // face it; a lantern anywhere else (a park, a square, a path)
  for (let m = 0; m < mapped.length; m += 2) {
    const x = mapped[m], z = mapped[m + 1];
    if (chunkKey(x, z) !== key) continue;
    // Charles Bridge carries its own lanterns (js/landmarks-karluv.js): the
    // tile's lamps there stood on the riverbed under the arches
    if (inLandmark(null, x, z)) continue;
    let bd = LAMP_REACH, qx = 0, qz = 0, bh = 0, br = null, bs = 0, bex = 0, bez = 0;
    for (const r of near) {
      if ((r.w ?? 0) < 4.4) continue;
      const half = r.w / 2, bb = bboxOfLine(r), reach = half + LAMP_REACH;
      if (x < bb[0] - reach || x > bb[2] + reach || z < bb[1] - reach || z > bb[3] + reach) continue;
      let run = 0;
      for (let i = 0; i < r.p.length - 1; i++) {
        const ax = r.p[i][0], az = r.p[i][1], ex = r.p[i + 1][0] - ax, ez = r.p[i + 1][1] - az;
        const L2 = ex * ex + ez * ez || 1e-9;
        let t = ((x - ax) * ex + (z - az) * ez) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx2 = ax + ex * t, cz2 = az + ez * t;
        const d = Math.hypot(x - cx2, z - cz2) - half;
        const L = Math.sqrt(L2);
        if (d < bd) { bd = d; qx = cx2; qz = cz2; bh = half; br = r; bs = run + L * t; bex = ex; bez = ez; }
        run += L;
      }
    }
    if (bd >= LAMP_REACH) {
      park.push([x, z, rnd(Math.abs(Math.round(x * 7 + z * 13)), 3) * Math.PI * 2]);
      continue;
    }
    let nx = x - qx, nz = z - qz;
    const L = Math.hypot(nx, nz);
    if (L < 0.05) { nx = 1; nz = 0; } else { nx /= L; nz /= L; }
    // surveyed a little inside the kerb line (the node is a GPS fix, the kerb
    // is our own half width): it stands just behind the kerb instead
    // (the kerb line steps out round a bus lay-by, and the lamp with it)
    const bay = br.br ? 0 : bayAt(br, bs, nx * bez - nz * bex >= 0 ? 1 : -1);
    let lx = x, lz = z;
    if (br.br) {
      // A SURVEYED LAMP OF A BRIDGE STANDS ON ITS DECK. Placed like a street
      // lamp it stood at the terrain under its node, on the riverbed below
      // Palackého, Čechův, Štefánikův, Mánesův and most Legií (the nodes sit
      // on the parapet, up to 4.6 m past our carriageway). It goes where the
      // rule puts a bridge's own columns: on the deck's edge, at the deck.
      lx = qx + nx * (bh - 0.25); lz = qz + nz * (bh - 0.25);
      if (lampInRoad(near, br, lx, lz, LAMP_CLEAR)) continue;
      const spot = [lx, lz, Math.atan2(-nx, -nz) + Math.PI];
      if (terrain) spot.push(bridgeDeckHeight(br, bs, terrain) + LAYER_Y.road);
      street.push(spot);
      continue;
    }
    if (bd - bay < 0.5) { lx = qx + nx * (bh + bay + 0.6); lz = qz + nz * (bh + bay + 0.6); }
    if (lampInRoad(near, null, lx, lz, LAMP_CLEAR) || onPad(lx, lz) || inHouse(lx, lz)) continue;
    street.push([lx, lz, Math.atan2(-nx, -nz) + Math.PI]);
  }
  // 2. the rule: along the wider drivable roads, alternating kerbs.
  // EVERY way that passes through this cell, not only the ones that start in
  // it: a lamp belongs to the cell it stands in. (It used to be the way's home
  // chunk AND this cell, so a street was lit for the first hundred metres from
  // wherever OSM happened to begin it and black for the rest of its length:
  // main roads, cut into short ways at every junction, were lit, and the long
  // residential streets between them were not.) The walk is the same from the
  // way's first vertex whichever cell does it, so the cells agree on the spots.
  // (the D11 / D35 and their slip roads: the tall masts of js/mastlamps.js)
  const mastGuards = { terrain, near, inRoad: lampInRoad, onPad, inHouse, nearMapped, mast, mast1 };
  for (const r of cell.roads) {
    if (mastsAlong(r, mastKind(r), x0, z0, x1, z1, mastGuards)) continue;
    if (!r.d || r.w < LAMP_MIN_W || !r.p) continue;
    // on a bridge the column stands on the deck's edge, not in the air beside it
    const half = r.br ? r.w / 2 - 0.25 : r.w / 2 + 0.7;   // else just off the kerb
    let carry = (r._id % 17) * 2;            // stagger so junctions aren't twinned
    let nth = 0, run = 0;
    for (let i = 0; i < r.p.length - 1; i++) {
      const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
      let dx = bx - ax, dz = bz - az;
      const L = Math.hypot(dx, dz);
      if (L < 0.01) continue;
      dx /= L; dz /= L;
      for (let d = LAMP_STEP - carry; d < L; d += LAMP_STEP) {
        const px = ax + dx * d, pz = az + dz * d;
        const first = ((nth++ + (r._id % 2)) & 1) ? 1 : -1; // alternate kerbs
        if (px < x0 || px >= x1 || pz < z0 || pz >= z1) continue; // this cell only
        if (nearMapped(px, pz)) continue;
        // A LAMP STANDS ON THE KERB, NEVER IN THE ROAD. The offset is
        // perpendicular to THIS way, and wherever another carriageway runs
        // close (a junction, a slip road, the far half of a dual
        // carriageway) perpendicular to one road points straight into the
        // other. Measured over the Pardubice tile: 106 of 2 083 lamps stood
        // on a carriageway, 61 of them more than a metre in, the worst
        // 4.42 m inside a 9 m primary, which is the middle of it.
        //
        // So try the far kerb, and if that is in the road too, place no lamp
        // at all: one dark stretch of street is invisible, a mast in the
        // running lane is something you hit at fifty.
        //
        // The kerb is not always half a width out, either: at a bus lay-by it
        // steps out three metres, and a column 0.7 m past the lane edge stood
        // in the bay where the bus pulls in (32 of the 80 lay-bys on the
        // Pardubice tile). The offset steps out with the kerb. bayAt counts
        // sides by the ribbon's perpendicular, the opposite of `side` here.
        for (const side of [first, -first]) {
          const nx = -dz * side, nz = dx * side;
          const off = half + (r.br ? 0 : bayAt(r, run + d, -side));
          const lx = px + nx * off, lz = pz + nz * off;
          // Its OWN way is tested too (not on a deck, where the column stands
          // inside the width on purpose): on the inside of a sharp bend the
          // other leg of the same street comes closer than the kerb offset
          // (0.25 m into the lane at 3836,-1403). The leg it was offset from
          // is 0.7 m away and the clearance 0.45, so that one never objects.
          if (lampInRoad(near, r.br ? r : null, lx, lz, LAMP_CLEAR)
            || (!r.br && (onPad(lx, lz) || inHouse(lx, lz)))) continue;
          // rot faces the road: the post stands on the kerb, the head reaches in
          const spot = [lx, lz, Math.atan2(-nx, -nz) + Math.PI];
          if (r.br && terrain) spot.push(bridgeDeckHeight(r, run + d, terrain) + LAYER_Y.road);
          street.push(spot);
          break;
        }
      }
      carry = (carry + L) % LAMP_STEP;
      run += L;
    }
  }
  // 3. lanterns: a pedestrian street is lit from inside its own paving, an
  // obytná zóna from just outside its shared surface
  for (const r of cell.roads) {
    const ped = r.t === 'pedestrian';
    if ((!ped && r.t !== 'living_street') || r.br || !r.p || (r.w ?? 0) < 3.5 || r.w >= LAMP_MIN_W && !ped) continue;
    const off = ped ? Math.max(0.6, r.w / 2 - 0.6) : r.w / 2 + 0.6;
    let carry = (r._id % 11) * 2, nth = 0, run = 0;
    for (let i = 0; i < r.p.length - 1; i++) {
      const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
      let dx = bx - ax, dz = bz - az;
      const L = Math.hypot(dx, dz);
      if (L < 0.01) continue;
      dx /= L; dz /= L;
      for (let d = PARK_STEP - carry; d < L; d += PARK_STEP) {
        const px = ax + dx * d, pz = az + dz * d;
        const side = ((nth++ + (r._id % 2)) & 1) ? 1 : -1;
        if (px < x0 || px >= x1 || pz < z0 || pz >= z1) continue;
        // outside a shared surface means outside its lay-by too
        const o2 = ped ? off : off + bayAt(r, run + d, -side);
        const lx = px - dz * side * o2, lz = pz + dx * side * o2;
        if (nearMapped(lx, lz) || lampInRoad(near, r, lx, lz, LAMP_CLEAR) || onPad(lx, lz) || inHouse(lx, lz)) continue;
        park.push([lx, lz, rnd(r._id, 40 + nth) * Math.PI * 2]);
      }
      carry = (carry + L) % PARK_STEP;
      run += L;
    }
  }
  return { street, park, mast, mast1 };
}

/**
 * The lamps of one cell, for whoever has to know them WITHOUT building it:
 * js/farlights.js draws every lamp of the town as a point of light out to
 * three kilometres, and it kept a centreline copy of the walk above with none
 * of its guards, so a lamp this file had dropped (in a carriageway, a house, a
 * lay-by) still shone from the helicopter, on a mast that was not there.
 *
 * The same plan, with one difference: the pad buckets are read AS THEY STAND.
 * junctionsIn works a pad's kerb out on first use, from whatever the chunk
 * index holds at that moment (js/streets.js on WHEN), and a point of light two
 * kilometres off must not be what decides that moment for a crossing whose
 * neighbouring tile is not in yet. On a pad nobody has finished the corner
 * band is not known, so a lamp anywhere on its outline counts as on asphalt:
 * measured over the Pardubice tile with no pad finished and with all of them,
 * the 4 019 lamps come out the same, and once a chunk there has been built
 * the answer is the built one anyway.
 */
export function lampPlan(cell, key, terrain, city = null) {
  const c = key.indexOf(','), x0 = +key.slice(0, c) * CHUNK, z0 = +key.slice(c + 1) * CHUNK;
  return lampSpots(cell, key, x0, z0, x0 + CHUNK, z0 + CHUNK, terrain, city, true);
}

/**
 * One kind of lamp as two InstancedMeshes (the steel, the lens), standing on
 * whatever `stand` says is underfoot there: the pavement, not the ground it
 * was laid over.
 */
function lampBatch(group, spots, kind, mats, stand) {
  if (!spots.length) return;
  const [pg, hg] = lampGeoms(kind);
  // CLONED per chunk: unloading a chunk disposes its geometries
  const posts = new THREE.InstancedMesh(pg.clone(), mats.lampPost, spots.length);
  const heads = new THREE.InstancedMesh(hg.clone(), mats.lampHead, spots.length);
  posts.castShadow = true;
  const ys = [], flat = [];
  for (let i = 0; i < spots.length; i++) {
    const [px, pz, rot, deckY] = spots[i];
    const y = Math.round((deckY ?? (stand ? stand.heightAt(px, pz) : 0)) * 1000) / 1000;
    ys.push(y); flat.push(px, pz, rot);
    _q.setFromAxisAngle(_up, rot);
    _v.set(px, y, pz); _s.set(1, 1, 1);
    _m4.compose(_v, _q, _s);
    posts.setMatrixAt(i, _m4);
    heads.setMatrixAt(i, _m4);
  }
  posts.instanceMatrix.needsUpdate = true;
  heads.instanceMatrix.needsUpdate = true;
  // A mast is an OBJECT: you cannot drive through it and you can put it in
  // the road. poles.js needs to turn these instance rows back into things
  // with positions, so the positions travel WITH the batch: named so it can
  // find them, plain numbers so they survive the worker codec, and in
  // instance order so row i here is pole i there. `ys` is each base height
  // (lightpools.js hangs the glow from it), `kind` the shape that falls.
  // (a motorway mast: 'mastPosts' / 'mast1Posts', js/city.js LAMP_BATCHES)
  const stem = kind === 'street' ? 'lamp' : kind;
  posts.name = stem + 'Posts';
  heads.name = stem + 'Heads';
  posts.userData.spots = flat;
  posts.userData.ys = ys;
  posts.userData.kind = kind;
  group.add(posts, heads);
}

// ---- trees: js/treeshapes.js says which tree stands where and how big it is,
// and holds the far template every chunk instances. Nothing about a tree's
// shape lives here any more: this file only decides WHERE they grow.
const _spec = {};

// ---- forests: real trees where the data only says "green" ----
// A wood drawn as a flat polygon reads as PAINT the moment you drive past it.
// Kunětická hora and the Labe floodplain are supposed to feel like the woods
// of AmongTheWoods, so every wood/forest polygon — and every park big enough
// to be canopy rather than lawn — grows actual trees into the chunk's tree
// InstancedMeshes.
//
// The scatter is a jittered grid ANCHORED TO THE WORLD, not to the polygon
// bbox and not to the chunk: grid cell (gi,gj) always produces the same point
// for the same polygon, so a tree belongs to exactly ONE chunk (half-open rect
// test) and no rebuild — of this cell or of a lone neighbour — can duplicate,
// drop or shift it. Every draw hashes the polygon _id, never Math.random, so
// two machines streaming the same tile grow the identical forest.
const FOREST_STEP = Math.sqrt(55);        // ≈7.42 m grid → one candidate per 55 m²
const FOREST_INSET = 0.08;                // jitter window inset — trees in adjacent
const FOREST_JIT = 1 - 2 * FOREST_INSET;  // cells keep ≥0.16·step ≈ 1.2 m apart
const FOREST_CAP = 400;                   // per polygon per chunk: a 900 ha wood must
                                          // not outspend the cell it happens to cross
const PARK_WOODED = 4000;                 // m² — below this a "park" is lawn, and its
                                          // mapped natural=tree points are the trees
const WOOD_TYPES = new Set(['wood', 'forest']);
const FOREST_FLOOR = 0x3a4a30;            // shade + litter under a canopy, not meadow

// (polygon _id, grid cell) → seed for rnd(). Deliberately folded down to ~2^20:
// rnd() multiplies its id by 374761393 in DOUBLE precision, so a full 32-bit
// seed would lose the low bits of that product and neighbouring cells would
// draw correlated jitter (visible as trees marching in rows).
function forestSeed(id, gi, gj) {
  let h = Math.imul(id ^ 0x9e3779b1, 2654435761);
  h = Math.imul(h ^ Math.imul(gi, 0x27d4eb2d), 2246822519);
  h = Math.imul(h ^ Math.imul(gj, 0x165667b1), 3266489917);
  h ^= h >>> 15;
  return (h >>> 0) % 1000003;
}

// which green polygons deserve a canopy. Parks are area-gated because the OSM
// "park" bucket holds everything from Tyršovy sady down to a 200 m² traffic
// island — filling those with 7 m trees would bury the streets they decorate.
function woodedGreen(f) {
  if (!f.o || f.o.length < 3) return false;
  if (WOOD_TYPES.has(f.t)) return true;
  if (f.t !== 'park') return false;
  return (f._area ??= Math.abs(polygonArea(f.o))) >= PARK_WOODED;
}

// Scatter one wooded polygon's share of THIS chunk into `out` (the spots the
// tree instancer consumes). Candidates come from the world grid over the part
// of the polygon that reaches into the cell, then survive three rejects:
// inside the outline, outside every hole, and — because floodplain woods are
// mapped straight across the Labe — not standing in open water, which renders
// 2 m below them.
//
// The rings are CLIPPED to the cell once up front rather than point-tested
// against the full outline: a Labe wood carries thousands of nodes, and
// ~290 candidates × 3000 edges per chunk was a 50 ms build spike measured on
// the real tiles. Sutherland–Hodgman leaves the inside/outside answer exact
// for points within the rect (all of ours are, by the half-open test below)
// and hands back a ring that is usually a handful of vertices.
// ---- trees where NOBODY drew a polygon -------------------------------------
// scatterForest plants into OSM's landuse, and OSM's landuse is half the story:
// over two 4.8 km tiles beside Pardubice, 51–52 % of the ground carrying real
// canopy above 3 m has no green polygon on it at all. This is the other half,
// and it is measured rather than guessed — js/canopy.js holds ČÚZK's surface
// model minus its bare-earth model, so every sample says how tall the thing
// standing there is.
//
// Same lattice, same jitter, same half-open ownership as scatterForest, so a
// tree OSM knows about and one it does not land on the same grid and the two
// can never fight over a cell. Only the GATE differs: measured height instead
// of point-in-polygon.
//
// The raster does not know a spruce from a chimney, so four things are excluded
// by hand. Buildings, because a house is eight metres tall and reads exactly
// like a tree. Roads, because a trunk in the carriageway is worse than a
// missing wood. Water. And anything a green polygon already covers, because
// scatterForest has planted it.
const CANOPY_MIN = 3.5;                   // m — a hedge, and below that a bush
const CANOPY_ROAD = 1.2;                  // m of clearance beyond the kerb
// A mapped tree is its own canopy: the raster read ITS crown, so a measured
// tree within CANOPY_TWIN of it is the same tree counted twice (a third of the
// street trees had a second trunk beside them). A wood's lattice does not know
// about mapped points either, but only a trunk nearly touching one is wrong.
const CANOPY_TWIN = 5, FOREST_TWIN = 2.5; // m
function scatterCanopy(cell, x0, z0, x1, z1, waters, canopy, out) {
  if (!canopy) return;
  // Same contract as Terrain.missed: a chunk that wanted the canopy and did not
  // have it is a GUESS, and city.js rebuilds it when the raster lands. Without
  // this the woods would appear only where a chunk happened to be built late.
  if (!canopy.ready(x0 + 1, z0 + 1)) { canopy.missed = true; return; }
  const greens = (cell.green ?? []).filter(woodedGreen);
  const roads = (cell.roads ?? []).filter((r) => r.d);
  const gi0 = Math.floor(x0 / FOREST_STEP), gj0 = Math.floor(z0 / FOREST_STEP);
  let n = 0;
  for (let gi = gi0; gi * FOREST_STEP < x1; gi++) {
    for (let gj = gj0; gj * FOREST_STEP < z1; gj++) {
      if (n >= FOREST_CAP) return;
      // a salt of its own, so this lattice is independent of any polygon id
      const seed = forestSeed(0x9E3779B1, gi, gj);
      const x = (gi + FOREST_INSET + FOREST_JIT * rnd(seed, 1)) * FOREST_STEP;
      const z = (gj + FOREST_INSET + FOREST_JIT * rnd(seed, 2)) * FOREST_STEP;
      if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
      const h = canopy.heightAt(x, z);
      if (h < CANOPY_MIN) continue;
      let ok = true;
      for (const g of greens) if (pointInPolygon(x, z, g.o)) { ok = false; break; }
      if (ok) for (const b of cell.buildings ?? []) {
        const bb = bboxOfRing(b);
        if (x < bb[0] || x > bb[2] || z < bb[1] || z > bb[3]) continue;
        if (pointInPolygon(x, z, b.o)) { ok = false; break; }
      }
      if (ok) for (const r of roads) {
        const half = (r.w ?? 3) / 2 + CANOPY_ROAD;
        const bb = bboxOfLine(r);
        if (x < bb[0] - half || x > bb[2] + half || z < bb[1] - half || z > bb[3] + half) continue;
        for (let i = 0; i < r.p.length - 1 && ok; i++) {
          if (distPointToSegment(x, z, r.p[i][0], r.p[i][1], r.p[i + 1][0], r.p[i + 1][1], null) < half) ok = false;
        }
        if (!ok) break;
      }
      if (ok && waters.length && inWater(x, z, waters)) ok = false;
      if (!ok) continue;
      // the measured height IS the tree's height — no more guessing a scale
      out.push({ x, z, seed, forest: true, wild: true, h });
      n++;
    }
  }
}

// bbox caches of their own: `_mmbb` belongs to the maps and holds a different
// shape, and recomputing a ring per candidate is what makes a scatter quadratic
function bboxOfRing(f) {
  if (f._sbb) return f._sbb;
  let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
  for (const [x, z] of f.o) { if (x < a) a = x; if (z < b) b = z; if (x > c) c = x; if (z > d) d = z; }
  return (f._sbb = [a, b, c, d]);
}
function bboxOfLine(f) {
  if (f._sbb) return f._sbb;
  let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
  for (const [x, z] of f.p) { if (x < a) a = x; if (z < b) b = z; if (x > c) c = x; if (z > d) d = z; }
  return (f._sbb = [a, b, c, d]);
}

function scatterForest(f, x0, z0, x1, z1, waters, out) {
  if (!woodedGreen(f)) return;
  const ring = clipRingToRect(f.o, x0, z0, x1, z1);
  if (!ring) return;                          // polygon only grazes this cell
  const holes = [];
  for (const h of f.i ?? []) {
    if (h.length < 3) continue;
    const ch = clipRingToRect(h, x0, z0, x1, z1);
    if (ch) holes.push(ch);
  }
  let ax = 1e9, bx = -1e9, az = 1e9, bz = -1e9;
  for (const [x, z] of ring) {
    if (x < ax) ax = x; if (x > bx) bx = x;
    if (z < az) az = z; if (z > bz) bz = z;
  }
  let n = 0;
  const gi0 = Math.floor(ax / FOREST_STEP), gj0 = Math.floor(az / FOREST_STEP);
  for (let gi = gi0; gi * FOREST_STEP < bx; gi++) {
    for (let gj = gj0; gj * FOREST_STEP < bz; gj++) {
      if (n >= FOREST_CAP) return;        // capped, silently — a thin patch in a
      const seed = forestSeed(f._id, gi, gj); // distant wood beats a frame spike
      const x = (gi + FOREST_INSET + FOREST_JIT * rnd(seed, 1)) * FOREST_STEP;
      const z = (gj + FOREST_INSET + FOREST_JIT * rnd(seed, 2)) * FOREST_STEP;
      if (x < x0 || x >= x1 || z < z0 || z >= z1) continue; // half-open: one owner
      if (!pointInPolygon(x, z, ring)) continue;
      let ok = true;
      for (const h of holes) if (pointInPolygon(x, z, h)) { ok = false; break; }
      if (ok && waters.length && inWater(x, z, waters)) ok = false;
      if (!ok) continue;
      out.push({ x, z, seed, forest: true, park: f.t === 'park' });
      n++;
    }
  }
}

// Ornamental planting — a shrubbery, a clipped hedge, the bed in the middle of
// a roundabout. Same machinery as the forest, at 2.4 m spacing and knee-to-
// shoulder height, so an island reads as PLANTED rather than as mown verge.
const BUSH_STEP = 2.4, BUSH_CAP = 220;
function scatterBushes(f, x0, z0, x1, z1, waters, out) {
  if (f.t !== 'bush' || !f.o || f.o.length < 3) return;
  const ring = clipRingToRect(f.o, x0, z0, x1, z1);
  if (!ring) return;
  const holes = [];
  for (const h of f.i ?? []) {
    if (h.length < 3) continue;
    const ch = clipRingToRect(h, x0, z0, x1, z1);
    if (ch) holes.push(ch);
  }
  let ax = 1e9, bx = -1e9, az = 1e9, bz = -1e9;
  for (const [x, z] of ring) {
    if (x < ax) ax = x; if (x > bx) bx = x;
    if (z < az) az = z; if (z > bz) bz = z;
  }
  let n = 0;
  const gi0 = Math.floor(ax / BUSH_STEP), gj0 = Math.floor(az / BUSH_STEP);
  for (let gi = gi0; gi * BUSH_STEP < bx; gi++) {
    for (let gj = gj0; gj * BUSH_STEP < bz; gj++) {
      if (n >= BUSH_CAP) return;
      const seed = forestSeed(f._id, gi, gj);
      const x = (gi + 0.5 + 0.34 * (rnd(seed, 1) - 0.5)) * BUSH_STEP;
      const z = (gj + 0.5 + 0.34 * (rnd(seed, 2) - 0.5)) * BUSH_STEP;
      if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
      if (!pointInPolygon(x, z, ring)) continue;
      let ok = true;
      for (const h of holes) if (pointInPolygon(x, z, h)) { ok = false; break; }
      if (ok && waters.length && inWater(x, z, waters)) ok = false;
      if (!ok) continue;
      out.push({ x, z, seed, forest: false, bush: true, h: 0.9 + rnd(seed, 3) * 0.8 });
      n++;
    }
  }
}

// ---- the chunk builder ----
// groundOnly builds the FAR tier: nothing but the aerial photo on a quad.
// From a helicopter the ortho already shows the roads, roofs and fields, so a
// ring of these carries the view out to kilometres for one draw call each —
// the alternative was watching the fully-detailed world simply stop.
// ---- float32 and a 110 km world ------------------------------------------
// Every builder below writes WORLD coordinates into geometry, which was fine
// while the world was a 30 km box: float32 resolves 0.5 mm at 4.8 km. Prague is
// 95 km west of the origin, where the spacing is 7.8 mm — and worse, the vertex
// shader computes modelViewMatrix × position with both terms near ±95 000, so
// the subtraction that should leave a metre of view space instead leaves
// catastrophic cancellation, and the whole city swims as the camera moves.
//
// The fix every large-world renderer uses (Cesium calls it RTC): keep the
// offset OUT of the vertex data and put it in the object's transform, because
// three.js computes matrixWorld and modelViewMatrix on the CPU in float64 and
// only the small, already-cancelled result reaches the GPU. So a finished chunk
// is shifted to be local to its own centre and the Group carries the rest.
//
// The shift itself runs on the already-float32 arrays, which leaves the vertices
// snapped to that 7.8 mm grid at Prague — invisible on a low-poly city with 3 m
// windows, and it is the JITTER, not the snap, that the eye catches.
export function rebase(obj, bx, bz) {
  obj.traverse((o) => {
    if (o.isInstancedMesh) {
      // column-major Matrix4: elements 12,13,14 are the translation
      const a = o.instanceMatrix.array;
      for (let i = 12; i + 2 < a.length; i += 16) { a[i] -= bx; a[i + 2] -= bz; }
      o.instanceMatrix.needsUpdate = true;
      o.computeBoundingSphere();
      // a template whose shader builds more than its vertices hold (the far
      // trees: js/treeshapes.js FAR_BOUND_PAD) says by how much
      if (o.userData.boundPad) o.boundingSphere.radius += o.userData.boundPad;
    } else if (o.userData.localGeom) {
      // a unit quad that already carries its offset in .position (the ortho
      // photo tile, the far-ring ground plane) — its geometry is local already
      o.position.x -= bx; o.position.z -= bz;
      // …and the ortho quad bakes its matrix ONCE (matrixAutoUpdate = false,
      // because it never moves again). Moving .position on such an object is
      // a no-op unless the matrix is rebuilt — which is why every aerial photo
      // silently rendered a chunk-centre away from its own chunk.
      if (!o.matrixAutoUpdate) o.updateMatrix();
    } else if (o.geometry) {
      o.geometry.translate(-bx, 0, -bz);
    }
  });
}
export const chunkBase = (cx, cz) => [cx * CHUNK + CHUNK / 2, cz * CHUNK + CHUNK / 2];

/**
 * `lod` picks how much of a chunk gets built:
 *   'full'   everything — roads, paint, kerbs, green, buildings with facades,
 *            street lamps, trees. What you walk and drive through.
 *   'shell'  the ground and the BUILDINGS, nothing else. From the air this is
 *            what the world is: the aerial photo already draws the roads, the
 *            lawns and the parking lots perfectly well, and at 700 m nobody
 *            reads a lamp post — but a village with no houses on it reads as a
 *            missing world, which is exactly the report this tier answers.
 *   'ground' the photo alone, for the far ring.
 * `true` and `false` still mean 'ground' and 'full', because the streamer used
 * to pass a boolean and the tests still do.
 */
// The build is a GENERATOR: it yields between features so the streamer can
// spread one chunk's 30–300 ms of meshing across many frames (js/city.js
// pumps it against a per-frame budget — one atomic build was one dropped
// frame, and while driving the queue is never empty). Nothing touches the
// scene until the generator RETURNS, so a paused build is invisible and the
// old group stays up in place. buildChunkMeshes below drains it in one go
// for callers that want the old synchronous behaviour (the far-ribbon
// overlay, interior re-meshes, tests).
export function* buildChunkMeshesGen(city, cx, cz, mats, lod = 'full') {
  const groundOnly = lod === true || lod === 'ground';
  const shell = lod === 'shell';
  // 'roads': ribbons and nothing else. A 3 km rural way draws WHOLE from the
  // chunk holding its first vertex, and that chunk can be a kilometre past
  // the streaming ring — so the road you are driving on simply was not there
  // ("nenačítá se vozovka"). The streamer builds those far homes at this
  // tier: roads, rails, fences, junction pads — no ground, no buildings, no
  // props, nothing the real cell will draw again when its turn comes.
  const roadsOnly = lod === 'roads';
  // Terrain.heightAt raises `missed` whenever it is asked about ground it does
  // not have. Clearing it here and reading it back at the end is how a chunk
  // learns that it was built on a guess — which matters because a feature is
  // drawn WHOLE from its home chunk, so a forest or a river polygon routinely
  // samples ground several tiles away that has not arrived yet. Without this,
  // "was the ground known?" was answered from the chunk's own centre, and a
  // chunk whose centre was fine but whose geometry reached into nothing was
  // never rebuilt — it kept its guess for the rest of the session.
  if (mats.terrain) { mats.terrain.missed = false; mats.terrain._missTiles = new Set(); }
  if (mats.canopy) mats.canopy.missed = false;
  if (mats.ground) mats.ground.missed = false;
  const key = cx + ',' + cz;
  const cell = city.chunkIndex.get(key);
  // A GROUND-ONLY cell needs nothing from the city — it is an aerial photo and
  // nothing else. Requiring an indexed cell first meant that whenever the
  // region tiles lagged behind (which is exactly what happens at 700 m/s) the
  // far ring returned null and the world simply had a HOLE in it: no photo, no
  // quad, just the fog-coloured apron showing through. So the photo goes down
  // as soon as the WMS can serve it, and the data fills in behind it.
  if (!cell && !groundOnly) return null;        // outside the mapped city
  const group = new THREE.Group();
  group.name = 'chunk:' + key;
  const x0 = cx * CHUNK, z0 = cz * CHUNK, x1 = x0 + CHUNK, z1 = z0 + CHUNK;
  const [bx, bz] = chunkBase(cx, cz);
  const done = () => {
    rebase(group, bx, bz); group.position.set(bx, 0, bz);
    // …read AFTER every vertex has been placed, which is the point
    group.userData.guessedGround = !!mats.terrain?.missed || !!mats.canopy?.missed
      || !!mats.ground?.missed;
    // …and WHICH height tiles the guesses were waiting on, so the streamer
    // can rebuild this chunk when THOSE arrive instead of on every arrival —
    // the drop-everything waves were most of the driving stutter
    const mt = mats.terrain?._missTiles;
    group.userData.missTiles = mt?.size ? [...mt] : null;
    if (mats.terrain) mats.terrain._missTiles = null;
    return group;
  };
  if (groundOnly) {
    const g = mats.ortho?.orthoGroundMesh?.(cx, cz);
    // record the tier the photo was FETCHED at — the streamer's staleness
    // check must compare against what the mesh actually carries, and by the
    // time a sliced build finalizes the focus (and tierOf) has moved on
    group.userData.px = mats.ortho?.tierOf?.(cx, cz);
    if (g) { g.userData.localGeom = true; group.add(g); return done(); }
    // No photo AND no data means we are off the edge of the world (ortho.js
    // clamps its requests to the region) — the apron is the right answer there,
    // and paving open country with grey quads would only cost draw calls.
    if (!cell) return null;
    // The far ring gets the SAME material as everything else. It used to have a
    // flat sage colour of its own, which was invisible while an aerial photo
    // was draped over it and is the entire horizon now that there is not one.
    const q = new THREE.Mesh(terrainQuad(x0, z0, mats.terrain, COLORS.groundBase, 0, SURF.grass),
      mats.flat);
    group.add(q);
    return done();
  }
  const flat = [], water = [], sink = new TriSink();
  // what a prop stands on here: the pavement where a street has one (one
  // answer for lamps, signs, shelters and benches alike)
  const stand = standingOn(cell, key, mats.terrain);
  // two more buckets beside the ground sink: textured street dressing (sign
  // faces, glass, posters) and café terraces. Both are authored at absolute
  // heights and never draped.
  const deco = new DecoSink(), terraces = new TriSink(false, false);

  // -- water first: it decides the holes the ground must be carved with --
  const holes = [];
  // the cell's water rings, already clipped to it: the forest scatter borrows
  // them so it never plants a tree in the river (floodplain woods are mapped
  // straight over the Labe), and it can only afford that test because these
  // rings are cut down to this one cell instead of running the whole river
  const wet = [];
  let flooded = false;                          // some ring swallowed the whole cell
  _c.setHex(BANK_COL);
  const kr = _c.r, kg = _c.g, kb = _c.b;
  sink.at(SURF.dirt);                 // riverbanks and trench walls are earth
  const bankMark = sink.mark();
  let quayRoads = null;                         // the 3x3 road list, for quay parapets
  for (const f of cell.water) {
    if (!f.o || f.o.length < 3) continue;
    // WHERE THE WATER SITS. On a flat world every surface was WATER_Y, a metre
    // or two below a ground that was everywhere zero. With terrain that is a
    // hole: the Vltava would render 187 m below Prague. So the level is read
    // from the ground along the body's own outline — and read PER POINT, so a
    // river that is running downhill has a surface that runs downhill with it.
    const wyAt = (px, pz) => waterLevelAt(f, px, pz, mats.terrain);
    const wy = wyAt(x0 + CHUNK / 2, z0 + CHUNK / 2);   // one number, for callers that want one
    // clip-per-chunk instead of _home dedupe: the Labe is one polygon spanning
    // dozens of cells, and home-only rendering would pop it with one far cell
    const clip = clipRingToRect(f.o, x0, z0, x1, z1);
    if (clip && Math.abs(polygonArea(clip)) > 0.5) {
      if (Math.abs(polygonArea(clip)) >= CHUNK * CHUNK * 0.999) flooded = true;
      else holes.push(clip);
      const iClip = (f.i ?? []).map((h) => clipRingToRect(h, x0, z0, x1, z1)).filter(Boolean);
      wet.push({ o: clip, i: iClip, wy });
      // tessellated first, then every vertex lifted onto the level field — the
      // surface is a gentle ramp down the valley instead of one flat lid
      // (finer near a Prague weir crest, so the face and its foam can show)
      const surf = refineNearWeirs(terrainTess(shapePoly(clip, iClip, wy, COLORS.water), 8),
        f, x0, z0, x1, z1);
      if (surf) {
        const a = surf.attributes.position.array;
        for (let i = 0; i < a.length; i += 3) a[i + 1] = wyAt(a[i], a[i + 2]);
        surf.attributes.position.needsUpdate = true;
        paintFlow(surf, f).userData.flow = true;  // downstream drift and foam for the shader
        water.push(surf);
      }
      // islands are land: give them a lid just under the green-fill layer,
      // their outline already grows a skirt facing out into the water below
      for (const h of iClip) {
        const plate = drape(shapePoly(h, null, 0.02, COLORS.groundBase, SURF.grass), mats.terrain);
        if (plate) flat.push(plate);
      }
    }
    // skirts ride the ORIGINAL rings — the clipped ones grew artificial edges
    // along the cell border that would dam the river with earth walls
    const qr = isPooled(f) ? (quayRoads ??= nearRoads(city, cell, cx, cz)) : null;
    skirtRing(sink, f.o, key, true, kr, kg, kb, mats.terrain, wyAt, qr, !shell);
    for (const h of f.i ?? []) if (h.length >= 3)
      skirtRing(sink, h, key, false, kr, kg, kb, mats.terrain, wyAt, qr, !shell);
    yield;
  }
  if (mats.terrain && cell.water.some(isPooled)) {
    sink.at(SURF.paving);
    weirSillsInto(sink, x0, z0, x1, z1);       // the Prague weir crests, in stone
    sink.at(SURF.dirt);
  }
  if (mats.terrain) {
    sink.at(SURF.gravel);
    vysehradInto(sink, x0, z0, x1, z1, mats.terrain);   // the tunnel under the rock
    sink.at(SURF.dirt);
  }
  if (mats.terrain && !roadsOnly) {
    sink.at(SURF.paving);
    quayStairsInto(sink, x0, z0, x1, z1, mats.terrain);  // stone steps and walls down to the lower quays
    sink.at(SURF.dirt);
  }
  if (mats.terrain) sink.fixFrom(bankMark);   // bank skirts resolved absolutely
  const ww = wwBuckets(city).get(key);
  if (ww) for (const f of ww) {
    trenchInto(sink, water, holes, f, cell, x0, z0, x1, z1, kr, kg, kb, mats.terrain);
    yield;
  }

  // -- ground: aerial photo when the ortho manager has the tile, flat quad
  // otherwise — both carved with the water holes; a fully flooded cell needs
  // no ground at all (the river surface and its banks are the geometry) --
  let orthoGround = null;
  // the road/rail corridors the ground must dive under — used by BOTH ground
  // kinds. The photo used to skip this and lay its grass over every cutting:
  // "Proč je někde terén/tráva přes vozovku???" was the aerial photograph,
  // draped on raw terrain that arches back over a levelled deck.
  const corr = [];
  if (cell && !shell && mats.terrain) {
    // gathered from the 3×3 neighbourhood, not this cell alone: a corridor
    // reaches ~11 m past its road's bbox (kerb band + flare), so a way whose
    // bbox stops just across the border still governs ground on THIS side —
    // missing it left 8 cm of photo grass on the lane at chunk seams
    const seen = new Set();
    for (let dx2 = -1; dx2 <= 1; dx2++) for (let dz2 = -1; dz2 <= 1; dz2++) {
      const c2 = dx2 === 0 && dz2 === 0 ? cell
        : city.chunkIndex.get((cx + dx2) + ',' + (cz + dz2));
      if (!c2) continue;
      // the flat band reaches 4.5 m past the kerb: the ground and the photo
      // sample every 4 m, and a shorter band let the chord between a capped
      // vertex and a rising one arch centimetres over the lane edge
      for (const r of c2.roads) {
        if (r.br || !r.p || r.p.length < 2 || seen.has(r)) continue;
        seen.add(r);
        corr.push(roadCorr(r, bboxOfLine(r)));
      }
      for (const r of c2.rails) {
        if (r.br || !r.p || r.p.length < 2 || seen.has(r)) continue;
        seen.add(r);
        corr.push(railCorr(r, bboxOfLine(r)));
      }
    }
  }
  if (!flooded && !roadsOnly) {
    yield;
    orthoGround = mats.ortho?.orthoGroundMesh?.(cx, cz) ?? null;
    group.userData.px = mats.ortho?.tierOf?.(cx, cz);  // tier AS FETCHED — see above
    if (orthoGround) {
      // carving replaces the unit quad with a world-space ShapeGeometry and
      // zeroes .position, so only the UNcarved tile is still local
      if (holes.length) carveOrtho(orthoGround, x0, z0, x1, z1, holes, mats.terrain);
      else orthoGround.userData.localGeom = true;
      if (corr.length && mats.terrain) {
        const g2 = orthoGround.geometry;
        yield* clampUnderRoadsGen(g2, corr, mats.terrain,
          orthoGround.userData.localGeom ? orthoGround.position.x : 0,
          orthoGround.userData.localGeom ? orthoGround.position.z : 0);
        g2.attributes.position.needsUpdate = true;
        g2.computeVertexNormals();
      }
      orthoGround.receiveShadow = true;
      group.add(orthoGround);
    } else {
      // Without holes the ground is a displaced grid; with them it has to be a
      // carved polygon, which is then draped vertex by vertex. The carved case
      // is coarser (ShapeGeometry triangulates the outline, not a grid), but it
      // only happens where water crosses the cell — and there the ground is a
      // riverbank, which is where the flat WATER surface is the shape that
      // matters anyway.
      let g = holes.length
        ? quayDrape(quayRefine(terrainTess(shapePoly([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], holes, 0, COLORS.groundBase, SURF.grass))), mats.terrain)
        : terrainQuad(x0, z0, mats.terrain, COLORS.groundBase, 0, SURF.grass);
      // ---- the ground never rises over a deck ----------------------------
      // The earthworks conform the 20 m height grid to every levelled way,
      // but a 20 m grid cannot hold a 9 m cutting: the bicubic arches back
      // over the deck between grid nodes — measured 0.6 m of grass lying on
      // Palackého at the flyover, 88 buried spots within one 90 m circle.
      // So the drawn ground is CLAMPED under every corridor, like the fills
      // already are. The reach extends 2.9 m past the kerb with a FLAT cap:
      // the ground mesh samples every 4 m, so a narrower reach would let a
      // chord between two outside vertices arch over a 3 m track — the flat
      // band it cuts is the road's shoulder, which the conform already
      // flattens at the coarser scale.
      if (g && corr.length) g = yield* clampUnderRoadsGen(g, corr, mats.terrain);
      if (g) flat.push(g);
    }
  }

  // -- green/paved fills. Under the aerial photo these normally stand down:
  // the photograph already shows every lawn and forecourt, at a fidelity flat
  // colour cannot touch, and painting over it throws that away.
  //
  // A CAR PARK is the exception, and it is not a close call. The orthophoto was
  // flown on one particular morning with one particular set of cars standing in
  // it, so the lot arrives with cars baked into the ground — and then
  // parkinglots.js parks its own cars on top of them. Two cars to a bay, one of
  // them a smear, and no asphalt anywhere between. A surface the player drives
  // and parks on has to be a real surface, so this one is worth the photograph.
  const scatter = mats.trees !== false && !shell && !roadsOnly;
  // The trees are gathered HERE, long before they are instanced at the bottom,
  // because the flat sink below wants them: every tree that turns out to stand
  // on paving gets its pit cut into that paving (js/treepits.js).
  const trees = [], plates = [];   // (plates: the sealed rectangles laid below)
  if (scatter) {
    yield;
    // (with whatever the tile says the tree IS: species, height, crown, girth;
    // a landmark's clear zone, such as the gate arch, keeps its trees out)
    for (const t of cell.trees) if (t._home === key && !landmarkClear(t.p[0][0], t.p[0][1]))
      trees.push(mappedTree(t));
    const mapped = trees.length;
    for (const f of cell.green) {
      scatterForest(f, x0, z0, x1, z1, wet, trees);
      scatterBushes(f, x0, z0, x1, z1, wet, trees);
      yield;
    }
    scatterCanopy(cell, x0, z0, x1, z1, wet, mats.canopy, trees);
    // no scattered tree on top of a mapped one (see CANOPY_TWIN)
    let keep = mapped;
    for (let i = mapped; i < trees.length; i++) {
      const t = trees[i], reach = t.wild ? CANOPY_TWIN : FOREST_TWIN;
      let twin = false;
      if (!t.bush) for (const m of cell.trees) {
        if (Math.hypot(m.p[0][0] - t.x, m.p[0][1] - t.z) < reach) { twin = true; break; }
      }
      if (!twin && !landmarkClear(t.x, t.z)) trees[keep++] = t;   // nor in a landmark's doorway
    }
    trees.length = keep;
  }
  // the surface model's reading at a mapped tree: a street lime is as tall as
  // it was measured, not as tall as a dice roll (0 where there is no raster)
  const measured = mats.canopy && mats.canopy.ready(x0 + 1, z0 + 1) ? mats.canopy : null;
  const specOf = (t) => treeSpec(t, t.h || !measured ? 0 : measured.heightAt(t.x, t.z), _spec);
  if (!shell && !roadsOnly) {
    // A wood keeps its fill (the trees don't close ranks, and a bare base plane
    // between the trunks would be worse) but it goes to forest-floor tone —
    // meadow green glowing through a canopy is exactly what made these read as
    // paint. With trees switched off the honest wood green comes back.
    const greenOf = (f) => (scatter && WOOD_TYPES.has(f.t) ? FOREST_FLOOR
      : COLORS.green[f.t] ?? (WOOD_TYPES.has(f.t) ? COLORS.green.wood : COLORS.green.grass));
    const polyKinds = [
      [cell.green, LAYER_Y.green, greenOf, surfOfGreen,
        () => !orthoGround],
      [cell.paved, LAYER_Y.paved,
        (f) => COLORS.paved[f.t] ?? COLORS.paved.plaza, surfOfPaved,
        (f) => !orthoGround || f.t === 'parking' || laidUnderPhoto(f)],
    ];
    // The drivable decks a fill must stay under — from EVERY chunk the fill
    // reaches, not just this one. A fill is drawn whole from its home chunk,
    // and clamping it against the home cell's roads alone left the part that
    // crosses into a neighbour unclamped against the neighbour's roads: a
    // green tongue lying across the junction one chunk over, lane dashes
    // painted on top of it.
    const drvFor = (fb) => {
      const seen = new Set(), out = [];
      for (let cx2 = Math.floor(fb[0] / CHUNK); cx2 <= Math.floor(fb[2] / CHUNK); cx2++) {
        for (let cz2 = Math.floor(fb[1] / CHUNK); cz2 <= Math.floor(fb[3] / CHUNK); cz2++) {
          const c2 = city.chunkIndex.get(cx2 + ',' + cz2);
          if (!c2) continue;
          for (const r of c2.roads) {
            // every levelled way, not only the drivable ones — a green fill
            // lying over a cycleway buries it exactly like over a street
            if (r.br || !r.p || r.p.length < 2 || seen.has(r._id)) continue;
            seen.add(r._id);
            out.push({ r, bb: bboxOfLine(r), hw: (r.w ?? 3) / 2 + 0.25,
              lay: FOOT_CLASSES.has(r.t) ? LAYER_Y.footway : LAYER_Y.road });
          }
          for (const r of c2.rails) {
            if (r.br || !r.p || r.p.length < 2) continue;
            const id = r._id ?? (r._id = 'rail:' + c2.rails.indexOf(r));
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({ r, bb: bboxOfLine(r), hw: 2.45, lay: LAYER_Y.rail });
          }
        }
      }
      return out;
    };
    for (const [list, y, pick, kind, want] of polyKinds) for (const f of list) {
      if (!want(f) || f._home !== key || f.o.length < 3) continue;
      yield;
      // A fill that touches a drivable corridor is tessellated FINER than the
      // corridor is wide. The clamp below works on vertices, and the default
      // 12 m tessellation let one triangle bridge a 6 m carriageway with all
      // three corners outside it — the median stayed high across the road and
      // the lane dashes ran over grass. 3.5 m guarantees a vertex lands inside
      // any corridor wider than it, which every drivable one is.
      const fb = bboxOfRing(f);
      const drv = drvFor(fb);
      const nearRoad = drv.some(({ bb, hw }) =>
        !(fb[2] < bb[0] - hw || fb[0] > bb[2] + hw || fb[3] < bb[1] - hw || fb[1] > bb[3] + hw));
      const g = yield* clampUnderRoadsGen(
        quayDrape(quayRefine(terrainTess(shapePoly(f.o, f.i, y, pick(f), kind(f)), nearRoad ? 3.5 : undefined)),
          mats.terrain),
        drv, mats.terrain);
      if (g) flat.push(g);
    }
    // The classifier's sealed ground, straight off the raster: a handful of
    // merged rectangles per chunk, through the very same tess-and-drape path
    // as every other fill — at LAYER_Y.inferred, under everything OSM said and
    // under every levelled road, which is the entire point of the layer.
    // The inside of a town square, which OSM plots as a web of footways on sett
    // and concrete and no area at all — so nothing here has a surface, and the
    // player walks on either a photograph or a field. sealed.js closes that path
    // network into ground; this lays paving on it, at LAYER_Y.inferred like the
    // shipped raster, i.e. under every OSM fill and every levelled road.
    //
    // It draws under the photo too, and that is the point: the photograph shows
    // the square from 300 m up through the crowns of its trees, which is the one
    // thing it cannot show you the floor of.
    {
      // never two plates at one height: where the shipped classifier is about to
      // surface a cell itself, leave it to the classifier
      const ceded = !orthoGround && mats.ground
        ? (x, z) => mats.ground.classAt(x, z) > 0 : null;
      const rects = sealedRects(cell, cx, cz, ceded, mats.terrain);
      // …laid in what the paths across it are laid in: setts where most of
      // the walked ways here say sett (Staroměstské, Pernštýnská), slabs
      // otherwise. Slabs everywhere left an old-town square a patchwork of
      // two floors, sett ribbons threaded through concrete plates.
      const settled = rects.length && settSquare(city, cx, cz);
      const plateSurf = settled ? SURF.cobble : SURF.paving;
      const plateHex = settled ? COLORS.paved.plaza : COLORS.inferred.paving;
      if (rects.length) {
        // Clamped against `corr` — the SAME wide corridor list the base ground
        // uses — and not a narrow kerb-only list. The ground inside a corridor
        // is benched to the deck over w/2 + 4.5 m with a 5 m flare; a plate
        // clamped only to w/2 + 0.25 keeps raw terrain height across that
        // bench, and on a road cut into a hillside raw terrain is metres above
        // it. Measured in Jinonice: 18 % of the derived paving floated, up to
        // 2.22 m — slabs leaning against the cut like fallen fence panels.
        for (const r of rects) {
          yield;
          plates.push(r);
          const nearRoad = corr.some(({ bb, hw, flare }) => {
            const rc = hw + (flare ?? 0);
            return !(r.x1 < bb[0] - rc || r.x0 > bb[2] + rc || r.z1 < bb[1] - rc || r.z0 > bb[3] + rc);
          });
          const g = yield* clampUnderRoadsGen(quayDrape(quayRefine(terrainTess(shapePoly(
            [[r.x0, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0, r.z1]],
            null, LAYER_Y.inferred, plateHex, plateSurf),
          nearRoad ? 3.5 : undefined)), mats.terrain), corr, mats.terrain);
          if (g) flat.push(g);
        }
      }
    }
    // …but the classifier's guess at sealed ground stays down under the photo.
    // Unlike a car park it has nothing the photograph gets wrong — it exists
    // precisely to stand in for a photograph that is not there.
    if (!orthoGround && mats.ground) {
      // corr, for the same reason as the derived plaza above: the classifier's
      // plates lean off the corridor bench on any cut slope exactly the same way
      // (never in a motorway's verge: the photo's pale shoulders and cuttings
      // read as paving there, js/mwground.js)
      const gRects = mats.ground.rectsIn(x0, z0);
      for (const r of gRects.length ? cutRects(gRects, motorwayVerge(cell, cx, cz), cx, cz) : gRects) {
        yield;
        plates.push(r);
        const col = r.c === 2 ? COLORS.inferred.asphalt : COLORS.inferred.paving;
        const sc = r.c === 2 ? SURF.asphalt : SURF.paving;
        const nearRoad = corr.some(({ bb, hw, flare }) => {
          const rc = hw + (flare ?? 0);
          return !(r.x1 < bb[0] - rc || r.x0 > bb[2] + rc || r.z1 < bb[1] - rc || r.z0 > bb[3] + rc);
        });
        const g = yield* clampUnderRoadsGen(quayDrape(quayRefine(terrainTess(shapePoly(
          [[r.x0, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0, r.z1]],
          null, LAYER_Y.inferred, col, sc), nearRoad ? 3.5 : undefined)), mats.terrain), corr, mats.terrain);
        if (g) flat.push(g);
      }
    }
  }

  // -- roads + rails ribbons into the same sink, merged with everything --
  // The shell tier skips them: from a helicopter the photo underneath already
  // has every road in it, at better fidelity than the ribbon, and the ribbon is
  // the single most expensive thing in a rural chunk.
  if (!shell) {
    // (a quay flight's OSM line is drawn in stone by js/quaystairs.js)
    for (const f of cell.roads) if (f._home === key && !isQuayStairWay(f)) { roadRibbon(sink, f, mats.terrain, cell, key, city); yield; }
    for (const f of cell.rails) if (f._home === key) { railWay(sink, f, mats.terrain, cell, mats.tramMasts !== false, city); yield; }
    // …and the surfaces where they meet, filling what the trims left behind
    const js = junctionsIn(key);
    if (js) for (const j of js) junctionPad(sink, j, mats.terrain, cell);
    yield;
    // signs and zebras write into the SAME sink — and they must do it HERE,
    // before sink.geo() below turns it into geometry. The first version
    // appended them after that line: thirty zebra bars per chunk, emitted
    // into a bucket nobody ever poured out again.
    if (!roadsOnly && cell.signs) for (const sg3 of cell.signs) {
      if (sg3._home === key) signPost(sink, deco, sg3, cell, stand);
    }
    // …and the signs nobody surveyed but the data implies (js/streetsigns.js),
    // with the crossing plates the zebras ask for as they are painted
    const offRoad = (px, pz, r) => onCarriageway(cell, r, px, pz, 0.3);
    const planned = roadsOnly ? [] : plannedSigns(cell, key, js, offRoad, chunkKey);
    if (!roadsOnly && cell.crossings) for (const cr of cell.crossings) {
      if (cr._home === key) zebraInto(sink, cr, cell, mats.terrain, planned, offRoad);
    }
    for (const q of planned) signInto(sink, deco, stand, q[0], q[1], q[2], q[3], q[4], q[5]);
    yield;
    // trolejové vedení: the wires drawn WHOLE from the way's home chunk like
    // its ribbon, the masts by the cell they stand in (see trolleyInto)
    let tguard = null;
    for (const r of cell.roads) {
      if (r.tw && r.p && !roadsOnly) trolleyInto(sink, r, mats.terrain, stand, key,
        tguard ??= mastGuard(cell, key, city), cell);
    }
    // pylons + wires: towers on this chunk's vertices, spans owned by their
    // midpoint's chunk — same one-owner rule every linear feature uses
    if (!roadsOnly && cell.power && mats.terrain) for (const pw of cell.power) {
      yield;
      for (let i = 0; i < pw.p.length; i++) {
        const [vx, vz] = pw.p[i];
        if (chunkKey(vx, vz) === key) pylonInto(sink, vx, vz, !!pw.m, pw.v ?? 0, mats.terrain);
        if (i > 0) {
          const [ux2, uz2] = pw.p[i - 1];
          if (chunkKey((ux2 + vx) / 2, (uz2 + vz) / 2) === key)
            wireSpan(sink, ux2, uz2, vx, vz, !!pw.m, pw.v ?? 0, mats.terrain);
        }
      }
    }
    // zastávky: the poi list is small and unbucketized — a linear scan per
    // chunk build is cheaper than teaching the index a fourth node layer
    if (!roadsOnly && city.pois) for (const poi of city.pois) {
      if (chunkKey(poi.p[0], poi.p[1]) !== key) continue;
      if (poi.t === 'bus_stop') busStopInto(sink, poi.p[0], poi.p[1], cell, mats.terrain, stand, deco);
      else if (poi.t === 'fuel' && poi.cv) canopyFuelInto(sink, poi, cell, mats.terrain);   // under its mapped roof
      else if (poi.t === 'fuel') fuelInto(sink, poi.p[0], poi.p[1], poi.n, cell, mats.terrain);
    }
    yield;
    // …and everything else a Czech street has standing on it (js/furniture.js)
    const hexRGB = (hex) => { _c.setHex(hex); return [_c.r, _c.g, _c.b]; };
    const rndAt = (x, z, i) => rnd(Math.abs(Math.round(x * 7 + z * 13)) + i * 9176, i);
    if (!roadsOnly) furnitureInto(sink, cell, key, stand, hexRGB, rndAt, chunkKey, deco);
    // zahrádky: tables on the pavement outside every café the tiles name
    if (!roadsOnly && mats.terrain) terracesInto(terraces, cell, key, stand, hexRGB, rndAt,
      (x, z, margin) => onCarriageway(cell, null, x, z, margin), chunkKey);
    // the square of soil every tree on paving stands in (js/treepits.js)
    if (scatter) treePitsInto(sink, cell, trees, specOf, mats.terrain, plates);
    // fences, walls, noise barriers — the lines that divide one plot from the
    // next, and the reason a town stops looking like houses dropped in a field
    if (cell.barriers) for (const b of cell.barriers) {
      if (b._home === key && !landmarkBarrier(b) && !osmBarrierReplaced(b)) { barrierInto(sink, b, mats.terrain, city); yield; }
    }
    // the D11's median barrier and guard rails, planned per cell (js/mwplan.js)
    if (!roadsOnly) { motorwayDressInto(sink, cell, key, mats.terrain, city); yield; }
    if (!roadsOnly && cell.calming) for (const cm of cell.calming) {
      if (cm._home === key) bumpInto(sink, cm, cell, mats.terrain);
    }
    const cls2 = clustersIn(key);
    if (cls2) for (const cl of cls2) clusterPad(sink, cl, mats.terrain, cell);
  }
  // the D11's green bridges and noise walls: tall, so the shell tier draws
  // them too and they do not pop in at the full ring's edge (js/mwtall.js)
  if (!roadsOnly) motorwayTallInto(sink, cell, key, mats.terrain);
  // Roads, rails, kerbs, lane paint, bank skirts and bridge parapets all land
  // in this one sink, and every one of them is authored as a height ABOVE the
  // ground — so draping the finished buffer once puts the whole lot on the
  // hillside in a single pass, and the layering they were given (LAYER_Y) is
  // preserved because the terrain is ADDED to it rather than replacing it.
  // Bridges keep working for the same reason: their deck is already a lift.
  yield;
  const sg = sink.geo();
  // The sink — kerbs, fences, props, pylons, everything with a HEIGHT — gets
  // its own mesh so it can CAST. It used to merge into flatMesh below, whose
  // "ground catches, never casts" then silenced every fence and bench in the
  // world: shadow mapping was on, the sun tracked the camera, and nothing at
  // street level threw a shadow ("stíny vůbec nefungují").
  if (sg) {
    const sinkMesh = new THREE.Mesh(drape(sg, mats.terrain, sink.fixed), mats.flat);
    sinkMesh.castShadow = true;
    sinkMesh.receiveShadow = true;
    group.add(sinkMesh);
  }
  const dg = deco.geo();
  if (dg) {
    // sign faces, shelter glass, posters: thin plates that cast nothing
    const decoMesh = new THREE.Mesh(dg, mats.streetDeco);
    decoMesh.name = 'streetDeco';
    decoMesh.receiveShadow = true;
    group.add(decoMesh);
  }
  // The D11 / D35 signs (js/mwsigns.js plans, js/mwsignmesh.js builds): steel
  // and faces in buckets of their own, so this one block is the whole hook. In
  // the shell tier too: a gantry seen first at 600 m at 200 km/h must not pop.
  if (!roadsOnly && mats.motorwayDeco) {
    const mwSink = new TriSink(), mwDeco = new MwDecoSink();
    if (motorwaySignsInto(mwSink, mwDeco, key, mats.terrain, shell)) {
      const mg = mwSink.geo();                    // absolute heights: never draped
      if (mg) {
        const m = new THREE.Mesh(mg, mats.flat);
        m.name = 'motorwaySteel';
        m.castShadow = m.receiveShadow = true;
        group.add(m);
      }
      const fg = mwDeco.geo();
      if (fg) {
        const m = new THREE.Mesh(fg, mats.motorwayDeco);
        m.name = 'motorwayDeco';
        m.receiveShadow = true;
        group.add(m);
      }
    }
  }
  const tg = terraces.geo();
  if (tg) {
    const terraceMesh = new THREE.Mesh(tg, mats.terrace);
    terraceMesh.name = 'terraces';
    terraceMesh.castShadow = terraceMesh.receiveShadow = true;
    group.add(terraceMesh);
  }
  if (water.length) {
    for (const g of water) if (!g.userData.flow) paintFlow(g, null);   // still water
    const waterMesh = new THREE.Mesh(mergeSurfaceGeometries(water), mats.water);
    waterMesh.receiveShadow = true;
    waterMesh.onBeforeRender = () => {
      mats.water.uniforms.uTime.value = performance.now() * 0.001;
    };
    group.add(waterMesh);
  }
  if (flat.length) {
    yield;
    const flatMesh = new THREE.Mesh(mergeSurfaceGeometries(flat), mats.flat);
    flatMesh.receiveShadow = true;              // ground catches, never casts
    group.add(flatMesh);
  }

  // -- buildings: facade walls or v1 extrudes, one casting mesh either way --
  // Shells get the plain extrude: a window atlas costs a texture bind and a
  // second material for detail nobody can resolve from 700 m up.
  yield;
  const bm = roadsOnly ? null : buildBuildingsMesh(city, cx, cz,
    shell ? { ...mats, facades: false, shellLod: true } : mats);
  if (bm) group.add(bm);

  // -- street lamps: surveyed ones, the rule along wide roads, lanterns --
  if (mats.lamps !== false && !shell && !roadsOnly) {
    yield;
    const plan = lampSpots(cell, key, x0, z0, x1, z1, mats.terrain, city);
    lampBatch(group, plan.street, 'street', mats, stand);
    lampBatch(group, plan.park, 'park', mats, stand);
    lampBatch(group, plan.mast, 'mast', mats, stand);
    lampBatch(group, plan.mast1, 'mast1', mats, stand);
  }

  // -- road signs: dej přednost, stop, hlavní silnice ----------------------
  // A few flat-coloured triangles on a thin post, placed at the OSM node
  // (which sits on the way at the stop line), pushed to the right kerb of the
  // travel direction it governs and turned to face the oncoming driver — the
  // same convention traffic.js uses for its signal poles. Relative heights;
  // the chunk drape stands them on the ground.
  // -- trees: ONE InstancedMesh, crown picture and trunk in one template --
  // Mapped street trees (natural=tree points, rendered from their home cell)
  // and FOREST trees (scattered through every wooded polygon that reaches into
  // this cell) share one batch — the draw-call budget is per chunk, not per
  // source, and a floodplain cell would otherwise pay twice for the same
  // mesh. It was two batches (trunks and crowns) until the crown became an
  // impostor with the trunk folded into its template (js/treeshapes.js).
  if (trees.length) {
    const crown = new THREE.InstancedMesh(farTemplate(), mats.crown, trees.length);
    let pad = FAR_BOUND_PAD;
    for (let i = 0; i < trees.length; i++) {
      // instancing is cheap per tree, but a floodplain cell holds thousands:
      // every scratch var below is fully re-set each iteration, so the slice
      // boundary is safe
      if (i > 0 && (i % 500) === 0) yield;
      const t = trees[i];
      // Species, height, crown and trunk are all the tree's own id and place
      // (js/treeshapes.js). A wood's slots and the measured-but-unmapped ones
      // arrive with their height; a mapped point asks the raster here.
      const spec = specOf(t);
      const gy = mats.terrain ? mats.terrain.heightAt(t.x, t.z) : 0;
      // the crown's matrix is the unit crown sphere: the shader stands the
      // species' trunk under it down to the ground
      treeMatrices(spec, t.x, gy, t.z, _m4, null);
      crown.setMatrixAt(i, _m4);
      // the leaf colour carries the species in its low bits: that is how the
      // far shader and the near models learn it (see crownColor)
      crown.setColorAt(i, crownColor(spec, _c));
      pad = Math.max(pad, farBoundPad(spec));
    }
    // instance matrices live in world space, so rebase() recomputes the bounds
    // (or the whole batch frustum-culls against the template's origin-sized
    // sphere) and grows them by this pad: the template only holds a
    // placeholder of the trunk the shader stands under every crown (the
    // tallest tree's reach, never under FAR_BOUND_PAD)
    crown.userData.boundPad = pad;
    crown.name = 'trees-far';
    crown.castShadow = crown.receiveShadow = true;
    group.add(crown);
  }
  return done();
}

export function buildChunkMeshes(city, cx, cz, mats, lod = 'full') {
  const gen = buildChunkMeshesGen(city, cx, cz, mats, lod);
  let it;
  do { it = gen.next(); } while (!it.done);
  return it.value;
}
