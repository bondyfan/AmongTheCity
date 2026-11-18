// Spoken captions and recording identifiers are shared by playback and the
// renderer (scripts/gen-prologue-audio.mjs). Each line is
// [id, speaker, words, role, direction for the voice].
//
// The opening is two calls. On the street the hospital names the price and
// the deadline; on the roof Vašek offers the only way to it. Nobody says
// anything they could not know: the father asks whose car it is, and Vašek
// will not tell him.
export const hospitalCall = [
  [
    'nurse-01',
    'Sestra',
    'Dobrý večer, tady sestra Dvořáková z dětské kardiologie. Volám kvůli vaší dceři.',
    'care',
    'softly, carefully',
  ],
  ['dad-01', 'Ty', 'Stalo se něco?', 'father', 'alarmed, quiet'],
  [
    'nurse-02',
    'Sestra',
    'Je stabilní, teď spí. Ale pojišťovna ten zákrok nehradí. Aby jí zůstal termín operace, musíte zaplatit aspoň zálohu. Do zítřejší půlnoci. Dvě stě padesát tisíc korun.',
    'care',
    'gently, slowing down before the amount',
  ],
  ['dad-02', 'Ty', 'Sakra.', 'father', 'under his breath, shaken'],
  [
    'nurse-03',
    'Sestra',
    'Je mi to moc líto. Bez zálohy ten termín dostane jiný pacient.',
    'care',
    'apologetic, quiet',
  ],
  ['dad-03', 'Ty', 'Dobře. Nějak to zkusím.', 'father', 'hollow, trying to stay composed'],
];
export const friendCall = [
  ['friend-01', 'Vašek', 'Čau.', 'friend', 'tense, forcing a casual tone'],
  ['dad-04', 'Ty', 'Čau, Vašku. Teď se mi to nehodí.', 'father', 'flat, far away'],
  ['friend-02', 'Vašek', 'Počkej, nezavěšuj. Mám pro tebe kšeft. Dvě stě padesát tisíc.', 'friend', 'urgent, then slowly on the sum'],
  ['dad-05', 'Ty', 'Dvě stě padesát tisíc? Za co?', 'father', 'stunned, wary'],
  [
    'friend-03',
    'Vašek',
    'To po telefonu ne. Řeknu ti to, až budeš tady. Potřebuju, abys přijel do Pardubic. Ještě dneska.',
    'friend',
    'low, firm',
  ],
  ['dad-06', 'Ty', 'Proč nepřijedeš ty za mnou?', 'father', 'tired, suspicious'],
  [
    'friend-04',
    'Vašek',
    'Sebrali mi řidičák. A potřebuju někam odvézt. Počkám na tebe před nádražím, u kombíku.',
    'friend',
    'a little ashamed, matter of fact',
  ],
  ['dad-07', 'Ty', 'Vašku… těch dvě stě padesát platí?', 'father', 'quiet, he needs it to be true'],
  [
    'friend-05',
    'Vašek',
    'Platí. Poslední vlak ti jede, koukám, za tři minuty. Stihneš to.',
    'friend',
    'relieved, hurrying him',
  ],
  ['dad-08', 'Ty', 'No nevím. Pokusím se.', 'father', 'exhales, already moving'],
];
// Text messages. They have no voice: the phone shows them. The bank's comes on
// the roof; the hospital's only at Vašek's table, when he has heard the job.
export const bankMessage = ['Banka', 'Vaši žádost o půjčku 250 000 Kč jsme zamítli.'];
export const hospitalMessage = [
  'Nemocnice',
  'Připomínáme: zálohu 250 000 Kč je nutné uhradit do zítřejší půlnoci. Jinak termín operace propadne.',
];
export const calls = [...hospitalCall, ...friendCall];

export const parkingLines = [
  ['park-01', 'Vašek', 'Hoď batoh dozadu. Klíčky máš na sedačce.', 'friend', 'warm, conversational'],
  ['park-02', 'Ty', 'Víš, na co ty prachy potřebuju?', 'father', 'quiet'],
  ['park-03', 'Vašek', 'Vím. Jak jí je?', 'friend', 'concerned'],
  ['park-04', 'Ty', 'Dneska jsem ji neslyšel.', 'father', 'tired'],
  ['park-05', 'Vašek', 'Tak jedem.', 'friend', 'softly'],
  ['park-06', 'Vašek', 'Ke mně domů. Dražkovická sto devatenáct. Tam ti řeknu, o co jde.', 'friend', 'low, glancing around'],
];
// At the kitchen table in Dražkovická 119: what the job is.
export const tableTalk = [
  ['table-01', 'Vašek', 'Sedni si.', 'friend', 'quiet, serious'],
  [
    'table-02',
    'Vašek',
    'Tak poslouchej. Jde o auto. Stojí u jedné vily v lese pod Kunětickou horou. Půl roku s ním nikdo nevyjel.',
    'friend',
    'low, leaning in',
  ],
  ['table-03', 'Ty', 'A co já s tím?', 'father', 'guarded'],
  ['table-04', 'Vašek', 'Dneska v noci ho odtamtud odvezeš.', 'friend', 'flat, direct'],
  ['table-05', 'Ty', 'Odvezu. Takže ho mám ukrást.', 'father', 'bitter, slowly'],
  [
    'table-06',
    'Vašek',
    'Jo. Mám na něj kupce a tobě z toho dám dvě stě padesát tisíc. Já řídit nesmím. Jedna hlídka a jdu sedět.',
    'friend',
    'honest, a little desperate',
  ],
  ['table-07', 'Vašek', 'Tady máš kuklu. Kdyby tě tam někde chytla kamera.', 'friend', 'practical'],
  ['table-08', 'Ty', 'Dobře. Udělám to.', 'father', 'after a long breath, decided'],
];
