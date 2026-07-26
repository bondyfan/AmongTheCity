import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5180 },
  // The bundle goes to dist/bundle/, NOT dist/assets/ — public/assets/sounds
  // is copied to dist/assets/ verbatim and the two must not share a folder.
  build: { assetsDir: 'bundle' },
  // bare "three" resolves to the vendored module (same trick as AmongTheWoods) —
  // the importmap in index.html covers the no-bundler case, this covers vite
  resolve: {
    alias: {
      three: resolve(__dirname, 'libs/three.module.js'),
    },
  },
});
