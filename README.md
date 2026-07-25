# Among The City — Pardubice

GTA-lite ve three.js. Věrná replika Pardubic postavená z OpenStreetMap dat
(RÚIAN půdorysy všech budov včetně podlažnosti, skutečná uliční síť). Hráč
se probouzí na přednádraží hlavního nádraží, chodí po skutečných ulicích,
nastupuje do aut (E) a jezdí městem, kde proudí AI doprava po skutečných
silnicích s pravostranným provozem.

## Spuštění
```
npm install
npm run dev        # http://localhost:5180
```

## Data pipeline
```
npm run fetch-city    # jen centrum Pardubic → public/data/pardubice.json (v repu, fallback)
node scripts/fetch-region.mjs   # CELÝ region PCE+HK+Chrudim (~30×38 km, ~1 h, resumable)
node scripts/build-region.mjs   # → public/data/tiles/* + manifest.json (gitignored, ~60 MB)
npm test              # sanity testy dat + souvislost silniční sítě
```
Hra načte region-manifest, když existuje; jinak spadne zpět na samotné
Pardubice. Ortofoto se streamuje za běhu přímo z ČÚZK WMS (2048 px/480 m).

## Data a licence
Mapová data © přispěvatelé OpenStreetMap (ODbL). Letecký podklad: Ortofoto ČR
© ČÚZK (open data CC BY 4.0) — dlaždice v public/data/ortho stažené přes WMS.

## Architektura
Viz ARCHITECTURE.md — moduly: geo (index), city (streaming+kolize), meshes
(extruze budov, silnice, koleje, stromy), vehicles (arkádová fyzika),
traffic (graf silnic + AI), player/citizen, sky (slunce/západ z Among The
Woods), minimap. Souřadnice: metry, origin = uzel stanice Pardubice hl.n.

## Roadmap
- celá ČR: dlaždicované stahování po obcích, LOD, sdílený formát
- chodci, zvuky, kolize aut mezi sebou, semafory, noční světla
