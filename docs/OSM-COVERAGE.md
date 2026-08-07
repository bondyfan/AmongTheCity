# What OpenStreetMap offers that the game throws away

A measurement, not an opinion. Every number below was counted by walking the raw
`.osm.pbf` extracts with the repo's own reader (`scripts/lib/osmpbf.mjs`) and
applying the *verbatim* `wantNode` / `wantWay` / `wantRelation` predicates from
`scripts/split-extracts.mjs`, so "kept" here means exactly what the pipeline
means by it. **No code was changed to produce this document.**

---

## Method, and what the numbers mean

Two survey scripts, run from the repo root (they live in the scratchpad, not the
repo — they are throwaway):

1. one pass per extract over `data/raw-osm/*.osm.pbf`, keeping only nodes that
   pass `nodeWanted()` — the same dilated world mask the splitter uses — then
   resolving every way's refs against that index exactly as `splitExtract()`
   does (a way with one missing node is dropped whole, so it is not counted as
   present);
2. per tag key and per `key=value`, a six-way counter: node/way/relation ×
   element-kept/element-dropped.

Whole run: **7 extracts, ~50 s wall clock, ~1.4 GB peak RSS.** No osmium, no
network, no new dependency.

**Two columns, two scopes.**

* **Pardubický** — `data/raw-osm/pardubicky.osm.pbf` alone, restricted to the
  world mask. One extract, no overlap, exact.
* **World** — the six extracts `pardubicky + kralovehradecky + olomoucky +
  stredocesky + vysocina + zlinsky`, restricted to the world mask.
  `praha.osm.pbf` is **excluded from this column on purpose**: see the incidental
  finding at the bottom — Geofabrik's `stredocesky` extract already contains the
  whole of Prague, so including both double-counts the densest city in the world.
  Residual double-counting at the remaining kraj borders is small (measured at
  **0.005 %** of shop nodes once Prague is removed: 2 duplicates in 19 317).

**Two ways to lose a tag, and the table separates them.**

* **Stage 1 — `scripts/split-extracts.mjs`.** The element itself never reaches
  `data/raw-region/`. Nothing downstream can recover it.
* **Stage 2 — `scripts/build-region.mjs`.** The element survives (usually
  because it is *also* a building or a road), but the builder never reads that
  key, so the value never reaches `public/data/tiles/`. `build-region.mjs`
  touches **53 tag keys** in total; every other key on a surviving element dies
  here.

The `LOST` counts below are a **lower bound** for keys the builder does read:
`name` is counted lost only where its element was dropped, but a surviving
*polygon's* name is discarded too (see "Names" below).

**Ground truth check.** `McDonald's` (node/8… at 241 m from Pardubice hlavní
nádraží) appears **0 times** in `data/raw-region/0_0.json` and 0 times in
`public/data/tiles/0_0.json`. `addr:housenumber` appears **9 times** in
`data/raw-region/0_0.json` — against 169 495 of them in the Pardubický extract.
The loss is real, not an artefact of the counting.

---

## The table — tags the pipeline discards, most common first

Ordered by the World column. "Type" is where the tag predominantly sits.

| # | Tag | World | Pardubický | Type | Lost at | What it would add to a driving game |
|---:|---|---:|---:|---|---|---|
| 1 | `source=*` | 2 390 935 | 373 929 | way/node/rel | stage 2 | Nothing — provenance metadata, correctly ignored. Listed only so the rest of the table is read against a real ceiling. |
| 2 | `ref:ruian:building` | 1 487 571 | 220 118 | way (area) | stage 2 | The Czech cadastre id of every building; a stable join key to RÚIAN's own storey/use/year tables if you ever want real data instead of the two-storey guess. |
| 3 | `building:ruian:type` | 1 422 399 | 204 733 | way (area) | stage 2 | Cadastral building *use* (bytový dům, rodinný dům, garáž, průmyslový objekt) on 1.4 M footprints — far better coverage than OSM's own `building=*` for choosing façade, window rhythm and roof. |
| 4 | `addr:housenumber` | 1 219 327 | 169 495 (166 366 node) | **node** | **stage 1** | Every street number in the country, surveyed to the metre. House numbers on doors, a real address to name a mission target, and the raw material for door/entrance placement. |
| 5 | `addr:postcode` | 1 219 517 | 169 475 | node | stage 1 | PSČ per address point; a free postal-district partition for radio zones, delivery jobs, police response areas. |
| 6 | `ref:ruian:addr` | 1 200 707 | 167 470 | node | stage 1 | Cadastre address-point id — the join key that turns an address point into occupancy data. |
| 7 | `addr:conscriptionnumber` | 1 074 433 | 151 283 | node | stage 1 | The *číslo popisné* (the red plaque); Czech houses carry two numbers and this is the one on the wall. |
| 8 | `addr:place` | 1 044 391 | 153 344 | node | stage 1 | Village/quarter name for addresses that have no street — how most Czech villages are actually addressed. |
| 9 | `building:flats` | 892 366 | 127 169 | way (area) | stage 2 | Number of dwellings per building. A direct population proxy: lit-window count at night, pedestrian and traffic density by block, which panelák is a 60-flat tower and which is a duplex. |
| 10 | `addr:street` | 704 931 | 69 443 (67 137 node) | **node** | **stage 1** | Street name attached to a *point*, not a line — the only reliable way to name a building's address, and a cross-check on which side of the road a house belongs to. |
| 11 | `start_date` | 336 534 | 47 788 | way (area) | stage 2 | Construction year on 336 k buildings. Age drives everything visual: prewar plaster vs 1970s panel vs post-1995 satellite suburb. The single cheapest way to stop every street looking the same. |
| 12 | `power=*` (tower/pole nodes) | 288 448 (264 294 lost) | 52 754 | **node** | **stage 1** | 226 854 pylon and pole *nodes* dropped. The splitter keeps `power=line` ways and infers a pylon at every vertex — which is right for lines, but loses `power=substation`, `power=generator` (wind turbines), `power=transformer` and the design/height tags that say lattice vs tubular. |
| 13 | `addr:streetnumber` | 218 009 | 4 952 | node | stage 1 | The *orientační číslo* (the blue plaque) — the number people actually navigate by in Czech towns. |
| 14 | `lit=*` | 120 855 | 9 358 (8 608 way) | **way** | **stage 2** | "Is this road lit at night", stated per way. The game already has street lamps and a real night; this says which streets should have a glow and which go black. 114 070 road ways carry it and it is discarded. |
| 15 | `tracktype` | 100 701 | 19 647 | way (line) | stage 2 | Grade1–5 on 100 k field tracks — the difference between a concrete farm road you can take at 60 and a pair of ruts. Pure vehicle-handling data, already surveyed. |
| 16 | `access=*` | 91 160 | 9 250 | way/node | stage 2 | `private`, `no`, `destination`, `agricultural`. Which roads the AI traffic should never use and which gate the player through a farmyard. |
| 17 | `service=*` | 80 208 | 14 259 | way (line) | stage 2 | `driveway` / `parking_aisle` / `alley` / `spur` on 80 k service roads, all currently rendered as one 3.6 m class. A parking aisle and a private driveway want different width, surface and AI behaviour. |
| 18 | `meadow=*` / `dibavod:id` | 78 459 / 82 665 | 18 896 / 16 272 | way (area) | stage 2 | Meadow subtype and the Czech hydrology register id — mowing regime and real river/lake identity for water bodies. |
| 19 | `footway=*` | 57 151 | 2 359 | way (line) | stage 2 | `sidewalk` vs `crossing` vs `traffic_island` on 57 k footways. The game already draws crossings from nodes; this tells it which footways are *pavements beside a road* and should be raised on a kerb. |
| 20 | `crossing:markings`, `tactile_paving` | 54 480 / 50 995 | 3 858 / 3 251 | node/way | stage 2 | Zebra vs no markings, and where the blind-guidance strip is. Zebra stripes are already rendered; this says which crossings actually have them. |
| 21 | `smoothness` | 52 503 | 6 757 | way (line) | stage 2 | Ride quality, six levels, surveyed. Suspension response and tyre noise for free. |
| 22 | `layer` | 63 516 | 10 300 | way (line) | stage 2 | Relative vertical ordering at crossings. The builder reads `bridge`/`tunnel` but not `layer`, so a stack of three ways over one point has no defined order. |
| 23 | `capacity` | 33 484 | 1 829 | way (area)/node | stage 2 | Parking spaces per car park, bicycle stands per rack. Tells the game how many parked cars to place instead of guessing from area. |
| 24 | `opening_hours` | 31 449 | 2 839 | node | stage 1 | When a shop is open — the difference between a lit shopfront at 20:00 and a shuttered one. Now that night is dark, this has somewhere to land. |
| 25 | `leaf_type` / `leaf_cycle` | 31 630 / — | 5 919 / 4 458 | node/way | stage 2 | Broadleaf vs needleleaf, evergreen vs deciduous, on 24 440 individual trees. The trees are already placed; every one of them is currently the same tree. |
| 26 | `man_made=*` (all values) | 26 100 | 5 229 | node+way | mostly **stage 1** | Only 2 925 of 26 100 survive, and none because of this tag. Detail below. |
| 27 | `entrance=*` | 17 347 | 952 | **node** | **stage 1** | 17 334 surveyed door positions on building outlines. Where a pedestrian emerges, where a mission marker belongs, where the porch light goes. |
| 28 | `sidewalk=*` | 20 045 | 2 062 | way (line) | stage 2 | Pavement present on left/right/both, stated on the *road* way. Cheaper and more reliable than inferring pavements from separate footway geometry, and it is already in the raw tiles for kept roads. |
| 29 | `shop=*` (all values) | 21 951 | 2 598 | **node** (19 319) | **stage 1** | 270 distinct values; 19 742 lost outright. Detail below. |
| 30 | `historic=*` (all values) | 24 541 | 3 780 | node | mostly kept | 22 408 kept — the crosses and memorials. The 2 133 lost are castles, boundary stones, ruins, archaeological sites. |
| 31 | `roof:levels` | 23 180 | 1 534 | way (area) | stage 2 | Storeys *inside the roof*, i.e. how tall the pitched part is. The builder computes wall height and then guesses the ridge; this is the surveyed answer. |
| 32 | `kerb=*` / `barrier=kerb` | 12 192 / 9 879 | 224 / 100 | node+way | **stage 1** (`barrier=kerb` 61/9 879 kept) | Kerb height class (`raised`/`lowered`/`flush`) at 11 405 nodes, and 1 184 kerb *lines*. A raised kerb is a physical obstacle a car can hit and mount — currently the road edge is a texture change with no geometry. |
| 33 | `brand=*` | 14 030 | 1 513 | node | stage 1 | Normalised chain identity (`Lidl`, `Albert`, `Teta`, `Penny`) on 12 835 nodes — the one tag that lets a shop get a real, recognisable sign instead of a generic one. |
| 34 | `tourism=*` (all values) | 39 380 | 7 382 | **node** | mostly **stage 1** | 31 883 lost. 26 338 of them are `tourism=information` (guideposts). Detail below. |
| 35 | `railway=switch` | 12 419 | 1 837 | **node** | **stage 1** | Every point/turnout on the network. Rails are already drawn; switches are where a yard reads as a yard. |
| 36 | `railway=signal` | 11 416 | 1 803 | **node** | **stage 1** | Trackside signals, návěstidla — tall, visually distinctive, and 11 416 of them are surveyed with a position. |
| 37 | `roof:colour` | 11 472 | 782 | way (area) | stage 2 | Roof colour, when `building:colour` (which *is* read) says only the wall. |
| 38 | `roof:material` | 9 803 | 172 | way (area) | stage 2 | `tiles` / `roof_tiles` / `metal_sheet` / `eternit` on 9 683 buildings. Roof shape is already used; the material would give the tiles their colour and sheen instead of one flat guess. |
| 39 | `natural=peak` | 5 402 | 1 432 | **node** | **stage 1** | Named summits with elevation — free landmark names for the map in the Zlín and Vysočina hills, where the terrain is the point. |
| 40 | `amenity=parking_space` | 8 023 | 805 | **way (area)** | **stage 1** | 7 811 individually mapped parking *bays*. The game draws parking lots as a slab; these say exactly where each car stands and which way it faces. |
| 41 | `amenity=parcel_locker` | 4 928 | 516 | **node** | **stage 1** | Z-BOX/Alzabox — the single most visually recognisable new object on Czech streets, and there are 4 915 surveyed positions. |
| 42 | `railway=level_crossing` | 6 177 | 1 199 | **node** | **stage 1** | 6 166 of 6 177 lost. Where a road crosses a railway at grade — barriers, St Andrew's cross, lights, and a genuine driving hazard. The game already has rails *and* roads and draws no crossing where they meet. |
| 43 | `railway=crossing` | 2 031 | 230 | **node** | **stage 1** | The pedestrian version of the above. |
| 44 | `natural=wetland` | 3 827 | 973 | way (area) | **stage 1** | 3 798 marsh/reed polygons that currently fall through to "unmapped ground is a field" and render as mown lawn. |
| 45 | `leisure=swimming_pool` | 3 461 | 712 | way (area) | **stage 1** | 3 384 pools — blue rectangles in back gardens, and the thing that makes an aerial view of a suburb read correctly. |
| 46 | `emergency=fire_hydrant` | 1 688 | 400 | **node** | **stage 1** | Street furniture, already the right scale for the furniture layer that exists. |
| 47 | `office=*` (all values) | 2 171 | 320 | **node** | **stage 1** | 73 values, 258 survive and none because of this tag. Detail below. |
| 48 | `natural=cliff` | 2 573 | 254 | way (line) | **stage 1** | 2 532 cliff lines — a hard vertical break in terrain the DMR grid smooths away. |
| 49 | `maxheight` / `maxweight` | 4 158 / 4 199 | 299 / 408 | way (line) | stage 2 | Bridge and underpass limits. The one piece of road data that is *only* interesting in a driving game. |
| 50 | `advertising=billboard` | 856 | 100 | **node** | **stage 1** | 847 billboard positions. Czech arterial roads are lined with them and their absence is conspicuous. |
| 51 | `highway=speed_camera` | 764 | 82 | **node** | **stage 1** | Fixed speed cameras, with a position. A driving game has an obvious use. |
| 52 | `highway=motorway_junction` | 508 | 45 | **node** | **stage 1** | Exit number + destination name at every motorway exit — exactly the text a motorway sign needs, and the D11 is the road the player actually drives. |
| 53 | `highway=turning_circle` / `turning_loop` | 638 | 28 | **node** | **stage 1** | Where a dead-end road widens into a bulb. Currently every cul-de-sac ends in a flat stub. |
| 54 | `highway=traffic_mirror` | 788 | — | **node** | **stage 1** | Dopravní zrcadlo — visually distinctive roadside object at blind junctions. |
| 55 | `landuse=vineyard` | 761 | 3 | way (area) | **stage 1** | 745 vineyard polygons, essentially all in the Zlín/Olomouc half of the world. Rendered as unmapped ground → field. Rows of vines are a signature Moravian landscape. |
| 56 | `landuse=farmyard` | 2 525 | 488 | way (area) | **stage 1** | 2 500 farmyards. Hard standing between barns, currently lawn — the same bug the `YARD_LANDUSE` list was written to fix, one value short. |
| 57 | `landuse=residential` | 17 210 | 1 860 | way (area) | **stage 1** (deliberate) | Deliberately excluded (the comment in `split-extracts.mjs` explains why: Czech suburb ground really is garden). Listed for completeness — it is still 17 040 polygons of *zoning* context an offline classifier could use. |
| 58 | `area:highway` | 4 443 | 238 | **way (area)** | **stage 1** | 4 218 road *surfaces* mapped as polygons rather than centrelines — the actual painted extent of a junction or a square, including the flare of a turning lane. The game extrudes every road from a centreline and a class width; this is the surveyed truth for the places where that guess is worst. |
| 59 | `craft=*` | 836 | 135 | node | stage 1 | Workshops (`carpenter`, `electrician`, `car_repair`) — small commercial premises that read as "a working town". |
| 60 | `healthcare=*` | 2 571 | 395 | node | stage 1 | Finer than `amenity=doctors`; would populate the medical layer the game has only `hospital` for. |
| 61 | `natural=tree_row` | 6 358 | 573 | way (line) | **kept** | Already kept and sampled every 7 m (`processTrees`). Listed because the brief asked — this one is *not* thrown away. |
| 62 | `landuse=orchard` | 6 199 | 400 | way (area) | **kept as element, value lost** | Element survives, but `greenKind()` maps it to `'grass'`. 5 699 orchards render as lawn; rows of fruit trees would be the obvious win. |

---

## Category detail

### `amenity=*` — 219 distinct values, 197 955 features (world) / 26 861 (Pardubický)

139 332 elements survive stage 1 — but almost all of them because they are
benches, bins, parking or buildings, not because the value was wanted. The
builder's furniture table reads exactly eight amenity values plus
`parking`/`fuel`/`hospital`/`police`/`fire_station`. **Everything else is
decoration on a footprint that never reaches a tile.**

The largest values the pipeline never uses (world / Pardubický, node-dominant
unless noted):

| Value | World | Pardubický | Kept | Why it matters |
|---|---:|---:|---:|---|
| `parking_space` | 8 023 | 805 | 0 | individual bays (way/area) |
| `restaurant` | 5 703 | 478 | 55 | named, on the street, lit at night |
| `parcel_locker` | 4 928 | 516 | 0 | Z-BOX, unmistakable object |
| `vending_machine` | 3 601 | 310 | 1 | pavement furniture |
| `cafe` | 2 003 | 138 | 96 | terrace seating, awnings |
| `school` | 2 014 | 241 | 47 | drives traffic patterns and time-of-day |
| `fast_food` | 1 857 | 153 | 22 | drive-throughs; the McDonald's below |
| `atm` | 1 621 | 158 | 0 | wall-mounted, always lit |
| `fountain` | 1 549 | 144 | 142 | square centrepieces |
| `kindergarten` | 1 393 | 144 | 10 | |
| `pharmacy` | 1 117 | 142 | 14 | green cross, universally recognised |
| `post_office` | 1 090 | 181 | 13 | Česká pošta livery |
| `charging_station` | 835 | 142 | 3 | |
| `bank` | 652 | 74 | 34 | |
| `hunting_stand` | 2 836 | 578 | 3 | posluchy at every field edge — pure Czech countryside |
| `parking_entrance` | 2 433 | 38 | 16 | ramps into underground garages |
| `waste_disposal` | 2 515 | 312 | 17 | |
| `clock` | 829 | 47 | 74 | |

### `shop=*` — 270 distinct values, 21 951 (world) / 2 598 (Pardubický)

**19 742 lost at stage 1.** The 2 209 that survive do so because the element is
*also* a building — and `build-region.mjs` reads `t.shop` for one purpose only:
turning `building=yes` into `t:'commercial'`. **The value itself never reaches a
tile in any case.** A `shop=supermarket` and a `shop=hairdresser` produce
identical geometry today.

Top values (Pardubický kraj): `convenience` 311, `clothes` 214, `supermarket`
142, `storage_rental` 135, `hairdresser` 98, `car_repair` 67, `chemist` 63,
`bakery` 63, `butcher` 62, `florist` 60. World: `convenience` 3 737,
`supermarket` 1 572, `hairdresser` 1 560, `clothes`, `car_repair` 911,
`bakery` 871, `kiosk` 280, `mall` 161, `department_store` 109.

### `office=*` — 73 values, 2 171 (world) / 320 (Pardubický)

Effectively total loss: 258 survive, none because of this tag. Top:
`company` 593, `insurance` 428, `government` 360, `estate_agent`, `lawyer`,
`financial_advisor`. Office use on an upper floor is what puts a lit window grid
on a façade at 19:00 instead of curtains.

### `tourism=*` — 36 values, 39 380 (world) / 7 382 (Pardubický)

31 883 lost. Only `tourism=artwork` is deliberately kept (1 033 in Pardubický).

| Value | World | Kept | Note |
|---|---:|---:|---|
| `information` | 26 338 | 57 | guideposts and boards — 26 317 nodes, dense on every trail junction |
| `hotel` | 1 879 | 444 | kept only when it is also a building; the *name* survives, the fact that it is a hotel does not |
| `viewpoint` | 1 777 | 66 | |
| `attraction` | 1 256 | 225 | |
| `museum` | 762 | 193 | |

### `historic=*` — 72 values, 24 541 (world) / 3 780 (Pardubický)

**The best-covered category in the pipeline.** 22 408 kept, because
`FURNITURE_HISTORIC` already takes `wayside_cross`, `wayside_shrine`, `memorial`
and `monument` — 1 583 + 308 + 1 340 + 18 in Pardubický alone. What is still
lost: `boundary_stone` (219 world), `archaeological_site` (143),
`historic=stone`, `historic=tomb`, `historic=mine`. Small numbers, and the
crosses — the ones that matter for a Czech road — are already in.

### `leisure=*` — 58 values, 52 266 (world) / 6 380 (Pardubický)

36 977 kept (pitch, playground, park, garden, golf_course, stadium). Lost:

| Value | World | Kept | Note |
|---|---:|---:|---:|
| `swimming_pool` | 3 461 | 24 | 3 384 way-areas |
| `track` | 1 136 | 7 | running tracks — the red oval next to every school |
| `fitness_station` | 1 261 | 2 | outdoor gyms |
| `nature_reserve` | 1 095 | 7 | mostly relations; context, not geometry |
| `picnic_table` | 827 (Pce) | 26 | duplicates `amenity=picnic_table`, which *is* kept |

Also note: `leisure=pitch` is kept and `sport=*` **is** read (`SPORTS` regex), so
a tennis court and a football pitch already differ.

### `man_made=*` — 144 values, 26 100 (world) / 5 229 (Pardubický)

**2 925 of 26 100 survive, and not one of them because of this tag** —
`man_made` appears nowhere in `wantWay`/`wantNode`. The survivors are chimneys
and towers that happen to carry `building=*`.

| Value | World | Kept | What it would add |
|---|---:|---:|---|
| `surveillance` | 3 520 | 18 | CCTV poles |
| `tower` | 2 351 | 530 | transmitter and water towers — landmark silhouettes |
| `bridge` | 1 941 | 13 | bridge *outlines* (the deck as an area, not the road line) |
| `pipeline` | 1 736 | 11 | above-ground heat pipelines — a signature Czech industrial-town object |
| `embankment` | 1 758 | 52 | railway and road embankments the terrain grid misses |
| `mast` | 1 429 | 3 | |
| `chimney` | 1 060 | 130 | the tall brick stack that tells you which town this is |
| `flagpole` | 1 326 | 4 | |
| `street_cabinet` | 2 676 | 158 | grey boxes on every pavement |
| `storage_tank` / `silo` | 1 130 / — | 777 | mostly survive as buildings |
| `water_tower` | — | 17/37 (Pce) | |

### Building shape tags — the one place the pipeline is already good

| Tag | World | Lost | Status |
|---|---:|---:|---|
| `building:levels` | 979 983 | 5 743 | **read** — `buildingHeight()` |
| `height` | 48 370 | 5 640 | **read** — outranks levels |
| `roof:shape` | 119 615 | 8 966 | **read** — and back-filled by `defaultRoof()` where absent |
| `building:colour` | — | 20 (Pce) | **read** — via `CZ_COLOURS` |
| `roof:levels` | 23 180 | **23 180** | dropped |
| `roof:colour` | 11 472 | **11 472** | dropped |
| `roof:material` | 9 803 | **9 803** | dropped |
| `building:material` | — | 66 (Pce) | dropped |

`building:levels` coverage is genuinely excellent — 976 242 way-areas — and it is
already used. `roof:shape` at 119 213 is thinner, which is exactly the gap
`defaultRoof()` was written to plug.

### Addresses — the largest single loss in the file

`addr:housenumber` is on **1 187 615 nodes** across the world (166 366 in the
Pardubický kraj alone) and **every one of those nodes is dropped at stage 1** —
`wantNode` has no address clause. The 31 546 way-borne ones survive only where
the way is a building, and are then dropped at stage 2 because
`build-region.mjs` never reads the key.

Measured in the built product: `data/raw-region/0_0.json` — the 4.8 km tile whose
north-west corner *is* Pardubice hlavní nádraží — contains **9** occurrences of
`addr:housenumber`.

### Names

`build-region.mjs` writes a name for **buildings** (`b.n`), **roads** (`r.n`),
**POIs** (station / tram_stop / bus_stop / aerodrome / fuel / hospital / police /
fire_station) and **places**. `processAreas()` writes no name at all, so a named
lake, a named park and a named industrial zone all lose their name even though
their polygon survives.

Measured on `pardubicky.osm.pbf` (ways inside the world carrying `name=*`):

```
named buildings (name KEPT)        2 154
named roads     (name KEPT)       11 236
named water areas (name DROPPED)     572
named green areas (name DROPPED)     273
named yard/zone   (name DROPPED)     166
→ 1 011 named polygons survive as geometry and lose their name
```

---

## Named POI nodes near Pardubice — the specific measurement

**Question:** how many named nodes carrying `shop=*`, `amenity=fast_food`,
`restaurant`, `cafe`, `bank`, `post_office` or `pharmacy` exist in the Pardubice
area?

**Answer, counted on `pardubicky.osm.pbf`, distance measured from the world
origin (Pardubice hlavní nádraží, 50.0317084 N, 15.7560881 E):**

| Radius | Named POI nodes |
|---|---:|
| 500 m | 52 |
| 900 m | 127 |
| 1 500 m | 627 |
| 3 000 m | 1 065 |
| 6 000 m | **1 215** |

Within 6 km, by class: `shop=*` 911, `restaurant` 124, `cafe` 66,
`fast_food` 50, `pharmacy` 33, `bank` 19, `post_office` 12.
(1 321 such nodes exist in that radius; **92 %** carry a name.)
A further **93 named POI ways/areas** are in the same radius (supermarkets
mapped as building outlines: Penny, Billa, Kaufland, Lidl, Globus…).

**Across the whole game world** (all seven extracts, node ids deduplicated, world
mask applied):

| Class | Nodes | Named |
|---|---:|---:|
| `shop=*` | 19 317 | 16 559 |
| `amenity=restaurant` | 5 603 | 5 302 |
| `amenity=cafe` | 1 809 | 1 704 |
| `amenity=fast_food` | 1 778 | 1 500 |
| `amenity=pharmacy` | 1 094 | 1 044 |
| `amenity=post_office` | 1 075 | 1 060 |
| `amenity=bank` | 608 | 594 |
| **total** | **31 284** | **27 763** |

**27 763 named, surveyed, positioned shopfronts in the world, and the pipeline
keeps zero of them.**

### A dozen real examples (all `type=node`, all currently discarded)

Game coordinates are metres from the origin, x east / z **south**.

| OSM id | Tag | lat, lon | x | z | dist | Name |
|---|---|---|---:|---:|---:|---|
| node/12158410569 | `shop=ticket` | 50.032222, 15.755994 | −7 | −57 | 58 m | České dráhy |
| node/12222240819 | `shop=ticket` | 50.032223, 15.755861 | −16 | −57 | 59 m | RegioJet |
| node/12158410577 | `amenity=fast_food` | 50.032339, 15.755836 | −18 | −70 | 72 m | Kiosek |
| node/877413642 | `amenity=restaurant` | 50.032578, 15.755717 | −27 | −97 | 100 m | Momento |
| node/12476100778 | `amenity=fast_food` | 50.032631, 15.756261 | 12 | −103 | 103 m | pont to go |
| node/10128068154 | `amenity=restaurant` | 50.030510, 15.752853 | −232 | 133 | 267 m | Dobrá Kantýna Vápenka |
| node/12569453187 | `amenity=post_office` | 50.033078, 15.759494 | 244 | −152 | 288 m | Česká pošta – Depo Pardubice |
| node/12126019863 | `amenity=cafe` | 50.034152, 15.762648 | 470 | −272 | 543 m | PUTOVNÍ PRAŽÍRNA |
| node/6923978718 | `amenity=pharmacy` | 50.034987, 15.763369 | 522 | −365 | 637 m | U Raka |
| node/296729603 | `amenity=restaurant` | 50.032366, 15.765692 | 688 | −73 | 692 m | Veselka |
| node/12198896434 | `amenity=bank` | 50.034062, 15.766128 | 719 | −262 | 765 m | ČSOB |
| node/664162865 | `amenity=pharmacy` | 50.024177, 15.757609 | 109 | 838 | 845 m | Dukla |
| node/11524294451 | `amenity=cafe` | 50.033725, 15.769980 | 995 | −224 | 1 020 m | La Donuteria CZ |
| node/12112034994 | `amenity=post_office` | 50.033788, 15.774665 | 1 331 | −231 | 1 351 m | Nova Post |

### The four the user reported — **all confirmed present in the raw data**

| Reported | Found | OSM id | Tag | lat, lon | x, z | dist from hl. n. |
|---|---|---|---|---|---|---|
| McDonald's | **yes** | node/13970695060 | `amenity=fast_food`, `brand=McDonald's` | 50.033526, 15.754266 | −131, −202 | **241 m** |
| Česká pošta | **yes** | node/12569453187 | `amenity=post_office`, name "Česká pošta - Depo Pardubice" | 50.033078, 15.759494 | 244, −152 | **288 m** |
| Kora HB | **yes** — spelled `coraHB` in OSM | node/13634813428 | `shop=car_parts` | 50.032778, 15.751332 | −341, −119 | **361 m** |
| Lidl | **yes** | node/3394785494 | `shop=supermarket`, `brand=Lidl` | 50.032724, 15.750031 | −434, −113 | **448 m** |

Two further McDonald's are in range: node/296759851 at 1 175 m (x 1 070,
z −485) and node/13612459958 at 2 948 m (x −27, z −2 947).

Also within 500 m of the station, all discarded: Albert (392 m), Rossmann
(403 m), TEDi, Woolworth, Action, Sportisimo, sinsay, CCC, HalfPrice, Planeo,
Pet Center. Within 3 km: Tesco, Coop, Billa, KFC ×2, Teta ×4, Kaufland ×2,
Penny ×2, Globus, a second McDonald's, Tescoma.

**Verification that they are discarded, not merely unrendered:**
`grep -c McDonald data/raw-region/0_0.json` → **0**. The name never reaches
`data/raw-region/`, so nothing downstream could use it even in principle.

---

## Incidental finding (not acted on)

`data/raw-osm/praha.osm.pbf` is a **strict subset** of
`data/raw-osm/stredocesky.osm.pbf`. Measured: 7 660 `shop=*` nodes inside the
world mask in `praha`, and **exactly 7 660 duplicate node ids** appear when
`stredocesky` is read after it — a perfect overlap, zero unique. Geofabrik's
Středočeský extract includes Prague.

Consequence for `split-extracts.mjs`: every Prague element is written **twice**
into `data/raw-region/`, doubling those tiles' raw size and split time.
`build-region.mjs` dedupes within a tile (`seen` set keyed `el.type + '/' + el.id`
in each layer), so **nothing is rendered twice and no output is wrong** — this is
cost, not a bug. Dropping `praha.osm.pbf` from the extract list would halve the
Prague raw tiles at no loss. **No change has been made.**

---

## Reproducing this

Nothing in the repo was modified. The two survey scripts live in the session
scratchpad:

```
/private/tmp/claude-501/-Users-frantisekdivoky-Documents-html-AmongTheCity/
  cb5d45ee-ab80-4455-a1f3-fafadc52cac9/scratchpad/
    survey.mjs    # one extract → tag counts + Pardubice POI harvest (JSON)
    merge.mjs     # merge several survey JSONs
    report.mjs    # print the tables
    poicount.mjs  # deduplicated named-POI count across all extracts
```

Run from the repo root, e.g.:

```
node --max-old-space-size=8192 <scratch>/survey.mjs \
  data/raw-osm/pardubicky.osm.pbf <scratch>/pardubicky.json
node <scratch>/report.mjs <scratch>/pardubicky.json top 60
node <scratch>/report.mjs <scratch>/pardubicky.json vals amenity 15
```

**A data rebuild is NOT required to reproduce any number here** — the survey
reads the PBFs directly and writes nothing into the repo. If a future change
does alter the filters, the full regeneration is:

```
node scripts/split-extracts.mjs      # rewrites data/raw-region/ from the PBFs
node scripts/build-region.mjs        # hours — rewrites all 342 public/data/tiles/
```

(Neither was run for this survey, so neither is timed here. The read-only pass
over all seven extracts that produced these numbers took **~50 s**, which is a
floor for the split, not an estimate of it.)
