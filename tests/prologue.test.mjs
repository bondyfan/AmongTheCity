import test from 'node:test';
import assert from 'node:assert/strict';
import { bridge, stationExit, storyStart } from '../js/prologue-route.js';
import { blank, parse, serialize } from '../js/savegame.js';

import { readFileSync, statSync } from 'node:fs';
import { register } from 'node:module';
import { railPose, lineLength } from '../js/story-rail.js';
register(new URL('./three-alias.mjs', import.meta.url));
const { Navigation } = await import('../js/navigation.js');

test('Kolín bridge, the whole railway and the forecourt share a drivable world', () => {
  const root = new URL('../public/',import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('data/manifest.json', root)));
  const tiles = manifest.tiles.filter(t => t.tx>=-9 && t.tx<=0 && t.tz>=-1 && t.tz<=0);
  const byId = new Set(tiles.map(t => t.tx+'_'+t.tz));
  for(let s=0; s<=lineLength; s+=100) {
    const p=railPose(s), id=Math.floor(p.x/4800)+'_'+Math.floor(p.z/4800);
    assert.ok(byId.has(id),'missing world tile '+id);
  }
  assert.ok(lineLength>41000 && lineLength<43000);
  const roads=[];
  for (const t of tiles) {
    assert.equal(statSync(new URL('data/terrain/'+t.tx+'_'+t.tz+'.bin',root)).size,241*241*2);
    roads.push(...JSON.parse(readFileSync(new URL(t.f,root))).roads);
  }
  const nav=new Navigation({roads});
  nav.setDestination(stationExit.x,stationExit.z);
  nav.reroute(bridge.x,bridge.z);
  assert.ok(nav.route?.length>50);
  assert.equal(nav.partial,false);
  assert.ok(nav.remainingM>39000);
});
test('chapter checkpoints round-trip, fresh single player starts in Kolín and legacy saves continue', () => {
  for (const stage of ['bridge', 'station', 'coach', 'arrival', 'forecourt', 'done']) {
    assert.equal(parse(serialize({ ...blank(), prologue: stage })).state.prologue, stage);
    assert.equal(storyStart(true, 'pardubice', stage, false), stage);
  }
  assert.equal(storyStart(true, 'pardubice', null, true), 'bridge');
  assert.equal(storyStart(true, 'pardubice', null, false), null);
  assert.equal(storyStart(true, 'praha', null, true), null);
  assert.equal(storyStart(true, null, null, true), null);
  assert.equal(storyStart(false, 'pardubice', 'arrival', false), null);
  assert.equal(parse('{"v":2,"pos":{"x":20,"z":-121}}').state.prologue, null);
});

test('an evening car park keeps the two door approaches free for the handover', async () => {
  const { ParkingLots } = await import('../js/parkinglots.js');
  const parkedAtNight = (reserved) => {
    const lot = { t: 'parking', o: [[0, 0], [42, 0], [42, 18], [0, 18]] };
    const parked = [];
    const vehicles = { add: (kind, x, z, heading) => ({ kind, x, z, heading }) };
    new ParkingLots({ paved: [lot] }, vehicles, null, parked).update(1, { x: 0, z: 0 }, 0, reserved);
    return parked;
  };
  const regular = parkedAtNight(null);
  assert.ok(regular.length > 6);
  const reserved = regular[4];
  const duringHandover = parkedAtNight(reserved);
  assert.ok(duringHandover.length > 0);
  assert.ok(duringHandover.every(car => Math.hypot(car.x - reserved.x, car.z - reserved.z) >= 5));
});

test('every replay selects another connected platform and the countdown survives a save', async()=>{
  const {newTrip,platforms}=await import('../js/prologue-route.js');
  const {routeFor}=await import('../js/story-rail.js');
  const starts=[];
  for(const platform of platforms){
    for(const random of [0,.99])assert.notEqual(newTrip(platform,()=>random).platform,platform);
    const route=routeFor(platform);
    starts.push(route.railPose(0));
    assert.ok(Math.abs(route.lineLength-lineLength)<600);
    assert.deepEqual(route.railPose(route.lineLength),railPose(lineLength));
    const trip={platform,remaining:82.5};
    assert.deepEqual(parse(serialize({...blank(),storyTrip:trip})).state.storyTrip,trip);
  }
  for(let i=1;i<starts.length;i++) assert.ok(Math.hypot(starts[i].x-starts[i-1].x,starts[i].z-starts[i-1].z)>8);
});
