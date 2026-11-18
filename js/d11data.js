// ---- d11data.js: the baked D11 / D35 tables behind js/d11.js ----
// Baked once (round 8 wave 0, a scratch script) from the tile motorway ways,
// the raw OSM tags in data/raw-region and cs.wikipedia; plain constants, no
// imports, worker safe. The tables may be edited by hand; the carriageway
// lines are in js/d11lines.js and change only with the tiles.
// Read it through js/d11.js, which documents the lines, the km and the API.

function deepFreeze(o) { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); }

/**
 * The exits, in km order per road. Each: { id, road, n (the exit number = km),
 * name (the interchange as ŘSD names it), kind 'exit' | 'junction' (dálniční
 * křižovatka), km (the anchored centre), cross (shields of the road it
 * meets), outside (beyond the world's terrain), and per carriageway E / W
 * (S / N on the D35) null or { div, mer, alt?, to, refs, thru }: the slip's
 * diverge from and merge back onto THIS carriageway ({x, z, km}, exact tile
 * vertices), alt a second exit slip (exit 1 eastbound: D0 and Černý Most),
 * to the destination texts as on the gantry (the OSM destination tag of the
 * slip, abbreviations as signed), refs their shields, thru the straight-on
 * destinations. Texts marked FALLBACK had no tag: the owner should review.
 */
export const EXITS = deepFreeze([
  { id: 'd11-1', road: 'D11', n: 1, name: 'Horní Počernice', kind: 'junction', km: 0.03, cross: ['D0'],
    E: {
      div: { x: -83754.7, z: -7650.2, km: -0.385 },
      mer: { x: -82985.8, z: -7447.2, km: 0.384 },
      alt: { x: -83294.3, z: -7511.2, km: 0.09, to: ['Mladá Boleslav', 'Praha-Černý Most'], refs: [] },
      to: ['Plzeň', 'Brno', 'Praha-centrum'], refs: ['D0'], thru: ['Hradec Králové'],
    },
    W: {
      div: { x: -82947.6, z: -7467, km: 0.418 },
      mer: null,
      to: ['Plzeň', 'Brno', 'Praha-centrum'], refs: ['D0'], thru: ['Praha'],
      // to: the tag of the D0 way the carriageway runs into (OSM 1375712122; the slip beside it says "Nákupní zóna"); thru FALLBACK
    },
  },
  { id: 'd11-8', road: 'D11', n: 8, name: 'Jirny', kind: 'exit', km: 8, cross: [],
    E: {
      div: { x: -75652.8, z: -10074.7, km: 7.729 },
      mer: { x: -75371.7, z: -10092.7, km: 7.991 },
      to: ['Úvaly', 'Brandýs n.L.'], refs: [], thru: ['Hradec Králové'],
    },
    W: {
      div: { x: -75073.6, z: -10133.3, km: 8.285 },
      mer: { x: -75316.9, z: -10109.7, km: 8.045 },
      to: ['Úvaly', 'Brandýs n.L.'], refs: [], thru: ['Praha'],
    },
  },
  { id: 'd11-18', road: 'D11', n: 18, name: 'Bříství', kind: 'exit', km: 18, cross: ['II/272'],
    E: {
      div: { x: -65273.2, z: -11721.3, km: 18.089 },
      mer: { x: -65045.4, z: -11670.3, km: 18.309 },
      to: ['Český Brod', 'Lysá n. L.'], refs: ['II/272'], thru: ['Hradec Králové'],  // refs: from cs.wikipedia, the slip has no destination:ref
    },
    W: {
      div: { x: -65047.9, z: -11683.9, km: 18.304 },
      mer: { x: -65693.5, z: -11773.9, km: 17.679 },
      to: ['Bříství', 'Lysá n. Labem'], refs: ['II/272'], thru: ['Praha'],  // refs: from cs.wikipedia, the slip has no destination:ref
    },
  },
  { id: 'd11-25', road: 'D11', n: 25, name: 'Sadská', kind: 'exit', km: 25.002, cross: ['II/330'],
    E: {
      div: { x: -58317, z: -9719.2, km: 24.984 },
      mer: { x: -58069.4, z: -9623.1, km: 25.265 },
      to: ['Sadská', 'Poříčany'], refs: ['II/330'], thru: ['Hradec Králové'],  // FALLBACK: no destination tag; the town and the village the II/330 reaches
    },
    W: {
      div: { x: -58245.5, z: -9703.6, km: 25.059 },
      mer: { x: -58523.5, z: -9822.6, km: 24.766 },
      to: ['Sadská', 'Poříčany'], refs: ['II/330'], thru: ['Praha'],  // FALLBACK: no destination tag
    },
  },
  { id: 'd11-35', road: 'D11', n: 35, name: 'Vrbová Lhota', kind: 'exit', km: 35, cross: ['II/329'],
    E: {
      div: { x: -49136.3, z: -9926.2, km: 34.963 },
      mer: { x: -48868.2, z: -9930.2, km: 35.239 },
      to: ['Pečky', 'Nymburk', 'Poděbrady'], refs: ['II/329'], thru: ['Hradec Králové'],
    },
    W: {
      div: { x: -49079.3, z: -9938.6, km: 35.023 },
      mer: { x: -49335.4, z: -9938.8, km: 34.75 },
      to: ['Písková Lhota', 'Pečky'], refs: ['II/329'], thru: ['Praha'],
    },
  },
  { id: 'd11-39', road: 'D11', n: 39, name: 'Kluk', kind: 'exit', km: 39.001, cross: ['I/38'],
    E: {
      div: { x: -45461.9, z: -9617.4, km: 38.748 },
      mer: { x: -45186, z: -9582, km: 39.035 },
      to: ['Nymburk', 'Poděbrady', 'Kolín'], refs: ['I/38'], thru: ['Hradec Králové'],
    },
    W: {
      div: { x: -44972.3, z: -9573.2, km: 39.265 },
      mer: { x: -45275.5, z: -9604.8, km: 38.939 },
      to: ['Kolín', 'Nymburk', 'Poděbrady'], refs: ['I/38'], thru: ['Praha'],
    },
  },
  { id: 'd11-42', road: 'D11', n: 42, name: 'Libice nad Cidlinou', kind: 'exit', km: 41.991, cross: ['I/32', 'II/125'],
    E: {
      div: { x: -42584.4, z: -9641.6, km: 41.846 },
      mer: { x: -42325.3, z: -9662.7, km: 42.109 },
      to: ['Jičín', 'Velký Osek'], refs: ['I/32', 'II/125'], thru: ['Hradec Králové', 'Pardubice'],  // thru: the through way's tag
    },
    W: {
      div: { x: -42300.4, z: -9677.4, km: 42.134 },
      mer: { x: -42532.8, z: -9658.4, km: 41.899 },
      to: ['Velký Osek', 'Jičín', 'Poděbrady'], refs: ['I/32', 'II/125'], thru: ['Praha'],
    },
  },
  { id: 'd11-50', road: 'D11', n: 50, name: 'Dobšice', kind: 'exit', km: 50, cross: ['II/328'],
    E: {
      div: { x: -33975.9, z: -10007.9, km: 50.005 },
      mer: { x: -33679.7, z: -9989.3, km: 50.315 },
      to: ['Městec Králové', 'Žehuň'], refs: ['II/328'], thru: ['Hradec Králové'],  // refs: from cs.wikipedia, the slip has no destination:ref
    },
    W: {
      div: { x: -33960.2, z: -10020, km: 50.021 },
      mer: { x: -34283.3, z: -10008.8, km: 49.718 },
      to: ['Městec Králové', 'Žehuň', 'Kolín'], refs: ['II/328'], thru: ['Praha'],  // refs: from cs.wikipedia, the slip has no destination:ref
    },
  },
  { id: 'd11-62', road: 'D11', n: 62, name: 'Chlumec nad Cidlinou', kind: 'exit', km: 61.999, cross: ['II/327'],
    E: {
      div: { x: -22915.8, z: -10964.2, km: 62.016 },
      mer: { x: -22643.5, z: -10894.4, km: 62.295 },
      to: ['Týnec n. Labem', 'Chlumec n. Cidlinou'], refs: ['II/327'], thru: ['Hradec Králové'],  // refs: from cs.wikipedia, the slip has no destination:ref
    },
    W: {
      div: { x: -22957.8, z: -10986.8, km: 61.969 },
      mer: { x: -23223.1, z: -11033.5, km: 61.689 },
      to: ['Týnec n. Labem', 'Chlumec n. Cidlinou'], refs: ['II/327'], thru: ['Praha'],  // refs: from cs.wikipedia, the slip has no destination:ref
    },
  },
  { id: 'd11-68', road: 'D11', n: 68, name: 'Chýšť', kind: 'exit', km: 67.999, cross: ['I/36'],
    E: {
      div: { x: -17241.3, z: -11421.5, km: 67.752 },
      mer: { x: -17019.7, z: -11515.1, km: 67.991 },
      to: ['Nové Město', 'Lázně Bohdaneč'], refs: ['I/36'], thru: ['Hradec Králové'],
    },
    W: {
      div: { x: -16774.6, z: -11602.9, km: 68.228 },
      mer: { x: -17020.3, z: -11527.5, km: 67.994 },
      to: ['Lázně Bohdaneč', 'Chlumec n. Cidlinou', 'Nové Město'], refs: ['I/36'], thru: ['Praha'],
    },
  },
  { id: 'd11-76', road: 'D11', n: 76, name: 'Pravy', kind: 'exit', km: 76.003, cross: ['II/323'],
    E: {
      div: { x: -8996, z: -11793.5, km: 75.676 },
      mer: { x: -8712, z: -11823.6, km: 75.937 },
      to: ['Nechanice', 'Dobřenice', 'Přelouč'], refs: ['II/323'], thru: ['Hradec Králové'],
    },
    W: {
      div: { x: -8289.6, z: -11858.6, km: 76.365 },
      mer: { x: -8587.1, z: -11845.9, km: 76.059 },
      to: ['Přelouč', 'Nechanice', 'Dobřenice'], refs: ['II/323'], thru: ['Praha'],
    },
  },
  { id: 'd11-84', road: 'D11', n: 84, name: 'Sedlice', kind: 'junction', km: 83.999, cross: ['D35'],
    E: {
      div: { x: -1676.1, z: -12996.1, km: 83.505 },
      mer: { x: -936, z: -13607.5, km: 84.455 },
      to: ['Olomouc', 'Pardubice', 'Hradec Králové'], refs: ['D35'], thru: ['Hradec Králové'],
    },
    W: {
      div: { x: -1019.9, z: -13545.4, km: 84.357 },
      mer: { x: -1496.6, z: -13145.5, km: 83.746 },
      to: ['Olomouc', 'Pardubice'], refs: ['D35'], thru: ['Praha'],
    },
  },
  { id: 'd11-90', road: 'D11', n: 90, name: 'Kukleny', kind: 'exit', km: 89.855, cross: ['II/611'],
    E: {
      div: { x: 611.8, z: -18386.9, km: 89.417 },
      mer: { x: 976.7, z: -19347.2, km: 90.493 },
      to: ['Nový Bydžov', 'Hradec Králové-Kukleny'], refs: ['II/324', 'II/611'], thru: ['Wroclaw', 'Trutnov', 'Liberec', 'Hradec Králové-Plotiště'],
      // thru: the tag of the through way from here on (OSM 857753033, ref D11;D35)
    },
    W: {
      div: { x: 957.6, z: -19326.1, km: 90.464 },
      mer: { x: 561.2, z: -18284.1, km: 89.31 },
      to: ['Nový Bydžov', 'Hradec Králové-Kukleny'], refs: ['II/324', 'II/611'], thru: ['Praha'],
      // to: the slip (516619101) carries no tag, but it is a collector road:
      // it gives off the Nový Bydžov branch first (977859736 "Chlumec nad
      // Cidlinou;Nový Bydžov", to the II/611), then the Kukleny one (781623695
      // "Opatovice nad Labem;Hradec Králové - Kukleny", destination:ref
      // 324;611), and runs on as the links tagged ref D11 to the merge below.
      // Read from data/raw-region in round 9; the order of the E slip's tag.
    },
  },
  { id: 'd11-95', road: 'D11', n: 95, name: 'Plotiště', kind: 'junction', km: 94.999, cross: ['D35', 'I/11', 'I/35'],
    E: {
      div: { x: 1295, z: -22989.2, km: 94.649 },
      mer: { x: 1700.1, z: -23671.8, km: 95.48 },
      to: ['Hradec Králové', 'Jičín'], refs: ['I/11', 'I/35'], thru: ['Trutnov', 'Jaroměř'],
      // to: the slip (977835780 -> 941692566) carries no tag and ends on the
      // I/35 roundabout (primary ref 35), whose arms are signed "Šumperk;Hradec
      // Králové" destination:ref 11 and "Liberec;Jičín" destination:ref 35.
      // No D35 north of here in the data: the shield was the I/35's (round 9).
      // thru: FALLBACK (no tag on the through way past 84, but "Trutnov" on the D35 joining it)
    },
    W: {
      div: { x: 1689, z: -23679.3, km: 95.479 },
      mer: { x: 1224, z: -22828.1, km: 94.452 },
      to: ['Hradec Králové', 'Jičín'], refs: ['I/11', 'I/35'], thru: ['Praha'],
      // to: the slip (881442253 -> 977835764) ends on the same I/35
      // roundabout; its arms as for 95 E (round 9)
    },
  },
  { id: 'd11-104', road: 'D11', n: 104, name: 'Smiřice', kind: 'exit', km: 104.001, cross: ['I/33'], outside: true,
    E: {
      div: { x: 6662.1, z: -30584.1, km: 104.091 },
      mer: { x: 6768.2, z: -30839.8, km: 104.387 },
      to: ['Smiřice', 'Hořiněves'], refs: ['I/33'], thru: ['Trutnov', 'Jaroměř'],  // refs: from cs.wikipedia, the slip has no destination:ref
      // thru: FALLBACK (no tag on the through way past 84, but "Trutnov" on the D35 joining it)
    },
    W: {
      div: { x: 6603.7, z: -30469.3, km: 103.957 },
      mer: { x: 6478.4, z: -30177.6, km: 103.642 },
      to: ['Smiřice'], refs: ['I/33'], thru: ['Praha'],  // FALLBACK: no destination tag
    },
  },
  { id: 'd11-108', road: 'D11', n: 108, name: 'Jaroměř-jih', kind: 'exit', km: 107.998, cross: ['I/33'], outside: true,
    E: {
      div: { x: 8281.7, z: -33451.3, km: 107.65 },
      mer: { x: 8361.1, z: -33741.1, km: 107.972 },
      to: ['Velichovky', 'Jaroměř'], refs: ['I/33'], thru: ['Trutnov', 'Jaroměř'],  // refs: from cs.wikipedia, the slip has no destination:ref
      // thru: FALLBACK (no tag on the through way past 84, but "Trutnov" on the D35 joining it)
    },
    W: {
      div: { x: 8449.9, z: -34084.2, km: 108.327 },
      mer: { x: 8371, z: -33824.8, km: 108.056 },
      to: ['Jaroměř'], refs: ['I/33'], thru: ['Praha'],  // FALLBACK: no destination tag
    },
  },
  { id: 'd35-127', road: 'D35', n: 127, name: 'Sedlice', kind: 'junction', km: 126.9, cross: ['D11'],
    S: null,
    N: {
      div: { x: -950.9, z: -13069.8, km: 127.453 },
      mer: null,
      to: ['Praha'], refs: ['D11'], thru: ['Wroclaw (PL)', 'Trutnov', 'Liberec'],
      // thru: the tag of the D35 way that joins the D11 eastbound (OSM 1332946520)
    },
  },
  { id: 'd35-131', road: 'D35', n: 131, name: 'Opatovice nad Labem', kind: 'exit', km: 130.95, cross: ['I/37', 'II/324'],
    S: {
      div: { x: 1926.8, z: -12101.2, km: 130.479 },
      mer: { x: 2742.8, z: -11645.6, km: 131.396 },
      to: ['Opatovice nad Labem', 'Hradec Králové'], refs: ['I/37', 'II/324'], thru: ['Olomouc'],  // FALLBACK: no destination tag; refs from cs.wikipedia (the N slip says 37;124)
    },
    N: {
      div: { x: 2806.8, z: -11587.6, km: 131.478 },
      mer: { x: 1855.7, z: -12119.7, km: 130.41 },
      to: ['Hradec Králové', 'Pardubice', 'Opatovice nad Labem'], refs: ['I/37', 'II/324'], thru: ['Wroclaw', 'Liberec', 'Praha'],
      // refs: the slip's tag says 37;124, cs.wikipedia (and the S side) II/324; thru: the through way's tag (OSM 45190012)
    },
  },
  { id: 'd35-139', road: 'D35', n: 139, name: 'Rokytno', kind: 'exit', km: 139.001, cross: ['II/298'],
    S: {
      div: { x: 8888.5, z: -7647.6, km: 138.868 },
      mer: { x: 8989.1, z: -7390.4, km: 139.154 },
      to: ['Sezemice', 'Býšť'], refs: ['II/298'], thru: ['Olomouc'],
    },
    N: {
      div: { x: 9002.9, z: -7388.7, km: 139.163 },
      mer: { x: 8900, z: -7655.4, km: 138.864 },
      to: ['Třebechovice pod Orebem', 'Býšť'], refs: ['II/298'], thru: ['Praha', 'Hradec Králové'],
      // thru: the through way's tag (OSM 933557760)
    },
  },
  { id: 'd35-144', road: 'D35', n: 144, name: 'Časy', kind: 'exit', km: 143.997, cross: ['I/36'],
    S: {
      div: { x: 10759.2, z: -3905.7, km: 143.661 },
      mer: { x: 10583.7, z: -3271.9, km: 144.318 },
      to: ['Pardubice', 'Holice'], refs: ['I/36'], thru: ['Olomouc'],
    },
    N: {
      div: { x: 10612.9, z: -3305.3, km: 144.28 },
      mer: { x: 10770.6, z: -3968.3, km: 143.591 },
      to: ['Pardubice', 'Sezemice', 'Holice'], refs: ['I/36'], thru: ['Hradec Králové'],
      // thru: FALLBACK (the D35 northbound ends on the D11 eastbound)
    },
  },
  { id: 'd35-148', road: 'D35', n: 148, name: 'Dašice', kind: 'exit', km: 148.002, cross: ['II/322'],
    S: {
      div: { x: 12401, z: -349.5, km: 147.852 },
      mer: { x: 12654.9, z: -125.1, km: 148.166 },
      to: ['Dašice', 'Dolní Roveň'], refs: ['II/322'], thru: ['Olomouc'],
    },
    N: {
      div: { x: 12663.3, z: -133.7, km: 148.167 },
      mer: { x: 12410.1, z: -357.9, km: 147.853 },
      to: ['Dašice', 'Dolní Roveň'], refs: ['II/322'], thru: ['Hradec Králové'],  // FALLBACK: no destination tag; mirrors the S slip
      // thru: FALLBACK (the D35 northbound ends on the D11 eastbound)
    },
  },
  { id: 'd35-157', road: 'D35', n: 157, name: 'Ostrov', kind: 'exit', km: 157, cross: ['I/17'],
    S: {
      div: { x: 18848.8, z: 5467, km: 156.626 },
      mer: { x: 19272.5, z: 5737.9, km: 157.124 },
      to: ['Chrudim', 'Hrochův Týnec'], refs: ['I/17'], thru: ['Olomouc'],
    },
    N: {
      div: { x: 19507.2, z: 5840.5, km: 157.38 },
      mer: { x: 19188.3, z: 5678.9, km: 157.021 },
      to: ['Chrudim', 'Hrochův Týnec'], refs: ['I/17'], thru: ['Hradec Králové'],
      // thru: FALLBACK (the D35 northbound ends on the D11 eastbound)
    },
  },
]);

/**
 * Rest areas and services, in km order per road. Per carriageway null or
 * { div, mer, fuel (the brand OSM names, null: none), poi ([x, z] of the
 * tile fuel poi, null: the tiles have none: they keep fuel only as nodes, and
 * the Osice W and Dolní Roveň stations are OSM areas), food (a restaurant on
 * that side, from the raw OSM nodes: at Osice the McDonald's stands on the W
 * side), wc, parking, trucks }. The slips are motorway_link ways except
 * Bříství, whose access roads are tile service roads. via: reached through
 * that exit (Dobšice, the Shell truck stop off exit 50), km is then the poi's.
 * trucks comes from the size of the tile parking lots (> 2500 m², the tiles
 * carry no hgv tag) and wc is assumed at every site: owner review.
 * Předměřice (between 95 and 104) has no parking in the tiles, so it is not
 * listed; the parking-only bay at km 35.4 E is part of exit 35's slips.
 */
export const REST = deepFreeze([
  { id: 'beranka', name: 'Beranka', road: 'D11', km: 3.346,
    E: { div: { x: -80292.9, z: -8493.2, km: 3.116 }, mer: { x: -79845.4, z: -8642.7, km: 3.556 }, fuel: 'Orlen', poi: [-80115.9,-8505.1], food: "Burger King", wc: true, parking: true, trucks: true },
    W: { div: { x: -79832.3, z: -8668.2, km: 3.575 }, mer: { x: -80281, z: -8518, km: 3.134 }, fuel: 'Shell', poi: [-80001.6,-8661.4], food: null, wc: true, parking: true, trucks: true },
  },
  { id: 'bristvi', name: 'Bříství', road: 'D11', km: 19.157,
    E: { div: { x: -64223.6, z: -11308.3, km: 19.157 }, mer: { x: -63918.4, z: -11146.4, km: 19.482 }, fuel: 'MOL', poi: [-64104.4,-11207.2], food: "Fresh Corner", wc: true, parking: true, trucks: true },
    W: { div: { x: -63782.4, z: -11096.3, km: 19.619 }, mer: { x: -64654.9, z: -11543.3, km: 18.695 }, fuel: 'MOL', poi: [-63891.1,-11188.7], food: null, wc: true, parking: true, trucks: false },
  },
  { id: 'vrbova-lhota', name: 'Vrbová Lhota', road: 'D11', km: 35.931,
    E: { div: { x: -48565.6, z: -9938.7, km: 35.549 }, mer: { x: -47945.8, z: -9943.6, km: 36.183 }, fuel: 'OMV', poi: [-48314.8,-9896.7], food: "McDonald's", wc: true, parking: true, trucks: true },
    W: { div: { x: -47818.3, z: -9953.5, km: 36.313 }, mer: { x: -48536, z: -9951.5, km: 35.579 }, fuel: 'OMV', poi: [-48251.1,-10005.8], food: null, wc: true, parking: true, trucks: true },
  },
  { id: 'dobsice', name: 'Dobšice', road: 'D11', via: 50, km: 49.975,
    E: { div: null, mer: null, km: 49.975, fuel: 'Shell', poi: [-34008.2,-9954.6], food: 'KFC, Burger King', wc: true, parking: true, trucks: true },
    W: { div: null, mer: null, km: 49.976, fuel: 'Shell', poi: [-34008.2,-9954.6], food: 'KFC, Burger King', wc: true, parking: true, trucks: true },
  },
  { id: 'osice', name: 'Osice', road: 'D11', km: 80.672,
    E: { div: { x: -4447.6, z: -11751.8, km: 80.355 }, mer: { x: -3853.2, z: -11910.2, km: 80.989 }, fuel: 'Benzina', poi: [-4192.7,-11747.1], food: null, wc: true, parking: true, trucks: true },
    W: { div: { x: -3887.8, z: -11912.6, km: 80.956 }, mer: { x: -4427.1, z: -11768.8, km: 80.38 }, fuel: 'Benzina', poi: null, food: "McDonald's", wc: true, parking: true, trucks: true },
  },
  { id: 'dolni-roven', name: 'Dolní Roveň', road: 'D35', km: 151.594,
    S: { div: { x: 15249.5, z: 1415.7, km: 151.144 }, mer: { x: 16223.4, z: 1928.6, km: 152.226 }, fuel: 'Shell', poi: null, food: null, wc: true, parking: true, trucks: true },
    N: { div: { x: 16078.7, z: 1836, km: 152.058 }, mer: { x: 15091.9, z: 1321.6, km: 150.963 }, fuel: 'Shell', poi: null, food: null, wc: true, parking: true, trucks: true },
  },
]);

/**
 * Bridge decks per carriageway, [km low, km high] sorted, from the tile ways
 * flagged br (merged when less than 15 m apart). Plant nothing on them.
 */
export const BRIDGES = deepFreeze({
  E: [
    [2.335, 2.4], [13.664, 13.673], [13.737, 13.791], [14.001, 14.045], [18.014, 18.06], [21.406, 21.444],
    [26.222, 26.276], [29.496, 29.535], [32.678, 32.735], [33.916, 33.952], [35.906, 35.924], [40.53, 40.66],
    [40.965, 41.127], [41.571, 41.846], [42.134, 42.173], [42.449, 42.48], [42.639, 42.673], [42.974, 42.997],
    [43.313, 43.341], [43.739, 43.786], [44.342, 44.367], [45.269, 45.361], [55.119, 55.151], [56.511, 56.534],
    [56.825, 56.846], [59.777, 60.343], [62.491, 62.695], [62.948, 62.984], [63.286, 63.328], [63.476, 63.737],
    [63.873, 63.902], [67.961, 68.048], [68.896, 68.931], [71.581, 71.611], [72.875, 72.928], [73.96, 73.998],
    [75.112, 75.147], [77.243, 77.276], [78.393, 78.429], [79.877, 79.9], [80.291, 80.335], [81.628, 81.666],
    [83.482, 83.505], [86.319, 86.354], [87.35, 87.385], [87.984, 88.035], [88.194, 88.229], [89.468, 89.49],
    [95.012, 95.031], [95.241, 95.26], [95.362, 95.381], [95.48, 95.505], [95.686, 95.706], [98.434, 98.452],
    [99.812, 99.832], [100.365, 100.379], [101.469, 101.861], [105.457, 105.623], [110.333, 110.631],
  ],
  W: [
    [2.344, 2.403], [13.741, 13.798], [14.007, 14.054], [18.004, 18.051], [21.408, 21.449], [26.229, 26.285],
    [29.504, 29.539], [32.672, 32.733], [33.916, 33.951], [35.906, 35.925], [40.53, 40.66], [40.965, 41.127],
    [41.571, 41.846], [42.134, 42.173], [42.466, 42.497], [42.645, 42.68], [42.974, 42.997], [43.31, 43.335],
    [43.734, 43.782], [44.343, 44.367], [45.29, 45.381], [55.117, 55.151], [56.511, 56.534], [56.827, 56.846],
    [59.769, 60.334], [62.492, 62.697], [62.948, 62.983], [63.286, 63.327], [63.476, 63.736], [63.872, 63.903],
    [67.933, 68.025], [68.891, 68.921], [71.58, 71.609], [72.872, 72.923], [73.959, 74.003], [75.112, 75.147],
    [77.243, 77.275], [78.392, 78.43], [79.881, 79.904], [80.284, 80.328], [81.629, 81.665], [83.482, 83.505],
    [86.315, 86.351], [87.354, 87.39], [87.981, 88.031], [88.189, 88.225], [89.468, 89.49], [95.012, 95.031],
    [95.241, 95.26], [95.362, 95.381], [95.479, 95.503], [95.686, 95.706], [98.432, 98.45], [99.812, 99.832],
    [100.365, 100.379], [101.469, 101.861], [105.457, 105.623],
  ],
  S: [
    [126.93, 126.989], [128.489, 128.554], [129.354, 129.422], [129.89, 129.93], [130.442, 131.536], [131.802, 131.873],
    [132.283, 133.28], [133.564, 133.594], [135.249, 135.299], [136.44, 136.453], [137.64, 137.686], [138.059, 138.076],
    [139.755, 139.771], [140.204, 140.276], [141.791, 141.841], [142.014, 142.095], [143.934, 143.969], [144.067, 144.094],
    [144.28, 144.318], [144.63, 144.644], [146.156, 146.184], [146.245, 146.278], [150.498, 150.529], [150.717, 150.729],
    [150.886, 150.923], [152.95, 152.967], [153.126, 153.162], [154.748, 154.764], [155.007, 155.454], [155.665, 155.838],
    [156.339, 156.387], [158.04, 158.072],
  ],
  N: [
    [128.488, 128.553], [129.354, 129.423], [129.892, 129.931], [130.442, 131.536], [131.801, 131.873], [132.283, 133.28],
    [133.561, 133.591], [135.249, 135.299], [136.442, 136.455], [137.64, 137.686], [138.059, 138.076], [139.755, 139.772],
    [140.204, 140.276], [141.791, 141.841], [142.014, 142.095], [143.934, 143.969], [144.067, 144.094], [144.28, 144.317],
    [144.63, 144.644], [146.153, 146.181], [146.249, 146.282], [150.495, 150.525], [150.712, 150.724], [150.886, 150.923],
    [152.95, 152.968], [153.123, 153.159], [154.748, 154.764], [155.007, 155.455], [155.665, 155.838], [156.329, 156.377],
    [158.04, 158.071],
  ],
});

/**
 * The two green bridges (ecoducts). Under each the build dropped the tunnel
 * ways, leaving a hole per carriageway that js/roadpatches.js fills: a / b
 * are the tile way ends either side of the hole (travel order), deck the
 * deck length (cs.wikipedia: Žehuň 50 m, Voleč 78 m; the holes measure 47 to
 * 48 m and 79 m), km the centre on E.
 */
export const ECODUCTS = deepFreeze([
  { id: 'zehun', name: 'Ekodukt Žehuň', deck: 50, km: 51.498,
    E: { a: [-32581.9, -9975.1], b: [-32536.1, -9989], km0: 51.473, km1: 51.523 },
    W: { a: [-32539.9, -10001.2], b: [-32585.2, -9987.3], km0: 51.473, km1: 51.523 } },
  { id: 'volec', name: 'Ekodukt Voleč', deck: 78, km: 71.229,
    E: { a: [-13701.1, -10738.7], b: [-13627.4, -10710.4], km0: 71.193, km1: 71.265 },
    W: { a: [-13622.8, -10721.5], b: [-13696.7, -10750.3], km0: 71.192, km1: 71.265 } },
]);

/** E km where the D11 carries the D35 too (Sedlice to Plotiště, raw ref "D11;D35"). */
export const D35_SHARED = Object.freeze([84.357, 94.649]);
/**
 * E km where the D11 leaves the world's tiles (the edge of tile 1_-6: 1_-7 is
 * not in the manifest). The tile ways run on to km 110.631 over no terrain;
 * plan signs, traffic and services only below this.
 */
export const D11_WORLD_END_KM = 101.658;
