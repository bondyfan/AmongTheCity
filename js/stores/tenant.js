// ---- stores/tenant.js: a chain that is only a tenant ----
// Main thread. A Lidl under an office block, a KFC in a station hall: there is
// no shop floor to walk (js/stores/chains.js standalone), so the chain sells
// over one screen, its own goods at its own prices.

import { Order } from './cart.js';
import { isOpen, chainOfName } from './chains.js';
import { GOODS, DEPT_NAME, priceAt, menuOf } from './catalog.js';

/** E at a venue called `name`, for the StoreWorld `sw`. True when `name` is a chain's and it sells this way. */
export function tenantPanel(sw, name) {
  const chain = chainOfName(name);
  if (!chain || chain.kind === 'showroom' || !isOpen(chain, sw.d.hour())) return false;
  const fast = chain.kind === 'fast', o = new Order();
  const menu = fast ? menuOf(chain.id)
    : GOODS.filter((g) => g.keep !== false).map((g) => ({ ...g, price: priceAt(chain.id, g), sec: DEPT_NAME[g.dept] }));
  sw.panel.menu({
    title: chain.label.toUpperCase(), menu, order: o, have: () => sw.d.wallet.money(),
    payLabel: fast ? 'Objednat a zaplatit' : 'Zaplatit',
    note: fast ? 'Najíš se hned u pultu.' : 'Nákup půjde do tašky. Klávesou I ji otevřeš a můžeš jíst.',
    onPay: () => {
      const sum = o.total();
      if (!sw.d.wallet.pay(sum, fast ? 'jídlo' : 'nákup')) return false;
      if (fast) {
        const w = o.worth();
        sw.d.vitals.heal(w.hp); sw.d.vitals.eat(w.kcal);
        sw.d.onAte?.(w.hp, w.kcal, 'Dobrou chuť');
      } else {
        sw.bag.takeAll(o.list());
        sw.d.toast('Zaplaceno ' + sum + ' Kč', { icon: '🧾', kind: 'good', sub: 'Nákup máš v tašce (klávesa I).' });
      }
      return true;
    },
  });
  return true;
}
