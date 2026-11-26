// The briefing shown while a match loads: each mission opens with its story, scrolling up the screen like the
// opening of an old space film, and a line that tells each team what to do.

import type { Mission } from "../shared/proto";

export interface Story {
  episode: string;
  title: string;
  /** The paragraphs of the crawl. */
  text: string[];
  /** What each team has to do: [workers, technicians]. */
  task: [string, string];
}

export const STORIES: Record<Mission, Story> = {
  server: {
    episode: "Zmiana I",
    title: "ODŁĄCZONY SERWER",
    text: [
      "W magazynie zapanował niepokój. Odkąd na hali działa efectivo, każdy ruch zostawia ślad, a mapa Live widzi wszystko. Pracownicy uznali, że tego już za wiele.",
      "W nocy ktoś wyciągnął kabel z serwera lokalnego. Tagi zamilkły, mapa zgasła, a w centrali efectivo zapaliła się czerwona lampka.",
      "Pod rampę podjeżdża zespół techniczny. Ma jedno zadanie: przejść przez całą halę, dotrzeć do jednej z dwóch szaf i podłączyć serwer z powrotem. Pracownicy ustawili już palety w poprzek alejek i czekają z kartonami w rękach…",
    ],
    task: [
      "Nie dopuść techników do serwerów A i B. Jeśli któryś podłączą, masz 40 sekund, żeby go odłączyć: przytrzymaj E przy szafie.",
      "Podłącz serwer A albo B: przytrzymaj E przy szafie. Potem broń go przez 40 sekund, aż się uruchomi.",
    ],
  },
  tags: {
    episode: "Zmiana II",
    title: "DOSTAWA TAGÓW",
    text: [
      "Kierownik zamówił więcej tagów zegarkowych. To małe lokalizatory UWB noszone na nadgarstku: wystarczy założyć jeden, a hala od razu wie, gdzie jesteś.",
      "Pracownicy dowiedzieli się o dostawie z samego rana. Nikt nie zamierza zakładać kolejnego zegarka, który wszystko o nim wie.",
      "Technicy efectivo wyładowali skrzynki przy rampie. Jedną z nich trzeba donieść do stacji ładowania w głębi hali i zamontować. Skrzynka nadaje sygnał, więc ten, kto ją niesie, świeci na mapie Live jak latarnia…",
    ],
    task: [
      "Nie pozwól zamontować tagów na stacji A ani B. Jeśli się uda, masz 40 sekund, żeby je zdjąć: przytrzymaj E przy stacji.",
      "Jeden z was niesie skrzynkę tagów. Zamontujcie ją na stacji A albo B (przytrzymaj E) i brońcie przez 40 sekund.",
    ],
  },
};
