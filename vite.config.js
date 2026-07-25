import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5180 },
  // bare "three" resolves to the vendored module (same trick as AmongTheWoods) —
  // the importmap in index.html covers the no-bundler case, this covers vite
  resolve: {
    alias: {
      three: resolve(__dirname, 'libs/three.module.js'),
    },
  },
});
