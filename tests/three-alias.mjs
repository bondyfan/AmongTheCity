// A module-resolution hook that teaches node the same thing index.html's
// importmap teaches the browser: bare 'three' is the vendored copy in libs/.
// three.js is not an npm dependency of this project (no node_modules/three), so
// without this every module that draws anything is untestable headless — which
// is exactly why the destruction tests, whose subject is weapons.js and
// city.js, could not exist before. It is a plain resolver: nothing is stubbed,
// the real three.js runs, it simply never touches WebGL in these tests.
const THREE_URL = new URL('../libs/three.module.js', import.meta.url).href;

export function resolve(spec, ctx, next) {
  if (spec === 'three') return next(THREE_URL, ctx);
  return next(spec, ctx);
}
