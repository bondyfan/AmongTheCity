// ---- flight-schedule.js: the five minutes between the ticket and the doors ----
// Pure: real seconds in, a phase out. Frank, 25 Nov 2026: the flight leaves
// within five minutes of REAL time from buying the ticket ("do 5 minut jako
// reálného času, ne herního"), the aircraft is already waiting, and nobody
// stands an hour at a closed gate. A game hour is one real minute, so this
// cannot be the world clock: the schedule counts the frames' own seconds,
// which also stop while the game is paused.
//
//   0 s     ticket sold          check-in, then the security lane
//   20 s    boarding             gate open, the first announcement
//   210 s   last call            the second announcement
//   270 s   gate closing         the third
//   300 s   departure            a passenger past the gate is waited for (the
//                                crew will not leave someone on the apron);
//                                one who never reached it has missed it and
//                                is put on the next flight, free, whose
//                                boarding starts at once
// A passenger who sits down sooner does not wait for the clock: the doors
// close as soon as he is in 14A (js/flight.js).

export const SCHEDULE = { boarding: 20, lastCall: 210, closing: 270, departs: 300 };

/** A schedule that started at `now` (seconds). `quick`: boarding opens at once (the desks that are also the gate). */
export function newSchedule(now, quick = false) {
  return { t0: now - (quick ? SCHEDULE.boarding : 0) };
}

/** → { phase: 'checkin' | 'boarding' | 'lastCall' | 'closing' | 'due', left, open } */
export function scheduleAt(s, now) {
  const t = now - s.t0, S = SCHEDULE;
  const phase = t < S.boarding ? 'checkin' : t < S.lastCall ? 'boarding' : t < S.closing ? 'lastCall' : t < S.departs ? 'closing' : 'due';
  return { phase, left: Math.max(0, S.departs - t), open: t >= S.boarding, toBoarding: Math.max(0, S.boarding - t) };
}

/** "za 4 min", "za 40 s", "nyní": what the boards and the pass say. */
export function countdownText(left) {
  if (left <= 0.5) return 'nyní';
  if (left < 60) return 'za ' + Math.ceil(left / 10) * 10 + ' s';
  return 'za ' + Math.ceil(left / 60) + ' min';
}

/** The boards' status word for a schedule phase. */
export const STATUS = { checkin: 'Odbavení', boarding: 'Nástup', lastCall: 'Poslední výzva', closing: 'Gate se zavírá', due: 'Odlet' };
