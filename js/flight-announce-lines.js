// ---- flight-announce-lines.js: what the airport and the cabin say on the flight ----
// Pure data, no DOM and no audio. Each line is rendered to public/assets/flight/<id>.mp3
// by scripts/gen-flight-audio.mjs, and js/flight-announce.js plays it. The generator
// imports this file, so the text that is spoken and the text that is checked are the
// same string.
//
// Roles: 'pa' is the airport's public address, 'crew' is the cabin crew, 'captain' is
// the captain over the aircraft PA. Each line has its language parts in the order they
// are spoken. Airport lines at Pardubice and Praha are Czech first, then English; at
// Seychelles International they are English first, then Czech. Cabin lines are Czech
// first, then English, everywhere. The subtitle is Czech and short, for the HUD.
//
// Nothing here says a clock time or a temperature: both change while the game runs.
// The carrier is ATC, an invented airline.

export const ROLES = ['pa', 'crew', 'captain'];

// The two chimes are sounds, not speech: they have a file, no text, and are played
// before the line (chime for the airport, cabin-chime for the aircraft).
export const SOUND_IDS = ['chime', 'cabin-chime'];

const pa = (id, first, second, subtitle) => ({
  id,
  role: 'pa',
  parts: [first, second],
  subtitle,
});

export const LINES = [
  // ---- gate announcements, flight 740: Pardubice to Mahé via Dubai, gate 2 ----
  pa('board-740',
    { lang: 'cs', text: 'Dámy a pánové, nástup do letu sedm set čtyřicet do Mahé přes Dubaj na gate dva právě začal.' },
    { lang: 'en', text: 'Ladies and gentlemen, boarding has started for flight seven four zero to Mahé via Dubai at gate two.' },
    'Nástup do letu 740 na gate 2 právě začal.'),
  pa('last-740',
    { lang: 'cs', text: 'Poslední výzva pro cestující letu sedm set čtyřicet do Mahé. Prosíme, přejděte okamžitě na gate dva.' },
    { lang: 'en', text: 'Last call for flight seven four zero to Mahé. Passengers, please proceed immediately to gate two.' },
    'Poslední výzva k letu 740. Jděte okamžitě na gate 2.'),
  pa('close-740',
    { lang: 'cs', text: 'Odbavení letu sedm set čtyřicet do Mahé končí. Gate dva se právě zavírá.' },
    { lang: 'en', text: 'Boarding is closing for flight seven four zero to Mahé. Gate two is now closing.' },
    'Gate 2 se zavírá, odbavení letu 740 končí.'),

  // ---- flight 750: Praha to Mahé via Dubai, gate B 6 ----
  pa('board-750',
    { lang: 'cs', text: 'Dámy a pánové, nástup do letu sedm set padesát do Mahé přes Dubaj na gate B šest právě začal.' },
    { lang: 'en', text: 'Ladies and gentlemen, boarding has started for flight seven five zero to Mahé via Dubai at gate B six.' },
    'Nástup do letu 750 na gate B6 právě začal.'),
  pa('last-750',
    { lang: 'cs', text: 'Poslední výzva pro cestující letu sedm set padesát do Mahé. Prosíme, přejděte okamžitě na gate B šest.' },
    { lang: 'en', text: 'Last call for flight seven five zero to Mahé. Passengers, please proceed immediately to gate B six.' },
    'Poslední výzva k letu 750. Jděte okamžitě na gate B6.'),
  pa('close-750',
    { lang: 'cs', text: 'Odbavení letu sedm set padesát do Mahé končí. Gate B šest se právě zavírá.' },
    { lang: 'en', text: 'Boarding is closing for flight seven five zero to Mahé. Gate B six is now closing.' },
    'Gate B6 se zavírá, odbavení letu 750 končí.'),

  // ---- flight 741: Mahé to Pardubice via Dubai, gate 1 (English first, at Seychelles) ----
  pa('board-741',
    { lang: 'en', text: 'Ladies and gentlemen, boarding has started for flight seven four one to Pardubice via Dubai at gate one.' },
    { lang: 'cs', text: 'Dámy a pánové, nástup do letu sedm set čtyřicet jedna do Pardubic přes Dubaj na gate jedna právě začal.' },
    'Nástup do letu 741 na gate 1 právě začal.'),
  pa('last-741',
    { lang: 'en', text: 'Last call for flight seven four one to Pardubice. Passengers, please proceed immediately to gate one.' },
    { lang: 'cs', text: 'Poslední výzva pro cestující letu sedm set čtyřicet jedna do Pardubic. Prosíme, přejděte okamžitě na gate jedna.' },
    'Poslední výzva k letu 741. Jděte okamžitě na gate 1.'),
  pa('close-741',
    { lang: 'en', text: 'Boarding is closing for flight seven four one to Pardubice. Gate one is now closing.' },
    { lang: 'cs', text: 'Odbavení letu sedm set čtyřicet jedna do Pardubic končí. Gate jedna se právě zavírá.' },
    'Gate 1 se zavírá, odbavení letu 741 končí.'),

  // ---- flight 751: Mahé to Praha via Dubai, gate 1 (English first, at Seychelles) ----
  pa('board-751',
    { lang: 'en', text: 'Ladies and gentlemen, boarding has started for flight seven five one to Prague via Dubai at gate one.' },
    { lang: 'cs', text: 'Dámy a pánové, nástup do letu sedm set padesát jedna do Prahy přes Dubaj na gate jedna právě začal.' },
    'Nástup do letu 751 na gate 1 právě začal.'),
  pa('last-751',
    { lang: 'en', text: 'Last call for flight seven five one to Prague. Passengers, please proceed immediately to gate one.' },
    { lang: 'cs', text: 'Poslední výzva pro cestující letu sedm set padesát jedna do Prahy. Prosíme, přejděte okamžitě na gate jedna.' },
    'Poslední výzva k letu 751. Jděte okamžitě na gate 1.'),
  pa('close-751',
    { lang: 'en', text: 'Boarding is closing for flight seven five one to Prague. Gate one is now closing.' },
    { lang: 'cs', text: 'Odbavení letu sedm set padesát jedna do Prahy končí. Gate jedna se právě zavírá.' },
    'Gate 1 se zavírá, odbavení letu 751 končí.'),

  // ---- cabin, to Mahé (sez) ----
  { id: 'welcome-sez', role: 'crew', parts: [
    { lang: 'cs', text: 'Dobrý den, vítejte na palubě letu do Mahé přes Dubaj. Najděte si sedadlo a uložte zavazadla.' },
    { lang: 'en', text: 'Good day, and welcome aboard our flight to Mahé via Dubai. Please find your seat and stow your bags.' },
  ], subtitle: 'Vítejte na palubě letu do Mahé. Najděte si sedadlo.' },
  { id: 'takeoff-sez', role: 'captain', parts: [
    { lang: 'cs', text: 'Tady kapitán. Připravte kabinu ke vzletu. Cesta do Mahé potrvá asi deset hodin, s mezipřistáním v Dubaji.' },
    { lang: 'en', text: 'This is the captain. Cabin crew, prepare for take-off. The flight to Mahé takes about ten hours, via Dubai.' },
  ], subtitle: 'Kapitán: připravte kabinu ke vzletu. Cesta potrvá asi deset hodin.' },
  { id: 'descent-sez', role: 'captain', parts: [
    { lang: 'cs', text: 'Tady kapitán. Zahájili jsme klesání do Mahé. Prosíme, zapněte si bezpečnostní pásy.' },
    { lang: 'en', text: 'This is the captain. We have started our descent to Mahé. Please fasten your seat belts.' },
  ], subtitle: 'Kapitán: zahájili jsme klesání do Mahé, zapněte si pásy.' },
  { id: 'arrived-sez', role: 'crew', parts: [
    { lang: 'cs', text: 'Vítejte na Mahé. Prosíme, zůstaňte sedět, dokud nezhasne znak pro připoutání. Děkujeme, že jste letěli s ATC.' },
    { lang: 'en', text: 'Welcome to Mahé. Please remain seated until the seat belt sign is switched off. Thank you for flying ATC.' },
  ], subtitle: 'Vítejte na Mahé. Zůstaňte sedět, dokud nezhasne znak.' },

  // ---- cabin, to Pardubice (ped) ----
  { id: 'welcome-ped', role: 'crew', parts: [
    { lang: 'cs', text: 'Dobrý den, vítejte na palubě letu do Pardubic přes Dubaj. Najděte si sedadlo a uložte zavazadla.' },
    { lang: 'en', text: 'Good day, and welcome aboard our flight to Pardubice via Dubai. Please find your seat and stow your bags.' },
  ], subtitle: 'Vítejte na palubě letu do Pardubic. Najděte si sedadlo.' },
  { id: 'takeoff-ped', role: 'captain', parts: [
    { lang: 'cs', text: 'Tady kapitán. Připravte kabinu ke vzletu. Cesta do Pardubic potrvá asi deset hodin, s mezipřistáním v Dubaji.' },
    { lang: 'en', text: 'This is the captain. Cabin crew, prepare for take-off. The flight to Pardubice takes about ten hours, via Dubai.' },
  ], subtitle: 'Kapitán: připravte kabinu ke vzletu. Cesta potrvá asi deset hodin.' },
  { id: 'descent-ped', role: 'captain', parts: [
    { lang: 'cs', text: 'Tady kapitán. Zahájili jsme klesání do Pardubic. Prosíme, zapněte si bezpečnostní pásy.' },
    { lang: 'en', text: 'This is the captain. We have started our descent to Pardubice. Please fasten your seat belts.' },
  ], subtitle: 'Kapitán: zahájili jsme klesání do Pardubic, zapněte si pásy.' },
  { id: 'arrived-ped', role: 'crew', parts: [
    { lang: 'cs', text: 'Vítejte v Pardubicích. Prosíme, zůstaňte sedět, dokud nezhasne znak pro připoutání. Děkujeme, že jste letěli s ATC.' },
    { lang: 'en', text: 'Welcome to Pardubice. Please remain seated until the seat belt sign is switched off. Thank you for flying ATC.' },
  ], subtitle: 'Vítejte v Pardubicích. Zůstaňte sedět, dokud nezhasne znak.' },

  // ---- cabin, to Praha (prg) ----
  { id: 'welcome-prg', role: 'crew', parts: [
    { lang: 'cs', text: 'Dobrý den, vítejte na palubě letu do Prahy přes Dubaj. Najděte si sedadlo a uložte zavazadla.' },
    { lang: 'en', text: 'Good day, and welcome aboard our flight to Prague via Dubai. Please find your seat and stow your bags.' },
  ], subtitle: 'Vítejte na palubě letu do Prahy. Najděte si sedadlo.' },
  { id: 'takeoff-prg', role: 'captain', parts: [
    { lang: 'cs', text: 'Tady kapitán. Připravte kabinu ke vzletu. Cesta do Prahy potrvá asi deset hodin, s mezipřistáním v Dubaji.' },
    { lang: 'en', text: 'This is the captain. Cabin crew, prepare for take-off. The flight to Prague takes about ten hours, via Dubai.' },
  ], subtitle: 'Kapitán: připravte kabinu ke vzletu. Cesta potrvá asi deset hodin.' },
  { id: 'descent-prg', role: 'captain', parts: [
    { lang: 'cs', text: 'Tady kapitán. Zahájili jsme klesání do Prahy. Prosíme, zapněte si bezpečnostní pásy.' },
    { lang: 'en', text: 'This is the captain. We have started our descent to Prague. Please fasten your seat belts.' },
  ], subtitle: 'Kapitán: zahájili jsme klesání do Prahy, zapněte si pásy.' },
  { id: 'arrived-prg', role: 'crew', parts: [
    { lang: 'cs', text: 'Vítejte v Praze. Prosíme, zůstaňte sedět, dokud nezhasne znak pro připoutání. Děkujeme, že jste letěli s ATC.' },
    { lang: 'en', text: 'Welcome to Prague. Please remain seated until the seat belt sign is switched off. Thank you for flying ATC.' },
  ], subtitle: 'Vítejte v Praze. Zůstaňte sedět, dokud nezhasne znak.' },

  // ---- generic, any flight ----
  { id: 'doors', role: 'crew', parts: [
    { lang: 'cs', text: 'Kabinová posádko, připravte dveře k odletu a proveďte křížovou kontrolu.' },
    { lang: 'en', text: 'Cabin crew, please prepare the doors for departure and perform the cross check.' },
  ], subtitle: 'Kabinová posádko, připravte dveře k odletu.' },
];

// id -> line, for the player and for the checks.
export const BY_ID = Object.fromEntries(LINES.map((line) => [line.id, line]));
