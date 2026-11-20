// ---- stores/catalog.js: what the shops sell, and for how much ----
// Pure data. Shelf prices are Czech ones of late 2025 (the Czech Statistical
// Office's consumer price averages where it publishes one: milk 27 Kč, a
// kilo of bread 40, ten eggs 75, butter 62 a quarter, potatoes 19 a kilo,
// bottled beer 15), the restaurant menus the chains' own price lists of 2025
// and 2026. A discounter is a few per cent under the list, a hypermarket on it.
//
// What a thing DOES is in the game's own terms (js/vitals.js): `hp` heals,
// `kcal` fills (energy points out of 100). Food bought in a shop goes into the
// bag and is eaten when the player chooses; a restaurant meal is eaten there.
// Nothing here carries a brand name: a carton of milk is a carton of milk.

const it = (id, name, price, dept, hp, kcal, icon, extra) => ({ id, name, price, dept, hp, kcal, icon, ...extra });

/** Every item a supermarket shelf can hand over, by department. */
export const GOODS = [
  it('rohlik', 'Rohlík', 4, 'bakery', 2, 6, '🥖'),
  it('chleb', 'Chléb konzumní', 42, 'bakery', 8, 30, '🍞'),
  it('kolac', 'Koláč s tvarohem', 19, 'bakery', 4, 12, '🥮'),
  it('kobliha', 'Kobliha', 12, 'bakery', 3, 10, '🍩'),
  it('banany', 'Banány 1 kg', 35, 'produce', 9, 22, '🍌'),
  it('jablka', 'Jablka 1 kg', 39, 'produce', 10, 20, '🍎'),
  it('rajcata', 'Rajčata 500 g', 34, 'produce', 6, 8, '🍅'),
  it('brambory', 'Brambory 2 kg', 38, 'produce', 6, 30, '🥔'),
  it('mleko', 'Mléko polotučné 1 l', 27, 'dairy', 5, 14, '🥛'),
  it('maslo', 'Máslo 250 g', 62, 'dairy', 4, 20, '🧈'),
  it('jogurt', 'Bílý jogurt', 12, 'dairy', 4, 8, '🥣'),
  it('eidam', 'Eidam 30 % plátky', 29, 'dairy', 6, 16, '🧀'),
  it('vejce', 'Vejce 10 ks', 75, 'dairy', 10, 30, '🥚'),
  it('sunka', 'Šunka 100 g', 32, 'meat', 7, 14, '🥓'),
  it('parky', 'Párky 300 g', 49, 'meat', 9, 26, '🌭'),
  it('kure', 'Kuřecí prsa 500 g', 105, 'meat', 14, 34, '🍗'),
  it('voda', 'Minerálka 1,5 l', 17, 'drinks', 3, 4, '💧'),
  it('kola', 'Kola 1,5 l', 39, 'drinks', 3, 12, '🥤'),
  it('dzus', 'Pomerančový džus 1 l', 45, 'drinks', 5, 12, '🧃'),
  it('pivo', 'Pivo lahvové 0,5 l', 15, 'beer', 2, 8, '🍺'),
  it('lezak', 'Ležák 0,5 l', 26, 'beer', 2, 10, '🍺'),
  it('testoviny', 'Těstoviny 500 g', 29, 'dry', 6, 36, '🍝'),
  it('ryze', 'Rýže 1 kg', 45, 'dry', 6, 40, '🍚'),
  it('mouka', 'Mouka hladká 1 kg', 19, 'dry', 2, 20, '🌾'),
  it('kava', 'Káva mletá 250 g', 119, 'dry', 4, 6, '☕'),
  it('cokolada', 'Čokoláda 100 g', 35, 'sweets', 5, 18, '🍫'),
  it('susenky', 'Sušenky', 24, 'sweets', 4, 14, '🍪'),
  it('chipsy', 'Chipsy 150 g', 45, 'snacks', 3, 20, '🥔'),
  it('orisky', 'Arašídy solené', 32, 'snacks', 4, 22, '🥜'),
  it('pizza', 'Mražená pizza', 69, 'frozen', 12, 40, '🍕'),
  it('zmrzlina', 'Zmrzlina 1 l', 79, 'frozen', 6, 24, '🍨'),
  it('papir', 'Toaletní papír 8 rolí', 89, 'drug', 0, 0, '🧻', { keep: false }),
  it('mydlo', 'Tekuté mýdlo', 39, 'drug', 0, 0, '🧴', { keep: false }),
  it('zarovka', 'Žárovka LED', 59, 'home', 0, 0, '💡', { keep: false }),
  it('ponozky', 'Ponožky 3 páry', 99, 'home', 0, 0, '🧦', { keep: false }),
];

/** Czech name of every department, as the board over the aisle has it. */
export const DEPT_NAME = {
  bakery: 'Pečivo', produce: 'Ovoce a zelenina', dairy: 'Mléčné výrobky', meat: 'Maso a uzeniny',
  drinks: 'Nápoje', beer: 'Pivo a víno', dry: 'Trvanlivé potraviny', sweets: 'Sladkosti', snacks: 'Slané pochutiny',
  frozen: 'Mražené', drug: 'Drogerie', home: 'Domácnost',
};

const BY_ID = new Map(GOODS.map((g) => [g.id, g]));
export const goodById = (id) => BY_ID.get(id) ?? null;

/** How a chain prices the list: the discounters under it, the convenience end over it. */
const PRICE_K = { lidl: 0.94, penny: 0.94, norma: 0.92, kaufland: 0.96, makro: 0.9, albert: 1.02, billa: 1.05, tesco: 1.0, globus: 0.98 };

/** A shelf price at one chain, rounded the way a Czech shelf label is (to 90 haléřů). */
export function priceAt(chainId, good) {
  const p = good.price * (PRICE_K[chainId] ?? 1);
  return p < 20 ? Math.max(2, Math.round(p * 10) / 10) : Math.round(p) - 0.1;
}

/** The items of a department a shelf hands over. */
export const goodsOf = (dept) => GOODS.filter((g) => g.dept === dept);

// ---- the restaurants ----------------------------------------------------------
// hp and kcal by what the dish is: a menu fills a hungry player, fries do not.
const dish = (id, name, price, hp, kcal, icon, sec) => ({ id, name, price, hp, kcal, icon, sec });

export const MENUS = {
  mcdonalds: [
    dish('hamburger', 'Hamburger', 39, 9, 20, '🍔', 'Burgery'),
    dish('cheese', 'Cheeseburger', 42, 10, 22, '🍔', 'Burgery'),
    dish('dcheese', 'Double Cheeseburger', 85, 18, 36, '🍔', 'Burgery'),
    dish('bigmac', 'Big Mac', 115, 24, 44, '🍔', 'Burgery'),
    dish('mcchicken', 'McChicken', 109, 22, 40, '🍔', 'Burgery'),
    dish('nuggets6', 'Chicken McNuggets 6 ks', 105, 18, 30, '🍗', 'Kuře'),
    dish('nuggets9', 'Chicken McNuggets 9 ks', 125, 24, 42, '🍗', 'Kuře'),
    dish('hranolky', 'Hranolky střední', 59, 8, 26, '🍟', 'Přílohy'),
    dish('menubm', 'Big Mac menu', 185, 38, 78, '🍱', 'Menu'),
    dish('happy', 'Happy Meal', 119, 20, 46, '🎁', 'Menu'),
    dish('cola', 'Coca-Cola 0,5 l', 52, 3, 12, '🥤', 'Nápoje'),
    dish('capp', 'Cappuccino', 72, 5, 6, '☕', 'McCafé'),
    dish('mcflurry', 'McFlurry', 72, 6, 20, '🍨', 'McCafé'),
  ],
  kfc: [
    dish('twister', 'Twister', 125, 22, 40, '🌯', 'Wrapy'),
    dish('zinger', 'Zinger burger', 169, 26, 46, '🍔', 'Burgery'),
    dish('zingerd', 'Zinger Double', 159, 28, 48, '🍔', 'Burgery'),
    dish('wings5', 'Hot Wings 5 ks', 97, 16, 28, '🍗', 'Kuře'),
    dish('strips', 'Strips menu', 175, 30, 64, '🍱', 'Menu'),
    dish('twistermenu', 'Twister menu', 188, 34, 70, '🍱', 'Menu'),
    dish('kyblik', 'Kyblík Classic', 309, 60, 100, '🪣', 'Kyblíky'),
    dish('kyblik15', 'Kyblík 15 Hot Wings', 289, 52, 90, '🪣', 'Kyblíky'),
    dish('hranolky', 'Hranolky Kentucky Gold', 70, 9, 28, '🍟', 'Přílohy'),
    dish('pepsi', 'Pepsi 0,33 l', 55, 3, 10, '🥤', 'Nápoje'),
  ],
  burgerking: [
    dish('whopper', 'Whopper', 159, 28, 50, '🍔', 'Burgery'),
    dish('bigking', 'Big King', 129, 24, 44, '🍔', 'Burgery'),
    dish('crispy', 'Crispy Chicken', 139, 24, 42, '🍔', 'Burgery'),
    dish('whoppermenu', 'Whopper menu', 215, 40, 82, '🍱', 'Menu'),
    dish('bigkingmenu', 'Big King menu', 199, 36, 76, '🍱', 'Menu'),
    dish('nuggets', 'King Nuggets 6 ks', 99, 16, 28, '🍗', 'Kuře'),
    dish('krouzky', 'Cibulové kroužky', 65, 8, 22, '🧅', 'Přílohy'),
    dish('hranolky', 'Hranolky střední', 62, 8, 26, '🍟', 'Přílohy'),
    dish('cola', 'Coca-Cola 0,5 l', 55, 3, 12, '🥤', 'Nápoje'),
  ],
};

export const menuOf = (chainId) => MENUS[chainId] ?? MENUS.mcdonalds;

/** The sum of a list of { price, n } lines, in whole crowns the way a till rounds cash. */
export function total(lines) {
  let s = 0;
  for (const l of lines) s += l.price * (l.n ?? 1);
  return Math.round(s);
}
