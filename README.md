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

## Data pipeline (už spuštěná, výstup je v repu)
```
npm run fetch-city   # Overpass API → data/raw/*.json (~15 MB)
npm run build-city   # → public/data/pardubice.json (3.5 MB, lokální metry)
npm test             # sanity testy dat + souvislost silniční sítě
```

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
