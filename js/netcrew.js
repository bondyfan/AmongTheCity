// ---- netcrew.js: the other players, in the glass of the cars they ride -----------
//
// A car is one opaque mesh and the people behind its windows are pictures the
// body shader paints into the glass (js/carglass.js): the driver and the front
// passenger, whoever the car has been TOLD sits there (js/cardoor.js setDriver,
// setPassenger). The local player tells it about themselves (js/player.js).
// Nobody told it about a PEER, so a friend in your passenger seat was a name
// tag over an empty seat: their body is placed on the seat by netcity, inside
// the shell, where no camera outside the car can see it. And a peer's own
// proxy car showed a stock civilian at the wheel instead of the peer.
//
// This is the telling, once a frame and only on a change:
//   begin()                      a new frame
//   show(uid, car, seat, cit)    peer `uid` sits in `seat` of `car` (anything
//                                with the car's mesh on it: a local car, a
//                                ghost record), as citizen `cit`
//   end(keep)                    whoever was not shown this frame is taken out
//                                of their glass again; keep(car, seat) says the
//                                local player has that seat now, so leave it
//
// Front seats only: the glass has no picture for the back row, so a peer in a
// back seat is not drawn from outside (their name tag still rides the car).
//
// No three.js here: the two setters are handed in, so node can test the rules.

export function makeNetCrew({ setDriver, setPassenger }) {
  const shown = new Map();   // uid -> { car, mesh, seat, cit, frame }
  let frame = 0;

  function put(s) {
    if (s.seat === 0) setDriver(s.car, { jacket: s.cit?.look?.jacket, cit: s.cit });
    else setPassenger(s.car, s.cit);
  }
  function take(s, keep) {
    // (a mesh that was rebuilt or dropped took its glass with it: nothing to undo)
    if (s.car.mesh !== s.mesh || !s.mesh) return;
    // seat 0 goes back to the rule every car follows: its stock driver while the lamps burn
    if (s.seat === 0) setDriver(s.car, undefined);
    else if (!keep?.(s.car, s.seat)) setPassenger(s.car, null);
  }

  return {
    begin() { frame++; },
    show(uid, car, seat, cit) {
      if (!car?.mesh || !cit || !(seat === 0 || seat === 1)) return;
      const s = shown.get(uid);
      if (s && s.car === car && s.mesh === car.mesh && s.seat === seat && s.cit === cit) { s.frame = frame; return; }
      if (s) take(s, null);
      const n = { car, mesh: car.mesh, seat, cit, frame };
      shown.set(uid, n);
      put(n);
    },
    end(keep = null) {
      for (const [uid, s] of shown) {
        if (s.frame === frame) continue;
        shown.delete(uid);
        take(s, keep);
        // (two peers reported the same seat, the double-book the seat book
        // settles a moment later: the one who is still there stays in the glass)
        for (const o of shown.values()) if (o.car === s.car && o.seat === s.seat && o.frame === frame) put(o);
      }
    },
    get size() { return shown.size; },
  };
}
