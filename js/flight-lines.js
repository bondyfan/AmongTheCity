// ---- flight-lines.js: everything the flight says, in one place ----
// The words the counter, the security officer, the gate agent, the cabin crew
// and the captain say, and the heading card's text for each step of the trip.
// Czech, because the player reads them. Pure: no DOM.

import { clockText } from './flight-trip.js';

const kc = (n) => n.toLocaleString('cs-CZ') + ' Kč';
const hour = (t01) => clockText(t01 * 1440);

export const lines = {
  sold: (t) => `Tady je vaše palubní vstupenka. Let ${t.no} na Mahé přes Dubaj, sedadlo ${t.seat} u okna, gate ${t.gate}. Pokračujte bezpečnostní kontrolou. Šťastnou cestu!`,
  soldHome: (t) => `Odbaveno. Let ${t.no} do Pardubic přes Dubaj, sedadlo ${t.seat}. Kontrolou jste prošel, letadlo stojí na odstavné ploše, můžete rovnou nastoupit.`,
  haveTicket: (t) => `Letenku už máte: ${t.no}, sedadlo ${t.seat}, gate ${t.gate}.`,
  noMoney: (fare) => `Letenka na Seychely stojí ${kc(fare)}. Tolik u sebe nemáte.`,
  cleared: 'V pořádku, můžete pokračovat. Gaty jsou vpravo.',
  boarding: 'Děkuji, příjemný let. Letadlo stojí na odstavné ploše vpravo, jděte po chodníku ke schůdkům.',
  welcome: (t) => `Dobrý den, vítejte na palubě. Sedadlo ${t.seat} je ve čtrnácté řadě vlevo u okna.`,
  stayBelted: 'Prosím zůstaňte sedět s připoutaným pásem, dokud letadlo nezastaví.',
  aboard: (r) => `Dámy a pánové, tady kapitán. Vítejte na palubě letu ${r.no} do ${r.to === 'SEZ' ? 'Mahé' : 'Pardubic'} s mezipřistáním v Dubaji. Zavíráme dveře, připoutejte se prosím.`,
  taxi: 'Posádko, připravte kabinu ke vzletu.',
  climbing: (r) => `Tady opět kapitán. Stoupáme do letové hladiny tři sta padesát. Do Dubaje poletíme necelých šest hodin, celá cesta potrvá asi ${Math.round(r.hours)} hodin.`,
  cruise: (r) => `Let ${r.no} · přes ${r.via}`,
  stop: () => 'Mezipřistání, doplnění paliva a výměna posádky. Za necelou hodinu letíme dál.',
  approach: (r, dest) => (dest?.placeholder ? 'Přiblížení. Mahé se zatím staví, přistáváme proto zástupně v Pardubicích.' : `Přiblížení na letiště ${r.to === 'SEZ' ? 'Seychelles International' : 'Pardubice'}.`),
  landing: (r, arr, placeholder) => `Dámy a pánové, za několik minut přistaneme ${r.to === 'SEZ' ? (placeholder ? 'zástupně v Pardubicích' : 'na Mahé') : 'v Pardubicích'}. Místní čas je ${hour(arr)}. Připoutejte se prosím a narovnejte opěradla.`,
  arrived: (r, dest) => (r.to === 'SEZ' && !dest?.placeholder ? 'Vítejte na Seychelách. Děkujeme, že jste letěli s námi, a přejeme krásný pobyt na Mahé.' : 'Vítejte v Pardubicích. Děkujeme, že jste letěli s námi.'),
  welcomeTo: (r, dest) => (r.to !== 'SEZ' ? 'Vítej doma v Pardubicích' : dest?.placeholder ? 'Náhradní přistání v Pardubicích' : 'Vítej na Mahé'),
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

/** The heading card: [place, task, help] for this step and where the player is. */
export function guideOf(trip, phase, zone, route) {
  const place = route.dir === 'home' ? 'Letiště Mahé' : 'Letiště Pardubice';
  switch (trip.state) {
    case 'none':
    case 'done':
      if (!zone) return ['', '', ''];
      return [place, `Let ${route.no} na ${route.toName}`,
        route.dir === 'home' ? `Letenku domů prodávají u odbavení · ${kc(route.fare)}` : `Letenku koupíš u přepážek 3 a 4 · ${kc(route.fare)}`];
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
