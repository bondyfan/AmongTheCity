// Part two of the Last Train: the car under Kunětická hora. Every line is
// [recording id, speaker on the caption, words, voice role, direction for the
// voice model]. Roles: father (the player), friend (Vašek), farmer (Jarda),
// radio (the police dispatcher). scripts/gen-heist-audio.mjs renders them.

// On the street in front of Dražkovická 119, half past two at night.
export const sendOff = [
  ['heist-01', 'Vašek', 'Tak. Vem si můj kombík a dojeď do Brozan. Na statku na konci vsi čeká jeden farmář. Jarda.', 'friend', 'low, early morning, matter of fact'],
  ['heist-02', 'Ty', 'Farmář?', 'father', 'tired, doubtful'],
  ['heist-03', 'Vašek', 'Zná to tam. Doveze tě až k lesu, dál už půjdeš pěšky. Kombík nech u něj na dvoře.', 'friend', 'practical'],
  ['heist-04', 'Vašek', 'A nic si z něj nedělej. Je to hodnej kluk. Jenom je trochu mimo.', 'friend', 'half a smile, a little embarrassed'],
];

// In the farmyard. Jarda leans on his van, reggae from the open door.
export const farmTalk = [
  ['farm-01', 'Jarda', 'Nazdááár, brácho. Ty jseš ten od Vaška, že jo? Já to cejtil už od rána. Měsíc je ve Štíru, to se dějou věci.', 'farmer', 'very stoned, slow drawl, warm, delighted to see him'],
  ['farm-02', 'Ty', 'Dobrý den. Prý mě máte někam odvézt.', 'father', 'polite, stiff, uneasy'],
  ['farm-03', 'Jarda', 'Tykej mi, vole. Vesmír taky nikomu nevyká. Vylez z toho auta a nech ho tady u slepic, těm je to jedno. Hodím tě tam já.', 'farmer', 'stoned, giggling a little, generous'],
  ['farm-04', 'Jarda', 'Chceš si dát? Vlastní úroda. Bio. Zalejvaná při úplňku.', 'farmer', 'holding his breath in, then exhaling slowly, proud'],
  ['farm-05', 'Ty', 'Ne, díky. Potřebuju mít čistou hlavu.', 'father', 'firm, a little alarmed'],
  ['farm-06', 'Jarda', 'Čistou hlavu. To je hezký. Já ji měl naposled v devadesátým osmým. Tak nasedat, kosmonaute.', 'farmer', 'dreamy, amused, slow'],
];

// In the van, on the way to the forest. He never stops talking.
export const rideTalk = [
  ['ride-01', 'Jarda', 'Co jseš za znamení?', 'farmer', 'stoned, curious, slow'],
  ['ride-02', 'Ty', 'Kozoroh.', 'father', 'flat, looking at the road'],
  ['ride-03', 'Jarda', 'Kozoroh! No jasně. Kozoroh furt něco musí. Musí, musí, musí. A přitom se, brácho, nemusí vůbec nic. Jenom umřít. A i to až potom.', 'farmer', 'stoned, as if revealing a great truth, slow laugh at the end'],
  ['ride-04', 'Jarda', 'Vidíš tu Kuňku? To je starej vulkán. Tam jde energie rovnou ze země. Proto mi tady tak roste.', 'farmer', 'stoned, reverent, pointing through the windscreen'],
  ['ride-05', 'Ty', 'Co vám roste?', 'father', 'careful'],
  ['ride-06', 'Jarda', 'Rajčata. Taky rajčata.', 'farmer', 'long pause, innocent, then a small giggle'],
  ['ride-07', 'Jarda', 'Já když si zahulim, tak slyším, co si povídaj slepice. Většinou o mně. Nic hezkýho.', 'farmer', 'stoned, confiding, a bit hurt'],
  ['ride-08', 'Ty', 'Nemohl byste se dívat na cestu?', 'father', 'tense, polite'],
  ['ride-09', 'Jarda', 'Cesta se dívá na mě, brácho. My dva se známe.', 'farmer', 'serene, unbothered, slow'],
  ['ride-10', 'Jarda', 'Merkur je teď retrográdní, víš? To se nemaj podepisovat smlouvy. A krást auta. Ne že bych něco věděl. Já nevím nic. Já jsem jenom rajče.', 'farmer', 'stoned, drifting, the last sentence almost whispered'],
];

// At the roadside by the forest.
export const dropTalk = [
  ['drop-01', 'Jarda', 'Tak jsme tady. Dál nejedu. V lese jsou srnky a ty mě soudí.', 'farmer', 'stoned, dead serious'],
  ['drop-02', 'Ty', 'Díky za odvoz.', 'father', 'relieved to get out'],
  ['drop-03', 'Jarda', 'Není zač. A kdyby něco, tak dejchej. Nádech nosem, výdech pusou. A pozdravuj Saturn.', 'farmer', 'warm, slow, kind'],
];

// Vašek on the phone while he walks to the villa.
export const villaCall = [
  ['call-01', 'Vašek', 'Tak co, žiješ? Dovez tě Jarda?', 'friend', 'on the phone, low, a little amused'],
  ['call-02', 'Ty', 'Dovez. Je úplně mimo.', 'father', 'quiet, walking'],
  ['call-03', 'Vašek', 'To je. Poslouchej. Ta vila je hned u lesa. Auto stojí vzadu za domem pod přístřeškem. Klíčky nehledej, nejsou.', 'friend', 'on the phone, serious now'],
  ['call-04', 'Vašek', 'Na rohu domu je kamera. Než tam vlezeš, nasaď si tu kuklu.', 'friend', 'on the phone, insisting'],
  ['call-05', 'Vašek', 'A hlavně nezapomeň sundat značky. Normálně je urvi. Obě.', 'friend', 'on the phone, slow and clear, this is the important part'],
  ['call-06', 'Ty', 'Jasně.', 'father', 'short, breath in the cold'],
];

// He talks to the car.
export const startLine = ['start-01', 'Ty', 'No tak. Naskoč.', 'father', 'under his breath, pleading with a machine'];

// The police radio (heard only when something has gone wrong).
export const radioPlate = ['radio-01', 'Vysílačka', 'Všem hlídkám. Kamera na Hradecké zachytila hledaný vůz, stříbrný Mercedes. Značka souhlasí. Jede do centra.', 'radio', 'police dispatcher, brisk, routine'];
export const radioBare = ['radio-02', 'Vysílačka', 'Tady hlídka. Máme tu Mercedes bez značek. Jdeme za ním.', 'radio', 'police officer on the radio, alert'];

// Vašek calls as he comes into town.
export const cityCall = [
  ['city-01', 'Vašek', 'Kde jseš?', 'friend', 'on the phone, tense, fast'],
  ['city-02', 'Ty', 'Jedu do centra.', 'father', 'driving, short'],
  ['city-03', 'Vašek', 'Poslouchej, hledaj to auto. Asi jsi tam spustil alarm. Konec Sedmnáctýho listopadu je zatarasenej, u podjezdu stojej dvě hlídky.', 'friend', 'on the phone, urgent'],
  ['city-04', 'Vašek', 'Vem to přes třídu Míru a objeď to Anenskou. Čekám u garáží Na Starý poště.', 'friend', 'on the phone, urgent, clear'],
];

// In the lock-up garage, the door down.
export const garageTalk = [
  ['end-01', 'Vašek', 'Ty vole. Tys to fakt udělal.', 'friend', 'breathless, grinning, quiet'],
  ['end-02', 'Ty', 'Udělal. Kde jsou ty peníze?', 'father', 'worn out, hard'],
  ['end-03', 'Vašek', 'Kupec přijede v poledne. Do tý doby se to auto odsud nehne.', 'friend', 'reassuring, hands up'],
  ['end-04', 'Ty', 'Do půlnoci to musí být v nemocnici, Vašku.', 'father', 'low, every word weighed'],
  ['end-05', 'Vašek', 'Bude. Slibuju. Běž se vyspat.', 'friend', 'sincere, gentle'],
];

export const heistLines = [...sendOff, ...farmTalk, ...rideTalk, ...dropTalk, ...villaCall, startLine, radioPlate, radioBare, ...cityCall, ...garageTalk];
