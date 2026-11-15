// ---- city life: the wiring between the crowd, the traffic and the buses --------
// pedestrians.js must not import traffic.js and traffic.js must not import
// pedestrians.js: they are two consumers of one shared clock, not a stack. But
// a walker has to know when the lights let them cross and whether a car is
// coming, and a driver has to know who is on the zebra. main.js used to be
// where every such hook was tied by hand; this module is that knot, in one
// place, so main.js makes one call after it has built the pieces and one call
// a frame.
//
// Nothing here owns state the co-op world shares: every hook is a question one
// module asks another about facts both clients already hold.

import { worldT } from './worldclock.js';
import { hourAt, isWeekend, trafficWeekK } from './dayrhythm.js';
import { Buses } from './buses.js';
import { KerbParking, KERB_INTRUDES } from './kerbparking.js';
import { SITE } from './crowdsites.js';
import { TransitDress } from './transitdress.js';
import { StopNames } from './stopnames.js';
import { TrolleyMasts } from './trolleymasts.js';
import { Trams } from './trams.js';
import { TramDraw } from './tramdraw.js';
import { nightKOf } from './sky.js';
import { tramGround } from './tramground.js';
import { TramStops } from './tramstops.js';
import { TramWait } from './tramwait.js';

/**
 * Tie the crowd to the traffic. Every argument is something main.js already
 * built; any of the optional ones may be null.
 *   { city, traffic, peds, vehicles, world, parked }
 * Returns { update(dt, pos, t01), trafficK() }.
 */
export function wireCityLife({ city, traffic, peds, vehicles = null, world = null, parked = null }) {
  if (traffic && peds) {
    // who the drivers give way to: one record per walker on a carriageway or
    // about to step onto one. The same array for the life of the session.
    traffic.walkers = peds.crossers;
    // when the lights let a walker cross (pure in shared time, so it can be
    // baked into the shared timelines), and whether something is bearing down
    // on a crossing right now (local, like the lag it causes)
    peds.signalWait = (x, z, rdx, rdz, t, crossT) => traffic.walkWait(x, z, rdx, rdz, t, crossT);
    peds.roadBusy = (cx, cz, hw, need, stops) => traffic.threatens(cx, cz, hw, need, stops);
  }
  // buses and trolleybuses on their lines (js/buses.js, the real ones through
  // js/realtransit.js): trips are traffic schedules, the crowd reads the
  // timetable and the doors
  const buses = traffic ? new Buses(city, traffic) : null;
  if (buses && peds) {
    peds.busEta = (x, z, t) => buses.eta(x, z, t);
    peds.busAt = (x, z) => buses.standingAt(x, z);
    peds.busNear = (x, z) => buses.approaching(x, z);
  }
  // cars along the kerbs of residential streets (js/kerbparking.js). The
  // traffic is told which side of a street they stand on, and keeps off it.
  const kerb = (vehicles && parked && city.chunkIndex)
    ? new KerbParking(city, vehicles, world, parked,
      peds ? (x, z) => !!peds.sites.has(SITE.STOP, x, z, 18) : null)
    : null;
  if (kerb && traffic) { traffic.kerbOf = (road) => kerb.sideOf(road); traffic.kerbIntrudes = KERB_INTRUDES; }
  // the masts that carry the trolley wire, as things a car can knock down
  // (js/trolleymasts.js), and what a bus on a line wears: destination
  // displays, trolley poles on the wire, off it where a mast is down
  const masts = (vehicles?.scene?.add && world?.built) ? new TrolleyMasts({ scene: vehicles.scene, city, world }) : null;
  const dress = (buses && vehicles) ? new TransitDress({ traffic, vehicles, world, deadAt: masts?.deadAt ?? null }) : null;
  // …and the stops nearest the player wear their names (js/stopnames.js)
  const names = (buses && vehicles?.scene?.add && typeof document !== 'undefined')
    ? new StopNames({ scene: vehicles.scene, city, nearEdges: buses.real._near,
      standY: world?.walkY ? (x, z) => world.walkY(x, z) : null })
    : null;
  // Prague's trams on their rails (js/trams.js): the route files reach them
  // through the real lines' fetcher, the traffic and the crowd give way to them
  const ground = tramGround(city, world?.terrain ?? null, world?.walkY ? (x, z) => world.walkY(x, z) : null);
  const trams = buses ? new Trams({
    draw: (vehicles?.scene?.add && typeof document !== 'undefined') ? new TramDraw(vehicles.scene) : null,
    groundY: ground.groundY, loadedAt: ground.loadedAt,
    traffic, clock: () => worldT(), nightK: (t01) => nightKOf(t01 ?? 0.5),
  }) : null;
  if (trams) buses.real.onTramRoute = (file, r) => trams.addRoute(file, r);
  if (trams && peds?.roadBusy) {
    const busy = peds.roadBusy;
    peds.roadBusy = (cx, cz, hw, need, stops) => busy(cx, cz, hw, need, stops) || trams.threatens(cx, cz, hw);
  }
  // …people wait at their platforms, and get on and off (js/tramwait.js):
  // the crowd asks the same three questions it asks of a bus
  const tramWait = (trams && peds?.sites) ? new TramWait(trams, peds) : null;
  if (tramWait) {
    const eta = peds.busEta, at = peds.busAt, near = peds.busNear;
    peds.busEta = (x, z, t) => Math.min(eta ? eta(x, z, t) : Infinity, tramWait.eta(x, z, t));
    peds.busAt = (x, z) => tramWait.standingAt(x, z) ?? (at ? at(x, z) : null);
    peds.busNear = (x, z) => tramWait.approaching(x, z) || (near ? near(x, z) : false);
  }
  // …and their stops wear a post with the tram plate and the name
  const tramStops = trams?.draw ? new TramStops({ scene: vehicles.scene, trams,
    standY: world?.walkY ? (x, z) => world.walkY(x, z) : null }) : null;
  if (trams) trams.wait = tramWait;
  if (trams && typeof window !== 'undefined') window.trams = trams;     // for checks in the console
  return {
    buses, kerb, dress, names, masts, trams, tramWait,
    update(dt, pos, t01) {
      buses?.update(dt, pos);
      trams?.update(dt, pos, t01);
      tramWait?.update(pos);
      tramStops?.update(dt, pos);
      masts?.update(dt, pos);
      dress?.update(dt, t01);
      names?.update(dt, pos);
      kerb?.update(dt, pos, t01);
    },
    /** What the day of the week does to main.js's own hourly traffic curve. */
    trafficK() {
      const wt = worldT();
      return trafficWeekK(hourAt(wt), isWeekend(wt));
    },
  };
}
