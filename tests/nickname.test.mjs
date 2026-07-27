// ---- the nickname gate: "no name, no server" has to actually hold ----
// menu.js promises the player that a nickname is required for the server and
// that other people will read it. Three modules enforce that promise with the
// SAME filter written out three times — menu.sanitizeName on the way in,
// netcity.sanitizeName on every packet out and in, nametags.clean before it
// reaches a canvas — under a comment that says "keep this byte-identical" and
// nothing that makes it so. Two rounds of review have now found real holes in
// that filter (U+3164, then U+034F / U+17B5 / U+FE0F / the U+E00xx tag block),
// and a hole in ONE of the three copies is worse than a hole in all three:
// sender and receiver would disagree about what the name is.
//
// So this test reads the three implementations out of the SOURCE FILES rather
// than importing them — netcity.js and nametags.js both import 'three', which
// is an importmap entry in index.html and not a node package — and checks two
// things: that the three are still character-for-character the same function,
// and that a large corpus of blank/spoofing nameplates is refused by each.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = (f) => readFileSync(new URL('../js/' + f, import.meta.url), 'utf8');

function grab(file, fnName) {
  const s = src(file);
  const strip = s.match(/const STRIP = (\/\[[\s\S]*?\]\/gu);/);
  const ink = s.match(/const INK = (\/\[[\s\S]*?\]\/u);/);
  const body = s.match(new RegExp('(?:export )?function ' + fnName + '\\(s\\) \\{([\\s\\S]*?)\\n\\}'));
  assert.ok(strip, `${file}: no STRIP regex`);
  assert.ok(ink, `${file}: no INK regex`);
  assert.ok(body, `${file}: no ${fnName}() body`);
  // eslint-disable-next-line no-new-func
  const fn = new Function('STRIP', 'INK', `return function (s) {${body[1]}}`)(
    eval(strip[1]), eval(ink[1]));
  return { file, strip: strip[1], ink: ink[1], body: body[1], fn };
}

const IMPLS = [
  grab('menu.js', 'sanitizeName'),
  grab('netcity.js', 'sanitizeName'),
  grab('nametags.js', 'clean'),
];

const u = (...cp) => cp.map((c) => String.fromCodePoint(c)).join('');

// Every one of these renders as nothing, or renders as something other than
// itself. None may ever come back as a truthy name.
const BLANK = {
  'empty string': '',
  'spaces only': '   ',
  'tab + newline': u(9, 10),
  'zero width space U+200B': u(0x200b),
  'zero width space x3': u(0x200b).repeat(3),
  'zero width non-joiner U+200C': u(0x200c),
  'zero width joiner alone U+200D': u(0x200d),
  'zero width joiner x4': u(0x200d).repeat(4),
  'word joiner U+2060': u(0x2060),
  'unassigned invisible U+2065': u(0x2065),
  'hangul filler U+3164': u(0x3164),
  'hangul filler x5': u(0x3164).repeat(5),
  'choseong filler U+115F': u(0x115f),
  'jungseong filler U+1160': u(0x1160),
  'halfwidth filler U+FFA0': u(0xffa0),
  'blank braille U+2800': u(0x2800),
  'mongolian vowel sep U+180E': u(0x180e),
  'byte order mark U+FEFF': u(0xfeff),
  'soft hyphen U+00AD': u(0xad),
  'left-to-right mark U+200E': u(0x200e),
  'right-to-left mark U+200F': u(0x200f),
  'right-to-left override U+202E': u(0x202e),
  'arabic letter mark U+061C': u(0x61c),
  'first strong isolate U+2068': u(0x2068),
  'no-break space U+00A0': u(0xa0),
  'NUL': u(0),
  'DEL': u(0x7f),
  'C1 NEL U+0085': u(0x85),
  'line separator U+2028': u(0x2028),
  'paragraph separator U+2029': u(0x2029),
  'thin space U+2009': u(0x2009),
  'ideographic space U+3000': u(0x3000),
  'figure space U+2007': u(0x2007),
  'combining grapheme joiner U+034F': u(0x34f),
  'combining grapheme joiner x5': u(0x34f).repeat(5),
  'khmer inherent AQ U+17B4': u(0x17b4),
  'khmer inherent AA U+17B5': u(0x17b5),
  'variation selector-16 U+FE0F': u(0xfe0f),
  'variation selector-1 U+FE00': u(0xfe00),
  'variation selector-15 x8': u(0xfe0e).repeat(8),
  'tag space U+E0020': u(0xe0020),
  'tag latin a U+E0061': u(0xe0061),
  'tag word': u(0xe0066, 0xe0072, 0xe0061),
  'musical format U+1D173': u(0x1d173),
  'object replacement U+FFFC': u(0xfffc),
  'interlinear annotation U+FFF9': u(0xfff9),
  'combining grave alone U+0300': u(0x300),
  'combining acute x6': u(0x301).repeat(6),
  'lone high surrogate': '\uD834',
  'lone low surrogate': '\uDD73',
  'private use U+E000': u(0xe000),
  'markup breakers only': '<>&"\'`',
  'mixed invisibles': u(0x200b, 0xfe0f, 0x34f, 0x3164, 0xe0020, 0x2800),
  'space + joiner + selector': u(32, 0x200d, 0xfe0f, 32),
};

// …and these are real names that must survive intact.
const KEEP = [
  ['Franta', 'Franta'],
  ['  Franta  ', 'Franta'],
  ['a<b>c', 'abc'],
  ['ab' + u(0x202e) + 'cd', 'abcd'],
  ['Ja' + u(0x200b) + 'ra', 'Jara'],
  ['Petr' + u(0x3164) + 'Novak', 'PetrNovak'],
  ['Frank' + u(0xe0061), 'Frank'],            // no smuggled tag payload
  ['01234567890123456789', '01234567890123'], // the 14-char cap
  ['Žofie', 'Žofie'],
  ['Z' + u(0x30c) + 'ofie', 'Z' + u(0x30c) + 'ofie'],   // decomposed caron
  ['Řehoř Čtvrt', 'Řehoř Čtvrt'],
  ['大和', '大和'],
  ['Хтось', 'Хтось'],
];

test('all three nickname filters are the same function', () => {
  const [a, ...rest] = IMPLS;
  for (const b of rest) {
    assert.strictEqual(b.strip, a.strip, `STRIP differs: ${a.file} vs ${b.file}`);
    assert.strictEqual(b.ink, a.ink, `INK differs: ${a.file} vs ${b.file}`);
    assert.strictEqual(b.body, a.body, `body differs: ${a.file} vs ${b.file}`);
  }
});

test('a blank nameplate can never reach the server or a sprite', () => {
  for (const impl of IMPLS) {
    for (const [label, value] of Object.entries(BLANK)) {
      assert.strictEqual(impl.fn(value), '',
        `${impl.file} let ${label} through as ${JSON.stringify(impl.fn(value))}`);
    }
  }
});

test('real nicknames survive the filter unchanged', () => {
  for (const impl of IMPLS) {
    for (const [input, want] of KEEP) {
      assert.strictEqual(impl.fn(input), want,
        `${impl.file}: ${JSON.stringify(input)} → ${JSON.stringify(impl.fn(input))}`);
    }
  }
});

test('emoji stay one glyph and keep their colour', () => {
  const family = u(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  const thumb = u(0x1f44d, 0xfe0f);
  for (const impl of IMPLS) {
    assert.strictEqual(impl.fn(family), family, `${impl.file} broke the family emoji`);
    assert.strictEqual(impl.fn(thumb), thumb, `${impl.file} stripped the presentation selector`);
  }
});

test('the menu gates the server button on a surviving name', () => {
  const s = src('menu.js');
  // the click handler must run requireName() before pick('server'), and
  // requireName() must be the sanitizer — not a raw truthiness test on .value
  assert.match(s, /multi\.addEventListener\('click',[^\n]*requireName\(\)[^\n]*pick\('server'\)/,
    'the multiplayer button no longer refuses without a name');
  assert.match(s, /const requireName = \(\) => \{\s*\n\s*if \(sanitizeName\(nameIn\.value\)\) return true;/,
    'requireName() no longer runs the name through sanitizeName');
  // single player is deliberately ungated — assert that too, so a future
  // change that gates it is a deliberate one
  assert.match(s, /single\.addEventListener\('click', \(\) => pick\('single'\)\)/,
    'single player should not require a nickname');
});
