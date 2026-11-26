# efectivo ARENA

Bitwa na kartony w magazynie: **pracownicy magazynu kontra technicy efectivo**. Gra działa w przeglądarce (three.js),
a pokoje online obsługuje mały serwer Node.js z WebSocketami. Tryb z botami działa w całości w przeglądarce.

- **Dwie drużyny, do 20 na 20:**
  - Pracownicy magazynu (pomarańczowe kamizelki) bronią hali.
  - Technicy efectivo (niebieskie kamizelki) przyjeżdżają od ramp i wykonują misję.
- **Dwie misje:**
  - *Serwer lokalny:* pracownicy odłączyli serwer. Technicy muszą dojść do szafy i przytrzymać E przez 12 sekund.
    Pracownicy wygrywają, gdy minie 7 minut.
  - *Tagi zegarkowe:* technicy noszą skrzynki z tagami z dostawy przy rampie do stacji ładowania. Potrzeba pięciu
    dostaw. Kto niesie tagi, jest stale widoczny na mapie Live. Upuszczoną skrzynkę pracownicy mogą przejąć.
- **Odprawa zamiast ekranu ładowania:** przed każdą zmianą przewija się historia misji i zadanie twojej drużyny.
- **Lobby ze slotami:** widać obie drużyny, wybierasz stronę i liczbę botów w każdej. Online zmianę ustawia i zaczyna
  gospodarz, czyli pierwsza osoba w hali.
- **Hala 240 × 130 m (31 200 m²) w trzech konfiguracjach,** losowanych przy każdej zmianie: klasyczna, z regałami
  buforowymi na środku i lustrzana. Ścianki działowe dzielą środek hali na trzy trasy podejścia.
- **Regały snajperskie:** kilka regałów w każdej konfiguracji jest niższych, ma żółtą drabinę i pomost na górze. Na
  pomoście nie ma osłony, skok z góry zabiera zdrowie, a trafiony bot namierza strzelca nawet z daleka.
- **Cztery sloty:** Kartonomiot (serie), Paczkownik (pojedyncze paczki), Paletówka (garść paczek, do znalezienia na
  hali) i kartonowy granat (rzucany łukiem, razi rywali w promieniu 6,5 m). Kartony naprawdę lecą, a zamiast
  wystrzału słychać piknięcie skanera kodów.
- **Powroty falami:** wyeliminowani gracze wracają razem, pracownicy co 14 s, technicy co 9 s.
- **Wózki widłowe dla dwóch osób (6 na hali):** pierwszy gracz, który naciśnie E, prowadzi. Drugi wskakuje na tylny
  podest i rzuca. Karoseria osłania nogi, a rzucający stoi odsłonięty.
- **Mapa Live:** pokazuje twoją drużynę, wózki i cel misji, a rywali tylko wtedy, gdy rzucają.
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
- czy w każdej z trzech konfiguracji spawny, znajdźki i obiekty misji są osiągalne,
- czy zmiany samych botów w obu misjach kończą się wynikiem i nie ma ognia w swoich,
- zasady lobby (tylko gospodarz ustawia i zaczyna, najwyżej 20 osób w drużynie),
- wózek widłowy, wejście na pomost, podłączanie serwera i granat.

`npm run check:online` przechodzi lobby, odprawę i jazdę wózkiem we dwóch na prawdziwym serwerze.
`npx tsx smoke.ts --balance` rozgrywa więcej zmian botów i pokazuje, kto wygrywa.

## Sterowanie

| Klawisz | Akcja |
|---|---|
| W A S D | Ruch, a w wózku gaz, wsteczny i skręt. W przy żółtej drabinie wchodzi na regał |
| Mysz, LPM | Celowanie i rzut kartonem |
| Shift, Spacja | Sprint, skok na niskie palety |
| R | Przeładowanie |
| 1 2 3 4 | Kartonomiot, Paczkownik, Paletówka, kartonowy granat |
| E | Wózek widłowy: wsiądź, wskocz na podest, wysiądź. Przy serwerze przytrzymaj: podłączanie |
| Tab | Tablica wyników |
| T | Czat |
| Esc | Pauza: czułość, głośność, pole widzenia |

## Kod

| Pliki | Co tam jest |
|---|---|
| `shared/` | Mapa, fizyka, wyrzutnie, wózki, nawigacja i boty, host meczu (`sim.ts`), wspólne dla przeglądarki i serwera |
| `client/` | Render three.js, postacie, latające kartony, dźwięki (syntezowane), HUD, lobby i odprawa (`story.ts`) |
| `server.ts` | Pokoje WebSocket, 60 ticków/s, snapshoty 20/s |
| `smoke.ts` | Test bez grafiki |

Wszystkie tekstury, modele i dźwięki powstają w kodzie, więc gra nie pobiera żadnych plików graficznych ani dźwiękowych.
