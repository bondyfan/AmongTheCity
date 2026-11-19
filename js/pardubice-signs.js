// What is written round Pardubice hlavní nádraží. Since the rebuild the
// station is signed by TRACK alone, 1 to 11 across its five platforms
// (before, it was "platform / track"), and each platform is cut into sectors
// A to H from the east. These are the painters for js/stationkit.js plates.

const TRACKS = { 1: [1, 2, 3], 2: [4, 5], 3: [6, 7], 4: [8, 9], 5: [10, 11] };
export const tracksOf = (platform) => TRACKS[platform] ?? [];

// Sector at a place along the platforms (u, metres east of the western
// underpass): F, G, H to the west of it, E to A to the east.
export function sectorAt(u) {
  return u < 0 ? 'FGH'[Math.min(2, Math.floor(-u / 42))] : 'EDCBA'[Math.min(4, Math.floor(u / 45))];
}
// The sectors a flight of the underpass comes up into.
export function sectorsBy(f) {
  const east = f.b > f.a,
    western = Math.abs(f.a) < 10;
  if (f.to === 5) return east ? 'A–E' : 'F';
  if (western) return east ? 'C–E' : 'F–H';
  return east ? 'A–D' : 'E–H';
}

// An evening's departures: [time, train, destination, track].
const timetable = [
  ['20:34', 'R 881', 'Praha hl. n.', 4],
  ['20:36', 'Os 5024', 'Hradec Králové hl. n.', 1],
  ['20:41', 'Ex 143', 'Ostrava hl. n.', 7],
  ['20:44', 'Os 5361', 'Slatiňany', 10],
  ['20:48', 'R 986', 'Liberec', 2],
  ['20:52', 'rj 257', 'Graz Hbf', 8],
  ['20:55', 'Os 5008', 'Kolín', 5],
  ['21:02', 'R 867', 'Brno hl. n.', 6],
  ['21:05', 'Os 5367', 'Chrudim', 11],
  ['21:09', 'Ex 152', 'Praha hl. n.', 4],
  ['21:14', 'Os 5046', 'Jaroměř', 2],
  ['21:18', 'Sp 1988', 'Česká Třebová', 9],
  ['21:26', 'R 892', 'Praha hl. n.', 5],
  ['21:31', 'Os 5026', 'Hradec Králové hl. n.', 1],
  ['21:37', 'Ex 145', 'Žilina', 7],
  ['21:44', 'Os 5363', 'Havlíčkův Brod', 10],
  ['21:50', 'R 988', 'Liberec', 3],
  ['21:58', 'rj 259', 'Wien Hbf', 8],
  ['22:04', 'Os 5010', 'Kolín', 5],
  ['22:11', 'R 869', 'Brno hl. n.', 6],
  ['22:19', 'Os 5369', 'Chrudim', 11],
  ['22:27', 'Ex 154', 'Praha hl. n.', 4],
  ['22:36', 'Os 5048', 'Jaroměř', 2],
  ['22:48', 'Os 5012', 'Přelouč', 9],
];

// A blue departure board: a header and `rows` lines, either every train
// (tracks null, from `skip` on) or only those leaving from `tracks`.
export function departures(tracks, rows, skip = 0) {
  const list = (tracks ? timetable.filter((t) => tracks.includes(t[3])) : timetable.slice(skip)).slice(0, rows);
  return (ctx, w, h) => {
    const head = h / (rows + 1.3),
      row = (h - head * 1.3) / rows;
    ctx.fillStyle = '#1657c8';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#0d3f9c';
    ctx.fillRect(0, 0, w, head * 1.3);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = '700 ' + Math.round(head * 0.74) + 'px system-ui, sans-serif';
    ctx.fillText(tracks ? 'Kolej ' + tracks.join(' · ') : 'Odjezd / Departure', w * 0.03, head * 0.68, w * 0.7);
    ctx.textAlign = 'right';
    ctx.font = '600 ' + Math.round(head * 0.5) + 'px system-ui, sans-serif';
    ctx.fillText(tracks ? 'Odjezd / Departure' : 'Kolej', w * 0.97, head * 0.68, w * 0.4);
    list.forEach(([time, train, to, track], i) => {
      const y = head * 1.3 + (i + 0.5) * row;
      if (i % 2) {
        ctx.fillStyle = '#1b62d6';
        ctx.fillRect(0, y - row / 2, w, row);
      }
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.font = '700 ' + Math.round(row * 0.6) + 'px system-ui, sans-serif';
      ctx.fillText(time, w * 0.03, y, w * 0.14);
      ctx.font = '500 ' + Math.round(row * 0.5) + 'px system-ui, sans-serif';
      ctx.fillStyle = '#d5e4ff';
      ctx.fillText(train, w * 0.19, y, w * 0.19);
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 ' + Math.round(row * 0.6) + 'px system-ui, sans-serif';
      ctx.fillText(to, w * 0.4, y, w * 0.47);
      ctx.textAlign = 'right';
      ctx.fillText(String(track), w * 0.97, y, w * 0.08);
    });
  };
}

// The board on a platform post: the next train from this edge.
export function nextTrain(track) {
  const t = timetable.find((row) => row[3] === track) ?? timetable[0];
  return (ctx, w, h) => {
    ctx.fillStyle = '#20263a';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#3d57c9';
    ctx.fillRect(w * 0.02, h * 0.08, w * 0.96, h * 0.84);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 ' + Math.round(h * 0.34) + 'px system-ui, sans-serif';
    ctx.fillText(t[2].toUpperCase(), w / 2, h * 0.36, w * 0.9);
    ctx.font = '500 ' + Math.round(h * 0.22) + 'px system-ui, sans-serif';
    ctx.fillText(t[1] + '   odjezd ' + t[0] + '   kolej ' + track, w / 2, h * 0.72, w * 0.9);
  };
}

// A station clock's face, the hands at ten past ten.
export function clock(ctx, w, h) {
  const r = Math.min(w, h) / 2;
  ctx.fillStyle = '#20263a';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.fillStyle = '#f6f4ea';
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.94, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#16181c';
  ctx.lineCap = 'butt';
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6;
    ctx.lineWidth = r * (i % 3 ? 0.035 : 0.07);
    ctx.beginPath();
    ctx.moveTo(Math.sin(a) * r * 0.72, -Math.cos(a) * r * 0.72);
    ctx.lineTo(Math.sin(a) * r * 0.86, -Math.cos(a) * r * 0.86);
    ctx.stroke();
  }
  for (const [turn, long, wide] of [[10.17 / 12, 0.48, 0.09], [10 / 60, 0.74, 0.06]]) {
    const a = turn * Math.PI * 2;
    ctx.lineWidth = r * wide;
    ctx.beginPath();
    ctx.moveTo(-Math.sin(a) * r * 0.12, Math.cos(a) * r * 0.12);
    ctx.lineTo(Math.sin(a) * r * long, -Math.cos(a) * r * long);
    ctx.stroke();
  }
}
