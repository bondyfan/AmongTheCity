// The five minutes between the ticket and the doors (js/flight-schedule.js),
// the list of destinations a desk offers (js/flight-destinations.js) and the
// desks themselves (js/flight-checkin.js) with stubs for the HUD and the
// wallet. Frank, 25 Nov 2026: choose where to fly, only the Seychelles for
// now, about 20 000 Kč, and off within five REAL minutes of buying.
import test from 'node:test';
import assert from 'node:assert';

const { SCHEDULE, newSchedule, scheduleAt, countdownText } = await import('../js/flight-schedule.js');
const { destinationsFrom } = await import('../js/flight-destinations.js');
const { ROUTES, routesFrom, newTrip, advance } = await import('../js/flight-trip.js');
const { checkIn } = await import('../js/flight-checkin.js');
const { PRICE } = await import('../js/prices.js');

test('a flight leaves at most five real minutes after the ticket, boarding within half a minute', () => {
  assert.equal(SCHEDULE.departs, 300);
  assert.ok(SCHEDULE.boarding <= 30);
  const s = newSchedule(100);
  assert.equal(scheduleAt(s, 100).phase, 'checkin');
  assert.equal(scheduleAt(s, 100 + SCHEDULE.boarding).phase, 'boarding');
  assert.equal(scheduleAt(s, 100 + SCHEDULE.lastCall + 1).phase, 'lastCall');
  assert.equal(scheduleAt(s, 100 + SCHEDULE.closing + 1).phase, 'closing');
  assert.equal(scheduleAt(s, 100 + 300).phase, 'due');
  assert.equal(scheduleAt(s, 100 + 60).left, 240);
  // the desks that are the whole terminal open boarding at once
  const q = newSchedule(50, true);
  assert.ok(scheduleAt(q, 50).open);
  assert.equal(scheduleAt(q, 50).left, 300 - SCHEDULE.boarding);
});

test('the countdown reads as a Czech board would say it', () => {
  assert.equal(countdownText(299), 'za 5 min');
  assert.equal(countdownText(61), 'za 2 min');
  assert.equal(countdownText(42), 'za 50 s');
  assert.equal(countdownText(0), 'nyní');
});

test('every desk lists real places, and only the Seychelles (or the way home) can be bought', () => {
  for (const home of ['LKPD', 'LKPR']) {
    const list = destinationsFrom(home);
    const open = list.filter((d) => d.open);
    assert.deepEqual(open.map((d) => d.id), ['sez'], home + ' sells Mahé and nothing else yet');
    assert.equal(open[0].fare, 20000);
    assert.ok(list.filter((d) => !d.open).length >= 5, 'the rest of the list says it is coming');
  }
  const home = destinationsFrom('SEZ').filter((d) => d.open).map((d) => d.id);
  assert.deepEqual(home.sort(), ['ped', 'prg'], 'from Mahé you choose Pardubice or Prague');
  assert.equal(PRICE.flight.mahe, 20000);
});

test('each route lands where the page switch puts the passenger', () => {
  assert.equal(ROUTES.out.spawn, 'sez-arrival');
  assert.equal(ROUTES.prgOut.spawn, 'sez-arrival');
  assert.equal(ROUTES.home.spawn, 'pce-arrival');
  assert.equal(ROUTES.homePrg.spawn, 'prg-arrival');
  assert.deepEqual(routesFrom('LKPR').map((r) => r.dir), ['prgOut']);
  for (const r of Object.values(ROUTES)) assert.ok(r.pa && r.dest && r.toward && r.home, r.dir + ' has its announcements and its Czech');
});

// ---- the desks, with stubs ------------------------------------------------------
function desks({ passage = false, story = false, money = 50000 } = {}) {
  let trip = newTrip();
  const said = [], pa = [];
  const wallet = { money: () => money, canPay: (n) => n <= money, pay: (n) => (n <= money ? ((money -= n), true) : false) };
  const c = checkIn({
    player: { pos: { x: 0, z: 0 } }, wallet, say: (who, what) => said.push([who, what]),
    steps: null, passage: passage ? { busy: false, nearDesk: () => true, nearAirside: () => false, through: () => {} } : null,
    terminal: null, pa: { say: (id) => pa.push(id), subtitle: () => '' }, homeId: passage ? 'SEZ' : 'LKPD',
    storyBusy: () => story, getTrip: () => trip, setTrip: (t) => { trip = t; }, sold: () => {},
  });
  return { c, said, pa, trip: () => trip, set: (t) => { trip = t; }, money: () => money };
}

test('buying takes the fare, and the boarding announcement follows twenty seconds later', () => {
  const d = desks();
  assert.ok(d.c.buy({ route: 'out' }));
  assert.equal(d.money(), 30000);
  assert.equal(d.trip().state, 'ticket');
  d.c.tick(5);
  assert.deepEqual(d.pa, []);
  d.c.tick(16);
  assert.deepEqual(d.pa, ['board-740']);
  d.c.tick(200);
  d.c.tick(60);
  assert.deepEqual(d.pa, ['board-740', 'last-740', 'close-740']);
});

test('a passenger who never reached the gate is put on the next flight, free, boarding at once', () => {
  const d = desks();
  d.c.buy({ route: 'out' });
  d.c.tick(301);
  assert.equal(d.money(), 30000, 'the rebooking costs nothing');
  assert.equal(d.c.schedule.phase, 'boarding');
  assert.ok(d.said.some(([, w]) => /nestihl/.test(w)));
});

test('one already past the gate is waited for', () => {
  const d = desks();
  d.c.buy({ route: 'out' });
  d.set(advance(advance(d.trip(), 'security').trip, 'gate').trip);
  d.c.tick(301);
  assert.equal(d.c.schedule.phase, 'due', 'no new flight: this one waits');
  assert.ok(d.said.some(([, w]) => /čekáme/.test(w)));
});

test('the desk before a solid terminal sells, checks and boards in one', () => {
  const d = desks({ passage: true });
  assert.ok(d.c.buy({ route: 'home' }));
  assert.equal(d.trip().state, 'boarding');
  d.c.tick(0.1);
  assert.deepEqual(d.pa, ['board-741']);
});

test('nothing is sold while the campaign is under way, and the desk says why', () => {
  const d = desks({ story: true });
  assert.equal(d.c.buy({ route: 'out' }), false);
  assert.equal(d.money(), 50000);
  const p = desks({ passage: true, story: true });
  assert.ok(p.c.use({ x: 0, z: 0 }));
  assert.ok(p.said.some(([, w]) => /příběh/.test(w)));
});
