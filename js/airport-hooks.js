// ---- airport-hooks.js: one answer for the world, from the terminal and the airliner ----
// js/city.js asks one object (world.airport) where a walker stands and what
// stops him, the way it asks world.stores and world.storyCoach. Two things
// at an airport answer: the terminal near set (js/airport-terminal.js: its
// floor slab, its doors) and the flight (js/flight.js: the cabin, the
// airstairs, the officer at the security lanes). main.js plugs them in and
// out; whichever is missing simply says nothing.
//
//   carrying(x, z)            inside the cabin: then only the cabin counts
//   floor(x, z, maxY)         the highest of their floors at or below maxY
//   collide(pos, r, opts)     either of them pushed the walker (mutates pos)
//   covered / lid / outside   the camera, inside the terminal (main.js)

export function airportHooks() {
  return {
    terminal: null,
    flight: null,
    carrying(x, z) { return !!this.flight?.hooks.carrying(x, z); },
    floor(x, z, maxY) {
      const a = this.flight?.hooks.floor(x, z, maxY) ?? -Infinity;
      const b = this.terminal?.floor(x, z, maxY) ?? -Infinity;
      return a > b ? a : b;
    },
    collide(pos, r, opts) {
      const a = this.flight?.hooks.collide(pos, r, opts) ?? false;
      const b = opts?.interior ? (this.terminal?.collide(pos, r, opts) ?? false) : false;
      return a || b;
    },
    covered(x, z) { return !!this.terminal?.covered(x, z); },
    lid(x, z) { return this.terminal?.lid(x, z) ?? null; },
    outside(tx, tz, x, z) { return !!this.terminal?.outside(tx, tz, x, z); },
  };
}
