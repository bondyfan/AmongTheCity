import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5180 },
  // libs/three.module.js is loaded via the importmap in index.html — keep
  // vite from trying to prebundle a bare "three" specifier it can't resolve
  optimizeDeps: { exclude: ['three'] },
});
