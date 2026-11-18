import * as THREE from 'three';
import { floorAt, openingCalls, trainZ, doorX } from './prologue-route.js';
import { scenery } from './prologue-kit.js';
import { station } from './prologue-station.js';
import { coach } from './prologue-coach.js';
import { makeCitizen } from './citizen.js';
import { storyHud } from './prologue-hud.js';

const place = ['Kolín', 'Pardubice hlavní nádraží'];
const walkHelp = 'WASD chůze · Shift běh · ← → nebo tažení pravou myší rozhlížení';
const bagX = 1.7,
  bagZ = 40;
export function createPrologue({ checkpoint, save, input, sound, prepareCity, exit }) {
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(67, 1, 0.035, 340);
  const hemi = new THREE.HemisphereLight(0xffe6dc, 0x9392a5, 1.72);
  const sun = new THREE.DirectionalLight(0xffcf9c, 1.55);
  sun.position.set(-20, 18, 36);
  scene.add(hemi, sun);
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(260, 40, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { night: { value: 0 } },
      vertexShader:
        'varying vec3 dir; void main(){dir=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: `varying vec3 dir; uniform float night;
      void main(){vec3 d=normalize(dir); float t=smoothstep(-.09,.58,d.y);
      vec3 c=mix(vec3(.85,.43,.29),vec3(.11,.16,.34),t);
      c=mix(c,mix(vec3(.31,.29,.36),vec3(.045,.067,.15),t),night);
      c+=vec3(.8,.42,.17)*pow(max(dot(d,normalize(vec3(-.72,.095,-.68))),0.),35.)*(1.-night);
      gl_FragColor=vec4(c,1.);
      #include <colorspace_fragment>
      }`
    })
  );
  scene.add(sky);
  const kits = [];
  const assemble = (build) => {
    const group = new THREE.Group();
    scene.add(group);
    const kit = scenery(group);
    build(kit);
    kit.finish();
    kits.push(kit);
    return group;
  };
  const origin = assemble((k) => station(k, false)),
    destination = assemble((k) => station(k, true));
  const carriage = assemble(coach);
  const people = [];
  function person(parent, uid, x, y, z, heading, sitting = false) {
    const body = makeCitizen({ uid, archetype: 'man' });
    parent.add(body.group);
    body.group.position.set(x, y, z);
    body.group.rotation.y = heading;
    if (sitting) body.sitPose(1, 0);
    people.push(body);
  }
  person(origin, 'pruvodci', 15.8, 0, -19.9, 0.65);
  person(destination, 'cestujici', -5, 0, -19.8, 2.4);
  person(carriage, 'cestujici-u-okna', -6.35, -0.27, trainZ - 1.08, Math.PI / 2, true);
  person(carriage, 'cestujici-s-taskou', 9.3, -0.27, trainZ + 1.08, -Math.PI / 2, true);
  const door = assemble((k) => {
    k.box(doorX, 1.44, trainZ + 1.49, 1.49, 2.55, 0.13, 0xb64539);
    k.box(doorX, 1.65, trainZ + 1.566, 0.83, 0.88, 0.025, 0x5f7686);
  });
  const bag = assemble((k) => {
    k.box(bagX, 0.34, bagZ, 0.48, 0.65, 0.3, 0x74503b);
    k.box(bagX, 0.31, bagZ + 0.16, 0.38, 0.35, 0.1, 0x9d7755);
    k.box(bagX, 0.03, bagZ + 0.45, 0.61, 0.06, 0.67, 0x7e857b);
  });
  const lineSide = assemble((k) => {
    k.box(0, -0.98, trainZ, 380, 0.31, 220, 0x4d594a);
    for (const dz of [-3.7, 3.7]) k.box(0, -0.73, trainZ + dz, 370, 0.14, 2.3, 0x77716c);
    for (let i = 0; i < 75; i++) {
      const x = i * 3 - 100,
        z = trainZ + (i % 2 ? 1 : -1) * (10 + (i % 7));
      if (i % 5 === 0) {
        k.box(x, 2, z, 4, 4, 3, 0x575369);
        k.box(x, 2, z + (z < trainZ ? 1.51 : -1.51), 0.84, 1, 0.04, 0xffcb87, 0, true);
      } else {
        k.box(x, 1.4, z, 0.19, 3, 0.19, 0x4f4440);
        k.box(x, 3.6, z, 2.2, 2.7, 2.1, 0x525e5d);
      }
    }
  });
  const treads = assemble((k) => {
    for (let i = 0; i < 28; i++) {
      const z = 2 + (i * 8) / 28,
        y = ((z - 10) * 3.6) / 8;
      k.box(1.12, y + 0.014, z, 2.03, 0.035, 0.2, 0x454c53);
      k.box(1.12, y + 0.036, z + 0.08, 2.01, 0.014, 0.024, 0xe9c476);
    }
  });
  let treadPhase = 0;
  const hud = storyHud();
  document.body.classList.add('on-last-train');
  let arrival = checkpoint === 'arrival';
  let phase = { bridge: 'ring', station: 'walk', coach: 'coach', arrival: 'alight' }[checkpoint] ?? 'ring';
  let x = 0,
    z = 68,
    y = 2.4,
    yaw = 0,
    pitch = 0,
    ride = 0,
    line = 0,
    seconds = 120,
    stride = 0;
  let missedTime = 0,
    conductorTime = 0,
    seatX = 4.8,
    seatSide = -1,
    closed = false;
  if (phase === 'walk') {
    z = 39;
    y = 0;
  }
  if (phase === 'coach') {
    x = doorX;
    z = trainZ;
    y = 0.18;
    yaw = Math.PI / 2;
  }
  if (arrival) {
    x = seatX;
    z = trainZ;
    y = 0.18;
    yaw = -Math.PI / 2;
  }
  const moving = () => ['bag', 'walk', 'coach', 'alight'].includes(phase);
  input.rpgMode = true;
  function nearBag() {
    return Math.hypot(x - bagX, z - bagZ) < 2.3;
  }
  function atSeat() {
    return x < 10.9 && x > -8.65 && Math.abs(z - trainZ) < 0.5;
  }
  function outdoors() {
    return z > 27.8 && Math.abs(x) < 2.5;
  }
  function interact() {
    if (closed || document.body.dataset.panelOpen) return;
    if (phase === 'ring') {
      phase = 'call';
      line = 0;
    } else if (phase === 'call') {
      if (++line === openingCalls.length) phase = 'bag';
    } else if (phase === 'bag' && nearBag()) {
      phase = 'walk';
      save('station');
    } else if (phase === 'late') {
      phase = 'walk';
      missedTime = 0;
      x = 0;
      z = 38;
      y = 0;
      yaw = 0;
      pitch = 0;
      seconds = 120;
    } else if (phase === 'coach' && atSeat()) {
      seatX = Math.max(-8.2, Math.min(10.14, -8.2 + Math.round((x + 8.2) / 2.62) * 2.62));
      seatSide = Math.cos(yaw) > 0 ? -1 : 1;
      prepareCity();
      phase = 'ride';
      ride = 0;
      yaw = seatSide < 0 ? 0 : Math.PI;
      pitch = -0.04;
      sound('train_doors', 0.55);
    } else if (phase === 'seated') {
      phase = 'alight';
      x = seatX;
      z = trainZ;
      y = 0.18;
      yaw = -Math.PI / 2;
      pitch = 0;
    }
  }
  hud.button.onclick = interact;
  const key = (e) => {
    if (e.code === 'KeyE' && !e.repeat && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      interact();
    }
  };
  window.addEventListener('keydown', key);
  function close() {
    closed = true;
    window.removeEventListener('keydown', key);
    document.body.classList.remove('on-last-train');
    people.forEach((body) => body.dispose());
    hud.close();
    kits.forEach((k) => k.dispose());
    sky.geometry.dispose();
    sky.material.dispose();
    scene.clear();
    input.takeDrag();
    input.cancelCombat();
    input.keys.clear();
  }
  function move(dt) {
    const drag = input.takeDrag();
    yaw -= drag.x * 0.003;
    pitch = THREE.MathUtils.clamp(pitch - drag.y * 0.003, -1.1, 1.1);
    yaw += dt * 1.85 * (Number(input.keys.has('ArrowLeft')) - Number(input.keys.has('ArrowRight')));
    if (!moving()) return;
    const side = Number(input.keys.has('KeyD')) - Number(input.keys.has('KeyA'));
    const ahead = -input.moveZ;
    const speed = ((input.selecting ? 5.8 : 3.3) * dt) / Math.max(1, Math.hypot(side, ahead));
    const dx = (Math.cos(yaw) * side - Math.sin(yaw) * ahead) * speed;
    const dz = (-Math.sin(yaw) * side - Math.cos(yaw) * ahead) * speed;
    // Substep even a long frame so thin partitions and stair landings hold.
    const parts = Math.max(1, Math.ceil(speed / 0.085));
    for (let i = 0; i < parts; i++) {
      for (const [nx, nz] of [
        [x + dx / parts, z],
        [null, z + dz / parts]
      ]) {
        const px = nx ?? x;
        if (phase === 'bag' && nz < 36) continue;
        if (phase === 'coach' && nz > trainZ + 1.32) continue;
        if (arrival && px < 0.16 && px > -0.16 && nz > 2 && nz < 10) continue;
        const floor = floorAt(px, nz, y, arrival);
        if (floor !== null) {
          x = px;
          z = nz;
          y = floor;
        }
      }
    }
    if (side || ahead) stride += speed * 1.75;
    if (arrival && x > 0.16 && x < 2 && z > 2 && z < 10) {
      z = Math.min(10, z + dt * 0.82);
      y = ((z - 10) * 3.6) / 8;
    }
    if (phase === 'walk' && Math.abs(z - trainZ) < 0.9) {
      phase = 'coach';
      conductorTime = 3.4;
      save('coach');
      sound('station_bell', 0.35);
    }
    if (phase === 'alight' && outdoors()) {
      save('forecourt');
      close();
      exit();
    }
  }
  function routeHint() {
    if (arrival) {
      if (z < -20.97 && Math.abs(z - trainZ) < 2)
        return x < 12.8 ? 'Uličkou k nástupním dveřím →' : 'Vystup na nástupiště';
      if (y > -1 && z < 0) return 'Sejdi po schodech do podchodu';
      if (z < 2) return 'Podchodem k označení Východ • Hala';
      if (z < 10) return 'Vyjdi do odbavovací haly';
      return 'Vyjdi před nádraží za Vaškem';
    }
    if (z > 28) return 'Stihni poslední vlak do Pardubic';
    if (z > 2) return 'Projdi halou do podchodu';
    if (y < -2.9 && x < 3) return 'Nástupiště 2 • odboč vpravo ke schodům';
    if (x < 10.9 && y < -0.25) return 'Vyjdi po schodech na nástupiště';
    return 'Nastup otevřenými dveřmi do modrého vozu';
  }
  function drawHud() {
    let title = '',
      help = walkHelp,
      action = '',
      speaker = '',
      text = '';
    switch (phase) {
      case 'ring':
        title = 'Nemocnice volá';
        action = 'Přijmout hovor';
        break;
      case 'call':
        [speaker, text] = openingCalls[line];
        title = line < 4 ? 'Hovor z nemocnice' : line === 4 ? 'Zpráva od mámy' : 'Vašek';
        action = line === 4 ? 'Zvednout Vaškovi telefon' : 'Pokračovat';
        break;
      case 'bag':
        title = 'Vezmi si batoh na konci mostu';
        if (nearBag()) action = 'Vzít batoh';
        break;
      case 'walk':
        title = routeHint();
        help =
          'Odjezd za ' +
          Math.floor(Math.ceil(seconds) / 60) +
          ':' +
          String(Math.ceil(seconds) % 60).padStart(2, '0') +
          ' · ' +
          walkHelp;
        break;
      case 'late':
        title = 'Poslední vlak odjel';
        action = 'Zkusit cestu od mostu znovu';
        break;
      case 'coach':
        if (conductorTime > 0) {
          speaker = 'Průvodčí';
          text = 'Dobrý, vidím vás. Pojďte.';
        }
        title = 'Projdi vozem a vyber si místo u okna';
        if (atSeat()) action = 'Sednout si';
        break;
      case 'ride':
        title = 'Poslední vlak do Pardubic';
        help = '← → nebo myš • výhled z okna';
        if (ride > 4 && ride < 10) {
          speaker = 'Vašek · zpráva';
          text = 'Čekám na parkovišti před hlavákem. Až vystoupíš, projdi halou ven.';
        }
        break;
      case 'seated':
        title = 'Pardubice hlavní nádraží';
        action = 'Vstát ze sedadla';
        break;
      case 'alight':
        title = routeHint();
        break;
    }
    if (phase === 'ring' || phase === 'call') help = 'Most přes Labe · soumrak';
    hud.guide(phase === 'ride' ? 'Kolín → Pardubice' : place[Number(arrival)], title, help);
    hud.say(speaker, text);
    hud.action(action);
    hud.phone(
      phase === 'ring' ? 'Nemocnice' : phase === 'call' ? (line === 4 ? 'Máma' : line < 4 ? 'Nemocnice' : 'Vašek') : '',
      phase === 'ring' || (phase === 'call' && line === 4) ? '' : 'Probíhá hovor'
    );
  }
  return {
    dispose: close,
    frame(dt, renderer) {
      if (closed) return;
      if (document.hidden || document.body.dataset.panelOpen) dt = 0;
      conductorTime = Math.max(0, conductorTime - dt);
      move(dt);
      if (closed) return;
      if (phase === 'walk' && (seconds = Math.max(0, seconds - dt)) === 0) phase = 'late';
      if (phase === 'ride') {
        ride += dt;
        if (ride >= 16) {
          arrival = true;
          phase = 'seated';
          save('arrival');
          sound('station_bell', 0.5);
        }
      }
      const t = Math.min(1, ride / 16);
      origin.visible = !arrival && t < 0.48;
      origin.position.x = -110 * t * t * 11;
      destination.visible = arrival || t > 0.58;
      destination.position.x = arrival ? 0 : 140 * (1 - t) * (1 - t) * 5;
      lineSide.visible = phase === 'ride' && t > 0.14 && t < 0.86;
      lineSide.position.x = 75 - 150 * t;
      if (phase === 'late') missedTime += dt;
      carriage.position.x = Math.min(155, missedTime * missedTime * 1.4);
      door.position.x = carriage.position.x;
      door.visible = phase === 'late' || (phase === 'ride' && t < 0.97);
      bag.visible = phase === 'bag' || phase === 'call' || phase === 'ring';
      treads.visible = arrival;
      if (arrival) {
        treadPhase = (treadPhase + dt * 0.82) % (8 / 28);
        treads.position.set(0, (treadPhase * 3.6) / 8, treadPhase);
      }
      const night = arrival ? 1 : t;
      sky.material.uniforms.night.value = night;
      if (phase === 'ride' || phase === 'seated') {
        camera.position.set(seatX - 0.38, 1.37, trainZ + seatSide * 1.01);
      } else camera.position.set(x, y + 1.64 + Math.sin(stride) * 0.024, z);
      camera.rotation.order = 'YXZ';
      camera.rotation.set(pitch, yaw, 0);
      const aspect = renderer.domElement.clientWidth / Math.max(1, renderer.domElement.clientHeight);
      if (camera.aspect !== aspect) {
        camera.aspect = aspect;
        camera.updateProjectionMatrix();
      }
      drawHud();
      renderer.render(scene, camera);
    }
  };
}
