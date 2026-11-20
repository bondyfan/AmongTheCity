// Part two of the Last Train, in places. World metres, x east, z south (so
// north is the smaller z); a heading h faces (-sin h, -cos h). Every spot was
// read off the map tiles (public/data/tiles), none is invented:
//   the farm is the barn complex north of Brozany, the villa stands where the
//   map has "Perníková chaloupka" under Kunětická hora, the lock-ups are the
//   row of garages in Na Staré poště.
export const kerb = { x: 1209.6, z: 1448.5, h: 0.03 }; // Dražkovická 119, where the estate waits
export const start = { x: 1213.6, z: 1448.0, h: -Math.PI / 2 }; // on the pavement at his door
export const kombi = { x: 1211.0, z: 1451.5, h: -0.05 }; // the estate at the kerb, nose to the north

// --- the farm in Brozany
export const farm = {
  yard: { x: 2976, z: -3997 }, // the end of the farm's own road, between the barns
  van: { x: 2983.5, z: -3990.5, h: 2.2 }, // Jarda's van, nose to the way out
  // the van's way from the yard to the roadside by the forest: the farm road
  // down to the village street, then the road through Ráby (1.6 km)
  ride: [
    [2983.5, -3990.5], [2996, -4009], [3001, -4008], [3055, -3926], [3100, -3857], [3109, -3850], [3114.2, -3867.2],
    [3139.5, -3980.7], [3145.5, -4000.9], [3198.3, -4136.2], [3230.6, -4213.2], [3269.7, -4290], [3329.9, -4403.8],
    [3346, -4437.9], [3374.2, -4514.1], [3383.1, -4547.2], [3384, -4557.9], [3372.6, -4699.1], [3372, -4708.8],
    [3373.1, -4723.9], [3409.6, -4881.3], [3447.1, -5136.1], [3454, -5176],
  ],
};

// --- the villa in the forest (the map's "Perníková chaloupka")
// Its own frame: u along the drive that runs up the west wall (towards the
// car), v to the right of that (towards the house).
export const villa = {
  x: 3601.7, z: -5170.8, // where the drive leaves the forest road: the gate
  h: 0.1996, // the drive runs a little east of north
  road: [[3457.8, -5199], [3539.8, -5183.8], [3601.7, -5170.8]], // the walk in from the drop
  car: { u: 46.5, v: 0.4 }, // under the lean-to behind the house, nose to the gate
  camera: { u: 30.2, v: 2.6, up: 3.3 }, // on the house's corner, over the drive
  cone: { u0: 9, u1: 31, half: 4.2 }, // the strip of drive the camera sees
};
export function villaAt(u, v = 0) {
  const s = Math.sin(villa.h), c = Math.cos(villa.h);
  // the drive's direction is (sin h, -cos h), its right is (cos h, sin h)
  return { x: villa.x + u * s + v * c, z: villa.z - u * c + v * s };
}
export function villaLocal(x, z) {
  const s = Math.sin(villa.h), c = Math.cos(villa.h), dx = x - villa.x, dz = z - villa.z;
  return { u: dx * s - dz * c, v: dx * c + dz * s };
}
// The heading that faces along +u (up the drive, towards the car) and the one
// that faces back to the gate.
export const villaIn = -villa.h;
export const villaOut = Math.PI - villa.h;

// --- the way home
export const city = {
  centre: { x: 994.5, z: -495.7 }, // Masarykovo náměstí, where 17. listopadu begins
  anpr: { x: 1276, z: -2947 }, // the camera over Hradecká
  callAt: 760, // metres from the centre at which Vašek rings
  block: { x: 1016.4, z: -76, h: 3.2 }, // two patrol cars across the end of 17. listopadu (h: the street, southwards)
  blockSees: 110, // how close to the roadblock is too close
  garage: { x: 884.7, z: 110.6, h: Math.PI }, // in front of a lock-up in Na Staré poště, nose to the door
  door: { x: 884.7, z: 115.6 },
  vasek: { x: 888.3, z: 114.2 },
};

// The story's clock for part two (hours). The game's sun rises at five and the
// night is properly dark until a quarter to four (js/sky.js), so he leaves at
// half past two and steals the car in the last of the dark; day breaks on the
// way into town and it is seven on třída Míru (Frank, 20 Nov 2026: "už musí
// začínat svítat… na té třídě míru, tak už musí být třeba 7 ráno").
export const hours = { leave: 2.5, farm: 3.0, drop: 3.3, villa: 3.55, away: 4.15, centre: 7.0, garage: 7.5 };

export const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
