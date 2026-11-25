# Among The City — architecture contract

GTA-lite in three.js. A faithful replica of Pardubice built from OpenStreetMap
data (RÚIAN building footprints, real road network). The player spawns on the
forecourt of **Pardubice hlavní nádraží**, walks the real streets, enters cars
and drives. Engine DNA (postfx, sunset system, input, low-poly art direction)
comes from ../AmongTheWoods.

## Hard rules for every module

- ES modules, `import * as THREE from 'three'` (importmap → libs/three.module.js).
- Plain JS, no TypeScript. Match the AmongTheWoods code style: dense, well-
  commented prose comments explaining WHY, ~100-col lines.
- **y is up. x is east. z is SOUTH (north = −z).** Ground level is y = 0
  (Pardubice is Polabí-flat). Angles: `heading` is radians, 0 = facing −z
  (north), positive turns clockwise when seen from above (i.e. mesh built
  facing −z, `mesh.rotation.y = -heading`... NO — convention: heading 0 = −z,
  `dirX = Math.sin(heading)`... we standardize: **`dirX = -Math.sin(heading)`,
  `dirZ = -Math.cos(heading)`, `mesh.rotation.y = heading`**, i.e. a mesh
  authored facing −z and yawed by `heading` moves along (dirX, dirZ).
- Low-poly flat-shaded look, NO textures (vertex colors + solid materials),
  matching AmongTheWoods. Materials: `MeshLambertMaterial` with
  `vertexColors: true` for merged geometry.
- Merged geometry per chunk — never one Mesh per building/road segment.
- No per-frame allocations in update loops (reuse scratch vectors).

## Data: public/data/pardubice.json

Produced by scripts/build-city.mjs. Local meters around the station
(origin lat 50.03824, lon 15.75648). Compact keys:

```
{ name, origin:{lat,lon}, mPerLat, mPerLon,
  buildings: [{ o:[[x,z]...], i:[[[x,z]...]]?, h, y?, lv?, t, c?, n?, r? }],
     // o=outer ring (no closing dup), i=inner rings (holes), h=height m,
     // y=min height (skyway), t=building type, c="#hex", n=name, r=roof shape
  roads: [{ p:[[x,z]...], t:class, w, v, d, ow?, br?, ln?, n? }],
     // w=width m, v=speed km/h, d=1 drivable, ow=oneway (p direction), br=bridge
  rails: [{ p, t:"rail"|"tram", br? }],
  water: [{ o, i?, t:"water" }], waterways: [{ p, w }],
  green: [{ o, i?, t:"park"|"wood"|"grass"|"pitch"|"cemetery" }],
  paved: [{ o, t:"parking"|"plaza" }],
  trees: [[x,z]...],
  pois:  [{ p:[x,z], t, n? }] }
```

## Modules & owners

### js/config.js (done — read it)
All constants: SPAWN, CHUNK size, view radius, colors, road layering heights,
bridge deck height, car specs, speeds.

### js/geo.js (done — read it)
`loadCity(url)` → fetches + returns `city` with a per-chunk spatial index:
`city.chunks: Map<"cx,cz", {buildings, roads, rails, water, green, paved, trees}>`
(features appear in EVERY chunk their bbox touches — dedupe at mesh time via
the `_id` stamped on each feature). Geometry helpers: `pointInPolygon`,
`polygonArea`, `distPointToSegment`, `roadElevation(road, i, t)` (bridge ramps),
`chunkKey(x,z)`, `forEachChunkInRadius`.

### js/city.js (done — read it)
`class CityWorld` — streams chunk Groups in/out around a focus point.
Calls `buildChunkMeshes(city, cx, cz, mats)` from meshes.js. Public:
`update(dt, focus)`, `heightAt(x,z)`, `collide(pos, radius)` (mutates a
{x,z}, returns true if pushed — buildings + water), `ready(pos)`.

### js/meshes.js — AGENT A
```js
export function makeMaterials() → mats            // shared, called once
export function buildChunkMeshes(city, cx, cz, mats) → THREE.Group|null
```
One Group per chunk, positioned at ORIGIN (geometry in world coords is fine —
chunks are ≤ ~2 km from origin, float32 is plenty). Inside, few merged meshes:
- **ground base**: one 120×120 quad per chunk at y=0, asphalt-suburb gray-green.
- **green/paved/water polys** (holes via THREE.Shape holes): y from config
  LAYER_Y, flat color per type (config COLORS). Clip is NOT needed — polys may
  overhang the chunk; dedupe via feature._id (a feature renders only in its
  HOME chunk = chunk of its first vertex; other chunks skip it. Overhang is
  fine because neighbours stream together).
- **roads**: ribbons from polyline p with width w (miter joins, round caps via
  disc fans at endpoints), y by class from config (footways slightly above
  roads), bridges: deck at BRIDGE_Y with geo.roadElevation ramps + gray side
  skirts. Drivable roads get center dashes (thin white quads) when w ≥ 6 and
  class ≥ tertiary; crossings none (v1).
- **rails**: two parallel dark steel ribbons 1.435 m apart + sleeper quads
  every 0.8 m (merged; cheap boxes are fine at this camera).
- **buildings**: THREE.Shape (+holes) → ExtrudeGeometry depth h, translated to
  y (min height). Vertex colors: walls from palette by type/`c` with subtle
  per-building tint jitter + slight darkening toward the ground (fake AO);
  flat roof face a darker desaturated shade. `r` (roof shape) ignored in v1
  EXCEPT `gabled` on small houses (< 300 m²): add a simple ridge prism.
  Windows: NONE in v1 (flat style) — but named landmarks (n present) keep
  full saturation so they pop.
- **trees**: ONE InstancedMesh per chunk (`trees-far`, mats.crown): every
  tree is a camera-facing picture of its species' crown on a five-sided
  trunk the shader builds from a species table (js/treeshapes.js "the far
  tier", js/treeshader.js). The pictures are the near models themselves,
  rendered once at start-up into an atlas with their normals and shade
  (js/treeimpostor.js), so a far crown is lit by the real sun. Round the
  camera js/trees.js swaps them for the full models of js/treemodels.js.
  The batch's bounding sphere carries `userData.boundPad` (rebase adds it)
  because the template only holds a placeholder of the trunk. A/B and costs
  from the console: `__atc.trees.ab` ({ impostor, near, wind }) and
  `__atc.trees.stats()`.
Return null if the chunk index has no entry.

### js/vehicles.js — AGENT B
```js
export function makeCarMesh(colorHex) → { group, wheels: [Mesh×4] }
export class Vehicles {
  constructor(scene)
  add(kind, x, z, heading, color?) → car     // kind: 'sedan'|'hatch'|'van'
  remove(car)
  update(dt)                                  // spin wheels, settle suspension tilt
}
export function driveStep(car, ctl, dt, world)
```
`car` = { mesh, wheels, x, z, heading, speed (m/s, +fwd), steer, kind, color,
len, wid, ai: null }. `driveStep` arcade physics: throttle/brake/handbrake from
`ctl = {gas: -1..1, steer: -1..1, brake: 0|1}`; accel ~6 m/s², vmax ~38 m/s,
reverse ~8 m/s, steering angle shrinks with speed (stable at 130 km/h), light
lateral grip slide (drift factor), deceleration by drag+rolling. Collision:
sample 4 corner points against `world.collide` — on hit, push out, kill 60% of
speed, small heading bounce. Low-poly car mesh: body box + cabin trapezoid
(BoxGeometry scaled verts), dark window band, 4 cylinder wheels, headlight/
taillight small emissive boxes (overbright ~2.5 for night bloom later).

### js/traffic.js — AGENT C
```js
export class Traffic {
  constructor(city, vehicles)
  update(dt, playerPos, playerCar)
  steal(car) → removes from AI control (player takes it)
  cars → Set
}
```
Build a directed graph ONCE from `city.roads` where `d=1`: nodes keyed by
`x.toFixed(1)+','+z.toFixed(1)` of way endpoints AND interior points shared
between ways (build a point→ways multimap first; any point used by ≥2 drivable
ways or being a way end is a graph node; split ways into edges between
consecutive nodes). Edge: { pts, len, speed (m/s = v/3.6), oneway, road }.
AI cars: spawn on random edges within 400 m of player (cap ~45 alive, despawn
past 520 m), travel along edge pts with **right-hand lane offset** of
`min(road.w*0.27, 2.1)` m perpendicular to travel direction; at node end pick a
random outgoing edge (respect oneway, prefer ± straight, no immediate U-turn
unless dead end); speed = edge.speed capped by curve sharpness ahead; brake
smoothly (IDM-ish: gap/2s rule) for the car or player-car ahead within a 22 m
look-ahead cone on the same heading (±35°), full stop at 2.5 m. Elevation via
`geo.roadElevation` on bridges. Sets car.x/z/heading/speed directly (no
driveStep). Every car gets a random muted color from config CAR_COLORS.

### js/player.js + js/citizen.js — AGENT D
```js
// citizen.js
export function makeCitizen(look?) → { group, walk(walkT, speedK), parts }
// player.js
export class Player {
  constructor(scene, x, z, heading)
  update(dt, { input, camYaw, world })   // ignores input while .inCar
  pos {x,z}, heading, speed, walkT, mesh, inCar: car|null
  setInCar(car|null)                     // hides mesh, parks it at car pos on exit
}
```
Citizen: AmongTheWoods box-people style (torso box, head, arm/leg boxes with
pivot groups at shoulders/hips), ~1.75 m tall, palette (jacket/pants/skin).
walk(): legs/arms swing sin(walkT), slight bob. Player movement: WASD relative
to camYaw (W = away from camera), jog 4.2 m/s, Shift sprint 7 m/s, accel/brake
~14 m/s² for snap, heading turns toward move dir (12 rad/s), `world.collide`
with r=0.38. walkT advances with distance (walkT += speed*dt*1.6).

### js/sky.js — AGENT E
Port AmongTheWoods' *new* elevation-driven sun/sunset system into a
self-contained module (source: ../AmongTheWoods/js/main.js — solarPhase,
sunElevAt, nightAtHour, SUN_DAY/SUN_LOW/GOLDEN_TOP/SUNSET_FOG/SUNSET_SKY,
updateAtmosphere's hemi/sun intensity + fog/sky lerp; and models.js
makeSkyDome with uMoon). Public:
```js
export function makeSky(scene) → sky   // adds hemi + dir sun (castShadow) + dome
export function updateSky(sky, tod, camera, scene)  // tod 0..1; drives colors,
   // fog color (scene.fog assumed FogExp2 OR linear set by main), dome uniforms
export function sunDirOf(tod, out)     // for shadow placement in main
```
City palette: day sky #87b5e8→zenith, urban fog gray-blue; keep the sunset/
night constants. Moon included. No biome logic, no cave logic.

### js/minimap.js — AGENT F
```js
export class Minimap {
  constructor(canvas, city)
  update(playerX, playerZ, heading, cars)  // circular, north-up world,
     // player arrow rotates; roads pre-rendered once to an offscreen canvas
     // (2048², whole city, roads by class width/color + water + green), blit
     // translated so player is centered, ~90 m radius view; AI cars = dots.
}
```

### js/main.js (integrator — NOT yours, do not create)
Boot, camera (walk orbit-follow + drive chase cam with FOV kick), E to
enter/exit, clock (24 min day, start 10:30), HUD (speedo, clock, hints,
banner), postfx hookup later.

## Verification
- `npm run dev` port 5180. tests/ = node --test for geo + traffic graph.
- Browser check: load, zero console errors, screenshot at spawn shows the
  station building + streets + moving cars.

---

# v2 upgrade contract (realism pass)

## Bridges & water — REALITY FIX
Bridges do NOT hump. `BRIDGE_Y = 0.85` (config), `geo.bridgeElevation(dist,
totalLen)` returns a FLAT 0.85 deck with a 6 m blend at each way end. What
makes a bridge read as a bridge is the RIVER SUNK BELOW IT: water polygons
render at `WATER_Y = −2.0` and every water outline (outer + holes) grows a
vertical BANK skirt from y 0.05 down to −2.4 (earthy #6b5f4c). Bridge roads
get thin side railings (0.9 m tall dark strips at both ribbon edges).

## js/ortho.js — real aerial ground (ČÚZK ortofoto, open data CC-BY)
`scripts/fetch-ortho.mjs` downloads WMS supertiles:
`https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=0&STYLES=&CRS=CRS:84&BBOX=<lonW,latS,lonE,latN>&WIDTH=1024&HEIGHT=1024&FORMAT=image/jpeg`
Supertile = 480×480 m (4×4 chunks), saved `public/data/ortho/<sx>_<sz>.jpg`
where sx = floor(x/480), sz = floor(z/480), covering x,z ∈ [−2400, 2400).
Convert local meters ↔ lon/lat with mPerLon/mPerLat + origin from the city
JSON. Runtime: `initOrtho()` → manager; `orthoGroundMesh(cx, cz)` returns a
120 m ground quad Mesh at y=0 with the right THREE texture + UV window (or
null when the tile file is missing → caller falls back to flat color).
Textures: SRGBColorSpace, LinearFilter, anisotropy 4, cache per supertile.

## meshes.js v2
- ground: if `mats.ortho` (an ortho manager) is set, use its quad; else flat.
  When ortho is on, SKIP green/paved fills (the photo shows them) but KEEP
  water (sunken), roads, rails, buildings, trees.
- buildings: procedural FACADES — one shared 1024² CanvasTexture atlas built
  once: a grid of window-band variants (plaster columns of lit/dark windows,
  ground-floor storefront band, panel-building seams). Walls UV-map so one
  window row ≈ one RÚIAN storey (b.lv), one window ≈ 2.7 m of wall run;
  vertex-color still tints per building (palette × jitter). Roofs stay flat
  color. `facades: false` in mats → v1 plain walls (settings toggle).

## js/audio.js
`initAudio()` (first user gesture), `sfx(name, vol)` (files from
assets/sounds/*.mp3, generated by scripts/gen-sounds.mjs via ElevenLabs —
door_open, door_close, engine_start, horn), and a PROCEDURAL engine loop:
`engineStart()/engineStop()/engineSet(speed01, throttle01)` — WebAudio graph
(2 detuned saw/triangle oscillators + lowpass + subtle noise), base 55 Hz
idle → ~190 Hz flat out, gain ducks with throttle off. `setVolume(0..1)`.
No dependency on main.js internals.

## js/settings.js — Woods-style graphics panel
`initSettings(apply)` injects a ⚙️ button (top-right) + modal (DOM built in
JS, styles injected). Persisted in localStorage `atc-settings`. Presets
low/medium/high + advanced: shadows (on/off), shadowRes (1024/2048/4096),
resScale (0.75/1/native), viewChunks (3/4/5/6), traffic (0/20/45/80),
ortho (on/off), facades (on/off), trees (on/off), mouseLook (on/off),
volume (0..1). Changing anything calls `apply(settings, changedKey)`;
preset writes all keys then apply('preset'). Defaults = medium + ortho on +
mouseLook ON. Export `getSettings()`.

---

# v3 contract (region + driving feel)

## Tiled world (agent TILES)
The world is now the whole agglomeration (~30×38 km), streamed as 4.8 km data
tiles produced by scripts/build-region.mjs from data/raw-region/*.json (one
combined Overpass response per tile — see fetch-region.mjs). Same origin
(Pardubice hl.n.), same feature format as pardubice.json plus per-tile
`signals: [[x,z],…]` (highway=traffic_signals). Output:
`public/data/tiles/<tx>_<tz>.json` + `public/data/manifest.json`
{ origin, mPerLat, mPerLon, tile: 4800, tiles: [{tx,tz,f,n}] }.
Runtime (geo.js): `loadCity(url)` detects a manifest (`.tiles`) vs the legacy
single file and returns the same `city` object either way; city gains
`ensureTiles(x, z)` → Promise (fetches+indexes every manifest tile whose
bounds come within 2600 m; incremental bucketize into chunkIndex; tiles never
unload in v3), `city.signals` (growing array) and `city.onTileLoaded(cb)`
(cb({roads, signals}) AFTER indexing). city.js CityWorld.update() calls
`city.ensureTiles(focus.x, focus.z)` (throttled ~1 s, fire-and-forget) so the
world grows as you drive. minimap.js re-renders its offscreen city bitmap
(debounced 2 s) on tile load and re-centers its world window when the player
strays >1500 m from the last render center.

## Vehicles v3 (agent VEHICLES)
`driveStep(car, ctl, dt, world, others)` — others: iterable of other cars.
- Realistic acceleration: per-kind engine curve `a = accel * (1 − v/vmax)^1.3`
  (sedan 0–100 in ~9 s), so top speed approaches asymptotically.
- Kinds with distinct silhouettes AND specs { accel, vmax(m/s), grip }:
  sedan (175 km/h), hatch (150), kombi (165), suv (160), van (130), truck (95,
  box body), bus (105, long). Muted real-world colors.
- DRIFT: lateral grip drops as steer×speed grows (progressive rear slip →
  visible countersteer slides), handbrake cuts grip hard (proper smyk).
- CAR-CAR collision: each car ≈ two circles (front/rear, r≈wid·0.62). Test
  against `others` within 12 m; on overlap separate both bodies, exchange a
  momentum impulse along the contact normal (other car gets shoved), scrub
  40-70% of closing speed, small yaw kick, set `other._rammedT = 2.5` so the
  traffic AI knows it was hit.
## Traffic v3 (agent TRAFFIC)
- `addTile({roads, signals})` — incremental graph growth: node keys are
  rounded coordinates, so cross-tile edges stitch themselves. Re-run spawn
  logic against the grown graph. Called via city.onTileLoaded (wire it in the
  constructor: `city.onTileLoaded(t => this.addTile(t))`; the initial
  city.roads array may already hold pre-loaded tiles).
- `this.maxCars` honored (settings sends 0/30/60/120); spawnR 400→460.
- TRAFFIC LIGHTS: cluster signals within 30 m → one junction controller,
  2-phase (N-S-ish vs E-W-ish by approach bearing), green 11 s / amber 1.5 s
  alternating, phase offset hashed per junction. A mast (js/signalmodel.js:
  shaft, three-lens head with hoods, pedestrian head) at each signal node,
  oriented to its road. Every standing mast within SIG_VIS2 is one instance of
  ONE InstancedMesh (js/signalbatch.js: the parts merged, a per-vertex lens
  index, a per-instance state float picks off or lit colour and glow in the
  shader), so the lights of the whole city in range are one draw call; a
  felled mast gives up its slot. The mesh stands at an anchor near the masts
  and the instances are offsets from it (float32 world coordinates at 95 km
  broke the lens out of its housing). `__batch.signals = false` (js/batchflags.js)
  draws the old per-mast Groups for an A/B. AI: a red/amber light on the car's edge ahead → smooth
  stop 5 m short (reuse the follow-brake math); pull away on green.
- Cars with `_rammedT > 0`: AI control suspended (car keeps momentum, decays
  by friction), timer down, then re-snap onto the nearest own-edge point and
  resume driving.
- Use the full kind roster: mostly sedan/hatch/kombi/suv, sprinkle van/truck/
  bus on big roads (speed ≥ 50 km/h edges).
## Audio v2 (agent AUDIO)
Engine gains VIRTUAL GEARS: 5 ratios; rpm01 cycles 0.25→1 within a gear as
speed01 crosses its band, drops on upshift (~120 ms dip in freq+gain — the
"shift"). Richer voice: add a square osc at 2× fundamental (−14 dB), mild
frequency vibrato (~4 Hz, ±1.5 %) at low rpm for idle lope, sharper filter
response to throttle. Keep API identical (engineSet(speed01, throttle01)).
## Facades v2 + runtime ortho (agent FACADES)
- meshes.js atlas grows real variety: aged Czech plaster (subtle streaking),
  brick industrial, panel prefab with joint grid, glass storefront, sills +
  lintels around windows, window glass with sky-gradient reflections + a few
  warm lit rooms; 12+ generic variants; keep cell layout/UV contract.
- ortho.js: RUNTIME WMS (CORS confirmed working) — no local tiles: fetch
  `https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer?...`
  480 m tiles at **2048 px** (0.23 m/px, 4× current detail) straight into
  THREE.Texture via TextureLoader/createImageBitmap, LRU-cache ~48 tiles
  (dispose evicted), same orthoGroundMesh(cx,cz) API, flat-color fallback
  while loading. public/data/ortho/*.jpg are DELETED (integrator does it).

---

# v4 contract (helicopter, clouds, forests, city sound)

## js/helicopter.js — AGENT HELI
```js
export function makeHelipad(x, z)                  → THREE.Group (static pad)
export class Helicopter {
  constructor(scene, x, z, heading)
  update(dt, ctl, world)   // ctl {pitch,roll,yaw,lift} each -1..1
  x, z, y, heading, mesh, rotorSpeed, airborne
}
```
Low-poly Robinson-ish: cabin (rounded box + glass band), tail boom, tail
rotor, skids, main rotor = 2 thin blades on a hub (spin by rotorSpeed, blur
to a translucent disc past ~40 rad/s). Flight model, arcade but weighty:
lift builds with rotorSpeed (spin-up ~3 s after start); collective from
ctl.lift (arrows ↑/↓) sets target climb rate ±9 m/s with lag; WASD is
pitch/roll — the machine BANKS (mesh tilts up to 0.35 rad) and accelerates
along its tilt, vmax ~62 m/s, drag pulls it back level; yaw eases with roll
so turns coordinate. Ground: y never below world.heightAt(x,z); landing
below 0.4 m of ground with descent <3 m/s settles it (airborne=false), a
harder impact just clamps. Collision: buildings via world.collide at the
fuselage radius while below 40 m. No per-frame allocation.
Heliport: `makeHelipad` = dark asphalt disc + painted H + white ring +
4 corner lights (emissive, toneMapped:false so bloom bites at night).

## clouds — AGENT SKY (js/clouds.js + a small sky.js hook)
```js
export class Clouds { constructor(scene); update(dt, camera, sunDir, nightK) }
```
VOLUMETRIC-LOOKING without a raymarch: a field of ~90 camera-facing billboard
puffs grouped into ~14 clusters drifting on the wind, each puff a soft radial
CanvasTexture sprite, cluster puffs jittered in 3 axes so a cluster reads as a
volume from any angle; sprites lit per-cluster by dot(sunDir, offsetDir) →
bright rims toward the sun, grey-blue undersides; they sit 260–420 m up, cover
±1800 m around the camera and RECENTER on it (infinite sky, no seams);
opacity/tint follow nightK. Additive-free (normal blend, depthWrite false,
fog false, renderOrder −900 so the city always draws over them).
Also: helicopters must be able to fly INTO them — no special casing.

## forests — AGENT FOREST (js/meshes.js only)
Where the data says `green.t === 'wood'|'forest'` (and large `park`), scatter
REAL trees instead of a flat green polygon: deterministic Poisson-ish points
(hash the polygon _id, ~1 tree per 55 m², capped 400/chunk-polygon), each a
2-cone-or-icosphere crown + trunk, size/hue jitter, clipped to the polygon
(pointInPolygon) AND to the chunk rect, merged into the existing per-chunk
tree InstancedMeshes. Keep the ground polygon underneath (dark forest floor).
Respect mats.trees === false. This is what makes Kunětická hora and the
Labe floodplain read like AmongTheWoods rather than green paint.

## sounds — AGENT AUDIO2 (scripts/gen-sounds.mjs + js/audio.js)
Generate via ElevenLabs (same pattern as the existing script, env
ELEVENLABS_API_KEY) into assets/sounds/: `city_ambience` (10 s loopable urban
hum: distant traffic, faint voices), `traffic_pass` (a single car passing at
speed), `horn_far`, `horn_angry`, `heli_start`, `siren_far`.
js/audio.js gains: `ambientStart()/ambientStop()` (looping city_ambience via
a GainNode, ducked while driving fast), `nearbyTrafficHum(nCars, avgDist)`
(a cheap procedural low rumble scaled by how much traffic is close — no
per-car audio), `horn()` (random of the two), and a procedural HELI rotor
loop `heliStart/heliStop/heliSet(rotor01, speed01)` (thumping LFO-gated
noise + low osc, blade-slap rate follows rotor01).

---

# v5 contract: the world map (M)

## public/data/places.json (done — produced by scripts/fetch-places.mjs)
`{ origin, mPerLat, mPerLon, places: [{ n, t, r, p:[x,z], pop? }] }` — 429
named settlements in local metres, sorted by rank r (0 city … 5 isolated
dwelling). Fetch it alongside the city; a failure must leave the map working
without labels.

## js/worldmap.js — AGENT MAP
```js
export class WorldMap {
  constructor(city, minimap)          // reads the LIVE city arrays like Minimap
  toggle(force?)  → bool              // open/close; returns the new state
  get open()                          // bool
  update(player, car, heli)           // per-frame while open: markers + HUD
  waypoint                            // {x, z} | null — main drives the HUD arrow
}
```
Behaviour (model it on ../AmongTheWoods `#bigmap` + `Minimap.drawBig`, but
this is a REGION map, not a round island):
- Full-screen overlay built in JS (inject its own `<style>`; touch no HTML).
  Dark translucent backdrop, a centred canvas that fills ~92 % of the viewport
  keeping the region's aspect, a title bar and a legend/hint line in Czech.
- Renders the whole loaded region: water, green, roads by class (thin for
  service, thick for motorway/trunk), rails, and building fill as a light
  wash. Reuse the Minimap's palette so the two read as one map. Render ONCE
  into an offscreen canvas at open, and again when `city.onTileLoaded` fires
  while open (debounced 1 s) — never per frame.
- PAN + ZOOM: drag to pan, wheel to zoom 1×…12×, double-click to recentre on
  the player. Clamp the view to the region bounds.
- LABELS from places.json, drawn biggest-rank first with a simple screen-space
  collision reject (skip a label whose box overlaps one already drawn), and a
  per-rank zoom threshold so villages only appear once zoomed in. White text,
  dark outline, a small dot at the place position; cities get a bigger dot.
- MARKERS: the player as a heading arrow, the parked helicopter as an icon,
  and the waypoint. Left-click sets/moves the waypoint, right-click clears it.
  Expose it as `.waypoint`.
- Escape or M closes; opening pauses nothing (the city keeps streaming).
- Zero per-frame allocation while open; all geometry work happens in the
  offscreen render.

## main.js integration (MINE, not the agent's)
`input.onKey('KeyM')` toggles; a HUD arrow points to `map.waypoint` with the
distance in metres, and the minimap draws the same waypoint.

---

# v5 contract (interiors, people, demolition)

Every roof in Pardubice now has rooms under it, you can walk in through a real
front door, and the helicopter carries a rocket pod that takes buildings apart
the way Teardown does. Five new modules, none of which knows about the others'
internals.

## js/interiors.js — the floor plan (pure data, no three.js)
```js
export function classify(f) → use            // 'flats'|'house'|'mall'|…
export function entranceOf(f, roads?, neighbours?) → {i,t,x,z,nx,nz,w}
export function buildingPlan(f, roads?, neighbours?) → plan   // cached on f._plan
export function hasInterior(f) → bool
export function planToWorld(fr, u, v, out)
export const USE_LABEL
```
**Classification** layers, in order: a `shop=`/`amenity=` tag from the data
pipeline (`f.u`), a BRAND table of the real Pardubice chains, name regexes, the
OSM `building=` type, then pure geometry (area × levels) for the 2 400 buildings
tagged `yes`/`no`/`roof`. Over the real data that lands 3 869 houses, 3 378
garages, 1 165 blocks of flats, 511 industrial, 53 schools, 28 supermarkets and
7 malls.

**Brands** encode the real thing, not a generic: Palác Pardubice (AFI Palác) is
three levels, 116-odd units around an atrium with a Cinema City under the roof;
Obchodní dům Prior is the 1974 department store, escalators, grocery on the
ground; Kaufland is a single ~4 200 m² hall with eight-plus tills; Lidl six
aisles, four tills and the non-food middle aisle; Penny the 2026 "Market Hall"
refit. Sources are cited in the BRANDS block.

**Layouts** are drawn in the footprint's own OBB (u along the longest edge) and
CLIPPED to the true polygon at geometry time, so an L-shape gets a plausible
plan with the overhang trimmed. `corridorLayout` (flats/school/hotel/hospital/
office/civic), `mallLayout`, `openLayout` (industrial/parking/church/garage/
supermarket), `houseLayout` (BSP). The **stair core** is the one thing that must
land inside the real outline — candidate positions are tested against the
polygon and a building where none fits becomes single-storey rather than a lie.

## js/pieces.js — plan → boxes (pure data, no three.js)
```js
export function interiorPieces(plan) → piece[]   // floors, lining, partitions,
export function shellPieces(plan) → piece[]      // stairs, rails, furniture
```
BOTH are built the moment a building is ACTIVATED — the shell is not held back
for damage. That is what makes windows real openings with real panes (you can
see into a building without shooting it) and what removes the on-hit pop
entirely: before and after are the same geometry. Each exterior BAY becomes
plaster-below-sill, plaster-above-lintel, two jambs and a pane, and every solid
one samples the exact atlas sub-rectangle the painted facade would have used —
WIN_BAND / WIN_FRAC in meshes.js are the shared agreement on where a window sits
inside a cell. Slabs subdivide at the footprint boundary so nothing pokes out
through the facade; ceilings and roofs do not (nobody stands on them).
Nothing emits a surface. Slabs are grids of TILES, walls rows of PANELS, stairs
stacks of STEPS — so a wall is not a thing that can be holed, it is forty things
that can be deleted. A tile touching a void (stair well, atrium) subdivides 4×4
so the hole stays open; getting that wrong sealed the first version's staircases
shut. The outer leaf wears the FACADE's own colour, window rhythm and AO
(`plan.wallHex`, stamped by interiorsim from `meshes.buildingWallHex`) so a
building does not change identity the instant a rocket promotes it to boxes.

## js/destructible.js — BuildingModel, Debris, Dust
One InstancedMesh per building (plus one for glass); a hit rewrites the instance
buffers and drops `count`. **Structure is a grid**: ~1.6 m cells, support
propagates DOWN a column for free and SIDEWAYS at a cost of one unit per cell
(SPAN = 6), so a wall stands, a floor plate spans ~10 m, and anything further
out falls. A second BRACING test drops splinters that have no lateral neighbours
above stub height. `_collapse` releases the condemned pieces in WAVES lowest
first, so a collapse travels through the building instead of happening in one
frame. Cost on a 12 800-piece tower: ~13 ms for the first hit (the pair-wise
graph this replaced cost 150 ms), ~2 ms after.

## js/interiorsim.js — Interiors (policy + people)
Activates the interiors of the ~8 nearest buildings while the player is on foot
(a building whose DOOR you are standing at always wins a slot and is built
immediately), keeps every wrecked building for the session, owns the shared
debris/dust pools, and answers `supportY` / `pushOut` / `occupied` / `modelAt`
for the walk controller and the chase camera. Occupants are the same box people
as the pavement crowd: they walk between the rooms of their floor, run for the
stairs when something goes off, and — if the floor is blown out from under them
— GRAB THE LEDGE and hang there before climbing back or losing their grip.

## js/weapons.js — the rocket pod (V)
Unguided, 55 m/s off the rail to 210 m/s on the motor, slight droop. Impact is
resolved by sub-stepping the flight path in 1.2 m bites against the footprint
index AND `world.solidAt` (the box models), which is what lets a second rocket
fly through the hole the first one made. `aimPoint()` runs the same integrator
ahead of time; main.js projects its answer onto the screen, so the reticle hangs
over the helicopter and slides onto the target as you nose down.

## Integration
- **city.js** owns `interiors`, and gains `supportY`, `roofY` (land the
  helicopter on a roof, walk on it), `buildingHitAt`, `solidAt`,
  `damageBuilding`, `hideBuilding` and `_rebuildBuildings` (re-mesh ONE chunk's
  building batch in place). `collide(pos, r, opts)` takes `opts.interior` (use
  the boxes) and `opts.aboveY` (a roof below you is not an obstacle).
- **player.js** has a `y` now: gravity, and a 0.55 m step-up that turns eighteen
  tread boxes into a staircase with no stair code at all.
- **meshes.js** cuts the front door into the facade and dresses it with a
  surround, a canopy and a lit sign board (two extra batches per chunk), and
  exports `buildBuildingsMesh` + `buildingWallHex`.
- **settings.js** gains `interiors` (off on Low). Wrecks survive the toggle.

## Verification
`npm test` covers classification against the real chains, "every multi-storey
building has treads you can climb", "no slab roofs over its own staircase",
piece sanity, and the door being on the footprint.

---

# v6 contract: České dráhy

The region holds 1465 rail ways (532 km) and 25 named `pois` with `t:'station'`
— Pardubice hl.n., Hradec Králové hl.n., Chrudim, Přelouč, Holice and the rest.
Trains run on that real network and the player can ride them.

## js/trains.js — AGENT TRAIN
```js
export class Trains {
  constructor(scene, city, opts)      // opts { onBoard?, onAlight? }
  update(dt, focus)                   // stream, drive, stop at stations
  nearestBoardable(x, z, r)  → train|null   // a HALTED train within r
  board(train) / alight()  → bool
  riding                              // the train being ridden, or null
  trains                              // live Set
}
```
- ROUTES, not a graph: chain rail ways whose endpoints coincide (≤3 m) into
  long polylines ONCE per streamed tile, keep routes ≥ 800 m, and drop any
  `t:'tram'`. Trains own a route + a direction and simply advance along it;
  at the end they reverse. This is far more stable than the road graph — rails
  do not need junction choice to look right.
- STOPS: a station POI within 60 m of a route point becomes a stop on that
  route. Approaching one, the train brakes to a halt, waits DWELL≈14 s with
  doors "open" (a lit strip + the door sound), then pulls away. vmax 40 m/s
  (144 km/h), accel 0.55 m/s², brake 0.9 m/s² — a train must feel heavy.
- CONSIST: locomotive + 3–5 carriages, coupled and following the SAME
  polyline offset back by their length, so the set articulates through curves
  instead of sliding as one rigid box. Bogies ride `world.heightAt`.
- ČD LIVERY: modern České dráhy — dark blue body (#12305e), a white band at
  window height, a light-grey roof, dark window strip, and the ČD red accent
  (#c8102e) on the nose. Low-poly to match the cars. Cab windows, headlights
  (emissive, toneMapped:false so bloom bites at night), and a small painted
  "ČD" plate. Carriages get the same band and window rhythm.
- STREAMING: keep ~6 trains alive within 3.5 km of the focus, spawn beyond
  600 m so none pops in view, despawn past 4 km. Zero per-frame allocation.
- RIDING: `board()` hides the player mesh and parks them in the cab; `update`
  keeps `player.pos` on the train so the camera and streaming follow it.
  `alight()` only succeeds while halted, and places the player beside the
  train clear of the track.

## js/audio.js additions — AGENT TRAIN (same agent, keep the existing API)
`trainStart()/trainStop()/trainSet(speed01)` — a procedural rolling loop:
filtered noise for wheel roar plus a periodic rail-joint clatter whose rate
follows speed, and a low traction hum. Plus `sfx()` clips generated by
scripts/gen-sounds.mjs: `train_horn` (two-tone Czech loco horn), `train_pass`,
`station_bell` (the ČD platform chime), `train_doors`.

## main.js integration (MINE)
E boards/alights a halted train the way it does cars; the HUD shows the
station name and "odjezd" countdown while stopped.

---

# v8 contract: the world reaches Prague

The world was a 30×38 km rectangle around Pardubice: 72 tiles, 163 k buildings.
It is now the **D11 corridor** — Prague, the motorway, the villages strung along
it, Hradec Králové and Pardubice — **185 tiles, 110 km end to end, 831 k
buildings, 245 MB**. Everything below exists because that is a different order
of magnitude, not a bigger number.

## The shape of the world — scripts/lib/world-area.mjs
A rectangle spanning Prague to Hradec would be 252 tiles, most of them farmland
nobody drives through. The world is a UNION of shapes: the original
agglomeration box, a ±8 km BAND along the D11/D35 centreline (sampled at its
junctions), and a box over Prague. `tileWanted(tx, tz)` is the single answer to
"is this tile part of the world", and the splitter, the builder and the manifest
all ask it — the world's shape is one edit away and the scripts cannot disagree.

## Getting the data — scripts/{fetch-world,split-extracts}.mjs + lib/osmpbf.mjs
Overpass was one bbox query per tile. At 185 tiles — and with Prague's density —
it answers "runtime error: the server is probably too busy" more often than it
answers data, and a clean run is hours. Replaced by four Geofabrik `.osm.pbf`
extracts (praha, středočeský, královéhradecký, pardubický; ~320 MB) and a
**zero-dependency PBF reader** (`lib/osmpbf.mjs`: varints, packed fields, zigzag
deltas, zlib blobs — the format's field numbers ARE the schema). Whole-country
parse is seconds, not hours. `npm run fetch-world` is download → split → IPR →
build → gazetteer, all re-runnable.

`split-extracts.mjs` writes `data/raw-region/<tx>_<tz>.json` in exactly the
shape Overpass' `out geom` produced, so build-region needed no new parsing —
only `"owned": true`, which says "this element is already in its one tile, skip
the first-vertex test". A raw file without the flag is an old Overpass download
and still gets tested.

## Prague's real heights — scripts/fetch-ipr.mjs + the join in build-region
OSM has a height for barely half of Prague's 447 k footprints; the rest fell
back to "2 storeys ≈ 7.4 m", which flattens Staré Město into a village. IPR
Praha publishes its own survey (CC BY): 145 123 buildings with a storey count
and a coded roof shape. The join is spatial — IPR and OSM drew the same city
twice and share no ids — an IPR centroid inside an OSM footprint is the strong
match, nearest-centroid within 9 m the fallback for courtyard blocks whose
centroid lands in the yard. **109 700 buildings** now carry surveyed storeys and
roofs. An explicit OSM `height` still wins: that is a measurement.
`h` is the wall height to the EAVES in both paths — the pitched roof above it is
geometry, so adding a ridge allowance to `h` as well would count it twice.
Attribution is required and lives in README: *datový podklad © IPR Praha*.

## Roofs that follow the plan — meshes.js `roofCap`
A village house is one ridge over one rectangle and `ridgePrism` (OBB, < 300 m²)
is right for it. Prague's blocks are 400–2000 m² and L- or U-shaped around a
courtyard, where one ridge would sail over the yard. Those get a CAP: the real
outline offset inward along each vertex's angle bisector and lifted — which is
what a hipped or mansard roof IS, and it turns every corner of the plan.
Naive offsetting folds through thin wings: measured over the real footprints,
**55 % self-intersect at full depth**, and the area/winding guards do not catch
it. So the depth STEPS DOWN (1, ½, ¼, ⅛) until `ringSelfIntersects` says the
ring is simple, the rise follows the depth that survived, and anything still
knotted stays flat. Result over the whole world: 12 310 of 13 742 pitched blocks
capped, 440 866 triangles, **zero down-facing, zero below the eaves**.

## Surviving 110 km — the engine
- **float32.** Geometry was authored in world coordinates with chunk Groups at
  the origin. At Prague (x ≈ −95 000) float32 spacing is 7.8 mm and, worse, the
  vertex shader subtracts two ~10⁵ numbers, so the city SWIMS. `meshes.rebase()`
  shifts each finished chunk to be local to its own centre and puts the offset
  in `Group.position`, where three.js computes it in float64 on the CPU. The
  shift runs on already-float32 arrays, so vertices stay snapped to that 7.8 mm
  grid — invisible on a low-poly city; it is the jitter the eye catches, not the
  snap. `city._rebuildBuildings` re-applies it to a re-meshed batch.
- **Eviction.** Tiles never unloaded. Driving the D11 end to end crosses ~50 of
  them, and holding every building would be about a gigabyte. A tile 9 km behind
  goes SLIM: buildings and trees are unpicked from the chunk index and compacted
  OUT OF THE FLAT ARRAYS IN PLACE (every consumer holds those by reference
  forever), and re-fetched if you come back. Roads, rails, water and green stay
  resident — the world map draws them, the traffic graph is built from them, and
  they are a third of the weight. Feature `_id`s are derived from the tile slot,
  not a global counter, so a building that leaves and returns is the SAME
  building (ids seed tree jitter, lamp stagger, which shed is a franchise).
  A wrecked building pins its tile: `city.keepAlive`.
- **Traffic.** Four passes answered "what is near this point?" by scanning every
  junction or every edge. Fine for 2 000 roads; for one central Prague tile's
  18 000 it is hundreds of millions of distance tests and the tab stops dead.
  All four now query a 64 m bucket grid (`Buckets`) — every radius involved is
  ≤ 45 m, so the 3×3 neighbourhood is exhaustive. This is what made Prague load.
- **Ortho** clamps to a data-shaped box, not the old ±30 km radius.

## The map — public/data/overview.json + worldmap.js
The map draws the LIVE city arrays, which over 110 km means Prague is not on it
until you have personally driven there. `build-region.mjs` also emits a sketch
of the WHOLE world — motorway→secondary roads, main lines, big water, big
forests, and built-up area as run-length-merged 200 m cells — ~3 MB, in the same
feature shape the map's own helpers take, so it goes through `_polys`/`_roads`
unchanged and live detail paints over it. `places.json` is rebuilt from the same
extracts: **2 331 named settlements** (was 429), Praha included.

## Verification
`npm test` (17 tests) still passes. Prague renders at 56–78 fps at max settings
with zero console errors; the Vltava, its bridges, the tram network and the
signals are all there. meshes.js imports in node under a `three` resolver, which
is how `roofCap` was checked over all 13 742 real pitched footprints.

---

# v9 contract: airfields and the Gripen

## The data — aeroway, at last
The pipeline never fetched `aeroway`, so both airports were blank fields with a
terminal on them. `split-extracts.mjs` now wants every aeroway way, and
`build-region.mjs` sorts them into the layers that already exist rather than a
parallel one: **runways and taxiways ride the ROAD layer** (they are polylines
with a width — which is what a road is), and aprons/helipads ride `paved`.
That buys streaming, collision, the minimap and the world map for free.

Runways carry `d: 0` so the traffic AI never routes a Škoda onto one, and the
road `width` sanity cap opens from 30 m to 90 m for aeroways or a 45 m strip
would be clamped to a bus lane. `ref` ("09/27") comes through for the paint.
What the world got: **Pardubice LKPD** 09/27, 2 499 m × 75 m, 102 taxiways,
6 aprons; **Praha LKPR** 12/30 at 3 200 m and 06/24 at 3 724 m (two ways),
182 taxiways, 30 aprons.

## The paint — meshes.js `runwayPaint`/`taxiPaint`
A runway is not a wide road, and the entire difference is paint. Three marks at
real ICAO dimensions: the 30 m / 20 m dashed centreline, the threshold "piano
keys" (30 m × 1.8 m, count scaled from the strip's width), and edge stripes set
3 m in from each lip. Taxiways get the one mark that matters — a continuous
YELLOW centreline, which is the thread that visibly ties apron to threshold.

## js/aircraft.js — Saab JAS 39 Gripen
The type the Czech Air Force actually flies. Mach 2 (2 484 km/h), 14.1 m long,
delta-canard, single fin — modelled from the three shapes that make it
recognisable at a glance and nothing else.

The flight model is deliberately NOT the helicopter's. A helicopter hangs under
a thrust vector and can stop in the air; a fighter is a dart that has to keep
moving. Velocity follows the NOSE, and everything interesting falls out of three
real relationships:
- **Top speed is not a constant.** It is where thrust meets drag, and drag
  scales with air density (`ρ = exp(−y/8500)`). Sea level tops out at
  1 410 km/h; Mach 2 costs ~12 km of altitude. Climbing IS the throttle.
- **A turn is a banked turn**, ω = g·tan(φ)/V. Roll and the heading follows;
  because V is in the denominator the turn widens as you go faster. There is no
  separate steering input in the air.
- **Control authority scales with dynamic pressure.** Parked, the stick does
  nothing; below V_ROTATE (70 m/s) the nose will not come up.

Thrust is quoted in g because that is what makes it checkable: 0.56 g dry,
1.12 g in reheat. The first cut used 4.5 g and rotated after **77 metres**,
which is a catapult — `tests/aircraft.test.mjs` exists to catch exactly that
class of drift and pins rotation speed, take-off roll, both top speeds, the
turn-rate/airspeed relationship, the stall, and the landing rollout against
Pardubice's 2 499 m.

## js/airfield.js — where the machines live
The helicopter used to sit on the station forecourt, which was convenient and
slightly absurd. `AIRFIELDS` places a pad, a helicopter and 2–3 Gripens on the
real apron at each airport. Every parking spot was chosen by testing candidate
points against the actual apron polygons and rejecting anything inside — or
within 22 m of — a building, so nothing is parked in a hangar wall.
main.js keeps flat `helis`/`fighters` lists and one rule: walk up, press E.

## main.js integration
`game.jet` beside `game.heli` (never both). The stick is W/S pitch (back = nose
up, as in every aircraft), A/D roll, arrows throttle and rudder, Shift for the
burner — deliberately not the helicopter's mapping, because a jet has no
collective and sharing a key between thrust and climb would bury the one
control that matters. The chase camera hangs 14–40 m back and widens 22° with
speed; the streamer gets `chunksPerFrame = 14` while a jet is up, because a
Gripen crosses a 120 m chunk in a sixth of a second.

---

# v7 contract: navigation

Roads carry `n` (street name) on ~23 % of ways — every named street; the rest
are service roads and footways. `public/data/places.json` holds 429+ named
settlements with a rank. Together these are enough to answer "where am I" and
"how do I get there" without any new download.

## js/navigation.js — AGENT NAV
```js
export class Navigation {
  constructor(city)
  setDestination(x, z) / clear()
  update(dt, x, z)                 // re-routes when the player leaves the path
  route                            // [[x,z]…] world polyline, or null
  remainingM                       // metres left along the route, or null
  nextTurn                         // { dist, dir: 'left'|'right'|'straight', street } | null
}
```
- Build a DRIVING graph from `city.roads` with `d === 1`, exactly the way
  traffic.js already keys its nodes (round the coordinate) so the two agree;
  grow it incrementally from `city.onTileLoaded`.
- A* over that graph, cost = length / speed (so it prefers main roads), with a
  straight-line heuristic scaled by the fastest speed in the graph so it stays
  admissible. Cap the expansion (~40 k nodes) and return the best partial路
  route if the target is unreachable — a car in a village must still get a
  line toward the motorway rather than nothing.
- Snap start and destination to the nearest graph edge, not node.
- Re-route only when the player is > 35 m from the route, and at most once a
  second: a route is expensive and a driver weaving in a lane is not lost.

## js/navline.js — AGENT NAV (same agent)
```js
export class NavLine { constructor(scene); set(route); clear(); update(dt, x, z, world) }
```
The GPS line drawn ON the road: a ribbon ~1.6 m wide following the route
polyline, laid at LAYER_Y.marking + 0.02 so it sits above the tarmac and the
lane dashes, bright cyan (#25d0ff) with a soft emissive glow (toneMapped:false
so bloom catches it), and a subtle scrolling texture offset so it reads as
"flow toward the destination". Only the next ~400 m of route is built into
geometry; rebuild when the player advances past a threshold. Fades out behind
the car. Hidden when the player is not driving.

## js/place.js — AGENT PLACE
```js
export class PlaceFinder {
  constructor(city)                        // loads places.json itself
  update(x, z)                             // throttled internally
  town     // "Pardubice" | null
  street   // "Masarykovo náměstí" | null
}
```
- Street = the nearest `city.roads` way with a name whose distance to (x,z) is
  under (w/2 + 12) m, searched through the chunk index (never the whole array).
- Town = the nearest place from places.json, weighted by rank so a city wins
  over a neighbourhood at similar distance; report nothing past ~4 km.
- Both are sticky: a name only changes after the new one has held for ~0.6 s,
  so walking a junction does not flicker between two streets.

## Labels on the maps — AGENT LABELS
- `js/minimap.js`: draw street names along the road they belong to, inside the
  circular clip, only for roads whose class is >= residential and only when
  the name fits the drawn length; rotate the text to the road's angle, keep it
  upright (flip if it would read upside down), and cap the number drawn.
- `js/worldmap.js`: the same, at map scale — street labels appear from zoom
  >= 3, with the same collision-box rejection the place labels already use.

## main.js (MINE)
A HUD readout bottom-left showing town + street, and the destination handed to
Navigation whenever the world map's waypoint changes.

## Chunks are meshed off the main thread — js/meshworker.js + js/meshpool.js
A dense Pardubice chunk is 30–330 ms of geometry. Slicing the builder against a
frame budget spread that cost out; it never removed any of it. Now the work
happens in a pool of `hardwareConcurrency − 1` module workers (capped at 4) and
the frame's share is a spec and a decode.

    js/chunkspec.js   the INPUT codec: one chunk's cells, junction pads,
                      waterways, pois, hidden set, terrain + canopy rasters and
                      the ortho plan, as plain data postMessage can clone.
    js/meshworker.js  buildChunkPayload(state, spec) → geomcodec bytes. The
                      message handling is a pure (state, msg) function so node,
                      which has no DOM Worker, can test the real code.
    js/geomcodec.js   the OUTPUT codec (already there): one transferable
                      ArrayBuffer per chunk.
    js/meshpool.js    the main-thread half: submit / poll / finish, plus every
                      road back to the synchronous builder.

Measured over the ten densest chunks of central Pardubice with facades on:
**79.5 ms → 3.85 ms of main thread a chunk (20.6×)**, worst chunk 179 ms → 4.1 ms.
With the aerial photo on (a cheaper ground) 41.8 ms → 3.8 ms.

Three things a worker cannot build, because each is painted on a `<canvas>`:
the facade window atlas, the brand wordmarks and the aerial photo material. All
three are handled by NAMING rather than by switching off — the geometry comes
back with its atlas uvs and a material key, and the main thread resolves the key
to its own singleton (`facadeMaterial`, `brandMarkMat`, the ortho plan's `mat`).
The wordmarks then go one step further on the main thread: a label is a slot
of a shared 2048 x 1024 page (js/wordmarkatlas.js), and `mergeMarks` folds a
chunk's per-chain quads into one mesh per page with their uvs remapped, after
the decode (js/meshpool.js finish) and at the end of a synchronous
buildBuildingsMesh alike. The worker still sends one stream per chain. The
merged mesh lists its labels in `userData.marks`, which CityWorld._sweepMarks
counts, so a label in view never gives its slot away. A label is any shop's
own name (487 of them in the old town), so the pages go up to 32 (1024
labels) before a label falls back on a canvas of its own.

Two invariants worth knowing before touching js/city.js:
- **A key in `_inflight` is being built and is in neither `built` nor the
  queue.** The Map holds every flight; the ring scan, `_requeueCells`,
  `_dropTileChunks` and `_rebuildBuildings` all consult it.
- **At most one flight is synchronous.** It is a generator pumped against the
  frame budget, and two of those would divide the budget rather than spend it.

The fallback is not decorative. Under vite the bare `three` specifier resolves
for workers as it does for the page; opening index.html straight off disk, the
`<script type="importmap">` does NOT cover workers, so the worker fails to load
— and every chunk is built the old way. Same road out for a browser with no
Worker, a postMessage that throws, or three failed builds in a row.

No SharedArrayBuffer: it needs COOP/COEP, and `require-corp` would break the
ČÚZK ortophoto WMS (no CORP header) — the photos would silently stop loading.
The rasters are copied and transferred instead, once per worker per tile, with
a version bumped whenever the earthworks reshape a height grid in place.

# v10 contract: the city speaks

The crowd has been walking past the player since v5 and had never once noticed
they existed. You could clip a man with a wing mirror at fifty and he would get
up and keep walking. This contract gives Pardubice a mouth: **314 authored
Czech lines**, spoken aloud and shown in a bubble over the speaker's head.

## The four files, and why it is four and not one

    js/chatterlines.js   PURE DATA. 240 lines + 24 two-handers (74 turns), the
                         four-voice cast, and the id→filename rules. No imports.
    js/chatter.js        THE BRAIN. Who speaks, when, about what, and the rate
                         limits that stop it becoming a market. Imports only
                         the corpus, worldclock and audio — never three.js, so
                         it is testable headless.
    js/chatbubbles.js    THE RENDERER. A sprite with a canvas texture. No
                         timers, no policy; it is handed a list of live
                         utterances once a frame and draws them.
    scripts/gen-voices.mjs  Renders every line to mp3 through ElevenLabs.

The split between the brain and the renderer is what makes `tests/chatter.test.mjs`
possible: 31 assertions about casting, gender, cooldowns and conversation
lifecycle, with no canvas, no WebGL and no AudioContext in the process.

## The corpus

Twelve categories, each a situation: `nearmiss` `horn` `bump` `hit` `victim`
`bang` `driver` `player` `idle` `local` `tod` `phone`. Plus the two-handers.

**Point of view is part of the category.** `horn` and `hit` are pools chatter
only ever hands to a *pedestrian*, so lines written from inside a car ("Zhaslo
mi to, no!", "Já ho neviděl, vběhl mi pod kola!") were coming out of a
passer-by's mouth — seven of them, caught by review. They live under `driver`
now, and a test guards the property rather than the individual lines. `victim`
is the four lines the person **you** knocked down says once they are back on
their feet: `pedestrians.js` puts a survivor through rag → down (2–4 s on the
tarmac) → walk, and chatter watches for that state to come back round, because
"Bolí mě hlavně hrdost" from a man still in the air is a joke told too early.

**A line's `id` IS its filename.** `assets/voices/<id>__<cast key>.mp3`. Ids are
ASCII-only (a diacritic in a filename is a 404 waiting for a case-folding
difference between macOS and Linux — one was caught by the test) and may be
added freely but never renamed: a rename orphans a rendered file and bills a
new one.

`when` gates a line on `worldclock.tod()` — `morning` `noon` `evening` `night`.
The weather values (`rain` `cold` `hot` `fog`, 16 lines) are deliberately
present and deliberately dead: this build has no weather, so nothing can
satisfy them and those lines never play. They are written, rendered, and
waiting for the day sky.js grows a rain cloud.

## The cast is four, and a citizen keeps their voice

Two men, two women. **Every line is rendered by every cast member who could say
it** — 898 clips — and that is what buys the property worth having: a citizen's
voice is `hash32(seed)` off the same integer that already picked their jacket,
so it never changes between sentences, holds across both halves of a
conversation, and is the same voice on a co-op partner's machine. A per-person
pitch offset of ±7 % on top of four recordings is what stops forty walkers
sounding like four people. Nothing about the box people is gendered, so `g` is
a voice attribute and not a claim about the character.

## Distance has to FILTER, not just attenuate — js/audio.js `speakAt()`

`sfxAt()` was the wrong tool and the reason is physical. A bang forty metres
away really is mostly a quieter bang; a *voice* forty metres away has lost its
consonants. So a spoken line gets four things off the one distance number:

| | at your elbow | at 42 m |
|---|---|---|
| gain | full | the same 1/r law every other cue uses |
| lowpass | 16 kHz | **1.1 kHz** — this is what "far" actually sounds like |
| highpass | 20 Hz | 300 Hz — distance takes the chest weight out too |
| reverb send | 0 | 0.55 into a shared 1.1 s convolver, tapped *after* the filtering |

Range is **42 m** and that is content, not mixing: past that you cannot make out
words on a real street, and a readable bubble over an unintelligible voice is
worse than silence. What fills in beyond it is already in the mix —
`city_ambience.mp3` is, by its own generation prompt, "faint indistinct
murmuring voices far off". **Polyphony is 3.** A buffer name prefixed `v/`
routes `loadBuffer` to `assets/voices/` instead of `assets/sounds/`; that one
prefix is the whole integration.

## Determinism, and its limits

**Ambient is deterministic. Reactions are local.**

Which line a citizen says in a given 8-second slot is `hash32(their seed, slot)`
— no `Math.random` on that path, so two players on the same corner hear the same
sentence. What stays local is whether you were near enough to hear it, because
the budgets are about your ears and not about the world. Reactions are local
outright, exactly as the traffic horn is (traffic.js:2291) and for the same
reason: the event that caused them happened on one machine. Speech never moves
anybody, so local divergence is survivable here in a way it would not be for
the walk itself.

`pedestrians.js` gained one field for this: **`pid: s.seed`** on the body at
`_attach`. `_cutLoose()` nulls `sch`, and being run over or ghosted is exactly
when a body most needs to still be somebody.

## The rate limits ARE the design

The failure mode of this feature is not silence, it is a market square: eight
bubbles, three overlapping voices, and a player who switches it off in a minute.

- one ambient line near you every ~5 s, never the same sentence within 45 s
- at most 2 conversations running
- a 16–28 s cooldown per person, a 0.85 s global floor between reactions
  (armed by reactions only — a mutter is not an event and must not spend an
  event's budget, which was costing about one reaction in six)
- at most 2 witnesses answer any one event
- 10 bubbles drawn at once, hard cap (legibility, not performance)
- and under all of it, audio.js's three voices

Every cooldown here is an **absolute deadline**, not a countdown. The first
version copied `pedestrians.js`'s `hitCd` idiom — stamp a duration, test `> 0` —
but pedestrians.js decrements `hitCd` in its walk loop and nothing ever
decremented ours. A citizen who said one word was mute for the rest of their
420-second life, the busiest street went quiet after a minute, and every test
still passed, because "he does not speak twice" is what a working cooldown
looks like from the outside too. A timestamp cannot rot: no per-frame pass to
forget, no question about who ticks whose field. `tests/chatter.test.mjs` now
asserts the cooldown **ends**, which is the assertion whose absence hid it.

## Wiring (main.js, MINE)

    peds.onPedHit    → chatter.pedHit()      (and the scream now uses the
                       SAME seed as the speaking voice, so the person who
                       yells is the person who talks)
    peds.panic       → chained, so every present and future panic source
                       (weapons, corpses) feeds chatter.bang() for free
    city.crashDebris → chained: a car folding round a lamp post is the best
                       thing that can happen to a bystander's day
    traffic.onHonk   → new single-slot sink, fired from BOTH honk sites

**H is the horn**, and it is new: the AI has been honking at the player since v7
and the player could never honk back. It goes through the same sink as an AI
honk, so a pedestrian cannot tell who leaned on it.

`chatter.update()` runs **after `updateCamera()`**, not next to `peds.update()`.
Bubbles are screen-referred sprites scaled off view distance, so pumping them
before the camera moves sizes every one of them against last frame — visible as
a bubble that lags a hard corner.

## Generating the voices

    ELEVENLABS_API_KEY=sk_... node scripts/gen-voices.mjs

904 clips, ~26 000 characters, `eleven_v3` with `language_code: 'cs'`. Each
line's `tts` field (an English delivery direction) is prepended as a bracketed
tag — **verified by transcribing the output that v3 shapes the delivery without
speaking the tag**. `stability: 0.35` is what lets a shout be a shout; the
default sits the model in its audiobook register, which is the most common way
street dialogue comes back sounding like a museum guide.

Only missing files are billed. Concurrency is **3**: at six, a Creator-tier key
answers ~180 clips and 429s the other 720 — measured. 429 and 5xx retry with
jittered exponential backoff; a non-429 4xx fails immediately, because waiting
does not fix being wrong. `--stale` deletes orphaned mp3s.

**Editing a line's text does not orphan its mp3** — same id, same filename — so
the bubble would read one sentence while the voice said another. Delete those
by hand or `FORCE=1`.

## Verification

    npm test          # tests/chatter.test.mjs — 38 assertions

The one that matters most is *"every line a citizen can say has a clip rendered
in their own voice"*: it walks 270 seeds × 240 lines and asserts the file the
game will ask for is one the generator was told to produce. Nothing else in the
build connects those two halves, and a mismatch is inaudible rather than loud.

---

# v11 contract: the shops have their real names

Until this contract the pipeline threw away **every named shop and eatery node
in the country**. `scripts/split-extracts.mjs` kept four amenity values
(`fuel|hospital|police|fire_station`) and the string `shop` did not appear in
the file at all, so the loss happened at stage 1 and nothing downstream could
have recovered it even in principle — measured in the product, not the extract:
`grep -c McDonald data/raw-region/0_0.json` was **0**.

What the game did instead was **invent** the missing trade. `js/interiors.js`
`stampFranchises()` picked buildings by hash near a station or a hypermarket car
park and renamed them McDonald's or KFC. Meanwhile the real McDonald's
(node/13970695060, 241 m from the origin), the real Lidl (node/3394785494), the
real Česká pošta (node/12569453187) and the real coraHB (node/13634813428) stood
within 450 m of Pardubice hlavní nádraží and reached nothing.

Measured over the six extracts inside the world mask, node ids deduplicated:
shop 19 317 (16 559 named), restaurant 5 603 (5 302), cafe 1 809 (1 704),
fast_food 1 778 (1 500), pharmacy 1 094 (1 044), post_office 1 075 (1 060),
bank 608 (594) — **31 284 nodes, 27 763 of them named, and the pipeline kept
zero.** Full survey: `docs/OSM-COVERAGE.md`.

## scripts/lib/venues.mjs — ONE definition, two scripts

The splitter must keep the node and the builder must emit it, and the two must
never disagree about the tag list again, so both import the same module.

    venueKind(tags)  → the OSM value that says what a place SELLS, or null.
                       shop=* (minus no/vacant/closed), a named list of
                       amenity=*, tourism=hotel|museum|attraction, and office=*
                       collapsed to one 'office' (its 73 values look identical
                       from the street and the tiles are committed to git).
    venueName(tags)  → name ?? brand. NOT operator — on Czech data that is
                       mostly "Česká pošta, s.p." bolted onto street furniture.
    isVenue(tags)    → both of the above. The wantNode/wantWay clause.
    joinVenues(buildings, venues) → hangs each venue on the footprint it stands
                       in; MUTATES `n` and `u`; returns the claim statistics.

## THE JOIN IS A BUILD-TIME JOIN

OSM maps a shop three ways — tags on the building way, a node inside the
footprint, or a node in the doorway — and only the first ever reached a tile.
`scripts/build-region.mjs` now resolves the other two **per tile, offline**:

- INSIDE wins, and the **smallest** containing footprint wins, so a bakery
  inside a gallery names the unit it was drawn in and never the whole gallery.
- BESIDE (≤ 10 m) is the fallback for a doorway node, and only onto an unnamed
  building under 2 000 m² and 12 m tall. That gate is what stops a bistro
  renaming the eight-storey block it occupies the corner of.
- A surveyed building name ALWAYS outranks a POI node standing in it.
- Several venues in one block resolve by trade rank (a supermarket defines a
  building, the accountant on its third floor does not), then by name order, so
  the answer never depends on the order the PBF stored two nodes in.

Measured on the two Pardubice tiles (`-1,-1` and `0,-1`, 15 339 buildings):
1 384 venues landed inside a footprint, 25 in a doorway, **641 buildings took a
real OSM name**. Named buildings 721 → 1 362. Buildings wearing a fascia
200 → 706, of which the fascia shows the building's **own OSM name** 61 → 584.
New use classes that no guess could ever have produced: restaurant 0 → 125,
supermarket 23 → 62, school 59 → 89, hotel 18 → 26. Tile cost **+1.4 %**.

## The tile format gains one layer

    venues: [{ p:[x,z], t:kind, n:name, b:brand? }]

…and buildings gain `u`, the shop/amenity value. `js/interiors.js` `classify()`
had read `f.u` since v7 and **no build script had ever written it**.

A venue whose name is now ON a building is dropped from the layer — the same
string twice is the one cost this change does not have to pay. What ships is
the trade no footprint absorbed: a block's other tenants, the units inside a
gallery, a stall on a market square. `js/geo.js` bucketizes them by chunk (not a
flat list — `evictFar` gives back buildings and trees and nothing else, so a
linear scan would grow for as long as the session runs) and `venueAt(city, x, z,
maxD)` reads one 3×3 of cells. The on-foot HUD hint asks it when nothing
actionable is in range: 🏪 Sportisimo.

## `u` describes the GROUND FLOOR

The one place the trade must not win is Czech mixed use. A potraviny in the
corner of a panelák is a potraviny, not a five-storey supermarket — and it would
be, because `shop` is promoted past 900 m² and `restaurant` is laid out as a
single open volume, so the block would come out one storey tall. `classify()`
therefore refuses to let `u` retype a building OSM explicitly typed as housing,
and `signBrandOf()` reads `u` on its own so the shop still gets its fascia.

## What was deleted

`stampFranchises()`, `anchorsOf()`, `FRANCHISES`, `HOST_USES`, `HOST_TYPES`,
`ANCHOR_R`, the `_frAnchors` / `_frServed` caches on `city`, `CityWorld._stamped`
and its two call sites, and the three tests that pinned the guess's behaviour.
The `BRANDS` table stays: it is the LOOK of a chain (wall colour, cladding,
storey rules), and it is now keyed off a name that came out of OSM.

## Verification

    npm test          # tests/venues.test.mjs — 8 assertions

`tests/fixtures/pardubice-hlavni-nadrazi.json` is 45 kB of **verbatim stage-1
output** — every building way and every shop/amenity/office/tourism node in a
600 × 260 m box on the world origin, at OSM's own coordinate precision — because
`data/raw-region` is 2.1 GB and gitignored. The test that matters asserts the
McDonald's by Pardubice hlavní nádraží comes from **node/13970695060** and lands
within 40 m of where the surveyor put it (measured: 5 m). If the extraction
filter ever loses the shops again, that is the test that says so.

## Regenerating the world

    node scripts/split-extracts.mjs      # ~6 min, rewrites data/raw-region/
    node scripts/build-region.mjs        # HOURS, rewrites all 342 tiles

Both are required — the names are lost at stage 1, so rebuilding tiles alone
changes nothing. `--tiles=-1,-1 0,-1` rebuilds a subset, but note it also
rewrites `overview.json` from only those tiles, so it is for scratch `OUT_DIR`
runs and never for `public/data`.


# v11 contract: the crowd stops being one person

The city had ONE body — eleven boxes, 1.75 m tall, and only the palette changed
between them. The user's word for it was "Minecraft". Five bodies now walk
around Pardubice, and the whole design rests on one observation: **at twenty
metres the eye reads structure, not colour.** Fifteen centimetres of height, a
narrower shoulder, a stoop and a walking stick are legible down a street; a
different jacket is not.

## js/people.js — the third module that exists so two others can agree

    m30  1.78  28 %   the default bloke
    f30  1.69  26 %   narrow shoulders, waist, long hair
    f60  1.63  18 %   shorter, fuller waist, bun, hip-length coat
    m60  1.76  20 %   heavier, greying, shorter stride
    m90  1.67   8 %   stooped, thin, slow, walking stick

It imports **nothing** — not three.js, not the clock — and that is its purpose.
`js/citizen.js` builds the mesh and therefore needs three; `js/chatter.js` picks
the voice and must never touch three, or the headless tests die. A grandmother
has to *sound* like a grandmother, so both have to draw the same archetype from
the same seed, and the only way to guarantee that without one importing the
other is a third module that imports neither. `ARCH_SALT` lives there for the
same reason: a constant two modules must agree on belongs to neither of them.

The weights are not uniform on purpose — a ninety-year-old on a stick is
something you notice *because* it is rare. Uniform weights put one in five.

## The model got better and got CHEAPER

|                | old | new |
|---|---|---|
| meshes per body | 15 | **13** (14 with a stick) |
| materials | up to 5 | 1 shared + limbs |
| geometry | all shared | shared limbs + one ~9 kB cluster per body |

Everything that does not articulate — head, hair, eyes, pupils, nose, mouth,
neck, chest, waist, shoulder yoke, hips, coat — is **merged into one mesh with
vertex colours**, drawn with a single material every citizen in the world
shares. (The old header claimed eleven meshes; it was counting the eleven
*children* of the body group, four of which were pivot Groups holding two
meshes each. Measured with a traverse, the old figure drew fifteen.)

That merge is what pays for the detail: **static boxes are free**. The torso is
four boxes (hips → waist → chest → shoulder yoke) instead of one slab, because
a waist narrower than the chest and shoulders wider than both is the entire
difference between a person and a wardrobe. The head gets a nose, a mouth, and
hair that *wraps the skull* rather than sitting on it as a lid — a flat slab on
top of a cube leaves a cube, and that was the last thing still reading as
Minecraft after the shoulders landed.

The price is one per-instance BufferGeometry, so `dispose()` is no longer
optional bookkeeping — it is what stops a 24/7 room leaking VRAM as walkers
come and go.

## Joints, and where a stoop actually bends

The old figure had a one-piece arm and a one-piece leg, so the walk was two
pendulums. There is now an **elbow and a knee**, and the knee is most of the
improvement: a leg that folds under the body on the back-swing is the strongest
single cue that something is walking rather than being slid along the pavement.
Flexion peaks a quarter-cycle after the thigh reaches its rearmost point and is
clamped positive, because a knee bends one way only.

A `torso` group at hip height carries the upper body and the arms. `stoop` used
to be applied to `body`, whose origin is the **feet** — so an old man's bend
rotated the whole figure about his ankles and he leaned forward like a plank
with his legs in line with his spine. Bending at the hip with the legs left
vertical is what a stoop is. His stoop is 0.17 rad and not the 0.22 it was first
drawn at: the head rides in the same merged mesh as the chest, so it tips with
the back, and past about a fifth of a radian he is looking at the pavement and
the face stops being visible from street level.

## The voice follows the body

`voiceOf()` used to flip its own gender coin. That was fine while every citizen
was the same box and became wrong the moment there were five: a stooped
ninety-year-old would open his mouth and a young woman came out. Archetype
first, voice second, both off the same seed through the same salt:

    m30 → m1   m60 → m2   m90 → m2 (pitched a further −6 %)
    f30 → f2   f60 → f1

The mapping uses the cast that already existed, so **all 904 clips stayed valid
and nothing was re-rendered**. `pedestrians.js` also stamps `headTop` on each
body, and `chatter.js` hangs the speech bubble off *that* rather than a constant
— the five archetypes span 15 cm, which is exactly the amount that makes a fixed
1.75 m assumption look like a bug.

The hero and every peer stay on the default adult, deliberately: they come
through the uid path, their name tags and seat anchors were measured against a
1.75 m figure, and turning somebody else's avatar into a pensioner is not
`makeCitizen`'s decision to make.

## Also tuned

Drivers got their own 4.5 s floor (`DRIVER_CD`) on top of the general reaction
gap. Stand in the road, traffic.js piles up a queue, every car in it passes the
`heldT` test — and at the shared 0.85 s floor four of them shouted inside four
seconds. Screenshotted, that is a mob with two bubbles overlapping illegibly.
The queue is the joke; the volume is not.

# v13 contract: the road under the wheels

The complaint, verbatim: *"Když jedu v Tesle, která je elektro, tak to jenom
hučí jako vysavač, ale neslyším žádnou jízdu, jako zvuk jako kol, že se točí."*
And: *"Trošku víc realističtější ten smyk, ať se to fakt víc smýká, ať je to
fakt jako v nějakém GTAčku."* Four things came out of it — new recordings, a
banded playback layer, a real tyre model, and rubber left on the road.

## The bands, and why they were measured before they were trusted

`scripts/gen-sounds.mjs` grew twelve entries: three tyre-roll loops on asphalt,
two on gravel, three of airflow, two skid loops, and the two transients
(`skid_chirp`, `skid_bark`) that a loop faded up from zero cannot supply.

`js/audio.js` already carried a hard-won warning about exactly this shape of
asset — the four `eng_*` rpm bands came back with spectral centroids of
169–208 Hz and *no monotonic trend*, so crossfading them would have been
crossfading a sound with itself. The lesson taken from it was not "never band"
but **"write the bands to differ in KIND, then measure"**:

| clip | rms | centroid | <250 Hz | >2 kHz |
|---|---|---|---|---|
| `roll_asph_low`  | 0.077 | 321 Hz  | 79.6 % | 1.9 % |
| `roll_asph_mid`  | 0.193 | 810 Hz  | 47.9 % | 5.7 % |
| `roll_asph_high` | 0.192 | 1432 Hz | 35.1 % | 15.3 % |
| `wind_car_low`   | 0.183 | 792 Hz  | 60.0 % | 8.2 % |
| `wind_car_mid`   | 0.195 | 681 Hz  | 62.7 % | 5.6 % |
| `wind_car_high`  | 0.353 | 367 Hz  | 81.8 % | 3.4 % |

The roll ladder climbs (countable tread patter → fused hiss → hard sizzling
roar) and the wind ladder deliberately *descends* in brightness while climbing
in level, because that is what air does: a thin rush at town speed becomes a
deep pounding wall at two hundred. `roll_asph_high` had to be written twice —
the first version asked for "a bright roar sizzling on top with a heavy rumble
beneath", got only the rumble, and measured 521 Hz, i.e. duller than the band
below it. **Accelerating would have sounded like slowing down.** Offering the
generator two characters and letting it choose is the mistake; naming the one
you want and forbidding the other is the fix.

`car_wind` survives and is demoted. Measured, it is almost pure low buffeting
(centroid 123 Hz, 96 % under 250) — a superb bed and a poor portrait of speed —
so it keeps gusting underneath at two thirds of its old level while the three
bands carry what changes.

## bandLayer — one crossfader, three users

`audio.js` gained a small shared machine rather than three copies: `[name,
vRef]` ascending, weight is a tent over the ladder (only ever two bands audible)
taken to **sqrt for equal power**, and each audible band's `playbackRate` tracks
`v / vRef` inside a clamp. A linear crossfade between two uncorrelated noise
sources dips 3 dB in the middle, and that hole lands at exactly the speed you
spend most of your time at. A missing clip falls back to `noiseBuffer()`, the
bargain `rwindBuild` already struck: a bare checkout must still make a noise
when it moves. Cost: ~16 MB of resident decoded PCM once the player first
drives, on top of what `chatter.js` already holds.

## The tyre model (js/vehicles.js `tyreStep`)

The old model was a kinematic bicycle: heading changed instantly with the wheel
and a scalar `_lat` was spawned from the heading change and exponentially
damped. It has no memory, so the car could not be pointed one way and travelling
another for any length of time, and countersteer did nothing recognisable
because there was no rotation to catch.

The replacement is the standard bicycle with real lateral forces and **yaw rate
as an actual state**: slip angle per axle, a simplified Pacejka curve
(`sin(C·atan(B·α))`, peak near 8°, falling to ~0.6 of peak — the falling tail is
the whole reason a drift can be *held*), yaw acceleration from the two moments,
longitudinal load transfer, and a friction circle split by pedal (drive 75 % to
the rear, brakes 65 % to the front). Everything is in **specific** force so
`KIND.mass` keeps meaning what its comment says: a ratio for collisions only.

Three details that are not decoration:

* **It runs at `SUB_DT = 1/120` regardless of the frame.** `stepGame` hands
  `driveStep` up to twenty steps of 1/20 s after a hidden tab, and a stiff tyre
  model integrated at 20 Hz oscillates and then spins the car.
* **Below `KIN_V` the kinematic constraint is blended back.** Real tyres do not
  slip at parking pace; they roll, and geometry alone sets the yaw rate. The
  force model's forces vanish with speed, so without this a car parks like a
  boat.
* **`car.speed` still means exactly what it meant** — signed m/s along the nose
  — because nine consumers outside `vehicles.js` depend on it.

### Balancing it: "jako na ledě"

The first cut was play-tested and rejected — *"je to az moc, jak kdyby na lede,
ze kdyz jedu a zatocim, tak se to uplne smekne"*. Three separate things were
wrong, and only one of them was the tyres:

1. **The car was neutral.** Real road cars are deliberately set up to
   understeer, so a driver who arrives too fast runs wide — which he can see and
   lift for — rather than spinning, which he cannot. `REAR_BIAS = 1.12`.
2. **Grip collapsed past the peak.** `PAC_C = 1.55` let force fall to 0.6 of
   peak, so any corner taken with commitment kept going. At 1.35 it falls only
   to ~0.85: a slide is still available, and the tyre can climb back out of one.
3. **The wheel could be slammed to full lock in 0.15 s at any speed** — which is
   the *only* input a keyboard can give. Measured, a stab at 108 km/h spiked the
   front slip angle past every skid threshold, so merely turning at speed
   sounded and looked like a drift. Winding ON now slows with speed
   (`STEER_ON / (1 + 0.055·v)`); coming BACK does not, because countersteer has
   to stay instant or the slide that *is* deliberate becomes uncatchable.

And one measurement bug that made the whole thing feel worse than it was:
`slipF/slipR` reported the **absolute** contact-patch velocity, so a front tyre
working perfectly well at 30 m/s still read three metres a second of scrub and
tripped the squeal and the marks. The signal now measures slip angle **in excess
of `A_PEAK`**, the tyre's own peak — the line between cornering and sliding — so
it reads a flat zero through any corner the car is actually gripping in. Loose
ground scales that peak down (`A_PEAK_OFF`), because a meadow shears long before
the rubber does, which is why a field can be ploughed into ruts at speeds that
would not mark tarmac.

### …and then it was too stiff

The next play-test: *"to zatacení je porád takové tuhé, ze se neda moc zatacet.
Pri vetsi rychlosti to pomalu zatáci porád jako vsude."* Fair, and mostly
self-inflicted — the fix for "on ice" had reached for stability three times over.

The number that actually decided it was never in the tyre model at all:
`CAR.steerSpeedK`, the steering-lock falloff, allowed only **6.1° of lock at
108 km/h**, which is an 81 m radius — a motorway sweep, not a turn. Opening it to
0.026 asks for 64 m; `KZ2` came back down from 1.45 to 1.15 (yaw inertia is felt
as *lag* long before it is felt as stability); and `STEER_SLOW` from 0.055 to
0.022. Extra lock is only a licence to slide if the tyres cannot hold what it
asks for, so `MU_REF` moved with it — 1.55 for an Octavia, past a real road tyre
and deliberately so. **Those two are a pair; move one and re-measure the other.**

| full lock at | 50 km/h | 72 | 90 | 108 |
|---|---|---|---|---|
| radius, before the balance pass | 28 m | 44 | 61 | 81 |
| radius, now | **15 m** | **26** | **38** | **53** |
| body slip | 2.2° | 2.9° | 5.0° | 6.7° |
| `slip01` | 0.00 | 0.01 | 0.07 | 0.13 |

Turn-in lag fell from 0.33 s to ~0.25 s, and `slip01` still sits at or under the
skid gate through all of it: the car turns hard without squealing or marking,
and only genuinely provoking it breaks traction.

Measured, after everything: 0–100 km/h in 5.67 s (the spec in the KIND comment
says ~5.7, and it never moved through any of this); a handbrake flick at 22 m/s
reaches 137°/s of yaw and 90° of body slip; countersteer takes a 68° slide back
to 8.8°; a panic stop and a hard corner on grass both still register; parking at
1.5 m/s still turns inside 4.4 m with `slip01` at zero; and dt = 1/20 with full
lock and handbrake stays finite and bounded.

### The trap the slide sprang

A sliding car reports `|car.speed| ≈ 0` while travelling 25 m/s sideways. The
old model made real slides rare enough to hide what that breaks; this one does
not. `car.vGround` is published alongside and now feeds the **speedometer**, the
**wall-impact damage**, the **pedestrian run-over test**, the **tyre and wind
audio** and the **speed streaks** — a car arriving at a wall out of a drift used
to hit it for free. The engine is the one correct exception: revs follow the
wheels, which roll forwards.

`car.offroad` was also being NaN'd by `undefined += …` on any hand-built car.
Every reader compared it (`> 0.05`, always false) and comparisons swallow NaN
silently; the tyre model *multiplies* by it, so the same latent bug went from
invisible to fatal on the first frame.

## js/skidmarks.js

One mesh, one preallocated indexed geometry, a ring of 2400 quads = four
independent wheel tracks of 600 segments each. It follows the **navline.js**
ribbon idiom (cut once at maximum size, drawn through `setDrawRange`, faded
through a per-vertex RGBA attribute) and not the pedestrians.js blood idiom,
because a pool sharing one material fades every decal at once — blood hit that
wall and had to sink corpses instead of fading them.

Four tracks rather than two: in a slide the front wheels point somewhere quite
different from the rears, and four crossing arcs is most of what makes a mark
read as a mark. Colour and lift come off the surface — near-black rubber at
+3.5 cm on tarmac, turned-over earth at +7.5 cm on soft ground, where grass.js
plants blades at +5 cm and would otherwise swallow the gouge. Height comes from
`world.surfaceY(x, z, car.y).y`, never `terrain.heightAt`: the `near` argument is
what keeps a mark under a flyover from snapping up onto the deck.

Emission is gated on **distance travelled**, never on frames, for the same
twenty-substeps reason as above, and the threshold is `SLIP_MARK`, exported from
`vehicles.js` so the marks and `SKID.on` in `audio.js` cannot disagree about
when a skid started. 3 m/s of scrub, not less: a brisk main-road bend runs 2.4,
and rubber through every fast corner is wallpaper rather than a skid mark.

The pool cap **is** the memory bound. `city.js` unloads only the chunks in its
own `built` map, so these outlive the street they were painted on — which is
what we want, and also why an unbounded emitter would leak forever.

# v14 contract: weight, walls and the windscreen

The ask: *"Udělej to ovládání auta trošku lepší, jako v GTA San Andreas, s
fyzikou. A když se rychle vybourám, chci vyletět předním sklem, jako v GTA 4."*
The v13 balance (planted, slides only when provoked) is kept on purpose: full
lock at 50 to 130 km/h with W held still reads slip01 0.00 in a front-drive car.

* **Body on springs** (`bodyStep`). Roll and pitch are damped springs driven by
  the tyre forces (`car._aLat`, `car._aLong`), about 4° of roll at 1 g and 3° of
  dive in a panic stop, one overshoot. Heave is driven by the wheels' vertical
  ACCELERATION, so a 12 cm kerb kicks the shell and a long hill bends nothing.
  Mesh only: car.y, `_gp`/`_gr` and the tyre model never see it.
* **Rear-drive torque** (`driveRear`, `SPIN_LOW`, `SPIN_CAP`). The BMW and the
  Mercedes can ask the rear tyres for more than the circle holds in low gears,
  capped at 0.86 of the circle. That cap is bistable territory: 0.92 spun a BMW
  190° on an ordinary 25 km/h junction turn with W held, 0.84 did nothing.
  At 0.86 full lock plus full throttle steps the tail out 20 to 27°, a normal
  junction turn just tightens.
* **Collisions are impulses.** The wall pass used to scale the velocity on every
  touching step, so W held against a wall re-crashed every frame (a 40 km/h tap
  cost 0.85 of a write-off) and a glance stopped dead. Now: every corner probed
  from one pose, summed push = normal, deepest push = depth, and an impulse at
  the contact with restitution 0.34 falling to 0.1 at 70 km/h, wall friction
  0.32, and the yaw inertia of the tyre model, so a one-corner hit spins the car
  and a square one does not. Car-car is the same with both masses. The step is
  cut into passes of at most 0.4 m (`COL_STEP`): a 30 cm wall at 130 km/h on a
  1/20 s frame used to be tunnelled.
* **The impact record**: `car.impactV` (closing speed of the hardest contact of
  this call), `impactCos` (1 = nose square on), `impactVx/Vz` (ground velocity
  BEFORE the impulse) and `impactWith` ('wall' | 'car'). Reset every call.
* **The kinematic blend uses ground speed.** By vx alone a broadside at 100 km/h
  was "parking pace" and stopped dead in 1.5 m.

Ejection lives in `js/ejection.js` (pure, no imports): `shouldEject` needs
impactV ≥ 16.5 m/s, impactCos ≥ 0.8 and a moving car. `Player.eject` hands the
body to `stepBody`: the crowd's ragdoll (gravity, tumble, one bounce at 0.3,
slide, settle flat) plus walls and the bonnet of the car it left, then lie
1.6 s and get up. HP go through `vitals.damage` from two curves (glass, and each
ground or wall arrival). The abandoned car's hull is excluded from the body's
collisions (main.js carHulls), or the body is "hit" by the seat it left.

# v15 contract: Prague

The ask: *"lets go na kolo 7"* on the plan for Prague: trams on the real lines,
hand-built landmarks, the Vltava with its quays, tenement blocks, memory for
the density, and a start in Prague. Six packages were built in parallel copies
and merged; these are the rules they agreed on.

* **Landmark regions** (`js/landmarks.js`). Every Prague entry carries
  `region: 'praha'` (none means Pardubice) and the prefilter is one box per
  region, also for `landmarkClear` and the walks. Optional fields: `lifted`
  (a gate over its passage, matched although the tile lifts it), `kind` (must
  equal `f.t`), `hide` (takes generic footprints out, builds nothing, solids
  `[]`), `reach` (how far model and solids may stand beyond the footprint box,
  checked by the tests). Footprint-less pieces (Charles Bridge, the Hus
  monument) are `EXTRAS`: each piece is built only by the chunk holding its
  anchor point, so a piece exists once whatever order tiles arrive in. The old
  town lives in `js/landmarks-praha.js` and its builders, the castle and the
  wide set in `js/landmarks-hrad.js`. K surface kinds stayed untouched (11 was
  reserved for the old town, 12 for the wide set; neither was needed).
* **Far skyline** (`js/landmarksfar.js`, main thread). Low-poly silhouettes of
  the castle, St Vitus, Žižkov, Petřín, the museum dome, Vyšehrad, Týn and the
  Old Town Hall tower, drawn beyond the streamed ring up to about 4 km and
  cross-faded with the near models. Only the silhouettes bend the haze (after
  220 m it counts 6 %), streamed chunks and Pardubice keep their fog.
* **One water level** (`js/riverpools.js`, worker safe). The Prague Vltava is
  four flat pools held by weir lines with a 7 m ramp: A 187.1, B 185.4,
  C 184.5, D 180.3. Every consumer asks `riverLevelAt` / `poolLevelAt`: water
  mesh, quay walls, náplavky stamps, bridge supports, the riverbed. Anything
  that builds over the river (Charles Bridge piers go to y 182) must not depend
  on a level of its own. The Labe is unchanged.
* **Corridor levels** (`js/corridorgeom.js`, `js/corridorfit.js`,
  `js/corridorlevel.js`, worker safe, round 10). Heavy rail and the motorway,
  trunk and primary classes (links and bridges included) are not levelled way
  by way: a corridor (straight-through chain, the two carriageways of a dual
  road, a bundle of parallel tracks; a pure function of tags, plan and ids)
  gets one profile along its chainage, from the PRISTINE survey across its
  whole width, low-passed within class cut and fill bounds, grade-limited
  symmetrically, with deck headroom as floors. Every member's `_prof` is
  resampled from it, so `roadGradeY` / `railGradeY` / `bridgeDeckHeight`
  readers need no change. Each way reads the corridor of its owner (the
  longest parallel neighbour, transitively), so a bundle agrees exactly. Where
  two corridors meet, the higher (rail, motorway, trunk, primary, links) is
  hard (`geo.junctionY`); minor roads, overlaps and level crossings
  (`js/levelxing.js`) adapt to it. A line is final only once its window's data
  and height tiles have all answered.
* **Levels: bridges and underpasses** (`js/levelsep.js`, `js/roadpose.js`,
  `js/drawnground.js`, all pure and worker safe, 18 Nov 2026). Three rules.
  (1) Two things on different LEVELS do not meet. Every contact, blocking,
  following and giving-way test used to be a plan test in x and z; each now
  also asks `sameLevel(ya, yb, dist)` (heights where the two STAND differ by at
  most 2.4 m, plus 8 % of the plan distance) or `inBand` for a tall body (a
  tram's stand-in, a lamp mast). That is `vehicles.carCarPass` and `polePass`,
  the hull block of `city.collide` (the asker's level is `opts.y ?? opts.yLo ??
  opts.aboveY`), `poles.collide/strike(…, y)`, in traffic.js the follow and
  crossing loop, the give-way box, the walkers and `threatens(…, y)`, and the
  obstacle list `_obst`, which is now FOUR numbers per hull (x, z, half, y;
  NaN: not told, separates nothing). Everybody who feeds it sends a `y`:
  `main.js pushActor` and `updateBlockers`, `police.blockers`, the cyclists'
  `block` and `note`, the trams' hull points, the walkers' crossing records.
  A new producer or consumer must carry the height too. An unknown height
  never separates, so an old caller behaves as before.
  (2) An AI car lies along its ROAD. Its height always came off the road
  (levelled grade or deck at its arclength), its attitude came off the terrain
  under its corners, which under a deck is the valley and in a cutting the
  grid's arch. traffic.js now writes `p.sg` (`roadpose.deckSlope`, signed
  along travel) and `vehicles.update` pitches by it, no roll; a car with
  another kind of driver asks `world.surfaceY` at its own level. A few times a
  second a car also asks the surface drawn at its wheels and is lifted onto a
  sheet lying over its road (`surfaceLift`: a slip road inside its
  carriageway, a junction pad), never by a whole step.
  (3) A prop stands on the ground that is DRAWN. The grid cannot hold a 9 m
  cutting between 20 m samples; the ground mesh is clamped under every
  corridor and the feet stand on that, but fences, lamp columns, signs,
  benches and trees asked the grid (2.8 m over the pavement in the Jana
  Palacha underpass). `drawnGround(terrain, corr)` answers `heightAt` by the
  mesher's own per-vertex rule (`batter.groundUnder`); buildChunkMeshesGen
  makes one per chunk from the corridor list it already had and hands it to
  `standingOn`, `barrierInto`, the sink's drape and the trees. It is not a
  Terrain: grades are still asked with the real one (the levelling caches
  compare it by identity). No street lamp is planted under a deck lower than
  its column (`roadpose.deckOver`, in `lampSpots`, so the far lights agree).
  And a rail joint on a bridge (a set of points: three decks sharing a node)
  holds the level of the structure's approaches like a road's joint does
  (`underpass.deckNodes(…, rail)`): left to the ground under it, the bridge
  over Jana Palacha dived 8.8 m into the street. Pinned by
  tests/levels.test.mjs.
* **Light lies on the road that is drawn** (`js/poolspot.js`, numbers only,
  20 Nov 2026). Where a lamp's pool and a car's headlight fan LIE is worked
  out there; `js/lightpools.js` only draws them (quads, the fans' strip, the
  two light maps of `js/lampmap.js`). Two rules. (1) A pool lies `LIFT` over
  what is DRAWN at its centre, asked at the level of the mast's foot:
  `world.heightAt` (carriageway, pavement, a path's slab, the ground under
  every corridor's ceiling), or surfaceY's own sheet where that is a thin
  layer or a deck's asphalt within half a metre of it. It used to take the
  higher of the road and the height GRID plus a layer ladder, and in a cutting
  the grid arches over the carriageway: on the ramp down to the Jana Palacha
  underpass the pools hung 1.1 to 1.3 m in the air (2.75 m at the worst on
  that tile). (2) A fan FOLLOWS its road. It was one plane at the pitch read
  13 m ahead, which over the top of a ramp left its far end a metre and more
  in the air and in a dip put its middle in the tarmac. `beamLie` now looks
  three times along the nose (13 m, half way on, the far end), the two
  further looks asked where the ones before say the surface will be. A look
  takes the carriageway, and where the nose has left it (a bend, a junction)
  what is DRAWN there (`world.heightAt`: pavement, path, ground), so the fan
  lies on the verge of a bend and follows a hillside falling away where a road
  ends; it is refused when what it finds is out of reach of the line (a deck
  overhead that surfaceY offers for want of anything lower, a street under the
  end of a deck, a terrace more than a metre up). A rise steeper than one in
  five counts as road only on a carriageway whose point half way lies on the
  same line (a street of up to 40 %, not a step). The chord goes into the
  instance matrix as before and the two inner nodes' heights over it into the
  instanced attribute `aBend`, which both vertex shaders add through ONE
  shared `BEND_GLSL` (`beamBend`). The fans' geometry is a 12-span strip of
  its own for that; a pool is still a quad. A look that fails leaves the plane
  it was. Pinned by tests/poolspot.test.mjs.
* **A prop stands on the paving that is drawn** (`js/footslab.js`, 20 Nov
  2026). The level of a footway's slab (its own profile blended toward the
  street it runs beside: `footPullW`, `streetPull`, `slabLevel`) is ONE pure
  function now, read by the feet (`city._footPull`) and by the props
  (`meshes.standingOn`). standingOn had a copy that knew only kerbed streets,
  asked the pull under the prop instead of at the path's centreline and
  picked the strongest pull before the cap: a lamp on the riverside path
  under Povltavská stood 1.8 m under its paving, one at the foot of Bubenské
  nábřeží 2.2 m over the ground. A path counts for a prop ON its slab (12 cm
  past the edge, as for feet) or beside a slab lying on the ground (within
  0.5 m of the drawn ground): a path carried on a wall does not lift the
  column 30 cm off its edge. Like the feet, a prop is not offered a street's
  pavement out over a stamped Prague quay. And no lamp is planted within
  `TRAM_CLEAR` (1.5 m) of a tram track's centreline (`lampSpots` `inTram`):
  kerb offsets and surveyed nodes fell on the rails in the middle of
  Seifertova and Sokolovská. Pinned by tests/prop-beside-path.test.mjs.
  The corner band of a junction is asked of the NINE pad buckets round the
  chunk (`padsAround`): a pad is bucketed by its centre and drawn whole by
  that chunk, so a crossing a few metres over the border has its corner in
  this one, and a lamp on it stood on the ground under the band. The same
  nine `lampGround` reads and `chunkspec.padKeys` ships, so the worker
  agrees (tests/fix-street.test.mjs builds it on both threads).
  And the band's height is ONE function, `streets.cornerLevel`, read by the
  feet (`city._padLevels`) and the props: the deck at the two ends of the
  stretch of KERB LINE, carried out across the band as
  `meshes.ringKerbInto` draws it. Both used to ask the pad's deck under
  themselves, out on the band, where its terrain guard reads the ground
  beside the street: by a crossing under a hillside that was up to 3 m over
  the paving drawn (tests/corner-band.test.mjs, against the built mesh).
* **Trams** (`js/trams.js`, `js/tramlines.js`). A tram's position is a pure
  function of route id, trip number and the shared clock: no state that two
  co-op clients could disagree on, no Math.random. A tram yields to a car on its
  rail only on this screen; the shared timetable is never changed.
  `traffic.railCross` makes cars wait short of a crossing a tram is due at.
  Round 7 polish: two trams never stand in each other (js/tramspacing.js: a
  tram claims its body plus its braking distance; where two claims cross, the
  one already in the junction, else the one due first by the timetable, goes);
  a held tram keeps a local `delay` and makes it up at 1.25 x its own clock,
  never jumping to the timetable. Beyond 240 m a tram is a 42-triangle loft,
  out to 1.5 km, with far glows at night (js/tramglow.js). Platforms are crowd
  STOP sites keyed by stop node and heading (js/tramwait.js), put down within
  800 m of the player once every line near is built, and the crowd's
  busEta/busAt/busNear answer for trams too. `tramMasts` (js/settings.js, off
  on low) is a chunk-recipe flag carried in the chunk spec.
* **Party walls** (`js/partywalls.js`). `stampPartyWalls` writes `f._pw` per
  tile when it is indexed (same tile only, plain data, carried to the worker);
  `edgeRoles` reports them as `PARTY_ROLE` and a party edge is always drawn as
  one blank firewall quad (skipping it opened holes on slopes).
* **Start places and the release stage.** `config.js START_PLACES` (Pardubice,
  Praha) decides where a game boots and which tiles it asks for first; each
  place has its own parked fleet with claim keys `place * FLEET_STRIDE + i`, so
  old Pardubice saves keep keys 0 and up. Death respawns at the nearest of
  `HOSPITALS`. With `geo.js RELEASE_GRAPHS` on, a deep-evicted tile is released
  from the traffic, walker, cycle and route-planner graphs, one graph per frame,
  and its ways come back when it returns; tests/tile-release.test.mjs pins that
  release then return builds the same graphs as a fresh load. With
  `RELEASE_DATA` (round 7 polish) the ways go too: roads, rails, signals, car
  parks, their JUNCTIONS/CLUSTERS records and every stitch link a neighbour's
  way holds to them (`underpassrelease.js releaseStructures`); only the pois stay
  listed (`t.poisIn`). A returning tile is indexed as on a first visit (same
  slot ids, new objects), and tests/tile-data-release.test.mjs pins that the
  pair it forms with a resident neighbour equals a fresh load in the same
  order, in both orders. Slim and deep eviction and every graph's release run
  as ONE job of small steps (`queueJob`, about 6 ms a frame, a listener may
  return a generator); tile indexing waits its turn behind it (`workTurn`).
  Burned kerb stalls are remembered by way id (kerbparking.js), trains drop
  the routes over released rails. A pin beyond the streamed roads gets the
  rest of its route over `js/coarseroute.js`, a graph of the overview's major
  roads (Navigation `opts.overview`, `coarseFrom`).

---

# v16 contract: the D11

The ask: round 8, the D11 between Prague and Hradec Králové as a Czech driver
knows it (barriers, signs with exit numbers, traffic at 130, services), with
no tile rebuild. The tiles carry the motorway as anonymous ribbons: no ref, no
names, no destinations, no junctions. Wave 0 landed three shared contracts
that the five round 8 packages build on. Read them, never re-derive them.

* **D11 facts** (`js/d11.js`, its baked lines in `js/d11lines.js` and its
  tables in `js/d11data.js`; pure, no three, no DOM, worker safe, node
  importable). Four carriageway centrelines
  in their direction of travel: `E` and `W` (the D11, Černý Most to past exit
  108 and back) and `S` and `N` (the D35 from the Sedlice split past Časy to
  the tunnel Homole). They ARE the tile motorway ways chained end to end
  (every tile vertex, 0.0 m off), the two ecoduct holes following the
  roadpatches.js patches. Official km: a piecewise linear calibration of the
  chainage through anchors (km 0 at the cs.wikipedia start, exit N at km N
  at its measured interchange centre: the exit number is the km rounded to
  the NEAREST, as the MD ČR notice for D0 interchange 60 at km 59.90 to 60.25
  and the real km of the rest areas show; round 8 SIGNS moved the wave 0
  N + 0.5 anchors down and re-baked every km in d11data.js; the raw chainage
  was 0.29 to 1.23 km off),
  W and N by projection onto
  E and S. `UP[cw]` is +1 on E and S (km grows), -1 on W and N. API:
  `d11At(km, cw, out?)` -> {x, z, dx, dz} (dx, dz the unit direction of
  travel; heading h = atan2(-dx, -dz)); `d11Locate(x, z, out?)` -> {road, cw,
  km, off, dx, dz} or null beyond `LOCATE_R` (25 m), `off` + to the right of
  travel, O(1) through a lazily built 64 m bucket grid (the first call on a
  thread decodes the lines and builds it, about 20 ms: call `d11Line('E')`
  during boot); `exitAhead(km, cw)`, `restAhead(km, cw)`, `exitNear(x, z, r)`,
  `onBridge(km, cw, pad)`, `kmRange(cw)`, `d11Line(cw)` (read-only typed
  arrays). Tables, deep frozen: `EXITS` (number, ŘSD name, kind, centre km,
  crossing shields, per carriageway the slip's diverge and merge {x, z, km}
  as exact tile vertices, the gantry destinations `to` and shields `refs`
  from the OSM destination tags, `thru`; texts without a tag are marked
  FALLBACK in d11data.js for the owner to review), `REST` (Beranka, Bříství,
  Vrbová Lhota, Dobšice off exit 50, Osice, Dolní Roveň on the D35: slips,
  fuel brand and tile poi, food, trucks), `ECODUCTS` (Žehuň km 52.0, Voleč km
  71.7: hole ends, deck length), bridge decks per carriageway (via
  `onBridge`), `D35_SHARED` (the km where the D11 also carries the D35) and
  `D11_WORLD_END_KM` (101.66: the tile ways run on to km 110.6 over no terrain,
  plan nothing past it). Everything is a function of the constants: co-op
  safe, the same on every thread and in any tile order. A fix to a fact goes
  in d11data.js (the tables are plain literals; the lines in d11lines.js are
  tile vertices, change them only with the tiles), and
  tests/d11.test.mjs checks the lines against the tiles, the km monotonic,
  every diverge in [N - 0.7, N + 0.5] and the round trip.

* **Lanes** (`js/lanes.js`, pure, worker safe). The single source of
  motorway lane geometry: the paint (meshes.js) and the AI (traffic.js) both
  read it, and neither hard-codes its own numbers. `laneLayout(road)` is null
  for every class but motorway and motorway_link, else one shared read-only
  record in metres from the OSM centreline, + to the right of travel: lane
  count, lane centres and widths, dividers, edge lines, the hard shoulder and
  the drawn half width. It maps the Czech D 27.5 cross section onto the
  measured carriageway spacing (median 12.4 m, the other carriageway always on
  the left; 17 to 20 m only at the Prague end and past km 100): two 3.75 m
  lanes with the lane line on the OSM line, the inner edge line 2.35 m from a
  median barrier at about -6.22 m (`MEDIAN_HALF`, a median value: a barrier
  must follow the measured distance to the other carriageway), the right
  edge line at 3.875 and a 2.5 m shoulder (`SHOULDER_W`) to the drawn edge at
  6.25. Narrow ways narrow their lanes to fit. A 3-lane piece keeps its two
  through lanes in place and puts the third in the shoulder band (2.25 m
  wide, about 1 m narrower than a real one: the drawn road is no wider).
  `auxRight(road, endsAt)` walks a run of 3-lane ways through `endsIndex`
  and classifies its rightmost lane as acceleration (`ACC_LEN` 283 m
  median), deceleration (`DEC_LEN` 208), weaving, or the fallback 'aux'
  (the slip road's tile not loaded yet: co-op code must not decide from it
  alone); `auxShare(aux, s)` gives the taper (`TAPER` 60 m, not confirmed
  by a standard). Everything is a pure function of the roads given.

* **Road patches** (`js/roadpatches.js`, appended in `geo.js indexPayload`).
  Ways the build dropped (it drops every tunnel) put back as tile road
  records: Celetná through the Powder Tower and the four D11 carriageway
  pieces under the two ecoducts. A patch lives in the tile of its first
  vertex, takes its `_id` from the top of that tile's id block, and its ends
  equal the neighbouring tile ways' ends to the decimetre (every graph welds
  ways at rounded end points). The d11.js lines follow these patches vertex
  for vertex, and tests/d11.test.mjs fails if they part. The elevation
  model keeps the green bridges' earth 9 to 11 m over the road, so
  `ecoductCuts()` describes one flat 'dig' stamp per carriageway, its floor a
  straight line between the ground 40 m outside each end of the hole, and
  js/terrainstamps.js lists them as two regions (Žehuň, Voleč); the road over
  each patch then rises at most 0.15 m off that line. The green decks
  themselves are drawn by the MOTORWAY-LOOK package.

* **The motorway look** (round 8 MOTORWAY-LOOK). Five worker-safe modules,
  none of them reading tile arrival order:
  `js/mwpaint.js` paints a oneway motorway or slip road (meshes.js roadRibbon
  hands it the ribbon frame) off `laneLayout`: V 4 edge lines 0.25 m at
  edgeL / edgeR, 6/12 m lane lines, the 3/1.5 m auxiliary line on a 3-lane
  piece by a slip road (`auxRight`) and wherever a slip road's asphalt covers
  the right edge line; a slip road paints nothing on motorway asphalt, and
  junction pads whose arms are all motorway or slip road cut nothing.
  `js/mwplan.js barrierPlan(cell, key, terrain, grow)` is the ONE barrier
  plan: per cell, walking every D11 / D35 way (`cwOf`: on a d11.js line) from
  its first vertex in 4 m stations, a concrete median half at the midpoint to
  the partner carriageway READ OFF THE d11.js LINES (9 to 15.5 m apart),
  else a steel rail on the left; a steel W-beam 0.6 m past the right edge,
  broken where another road's asphalt is; on a bridge both stand on the deck
  kerb. Plain numbers (STRIDE 7). `js/mwdress.js` draws it ('full' chunks),
  with the median surface and the delineators; `js/mwsolid.js` (city.collide)
  pushes probes out of the same plan, memoised per cell, only for a caller
  that gives its level (`opts.y`, which vehicles.js wallPass now passes, or a
  walker's `opts.yLo`), thick behind the face so 130 km/h does not tunnel.
  `js/mwtall.js` draws the two green bridges (the chunk holding each anchor)
  and the procedural noise walls (`NOISE_RUNS`, official km), in the shell
  tier too. The town lamp rule plants nothing along a D11 / D35 way, nor
  along a slip road reaching `motorwayLit` (250 m round an exit's or rest
  area's slip nodes): those are lit by `js/mastlamps.js` (round 9), 12 m
  masts walked from each way's first vertex every 40 m,
  kind `mast` (two arms, the motorway's outer side, 2.75 m past the asphalt,
  only where the rail before it stands, never in a sign's keep-out box) and
  `mast1` (one arm, along the full lit slip, with 5 m clear of unguarded
  asphalt). Mainline masts stay inside `motorwayLit`. Bridge sockets use the
  deck height and ground sockets the terrain. meshes.js `lampSpots` returns them as
  `plan.mast` / `plan.mast1`, `lampBatch` names them `mastPosts` /
  `mast1Posts` (city.js `LAMP_BATCHES`), lightpools.js throws a pool under
  each head and farlights.js a point at each, in one colour per interchange
  (`mastTint`). The delineator glows (`js/mwretro.js`) use the lamp glow
  shader with `uFloorPx` 5 and `uGive` 0 (every lamp glow: 1.1 and 1),
  and replan a cell when its road count changes.
  D11 bridge decks get concrete edge kerbs instead of the
  dark parapet, and their piers stand at shared official km
  (`mwPierStations`), side by side under both decks.
* **Horizon** (round 8, HORIZON). A tile arrival is indexed in slices in
  play (`geo.js indexPayloadSteps`, `city.indexSliceMs` 4 ms, set by main.js;
  at boot and in tests it drains at once): the tile is filed into a private
  stage and lands in a few steps after it (the index merge, the junction pads
  and their shapes, `underpass.js stitchStructuresSteps`, the bays), and every
  onTileLoaded listener gets a frame of its own (one may return a generator).
  tests/tile-slices.test.mjs pins that the result equals the single pass.
  A listener's payload gained `ids` ([lo, hi] of the tile's id block):
  CityWorld re-bakes a neighbour's earthworks only when the tile's ways reach
  it, and re-meshes only the cells whose ground the bake moved. The view: an
  eased OPENNESS per viewer (`js/openness.js`, sight lines in the chunk
  index; over the Prague Vltava the water counts) widens the ground window
  by a buildings band (`streamplan.js planCarRings`, also above 90 km/h), and
  outside Prague moves the fog out (`sky.fogOpen`, `sky.js OPEN_*`: wall to
  5.5 km, haze scaled to 6 km by day) over `js/farterrain.js` (one coarse
  orthophoto patch per terrain tile, min-pooled under the streamed ground)
  with `js/farlightsland.js` town lights at night; the window's edge then
  dissolves (`heightfog.js setFarEdge`, the same dither and discard as the
  Prague hand-over; `ATC_NO_EDGE` opts a material out). Openness 0 is the old
  fog to the digit. `sky.edgeFar` is the streamed edge's own wall: the crowd,
  the traffic and the Prague skyline read it, never scene.fog.far.
* **Services** (`js/d11services.js`, applied in `geo.js indexPayload` by
  `servicesInto(data)` before anything is filed). Pure, per payload: the
  Osice W Benzina, which OSM maps only as a building, gets a fuel poi under
  its canopy (`SYNTH_FUEL`); and every fuel poi's mapped canopy (a tile
  `t 'roof'` within 12 m, 32 m for a REST station) is LIFTED onto 4.5 m of
  clear height with the skyway field `y` (mesher, collider and walkers read
  it as passable underneath) and framed onto the poi (`cv`, `cr`, `ch`, `cd`).
  `js/forecourt.js forecourtFrame()` is the one rule for where a forecourt
  is: the mesher (`fuelInto` for a built one, `canopyFuelInto` under a mapped
  roof), the pump (`js/pumps.js pumpAt`, main.js F) and the fuel shop's food
  counter (`shopAt`, jobplaces.foodPlaceAt, `PRICE.shop`) all read it.
  `sites()` / `siteNear()` (REST plus the exit 35 bay) tell the parking lots
  a services lorry park (`lotClass`: 'lorry', 'service', 'town').
* **The long run and the train** (`js/haul.js`, `js/express.js`,
  `js/expressroute.js`, `js/railstitch.js`). A 'haul' job runs between two baked depots once per
  GAME day per direction (`gameDay`), timed by `jobmath.haulLimitS` (not the
  town's half-hour cap). "R Pardubice – Praha" leaves Pardubice hl.n. every
  game hour (a pure function of worldT and station names), calls only at
  `EXPRESS_STOPS` (`train.only`), charges `PRICE.train.ticket` on boarding,
  and N skips a rider to the next station (`train.hold`, tiles awaited, the
  clock untouched). `stitchPath` joins the Libeň yard end of line 010 to
  Praha hl.n. (6.2 km, end points welded within 32 m, no reversing
  continuation). trains.js now joins routes that meet end to end
  (`_joinRoutes`) and, given the terrain, puts its track at the rail grade
  (it ran at y 0.18 before, under the real terrain).

# Co-op server: a Cloudflare Durable Object (November 2026)

The co-op relay moved off the deleted VPS onto Cloudflare, the way Death Run
runs: a Worker `among-the-city-coop` (`server-city/worker/`) in front of ONE
Durable Object (SQLite class `CoopRoom`, `idFromName('PARDUBICE')`, European
location hint). The client contract did not change: `server-config.js`
SERVER_URL, `GET /health` (the menu, `js/menuhealth.js`) and the WebSocket at
`/ws` (`js/netcity.js`), same protocol.

* **One logic, two hosts.** `server-city/hub.js` (admission, hello and uid
  takeover, rate limits, lanes, PING/PONG, deadlines), `room.js` and
  `protocol.js` run unchanged under the Node relay (`index.js`, local play,
  `npm test`) and the Durable Object (`worker/src/coop.js`, adapter
  `worker/src/conn.js`). A rule changed in the hub is changed on both.
* **Hibernation.** `ctx.acceptWebSocket` and the `webSocket*` handlers, no
  timers; one alarm only while sockets exist (hello, silence, idle, dead
  sockets, the hourly account check). After a wake the hub is rebuilt from
  the socket attachments (seat, joinedAt, authority, last state) and from
  storage (meta with its stable `created`, the world snapshot, the budget).
* **Cost guard.** The object counts its own duration and requests per
  billing cycle (13th to 13th) on the high side and closes co-op with close
  code 4402 `limit` at `BUDGET_GBS` / `BUDGET_REQUESTS`; an optional secret
  `CF_ANALYTICS_TOKEN` adds an account-wide check against the GraphQL
  Analytics API, which fails closed (4503 `unmeasured` after two failed
  checks). `/health` then says `{ ready: false, reason: 'limit' }`, the
  menu and the HUD say it in Czech (`js/netnotice.js`), and
  nothing reconnects by itself. Socket caps count `ctx.getWebSockets()`,
  because a Workers socket cannot be terminated and a peer that ignores the
  close keeps it open. Details, numbers, what no cap can stop, and the
  deploy commands: `server-city/README.md`.

---

## Facade depth, weather and glass; a cheaper near shell (gfx/facades, Nov 2026)
* **js/facadefx.js** (main thread only) is pixel shading shared by the far
  chunk wall (`facadeatlas.buildFacadeMaterial`), the near shell's atlas boxes
  (`destructible.shellMat`) and the near glass (`destructible.mats`). No draw
  call, no vertex, no attribute: the atlas uv IS the cell address, and a
  64 x 2 float table (`cellTable`, from typology's FAMILIES) says where each
  cell's window is. The metres come from screen derivatives, so worker-built
  chunks need nothing new.
  * window depth: the ray through a painted opening is followed to the glass
    `GLASS_DEPTH[family]` (typologycells.js) metres in, or to a jamb, head or
    sill; the glass is sampled where the ray lands (parallax), the reveal in
    the wall's paint, and the sun is traced back out (head and jamb shadows).
    A lit window does not light its own reveal.
  * ledges: string courses, cornices and sills throw a sun-length shadow.
  * weather: mottle, rain streaks, sill run-off, rising damp, cornice soot,
    all hashed from world position (both tiers and both clients agree); the
    fine terms fade with the pixel footprint.
  * glass: darkened, sky reflection with Fresnel from the hemisphere light's
    own colours (follows the time of day), a skyline of the street opposite.
* The near pane now sits at the same `GLASS_DEPTH` (pieces.js `paneOff`), so
  the window does not jump at the 160 m swap.
* Gate: `facadeFx` in settings.js (off on Low, on Medium/High), applied once a
  frame through `facadeNight -> syncFacadeFx`. Console A/B: `__atcFacade.fx(false)`,
  `__atcFacade.fx(depth, weather, glass)`, `__atcFacade.fx()` back to the preset.
* Near shell savings (destructible.js): the solid pieces (balconies, rails,
  mullions, every interior box) ride in the atlas InstancedMesh as BOUNCE_RECT
  instances (pin texel, the old bounce emissive, no weather) instead of a
  second opaque InstancedMesh per building, in the main AND the shadow pass;
  and every model mesh culls against one sphere over all its pieces (pieces
  never move inside a model, they only leave to the debris pool). Console:
  `__atcFacade.merge(false)`, `__atcFacade.cull(false)` for the draw counts.
* Tests: tests/facadefx.test.mjs.

## The ground at street level (gfx/ground): js/groundglsl.js, streetdetail.js, orthodetail.js
The street detail shares existing draw calls and attributes. Mapped squares add
triangles to the ground mesh. Both mesh builders use the same neighbouring cells. Two ground materials share the GLSL in
`js/groundglsl.js`:
- **precise world xz** (`atcWrapXZ`): the chunk origin wrapped by 4 800 m (a
  whole number of every class's tile) plus the local position. Raw world xz at
  Prague (x ≈ −95 km) has 8 mm float steps, so every texture was a jittered
  mosaic. The slow noises restart on the 4.8 km grid lines (a soft seam there).
- **js/streetdetail.js** `atcStreetDetail`: a per-class multiplier the surface
  shader applies over the 256 px tile, drawn from world position so it has no
  period: asphalt blotches, bitumen age tint, binder stones; every slab, sett
  and paver its own shade from its WORLD unit index (`atcUnit`), walked-on
  dirt and weathering; dry and lush patches on grass; a kerb face 20 % darker.
  Every fine term fades by pixel footprint. Tyre tracks and drip line deepen.
- **js/orthodetail.js** on every ortho supertile Lambert: near the camera the
  photo is calmed (an explicit-LOD 1.6 m blur, dark blots lifted toward the
  4 m surround, only for a camera under ~20–60 m) and the synthesised setts,
  chippings or grass (classified from the photo's own colour) give albedo
  detail and normal relief, faded out by 25 cm pixels.
- **meshes.js**: a plaza/pedestrian area (or any area tagged cobble) is laid in
  its own stone over the photo like a car park; the derived square plates are
  setts where the walked ways in the 3 × 3 chunks round are mostly sett.
- Switch: `GROUND_DETAIL` (one shared uniform object). Preset key
  `groundDetail` (off on low), panel row "Detail povrchů zblízka", console
  A/B `__atc.groundDetail.value = 0 / 1` (no rebuild, no recompile).

# Cars in one draw (November 2026)

A near car was 11 draw calls (paint, glass, trim, two lamp materials, plates,
badges, four wheels) plus a brake mesh, a far car 4; at ~6.5 us of CPU a call
the traffic was a large slice of a CPU-bound frame. Now:

* **`js/carmerge.js`** merges a kind's near parts (paint, glass, trim, head,
  tail, brake, plates, badges) into ONE geometry; per-vertex `cpbr`
  (roughness, metalness, env gain, depth rung), `cfx` (paint weight, head,
  lamp code 1 tail / 2 brake, night gate) and `duv` (decal atlas) say what
  each vertex is. The depth rung replaces the polygonOffset ladder: draped
  layers are pulled toward the eye in the vertex shader. The far dress is
  merged the same way (wheels baked in).
* **`js/carbodymat.js`** is the one MeshPhysicalMaterial that shades it:
  clearcoat only where there is paint, decals over the paint by their alpha
  from a per (kind, colour) atlas (vehicles.js `decalTexFor`), lamps lit from
  the same `lampMats` main.js drives (getters), a hashed city skyline in every
  reflection (lit windows at night). Lit / unlit (a parked car is dark) and
  braking are cached materials on one program: `js/carmesh.js setCarState`.
* **`js/carinstances.js`**: wheels and the distance dress are pool MEMBERS.
  The meshes stay where every caller expects them (wheels spin and steer,
  setCarLod hides and shows) but sit on layer 31; the scene's onBeforeRender
  copies the matrices of the visible, in-frustum members into one
  InstancedMesh per kind and side (wheels) and per kind (far dress, colour and
  lamps per instance in `iPaint`). Pools are named `carpool:*`.
* **Budget**: near car 1 draw (+1 shadow), wheels and far cars a few draws
  for the whole fleet. `userData.hulls` is `[body]`, `userData.brake` a plain
  `{ visible }`, `userData.carState` the swap state.
* **A/B**: `atcCars.instancing(false|true)` at runtime, `atcCars.city(k)`,
  `atcCars.stats()`; `?carmerge=0` builds the old eleven-part cars,
  `?carinst=0` starts with the pools off.

## The campaign "Poslední vlak", part one (js/prologue*.js, Nov 2026)

The story from the street in Kolín to Vašek's kitchen table in Pardubice. It
is a set of small modules round two owners that main.js holds: `journey`
(js/prologue.js: the opening film, the roof, the station, the train) and
`meeting` (js/prologue-parking.js: Vašek at his car, the drive, the house,
the table). Both offer `use()` (E), `update(dt)`, `frameCamera()` and
`posePlayer()`; main.js asks the story first and plays the game otherwise.

* **Script**: `prologue-dialogue.js` is the one place the words live
  (`hospitalCall`, `friendCall`, `parkingLines`, `tableTalk`, the two text
  messages). `scripts/gen-prologue-audio.mjs` renders one recording per id
  into `public/assets/last-train/`. A line without a recording is timed by its
  length (`storyRecording({ missing })`), so the film plays before it is voiced.
  Speech is never skipped: lines follow one another by themselves.
* **The film** (`prologue-opening.js`) is a list of beats: ring1, call1 (with
  the four-second cut to the hospital room, `prologue-ward.js`), a black card,
  the roof (`prologue-roof.js` logic, `prologue-roofset.js` dressing), the
  bank's message, ring2, call2. `prologue-actor.js` owns what is attached to
  the father (phone, face, the gestures of a call); `prologue-street.js` and
  the roof hold the shots as (right, up, forward) offsets from his eyes.
* **Two lamps** (`prologue-lights.js`): the story has exactly two point lights
  for its whole length, moved and tinted by whichever scene is on, so the
  count of lights (and every compiled material) never changes mid-play.
* **After the call** the roof is walkable but has an edge (`prologue-ladder.js`
  is a deck for `world.storyCoach`, composed with the train's in prologue.js)
  and the way down is the cat ladder: E takes it, S climbs down.
* **The run**: 120 seconds (`DEPARTS_IN`). The pin and the column of light
  (`prologue-marker.js`) lead to the departure board and no further: the
  platform is read there. `prologue-tracks.js` takes back any step onto the
  rails, in Kolín and in Pardubice, so the underpass is the only way across.
  `prologue-platform.js` and `prologue-waiting.js` furnish the platform the
  train leaves from; `prologue-birds.js` and `prologue-life.js` are the pigeons
  and the cat. Sitting down is `prologue-seat.js`, with the game's own camera.
* **No second chances**: nothing is saved before the campaign's end
  (js/career.js `storyRunning`), an unfinished chapter in a save starts again
  (`storyStart`), and a missed train or a death restarts the campaign in place
  (main.js `failStory`).
* **The train is heard** (`prologue-voice.js`): the story train is not one of
  js/trains.js's, so it starts the same synthesised ride itself (`trainSet`
  takes a level for a train heard from the platform) and sounds the horn.
* **Its own clock** (`prologue-clock.js`, `worldclock.overrideTod`): 20:00 on
  the street, 20:10 as the train leaves, 20:30 in Pardubice, 22:00 at the
  house. Only the sky, the light and the HUD follow it; `worldT()` does not.
* **Pardubice**: `prologue-house.js` is Dražkovická 119 (the doorstep outside,
  the kitchen as a closed set far below the house) and `prologue-table.js` the
  scene at the table that ends part one and writes the first save.
* **Three paces** (js/player.js `_pace`, config `WALK`): a walk, the run on
  Shift, and a sprint on a double tap of Shift that spends `stamina`
  (js/stamina.js draws the bar).

## Saving only at autosave points; the world's numbers fixed (Nov 2026)

Frank, 20 Nov 2026: "To se musí ukládat jenom jako na autosavy", later also
"i když budeme spát, když budeme mít svůj byt"; and of traffic, the crowd and
the police: "nesmí to tam být vůbec jako v možnostech nastavení".

* **One writer** (js/career.js `autosave(point)`): no timer, no `pagehide` or
  `visibilitychange` save, none on the death card, none after a purchase or a
  look change. A point is a key of js/autosave.js `POINTS`: `mission` (part
  one calls it from `checkpointStory('done')`, part two from `completeHeist`,
  later missions at their end) and `sleep` (for the flat that does not exist yet: its bed calls
  `career.autosave('sleep')`). Anything else is refused. The save records the
  point (`point`) and a card says "Uloženo".
* **A reload is the last point**: quitting, dying, closing the tab lose what
  happened since; an arrest steps back to it too (`reloadLast`). The campaign,
  the free roam after it, `?devmode` Freeroam and co-op follow the same rule.
* **Older saves** (v2, written every 20 s and on quit) migrate to v3 without
  the quit spot and hour: a finished part one stands you at its end
  (`PART_ONE_END`, Vašek's door), anyone else on the square; money, car and
  stats stay. A v2 death-card save keeps its hospital and pays its bill.
* **Traffic, crowd, police** (js/worldsettings.js `WORLD`: 120 cars, 60
  walkers, patrols 0.70; "Běžná", "Rušno", "Běžně"): fixed outside `?devmode`
  whatever storage holds, and not in the panel. With `?devmode` they are on
  the dev tab ("Provoz a lidé"); co-op locks them again (`shareWorld`), since
  every client builds the same fleet from them. The classic game neither reads
  a developer's stored choice nor writes over it (`forStorage`). The presets no
  longer carry `traffic` or `peds`. The panel's CSS is js/settingsstyle.js.
* Tests: tests/autosave.test.mjs, tests/world-settings.test.mjs.

## Part two of the Last Train: the car under Kunětická hora (js/heist*.js, Nov 2026)

Part one ends saved at Vašek's table. Part two is a third owner beside
`journey` and `meeting` in main.js (`heist`, same four hooks: `use`, `update`,
`frameCamera`, `posePlayer`), created whenever `career.heistPending()` says the
save has part one and not part two. Like part one it is played in one sitting:
`career.storyRunning()` is true while it runs, nothing is written, and
`completeHeist()` writes `heist: 'done'`.

* **Stages** (`js/heist.js`): wake (02:30, Dražkovická) → tofarm (the estate to
  Brozany) → farm (Jarda) → ride (his van, the player in the passenger seat) →
  drop → walk (Vašek on the phone) → theft (the villa where the map has
  "Perníková chaloupka") → run (home at daybreak) → end (the lock-up in Na Staré
  poště, `js/heist-garage.js`). Places are in `js/heist-route.js`, all read off
  the map tiles; lines in `js/heist-dialogue.js`; `js/heist-talk.js` plays them
  one after another with nothing to press.
* **The van** (`js/heist-farmer.js`) is a real car with Jarda in `seats[0]`, so
  E gives the player seat 1 by the game's own rule. Nobody simulates it: the
  file writes `x, z, heading, speed, steer, y` along a smoothed polyline
  (`track`). It stays locked until he is behind the wheel.
* **The Mercedes** (`js/heist-car.js`): leaves found by dropping rays on the
  body, two plates (a dark holder goes over the plate the body draws), a window
  that unlocks it, and `car.hotwire`, which main.js reads in two places (no
  `carStart` in `onSeated`, no gas in the drive step) until the wires meet.
* **The police** (`js/heist-police.js`): plates left on are read on the way in
  and the heat never cools (`host.fail('plate')` after a while); a bare car
  draws a patrol that gets a close look; two `traffic.spawnPatrol` cars stand
  across the end of 17. listopadu. Arrests are the game's own.
* **Failing** goes through main.js `failStory`: with a heist it shows
  `heist.failText(why)`, stands the player where `heist.rewind()` says (the
  villa's gate once reached, else Vašek's street) and plays on.
* **The balaclava** (`js/heist-mask.js`) hangs on `parts.headS`, a head socket
  added to the modelled human beside the two hand sockets.
* **Sound**: `scripts/gen-heist-audio.mjs` (ElevenLabs, run only when asked).
  `storyRecording()` gained `set(level)` for looping beds (the van's radio).

## Part two, second pass: the weave, the villa's rooms, the buyer (21 Nov 2026)

Frank, 21 Nov 2026, five things, all in `js/heist*.js` and `js/story-props.js`:

- **Jarda weaves and gives up the wheel** (`heist-ride.js`, `heist-farmer.js`).
  `rideScript` runs the stretch from the farm to the forest: `ride` (Jarda
  drives; `farmer.weave(0|1|2)` widens the sine he wanders by, `pullOver()`
  stops him on the verge), `swap` (he walks round the bonnet with `man.walk`,
  takes seat 1 once the player has left it; the player takes seat 0 by the
  game's own E), `drive` (the van is an ordinary car of the game now), `drop`
  (`takeWheel()` moves Jarda back across, then `leave()`). A car the player
  has ridden in is off main.js's `parked` list, so the van asks `host.offer`
  to be findable again. A skipped ride (retry) is the old one: he drives it all.
- **The villa** (`heist-villa.js`, `heist-house.js`, `heist-lasers.js`). The
  map's "Perníková chaloupka" is rewritten when its tile is read (`geo.js`:
  `t: 'house'`, `sealed`, no trade, no name). `sealed` means no inside of the
  city's making (`interiors.hasInterior`), so it is a solid block to a walker,
  and no lit window (`typologylit.litOf`). `host.quiet({x,z,r})` sets
  `peds.keepOut` and `interiors.keepOut`: nobody walks there, nobody lives
  there. The way in is the story's: a ladder and a window on the west wall
  (a fade), into four rooms that are a set 46 m under the house. While he is
  in them `villaJob` is `world.storyCoach` (floor, and `pushOut` against
  `walls` and `furniture`) and owns the camera: from above and from the
  south, no ceiling, `host.aim(Math.PI)` so that W is up the picture. The
  game's own boom does not fit between those walls.
  A scanner (`scanners(parent, specs)`) is a camera on a wall whose beam comes
  down to a dot that swings between two points and rests at each; `caught()`
  is the dot and the beam below waist height. Five inside, one over the
  ladder. Being caught is `host.fail('laser')`: back to the gate, the key on
  the desk again (`job.reset()`). `tests/heist.test.mjs` searches place and
  time to prove the house can be walked at a walk between the beams.
  The key (`E` at the desk) unlocks the car (`merc.key()`); holding E starts
  it. The broken window and the two wires are gone. `villa-music` plays from
  the gate until the engine catches.
- **Leaves** (`heist-car.js`). Each leaf and twig is an item with a threshold
  of "metres driven, weighted by speed"; past it the instance on the car is
  zeroed and a twin in `air` (an unlit InstancedMesh in the scene) leaves with
  half the car's speed, sinks at 1.2 m/s rocking, lies on the road 11 s and
  shrinks away. Bird lime stays on the car.
- **The end** (`heist-garage.js`, `heist-deal.js`). `garageSet` is the room,
  shared by two films: `garageScene` (night, the door down) ends on the card
  "V poledne"; `dealScene` opens the door on a white noon. The briefcase
  (`props().briefcase()`) is never parented to a hand: each frame it is put at
  the holder's hand socket, or between two hands during a handover (`owner`
  0..2), or laid flat on Vašek's arm with the lid up (`flat`, `open`).
  `step` orders the scene: lines 0..5, the look into the case at 2.5.
- **Props** (`story-props.js`): turned bottles with labels, small glasses, a
  knitted balaclava with an eye opening, kitchen chairs with spindles, the
  briefcase with its money. Vašek's kitchen (`prologue-house.js furnish`)
  and the villa use them.

## A failed mission starts clean (js/story-retry.js, Nov 2026)

Frank, 20 Nov 2026: dead or arrested, the mission starts again, every film can
be skipped, and Vašek waits at the station again.

- `retry` is the mark a failure leaves (`failStory` in main.js sets it; it is
  stored under `atc-story-retry`, so a reload keeps it). `career.checkpointStory('done')`
  and `career.completeHeist()` lift it. A first play still skips nothing.
- While the mark is set, T (`journey.skip()`, `meeting.skip()`, `heist.skip()`)
  ends what is running: the opening film (`opening.skip`, not during the title
  card, which is the loading), the talk at the car park (Vašek is put in his
  seat), the film at the table, any talk of part two (`talker.skip` still calls
  what waited for the last word), the ride in Jarda's van (`farmer.skipRide`:
  black, the forest road's tile fetched, the van put 14 m short of its stop)
  and the film in the lock-up. The button is `hud.offer(label)`.
- `setHome(car)` stamps the estate's bay when the fleet is parked;
  `parkHome(car)` puts it back there on a restart of part one, whole and
  fuelled, with `_grounded = false` so it settles when that ground is known
  (he may have failed in Kolín). Vašek stands at `besideCar(car)`, so he is in
  front of the station again. Part two mends the estate in `enter('wake')`.

## Doors, locks, jumps and arrests: the step before part two (Nov 2026)

Stealing a car and moving a body, so that part two (the theft at Kunětická
hora) has something to stand on. Small modules round `js/player.js`:

* **Locks** (`js/carlocks.js`): 99 parked cars in 100 refuse the handle. The
  draw is hashed from the car (its fleet index, or the spot it stood on), so it
  never changes and is the same on every co-op screen. Never locked: `owned`
  (the garage), `unlocked` (Vašek's estate, a dev spawn, any car the player has
  sat in), and a car in traffic (that is a carjacking, below). You find out at
  the handle: main.js's E handler passes `locked` to `boardVehicle`, and the
  hint only says "zamčeno" once that handle has been tried.
* **The door** (`js/cardoor.js`): a car is one mesh with no door node. An open
  door is the body drawn with the door's outline discarded (the hole), the same
  geometry drawn again on a hinge with everything else discarded (the leaf),
  and a card for the leaf's inside. Both are uniforms on the one body program
  (`js/carglass.js doorIn`, keyed into `bodyMatFor` as a fifth key), so opening
  a door compiles nothing and costs two draws for one car. `doorSpec(kind,
  seat)` reads the outline off the same shape cardetail.js draws its shut lines
  on. Truck and bus have none and keep the old slide.
* **The cabin** is in twice. Behind every window of every car it is DRAWN, not
  built: a fragment of glass (`cpbr.z > 2`) follows its view ray into the car's
  frame and meets boxes and ellipsoids placed from `cabinSpec` (seats,
  headrests, dash, wheel, far door and windows, a driver when the lamps are on
  or `setDriver` says so). No geometry, no draw call. The real one
  (`attachCabin`, six meshes) goes in for the car whose door is open or whose
  driver's eyes are in use (main.js `fpCabin`), with `js/cabinkit.js` seats and
  one of three steering wheels; `cabinVariant(kind, colour)` picks the wheel
  and the upholstery for both, so what the glass shows is what the door opens
  onto. The two front door cards are meshes of their own and hide while that
  door is open.
* **Getting in and out** (`js/carentry.js`, called by player.js): walk to
  `door.stand`, reach, then either `tug` (locked: two pulls, `onLocked`, walk
  away) or open, `jack` (somebody in the seat: `onJack`), enter round the door,
  sit, and `player.doorAnim` pulls the door shut (`onShut`). Out is the same
  backwards. `player.doorCar` is whose door is open.
* **Poses** (`js/bodymoves.js`): records of joint angles blended over a base
  pose with `pose(parts, p, w)`. Reach, tug, haul, duck, jump, land, vault,
  the two get-ups, hands on the head.
* **Space** (`js/leap.js`) is a jump, or a vault when something low is right in
  front and there is ground behind it (asked of the walker's own collider at
  two heights; a car's bonnet by name). A jump is only an upward start for the
  gravity the walker already had. Space no longer punches: that is the mouse.
* **Getting up** (`js/ejection.js riseCurve`, `bodymoves.getUpPose`): a thrown
  body gets up with hands and knees, one way from its front and another from
  its back. `player.tumble()` throws the body down without a crash.
* **Carjacking** (`js/carjack.js`): the driver leaves through the door as a
  ragdoll, lies, gets up, runs. `witnessed()` is the rule: a person or a lit
  window within 100 m makes it `prepadeni`, two stars at once.
* **Arrest** (`js/policetune.js lethal`, `js/policecops.js` 'seize'): below
  three stars nobody shoots. Officers run at the player (to the driver's door
  of a stopped car), bring a runner down (`onTackle`), and arrest one who holds
  still (`onArrest`). main.js `busted()` kneels the player (`player.held`),
  shows ZATČEN and steps back to the last save (`career.reloadLast`); in the
  campaign, which is not saved, it is the campaign's own restart.
* **Sounds**: `scripts/gen-move-audio.mjs` (ElevenLabs, run only when asked).
  Until the files exist `audio.sfxOr` plays the old door pair instead.
* **Looking at it**: `dev/moves.html` stages one car and the player on a flat
  floor (`?scene=enter|locked|exit|jump|vault|getup|busted&t=…&strip=…`).

## The sound of cars (js/caraudio.js, public/worklets/, Nov 2026)

The engine used to be an oscillator playing one stored cycle of cylinder pulses
(js/audio.js `buildPiston`). Every cycle was the same cycle, the spectrum fell
away above 600 Hz, and revs were a straight function of road speed. It sounded
like a synthesiser because it was one. It is still there as the fallback; what
plays now is this.

* **One door** (`js/caraudio.js`): main.js calls `carStart(kind)`, `carStop()`,
  `carDrive(dt, car, load, gas, handbrake, city)` at the wheel and
  `carAudioFrame(dt, traffic, ears..., cabin, city)` every frame. It feeds the
  recorded layers that stay in audio.js (tyre roll, wind, skid) and drives the
  synthesised ones below.
* **Revs and gears** (`js/drivetrain.js`, pure): real ratios per kind (km/h per
  1000 rpm), a box that shifts by revs and pedal (early under a light foot,
  kickdown under a heavy one, down through the gears under braking, held in a
  slide), a clutch that slips pulling away, revs that fall through an upshift
  and blip on the way down, fuel cut on the overrun and a limiter that cuts in
  bursts. Traffic has no pedal, so `throttleFromMotion` guesses it from how the
  speed is changing.
* **Which engine** (`js/enginekinds.js`): `eng` (how it sounds) and `box` (how
  it is geared) per vehicle kind. The electric kinds and the tram are
  `ROLLING_KINDS`: no engine voice from the mixer, only the road layer. Tesla
  and trolleybus keep the motor whine of audio.js `buildEV`.
* **The voices** (`js/carvoices.js`, pure): one drivetrain per voice, the voice
  budget (`js/voicebudget.js`: eight traffic voices, ranked by loudness at the
  ears, sticky, stable slots) and one `Float32Array` a frame to the mixer.
  `post` is a MessagePort in the game and a function call in node, so tests and
  offline renders run the code the game runs.
* **The synthesis** (`public/worklets/`, loaded by `audioWorklet.addModule`, so
  it must be served as it stands: that is why it is not in js/):
  * `enginedsp.js`: the crank turns and the events of the four-stroke cycle
    happen as impulses (burn, exhaust valve, intake valve, valve ticks), each
    with its own random strength and timing. They pass through fixed things: a
    header pipe (quarter-wave delay loop), a silencer, a tailpipe, an intake
    resonator, the block. Noise is multiplied by the gas flow and by each burn.
    Turbo whistle with lag, blow-off, afterfire pops, cabin colouring.
  * `roaddsp.js`: tyre band for traffic, setts (a train of knocks into two body
    resonances, 12 cm apart), brake rub and the squeal of a last metre, brake
    air, tram rail rumble; `Impacts` is a collision as noise through detuned
    sheet-metal modes, re-struck while it crumples.
  * `carmixer.js`: slot 0 is the player (dead centre), the others are traffic:
    inverse-distance level, an air lowpass, equal-power pan, and Doppler from a
    delay line read distance/c seconds late, so everything bends together.
  * `car-worklet.js`: the AudioWorkletProcessor wrapper, nothing else.
* **The cabin**: `audio.js setCabin()` closes a lowpass and lifts a low shelf on
  the whole `master` bus while the camera is in the driver's seat; story
  dialogue goes round it on the `dry` bus. Both follow `setVolume`, so volume 0
  is still silence.
* **Setts**: `js/roadsurface.js cobbleAt()` asks the map whether the point is on
  a drivable street tagged `s: 'cobble'`. The player is probed ten times a
  second, one voiced traffic car per frame.
* **Cost**: nine voices render in 2 to 4 % of real time on one core of the
  audio thread; nothing is allocated per block. The main thread adds one
  drivetrain step per voice and one postMessage a frame.
* **Listening without sound** (the game runs muted in the built-in browser):
  `dev/audioscenes.js` scripts short drives; `node dev/render-car-audio.mjs
  <dir>` renders the synthesis alone, and `dev/audiorender.html?engine=old|new`
  renders the whole mix through the real audio.js into an OfflineAudioContext
  (`dev/audiorender-save.mjs` receives the WAV files).
* **Tests**: `tests/drivetrain.test.mjs`, `tests/voicebudget.test.mjs`,
  `tests/caraudio.test.mjs` (firing rate, no two cycles alike, load, Doppler,
  pan, distance, budget, brake air, setts, impacts, cost).

## The small life of a street (js/streetlife.js, Nov 2026)

Birds, the dogs people walk, prams, and what a passer-by has in a hand. main.js
builds one `StreetLife` next to the crowd and calls `update()` after
`peds.update()`; `peds.panic` is chained into `streetLife.scare`, so every bang
that makes people run also puts the birds up.

* **Four draw calls for all of it.** Birds, dogs and prams are each rows of one
  InstancedMesh; the leads are one small dynamic mesh. Wings, legs, heads and
  tails move in the vertex shader off per-row attributes (`birdmodel.js`,
  `dogmodel.js`), so a seated bird costs no script at all and its peck is a
  clock uniform. The bag in a hand and the phone at an ear are a few triangles
  in the walker's own skinned mesh (`bodyextras.js`), never a draw call.
* **Birds** (`birds.js` and its parts). `birdperches.js` lists, per streaming
  cell, the places a bird could sit: lamp arms and park lanterns (from
  `poles.js`), the top edge of road signs (`meshes.signPerches`, the mesher's
  own plan), the trolley wire, the eaves and parapets of roofs, patches of
  footway and quiet street, fields in open country. `birdsites.js` (pure, no
  imports) decides for each candidate, from its position alone, whether a flock
  lives there, of which species (pigeons and sparrows in town, crows at the
  edges and in fields, gulls within 70 m of water) and where each bird sits.
  `birdflight.js` (pure) is the steering that takes a bird from a seat into the
  air and onto another. Flocks get rows inside 105 m of the player and give
  them back past 140 m; the pool is 260 rows including the flocks that only
  pass overhead (`birdsky.js`, a closed form of the shared clock).
* **What scares them.** The player on foot (a hop of a few metres when
  strolling, the whole flock up when running), a car that comes AT them (a
  flock on the carriageway goes well before the bumper; one on the pavement
  sits through the traffic), a walker passing through (a hop), and any bang.
  A bird on a lamp, a wire or a roof ignores the street and goes only for a
  bang. Scared flocks land on a free perch nearby or leave for a minute;
  flocks also move about on their own. The wings are recordings
  (`scripts/gen-bird-audio.mjs`, ElevenLabs: one bird, a few, a flock,
  sparrows, a crow), played from where the flock was.
* **Seen from a car.** A game day is 24 minutes, so the night keeps half of
  the birds on lamps, signs and wires; birds are drawn a fifth over life size;
  and the roadside has its own perches: lamp arms, the tops of trolley masts
  (measured off the mast's own geometry), and patches of pavement a step
  behind the kerb on both sides of a street.
* **Dogs** (`dogs.js`, `dogwalk.js`). A dog belongs to its owner's body and
  arrives and leaves with it, under the crowd's own no-pop rule. It heels,
  pulls until the lead is tight, stops to sniff and is waited for, sits when
  the owner stops, and waits by an owner who is down. The lead is drawn from
  the owner's wrist bone to the collar and is a hard length in the simulation.
* **Hands with a job** (`pedprops.js`, pure). `propFor(seed, archetype)` gives
  a bag, a phone, a pram, a dog or nothing, off the citizen's own seed through
  its own salt, so it never disturbs the wardrobe draw. `js/gait.js` holds the
  arm (`HOLD`), standing and walking; the man with the stick keeps his stick
  and takes the lead in the other hand.
* **Co-op.** SHARED, because pure in the map, the seed and the shared clock:
  where flocks live and what they are, the flocks overhead, who carries what,
  which dog and which colours. LOCAL: a flock in the air and where it landed
  (it is back on its shared seat when it next comes into range), where a dog
  is sniffing this second, and the on/off switches.
* **For the campaign and anything else:** `__atc.life.birds.scare(x, z, r)`,
  `.flockNear(x, z, r)`, `.flush(flock, x, z, hard)`; `life.birds.enabled`,
  `life.dogs.enabled` and `life.prams.enabled` switch a part off in a running
  game, which is how its frame cost is measured.

## Pardubice hlavní nádraží as it stands (js/station-*.js, js/pardubice-*.js, Nov 2026)

The station used to be one straight corridor with four exits. It is now the
station of the 2020 to 2024 rebuild, read off OpenStreetMap (Overpass, 19 Nov
2026), the ČÚZK aerial photo and photographs of the finished building: five
platforms, tracks 1 to 11 for passengers (the station is signed by track
alone, with sectors A to H), two underpasses from the hall, and the covered
red footbridge to Dukla. Kolín keeps the underpass the campaign was built on.

* **The plan is data** (`js/station-layout.js`, no three.js, tested by
  `tests/station-layout.test.mjs` against the shipped tiles). Each station has
  a frame (u along the platforms, v across the tracks), ROOMS (rectangles of
  corridor floor) and FLIGHTS (axis-aligned ramps of steps from that floor to
  the surface: `axis, a, b, c, half, kind`). `kind` gives the lanes across a
  flight: plain steps, two belts (`escalator`), or steps and two belts
  (`hall`). Pardubice also has a `deck` and `ramps` up to it (the footbridge).
  Everything a walker needs is arithmetic on these: `floorAt`, `deckAt`,
  `nearestInside`, `nearestOnDeck`, `fencedOut`.
* **`js/station-passages.js`** is the same `world.stationPassages` as before
  (`floor`, `contain`, `inside`, `covered`, `cut`, `update`, `stations`), now
  generic over the plan, plus `lid(x, z)`: the underside of whatever roof the
  station built there. main.js keeps the camera below it, so the lens never
  looks down through a canopy. `cut` discards the ground inside every flight's
  footprint (the list of rectangles is written into the shader).
* **Pardubice's choices that are not reality**: the eastern underpass enters
  the hall round a corner (the real hall is 90 m long, the game's 72, and its
  own well would be under the annex); the lifts are towers and doors only;
  the departure boards show a fixed evening.
* **Walled mouths** (`walled`): somebody at platform level who is over a
  stair mouth, and not on its top steps, is put back outside it; on the bridge
  the glass does the same (`contain`). Kolín's mouths stay open as they were.
* **Landing heights** are read `beyond` the head of a flight: the mapped
  stairs under it are drawn a step above the paving.
* **Drawing** (`js/stationkit.js`): boxes and drums instanced per finish, the
  pattern of a finish (tiles, bricks, roof seams) laid in metres by the
  fragment shader, every plate of text in one atlas packed at `finish()`, and
  additive pools of light for the night. One draw call per finish. Finishes
  that light themselves are turned down as the game opens its exposure after
  dark (`night(k)`). `pardubice-underpass.js` builds the corridors, flights,
  plates and boards; `pardubice-platforms.js` the canopies (salmon red from
  above, as in the aerial photo), brick benches, clocks, names and sector
  plates; `pardubice-lavka.js` the footbridge; `pardubice-signs.js` holds
  what is written; `pardubice-station.js` puts them together.
* **Moving stairs** (`js/station-belts.js`): every tread of a station in one
  instanced mesh; a belt is a ramp underfoot and carries whoever stands on it.
* **The campaign** reads its way out of Pardubice from `prologue-route.js
  wayOut(u)`: the stairs or the moving stairs of the platform between tracks
  4 and 5, the western underpass, the moving stairs into the hall, the doors
  to the square. `prologue-tracks.js` is unchanged: the footbridge and its
  ramps count as floor, so they are allowed inside the yard.

## Modelled people and the character creator (js/characters/, Nov 2026)

Frank, 19 Nov 2026: the lofted figures of `js/citizen.js` still read as
puppets; every character should be a real rigged 3D person with recorded
motion, and a new campaign should start by choosing who you are.

`makeCitizen()` keeps its interface and gains a second body behind it. When
the PEOPLE BANK is loaded (`public/assets/people/manifest.json`, fetched while
the menu is up by `peopleload.js`) it returns a `makeHuman()`; without a bank
(headless tests, a failed download) it builds the lofted figure as before. No
caller knows which it holds.

* **One pose, any skeleton** (`skeletonmap.js`, `retarget.js`). A downloaded
  rig is found by bone NAME (Unreal, Mixamo, 3ds Max Biped, VRM families) and
  described against one reference pose: standing, arms and legs hanging
  straight down. A pose is then a rotation per SLOT away from that reference,
  which means the same thing on every skeleton. The game's own seventeen
  joints (`js/bodyjoints.js`, shared with the lofted figure) are the simplest
  such rig, so every move ever written for them (the walk solver, sitting, the
  car door, the vault, getting up, the arrest, the campaign's keyframes)
  carries across unchanged. The same bridge bakes a clip recorded on one
  skeleton for another.
* **Clips are numbers** (`clipbank.js`, `animset.js`). A clip is sampled once,
  at load, into local rotations of the skeleton that will be drawn: no
  AnimationMixer anywhere. Gaits are blended by speed and advanced by DISTANCE
  over the ground each recording covers, so a planted foot stays planted;
  every gait is turned to start on the same foot and stood on the ground of
  the body it plays on. Standing is one calm loop with an occasional fidget,
  drawn per person.
* **Clip or game, joint by joint** (`resolve.js`). The owner's base call
  (walk, stand, sit on a bench) picks a recording. The game's joints are then
  compared with the base it last asked for: a joint something moved since (a
  hand out to a door, a pistol raised, a scripted gesture) takes the game's
  angle, added to the clip while the difference is small and replacing it by
  0.35 rad. No recording for a state (a car seat, a ragdoll, a bicycle) means
  the game's pose for the whole body. A change of clip cross-fades.
* **A mouth that opens** (`mouth.js`). The one face bone a person keeps is the
  jaw, and `human.js` turns it after the pose is resolved, about the figure's
  left-to-right axis taken into the jaw's own frame at load. Two callers: the
  campaign calls `mouth(level)` every frame with the measured loudness of the
  line being played (`voiceToMouth` of `storyRecording().intensity()`), the
  street (`chatter.js` `_utter`) and the unmetered story lines call
  `talk(seconds)`, which makes the syllables up. Somebody talking while
  standing also plays a recorded gesture loop (role `talk`). A far body has no
  jaw to move, which nobody can see at sixty metres.
* **People behind car glass** (`seatrows.js`, `seated.js`, `js/carcrew.js`,
  `js/carglass.js`). A car is one mesh with opaque glass and its cabin is
  drawn by the body shader following the view ray, so nobody can sit in it as
  geometry. The people in the front seats are PICTURES of the modelled
  bodies: a person is sat in the car pose and photographed once from sixteen
  sides into a row of one render target (96 x 128 a picture, sixteen rows,
  made from the bank at boot and when somebody new sits down; nothing is
  downloaded). The glass intersects its ray with an upright plane through the
  seat that faces the eye and reads the picture taken from nearest that side.
  `seatrows.js` (pure) keeps whose picture is in which row: stock drivers
  (`@civ0..7`, `@police`, `@medic`) are never given up, named people
  (`body+head:d|p`) go by least recent use. `carcrew.js` says who a car
  shows: every car is born with a stock driver, shown while its lamps burn;
  `cardoor.js` `setDriver(car, { jacket, cit })` and `setPassenger(car, cit)`
  name the player, a co-op rider or Vasek, who are shown lamps or no lamps.
  The crew is part of the body material's key and its four-vector is shared by
  reference, so rows can be drawn or lost after a material exists. Without
  the bank the glass falls back to the box and ball it always drew. Whoever
  is thrown out of a jacked car is the person the glass showed
  (`carjack.js`).
* **A skeleton as flat arrays** (`skinpose.js`, `human.js`). Bones are not
  scene objects. A body's pose is resolved in `onBeforeRender`, so a person
  behind the camera costs nothing, and the skinning matrices are written
  straight into the skeleton's texture (a detached-mode SkinnedMesh with a
  no-op `Skeleton.update`). The shadow pass sees the pose of the frame before.
  Hands are sockets on the real wrist in the game's joint frame, so a pistol,
  a lead or a phone attaches as it always did. The driver joints sit in a
  hidden group, which the scene-graph policy does not traverse.
* **Far bodies** (`farbody.js`). Past `FAR_OUT` (62 m, `js/peopleshadows.js`)
  a person is an InstancedMesh of one whose vertex shader skins from a float
  texture baked once per modelled person: a row per frame of each gait, an
  idle and a seat. The row number rides in `instanceColor.r` (a per-object
  uniform on a shared built-in material is not re-sent between two objects
  drawn back to back). The processor's whole cost is that one number.
* **Who is who** (`cast.js`, `appearance.js`). A pedestrian's body is a pure
  function of its shared seed and its archetype (which already decided its
  voice); uniforms and the story's named people are tables. A player is
  `'1-<head>-<body>'`: the catalogue ids picked in the creator, a dozen
  characters, kept in localStorage (`atc-look`) and in the save, and sent in
  the co-op state blob as `ap` beside the nickname (`js/netcity.js`), where the
  relay never looks. Every receiver checks a code against its own catalogue.
* **The creator** (`creator.js`, `creatorstage.js`, `creatorstyle.js`). Opens
  before a campaign that starts from its first frame when no look has been
  chosen ("Nová hra" forgets the look), and from Nastavení, Hra, "Vzhled
  postavy" over a running game (`player.reskin()`). Its lists are computed
  from the catalogue. As a dialog it closes on Escape and on a click whose
  press and release both land outside the card.
* **Looking at it without a bank**: `js/characters/dummy.js` is a crash-test
  person (Biped names, T pose, centimetres, facing +z, arbitrary bone axes)
  whose clips are the game's own moves recorded onto its bones.
  `dev/people.html?rig=dummy`, `dev/moves.html?rig=dummy`, `dev/creator.html`,
  and the whole game with `?devmode&people=dummy`.

### The bank itself (public/assets/people/, scripts/people/)

The people are 44 of the Microsoft Rocketbox avatars (MIT licence, kept beside
them in `LICENSE.txt` and credited in the menu): 33 everyday adults, four
police, two paramedics, a nurse, a doctor, two children and a uniformed man who
plays the conductor. Their motion is 77 Rocketbox clips, recorded separately
for men and for women: three walks and three runs each, standing loops and
fidgets, sitting, the phone, a held bag, pushing, talking. The sources (1.8 GB
of FBX and uncompressed textures) live OUTSIDE the repository; nothing here is
part of a build. By hand:

    scripts/people/fetch-rocketbox.sh previews | avatars NAME... | anims NAME...
    scripts/people/build-people.sh          (Blender headless, Pillow, node)

* `people.json` is the catalogue: who is in, their sex, age, skin tone, style,
  the story's cast (`named`) and which clip plays which role.
* `convert-rocketbox.py` (Blender): one FBX to `avatars/<id>.glb` with no
  images. The mesh is split into `near_body`, `near_head`, `near_hair` (so the
  game can draw one person's head on another's body), a `far` copy at 1 300
  triangles, the face bones folded into the head except the jaw (53 bones
  remain; the jaw takes the lower lip and the tongue with it), and the UVs
  moved into the atlas layout.
* `build-atlas.py`: body, head and the alpha-cut hair cards in ONE texture per
  person (`atlas/<id>.webp`, 1792 x 1280), so a person is one draw call; every
  atlas again at 224 x 160 in `far.webp`; and `manifest.json`.
* `bake-clips.mjs`: the 77 clips in one `clips.bin` (16-bit rotations, fingers
  held still, 4.7 MB) read back by `js/characters/rawclips.js`.

What the game does with it:

* **One family, one bake.** Rocketbox clips are used as recorded (`family`
  matches), so their rotations are the same for every body: 41 of the 44 share
  a single bake and differ only in the path of the hips, scaled by leg length
  and stood on that body's own ground. The first body of a family fixes the
  bone ORDER; files that list their bones another way round are sorted to it.
* **A root that is not a bone.** A Biped's root (travel, and the turn of the
  hips) is the armature node above the bones, animated in a clip and standing
  still in a person's file. `bakeClip` carries the WORLD rotation across for a
  bone whose parents differ (`sameParent`), and follows node scale down the
  chain (the armature is in centimetres).
* **Sharp textures only near.** Every material starts on its tile of
  `far.webp`. A person's own atlas is fetched when the first near body of that
  person appears and dropped half a minute after the last has gone
  (`retainHi` / `releaseHi`). A body is born FAR unless it is a player or one
  of the story's people, so somebody spawned out of sight asks for nothing.
* **A head on another body** (`partGeometry`, `makeHuman({ head })`): the
  body's geometry without its head, and the other person's head and hair
  bound to the body's bones through its own inverse bind matrices. The creator
  offers it within one sex and skin tone.

Measured on the M1 Pro, medium preset, 1024 x 768, the same session, the bank
switched off and on (`?devmode&people=off`): Pardubice by the castle 6.1 ms a
frame with the lofted figures and 5.2 ms with people; Václavské náměstí 7.4
and 5.6. A showroom crowd of 24 costs 1.45 ms near and 0.69 ms far.

Not done: the driver drawn behind a car's glass is still the shader's own
(`js/carglass.js`); nobody's lips move when they speak; the Quaternius
Universal Animation Library (CC0, downloaded with the sources) is not wired
in, so jumping, punching, aiming and getting up are still the game's own poses
carried onto the new bodies.

## Chain stores and fast food as they stand in Czechia (js/stores/, Nov 2026)

Frank, 20 Nov 2026: every Lidl, Albert, Billa, Kaufland, Penny, McDonald's and
KFC should look as it does in reality, inside as well, and you should be able
to do there what you do in reality. The Billa in Pardubice "looks nothing like
a Billa"; a Lidl "is one of those big glazed buildings".

The tiles already name them (`n`, `u`, js/interiors.js had a BRANDS table for
the fascia): 143 buildings called Lidl, 167 Penny, 138 Albert, 109 Billa, 59
Kaufland, 45 McDonald's, 32 KFC. Nine in ten stand on their own. What they
lacked was everything else: a Lidl was a grey shed with strip windows and
grey boxes for shelves.

* **A store is a generated landmark** (`landmark.js`, `chains.js`).
  `landmarkOf()` asks `storeLandmark(f)` after the hand-made list: a building
  whose name is a chain's and which stands alone (not housing, not over 11 m,
  no courtyard, the right trade, a plausible size) answers with an entry shaped
  like the hand-made ones. The far mesh then skips it, the destructible
  interiors skip it, and its own generator draws it in every tier. A Lidl under
  six storeys of offices on Wenceslas Square stays the office block it is.
  `?devmode&stores=off` makes every store generic again (a before and after).
* **Fitted, not placed** (`site.js`). One answer per building for the mesh, the
  collision, the interior and the people: its own axes, which wall is the
  front, where the door is, which runs of wall are glass. THE FRONT IS THE WALL
  THAT LOOKS AT THE CAR PARK (the mapped parking polygons, weighed by size and
  by how squarely the wall faces them), not the wall nearest a pavement: the
  Lidl by Pardubice station has a service lane three metres off its gable and
  its car park along the whole north side. The choice is a plain memo on the
  feature (`_sf`), made on the main thread before a chunk's inputs are copied
  (`pinStores` in js/meshpool.js), so the mesh worker reads it and both builds
  agree. The drive-through (`drive.js`, `_sd`) travels the same way.
* **The shell** (`build.js`, `dress.js`, `dressfast.js`), by js/landmarkskit.js:
  walls on the footprint's own edges in three courses (plinth, sandwich panel,
  the chain's band), the glazing as REAL HOLES with their frames, a mono-pitch
  or a flat roof with its plant, and the inside of the same box (floor,
  ceiling, inner wall faces, lit after dark). In front: the canopy on its
  columns, the trolley bay, the hours board, the sign on the front and the
  flanks, the pylon. A restaurant gets the brand fin, a terrace with parasols,
  a playground (McDonald's) and, where OpenStreetMap maps the lane (the two ways
  round the Pardubice McDonald's are named "McDrive"), the order post, the
  hatch and the height bar. Three new surface kinds in the landmark material
  (`K.panel`, `K.slats`, `K.paving`, appended).
* **Signs** (`signs.js`, `signpaint.js`, `logodraw.js`) ride the chunk's
  wordmark stream, so they batch with every other fascia. Only
  `{ label, sign, trim }` of a brand crosses from the worker, so the label says
  what to paint: `@lidl/sq`, `@kfc/band`, `@albert/hours`. What a sign shows is
  one switch (`SIGN_STYLE.logos`): `'drawn'`, each mark rebuilt from plain
  shapes in code (no logo file is ever loaded), which is what ships since the
  owner chose it on 20 Nov 2026; `'plain'`, the chain's colours and its name
  in type, which is what the fascias always showed (`?devmode&signs=plain` to
  compare).
* **A store on a slope** (`site.js floorRel`, `apronOf`). The floor is laid
  over the highest ground under the footprint (up to 1.6 m over the founding
  height), so no turf comes up through the tiles, and the paved apron before
  the doors is a ramp from the floor down to the ground as it lies: the mesh
  draws it and `world.stores.floor` lets feet walk it.
* **Near the player** (`world.js`, one `StoreWorld` on `world.stores`). Within
  380 m: the glass in the holes, the sliding door, the lit room
  (`shellfx.js`), three draw calls a store. Within 130 m: the fittings
  (`layout.js`, `eatlayout.js`, `fixtures.js`, `fixgeo.js`), one InstancedMesh
  per kind of fitting, every instance showing its own cell of ONE procedural
  sheet of stocked shelves (`goodstex.js`, 8 x 8 cells, nothing copied from a
  photograph, no pack carries a name). A 2 600 m2 Lidl is some 400 modules in a
  dozen draw calls. `world.stores` answers `floor` (city.supportY), `collide`
  (city.collide: fittings and a shut door), `covered` and `lid` (the camera),
  `use` (E), `hint`, `posePlayer` (seated).
* **Shopping** (`shopping.js`, `cart.js`, `panels.js`, `catalog.js`). A basket
  inside the door or a trolley from the bay; E at a shelf opens the department
  with Czech shelf prices of late 2025 (ČSÚ averages where there is one, a
  discounter a few per cent under the list); a till with a cashier or a
  self-checkout scans the cart item by item; `wallet.pay` settles it and the
  food goes into the BAG (key I), from which it is eaten through
  `vitals.heal` and `vitals.eat` like any meal. Walking out with unpaid goods
  sets off the alarm at the door and is a crime (`wanted.add`).
* **Eating** (`eating.js`). Order and pay at a kiosk or the counter, wait for
  the number, collect the tray, sit on a free chair: the meal heals and fills
  bite by bite while seated. From the driver's seat the same order is placed at
  the order post and handed out at the window.
* **People** (`schedule.js`, `crowd.js`). Nobody is simulated. Where slot 4 of
  a store is at a given second of the SHARED clock is a function of the store's
  key, the slot and the clock: a visit is a plan of nodes along the free
  corridors (door, gate, two to four shelves, a till, out; or kiosk, counter,
  table, out), so two co-op players see the same woman at the same shelf with
  nothing on the wire. The bodies are the game's own people with their recorded
  walk, stand and sit; a reaching hand, a scanning arm and a bite are added
  joint by joint. Cashiers sit at as many tills as the hour needs.
* **Car parks** (js/parkinglots.js `shopLot`, `lotStalls`; `lotpaint.js`): a
  lot within 75 m of a chain store fills by day and empties at night, where a
  housing estate's does the opposite, and its bays are painted: the lines are
  the very stalls the parked cars stand in.
* **A chain as a tenant** (`world.stores.tenant`, called from js/career.js): a
  Lidl under an office block has no shop floor to walk, so E opens one screen
  with the chain's own goods at its own prices (into the bag), or its own menu
  (eaten at the counter), instead of the generic food counter.

Over the whole world 669 buildings are rebuilt this way (Penny 152, Lidl 131,
Albert 102, Billa 92, Kaufland 52, Tesco 46, McDonald's 37, KFC 25, Norma 14,
Burger King 10, Makro 5, Globus 3), about 1 500 triangles each, 60 of the
restaurants with a mapped drive-through. Measured on the M1 Pro (medium, noon,
1024 x 768, the pane hidden, the machine under other load): standing 22 m from
the front of a store with its whole interior in view costs about 1 to 2 ms a
frame over the same spot with the stores switched off (Pardubice Lidl 5.3 to
some 7 ms, Prague Kaufland 4.2 to 5.6 ms), of which the people are most; the
simulation step pays 0.06 ms; away from a store nothing.

Not done: a chain that is a tenant of a bigger building (a quarter of the
Alberts) keeps the generic building, with the one-screen counter above; nobody
drives through the drive-through but the player; the saddle-roofed stores of the
1990s are built as flat-roofed boxes; a store has no back-of-house; the
shelves cannot be blown up (a store is no longer a destructible building).

Tests: `tests/stores.test.mjs` (17): recognition against the real tiles, every
wall accounted for with one door on the front, the door open and every other
run solid, sound geometry on fifty real footprints, worker parity, the
drive-through on the mapped lane, layouts inside their walls, visits that are
deterministic and never teleport, the cart, the bag and the order.

## The Tesla showroom at Průhonice (js/stores/showlayout.js, showroom.js, 21 Nov 2026)

Tesla Centrum Praha is at V Oblouku 727, Průhonice (the retail zone it shares
with Čestlice, by the D1). The map has it as the building "Tesla Prague"
(`u: car`) in tile `-18_0`: a glazed strip 6.6 m deep wrapped round the south
corner of its workshop hall, 306 m2. No tile was rebuilt for it.

It is a fourth KIND of chain store, `showroom`, next to market, hyper and fast:
`chains.js` has the record (only a footprint tagged `shop=car` of that name
qualifies, so the service centre in Vysočany and every "Tesla" that is a
pharmacy or a bowling alley stay what they were), `build.js` builds the same
shell, and four things are its own.

- **The front is the wall with room behind it** (`pickShowFront`, pinned by
  `landmark.js pinStores` like every store's front). A grocer fronts its car
  park; here a car has to stand nose to the gate and be driven straight out,
  so each wall long enough for the gate's leaves is tried and the one with the
  biggest floor directly behind its gate wins. `arch.glassAll` glazes every
  wall that is not the back.
- **The door is a gate 5.2 m wide.** It is the ordinary sliding door of
  `shellfx.js`, and the ordinary doorway of `storeSolids` (a car's corner
  probes pass under a solid whose `bot` is over 0.5). `world.js` opens it for
  a car as well as for a walker.
- **A car stands on the floor.** `city.surfaceY` asks `stores.deck(x, z)`: a
  showroom's slab and the apron out of its gate, so the wheels are on the
  floor the mesh draws and roll down the same ramp a walker climbs.
- **The display cars are `parked` cars** (`showroom.js`), left open, with
  `car._show = { o, id, gone }`. Which car is on which stand is a function of
  the store's key and the slot; one that was driven away does not come back
  this session, and like a kerb car that fact stays on the client that took it.

**The theft rule** is `watchDisplay`, once a frame for the car the local player
drives: a display car that is not `owned` and is more than `LOT_PAD` (9 m) from
the footprint is charged once, `THEFT_HEAT` 46, which is two stars from a clean
record (`wanted.js STAR_AT[2]` is 45). Sitting in it, and rolling it out onto
the apron, cost nothing. Stars are local, so in co-op each player answers for
the car they took.

**Buying one** (Frank, 21 Nov 2026: "Ano, dej cenu"). A car still on the
premises is sold NEW with B, at `PRICE.showroom` (`prices.js showroomOffer`:
Model 3 289 000, Roadster 990 000), through the ordinary car panel and
`garage.buy`. The used-car ladder `PRICE.cars` is untouched, so a Roadster met
in the street is still not for sale. A bought car is `owned` and is never
charged; one driven off unpaid loses the showroom's price with its innocence.

## Cars: true shapes, paint with a history, a solid hull, the Roadster (Nov 2026)

**Shapes.** The Octavia (liftback and Combi) and the Model 3 were redrawn against the
real cars' numbers, and the fault was not in the details: the bodies were low and the
glasshouses tall (belt at 0.84 m under a 1.44 m roof), with the wheels pushed out to
the corners. `KIND.octavia`, `KIND.octaviaCombi` and `KIND.tesla` now carry the real
length, width, wheelbase and overhangs (the stations run past the axles by the real
overhang at each end, so a body is no longer centred on its wheels), a belt near a
metre and a high tail. The drawings of these kinds, and of the new `KIND.roadster`,
live in `js/cardress.js` (`STYLE_NEW`, `DRESS_NEW`); `js/cardetail.js` keeps the tools
and the older kinds and hands the tools over as an argument, so there is no import
cycle. `greenhouse()` learned `cPillar` and `sideMax` for an estate's third window.
The police livery and light bar in `traffic.js` are transcribed from the Octavia's
stations and were re-transcribed with it. `dev/carprofile.mjs` rasterises a kind
without a browser (side, front, rear, top, three-quarter) for checking proportions.

**Paint.** `js/carlook.js` (pure) decides a car's colour and its LOOK from a 32-bit
seed: finish (polished 30 %, used 51 %, worn 13 %, matte 6 % for ordinary cars, other
odds per class), dirt (clean, sills, film, caked) and the odd leaf. The look is one
byte, `car.look`: bits 0-1 finish, 2-3 dirt, 4-6 variant, 7 leaf; 0 is the polished
clean car every caller got before. Seeds: a traffic slot's own (`hash32(p.seed, 8)`
and `9`), a parking space's position (`seedAt`), so every client paints a car the
same. It travels in the top byte of the co-op `cl` field and in the garage save.
Drawing costs no draw and no program: per car the look is the body material's own
clearcoat, roughness and metalness plus `uLook` (the material is a bag of uniforms on
the one shared program, keyed `kind|hex|look`, swept when no car wears it); the
distance dress reads the per-instance `iLook` beside `iPaint`. Dirt and the leaf are
`js/cardirt.js`: value noise in the car's own frame (film from the sills up, spray on
the tail, rain runs, dust on what faces the sky) and a lens-shaped leaf laid in plan.
The plate atlas no longer depends on the colour (six per kind).

**A solid hull.** `js/carhull.js` (pure): a car is a rounded oriented rectangle.
`city.js collide()` used two discs, which do not meet in the middle of a car (a
walker went through the front seats, and through metres of a bus). Everyone on foot
now gets the exact hull; a driven car's own wall probes keep the discs, because car
against car is `carCarPass`, which got more discs for long vehicles (`discOffsets`).
Boarding plans a way round the body to the door (`planRound`, the shorter end, 0.5 m
clear) and the car stays solid during the walk; the crowd steps round a standing car
(`pedestrians.js _skirt`).

**The Roadster.** `KIND.roadster` (not in `CAR_KINDS`): 0 to 100 km/h in 1.00 s.
`thrust` is the share of the push that comes from the cold-gas nozzles and therefore
neither spends the friction circles nor tips the car back (`tyreStep`: `axT`), `cgH`
its low centre of gravity, `brakeK` its brakes. With the pedal down and the wheel hard
over it grips like the other cars (tests/carshapes.test.mjs). Its voice is a third
class beside piston and rolling: `enginekinds.js THRUST_KINDS`, `js/thrustdrive.js`
(motor revs, signed load, valve, tank) and `public/worklets/thrusterdsp.js`. It is met
as one town car in 450, in one kerb stall in 500 (left open), and in the dev spawner.

Measured on the M1 Pro, medium, 1024 x 768, noon, before and after in the same hour:
Pardubice, třída Míru 7.0 and 7.0 ms a frame before, 6.8 and 7.9 after; by the castle
7.9 before, 6.7 and 6.5 after; Prague, Václavské náměstí 5.4 and 5.6 before, 5.7 and
6.9 after; a Prague street 6.9 and 6.6 before, 7.5 and 6.8 after. The differences are
inside the noise of a machine other sessions were using.

## Solid trees, and a ghost's door in co-op (21 Nov 2026)

**A tree trunk is solid** (`js/treesolid.js`). The trunks are not a new data set: they
are read off the tree batch every chunk already draws (`js/meshes.js`, one
InstancedMesh whose matrix is the crown and whose colour carries the species). The
foot is the crown's centre taken `groundOf(species)` crown radii down the crown's own
axis, the girth is the species' `tau` share of the crown radius (0.13 to 0.7 m, a shrub
has none). So nothing new crosses the worker boundary, every client has the same
trunks, and a tree that is not drawn (trees switched off in the settings) is not there.
- `World._registerTrees(key, group)` hands the batch over when a chunk is finalised;
  the batch is only decoded the first time something asks near that chunk (a wood is
  thousands of trees and most chunks are never visited), into an 8 m grid per chunk.
- `world.collide()` pushes out of trunks for whoever passes `opts` (on foot, a body
  thrown from a car, a helicopter's skids), on their own level (`js/levelsep.js`). A
  call without `opts` (a spawn point nudged clear of walls) does not see trees: where a
  car is parked must not depend on which chunks happen to be loaded.
- A driven car's four corner probes are left out, as they are for the exact car hulls:
  a 30 cm trunk went between them, through the bonnet. `vehicles.js wallPass` asks
  `world.trunksNear()` and pushes each trunk out of the car's own plan
  (`js/carhull.js hullPushOut`); what would move the trunk moves the car the other way,
  as one more contact in the wall sums. So a tree is a wall: the impulse, the dent, the
  damage, the debris and the ejection through the windscreen are the wall's own. It
  chips no facade.
- Scheduled traffic does not ask (it drives its lanes, and the mesher keeps trees out
  of carriageways). The crowd does not ask either (it walks a shared timetable).
- Cost, measured in the game on the M1 Pro (Pardubice station square, 84 chunks
  registered, 14 of them ever decoded, 260 trunks): a trunk query is 0.14 to 0.21
  microseconds; a walker's whole `world.collide()` went from 7.03 to 7.33 microseconds
  a call. A frame makes a handful of those calls, so nothing a frame time can show.

**A ghost's door opens in co-op.** A traffic car leaves the shared schedule and drives
on as a local ghost when its generation rolls over in view, and also when it falls
`LAG_MAX` behind, which is what standing in front of it for about eleven seconds does.
With a session up such a car was left out of `nearestEnterableCar`: E did nothing, with
no hint, on exactly the car the player had just stopped ("nemůžu otevřít jezdící
teslu", every kind in fact). Now:
- `traffic.stealRef(car)` names any schedule car, ghost or not, as `{ key, gen, ghost }`:
  the slot it was born in and its generation (a ghost's own key is `slot#g<gen>`).
- `traffic.steal(car)` of a ghost also burns the same generation's re-minted slot, so
  the schedule never grows a second body of the car taken.
- The wire: `steal { key, gen }` for a scheduled car (an older client reads the key as
  before), `steal_g { key, gen }` for a ghost (an older client ignores it, which is
  right: the bare slot string may name the next generation's car there).
- `traffic.claimSlot(key, gen)` on the peer drops his scheduled copy of that
  generation and his own ghost of it, and leaves a slot that holds another generation
  alone. Ghosts stay out of the crash list and the run-over list, as before.

## Horns in space, the limit on the HUD, the law at a red light, no walking on the rails (Nov 2026)

Frank, 21 Nov 2026: horns around him sounded close, all at one level and from one side;
the HUD should show the speed limit and the car's model; police within 50 m give one star
for driving more than 50 % over the limit or through a red; and nobody may walk across the
tracks at Pardubice hl. n., or anywhere.

**Positioned one-shots** (`js/spatialsfx.js`, pure math plus one small pool). `audio.js
horn(x, z)` and every `sfxAt(...)` (traffic going past, sirens, crashes, screams, birds) now
play through eight prebuilt voices: gain (1/r, a horn's close radius 5 m, the rest 10 m),
a lowpass swept in log frequency with distance and a little darker behind you, a stereo
panner from the bearing to the ears, and a send into the shared street reverb that grows
with distance. A sound starts `d / 343` s late. `setListener` (main.js, every step: the car
you drive or your feet, the camera's bearing) re-aims every sounding voice, so a horn swings
round as you turn. When all eight sound, the quietest at the ear is stolen by anything
louder; otherwise the new sound is dropped. `sfxAt` took a seventh parameter, `rate` (the
ambulance's slower wail goes through it now). Your own horn (`horn()` with no position,
`caraudio.carHorn`) stays in the middle of your head.

**The limit and the model** (`js/roadlaw.js`, `js/lawhud.js`). The limit is the `speed` of
the traffic edge under the wheels, exactly what the AI drivers obey (posted maxspeed from
the tile, else the class default of `traffic.js defaultV`), found through
`traffic.edgesNear` as the nearest carriageway you are inside, preferring the edge pointing
your way (the two directions of a street are two edges; the crossing street at a junction
points across you). A new limit has to last 0.25 s before the sign changes; off every road
the sign lasts 3 s. `#limit-sign` is a Czech B 20a disc left of the number in `#speedo`
(`.over` above the limit, `.way` more than 50 % above it), `#car-model` the model under
`#fuel` (`vehicles.carLabel`). Only while you drive.

**One star in front of the police.** "Víc než 50 %" is read as more than 50 % OVER the limit
(over 75 in a 50). Held for 0.6 s with a patrol car, a pursuit unit or an officer on foot
within 50 m: `wanted.add` of `rychlost`. A red light: the approach you drive is WATCHED from
before its hold point (`traffic.js sigStop`, the point the AI stops at, a couple of metres
short of the paint); 3 m past it at over 2 m/s while `traffic.lightOf(e)` is 2 (the AI's own
phase on the shared clock), with police within 50 m: `cervena`. A traffic offence tops the
heat up to 30, inside the first star (18 to 45), never past it, so it is one star however
often, kept fresh, and nobody shoots below three (`policetune.js`). An 8 s cooldown per
offence. Local state like the rest of the wanted level.

**No walking on the rails** (`js/railbarrier.js`, called from `city.js collide()` for
walkers, `opts.interior`: the player and anybody else moved that way, the thrown-out
driver of a jacked car). Every heavy-rail way at grade (not a tram, a bridge or a tunnel)
is a strip 2.25 m either side of its centreline, the foot of the ballast bed the mesher
draws; a walker is pushed back out of it like out of a wall. That is also where a platform
visibly ends: the bed is drawn over the mapped platform polygon, which at Pardubice reaches
to 1.5 m of the rail, so the polygon gives no exception. Open: where any way (road, service
road, footway, path) meets the track at grade, inside that way's width plus half a metre
(the gates are indexed per chunk cell from its own rails and roads, endpoints included,
because OSM draws a crossing as a shared node); anywhere more than `LEVEL_GAP` above or
below the rail top (the station underpasses, the footbridge, road underpasses and bridges);
the station's own rooms, stairs and deck ramps (`stationPassages.floor`); and the story
coach's door step (`world.storyCoach.boarding`, prologue.js). The campaign's yard boxes
(`prologue-tracks.js`) stay as they were. Pedestrians walk mapped footways, which cross the
rails only where the map has a crossing. Pure in tile data and position, so co-op screens
agree without a word.

## Every train is the train from Kolín (21 Nov 2026)

Frank: "vlaky, aby všechny vlaky byly tak, jako je to, když nastupuje jako z Kolína ...
úplně jako takhle stejný model toho vlaku, nastoupit, sednout si tam a tak dále. A musí
opravdu ten vlak přijet, potom se odjet fyzicky."

* **One coach, two users.** `js/prologue-coach.js` is cut into parts (`coach`, `running`,
  `gangway`, `cab`, `doorLeaf`, `lettering`, `riders`); the campaign's `trainBody` calls
  them with the numbers it always had (a recording kit shows the same 2267 boxes, signs
  and seats before and after). `js/railcoach.js` gathers the same calls into three merged
  geometries (solid with the kit's grain shader on merged attributes, glass, glow) shared
  by every coach of every train: three draws a coach, plus four door leaves, the signs and
  a box that throws the shadow. Beyond 150 to 185 m a coach is its far model (a dozen
  boxes in the same colours). `coach(k, { doors: 2 })` gives the open world's coach a real
  door on BOTH flanks (a platform can be on either side); the campaign keeps its one.
* **A train** (`js/trains.js`) is a row of that coach, a cab at each end, no locomotive:
  three for the random trains, five for the express. Each coach still rides on its own
  two bogies, so the set bends. It stops with its MIDDLE at the station (`stopS`), its
  doors open (`t.closed` 1 shut to 0 open, the campaign's rates), start to close
  `DOOR_LEAD` before the dwell ends, and it does not move until they are shut. At the end
  of a line (no station) they stay shut.
* **The deck** (`js/traindeck.js`, pure): every coach has a frame `{ x, z, c, s, y, first,
  last }` written by `_place`; floor, door steps, walls, seats and cab walls are the
  campaign's own (`js/prologue-deck.js` `stepY`, `coachWalls`, `endWall`), asked per coach,
  with the slots of two coaches overlapping by 0.35 m so a bend opens no gap in the
  gangway. `trains.deck` is `world.rideDeck`, consulted beside `world.storyCoach` in
  `city.js supportY/collide` and in `railbarrier.js allowed()` (inside a coach, and at an
  open door out to 3.4 m, a walker may be in the track strip). A train on the move is no
  wall and no floor to anyone outside it.
* **Riding** (`js/trainride.js`, methods of Trains): he rides from the step he takes into
  a coach of a standing train with its doors open to the step he takes out of one. The
  train carries him by keeping his place in his coach's frame: read before the trains
  move, written after. For that `trains.update` now runs BEFORE the walker's update in
  main.js (it came after the crowd, and his body trailed the coach by a frame). E aboard
  is the seat (`prologue-seat.js`, the campaign's movement), never a teleport; `board()`
  and `alight()` remain for tests and scripts. `trains.locked` (the campaign is playing)
  turns the deck and boarding off: its own train is the only one. The camera is `enclosed`
  aboard, as in the campaign's coach.
* **The express arrives** (`js/express.js`): it is put on the line 420 m east of Pardubice
  hl. n. 48 to 30 s before its minute, runs in, stands with its doors open until the
  departure (`t.dwellFor`), and leaves. Its ticket is charged as the rider steps in
  (`onBoard`); without the money he rides without one. A skip (N) keeps him in his coach.
* **People** (`js/trainpeople.js`): the campaign's four seated passengers a coach, in ONE
  train at a time (the ridden one, else the nearest within 95 m), seated one a frame.
* Not done: the conductor walking the aisle, a timetable for the random trains, trains
  seen the same by two co-op players (they are local state, as before), a walker hit by
  a moving train. `js/trains.js` is still 1080 lines (it was 1279).
* Tests: `tests/trainride.test.mjs`, `tests/express.test.mjs`.

## Riding along in a car another player drives (21 Nov 2026)

In co-op a peer's car is a proxy this client only draws (`js/netvehicles.js`): not in
`vehicles.cars`, not in traffic, not in the crash list. It still is none of those. What it
gained is passenger seats.

- **The boardable face.** A ghost of a car somebody DRIVES (seat 0, not bound) carries
  `r.veh`, an object shaped like a vehicle (`proxy: true`, `uid`, `kind`, `x z y heading
  speed len wid mesh seats`, `gone`, `quiet`), kept on the drawn pose every frame.
  `ghosts.proxies()` lists them, `nearestEnterableCar()` in `js/main.js` adds them under the
  traffic rule (under 3 m/s), and the E handler sends a proxy to `boardPeerCar()`: the same
  `player.boardVehicle()` walk round the body, door and seat as any car, for seats from 1
  up. The wheel is never offered. `gone` is raised when the driver steps out, leaves, turns
  passenger or is suddenly in a different kind of car.
- **Who sits where** (`js/netride.js` `makeSeatBook`). `veh.seats` is local, so the seat is
  announced: event `seat_claim { ho: driver's uid, s, on }` for the walk-up, and the state
  packet's `veh.ho` + `veh.st` once seated. Advisory, like the helicopter's claim: two who
  press E inside one round trip both start walking, the lower uid keeps the seat, the other
  is walked away with "Místo zabral …". Somebody seated beats somebody walking. Seats per
  kind are `seatsOf()` (4, a roadster, van and lorry 2, a bus 8).
- **Seating a remote passenger by name.** A passenger's descriptor carries `ho`, and
  `sync()` binds him to that driver's ghost (or to our own car when `ho` is `ghosts.selfUid`)
  with no distance test. Guessing by distance only worked standing still: at 90 km/h the
  position he reports is a third of a second old and outside `BIND_R`, which built him a
  second car trailing the first. A sender without `ho` (an older client) is guessed as before.
- **What the passenger's eye rides on.** The camera is rigid to `player.pos`, which mirrors
  the proxy. A proxy with somebody local in it (or walking up to it) is chased with a
  critically damped spring (`follow()`, `RIDE_W`) instead of the fixed-rate ease, so a packet
  that lands early or late bends the velocity and never steps it. `sync(uid, v, age)` also
  takes how long the packet waited for its frame, which removes a frame's worth of sawtooth
  from every ghost's target.
- **Rides that end without E** (`makeRides().update`, once a frame after `ghosts.update`):
  the car is gone (`'gone'`: the body is stood up beside where the seat was, on `supportY`),
  it pulled away during the walk-up (`'left'`, over 4.5 m/s), or the seat was somebody
  else's (`'rival'`). The same update tells the room when our seat is taken and given back,
  whichever way the ride ended, and puts `player.pos` on this frame's pose. A driver whose
  packets stop is standing still; the passenger is told after 6 s and stays seated until he
  presses E or the fleet reaps the ghost (35 s).
- **Peers in the glass** (`js/netcrew.js`). A car is opaque and the people behind its
  windows are pictures the body shader paints (`js/carglass.js`), of whoever the car was
  told about. Nobody told it about a peer: a friend in your passenger seat was a name tag
  over an empty seat, and a peer's proxy showed a stock civilian at the wheel. Once a frame
  `pumpGhosts` asks `ghosts.hostOf(uid)` which car each peer sits in and `netCrew.show()`
  calls `setDriver` / `setPassenger` on a change, and takes them out again when they leave.
- Known limits: the glass has pictures for the FRONT seats only, so somebody in a back seat
  (or in a bus) is not drawn from outside; their name tag rides the car. When the driver
  steps out, the proxy disappears on the passenger's screen (as it always did for
  onlookers), so the passenger is put down too. The driver does not see the passenger's
  door open. Older clients ignore `seat_claim` and `ho`.

## One street for two players: the room (21 Nov 2026)

Frank: "hraci v multiplayeru nevidi stejne auta stejny provoz atd.... proste kazdy hrac
musi videt to stejne co ten druhy/jiny". The traffic SCHEDULE was shared already; what
each client DREW was not. Measured with two clients on one corner of Palackého, back to
back (`node dev/coopbench.mjs`, and once in the game with two tabs and `dev/coopprobe.js`):
22 % of the cars around them stood in the same place on both screens. Three causes, all
in `js/traffic.js`, none of them the schedule:

- **The camera decided.** A mesh arrives, and a finished car drives on as a ghost, only
  where the LOCAL camera cannot see the change (v9). Two players facing opposite ways
  therefore attached and kept different cars. While `traffic.watchers` (the peers within
  `ROOM_R` = 1200 m, `js/roomview.js peersNear`, set by `main.js` every frame) is not
  empty, "watched" has no direction: inside the fog wall of any player. A mesh is refused
  near anybody only to a car that was BORN near somebody (`_bornWatched`, from a `Trail`
  of where each player stood), so a player who drives up later is handed every car his
  friend already has. The far attach band is used all round.
- **A ghost was nobody's but this screen's.** It drove off free of the schedule, by a
  route chosen to leave THIS camera's view. In a room a ghost made by the end of a trip
  or a generation keeps its schedule: every trip that ends by length ROLLS (`_rolls`, no
  stop at the end), the hashed walk is laid `OT_LEG` further from the schedule's own end
  (`p.ot`, overtime), and the body follows it under the usual lag clamp. A ghost made by a
  blockage or one that falls `LAG_MAX` behind is still local (`p.ot = 0`), on the hashed
  walk as well.
- **The graph depended on the order the tiles arrived.** A way was cut into edges at the
  junctions known when it arrived, so a way of a later tile joining it mid-polyline found
  no node: 68 of 25 000 edges differed between two arrival orders of the four tiles whose
  common corner is the centre of Pardubice, and two clients fetch those in parallel.
  `_resplit` takes such an earlier way out (`releaseSteps`) and cuts it again with the
  batch; `_recut` does the reverse when a tile leaves. Schedules routed over a re-cut way
  are dropped and minted again by the next scan. This one applies in single player too.

Ghosts are walls again in a session (`main.js isGhostCar`): they are on both screens now,
and in a room about half the cars near the players are ghosts.

Parked cars: `ROOM_PARK_TOD`. Car parks and kerbs fill by the hour and never change where
the player could watch, so a street held whatever the hour was when THAT player arrived;
in a session they all fill as at 19:00, for everybody.

After (same bench, 5 min, share of cars within 2 m on both screens): side by side 1.00,
back to back 1.00 (was 0.22), one of them blocking the junction 0.93 (0.17), 30 against
60 fps 0.97, 150 m apart 0.65 (0.37), driving in convoy 0.87, a player driving up to the
other 0.14 in the first minute and 0.92 from the fourth. In the game, back to back: 0.79
(0.22), 3 % of the cars on one screen only. What is left is LAG, which is history: a
client that met a car later holds it nearer its schedule than one whose copy has queued,
and a ghost exists only where somebody had its car when the trip ended. The remedy for
both is a small snapshot over the wire (slot key and arc of the cars near each player,
the hooks `p.key` and `p.sR` the v8 header names), which is not built. Not touched and
still decided by each camera: pedestrians (0.67 in the same game test) and cyclists
(0.78), `_hidden()` in `js/pedestrians.js` and `js/cyclists.js`. Buses start a trip at
whichever stop is in reach and agree from the first stop both clients share. Random
trains, pursuits and the ambient ambulance are local.

Fleet: a room holds about 45 % more cars than one camera (84 against 58 at noon), the
ghosts all round instead of in the cone.

## A ticket for every train, bought on the phone (22 Nov 2026)

Frank: "na každej vlak si musím koupit lístek ... vytáhnu mobil a tam si to koupím."

* **The rule** (`js/tickets.js`, pure). A ticket is a single ride on one train, however
  far, bought at any time and kept in the phone until used. Two kinds: `os` (any ordinary
  train, `PRICE.train.local`) and `r` (the express, `PRICE.train.ticket`, also taken on an
  ordinary train when nothing cheaper is held). Nobody is stopped at the door. Once the
  train has run for `CHECK_AFTER` seconds (or as it stops at the next station, whichever
  is first: N skips) the conductor checks: a ticket in the phone is marked and is good on
  that train until the player leaves it, and for getting back on the same train
  (`validOn`). Without one the fare and `PRICE.train.fine` are paid on the spot; without
  the money for both, the player is put off at the next station with a platform
  (`trains.alight()`), and nothing is taken.
* **Wiring** (`js/main.js`): `Trains` `onBoard` and `onAlight` call `tickets.board(t)` and
  `tickets.alight()`, the frame calls `tickets.update(dt, trains.riding, () =>
  trains.alight())` right after the trains moved, `tickets.say` goes to the toasts
  (`sayText`), and the two train hints end in `tickets.hintNear(t)` / `hintAboard()`. The
  express no longer charges at its door.
* **The phone** (`js/phone.js`, key L, listed in `#controls-hint`) is a panel
  (`js/panel.js`: Escape, a click outside, one at a time, never keeps the mouse) in the
  frame of the campaign's `.journey-phone`, rising from the bottom right; the game runs
  on under it. A screen is `{ title, build(body), refresh(), key(digit) }`; the only one
  is the tickets (`js/phone-tickets.js`): `ticketScreen()` is its content as plain data
  (where he is, the trains standing or due there, the two tickets, what he holds, what
  the conductor will make of him), `ticketApp()` draws it and refreshes it every 400 ms.
  1 and 2 buy. L is refused while a campaign part runs (it has its own phone).
  `trains.stationNear(x, z, r)` (in `js/trainride.js`) is the nearest station.
* **The save.** Unused tickets are `tickets: { os, r }` in the save (`js/savegame.js`
  `blank` and `sanitize`, no version step: an older save reads as none), written by
  `career.snapshot()` beside the money and read back with it in `apply()` and
  `reloadLast()`. The ride being ridden is not saved.
* Harness: `__atc.tickets`, `__atc.phone`, `__atc.ticketScreen`. Tests:
  `tests/tickets.test.mjs`.
