# efectivo ARENA

Strzelanka FPS w magazynie efectivo, zbudowana na stosie Kong Royale (three.js + Node/WebSocket), jako osobne wejście —
gra KONG zostaje nietknięta.

- Hala 80 × 50 m: regały wysokiego składowania, strefy Kompletacja / Surowiec / Pakowanie / Strefa niebezpieczna / Wysyłka,
  wózki widłowe, palety, kotwice UWB.
- Pracownicy w kaskach i kamizelkach, karabin / pistolet / strzelba, apteczki, amunicja, efectivo GEO (radar na 10 s).
- Mapa efectivo Live w rogu: widzisz siebie, a rywali tylko wtedy, gdy strzelają.
- Deathmatch do 25 eliminacji albo 6 minut, boty na trzech poziomach, pokoje online do 8 osób.

## Uruchomienie

```sh
npm ci
npm run efectivo          # klient na http://localhost:5320/ (tryb z botami działa bez serwera)
npm run efectivo:server   # serwer pokoi online na porcie 3030
```

Produkcja: `npm run efectivo:build`, potem `npm run efectivo:start` (serwer + klient na jednym porcie, `EF_PORT`).
Znajomi wchodzą do tej samej hali przez link `?hala=KOD`.

Testy: `npm run efectivo:typecheck` i `npm run efectivo:smoke` (mapa, ścieżki botów, 3-minutowy mecz botów).

| Pliki | Co tam jest |
|---|---|
| `shared/` | Mapa, fizyka, bronie, nawigacja i AI botów, host meczu (`sim.ts`) — wspólne dla przeglądarki i serwera |
| `client/` | Render three.js, postacie, efekty, dźwięki (syntezowane), HUD w stylu efectivo |
| `server.ts` | Pokoje WebSocket, 60 ticków/s, snapshoty 20/s |
