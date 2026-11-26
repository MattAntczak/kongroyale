# efectivo ARENA

Drużynowa bitwa na kartony w magazynie efectivo: **Grupa A kontra Grupa B**. Gra działa w przeglądarce (three.js),
a pokoje online obsługuje mały serwer Node.js z WebSocketami. Tryb z botami działa w całości w przeglądarce.

- **Hala 240 × 130 m (31 200 m²) w normalnej skali:** 60 regałów wysokiego składowania, strefy Kompletacja,
  Surowiec, Pakowanie, Strefa niebezpieczna i Wysyłka, 9 ramp, kotwice UWB.
- **Regały snajperskie:** 8 z 60 regałów (po 4 na stronę każdej grupy) jest niższych, ma żółtą drabinę i pomost na
  górze. Na mapie Live są niebieskie. Na pomoście nie ma osłony, skok z góry zabiera zdrowie (drabiną schodzi się
  bezpiecznie), a trafiony bot namierza strzelca nawet z daleka. Na zwykłe regały wejść się nie da.
- **Grupy:** Grupa A (niebieskie kamizelki) startuje od zachodu, Grupa B (pomarańczowe) od rampy wysyłkowej. Grupy
  dopełniają się botami do pełnego składu (4 na 4, 6 na 6 albo 8 na 8). Nie ma ognia w swoich, a wygrywa grupa
  z 40 eliminacjami albo z lepszym wynikiem po 8 minutach.
- **Wyrzutnie kartonów:**
  - Kartonomiot strzela seriami.
  - Paczkownik rzuca pojedyncze paczki.
  - Paletówka rzuca garść małych paczek naraz.

  Każdy karton naprawdę leci i lekko opada. Zamiast wystrzału słychać piknięcie skanera kodów.
- **Wózki widłowe dla dwóch osób (6 na hali):** pierwszy gracz, który naciśnie E, prowadzi. Drugi wskakuje na tylny podest i rzuca
  kartonami. Karoseria osłania nogi, a rzucający stoi odsłonięty.
- **Mapa Live w rogu ekranu:** pokazuje całą twoją grupę i wózki, a rywali tylko wtedy, gdy rzucają. Znajdźka
  efectivo GEO pokazuje wszystkich przez 10 s.
- **Wygląd:** interfejs korzysta z design systemu aplikacji efectivo (`efectivo-admin-frontend`).

## Uruchomienie

Potrzebny jest Node.js 22.12 lub nowszy.

```sh
npm ci
npm run dev       # klient na http://localhost:5320/ (tryb z botami działa bez serwera)
npm run server    # serwer pokoi online na porcie 3030
```

Wersja produkcyjna: najpierw `npm run build`, potem `npm start`. To uruchamia serwer i klienta na jednym porcie
(ustawiasz go zmienną `EF_PORT`). Znajomi wchodzą do tej samej hali przez link z parametrem `?hala=KOD`.

Testy: `npm test` uruchamia typecheck oraz test bez grafiki. Ten test sprawdza:
- czy spawny i znajdźki są osiągalne,
- czy grupy są wyrównane i nie ma ognia w swoich,
- czy w 3-minutowym meczu botów padają eliminacje,
- czy działa wsiadanie, jazda, odrzucanie teleportu i wysiadanie z wózka,
- czy drabina wnosi gracza na pomost, bot zostaje na dole, a skok z pomostu zabiera zdrowie.

## Sterowanie

| Klawisz | Akcja |
|---|---|
| W A S D | Ruch, a w wózku gaz, wsteczny i skręt. W przy żółtej drabinie wchodzi na regał |
| Mysz, LPM | Celowanie i rzut kartonem |
| Shift, Spacja | Sprint, skok na niskie palety |
| R | Przeładowanie |
| 1 2 3 | Kartonomiot, Paczkownik, Paletówka |
| E | Wózek widłowy: wsiądź, wskocz na podest, wysiądź |
| Tab | Tablica wyników |
| T | Czat |
| Esc | Pauza: czułość, głośność, pole widzenia |

## Kod

| Pliki | Co tam jest |
|---|---|
| `shared/` | Mapa, fizyka, wyrzutnie, wózki, nawigacja i boty, host meczu (`sim.ts`), wspólne dla przeglądarki i serwera |
| `client/` | Render three.js, postacie, latające kartony, dźwięki (syntezowane), HUD i menu |
| `server.ts` | Pokoje WebSocket, 60 ticków/s, snapshoty 20/s |
| `smoke.ts` | Test bez grafiki |

Wszystkie tekstury, modele i dźwięki powstają w kodzie, więc gra nie pobiera żadnych plików graficznych ani dźwiękowych.
