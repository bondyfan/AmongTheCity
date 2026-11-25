// ==========================================================================
// Crime law: who has to see it, who can ring it in, and what it costs
//
// Frank, 25 Nov 2026: "když já ukradnu auto někomu, tak vyhodím ho z toho auta,
// tak on potom začne volat policii. Já jsem mu ukradnul auto a i tak budu mít
// jako 2 hvězdičky. Tak já se potom musím skrýt, ale já pokud ho vyhodím a
// zabiju toho člověka a nikdo tam nebude, že jo, samozřejmě policie, tak je to
// v pořádku. Jo, ale zase, když já zaútočím na nějakého člověka a blízkosti 50
// metrů policie, tak zase mám jako hvězdičku. Prostě, aby to fungovalo jako v
// GTAčku."
//
// Every crime the player commits comes here first (main.js: the fists, the
// car hitting somebody, the driver pulled out of his car, a parked car taken,
// a policeman run down), and this file decides whether it becomes stars at all,
// and when. Three ways it can go, as in GTA:
//
//   now    the police saw it: a patrol car, a pursuit unit or an officer on
//          foot within POLICE_R (50 m). Charged on the spot. Crimes against the
//          police themselves always count: they are the witness.
//   call   no police, but somebody who can phone: the victim (a driver you
//          threw out of his car, a man you knocked down), or a bystander within
//          CALLER_R (a pedestrian, a driver in another car). The call goes
//          through CALL_T seconds later (get up, find the phone, dial) and
//          then it is charged. If by then every caller is dead, nobody rang.
//   none   nobody saw it. Nothing.
//
// The table (RULES) says, per crime, whether the police must see it or a call
// will do, and whether the victim himself rings. The prices are js/wanted.js's
// CRIMES rows; this file only decides IF and WHEN, wanted.js how much.
//
// A punch is police only (Frank: "v blízkosti 50 metrů policie"): a scuffle
// nobody in uniform saw is nobody's business. Hitting somebody who is fighting
// you back (the fight session marks him p.brawl) is self-defence and free.
//
// Local state, like the wanted level it feeds: what the player did on this
// screen. It reads the shared world (where people and patrols are) and writes
// only this player's own stars, so co-op has nothing to agree about. The world
// is reached only through the callbacks the constructor is given, so this
// file loads under node --test with nothing else on disk.
// ==========================================================================

export const POLICE_R = 50;    // m: police nearer than this saw it (Frank's 50 m)
export const CALLER_R = 40;    // m: a bystander this close saw it and can phone
export const CALL_T = 9;       // s from the crime to the call going through

// police: the police seeing it charges it; call: a bystander may ring it in;
// victim: the victim rings it in himself; always: it is a crime against the
// police, they are the witness by definition
export const RULES = Object.freeze({
  rvacka:    Object.freeze({ police: true, call: false, victim: false }),   // a punch: police only
  srazeni:   Object.freeze({ police: true, call: true, victim: true }),     // knocked down by your car
  zabiti:    Object.freeze({ police: true, call: true, victim: false }),    // a killing (he cannot ring)
  prepadeni: Object.freeze({ police: true, call: true, victim: true }),     // a driver thrown out of his car
  kradez:    Object.freeze({ police: true, call: false, victim: false }),   // a parked car taken
  naraz:              Object.freeze({ always: true }),                      // ramming a patrol car
  napadeni_policisty: Object.freeze({ always: true }),                      // hitting a policeman
  zabiti_policisty:   Object.freeze({ always: true }),                      // killing one
});
const DEFAULT_RULE = RULES.rvacka;

/**
 * Pure: how a crime of this rule goes, given whether the police saw it and
 * how many people could phone. 'now' | 'call' | 'none'.
 */
export function verdict(rule, policeSaw, callers) {
  const r = rule ?? DEFAULT_RULE;
  if (r.always) return 'now';
  if (r.police && policeSaw) return 'now';
  if ((r.call || r.victim) && callers > 0) return 'call';
  return 'none';
}

const SAY_CALL = Object.freeze({
  prepadeni: 'Řidič volá policii',
  srazeni: 'Sražený volá policii',
});

export class CrimeLaw {
  /**
   * wanted     js/wanted.js's namespace (add)
   * policeAt   (x, z, r) -> true when police are within r
   * witnesses  (x, z, r, victim) -> people who saw it and could phone, the
   *            victim excluded (peds, drivers); [] when nobody
   * alive      (who) -> can this one still phone
   * toast      (text, opts), optional
   * vitals     js/vitals.js's namespace (onDown, down), optional: dying hangs
   *            up every call, as being wasted does in GTA. Without it a call
   *            queued just before the death went through after the hospital
   *            had already settled the stars, and the player woke up wanted
   *            for something the death had paid for.
   */
  constructor({ wanted = null, policeAt = null, witnesses = null, alive = null, toast = null, vitals = null } = {}) {
    this.wanted = wanted;
    this.policeAt = policeAt ?? (() => false);
    this.witnesses = witnesses ?? (() => []);
    this.alive = alive ?? ((w) => !!w && !w.dead);
    this.toast = toast;
    this.vitals = vitals;
    this.calls = [];          // { kind, due, callers }
    this._t = 0;
    vitals?.onDown?.(() => this.clear());
  }

  /**
   * The player did `kind` at (x, z). victim: the person it was done to, if
   * any (who may ring it in, and who is never his own witness). Returns how
   * it went: 'now', 'call', 'none' or 'free' (self-defence).
   */
  report(kind, x, z, victim = null) {
    // the dead commit no crimes: the car you died in rolling on into somebody
    // is not a call that should wait for you at the hospital
    if (this.vitals?.down?.()) return 'none';
    const rule = RULES[kind] ?? DEFAULT_RULE;
    if (kind === 'rvacka' && victim?.brawl) return 'free';
    const saw = !rule.always && rule.police ? !!this.policeAt(x, z, POLICE_R) : false;
    let callers = null;
    if (!rule.always && !saw && (rule.call || rule.victim)) {
      callers = [];
      if (rule.victim && victim && this.alive(victim)) callers.push(victim);
      if (rule.call) {
        const ws = this.witnesses(x, z, CALLER_R, victim) ?? [];
        for (const w of ws) if (w && w !== victim && this.alive(w)) callers.push(w);
      }
    }
    const v = verdict(rule, saw, callers ? callers.length : 0);
    if (v === 'now') this.wanted?.add(kind);
    else if (v === 'call') {
      this.calls.push({ kind, due: this._t + CALL_T, callers });
      const say = SAY_CALL[kind] && callers[0] === victim ? SAY_CALL[kind] : 'Svědek volá policii';
      this.toast?.(say, { icon: '📞', kind: 'warn', ms: 3000 });
    }
    return v;
  }

  /** One step: calls that are due go through, unless every caller is dead. */
  update(dt) {
    this._t += dt > 0 ? dt : 0;
    for (let i = this.calls.length - 1; i >= 0; i--) {
      const c = this.calls[i];
      if (this._t < c.due) continue;
      this.calls.splice(i, 1);
      let anyone = false;
      for (const w of c.callers) if (this.alive(w)) { anyone = true; break; }
      if (anyone) this.wanted?.add(c.kind);
    }
  }

  /** A new game, an arrest or a death (through vitals.onDown, see the
   *  constructor): nobody is on the phone any more. */
  clear() { this.calls.length = 0; }

  /** Seconds until the next call goes through, Infinity when none is pending. */
  nextCall() {
    let m = Infinity;
    for (const c of this.calls) if (c.due - this._t < m) m = c.due - this._t;
    return m;
  }
}
