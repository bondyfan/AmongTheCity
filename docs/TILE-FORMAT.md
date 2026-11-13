# Tile format

What `scripts/build-region.mjs` writes into `public/data`, and what the game may rely on.
This file is the contract between the data pipeline and every module that reads a tile.
The code tables it mentions live in `js/tiledata.js`, which the builder and the game both import.

Three rules hold for everything below.

1. **Every field added since the first tile is optional.** A consumer must work on a tile that
   lacks it (`tests/tiledata.test.mjs` feeds the runtime such a tile). Missing means "OSM does not
   say", never "no".
2. **Code tables are append only.** An index written into a tile keeps its meaning for ever.
3. **Coordinates are game metres**, x east and z SOUTH of Pardubice hlavní nádraží, rounded to
   0.1 m. Angles from OSM stay compass degrees (0 north, 90 east).

## Files

| File | What |
| --- | --- |
| `data/manifest.json` | `{ origin, mPerLat, mPerLon, tile: 4800, routes?, tiles: [...] }` |
| `data/tiles/<tx>_<tz>.json` | one 4.8 km tile: every layer below |
| `data/routes/<tx>_<tz>.json` | the public transport routes OWNED by that tile (round 5) |
| `data/overview.json` | the whole world at map fidelity, for the world map |

A manifest tile entry is `{ tx, tz, f, n, wb?, rt? }`: `f` the tile URL, `n` its feature count,
`wb` the bounds of its water, `rt` the route files to load there (see Routes).

A feature lives in exactly ONE tile: the one holding its first stored vertex.

## Tile layers (unchanged by round 5 unless marked NEW)

| Layer | Record |
| --- | --- |
| `buildings` | `{ o, i?, h, lv?, c?, t, n?, u?, r?, y? }` plus the NEW roof fields below |
| `roads` | `{ p, t, w, v, d, s?, ow?, rb?, br?, ln?, lf?, lb?, tf?, tb?, n?, tw?, l?, ref? }` plus NEW `pk` |
| `rails` | `{ p, t: 'rail' or 'tram', br? }` |
| `water`, `green`, `paved`, `zones` | `{ o, i?, t, s?, sp? }` |
| `waterways` | `{ p, w }` |
| `trees` | `[x, z]`, NEW: optionally longer |
| `pois` | `{ p, t, n? }` (stations, bus stops, fuel, hospital, police, fire station, aerodrome) |
| `venues` | `{ p, t, n, b? }` |
| `signals`, `crossings` | `[x, z]` (a crossing with a refuge island is `[x, z, 1]`) |
| `signs`, `calming` | `{ p, k }` |
| `power` | `{ p, m?, v? }` |
| `furniture` | `{ p, k, a? }` |
| `barriers` | `{ p, k, h?, se? }` |

`o` is an outer ring without its closing point, `i` a list of hole rings, `p` a polyline (or a
single point for point layers). The runtime (`js/geo.js indexPayload`) wraps a tree as
`{ p: [record], _id }`, so the tile record is `tree.p[0]` there.

## NEW: trees say what they are

```
[x, z]                                  nothing known (most trees, and every old tile)
[x, z, taxon, height, crown, girth]     trailing unknowns cut off, an unknown in the middle is 0
```

| Index | Meaning |
| --- | --- |
| 2 `taxon` | index into `TREE_TAXA` of `js/tiledata.js`. 0 unknown, 1 some broadleaved tree, 2 some conifer, 3 and up a genus (3 tilia, 4 acer, 5 aesculus, 6 platanus, 7 populus, 8 betula, 9 picea, 10 pinus, 11 prunus, 12 malus, 13 pyrus, 14 quercus, ...) |
| 3 `height` | metres, from `height` |
| 4 `crown` | crown DIAMETER in metres, from `diameter_crown` |
| 5 `girth` | trunk circumference in metres, from `circumference` |

Every `TREE_TAXA` entry is `{ id, cs, sp, leaf, ever }`: the Latin genus, a Czech name for UI,
the species CLASS to draw (an index into `SPECIES` of `js/treeshapes.js`, or -1 for the two
generic entries, where the consumer picks by hash among classes of that leaf type), `leaf`
`'b'` or `'n'`, and `ever` 1 for evergreen. Read with `treeTaxon(p)`, `treeClass(p)`,
`treeHeight(p)`, `treeCrown(p)`, `treeGirth(p)`; they all accept the bare `[x, z]`.

A `tree_row` way is sampled every 7 m as before and every sample carries the row's tags.
Source keys, in order: `genus`, `taxon`, `species`, then each with `:cs` and `:en`, and
`leaf_type` as the fallback. Latin, Czech and English spellings are all understood (over the
whole world nine tagged trees stay unread: a palm, an elder, a hickory). `leaf_cycle` is not
stored: `ever` comes from the genus, which is right for everything that grows here (the larch
is the one deciduous conifer and says so).

Coverage (July 2026 extract): 88 816 of 194 422 trees in the world carry a taxon, 5 125 of them
a genus. In the nine tiles round Pardubice: 3 652 trees, 2 562 with a taxon (2 087 only
"broadleaved", 65 only "needleleaved", 410 a genus: tilia 174, malus 86, betula 80, quercus 21,
acer 15, ...), 535 with a height, 21 with a girth, none with a crown diameter.

## NEW: on-street parking

```
road.pk = [left, right]
```

One code per side, LEFT and RIGHT of the direction `road.p` runs in. Mind the axes: z points
SOUTH, so for a segment running `(ex, ez)` the RIGHT side is the normal `(-ez, ex)` and the left
is `(ez, -ex)` (heading east, right is south). The builder has already
swapped the sides of a `oneway=-1` way, whose points it stores reversed. The runtime's
`smoothBends` adds points but never turns a road round, so the sides stay valid. No `pk`: OSM
says nothing about either side, so keep the procedural behaviour.

| Code | Meaning |
| --- | --- |
| 0 | nothing mapped for this side |
| 1 | no parking (`parking:side=no`, no sign named) |
| 2 | no parking sign (zákaz stání) |
| 3 | no stopping sign (zákaz zastavení) |
| 4 | parked in a separately mapped area (already in `paved` as `parking`): do not add a kerb row |
| 8 to 31 | allowed. `orientation = (code - 8) & 3` (0 unknown, 1 parallel, 2 diagonal, 3 perpendicular); `position = (code - 8) >> 2` (0 unknown, 1 lane on the carriageway, 2 street_side bay, 3 half_on_kerb, 4 on_kerb, 5 shoulder) |

Helpers: `parkSide(road, side)`, `parkAllowed`, `parkForbidden`, `parkOrient`, `parkPosition`.
Both OSM schemas are read (`parking:left|right|both[:orientation|:restriction]` and the older
`parking:lane:*`); a side-specific key beats `both`, the new schema beats the old. An
orientation with no position key (`parking:both:orientation=parallel` alone) reads as allowed,
position unknown.

Coverage: 4 183 roads in the world, almost all in Prague (tile -20,-2 alone has 708) and
Olomouc. **Round Pardubice it is next to nothing: 6 of 9 831 drivable roads in nine tiles**
(Lonkova and one service road). A consumer must keep its procedural kerb parking as the default
and treat `pk` as an override where present.

## NEW: roofs and walls

On a building, all optional:

| Field | Meaning |
| --- | --- |
| `rc` | `roof:colour` as `'#rrggbb'`. An explicit hex is kept; a colour NAME becomes the tone of the material it describes (`red` is fired clay `#a8523a`, `gray` weathered tile `#858583`), not the CSS primary |
| `rp` | the roof colour read off the ČÚZK aerial photo, `'#rrggbb'` |
| `rm` | `roof:material`, index into `ROOF_MATERIALS` (1 roof_tiles, 2 metal, 3 concrete, 4 tar_paper, 5 glass, 6 grass, 7 copper, 8 slate, ...) |
| `bm` | `building:material`, index into `WALL_MATERIALS` (1 plaster, 2 brick, 3 concrete, 4 glass, 5 wood, 6 stone, 7 metal, 8 plastic) |
| `rl` | `roof:levels` (0 is an answer: no storey under the roof) |
| `rh` | `roof:height` in metres |
| `rd` | `roof:direction`, compass degrees the main slope faces |
| `ro` | `roof:orientation`: 1 ridge along the longest side, 2 across it |

Preference for the colour: `rc`, then `rp`, then procedural. `roofColour(b)` does exactly that.
The existing `r` (roof shape) and `c` (wall colour) are untouched.

`rp` exists for every building under a photograph on disk (`data/raw-ortho`, 2 m per pixel):
tiles 0,-1 and -1,-1 (Pardubice NORTH of the railway: the centre, Polabiny, Dubina) and -10,-1
to -10,-5 and -11,-1, 27 791 buildings. There is no photograph on disk for tiles 0,0 and -1,0,
so the 15 000 buildings south of the main station (Dukla, Višňovka, Svítkov) have no `rp` and
fall back to the tag or the procedural colour. It is the
per-channel median of the pixels at least 1.5 m inside the footprint, after dropping pixels
that are leaf green, the darkest 30 % (the shaded pitch) and the brightest 5 %. A roof whose
answer is STILL leaf green is under a crown the photograph could not see through and gets no
`rp` at all (about 500 buildings, nearly all sheds and garages under 80 m²). It is the colour
AS PHOTOGRAPHED: sunlit and hazy, so paler and less saturated than the material (old-town clay
tile reads about `#b28b76`). Use it for hue and for telling red from grey, and restore
saturation in the shader if you want it. Checked: the photo is not mirrored and not offset
(road centrelines of tile 0,-1 land on asphalt grey for 53 % of 24 490 samples as georeferenced,
10 to 14 % when mirrored either way, and the best shift is under 1 m); of 223 blocks of seven
storeys and more 196 read grey; and where both a tag and the photo exist they agree on "reddish
or not" for 219 of 252 roofs. In the old town some of the tagged clay roofs still read as
dark grey-brown (a steep pitch in its own shade), which is why the tag comes first.

## NEW: public transport routes

Routes are NOT in the tiles. A line is ten kilometres long and must exist once, so:

* each route is written into ONE file, `data/routes/<tx>_<tz>.json`, named after the tile of its
  first stop that stands inside the world;
* each manifest tile entry lists in `rt` the keys (`"tx_tz"`) of every route file holding a
  route whose path or stops touch that tile, and the manifest has `routes: "data/routes/"`;
* at runtime `city.routeFilesNear(x, z, reach = 4800)` (js/geo.js) returns the URLs to fetch
  for the tiles within `reach`. Fetch them once, keep the routes whose `bb` is near
  (`routeNear(route, x, z, r)`), ignore the rest. Call it about once a second, not per frame.

The whole world is 1 168 routes (998 bus, 77 trolleybus, 93 tram) in 145 files, 6.0 MB, the
largest file 416 kB; 224 of 342 tiles have an `rt`. The spawn tile lists 13 files, 242 kB
together (the city lines plus the regional ones passing through).

### The route file

```
{ v: 1, tx, tz,
  stops:  [ [name, kind, x, z] | [name, 3, x, z, px, pz], ... ],
  legs:   [ [flags, x0, z0, dx1, dz1, dx2, dz2, ...], ... ],
  routes: [ { id, m, ref?, n?, fr?, to?, c?, nw?, op?, ms?, s, sf?, sd, p, L, bb, g?, pa? }, ... ] }
```

**stops** is a table shared by the routes of the file. `kind` is a bit set: 1 = `x, z` is a
stop position ON the carriageway (PTv2 role `stop`), 2 = a platform or pole beside the road is
known (role `platform`, or a legacy `highway=bus_stop`). With kind 2 alone `x, z` IS the
platform; with kind 3 the platform follows as `px, pz`. In Pardubice nearly every stop is kind 2:
the pole on the pavement, 4 to 10 m off the centreline (median 7 m), on the right of the
direction of travel for 1 076 of 1 085 calls. So a vehicle halts at arc `sd`, not at `x, z`.

**legs** is one entry per OSM way a route of this file runs along, shared by every route using
it. Integers in DECIMETRES, the first point absolute, each later point a delta. `flags`:
1 tunnel, 2 bridge, 4 rail (a tram track), 8 not in the tile `roads` layer (a tunnel, an area,
a class the road layer does not keep). For a leg without flag 8 the decoded points are exactly
the stored points of one `roads` feature (same rounding, same 0.5 m simplification): 99.3 % of
the legs round Pardubice equal a tile road point for point (forwards or backwards). The rest are
roundabout arcs, which are a slice of a ring road. Match legs to the road graph by coordinates.

**routes**

| Field | Meaning |
| --- | --- |
| `id` | OSM relation id. Stable: seed hashes and timetables from it |
| `m` | 0 bus, 1 trolleybus, 2 tram (`ROUTE_MODES`) |
| `ref`, `n`, `fr`, `to` | line number, full name, first and last stop as tagged |
| `c` | line colour `'#rrggbb'` when OSM has one (Prague yes, Pardubice no) |
| `nw`, `op` | network and operator (`"MHD Pardubice"`, `"Dopravní podnik města Pardubic"`) |
| `ms` | route_master relation id: the two directions and the short workings of one line share it |
| `s` | the calls in order: indices into `stops` |
| `sf` | per call, only when any is set: 1 boarding only, 2 alighting only, 4 on demand, 8 the mapped path never comes within 60 m of this stop, so its `sd` is interpolated between its neighbours |
| `sd` | per call: metres along the decoded path to the point abreast of the stop |
| `p` | the path: signed leg references. `+k` is `legs[k-1]` as stored, `-k` the same leg backwards, `0` a GAP |
| `L` | length of the decoded path in metres |
| `bb` | `[x0, z0, x1, z1]` around path and stops |
| `g` | number of gaps, when not zero |
| `pa` | 1 when members lie outside the world (the line runs on beyond it) |

One direction is one route: line 5 is two routes with the same `ms`. Do not assume a pair:
OSM has Pardubice buses 15, 24 and 25 in ONE direction only (towards Hlavní nádraží or Dubina),
8, 88, 20 and 902 are circles (first stop = last stop), and 6 and 14 have four variants each.

Decode with `routePath(file, route)` → `{ pts, cuts, flags }` (`pts` a flat `[x, z, ...]` in
metres in the direction of travel, `cuts` the point indices where a new piece starts after a
gap, `flags` per point the leg flags of the segment leaving it) and `routeStops(file, route)` →
`[{ n, k, x, z, px, pz, f, d }]`. `sd`, `L` and `d` measure along `pts` taken as ONE polyline,
a gap counting as the straight jump across it.

A gap means a member way is missing, lies outside the world or does not connect to the one
before it. Members are never reordered: a relation mapped out of order comes out in many pieces
and says so in `g`. Pardubice (61 routes) and Hradec Králové have none; Prague has 32 over 773
routes; the Zlín regional network (37 routes, 530 gaps) is mapped unordered and is not fit to
drive along without the road graph.

### What Pardubice gets (network "MHD Pardubice", 61 routes, all complete)

Trolleybus: 1, 2, 3, 4, 5, 7, 11, 12, 13, 17, 27, 30, 33 (26 routes, 14 to 24 stops, 6.7 to 14.7 km).
Bus: 6, 8, 9, 10, 14, 15, 16, 18, 20, 22, 23, 24, 25, 28, 29, 88, 90, 902, 906 (35 routes, 2 to
35 stops, 2.9 to 22.8 km). Examples: 3 Hlavní nádraží to Lázně Bohdaneč, 19 stops, 10.9 km;
5 Dukla to Dubina, 16 stops, 6.7 km; 13 Ohrazenice to Dubina, 19 stops, 8.7 km; 8 and 88 the
Dubina to Svítkov circle in each direction, 35 and 34 stops, 22.7 km. Three of the 1 085 calls
carry flag 8 (the mapped path misses the stop).

## Rebuilding

```
node scripts/split-extracts.mjs                 # data/raw-osm -> data/raw-region (2.2 GB) and _routes.json
node scripts/split-extracts.mjs --routes-only   # only data/raw-region/_routes.json, 40 s
node scripts/build-region.mjs                   # -> public/data, about 110 s
```

`RAW_DIR`, `OUT_DIR` and `ORTHO_DIR` redirect the three directories for a dry run.
`--tiles="0,-1 -1,-1"` rebuilds only those tiles; it still rewrites every route file and every
`rt`, and it leaves `overview.json` alone. Without `data/raw-ortho` no `rp` is written.
`_routes.json` is 25 MB and not in git: without it the builder leaves `data/routes` and every
`rt` exactly as they are on disk (the lines depend on the relations and the world grid, never
on a tile), and says so. Everything else in a tile is identical either way.
