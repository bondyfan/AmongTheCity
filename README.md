# Among The City — Pardubice

GTA-lite ve three.js. Věrná replika Pardubic postavená z OpenStreetMap dat
(RÚIAN půdorysy všech budov včetně podlažnosti, skutečná uliční síť). Hráč
se probouzí na přednádraží hlavního nádraží, chodí po skutečných ulicích,
nastupuje do aut (E) a jezdí městem, kde proudí AI doprava po skutečných
silnicích s pravostranným provozem.

Svět už ale nekončí za Pardubicemi: vede odsud přes Hradec Králové a celou
dálnici D11 i s vesnicemi kolem ní až do Prahy — 185 dlaždic, 110 km,
831 tisíc budov. Praha má vlastní výšky a střechy z pražského katastru
(IPR), takže Staré Město je Staré Město a ne pole bungalovů.

## Spuštění
```
npm install
npm run dev        # http://localhost:5180
```

## Data pipeline
```
npm run fetch-world   # CELÝ svět: Praha + dálnice D11 + Hradec + Pardubice
npm test              # sanity testy dat + souvislost silniční sítě
```
`fetch-world` je jeden příkaz a udělá všechno: stáhne čtyři krajské extrakty
z Geofabriku (~320 MB), rozřeže je na 185 dlaždic po 4,8 km, stáhne
podlažnosti Prahy z IPR a postaví `public/data/{tiles,manifest.json,
overview.json,places.json}` (~245 MB, v repu — Cloudflare je servíruje přímo).
Trvá to minuty, ne hodiny, a nezávisí na tom, jestli má Overpass dobrý den.
Jednotlivé kroky jdou spustit i zvlášť (`scripts/split-extracts.mjs`,
`fetch-ipr.mjs`, `build-region.mjs`, `fetch-places.mjs`); starší
`fetch-region.mjs` (Overpass, po dlaždicích) zůstává pro malé výřezy.

Hra načte region-manifest, když existuje; jinak spadne zpět na samotné
Pardubice. Ortofoto se streamuje za běhu přímo z ČÚZK WMS (2048 px/480 m).

## Data a licence
Mapová data © přispěvatelé OpenStreetMap (ODbL). Letecký podklad: Ortofoto ČR
© ČÚZK (open data CC BY 4.0) — streamováno za běhu přes WMS.
Počty podlaží a tvary střech v Praze: datový podklad © IPR Praha
(vrstva Podlažnosti, otevřená data CC BY) — 110 tisíc budov, které mají
skutečnou výšku a skutečnou střechu místo odhadu „dvě patra“.

## Architektura
Viz ARCHITECTURE.md — moduly: geo (index), city (streaming+kolize), meshes
(extruze budov, silnice, koleje, stromy), vehicles (arkádová fyzika),
traffic (graf silnic + AI), player/citizen, sky (slunce/západ z Among The
Woods), minimap. Souřadnice: metry, origin = uzel stanice Pardubice hl.n.

## Roadmap
- celá ČR: dlaždicované stahování po obcích, LOD, sdílený formát
- chodci, zvuky, kolize aut mezi sebou, semafory, noční světla
