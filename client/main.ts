// efectivo ARENA entry: the title page with the lobby (both teams and their slots, bots per team, the mission), and
// starting / leaving a Game. A game with bots is a room of our own inside the page; an online room is the same lobby
// fed by the server, where the first person in runs it.

import { Game } from "./game";
import { LocalLink, WsLink, type Link } from "./net";
import { initAudio } from "./audio";
import { MAX_TEAM } from "../shared/sim";
import { findPath } from "../shared/nav";
import type { Config, HostMsg } from "../shared/proto";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type Snap = Extract<HostMsg, { t: "snap" }>;

let mode: "bots" | "online" = "bots";
let link: Link | null = null;
let myId = 0;
let room = "";
let game: Game | null = null;
let lobby: Snap | null = null;
/** What we want the shift to be; sent to the host whenever we are it. */
let want: Config = { bots: [5, 5], mission: "random", map: "depot", difficulty: "normal" };

const store = {
  get(k: string) { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const myName = () => $<HTMLInputElement>("nick").value.trim() || "Magazynier";
const isHost = () => !!lobby && lobby.host === myId;

// ------------------------------------------------------------------ the link and its messages

function open(next: Link) {
  link?.close();
  link = next; myId = 0; lobby = null;
  next.onMessage = onMessage;
  next.onClose = (reason) => { if (link !== next) return; closeGame(); $("status").textContent = reason; if (mode === "online") { link = null; lobby = null; renderLobby(); } };
  renderLobby();
}

function openLocal() { open(new LocalLink(myName(), 1)); }

function onMessage(m: HostMsg) {
  if (m.t === "welcome") { myId = m.id; room = m.room; return; }
  if (m.t === "error") { $("status").textContent = m.text; return; }
  if (m.t === "snap") {
    if (m.phase === "lobby") {
      if (game) closeGame();
      const first = !lobby;
      lobby = m;
      if (first && isHost()) link!.send({ t: "config", config: want });
      renderLobby();
      return;
    }
    if (!game && link) startGame(m);
  }
  game?.handle(m);
  if (m.t === "ev" && m.evs.some((e) => e.k === "lobby")) closeGame();
}

function startGame(first: Snap) {
  $("title").hidden = true;
  game = new Game(link!, myId, room, first, (msg) => {
    // left through the pause menu: the room is gone with it
    game = null; link = null; lobby = null;
    $("title").hidden = false;
    $("status").textContent = msg ?? "";
    if (mode === "bots") openLocal(); else renderLobby();
  });
}

function closeGame() {
  if (!game) return;
  game.dispose();
  game = null;
  $("title").hidden = false;
}

// ------------------------------------------------------------------ the lobby

function renderLobby() {
  const on = !!lobby;
  $("lobby").hidden = !on;
  if (!lobby) return;
  const host = isHost();
  const cfg = host ? want : lobby.config;
  for (const t of [0, 1]) {
    const people = lobby.players.filter((p) => !p.bot && p.tm === t);
    const bots = Math.min(cfg.bots[t], MAX_TEAM - people.length);
    const rows = people.map((p) => `<div class="slot ${p.id === myId ? "me" : ""}"><span>${esc(p.n)}</span>${p.id === myId ? '<i class="badge badge-blue">Ty</i>' : ""}${p.id === lobby!.host ? '<i class="badge badge-gray">gospodarz</i>' : ""}</div>`);
    for (let i = 0; i < bots; i++) rows.push(`<div class="slot bot"><span>Bot ${i + 1}</span><i class="badge badge-gray">BOT</i></div>`);
    $("slots" + t).innerHTML = rows.join("") + `<div class="slot-count">${people.length + bots} / ${MAX_TEAM} miejsc</div>`;
    $("bots" + t).textContent = String(cfg.bots[t]);
    const mine = lobby.players.find((p) => p.id === myId)?.tm === t;
    const join = document.querySelector<HTMLButtonElement>(`button[data-join="${t}"]`)!;
    join.disabled = mine; join.textContent = mine ? "Jesteś w tej drużynie" : t === 0 ? "Dołącz do pracowników" : "Dołącz do techników";
    document.querySelector<HTMLElement>(`.team-card[data-team="${t}"]`)!.classList.toggle("mine", mine);
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("#missionRow button")) { b.setAttribute("aria-pressed", String(b.dataset.mission === cfg.mission)); b.disabled = !host; }
  for (const b of document.querySelectorAll<HTMLButtonElement>("#mapRow button")) { b.setAttribute("aria-pressed", String(b.dataset.map === cfg.map)); b.disabled = !host; }
  for (const b of document.querySelectorAll<HTMLButtonElement>("#diffRow button")) { b.setAttribute("aria-pressed", String(b.dataset.diff === cfg.difficulty)); b.disabled = !host; }
  for (const b of document.querySelectorAll<HTMLButtonElement>(".stepper button")) b.disabled = !host;
  $<HTMLButtonElement>("play").disabled = !host;
  const hostName = lobby.players.find((p) => p.id === lobby!.host)?.n ?? "";
  $("hostHint").textContent = host ? (mode === "online" ? `Hala ${room}: znajomi wchodzą przez ten sam kod` : "") : `Zmianę zaczyna gospodarz: ${hostName}`;
}

function setConfig(change: (c: Config) => void) {
  if (!isHost() || !link) return;
  change(want);
  link.send({ t: "config", config: want });
  renderLobby();
}

document.addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  const join = el.closest<HTMLButtonElement>("button[data-join]");
  if (join && link) { link.send({ t: "team", team: Number(join.dataset.join) }); return; }
  const step = el.closest<HTMLButtonElement>(".stepper button");
  if (step) {
    const t = Number(step.parentElement!.dataset.bots), d = Number(step.dataset.d);
    setConfig((c) => { c.bots[t] = Math.max(0, Math.min(MAX_TEAM, c.bots[t] + d)); });
    return;
  }
  const mission = el.closest<HTMLButtonElement>("#missionRow button");
  if (mission) { setConfig((c) => { c.mission = mission.dataset.mission as Config["mission"]; }); return; }
  const map = el.closest<HTMLButtonElement>("#mapRow button");
  if (map) { setConfig((c) => { c.map = map.dataset.map as Config["map"]; }); return; }
  const diff = el.closest<HTMLButtonElement>("#diffRow button");
  if (diff) { setConfig((c) => { c.difficulty = diff.dataset.diff as Config["difficulty"]; }); return; }
  const m = el.closest<HTMLButtonElement>("#modeRow button");
  if (m) {
    mode = m.dataset.mode as typeof mode;
    for (const c of document.querySelectorAll<HTMLButtonElement>("#modeRow button")) c.setAttribute("aria-pressed", String(c === m));
    $("roomRow").hidden = mode !== "online";
    $("status").textContent = "";
    if (mode === "bots") openLocal(); else { link?.close(); link = null; lobby = null; renderLobby(); }
  }
});

$("connect").addEventListener("click", () => {
  const code = ($<HTMLInputElement>("room").value.trim().toUpperCase() || "HALA").replace(/[^A-Z0-9]/g, "").slice(0, 8) || "HALA";
  store.set("efectivo.room", code);
  store.set("efectivo.nick", myName());
  history.replaceState(null, "", `?hala=${code}`);
  $("status").textContent = "";
  open(new WsLink(myName(), code, -1));
});

$("play").addEventListener("click", () => {
  if (!link || !isHost()) return;
  initAudio();
  store.set("efectivo.nick", myName());
  link.send({ t: "config", config: want });
  link.send({ t: "start" });
  // this click also counts as the gesture for pointer lock
  void $<HTMLCanvasElement>("view").requestPointerLock()?.catch?.(() => {});
});

// a new name means a new seat in our own room
$("nick").addEventListener("change", () => { store.set("efectivo.nick", myName()); if (mode === "bots" && !game) openLocal(); });

// ------------------------------------------------------------------ start-up

$<HTMLInputElement>("nick").value = store.get("efectivo.nick");
const invited = new URLSearchParams(location.search).get("hala");
$<HTMLInputElement>("room").value = invited ?? store.get("efectivo.room");
if (invited) {
  mode = "online";
  for (const c of document.querySelectorAll<HTMLButtonElement>("#modeRow button")) c.setAttribute("aria-pressed", String(c.dataset.mode === "online"));
  $("roomRow").hidden = false;
  renderLobby();
} else openLocal();

// is the online server up?
fetch("/efectivo/health").then((r) => r.ok ? r.json() : Promise.reject()).then((h: { rooms: number; players: number }) => {
  $("srvPill").innerHTML = `<span class="dot"></span> Serwer online · ${h.players} graczy`;
}).catch(() => { $("srvPill").innerHTML = `<span class="dot"></span> Gra z botami`; });

// a handle for scripted checks (tools drive the game through it)
(window as unknown as { __ef: unknown }).__ef = { get game() { return game; }, get link() { return link; }, findPath };
