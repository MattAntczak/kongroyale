# efectivo ARENA

Bitwa na kartony w magazynie: **pracownicy magazynu kontra technicy efectivo**. Gra działa w przeglądarce (three.js),
a pokoje online obsługuje mały serwer Node.js z WebSocketami. Tryb z botami działa w całości w przeglądarce.

- **Dwie drużyny, do 20 na 20:**
  - Pracownicy magazynu (pomarańczowe kamizelki) bronią punktów A i B.
  - Technicy efectivo (niebieskie kamizelki) przyjeżdżają od ramp i atakują.
- **Rundy jak w CS, z serwerem i tagami zamiast bomby:**
  - Technik przytrzymuje E przy punkcie A albo B przez 4 sekundy: podłącza serwer albo montuje tagi zegarkowe.
  - Potem trwa 40 sekund uruchamiania. Pracownicy muszą w tym czasie przytrzymać E przy tym punkcie przez 7 sekund,
    żeby wszystko odłączyć. Puszczenie E zaczyna od nowa.
  - Rundę wygrywa też drużyna, która wyeliminuje całą drugą. Gdy minie czas rundy bez podłączenia, wygrywają pracownicy.
  - W trakcie rundy nikt nie wraca do gry. Wyeliminowany gracz ogląda kolegów z drużyny.
  - Mecz trwa do 4 wygranych rund, a po trzeciej rundzie drużyny zamieniają się rolami.
- **Dwie misje:**
  - *Serwer lokalny:* każdy technik może podłączyć jeden z dwóch serwerów.
  - *Tagi zegarkowe:* skrzynkę z tagami niesie jeden technik i widać go stale na mapie Live. Po jego eliminacji
    skrzynka leży na podłodze, aż podniesie ją inny technik.
- **Odprawa zamiast ekranu ładowania:** przed meczem przewija się historia misji i zadanie twojej drużyny.
- **Lobby ze slotami:** widać obie drużyny, wybierasz stronę i liczbę botów w każdej. Online mecz ustawia i zaczyna
  gospodarz, czyli pierwsza osoba w hali.
- **Dwie mapy do wyboru w lobby:**
  - *Zajezdnia* (184 × 120 m): zamknięte pomieszczenia połączone bramami, w stylu map z CS. Przez halę centralną
    biegnie tor z wagonem i suwnica. Punkt A to przeładunek ciężki z dużą skrzynią i antresolą na dwojgu schodów,
    punkt B to chłodnia z osobnymi komorami. Kontenery, pakownia, warsztat i biura pozwalają obejść halę centralną.
    Technicy startują w lewym dolnym rogu, pracownicy w prawym dolnym, między nimi są doki z ciężarówką. Runda trwa
    2,5 minuty.
  - *Hala magazynowa* (540 × 290 m, ok. 156 000 m²) w trzech konfiguracjach losowanych przy każdym meczu: klasyczna,
    z regałami buforowymi na środku i lustrzana, po około 300 regałów. Runda trwa 5 minut.
- **Boty:** technicy idą jedną z trzech tras do punktu wylosowanego na rundę, pracownicy trzymają punkty A i B.
- **Regały snajperskie (hala magazynowa):** kilka regałów w każdej konfiguracji jest niższych, ma żółtą drabinę i pomost na górze. Na
  pomoście nie ma osłony, skok z góry zabiera zdrowie, a trafiony bot namierza strzelca nawet z daleka.
- **Lunety pod prawym przyciskiem myszy:** Kartonomiot ma celownik 2×, Dalekomiot lunetę 4× i daleki zasięg.
- **Sklep jak w CS:** wyrzutnie nie leżą na podłodze. Każdy zaczyna z darmowym Paczkownikiem i 800 zł. Sklep (klawisz
  B, kupujesz klawiszami 1–4) działa w czasie odliczania i przez pierwsze 15 sekund rundy: Kartonomiot 1800 zł,
  Paletówka 1200 zł, Dalekomiot 3500 zł, granat 300 zł. Wygrana runda daje 3000 zł, przegrana 1700 zł, eliminacja
  300 zł, podłączenie albo odłączenie punktu 300 zł. Kto przeżył rundę, zachowuje wyrzutnie; kto odpadł, wraca do
  Paczkownika. Po zamianie ról wszyscy zaczynają od 800 zł.
- **Pięć slotów:** Kartonomiot (serie), Paczkownik (strzela etykietami z kodem kreskowym), Paletówka (garść paczek),
  Dalekomiot (jedna ciężka paczka, luneta) i kartonowy granat (rzucany łukiem, razi rywali w promieniu 8 m). Kartony naprawdę lecą, a zamiast
  wystrzału słychać piknięcie skanera kodów.
- **Wózki widłowe dla dwóch osób (10 na hali, 2 w Zajezdni):** pierwszy gracz, który naciśnie E, prowadzi. Drugi wskakuje na tylny
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
- czy na każdej mapie (Zajezdnia i trzy konfiguracje hali) spawny, znajdźki i obiekty misji są osiągalne,
- czy całe mecze samych botów kończą się wynikiem do 4 rund i nie ma ognia w swoich,
- zasady lobby (tylko gospodarz ustawia i zaczyna, najwyżej 20 osób w drużynie),
- wózek widłowy, wejście na pomost, podłączanie i odłączanie serwera oraz granat.

`npm run check:online` przechodzi lobby, odprawę i jazdę wózkiem we dwóch na prawdziwym serwerze.
`npx tsx smoke.ts --balance` rozgrywa więcej meczów botów i pokazuje, kto wygrywa rundy.

## Sterowanie

| Klawisz | Akcja |
|---|---|
| W A S D | Ruch, a w wózku gaz, wsteczny i skręt. W przy żółtej drabinie wchodzi na regał |
| Mysz, LPM | Celowanie i rzut kartonem |
| PPM | Celownik: Kartonomiot 2×, Dalekomiot luneta 4× |
| Shift, Spacja | Sprint, skok na niskie palety |
| R | Przeładowanie |
| 1 2 3 4 5 | Kartonomiot, Paczkownik, Paletówka, Dalekomiot, kartonowy granat |
| E | Wózek widłowy: wsiądź, wskocz na podest, wysiądź. Przy punkcie A lub B przytrzymaj: podłączanie albo odłączanie |
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
