// ==========================================================================
// What the city says — the corpus
//
// PURE DATA. No imports, no three.js, no DOM, no clock. Two consumers read
// this file and they must never disagree about a single character of it:
//
//   js/chatter.js         picks a line at runtime and shows/speaks it
//   scripts/gen-voices.mjs renders every line to mp3 via ElevenLabs
//
// which is the whole reason `tts` (a delivery direction for the voice model)
// lives here next to the Czech text the player reads, in a file the game
// imports. Two files would have drifted the first time somebody fixed a typo:
// the bubble would say one thing and the mp3 another, and nothing would fail
// loudly enough to notice. One list, one id, one truth.
//
// THE ID IS THE FILENAME. A line's `id` plus a cast key is exactly the name of
// its audio: `assets/voices/<id>__<cast>.mp3`. So an id is not a label, it is
// an asset path — renaming one orphans a generated file, and the generator
// will simply bill you for a new one. Add lines freely; rename them never.
//
// THE CAST is four people, and four is a considered number rather than a
// budget. One voice for the whole city is a city of clones. Two is a city of
// twins. Four is enough that you stop noticing, because the thing the ear
// actually tracks is not "how many voices exist" but "did that person's voice
// change between sentences" — and the answer here is no, ever: a citizen's
// voice is a pure function of the seed that already decides their jacket, so
// they keep it for their whole 420-second life, across every line they say and
// both halves of a conversation. That property is what costs the assets (every
// line is rendered by every cast member who could say it, ~950 clips) and it
// is the one worth paying for. Nothing else about a citizen is gendered — the
// box people are eleven identical boxes — so `g` here is a VOICE attribute,
// not a character one.
//
// `when` gates a line on the world clock: '' is always, and morning/noon/
// evening/night are read off worldclock.tod(). The weather values (rain, cold,
// hot, fog) are deliberately present and deliberately dead: this build has no
// weather, so chatter.js can never satisfy them and those lines simply never
// play. They are written, rendered and waiting, and the day sky.js grows a
// rain cloud they turn on by themselves.
// ==========================================================================

// One line. The positional helper is not brevity for its own sake: 314 object
// literals of six keys each is 1900 lines nobody reads, and the point of the
// corpus being in the repo (rather than a JSON blob) is that it stays
// diffable, greppable and editable by a human who wants to fix one word.
//   id    stable, unique, IS the audio filename stem
//   cat   which situation the line belongs to (see CATS below)
//   g     'm' only a man, 'f' only a woman, 'a' anyone
//   mood  drives the bubble's rim colour and nothing else
//   when  '' always, else a world-clock/weather gate
//   text  what the bubble shows and the voice says, verbatim
//   tts   delivery direction for the voice model — English, never a translation
const L = (id, cat, g, mood, when, text, tts) => ({ id, cat, g, mood, when, text, tts });

// One turn of a two-hander. `s` is the speaker slot (0 or 1), not a person.
const T = (s, mood, text, tts) => ({ s, mood, text, tts });

// One conversation. `g` is two characters, one per speaker slot, same alphabet
// as a line's `g` — so 'ff' is two women, 'mf' is a man talking to a woman and
// 'aa' does not care. A turn's audio id is `<conv id>_<turn index>`, which is
// why turns must never be reordered once generated.
const C = (id, g, topic, turns) => ({ id, g, topic, turns });

// The four voices of Pardubice. `key` is the filename suffix and the index
// into this array is what a citizen's seed selects, so the ORDER is load-
// bearing: reordering this array re-voices every citizen in the world and
// orphans nothing, which sounds harmless right up until a co-op partner on the
// old order hears a different person. Append, don't reshuffle.
// scripts/gen-voices.mjs maps these keys onto actual ElevenLabs voice ids; no
// vendor identifier belongs in a file the game ships.
export const CAST = [
  { key: 'm1', g: 'm' },   // middle-aged man, the default Czech bloke
  { key: 'm2', g: 'm' },   // older man, gruffer
  { key: 'f1', g: 'f' },   // middle-aged woman
  { key: 'f2', g: 'f' },   // younger woman
];

// The situations a line can belong to. Kept as a list so chatter.js can assert
// against it and gen-voices.mjs can report per-category counts.
export const CATS = ['nearmiss', 'horn', 'bump', 'hit', 'victim', 'bang', 'driver',
  'player', 'idle', 'local', 'tod', 'phone'];

export const LINES = [

  // ---- nearmiss — auto proletělo těsně kolem — leknutí a nadávka ----
  L('near_miss_jezismarja', 'nearmiss', 'a', 'scared', '', 'Ježišmarjá!', 'short terrified yelp, high pitch, cut off'),
  L('near_miss_ty_ses_blbej', 'nearmiss', 'a', 'angry', '', 'Ty vole, ty seš úplně blbej?!', 'shouted after the car, furious, fast'),
  L('near_miss_gratuluju_ridicak', 'nearmiss', 'a', 'annoyed', '', 'Gratuluju k řidičáku!', 'loud sarcastic shout, exaggerated politeness'),
  L('near_miss_kinder', 'nearmiss', 'a', 'annoyed', '', 'Řidičák z Kinder vajíčka, co?', 'dry mocking, half-laughing, spoken to the back of the car'),
  L('near_miss_prechod', 'nearmiss', 'a', 'angry', '', 'Tady je přechod, ne dálnice!', 'shouted, indignant, hitting each word'),
  L('near_miss_velka_pardubicka', 'nearmiss', 'a', 'angry', '', 'Zpomal, tady není Velká pardubická!', 'yelled from the pavement, angry local, fast'),
  L('near_miss_lekla_jsem_se', 'nearmiss', 'f', 'scared', '', 'Ježiš, já se tak lekla.', 'breathless, shaky, half to herself'),
  L('near_miss_o_fous', 'nearmiss', 'a', 'amused', '', 'Ty jo, to bylo o fous.', 'nervous laugh, adrenaline, quiet disbelief'),
  L('near_miss_dva_centimetry', 'nearmiss', 'a', 'shocked', '', 'To byly dva centimetry! Dva!', 'wide-eyed, loud, repeating the number in disbelief'),
  L('near_miss_deti', 'nearmiss', 'a', 'angry', '', 'Já mám doma dvě děti, ty vole!', 'shouted with real fear underneath, voice cracking'),
  L('near_miss_policie', 'nearmiss', 'a', 'angry', '', 'Volám policajty, ty magore!', 'shouted threat, phone already in hand, determined'),
  L('near_miss_klidek', 'nearmiss', 'a', 'friendly', '', 'Klídek, kamaráde, klídek.', 'calm, palms-up, oddly good-natured for the situation'),
  L('near_miss_slepejsi', 'nearmiss', 'a', 'angry', '', 'Hele, dávej bacha, ty slepejši!', 'barked, short, straight at the driver'),
  L('near_miss_no_dovolte', 'nearmiss', 'f', 'annoyed', '', 'No dovolte! Já tady přecházím.', 'offended, prim, older lady scolding'),
  L('near_miss_ticho', 'nearmiss', 'a', 'neutral', '', 'Ne. Já k tomu radši nic neřeknu.', 'flat, controlled, deliberately calm, quiet'),
  L('near_miss_za_nas', 'nearmiss', 'f', 'tired', '', 'Za nás se takhle nejezdilo.', 'resigned sigh, elderly, muttered to nobody'),
  L('near_miss_opily', 'nearmiss', 'm', 'drunk', '', 'Ty jedeš, nebo já stojím?', 'slurred, swaying, genuinely confused'),
  L('near_miss_denik', 'nearmiss', 'a', 'amused', '', 'Ještě kousek a jsem v Deníku.', 'dark joke, dry chuckle, still shaking'),
  L('near_miss_infarkt', 'nearmiss', 'a', 'scared', '', 'Z tebe budu mít infarkt.', 'hand on chest, breathy, half-shouted'),
  L('near_miss_nemam_den', 'nearmiss', 'a', 'sad', '', 'Já dneska fakt nemám den.', 'quiet, defeated, almost whispered'),
  L('near_miss_bez_svetel', 'nearmiss', 'a', 'annoyed', 'night', 'Ještě bez světel! Klobouk dolů!', 'sarcastic shout into the dark, bitter'),
  L('near_miss_v_desti', 'nearmiss', 'a', 'annoyed', 'rain', 'V tomhle dešti to takhle řežeš?', 'shouted through rain, incredulous, wiping face'),

  // ---- horn — někdo zatroubil — na mě, nebo na někoho vedle ----
  L('horn_startled_woman', 'horn', 'f', 'scared', '', 'Ježišmarjá, já se lekla!', 'sharp gasp, high pitch, startled, hand on chest'),
  L('horn_sorry_didnt_see', 'horn', 'm', 'friendly', '', 'Promiň, promiň, já tě fakt neviděl.', 'apologetic, fast, slightly embarrassed, half-laughing'),
  L('horn_where_to_labe', 'driver', 'a', 'angry', '', 'Kam mám jako jet, do Labe?', 'shouted through open window, furious, sarcastic edge'),
  L('horn_honk_all_night', 'driver', 'a', 'annoyed', '', 'Trub si třeba do rána, kolona je kolona.', 'flat, resigned, bored, not even turning head'),
  L('horn_trolleybus_jump', 'driver', 'a', 'annoyed', '', 'A ten trolejbus mám jako přeskočit?', 'exasperated question, rising tone, arms-up energy'),
  L('horn_almost_wet_pants', 'horn', 'm', 'shocked', '', 'Ty vole, málem jsem se počůral.', 'breathless, shaken, nervous laugh at the end'),
  L('horn_itchy_klakson', 'horn', 'a', 'amused', '', 'Co, svědí tě klakson?', 'dry mockery, slow, smirking, deadpan'),
  L('horn_old_slow', 'horn', 'a', 'sad', '', 'No jo, no. Já už nejsem nejrychlejší.', 'quiet, elderly, apologetic, slightly hurt'),
  L('horn_one_more_time', 'driver', 'm', 'angry', '', 'Zatrub ještě jednou a vystoupím.', 'low growl, threatening, slow and controlled'),
  L('horn_thought_someone_knew_me', 'horn', 'm', 'amused', '', 'Já myslel, že mě někdo zná.', 'wry, self-deprecating, chuckling to himself'),
  L('horn_its_red_genius', 'driver', 'a', 'annoyed', '', 'Vždyť je červená, ty chytrolíne.', 'clipped, condescending, pointing at the light'),
  L('horn_pardubice_normal', 'horn', 'a', 'neutral', '', 'V Pardubicích se troubí furt, zvykej si.', 'casual local wisdom, shrug in the voice, calm'),
  L('horn_drunk_confused', 'horn', 'm', 'drunk', 'night', 'Todle bylo na mě?', 'slurred, delayed, genuinely confused, swaying'),
  L('horn_sarcastic_thanks', 'horn', 'a', 'annoyed', '', 'No tak to ti teda pěkně děkuju.', 'heavy sarcasm, slow, fake-polite, bitter'),
  L('horn_rip_out_the_horn', 'horn', 'f', 'angry', '', 'Já bych mu ten klakson vytrhla.', 'muttered through teeth, venomous, to a bystander'),
  L('horn_people_sleeping', 'horn', 'a', 'angry', 'night', 'Lidi tady spěj, ty vole!', 'yelled down from a window at night, hoarse, furious'),
  L('horn_fog_excuse', 'horn', 'a', 'neutral', 'fog', 'V té mlze nevidím ani na kapotu.', 'defensive but calm, tired explanation, leaning forward'),
  L('horn_mistaken_greeting', 'horn', 'm', 'friendly', '', 'Ahoj! Já tě nepoznal.', 'cheerful shout, waving, completely misreading the horn'),
  L('horn_stalled_engine', 'driver', 'a', 'scared', '', 'Zhaslo mi to, no! Co mám dělat?', 'panicked, fast, voice cracking, hands shaking'),
  L('horn_im_walking_already', 'horn', 'a', 'tired', 'morning', 'Jdu, jdu, nekřič na mě.', 'mumbled, weary, shuffling across the crossing'),

  // ---- bump — hráč do někoho vrazil pěšky ----
  L('bump_pardon_nic', 'bump', 'a', 'friendly', '', 'Pardon, to nic, to se stane.', 'quick and light, brushing it off, half a smile'),
  L('bump_ja_stal_blbe', 'bump', 'm', 'friendly', '', 'Jé, promiňte, já stál blbě.', 'flustered, apologizing for something that wasn\'t his fault'),
  L('bump_ne_ne_to_ja', 'bump', 'a', 'friendly', '', 'Ne ne, to já, promiňte.', 'hurried, overlapping, taking the blame first'),
  L('bump_no_dovolte', 'bump', 'f', 'annoyed', '', 'No dovolte!', 'sharp, offended, chin up, single clipped burst'),
  L('bump_davej_bacha', 'bump', 'm', 'annoyed', '', 'Ty vole, dávej bacha!', 'loud bark right after the impact, gruff'),
  L('bump_jeste_jednou', 'bump', 'm', 'angry', '', 'Ještě jednou a máš problém.', 'low, slow, quiet menace, close to the face'),
  L('bump_hori_nekde', 'bump', 'a', 'annoyed', '', 'Kam se ženeš, hoří někde?', 'shouted after him, sarcastic, rising at the end'),
  L('bump_lekla_jsem_se', 'bump', 'f', 'scared', '', 'Ježišmarjá, já se lekla!', 'startled gasp, hand on chest, breathy'),
  L('bump_aha_tak_nic', 'bump', 'a', 'neutral', '', 'Aha. Tak nic.', 'flat, resigned, two dead beats with a pause'),
  L('bump_stihame_vlak', 'bump', 'm', 'amused', 'morning', 'Copak, stíháme vlak, jo?', 'dry sarcasm, amused, slight chuckle underneath'),
  L('bump_chodnik_pro_vsechny', 'bump', 'f', 'annoyed', '', 'Chodník je pro všechny, ne?', 'lecturing tone, irritated, ends as a challenge'),
  L('bump_sedla_na_zadek', 'bump', 'f', 'shocked', '', 'Málem jsem si sedla na zadek.', 'shaken, still catching balance, voice a bit high'),
  L('bump_hovado', 'bump', 'm', 'angry', '', 'Ty seš ale hovado.', 'spat out with disgust, contemptuous, not shouted'),
  L('bump_jenom_stal', 'bump', 'm', 'sad', '', 'Já tady jenom stál, no.', 'quiet, defeated, talking mostly to himself'),
  L('bump_vajicka_v_tasce', 'bump', 'f', 'shocked', '', 'Bacha, mám v tašce vajíčka!', 'panicked yelp, clutching the bag, fast'),
  L('bump_oci_na_to', 'bump', 'm', 'angry', '', 'Oči na to nemáš, nebo co?', 'aggressive, leaning in, hard consonants'),
  L('bump_zvyknu_si', 'bump', 'a', 'annoyed', '', 'Klidně mě poražte, já si zvyknu.', 'heavy sarcasm, martyred sigh, slow'),
  L('bump_trida_miru', 'bump', 'a', 'annoyed', '', 'Na Třídě Míru se courá, ne běhá.', 'grumbling local, matter-of-fact, slightly nagging'),
  L('bump_opily_kamo', 'bump', 'm', 'drunk', 'night', 'Hele... kámo... ty seš kdo?', 'slurred, swaying, long pauses, friendly confusion'),
  L('bump_z_nocni', 'bump', 'a', 'tired', 'night', 'Já jdu z noční, prosím tě.', 'exhausted, no energy to be angry, mumbled'),

  // ---- hit — někoho srazilo auto — svědci, panika, pomoc ----
  L('hit_scream_ohno', 'hit', 'f', 'shocked', '', 'Ježišmarjá, ona ho srazila!', 'screamed from the sidewalk, high pitched, panicked'),
  L('hit_call_155', 'hit', 'a', 'scared', '', 'Zavolal někdo sto padesát pět?', 'shouted into the crowd, urgent, breathless'),
  L('hit_dont_move', 'hit', 'a', 'neutral', '', 'Nehýbejte s ním, ať leží!', 'firm and loud, taking charge, no panic'),
  L('hit_breathing', 'hit', 'f', 'scared', '', 'Dýchá? Řekněte mi, jestli dýchá!', 'shaky voice, close to tears, rushed'),
  L('hit_driver_fled', 'hit', 'a', 'angry', '', 'Ten ani nezastavil, hajzl jeden!', 'yelled after a departing car, furious, spitting'),
  L('hit_plate', 'hit', 'm', 'angry', '', 'Značku! Zapište si tu značku!', 'barked across the street, fast, commanding'),
  L('hit_nurse', 'hit', 'f', 'neutral', '', 'Pusťte mě k němu, jsem sestra.', 'calm but forceful, pushing through people'),
  L('hit_filming', 'hit', 'm', 'amused', '', 'Počkej, tohle musím natočit.', 'casual, half-laughing, phone already up'),
  L('hit_stop_filming', 'hit', 'a', 'angry', '', 'Nech ten mobil a pomoz, debile!', 'shouted at someone nearby, disgusted, sharp'),
  L('hit_phone_address', 'hit', 'a', 'scared', '', 'Kde to jsme? Na třídě Míru, u pošty!', 'talking into a phone, hurried, voice cracking'),
  L('hit_walk_away', 'hit', 'm', 'scared', '', 'Já nic neviděl, já jdu dál.', 'muttered while walking off fast, avoiding eye contact'),
  L('hit_green_light', 'hit', 'f', 'angry', '', 'Šel na zelenou, já to viděla!', 'indignant, loud, pointing at the crossing'),
  L('hit_driver_excuse', 'driver', 'm', 'shocked', '', 'Já ho neviděl, vběhl mi pod kola!', 'stammering, defensive, hands shaking'),
  L('hit_victim_leg', 'victim', 'a', 'angry', '', 'Do prdele, moje noha.', 'groaned through teeth, pain, low'),
  L('hit_victim_fine', 'victim', 'a', 'annoyed', '', 'Nechte mě, já jsem v pohodě.', 'grumbled while getting up, embarrassed, waving people off'),
  L('hit_victim_glasses', 'victim', 'a', 'annoyed', '', 'Kde mám brýle? Nešlápněte na ně.', 'dazed, patting the ground, slightly slurred'),
  L('hit_victim_pride', 'victim', 'a', 'amused', '', 'Bolí mě hlavně hrdost.', 'dry, wincing, quiet self-deprecating chuckle'),
  L('hit_dark_trolley', 'hit', 'm', 'amused', '', 'Ten už na trolejbus nespěchá.', 'flat deadpan aside to a bystander, dark'),
  L('hit_old_lady', 'hit', 'f', 'sad', '', 'Chudák, vždyť je to ještě dítě.', 'trembling elderly voice, quiet, near tears'),
  L('hit_stay_awake', 'hit', 'a', 'scared', '', 'Držím vás, neusínejte, slyšíte?', 'kneeling close, urgent, trying to sound calm'),

  // ---- bang — bouračka, výbuch, požár, vrtulník — komentář zvenčí ----
  L('witness_saw_that', 'bang', 'a', 'shocked', '', 'Ty vole, viděls to?', 'blurted out mid-street, stunned, pointing'),
  L('witness_what_was_that', 'bang', 'a', 'scared', '', 'Co to sakra bylo?!', 'yelped, startled, high pitch, fast'),
  L('witness_semtin_boom', 'bang', 'a', 'shocked', '', 'To muselo bejt slyšet až v Semtíně.', 'said slowly, ears still ringing, half to self'),
  L('witness_car_fire', 'bang', 'f', 'scared', '', 'Ježišmarjá, to auto hoří!', 'cried out, panicked, backing away'),
  L('witness_on_tv', 'bang', 'a', 'amused', '', 'To bude večer v telce.', 'said dryly, arms crossed, unimpressed'),
  L('witness_call_ambulance', 'bang', 'f', 'scared', '', 'Volám záchranku, vydržte!', 'shouted toward the wreck, urgent, breathless'),
  L('witness_jet_airport', 'bang', 'm', 'neutral', '', 'Klid, to je stíhačka z letiště.', 'explained calmly, know-it-all local, flat'),
  L('witness_heli_low', 'bang', 'a', 'annoyed', '', 'Ten vrtulník lítá nechutně nízko.', 'grumbled while squinting up, irritated'),
  L('witness_filming', 'bang', 'a', 'amused', '', 'Já to natáčím, tohle bude hit.', 'said gleefully, phone raised, quick'),
  L('witness_not_gas', 'bang', 'a', 'annoyed', '', 'To nebyl plyn, to mi nevykládejte.', 'said stubbornly, conspiratorial, jabbing finger'),
  L('witness_gov_silence', 'bang', 'm', 'neutral', '', 'V telce o tom zase nic neřeknou.', 'muttered low, conspiratorial, resigned'),
  L('witness_anyone_inside', 'bang', 'f', 'scared', '', 'Panebože, je tam někdo uvnitř?', 'asked shakily, hand over mouth, trembling'),
  L('witness_shooting_down', 'bang', 'a', 'scared', '', 'Střílí se! K zemi!', 'screamed, ducking, raw panic, very fast'),
  L('witness_rockets', 'bang', 'a', 'shocked', '', 'Rakety? U nás v Pardubicích?', 'asked in disbelief, voice cracking upward'),
  L('witness_dry_landing', 'bang', 'm', 'amused', '', 'No a je to. Pěkně to sletělo.', 'commented dryly, deadpan, like watching football'),
  L('witness_normal_day', 'bang', 'a', 'tired', '', 'Normální úterý v Pardubicích.', 'sighed sarcastically, worn out, walking on'),
  L('witness_building_falls', 'bang', 'a', 'scared', '', 'Ten barák padá! Utíkejte!', 'shouted at full volume, terrified, running'),
  L('witness_drunk_saw_it', 'bang', 'm', 'drunk', 'night', 'Já to viděl, fakt, letělo to.', 'slurred, swaying, insisting to nobody'),
  L('witness_driver_fled', 'bang', 'a', 'angry', '', 'Von ujel! Ten hajzl prostě ujel!', 'shouted after the car, furious, clipped'),
  L('witness_victim_pity', 'bang', 'a', 'sad', '', 'Ten už nevystoupí, chudák.', 'said quietly, heavy, almost a whisper'),

  // ---- driver — řidič křičí z okýnka ----
  L('driver_tak_jed', 'driver', 'a', 'angry', '', 'Tak jeď, sakra! Zelená už svítí!', 'shouted out of a car window, impatient, fast, angry'),
  L('driver_zelena_modra', 'driver', 'm', 'amused', '', 'Zelená! Nebo čekáš, až bude modrá?', 'leaning out of the window, mocking, half-laughing'),
  L('driver_couvas_debile', 'driver', 'm', 'angry', '', 'Kam couváš, ty debile?!', 'sudden panicked shout turning into rage, very loud'),
  L('driver_krizovatka_parkoviste', 'driver', 'f', 'angry', '', 'Křižovatka není parkoviště, kruci!', 'sharp furious yell, clipped, woman\'s voice'),
  L('driver_naklad_brzda', 'driver', 'm', 'angry', '', 'Tohle nezabrzdím jako kolo, blbe!', 'deep booming shout from a truck cab, angry, slow and heavy'),
  L('driver_chodnik_vlevo', 'driver', 'f', 'annoyed', '', 'Chodník je vlevo, ne pod mýma kolama.', 'irritated, flat delivery through an open window'),
  L('driver_ridicak_los', 'driver', 'm', 'annoyed', '', 'Řidičák sis vylosoval, co?', 'sneering, sarcastic, spoken loudly across the lane'),
  L('driver_blinkr', 'driver', 'a', 'annoyed', '', 'Blinkr! Blinkr, člověče, blinkr!', 'repeated shouts, escalating, exasperated'),
  L('driver_taxi_tarif', 'driver', 'm', 'annoyed', '', 'Mně běží tarif, tobě nic. Uhni!', 'taxi driver, gruff, businesslike then barking the last word'),
  L('driver_bus_dubina', 'driver', 'm', 'annoyed', '', 'Vezu plnou dvojku na Dubinu, uhni!', 'bus driver shouting over engine noise, tired and pushy'),
  L('driver_prsi_couras', 'driver', 'a', 'annoyed', 'rain', 'Prší a ty se couráš po silnici?', 'shouted through rain, hoarse, disbelieving'),
  L('driver_kuryr_baliky', 'driver', 'a', 'tired', '', 'Mám třicet balíků a hodinu času.', 'courier, breathless and worn out, rushed'),
  L('driver_senior_drive', 'driver', 'm', 'tired', '', 'Za nás se takhle nechodilo, mladej.', 'elderly man, slow, disapproving, weary'),
  L('driver_rano_semtin', 'driver', 'm', 'tired', 'morning', 'Jedu na šestou do Semtína, prosím tě.', 'early morning, worn out, pleading more than shouting'),
  L('driver_malem_prejel', 'driver', 'm', 'scared', '', 'Do prdele, málem jsem tě přejel!', 'shaken, adrenaline in the voice, loud and breathless'),
  L('driver_klepou_ruce', 'driver', 'f', 'scared', '', 'Klepou se mi ruce, ty jeden blázne.', 'trembling voice, quiet at first then rising, still in shock'),
  L('driver_ironie_pockam', 'driver', 'f', 'amused', '', 'Klidně tam stůj, já mám času moře.', 'dripping sarcasm, sweet tone hiding annoyance'),
  L('driver_zblaznil', 'driver', 'f', 'shocked', '', 'Ježišmarjá, ty ses zbláznil?!', 'genuine shock, high pitched, sudden'),
  L('driver_opily_dva', 'driver', 'm', 'drunk', 'night', 'Ty seš tam dva. Na kterýho troubit?', 'slurred, slow, oddly cheerful, late at night'),
  L('driver_senior_pozor', 'driver', 'f', 'friendly', '', 'Mladej, dávej na sebe pozor, jo?', 'kind elderly woman, warm, a little concerned'),
  L('driver_tady_nestuj', 'driver', 'a', 'neutral', '', 'Hele, tady se fakt stát nedá.', 'matter-of-fact, calm, spoken not shouted'),
  L('driver_nestiham_nic', 'driver', 'm', 'sad', '', 'Já dneska nestihnu vůbec nic.', 'resigned sigh, defeated, quiet'),

  // ---- player — hráč stojí moc blízko, civí, jde za mnou ----
  L('player_near_co_cumis', 'player', 'm', 'angry', '', 'Co čumíš, vole?', 'barked straight at the face, aggressive, short'),
  L('player_near_muzu_pomoct', 'player', 'f', 'annoyed', '', 'Můžu vám nějak pomoct?', 'passive-aggressive, fake politeness, raised eyebrow'),
  L('player_near_uhni', 'player', 'a', 'annoyed', '', 'Uhni, stojíš mi v cestě.', 'impatient, clipped, mid-step'),
  L('player_near_dobry_den', 'player', 'a', 'friendly', '', 'Dobrý den.', 'polite quick greeting in passing, warm'),
  L('player_near_ohen', 'player', 'm', 'neutral', '', 'Nemáte oheň, prosím vás?', 'casual, cigarette already in mouth, slightly mumbled'),
  L('player_near_jdes_za_mnou', 'player', 'f', 'scared', '', 'Ty jdeš za mnou, nebo co?', 'looking back over shoulder, tense, quiet'),
  L('player_near_na_obliceji', 'player', 'a', 'annoyed', '', 'Mám něco na obličeji, nebo co?', 'sarcastic, flat delivery, tired of being stared at'),
  L('player_near_chodnik_sirokej', 'player', 'm', 'annoyed', '', 'Chodník je širokej, hele.', 'grumbling sideways while squeezing past'),
  L('player_near_znam_vas', 'player', 'f', 'neutral', '', 'Já vás odněkud znám?', 'genuinely puzzled, squinting, slow'),
  L('player_near_nic_nekupuju', 'player', 'a', 'tired', '', 'Nic nekupuju, děkuju.', 'defensive brush-off, walking away mid-sentence'),
  L('player_near_drobny', 'player', 'a', 'tired', '', 'Drobný nemám, promiňte.', 'weary, automatic, eyes down'),
  L('player_near_nazdar', 'player', 'm', 'friendly', '', 'Nazdar, jak je?', 'cheerful street greeting, quick and loud'),
  L('player_near_od_grandu', 'player', 'f', 'scared', '', 'Ty mě sleduješ už od Grandu?', 'accusing but shaky, half-whisper, fast'),
  L('player_near_volam_policii', 'player', 'a', 'scared', '', 'Ještě krok a volám policii.', 'threatening through fear, phone already in hand'),
  L('player_near_dobry_vecer', 'player', 'a', 'friendly', 'evening', 'Dobrý večer, pěkně se ochladilo.', 'warm small talk with a stranger, unhurried'),
  L('player_near_ochranka', 'player', 'm', 'amused', '', 'Vy jste ochranka, nebo co?', 'teasing, half-laughing, eyebrows up'),
  L('player_near_cigaro_opily', 'player', 'm', 'drunk', '', 'Hele kámo, nemáš cigáro?', 'slurred, swaying, overly familiar'),
  L('player_near_leje', 'player', 'a', 'neutral', 'rain', 'Pěkně leje, co?', 'resigned small talk under a hood, wet and loud rain'),
  L('player_near_zima', 'player', 'f', 'annoyed', 'cold', 'Kruci, to je zima, viďte?', 'shivering, teeth clenched, quick'),
  L('player_near_v_noci', 'player', 'm', 'annoyed', 'night', 'Co tady v noci okouníte?', 'suspicious old man, low voice, from a doorway'),

  // ---- idle — mumlání pro sebe cestou po ulici ----
  L('idle_late_again', 'idle', 'a', 'annoyed', '', 'Zase jdu pozdě. No jasně.', 'muttered under the breath while walking fast, resigned'),
  L('idle_forgot_bread', 'idle', 'm', 'annoyed', '', 'Chleba. Chleba jsem zase nekoupil.', 'talking to himself, sudden realization, flat irritation'),
  L('idle_forgot_milk', 'idle', 'f', 'annoyed', '', 'Mlíko. Zapomněla jsem mlíko.', 'quiet self-scolding, stops mid-step'),
  L('idle_rain_again', 'idle', 'a', 'annoyed', 'rain', 'No a už zase prší. To je nádhera.', 'heavy sarcasm, looking up at the sky'),
  L('idle_beer_price', 'idle', 'm', 'shocked', '', 'Šedesát korun za pivo. Zbláznili se.', 'outraged disbelief, half-whisper, shaking head'),
  L('idle_two_hours_left', 'idle', 'a', 'tired', '', 'Ještě dvě hodiny a mám padla.', 'exhausted, counting down, dragging voice'),
  L('idle_mother_in_law', 'idle', 'a', 'annoyed', '', 'V neděli přijede tchyně. Radši budu marodit.', 'dry, deadpan, muttered to nobody'),
  L('idle_dynamo_lost', 'idle', 'm', 'sad', '', 'Dynamo zase dostalo pětku. Nádhera.', 'bitter sports-fan sarcasm, deflated'),
  L('idle_back_hurts', 'idle', 'a', 'tired', '', 'Ty záda. Já se snad ani neohnu.', 'groaning mid-sentence, older voice, wincing'),
  L('idle_one_beer', 'idle', 'm', 'friendly', 'evening', 'Dám si jedno. Jenom jedno, fakt.', 'cheerful self-negotiation, unconvincing promise'),
  L('idle_paramo_smell', 'idle', 'a', 'annoyed', '', 'Zase to smrdí od Parama.', 'sniffing, disgusted, muttered as a fact of life'),
  L('idle_trolley_missed', 'idle', 'a', 'annoyed', '', 'Trolejbus mi ujel před nosem.', 'defeated, slightly out of breath, arms-down tone'),
  L('idle_dostihy', 'idle', 'a', 'neutral', '', 'Na dostihy letos nejdu. Ani náhodou.', 'firm decision spoken out loud to nobody'),
  L('idle_cold_bite', 'idle', 'a', 'annoyed', 'cold', 'Ježišmarjá, to je kosa.', 'shivering, hissed through teeth'),
  L('idle_hot_day', 'idle', 'a', 'tired', 'hot', 'Já se tady snad uvařím.', 'slow, melting, wiping forehead'),
  L('idle_payday', 'idle', 'a', 'sad', '', 'Do výplaty devět dní. Super.', 'flat sarcasm, quiet, staring ahead'),
  L('idle_dog_mess', 'idle', 'a', 'angry', '', 'Kdo tohle po tom psovi uklidí? No kdo.', 'indignant, looking down at the pavement, rhetorical'),
  L('idle_roadworks', 'idle', 'a', 'annoyed', '', 'Zase kopou na třídě Míru.', 'weary complaint, said like it happens every year'),
  L('idle_kid_note', 'idle', 'a', 'annoyed', '', 'Malej má zase poznámku. Bezva.', 'parental sarcasm, sighing before the last word'),
  L('idle_hangover', 'idle', 'm', 'tired', 'morning', 'Už nikdy víc. Jako minule.', 'hoarse, hungover, self-aware mumble'),
  L('idle_keys_check', 'idle', 'a', 'neutral', '', 'Mám klíče? Mám klíče.', 'first half anxious question, second half relieved, patting pocket'),
  L('idle_parking', 'idle', 'm', 'angry', '', 'Zaparkovat se tady nedá. Nikde.', 'frustrated, clipped, jabbing the words'),
  L('idle_pernik', 'idle', 'a', 'neutral', '', 'Nezapomenout perník pro babičku.', 'reminding self out loud, sing-song memo tone'),
  L('idle_shoes_hurt', 'idle', 'f', 'tired', '', 'Tyhle boty mě zabijou.', 'pained, limping slightly, muttered'),
  L('idle_morning_meh', 'idle', 'a', 'tired', 'morning', 'Ráno je svinstvo. Na to není lék.', 'grumbling philosophy, low and slow'),
  L('idle_late_night', 'idle', 'a', 'tired', 'night', 'Půl dvanáctý a já se courám po městě.', 'amused at himself, quiet, wandering'),
  L('idle_fog', 'idle', 'a', 'neutral', 'fog', 'V týhle mlze nevidím ani na špičky bot.', 'squinting, half-laughing, muttered observation'),
  L('idle_boss_rant', 'idle', 'm', 'angry', '', 'Šéf ať mi vleze na záda.', 'venting to himself, low growl, bitter'),
  L('idle_lottery_dream', 'idle', 'a', 'amused', '', 'Kdybych vyhrál, tak už tu nejsem.', 'daydreaming, small chuckle at the end'),
  L('idle_husband_mug', 'idle', 'f', 'annoyed', '', 'Ten můj zase neumyl ani hrnek.', 'exasperated wife tone, muttered, eye-roll audible'),

  // ---- local — lokální kolorit — perník, přilba, Paramo, Dynamo ----
  L('pardubice_pernik_darek', 'local', 'a', 'annoyed', '', 'Zase perník? Já mám doma tři krabice.', 'flat resigned complaint, mild eye-roll, medium pace'),
  L('pardubice_paramo_smrad', 'local', 'm', 'amused', '', 'Cejtíš to? To je Paramo, vítej doma.', 'dry sarcastic welcome, half-laughing, casual'),
  L('pardubice_prilba_vecer', 'local', 'm', 'friendly', 'evening', 'V sobotu přilba, tak si dej pohov s prací.', 'warm buddy tone, relaxed, slight grin'),
  L('pardubice_taxis_pokazde', 'local', 'a', 'sad', '', 'Na Taxisu to skončí vždycky stejně.', 'quiet sigh, resigned, slow'),
  L('pardubice_dynamo_zase', 'local', 'm', 'annoyed', '', 'Dynamo prohrálo, no jasně že jo.', 'bitter fan grumble, clipped, downbeat'),
  L('pardubice_mlyny_hipsteri', 'local', 'm', 'shocked', '', 'V mlýnech kafe za stovku, ty vole.', 'incredulous, loud-ish, disbelieving'),
  L('pardubice_zelena_brana_schody', 'local', 'f', 'tired', '', 'Na bránu už podruhé nelezu, díky.', 'out of breath, tired, light humor'),
  L('pardubice_rychlik_praha', 'local', 'a', 'friendly', '', 'Do Prahy hodinu, to je celý kouzlo.', 'matter-of-fact pride, calm, conversational'),
  L('pardubice_labe_smrdi', 'local', 'f', 'annoyed', 'hot', 'Labe dneska nějak divně smrdí.', 'wrinkled-nose remark, quiet, mildly disgusted'),
  L('pardubice_semtin_bouchlo', 'local', 'm', 'shocked', '', 'V Semtíně zase něco bouchlo nebo co?', 'startled question, fast, half-joking'),
  L('pardubice_foxconn_smena', 'local', 'm', 'tired', 'morning', 'Ranní ve Foxconnu, to je fakt život.', 'deadpan sarcasm, exhausted, slow'),
  L('pardubice_trida_miru_tramvaj', 'local', 'a', 'annoyed', '', 'Na třídě Míru zas někdo troubí na trolejbus.', 'irritated observation, medium pace'),
  L('pardubice_polabiny_panelaky', 'local', 'm', 'amused', '', 'Polabiny, to je vesnice v paneláku.', 'wry joke to a friend, light chuckle'),
  // Filed under local rather than tod: it was written as a weather line and
  // has no clock gate, and an ungated line in the time-of-day pool is an idle
  // mutter in the wrong drawer — which is exactly what the test that moved it
  // here is for. A local complaining about the one windy spot in town works
  // any hour of the day.
  L('local_most_pres_labe_fouka', 'local', 'a', 'shocked', '', 'Na mostě přes Labe to fouká!', 'shouted against strong wind, strained, loud'),
  L('pardubice_dukla_hospoda', 'local', 'm', 'drunk', 'evening', 'Na Dukle je nejlepší pivo, konec debaty.', 'slightly slurred, insistent, loud'),
  L('pardubice_most_bartose', 'local', 'f', 'annoyed', '', 'Přes Bartošák to zase stojí, ježišmarjá.', 'frustrated driver, sharp, exasperated'),
  L('pardubice_zamek_valy', 'local', 'f', 'friendly', '', 'Na valech u zámku je klid, běž tam.', 'gentle recommendation, warm, unhurried'),
  L('pardubice_machonka_prujezd', 'local', 'a', 'neutral', '', 'Machoňkou to zkrátíš, jestli teda spěcháš.', 'quick helpful local tip, brisk'),
  L('pardubice_svitkov_zavody', 'local', 'm', 'annoyed', '', 'Ve Svítkově je dneska randál až sem.', 'complaining across a fence, mildly raised voice'),
  L('pardubice_chrudimka_rybar', 'local', 'm', 'annoyed', '', 'Na Chrudimce ti nic nechytnu, dej pokoj.', 'grumpy old fisherman, gruff, low'),
  L('pardubice_letiste_hluk', 'local', 'f', 'angry', '', 'Zase to letadlo, já se z toho picnu.', 'shouted upward at the sky, exasperated'),
  L('pardubice_rosice_nadrazi', 'local', 'a', 'neutral', '', 'Bydlím v Rosicích, jo, u těch kolejí.', 'casual self-introduction, plain, unbothered'),
  L('pardubice_pardubicky_konec', 'local', 'm', 'amused', '', 'Pardubičky? To je skoro Chrudim, vole.', 'teasing jab at a friend, laughing'),
  L('pardubice_cihelna_temno', 'local', 'f', 'scared', 'night', 'Přes Cihelnu v noci fakt nejdu.', 'hushed nervous refusal, quiet, tense'),
  L('pardubice_velka_sazka', 'local', 'm', 'sad', '', 'Vsadil jsem na favorita a mám prázdný kapsy.', 'defeated mutter, slow, self-mocking'),

  // ---- tod — vázané na denní dobu ----
  L('weather_morning_trolejbus_ujel', 'tod', 'a', 'tired', 'morning', 'Trolejbus mi ujel přímo před nosem.', 'groggy morning grumble, flat and defeated, slow'),
  L('weather_morning_bez_kafe', 'tod', 'a', 'tired', 'morning', 'Bez kafe se mnou nemluv.', 'mumbled warning, low energy, barely opening the mouth'),
  L('weather_morning_sichta_syntheska', 'tod', 'a', 'annoyed', 'morning', 'Šichta v Synthesce, no nazdar.', 'resigned sigh at the start of a shift, dry'),
  L('weather_morning_dobre_rano_ironie', 'tod', 'a', 'amused', 'morning', 'Dobrý ráno, i když dobrý není.', 'dry ironic greeting, half smile, unhurried'),
  L('weather_noon_obed_hlad', 'tod', 'a', 'friendly', 'noon', 'Deme na oběd, mám hlad jak trám.', 'cheerful call to a workmate, brisk and warm'),
  L('weather_noon_kratka_pauza', 'tod', 'a', 'annoyed', 'noon', 'Půlhodina pauza, to je k smíchu.', 'bitter complaint while chewing, clipped'),
  L('weather_evening_jedno_u_brany', 'tod', 'a', 'friendly', 'evening', 'Jdu na jedno k Zelený bráně.', 'relaxed after-work invitation, easy and warm'),
  L('weather_evening_domu_plny_zuby', 'tod', 'a', 'tired', 'evening', 'Konečně domů, mám toho plný zuby.', 'long exhale, worn out, dropping the shoulders'),
  L('weather_evening_dynamo_hraje', 'tod', 'a', 'amused', 'evening', 'Zapni to, Dynamo hraje!', 'excited shout across the room, fast and loud'),
  L('weather_night_kdo_tu_chodi', 'tod', 'a', 'scared', 'night', 'Kdo tu v tuhle hodinu ještě chodí?', 'nervous half whisper, glancing around, unsteady'),
  L('weather_night_opilec_bydliste', 'tod', 'a', 'drunk', 'night', 'Já bydlím někde tady, asi.', 'slurred, swaying, trailing off at the end'),
  L('weather_night_nelez_sem', 'tod', 'a', 'neutral', 'night', 'V noci sem radši nelez.', 'quiet flat warning, matter of fact, low voice'),
  L('weather_night_co_tu_delas', 'tod', 'a', 'annoyed', 'night', 'Hele, co tu děláš ve tři ráno?', 'suspicious challenge, sharp, stepping closer'),
  L('weather_rain_zase_leje', 'tod', 'a', 'annoyed', 'rain', 'Zase leje, no jasně, klasika.', 'fed up mutter under the rain, sarcastic'),
  L('weather_rain_pod_destnik', 'tod', 'a', 'friendly', 'rain', 'Pojď pod deštník, promokneš.', 'kind offer, raised voice over rain noise'),
  L('weather_rain_promoklej_na_kost', 'tod', 'm', 'angry', 'rain', 'Sem promoklej na kost, do prdele.', 'angry, shivering, spitting the words out'),
  L('weather_cold_mrzne_az_prasti', 'tod', 'a', 'annoyed', 'cold', 'Mrzne, až to praští, ty vole.', 'teeth chattering, gruff, breath visible'),
  L('weather_cold_promrzla', 'tod', 'f', 'sad', 'cold', 'Jsem promrzlá skrz naskrz.', 'small shaky voice, miserable, trembling'),
  L('weather_hot_jak_trouba', 'tod', 'a', 'annoyed', 'hot', 'Vedro jak když otevřeš troubu.', 'heat exhausted complaint, slow, wiping the forehead'),
  L('weather_hot_k_labi', 'tod', 'a', 'friendly', 'hot', 'Jdu se zchladit k Labi.', 'lazy summer remark, relaxed, half smiling'),
  L('weather_fog_od_labe', 'tod', 'a', 'neutral', 'fog', 'Od Labe leze mlha, nevidím na krok.', 'hushed observation, slow, slightly uneasy'),

  // ---- phone — útržek telefonátu při míjení ----
  L('phone_faktura_streda', 'phone', 'a', 'annoyed', '', 'Ne, tu fakturu jsem posílal už ve středu.', 'phone call, defensive, slightly exasperated, mid-sentence'),
  L('phone_mami_volam_vecer', 'phone', 'a', 'friendly', '', 'Mami, já ti volám večer, teď fakt nemůžu.', 'phone call, warm but hurried, walking fast'),
  L('phone_vyridime_doma', 'phone', 'a', 'angry', '', 'To si teda vyřídíme, až přijdu domů.', 'phone call, low threatening voice, teeth clenched'),
  L('phone_sraz_zelena_brana', 'phone', 'a', 'neutral', '', 'Sejdem se pod Zelenou bránou, v šest.', 'phone call, matter-of-fact, arranging a meeting'),
  L('phone_objednavka_pizza', 'phone', 'a', 'neutral', '', 'Dvě velký šunkový a jednu kolu, jo.', 'phone call, ordering food, flat and quick'),
  L('phone_sef_na_ceste', 'phone', 'a', 'scared', '', 'Já jsem na cestě, šéfe, fakt už tam skoro jsem.', 'phone call, lying to the boss, nervous and too eager'),
  L('phone_on_ti_keca', 'phone', 'a', 'angry', '', 'To není pravda, to on ti kecá.', 'phone call, sharp denial, cutting the other person off'),
  L('phone_udelej_si_sam', 'phone', 'a', 'annoyed', '', 'Tak si to teda udělej sám, ne?', 'phone call, sarcastic, fed up'),
  L('phone_neslysim_trolejbus', 'phone', 'a', 'annoyed', '', 'Neslyším tě, sedím v trolejbusu.', 'phone call, half shouting over background noise'),
  L('phone_prines_chleba', 'phone', 'a', 'neutral', '', 'Přines chleba, došel nám. A mlíko.', 'phone call, quick household instruction, no ceremony'),
  L('phone_uz_zase', 'phone', 'f', 'shocked', '', 'Ježišmarjá, a to už zase?', 'phone call, disbelief, breathy gasp'),
  L('phone_zlodejna_vyfuk', 'phone', 'm', 'angry', '', 'Sedmnáct set za výfuk? To je zlodějna.', 'phone call, outraged about a price, loud'),
  L('phone_pivo_v_osm', 'phone', 'm', 'friendly', '', 'Dneska v osm na pivo, platí?', 'phone call, cheerful, easy invitation'),
  L('phone_opilej_v_pohode', 'phone', 'm', 'drunk', 'night', 'Ale já jsem úplně v pohodě, fakt jo.', 'phone call, slurred, insisting he is fine'),
  L('phone_padam_na_hubu', 'phone', 'a', 'tired', 'evening', 'Dneska už nemůžu, padám na hubu.', 'phone call, exhausted sigh, trailing off'),
  L('phone_babicka_v_nedeli', 'phone', 'f', 'annoyed', '', 'Babička prej přijede v neděli. Zase.', 'phone call, dry resignation, eye-roll in the voice'),
  L('phone_rekni_ze_jsem_tu_nebyl', 'phone', 'm', 'scared', '', 'Řekni jí, že jsem tu nebyl, jo?', 'phone call, hushed, glancing over his shoulder'),
  L('phone_tak_nic_ahoj', 'phone', 'f', 'sad', '', 'No jo... já vím. Tak nic, ahoj.', 'phone call, quiet, defeated, ending the call'),
  L('phone_cekej_u_samosky', 'phone', 'a', 'friendly', '', 'Čekej u samošky v Polabinách.', 'phone call, casual, giving directions'),
  L('phone_sazka_na_klisnu', 'phone', 'm', 'amused', '', 'Vsadil jsem tři stovky na tu klisnu.', 'phone call, grinning, half bragging half joking'),
];

export const CONVS = [

  // ---- drby a řeči na ulici ----
  C('conv_street_soused_parkovani', 'mm', 'parkování před domem', [T(0, 'annoyed', 'Vy jste mi zase stál na mým místě.', 'grumpy neighbor, clipped, passive-aggressive'), T(1, 'neutral', 'Tam přece žádná cedule není.', 'defensive, shrugging it off'), T(0, 'annoyed', 'Cedule ne. Ale všichni to vědí.', 'slow, pointed, quietly seething')]),
  C('conv_street_babicky_ceny', 'ff', 'ceny v obchodě', [T(0, 'shocked', 'Vidělas, co stojí to máslo?', 'elderly woman, scandalized, leaning in'), T(1, 'neutral', 'Já ho beru jenom v akci.', 'matter-of-fact, resigned'), T(0, 'amused', 'Za chvíli si namažem chleba vzduchem.', 'dry old-lady joke, small laugh at the end')]),
  C('conv_street_puberta_babicka', 'mm', 'náhodné setkání', [T(0, 'friendly', 'Ty vole, kde ses tu vzal?', 'teenage boy, loud and delighted'), T(1, 'neutral', 'Šel jsem k babičce na oběd.', 'casual, slightly embarrassed'), T(0, 'amused', 'Ty ještě chodíš k babičce?', 'teasing, mock disbelief'), T(1, 'amused', 'Dělá řízky, tak drž hubu.', 'laughing, mock-defensive')]),
  C('conv_street_cigaro_pauza', 'mf', 'pauza na cigáro', [T(0, 'neutral', 'Deset minut a jdem zpátky, jo?', 'workmate, quick, lighting a cigarette'), T(1, 'amused', 'Deset minut od kdy? Od teď?', 'playful, negotiating'), T(0, 'amused', 'Od chvíle, co si zapálím.', 'grinning, sly')]),
  C('conv_street_pocasi_predpoved', 'aa', 'počasí a předpověď', [T(0, 'tired', 'Zase to začíná mrholit.', 'flat, looking up at the sky'), T(1, 'annoyed', 'Ráno přitom hlásili jasno.', 'irritated, sarcastic edge'), T(0, 'amused', 'Hlásili. To hlásí každý ráno.', 'dry, world-weary chuckle')]),
  C('conv_street_koleno_bolest', 'ff', 'bolavé koleno', [T(0, 'friendly', 'Jak vám slouží to koleno?', 'warm, concerned neighbor'), T(1, 'amused', 'Déšť poznám dřív než rádio.', 'wry old-lady humor, patient'), T(0, 'amused', 'Tak to bysme vás měli dát do televize.', 'teasing, gentle laugh')]),
  C('conv_street_dynamo_zapas', 'mm', 'hokej Dynamo Pardubice', [T(0, 'annoyed', 'Viděls včera tu třetí třetinu?', 'fan, exasperated, hands up'), T(1, 'annoyed', 'Viděl. A radši jsem vypnul.', 'disgusted, short'), T(0, 'angry', 'Za ty prachy by mohli aspoň bruslit.', 'raised voice, bitter, street-corner rant')]),
  C('conv_street_klepy_rozchod', 'ff', 'klepy o sousedech', [T(0, 'neutral', 'Prej se od ní odstěhoval.', 'low voice, gossipy, conspiratorial'), T(1, 'amused', 'No konečně. To trvalo tři roky.', 'delighted, catty'), T(0, 'scared', 'Ale já ti nic neřekla, jasný?', 'suddenly nervous, hushed, glancing around')]),
  C('conv_street_mama_dite', 'fa', 'máma a dítě', [T(0, 'annoyed', 'Nešahej na to, je to špinavý.', 'tired mother, sharp but not shouting'), T(1, 'friendly', 'Ale ono to bliká.', 'small child, curious, whiny'), T(0, 'tired', 'Bliká, protože je to rozbitý.', 'flat, exhausted, end of patience')]),
  C('conv_street_delnici_termin', 'mm', 'práce na stavbě', [T(0, 'tired', 'Do dvou to nestihnem, ani náhodou.', 'construction worker, heavy, resigned'), T(1, 'neutral', 'Tak to nestihnem. Já z toho neumřu.', 'deadpan, completely unbothered')]),
  C('conv_street_par_z_hospody', 'fm', 'pár po oslavě', [T(0, 'angry', 'Ty jsi říkal jenom jedno pivo.', 'woman, sharp, fed up, walking fast'), T(1, 'drunk', 'A taky bylo. Akorát pětkrát.', 'slurred, pleased with himself, giggling'), T(0, 'annoyed', 'Zítra vstáváš v šest, ty génie.', 'cutting sarcasm, not looking at him')]),
  C('conv_street_duchodci_lavicka', 'mm', 'důchodci na lavičce', [T(0, 'neutral', 'Tenhle strom tu za nás nebyl.', 'old man, slow, pointing'), T(1, 'sad', 'Za nás tu nebylo skoro nic.', 'quiet, nostalgic, thin voice'), T(0, 'sad', 'A stejně to bylo hezčí.', 'soft, wistful, almost to himself')]),
  C('conv_street_sefka_telefon', 'ff', 'nová šéfová', [T(0, 'shocked', 'Ona ti píše i v neděli?', 'disbelieving, eyebrows up'), T(1, 'tired', 'V neděli, v noci, o Vánocích.', 'drained, listing it mechanically'), T(0, 'friendly', 'Tak si ten telefon vypni, prosím tě.', 'warm advice, exasperated affection')]),
  C('conv_street_kde_ses_tu_vzal', 'mf', 'kde ses tu vzal', [T(0, 'shocked', 'Ježišmarjá, ty jsi tady?', 'loud surprise on the street, stopping mid-step'), T(1, 'amused', 'Já tu bydlím. Deset let.', 'dry, entertained, arms crossed'), T(0, 'amused', 'A já tudy chodím každý den.', 'laughing at himself, shaking head')]),

  // ---- komentář k tomu, co se právě stalo ----
  C('conv_event_bouracka_krizovatka', 'mm', 'bouračka na křižovatce', [T(0, 'shocked', 'Ty vole, viděls to?', 'loud gasp, disbelief, blurted out'), T(1, 'shocked', 'Napálil do něj naplno.', 'stunned, flat, staring ahead'), T(0, 'angry', 'A ještě couval, debile jeden.', 'angry shout toward the driver'), T(1, 'scared', 'Někdo by měl volat sanitku.', 'nervous, quick, uncertain')]),
  C('conv_event_vrtulnik_nad_nemocnici', 'ff', 'vrtulník nad nemocnicí', [T(0, 'neutral', 'Slyšíš ten vrtulník?', 'looking up, mildly curious'), T(1, 'sad', 'To bude zase někdo na obchvatu.', 'resigned, quiet, knowing'), T(0, 'scared', 'Ježišmarjá, snad ne.', 'hushed, worried')]),
  C('conv_event_policajti_beh', 'mf', 'policie u nádraží', [T(0, 'shocked', 'Tři policajti běželi k nádraží.', 'excited, fast, out of breath'), T(1, 'amused', 'Zase chytaj toho s kolem.', 'dry, amused, unimpressed'), T(0, 'amused', 'Ten jim uteče i dnes.', 'laughing a little, certain')]),
  C('conv_event_divnej_typek', 'ff', 'divný chodec kolem', [T(0, 'annoyed', 'Koukni na toho týpka.', 'low voice, nudging a friend'), T(1, 'scared', 'Chodí tady furt dokola.', 'uneasy whisper, glancing sideways'), T(0, 'scared', 'Nedívej se na něj a jdem.', 'tense, hurried whisper')]),
  C('conv_event_zacpa_most', 'mm', 'zácpa na mostě', [T(0, 'annoyed', 'Stojíme tady čtvrt hodiny.', 'irritated sigh, tired of waiting'), T(1, 'tired', 'Přes most se dneska nedostaneš.', 'flat, defeated, matter of fact'), T(0, 'annoyed', 'Já říkal, ať jdeme pěšky.', 'grumbling, told you so')]),
  C('conv_event_ridic_versus_chodec', 'mm', 'hádka řidiče a chodce', [T(0, 'angry', 'Kam lezeš, máš červenou!', 'shouted out of a car window, furious'), T(1, 'angry', 'A ty seš slepej, nebo co?', 'shouted back from the crossing, hot'), T(0, 'angry', 'Ještě mi tady nadávej, blbe.', 'escalating, sharp, spitting words'), T(1, 'annoyed', 'Jeď, ať tě nemusím vidět.', 'dismissive, walking away, done')]),
  C('conv_event_motorka_v_noci', 'mf', 'řvoucí motorka v noci', [T(0, 'annoyed', 'Ta motorka mi vzala uši.', 'wincing, hands near ears, irritated'), T(1, 'tired', 'Jezdí tu takhle každou noc.', 'exhausted, resigned'), T(0, 'amused', 'Někdo mu vypustí gumy, uvidíš.', 'half joking, dark little laugh')]),
  C('conv_event_cyklista_na_chodniku', 'ff', 'cyklista na chodníku', [T(0, 'angry', 'Ten cyklista mě málem porazil!', 'outraged, still shaken, loud'), T(1, 'annoyed', 'Po chodníku, jako by nic.', 'disapproving, clipped'), T(0, 'angry', 'A ještě zvonil, ať mu uhnu.', 'incredulous anger, rising pitch')]),
  C('conv_event_kolecka_na_namesti', 'mm', 'blázen v autě', [T(0, 'shocked', 'Ten tam dělal kolečka na náměstí.', 'wide eyed, fast, still processing'), T(1, 'amused', 'Myslel jsem, že to napálí do kašny.', 'laughing in disbelief'), T(0, 'neutral', 'Policajti tu byli za minutu.', 'reporting it plainly, still buzzing')]),
  C('conv_event_sireny_v_noci', 'aa', 'sirény a hasiči', [T(0, 'drunk', 'Co to sakra houká?', 'slurred, swaying, too loud'), T(1, 'drunk', 'Hasiči, vole. Někde hoří.', 'drunk, overly confident explanation'), T(0, 'drunk', 'Tak to se jdeme kouknout.', 'cheerful drunk enthusiasm, staggering off')]),
];

// ---- derived indexes, built once at import ------------------------------
// Category → lines. chatter.js asks for a pool many times a minute and must
// not filter a 240-entry array to do it; this is the whole reason the module
// has any code in it at all.
export const BY_CAT = new Map(CATS.map((c) => [c, []]));
for (const l of LINES) BY_CAT.get(l.cat)?.push(l);

// id → line, for the tests and for anything that wants to look one up.
export const BY_ID = new Map(LINES.map((l) => [l.id, l]));

/**
 * Which cast members can voice this line — i.e. exactly which mp3s exist for
 * it. The generator walks this and the game indexes into it, so a mismatch
 * here is a 404 rather than a wrong voice; keeping both on one function is the
 * point. `g` of 'a' means the whole cast, otherwise the matching half.
 */
export function castFor(g) {
  return g === 'a' ? CAST : CAST.filter((c) => c.g === g);
}

/** The audio id for one line in one cast voice — `assets/voices/<this>.mp3`. */
export function clipId(lineId, castKey) { return lineId + '__' + castKey; }

/**
 * Every clip the generator must produce, as { file, text, tts, castKey }.
 * Shared by scripts/gen-voices.mjs and by the test that guards against a line
 * whose text drifted away from the mp3 that was rendered from it.
 */
export function allClips() {
  const out = [];
  for (const l of LINES) {
    for (const c of castFor(l.g)) {
      out.push({ file: clipId(l.id, c.key), castKey: c.key, text: l.text, tts: l.tts });
    }
  }
  for (const cv of CONVS) {
    cv.turns.forEach((t, i) => {
      for (const c of castFor(cv.g[t.s] ?? 'a')) {
        out.push({ file: clipId(cv.id + '_' + i, c.key), castKey: c.key, text: t.text, tts: t.tts });
      }
    });
  }
  return out;
}
