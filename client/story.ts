// The briefing shown while a shift loads: each mission opens with its story, scrolling up the screen like the
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
      "Pod rampę podjeżdża zespół techniczny. Ma jedno zadanie: przejść przez całą halę, dotrzeć do szafy serwera i podłączyć go z powrotem. Pracownicy ustawili już palety w poprzek alejek i czekają z kartonami w rękach…",
    ],
    task: [
      "Bronisz serwera. Nie dopuść techników do szafy, dopóki nie skończy się czas zmiany.",
      "Dojdź do szafy serwera i przytrzymaj E, żeby go podłączyć. Kabel trzeba utrzymać 12 sekund.",
    ],
  },
  tags: {
    episode: "Zmiana II",
    title: "DOSTAWA TAGÓW",
    text: [
      "Kierownik zamówił więcej tagów zegarkowych. To małe lokalizatory UWB noszone na nadgarstku: wystarczy założyć jeden, a hala od razu wie, gdzie jesteś.",
      "Pracownicy dowiedzieli się o dostawie z samego rana. Nikt nie zamierza zakładać kolejnego zegarka, który wszystko o nim wie.",
      "Technicy efectivo wyładowali skrzynki przy rampie. Muszą je donieść do stacji ładowania w głębi hali. Każda skrzynka nadaje sygnał, więc każdy, kto ją niesie, świeci na mapie Live jak latarnia…",
    ],
    task: [
      "Nie pozwól donieść tagów do stacji ładowania. Upuszczoną skrzynkę możesz przejąć, wystarczy na nią wejść.",
      "Weź skrzynkę z dostawy przy rampie i zanieś ją do dowolnej stacji ładowania. Potrzeba pięciu dostaw.",
    ],
  },
};
