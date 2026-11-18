import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5180 },
  // The bundle goes to dist/bundle/, NOT dist/assets/ — public/assets/sounds
  // is copied to dist/assets/ verbatim and the two must not share a folder.
  build: { assetsDir: 'bundle' },
  // The mesh and far-city workers are module workers (`new Worker(url, { type:
  // 'module' })`) and their graph now splits (a module they share is also
  // loaded lazily), which the default classic "iife" worker bundle cannot do:
  // the production build stopped with "IIFE output formats are not supported
  // for code-splitting builds". Emit them as ES modules, as they are loaded.
  worker: { format: 'es' },
  // bare "three" resolves to the vendored module (same trick as AmongTheWoods) —
  // the importmap in index.html covers the no-bundler case, this covers vite
  resolve: {
    alias: {
      three: resolve(__dirname, 'libs/three.module.js'),
    },
  },
});
