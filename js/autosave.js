// ---- Autosave points: the only moments the game is written down ----
// Frank, 20 Nov 2026: "To se musí ukládat jenom jako na autosavy". Not every
// twenty seconds, not when the tab is closed, not when you go down: the save
// is taken at a POINT, and loading it puts you back at that point. Quitting
// between two points loses what happened since the last one, which is the
// whole idea: a reload returns the game to the last completed mission, never
// to the street where somebody closed the tab.
//
// The points, and what the notice under "Uloženo" says at each:
//   mission  a mission has been completed (js/career.js checkpointStory, and
//            whatever ends the next missions calls autosave('mission'))
//   sleep    the player has slept in a flat of his own ("i když budeme spát,
//            když budeme mít svůj byt"). There is no flat yet: when there is,
//            its bed calls career.autosave('sleep') and nothing else changes.
//
// A new kind of point is one line in POINTS. js/savegame.js keeps which point
// wrote a save (`point`), so the menu and the load can tell them apart.
//
// Pure: no DOM, no game. js/career.js does the writing.

export const POINTS = Object.freeze({
  mission: Object.freeze({ sub: 'Mise splněna' }),
  sleep: Object.freeze({ sub: 'Vyspal ses doma' }),
});

export const isPoint = (p) => typeof p === 'string' && Object.hasOwn(POINTS, p);

/** The small card shown when a point has been written. */
export function notice(point) {
  return { text: 'Uloženo', icon: '💾', sub: POINTS[point]?.sub ?? '', ms: 3200 };
}

// Where part one of the campaign ends, for a save from before the autosave
// points (js/savegame.js MIGRATIONS[2]): on the street at Vašek's door,
// Dražkovická 119, facing it. The same spot js/prologue-parking.js stands him
// on when the table scene is over (doorAt(0, -1.8) of js/prologue-house.js),
// written out here because that file needs three.js and this one must not.
export const PART_ONE_END = Object.freeze({ x: 1213.65, z: 1448, h: -Math.PI / 2 });
