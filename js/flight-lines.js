// ---- flight-lines.js: everything the flight says, in one place ----
// The words the counter, the security officer, the gate agent, the cabin crew
// and the captain say, and the heading card's text for each step of the trip.
// Czech, because the player reads them. Pure: no DOM.

import { clockText } from './flight-trip.js';

const kc = (n) => n.toLocaleString('cs-CZ') + ' Kč';
const hour = (t01) => clockText(t01 * 1440);

// how the far end is said: route.toward "na Mahé", "do Pardubic", "do Prahy"
const toward = (r) => r.toward ?? (r.to === 'SEZ' ? 'na Mahé' : 'do Pardubic');
const atDest = (r) => r.at ?? (r.to === 'SEZ' ? 'na Mahé' : 'v Pardubicích');
const gateAt = (r) => 'gate ' + r.gate;

export const lines = {
  sold: (t, r) => `Tady je vaše palubní vstupenka. Let ${t.no} ${toward(r)} přes Dubaj, sedadlo ${t.seat} u okna, gate ${t.gate}. Nástup začne za chvíli, pokračujte bezpečnostní kontrolou. Šťastnou cestu!`,
  soldThrough: (t, r) => `Odbaveno. Let ${t.no} ${toward(r)} přes Dubaj, sedadlo ${t.seat}. Nástup právě probíhá, provedu vás kontrolou rovnou k letadlu.`,
  haveTicket: (t) => `Letenku už máte: ${t.no}, sedadlo ${t.seat}, gate ${t.gate}.`,
  noMoney: (fare) => `Letenka stojí ${kc(fare)}. Tolik u sebe nemáte.`,
  storyFirst: 'Dokud hraješ příběh, letenky neprodáváme. Poletíš, až ho dohraješ, nebo když začneš hru v Praze.',
  notYet: (s) => `Nástup ještě nezačal, začne ${s < 1 ? 'hned' : 'za ' + Math.ceil(s) + ' s'}. Počkejte prosím u gate.`,
  missed: (t, r) => `Nástup na let ${t.no} jste nestihl. Přebookovali jsme vás zdarma na další let, nástup u ${gateAt(r)} začíná hned.`,
  waiting: 'Pospěšte si prosím, čekáme už jen na vás.',
  pa: (phase, r) => phase === 'boarding' ? `Zahajujeme nástup na let ${r.no} ${toward(r)} přes Dubaj, ${gateAt(r)}.`
    : phase === 'lastCall' ? `Poslední výzva pro cestující letu ${r.no} ${toward(r)}. Dostavte se neprodleně k ${gateAt(r)}.`
      : `${gateAt(r)[0].toUpperCase() + gateAt(r).slice(1)} pro let ${r.no} se uzavírá.`,
  cleared: 'V pořádku, můžete pokračovat. Gaty jsou vpravo.',
  boarding: 'Děkuji, příjemný let. Letadlo stojí na odstavné ploše vpravo, jděte po chodníku ke schůdkům.',
  welcome: (t) => `Dobrý den, vítejte na palubě. Sedadlo ${t.seat} je ve čtrnácté řadě vlevo u okna.`,
  stayBelted: 'Prosím zůstaňte sedět s připoutaným pásem, dokud letadlo nezastaví.',
  aboard: (r) => `Dámy a pánové, tady kapitán. Vítejte na palubě letu ${r.no} ${toward(r)} s mezipřistáním v Dubaji. Zavíráme dveře, připoutejte se prosím.`,
  taxi: 'Posádko, připravte kabinu ke vzletu.',
  climbing: (r) => `Tady opět kapitán. Stoupáme do letové hladiny tři sta padesát. Do Dubaje poletíme necelých šest hodin, celá cesta potrvá asi ${Math.round(r.hours)} hodin.`,
  cruise: (r) => `Let ${r.no} · přes ${r.via}`,
  stop: () => 'Mezipřistání, doplnění paliva a výměna posádky. Za necelou hodinu letíme dál.',
  approach: (r, dest) => (dest?.placeholder ? 'Přiblížení. Mahé se zatím staví, přistáváme proto zástupně v Pardubicích.'
    : `Přiblížení na letiště ${r.to === 'SEZ' ? 'Seychelles International' : r.to === 'PRG' ? 'Václava Havla Praha' : 'Pardubice'}.`),
  landing: (r, arr, placeholder) => `Dámy a pánové, za několik minut přistaneme ${placeholder ? 'zástupně v Pardubicích' : atDest(r)}. Místní čas je ${hour(arr)}. Připoutejte se prosím a narovnejte opěradla.`,
  arrived: (r, dest) => (r.to === 'SEZ' && !dest?.placeholder ? 'Vítejte na Seychelách. Děkujeme, že jste letěli s námi, a přejeme krásný pobyt na Mahé.'
    : `Vítejte ${dest?.placeholder ? 'v Pardubicích' : atDest(r)}. Děkujeme, že jste letěli s námi.`),
  welcomeTo: (r, dest) => (dest?.placeholder ? 'Náhradní přistání v Pardubicích' : r.welcome ?? (r.to === 'SEZ' ? 'Vítej na Mahé' : 'Vítej doma v Pardubicích')),
  welcomeHelp: (r, dest) => (r.to === 'SEZ' && dest?.placeholder ? 'Ostrov Mahé se ještě staví. Až bude hotový, let přistane tam.' : ''),
};

/** The line on the boarding pass: what this passenger is to do next. */
export function phaseText(trip, phase) {
  switch (trip.state) {
    case 'ticket': return 'Pokračuj bezpečnostní kontrolou';
    case 'airside': return 'Nástup u gate ' + trip.gate;
    case 'boarding': return 'Nástup probíhá';
    case 'aboard': return 'Najdi si sedadlo ' + trip.seat;
    case 'seated': return 'Připoutej se';
    case 'flying': return ({ doors: 'Zavírání dveří', taxiOut: 'Pojíždění na dráhu', takeoff: 'Vzlet', climb: 'Stoupání',
      cruise: 'Cestovní let', final: 'Přiblížení', landing: 'Přistání', taxiIn: 'Pojíždění ke stání', parked: 'Na stání' })[phase] ?? '';
    case 'arrived': return 'Vystup z letadla';
    default: return '';
  }
}

/** The heading card: [place, task, help] for this step and where the player is. `home` is the airport he is at. */
export function guideOf(trip, phase, zone, route, home = null) {
  const at = home ?? (route.home ?? 'LKPD');
  const place = at === 'SEZ' ? 'Letiště Mahé' : at === 'LKPR' ? 'Letiště Václava Havla' : 'Letiště Pardubice';
  switch (trip.state) {
    case 'none':
    case 'done':
      if (!zone) return ['', '', ''];
      if (zone === 'apron') return [place, 'Projdi terminálem ven', 'Dveře terminálu jsou na mapě'];
      return [place, at === 'SEZ' ? 'Let domů: Pardubice nebo Praha' : `Let ${route.no} na ${route.toName}`,
        at === 'SEZ' ? `Letenku koupíš u odbavení před terminálem · ${kc(route.fare)}`
          : at === 'LKPR' ? `Letenku koupíš u odbavení před Terminálem 1 · ${kc(route.fare)}`
            : `Letenku koupíš u přepážek 3 a 4 · ${kc(route.fare)}`];
    case 'ticket': return [place, 'Projdi bezpečnostní kontrolou', 'Rámy jsou vpravo za přepážkami'];
    case 'airside': return [place, 'Jdi ke gate ' + trip.gate, 'U pultu nech naskenovat palubní vstupenku'];
    case 'boarding': return [place, 'Nastup do letadla', 'Stojí na odstavné ploše, schůdky u předních dveří'];
    case 'aboard': return ['Na palubě', 'Najdi si sedadlo ' + trip.seat, 'Čtrnáctá řada, vlevo u okna'];
    case 'seated':
    case 'flying': return ['Let ' + trip.no, phaseText(trip, phase), phase === 'cruise' ? '' : 'C: pohled z kabiny nebo zvenku'];
    case 'arrived': return [route.toName, 'Vystup z letadla', 'E vstaneš, pak dveřmi vpředu vlevo a po schůdkách dolů'];
    default: return ['', '', ''];
  }
}
lines.guide = guideOf;
