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
- **Trzy mapy do wyboru w lobby:**
  - *Zajezdnia* (184 × 120 m): zamknięte pomieszczenia połączone bramami, w stylu map z CS. Przez halę centralną
    biegnie tor z wagonem i suwnica. Punkt A to przeładunek ciężki z dużą skrzynią i antresolą na dwojgu schodów,
    punkt B to chłodnia z osobnymi komorami. Kontenery, pakownia, warsztat i biura pozwalają obejść halę centralną.
    Technicy startują w lewym dolnym rogu, pracownicy w prawym dolnym, między nimi są doki z ciężarówką. Runda trwa
    2,5 minuty.
  - *Sortownia* (116 × 80 m): zwarte centrum sortowania paczek z trzema drogami. Punkt A to rampa z dokiem 1,2 m,
    zaparkowanym busem i klatkami na paczki, punkt B to zsypy z rynnami spadającymi do koryt. Pośrodku jest sorter z
    taśmami i podestem ze sterownią. Do A prowadzi długa aleja przez plac, do B ciasne przejście przez workownię i rynny,
    a łączniki ze środka pozwalają szybko przejść na punkt. Technicy startują na południu, pracownicy na północy między
    punktami. Runda trwa niecałe 2 minuty.
  - *Hala magazynowa* (540 × 290 m, ok. 156 000 m²) w trzech konfiguracjach losowanych przy każdym meczu: klasyczna,
    z regałami buforowymi na środku i lustrzana, po około 300 regałów. Runda trwa 5 minut.
- **Boty:** technicy idą jedną z trzech tras do punktu wylosowanego na rundę, a czasem jeden skrada się na drugi punkt.
  Pracownicy dzielą się po równo między A i B, stoją w miejscu i pilnują wejść. Gdy ktoś zobaczy techników przy
  jednym punkcie, reszta przechodzi tam z drugiego (zostaje jeden obrońca). Boty słyszą kroki biegnących do ok. 20 m.
- **Regały snajperskie (hala magazynowa):** kilka regałów w każdej konfiguracji jest niższych, ma żółtą drabinę i pomost na górze. Na
  pomoście nie ma osłony, skok z góry zabiera zdrowie, a trafiony bot namierza strzelca nawet z daleka.
- **Ruch i celowanie jak w CS:** ruch z tarciem i przyspieszeniem jak w grach na silniku Quake/Half-Life: puszczenie
  klawiszy wyhamowuje w ok. 0,4 s, a przeciwny klawisz zatrzymuje w ok. 0,13 s (kontra). Prędkość zależy od wyrzutni w ręku
  (Paczkownik i granat 4,8 m/s, Kartonomiot i Paletówka 88 %, Dalekomiot 84 %, w lunecie 60 %). Shift to cichy chód,
  Ctrl lub C kucanie. Skoki spowalniają po lądowaniu, więc skakanie nie jest szybsze od biegu. Pierwszy rzut po krótkiej
  przerwie leci prawie dokładnie w celownik, seria się rozrzuca, a bieg i skok psują celność. Kartonomiot ma stały
  odrzut (najpierw w górę, potem w lewo i w prawo), który da się wyuczyć i ściągać myszą. Celownik rozszerza się razem z
  rozrzutem. Kroki biegnących słychać do ok. 25 m. Kierunek każdego rzutu ustala gospodarz meczu, więc klient nie
  oszuka rozrzutu ani odrzutu.
- **Lunety pod prawym przyciskiem myszy:** Kartonomiot ma celownik 2×, Dalekomiot lunetę 4× i daleki zasięg.
- **Sklep jak w CS:** wyrzutnie nie leżą na podłodze. Każdy zaczyna z darmowym Paczkownikiem i 800 zł. Sklep (klawisz
  B, kupujesz klawiszami 1–4) działa w czasie odliczania i przez pierwsze 15 sekund rundy: Kartonomiot 1800 zł,
  Paletówka 1200 zł, Dalekomiot 3500 zł, granat 300 zł. Wygrana runda daje 3000 zł, przegrana 1700 zł, eliminacja
  300 zł, podłączenie albo odłączenie punktu 300 zł. Kto przeżył rundę, zachowuje wyrzutnie; kto odpadł, wraca do
  Paczkownika. Po zamianie ról wszyscy zaczynają od 800 zł.
- **Pięć slotów:** Kartonomiot (serie), Paczkownik (strzela etykietami z kodem kreskowym), Paletówka (garść paczek),
  Dalekomiot (jedna ciężka paczka, luneta) i kartonowy granat (rzucany łukiem, razi rywali w promieniu 8 m). Kartony naprawdę lecą, a zamiast
  wystrzału słychać piknięcie skanera kodów.
- **Wózki widłowe dla dwóch osób (10 na hali, po 2 w Zajezdni i Sortowni):** pierwszy gracz, który naciśnie E, prowadzi. Drugi wskakuje na tylny
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
- czy na każdej mapie (Zajezdnia, Sortownia i trzy konfiguracje hali) spawny, znajdźki i obiekty misji są osiągalne,
- czy całe mecze samych botów kończą się wynikiem do 4 rund i nie ma ognia w swoich,
- zasady lobby (tylko gospodarz ustawia i zaczyna, najwyżej 20 osób w drużynie),
- wózek widłowy, wejście na pomost, podłączanie i odłączanie serwera oraz granat.
- ruch i celowanie: kontrę, cichy chód i kucanie, niższy cel u kucającego, brak wstawania pod niskim stropem, skok z
  kucnięciem na paletę 1,25 m, odrzucanie za szybkiego ruchu przez gospodarza i rozrzut serii w porównaniu z pierwszym
  rzutem.

`npm run check:online` przechodzi lobby, odprawę i jazdę wózkiem we dwóch na prawdziwym serwerze.
`npx tsx smoke.ts --balance` rozgrywa więcej meczów botów i pokazuje, kto wygrywa rundy.

## Sterowanie

| Klawisz | Akcja |
|---|---|
| W A S D | Ruch, a w wózku gaz, wsteczny i skręt. W przy żółtej drabinie wchodzi na regał |
| Mysz, LPM | Celowanie i rzut kartonem |
| PPM | Celownik: Kartonomiot 2×, Dalekomiot luneta 4× |
| Shift | Cichy chód: wolniej i bez odgłosu kroków |
| Ctrl albo C | Kucanie: niższa sylwetka, najcelniejszy rzut w miejscu. Pod niskim stropem nie da się wstać |
| Spacja | Skok. Na palety 1,25 m wskakujesz skokiem z kucnięciem (Spacja, a w locie Ctrl) |
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
