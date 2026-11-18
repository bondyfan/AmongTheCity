// The receiving end of dev/audiorender.html?save=...: a page cannot write to
// disk, so it POSTs each rendered WAV here and this writes it into a folder.
//   node dev/audiorender-save.mjs <outDir> [port=5393]
// Listens on 127.0.0.1 only. Stop it with ctrl-C (or a GET /quit) when done.

import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const [outDir, port = '5393'] = process.argv.slice(2);
if (!outDir) { console.error('usage: node dev/audiorender-save.mjs <outDir> [port]'); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.method === 'GET' && req.url === '/quit') { res.end('bye'); server.close(); return; }
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  const name = basename(decodeURIComponent(req.url)).replace(/[^\w.-]/g, '_');
  if (!name.endsWith('.wav')) { res.writeHead(400).end(); return; }
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => {
    writeFileSync(join(outDir, name), Buffer.concat(parts));
    console.log('saved ' + name);
    res.end('ok');
  });
});
server.listen(Number(port), '127.0.0.1', () => console.log(`saving into ${outDir} on http://127.0.0.1:${port}`));
