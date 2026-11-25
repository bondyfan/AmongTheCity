// A ticket for every train, bought on the phone (Frank, 22 Nov 2026: "na
// každej vlak si musím koupit lístek ... vytáhnu mobil a tam si to koupím").
// The rule under test is the one written at the top of js/tickets.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));
const { Trains } = await import('../js/trains.js');
const D = await import('../js/traindeck.js');
const { Tickets, kindOf, fare, sayText, CHECK_AFTER, MAX_HELD } = await import('../js/tickets.js');
const { ticketScreen } = await import('../js/phone-tickets.js');
const { PRICE } = await import('../js/prices.js');
const { blank, sanitize, serialize, parse } = await import('../js/savegame.js');

const scene = { add() {}, remove() {} };
const A = 'Pardubice-Pardubičky', B = 'Kostěnice';
function line() {
  const rails = [];
  for (let x = 3000; x > -6000; x -= 1000) rails.push({ p: [[x, 0], [x - 1000, 0]], t: 'rail', _id: rails.length + 1 });
  const pois = [{ p: [0, 8], t: 'station', n: A }, { p: [-3000, 8], t: 'station', n: B }];
  return { rails, pois, onTileLoaded() {}, chunkIndex: { has: () => true } };
}
const DT = 1 / 15;

// The game's own wiring (js/main.js), with a purse instead of the wallet.
function game(money = 1000) {
  // (the rider waits well off the line: a body standing where a coach stops is aboard it)
  const g = { money, said: [], rider: { pos: { x: 400, z: 400 }, y: 0 } };
  g.tk = new Tickets({
    pay: (n) => (g.money >= n ? ((g.money -= n), true) : false),
    say: (event, data) => g.said.push([event, data]),
  });
  g.tr = new Trains(scene, line(), { onBoard: (t) => g.tk.board(t), onAlight: () => g.tk.alight() });
  g.tr.update(0.01, null);
  g.tr.player = g.rider;
  g.R = g.tr.routes[0];
  g.dir = g.R.pts[0][0] > g.R.pts[g.R.pts.length - 1][0] ? 1 : -1;
  g.step = (t, n, until) => {
    for (let i = 0; i < n; i++) {
      g.tr.update(DT, { x: t.x, z: t.z });
      g.tk.update(DT, g.tr.riding, () => g.tr.alight());
      if (until?.()) return i;
    }
    return n;
  };
  /** A train standing at A with its doors open and the rider in its aisle. */
  g.aboard = (express = false) => {
    const stA = g.R.stops.find((s) => s.name === A);
    const t = g.tr._spawn(g.R, stA.s, g.dir, 3);
    if (express) { t.express = 1; t.label = 'R Pardubice – Praha'; }
    g.step(t, 15 * 30, () => t.halted && t.closed < 0.05);
    Object.assign(g.rider.pos, D.toWorld(t.frames[1], 2, 0));
    g.rider.y = t.frames[1].y + D.FLOOR;
    g.step(t, 2);
    assert.equal(g.tr.riding, t, 'he walked in: he rides');
    return t;
  };
  g.events = () => g.said.map((s) => s[0]);
  return g;
}

test('the phone sells a ticket for the money, keeps it, and refuses what cannot be paid', () => {
  const g = game(PRICE.train.local + PRICE.train.ticket + 10);
  assert.equal(fare('os'), PRICE.train.local);
  assert.equal(fare('r'), PRICE.train.ticket);
  assert.ok(PRICE.train.local > 0 && PRICE.train.fine > PRICE.train.ticket, 'riding without one costs more than any ticket');
  assert.deepEqual(g.tk.buy('os'), { ok: true, reason: null });
  assert.deepEqual(g.tk.buy('r'), { ok: true, reason: null });
  assert.equal(g.money, 10);
  assert.equal(g.tk.count('os'), 1);
  assert.equal(g.tk.count('r'), 1);
  assert.deepEqual(g.tk.buy('os'), { ok: false, reason: 'money' });
  assert.equal(g.tk.count('os'), 1, 'nothing for nothing');
  assert.equal(g.money, 10, 'and nothing taken');
  assert.equal(g.tk.buy('first class').reason, 'kind');
  assert.deepEqual(g.events(), ['bought', 'bought']);
  const rich = game(1e9);
  for (let i = 0; i < MAX_HELD; i++) assert.ok(rich.tk.buy('os').ok);
  assert.equal(rich.tk.buy('os').reason, 'full');
});

test('with a ticket: nobody stops him at the door, the conductor marks it once the train has left', () => {
  const g = game(1000);
  g.tk.buy('os');
  const t = g.aboard();
  assert.equal(kindOf(t), 'os');
  assert.equal(g.tk.ride.state, 'open');
  assert.equal(g.tk.count('os'), 1, 'standing at the platform uses nothing');
  // out again before it leaves: the ticket is still his
  g.tr.alight();
  assert.equal(g.tk.ride, null);
  assert.equal(g.tk.count('os'), 1);
  assert.ok(g.tr.board(t, g.rider));
  // it leaves; a few seconds on, the conductor
  g.step(t, 15 * 60, () => !t.halted);
  assert.equal(g.tk.ride.state, 'open', 'not checked as it pulls out');
  g.step(t, Math.ceil((CHECK_AFTER + 1) / DT));
  assert.equal(g.tk.ride.state, 'valid');
  assert.equal(g.tk.count('os'), 0, 'the ticket is used');
  assert.equal(g.money, 1000 - PRICE.train.local, 'no surcharge');
  assert.deepEqual(g.events(), ['bought', 'ok']);
  // to the next station and off; back on the same train needs no second one
  g.step(t, 15 * 400, () => t.halted);
  assert.equal(t.stopName, B);
  assert.ok(g.tr.alight());
  assert.equal(g.tk.ride, null);
  assert.ok(g.tr.board(t, g.rider));
  assert.equal(g.tk.ride.state, 'valid', 'the same train: still good');
  g.step(t, 15 * 60, () => !t.halted);
  g.step(t, Math.ceil((CHECK_AFTER + 1) / DT));
  assert.equal(g.money, 1000 - PRICE.train.local);
  assert.deepEqual(g.events(), ['bought', 'ok'], 'checked once');
});

test('a ticket bought on the phone after boarding, before the conductor comes, counts', () => {
  const g = game(1000);
  const t = g.aboard();
  assert.equal(g.tk.hintAboard().includes('bez jízdenky'), true);
  g.step(t, 15 * 60, () => !t.halted);
  g.step(t, Math.floor((CHECK_AFTER - 3) / DT));
  assert.equal(g.tk.ride.state, 'open');
  assert.ok(g.tk.buy('os').ok);
  assert.equal(g.tk.hintAboard(), 'jízdenku máš');
  g.step(t, Math.ceil(5 / DT));
  assert.equal(g.tk.ride.state, 'valid');
  assert.equal(g.tk.hintAboard(), '', 'nothing more to say about it');
  assert.equal(g.money, 1000 - PRICE.train.local);
});

test('without a ticket he pays the fare and the surcharge, once, and rides on', () => {
  const g = game(1000);
  const t = g.aboard();
  g.step(t, 15 * 60, () => !t.halted);
  g.step(t, Math.ceil((CHECK_AFTER + 1) / DT));
  assert.equal(g.money, 1000 - PRICE.train.local - PRICE.train.fine);
  assert.equal(g.tk.ride.state, 'valid', 'paid for now');
  assert.deepEqual(g.said.at(-1), ['fined', { kind: 'os', price: PRICE.train.local, fine: PRICE.train.fine }]);
  g.step(t, 15 * 400, () => t.halted);
  assert.equal(g.tr.riding, t, 'he is not put off');
  assert.equal(g.money, 1000 - PRICE.train.local - PRICE.train.fine, 'and not charged twice');
});

test('without a ticket and without the money the conductor puts him off at the next station', () => {
  const g = game(PRICE.train.local + PRICE.train.fine - 1);
  const start = g.money;
  const t = g.aboard();
  g.step(t, 15 * 60, () => !t.halted);
  g.step(t, Math.ceil((CHECK_AFTER + 1) / DT));
  assert.equal(g.tk.ride.state, 'off');
  assert.equal(g.money, start, 'what he cannot pay is not taken in part');
  assert.equal(g.said.at(-1)[0], 'broke');
  assert.match(g.tk.hintAboard(), /vystupuješ/);
  assert.equal(g.tr.riding, t, 'not thrown off a moving train');
  g.step(t, 15 * 400, () => !g.tr.riding);
  assert.equal(g.tr.riding, null, 'off it');
  assert.ok(t.halted && t.stopName === B, 'at the next station, at ' + t.stopName);
  assert.ok(t.closed < 0.2, 'through an open door');
  assert.equal(D.locate(t.frames, g.rider.pos.x, g.rider.pos.z), null, 'he stands outside the coach');
  assert.deepEqual(g.said.at(-1), ['off', { station: B }]);
  assert.equal(g.tk.ride, null);
});

test('the express wants its own ticket; an express ticket is taken on an ordinary train', () => {
  // an ordinary ticket on the express is no ticket
  let g = game(1000);
  g.tk.buy('os');
  let t = g.aboard(true);
  assert.equal(kindOf(t), 'r');
  assert.match(g.tk.hintNear(t), /jízdenka/);
  assert.match(g.tk.hintNear(t), /<kbd>L<\/kbd>/, 'the hint names the key of the phone');
  g.step(t, 15 * 60, () => !t.halted);
  g.step(t, Math.ceil((CHECK_AFTER + 1) / DT));
  assert.equal(g.money, 1000 - PRICE.train.local - PRICE.train.ticket - PRICE.train.fine);
  assert.equal(g.tk.count('os'), 1, 'the ordinary one is still in the phone');
  // the right one
  g = game(1000);
  g.tk.buy('r');
  t = g.aboard(true);
  assert.equal(g.tk.hintNear(t), 'jízdenku máš');
  g.step(t, 15 * 60, () => !t.halted);
  g.step(t, Math.ceil((CHECK_AFTER + 1) / DT));
  assert.equal(g.money, 1000 - PRICE.train.ticket);
  assert.equal(g.tk.count('r'), 0);
  // and the dearer one on an ordinary train, the cheaper one first
  g = game(1000);
  g.tk.buy('r');
  t = g.aboard(false);
  g.step(t, 15 * 60, () => !t.halted);
  g.step(t, Math.ceil((CHECK_AFTER + 1) / DT));
  assert.equal(g.tk.count('r'), 0);
  assert.equal(g.money, 1000 - PRICE.train.ticket, 'no surcharge');
  g = game(1000);
  g.tk.buy('r'); g.tk.buy('os');
  t = g.aboard(false);
  g.step(t, 15 * 60, () => !t.halted);
  g.step(t, Math.ceil((CHECK_AFTER + 1) / DT));
  assert.deepEqual(g.tk.snapshot(), { os: 0, r: 1 });
});

test('a train that reaches its station before the conductor reached him is checked there', () => {
  // (N skips to the next station: js/express.js halts the train there)
  const g = game(1000);
  const t = g.aboard();
  g.step(t, 15 * 60, () => !t.halted);
  g.step(t, 3);
  assert.equal(g.tk.ride.state, 'open');
  const st = g.R.stops.find((s) => s.name === B);
  t.s = g.tr.stopS(t, st);
  g.tr._halt(t, st, 14);
  g.step(t, 2);
  assert.equal(g.tk.ride.state, 'valid');
  assert.equal(g.said.at(-1)[0], 'fined');
});

test('a death or a teleport ends the ride, and the next train is a new ride', () => {
  const g = game(1000);
  g.tk.buy('os'); g.tk.buy('os');
  const t = g.aboard();
  g.step(t, 15 * 60, () => !t.halted);
  g.step(t, Math.ceil((CHECK_AFTER + 1) / DT));
  assert.equal(g.tk.count('os'), 1);
  g.tr.eject();
  assert.equal(g.tk.ride, null);
  Object.assign(g.rider.pos, { x: 400, z: 400 });
  // another train: the marked ticket was for the first one
  const t2 = g.tr._spawn(g.R, g.R.stops.find((s) => s.name === A).s, g.dir, 3);
  assert.notEqual(t2.id, t.id);
  g.step(t2, 15 * 30, () => t2.halted && t2.closed < 0.05);
  assert.ok(g.tr.board(t2, g.rider));
  assert.equal(g.tk.ride.state, 'open');
});

test('what the save keeps: the tickets in the phone, never the ride', () => {
  assert.deepEqual(blank().tickets, { os: 0, r: 0 });
  const g = game(1000);
  g.tk.buy('os'); g.tk.buy('os'); g.tk.buy('r');
  const saved = parse(serialize({ ...blank(), savedAt: 5, tickets: g.tk.snapshot() })).state;
  assert.deepEqual(saved.tickets, { os: 2, r: 1 });
  const t = g.aboard();
  g.step(t, 15 * 60, () => !t.halted);
  g.step(t, Math.ceil((CHECK_AFTER + 1) / DT));
  assert.equal(g.tk.count('os'), 1);
  // a load (js/career.js apply, reloadLast): the phone is as it was saved
  g.tk.restore(saved.tickets);
  assert.deepEqual(g.tk.snapshot(), { os: 2, r: 1 });
  assert.equal(g.tk.ride, null);
  assert.equal(g.tk.validOn, null);
  // a save from before tickets, and a hand-edited one
  assert.deepEqual(sanitize({ money: 5 }).tickets, { os: 0, r: 0 });
  assert.deepEqual(sanitize({ tickets: { os: 1e9, r: -3 } }).tickets, { os: 20, r: 0 });
  assert.deepEqual(sanitize({ tickets: 'many' }).tickets, { os: 0, r: 0 });
  g.tk.restore({ os: NaN, r: 2.9 });
  assert.deepEqual(g.tk.snapshot(), { os: 0, r: 2 });
  // career.js writes them with the money and reads both back
  const career = fs.readFileSync(new URL('../js/career.js', import.meta.url), 'utf8');
  assert.match(career, /tickets: tickets\.snapshot\(\)/);
  assert.equal(career.match(/tickets\.restore\(s\.tickets\)/g)?.length, 2, 'on a load and on going back to the last save');
});

test('the ticket screen: where he is, the trains there, the prices, what he holds', () => {
  const g = game(100);
  const stA = g.R.stops.find((s) => s.name === A);
  assert.deepEqual(g.tr.stationNear(10, 8), { name: A, x: 0, z: 8, d: 10 });
  assert.equal(g.tr.stationNear(10, 8, 5), null);
  // far from any station
  let s = ticketScreen({ tickets: g.tk, trains: g.tr, x: 1500, z: 8, money: g.money });
  assert.equal(s.place, 'Nejbližší stanice');
  assert.deepEqual(s.lines, [A + ' · 1,5 km']);
  assert.deepEqual(s.offers.map((o) => [o.kind, o.price, o.can]), [['os', PRICE.train.local, true], ['r', PRICE.train.ticket, false]]);
  assert.match(s.offers[1].why, /Chybí ti/);
  assert.match(s.note, /přirážku/);
  // at the station, nothing there yet
  s = ticketScreen({ tickets: g.tk, trains: g.tr, x: 20, z: 30, money: g.money });
  assert.equal(s.place, A);
  assert.deepEqual(s.lines, ['Teď tu žádný vlak nestojí']);
  // an express standing there: its ticket comes first
  const t = g.tr._spawn(g.R, stA.s, g.dir, 3);
  t.express = 1; t.label = 'R Pardubice – Praha';
  g.step(t, 15 * 30, () => t.halted && t.closed < 0.05);
  s = ticketScreen({ tickets: g.tk, trains: g.tr, x: 20, z: 30, money: 1000 });
  assert.match(s.lines[0], /^R Pardubice – Praha · odjezd za \d+ s$/);
  assert.deepEqual(s.offers.map((o) => o.kind), ['r', 'os']);
  assert.ok(s.offers.every((o) => o.can));
  // aboard it with nothing
  Object.assign(g.rider.pos, D.toWorld(t.frames[1], 2, 0));
  g.rider.y = t.frames[1].y + D.FLOOR;
  g.step(t, 2);
  s = ticketScreen({ tickets: g.tk, trains: g.tr, x: g.rider.pos.x, z: g.rider.pos.z, money: 1000 });
  assert.equal(s.place, 'Ve vlaku: R Pardubice – Praha');
  assert.equal(s.tone, 'warn');
  assert.match(s.status, /bez jízdenky/);
  g.money = 1000;
  g.tk.buy('r');
  s = ticketScreen({ tickets: g.tk, trains: g.tr, x: g.rider.pos.x, z: g.rider.pos.z, money: g.money });
  assert.equal(s.tone, 'good');
  assert.equal(s.offers[0].count, 1);
  g.step(t, 15 * 60, () => !t.halted);
  g.step(t, Math.ceil((CHECK_AFTER + 1) / DT));
  s = ticketScreen({ tickets: g.tk, trains: g.tr, x: g.rider.pos.x, z: g.rider.pos.z, money: g.money });
  assert.match(s.status, /označená/);
  assert.match(s.lines[0], /^Příští stanice: /);
});

test('every train is wired to the tickets, the phone has a key, and nothing says it in an em dash', () => {
  const main = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(main, /onBoard: \(t\) => tickets\.board\(t\)/, 'every train, not the express alone');
  assert.ok(!/_paid/.test(main), 'the charge at the express door is gone');
  assert.match(main, /tickets\.update\(dt, trains\.riding, \(\) => trains\.alight\(\)\)/);
  assert.match(main, /input\.onKey\('KeyL'/);
  assert.match(fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /<b>L<\/b> mobil/);
  for (const f of ['tickets.js', 'phone.js', 'phone-tickets.js']) {
    assert.ok(!fs.readFileSync(new URL('../js/' + f, import.meta.url), 'utf8').includes(String.fromCharCode(0x2014)), f);
  }
  for (const e of ['bought', 'ok', 'fined', 'broke', 'off']) {
    const t = sayText(e, { kind: 'os', price: 49, fine: 400, station: B });
    assert.ok(t.text && t.sub && t.icon, e);
  }
  assert.equal(sayText('nothing'), null);
});
