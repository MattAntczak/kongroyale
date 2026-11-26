// efectivo ARENA entry: the title page (mode, bots, room code), the live preview of the hall drawn like the efectivo
// Live dashboard, and starting / leaving a Game.

import { Game } from "./game";
import { LocalLink, WsLink } from "./net";
import { initAudio } from "./audio";
import { Sim } from "../shared/sim";
import { BOXES, HALL, ZONES } from "../shared/map";
import { VEST_COLORS } from "./human";
import type { Difficulty } from "../shared/proto";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let mode: "bots" | "online" = "bots";
let diff: Difficulty = "normal";
let count = 7;
let game: Game | null = null;

const store = {
  get(k: string) { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function chips(rowId: string, attr: string, pick: (v: string) => void) {
  const row = $(rowId);
  row.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(`button[data-${attr}]`);
    if (!b) return;
    for (const c of row.querySelectorAll<HTMLButtonElement>(`button[data-${attr}]`)) c.setAttribute("aria-pressed", String(c === b));
    pick(b.dataset[attr]!);
  });
}

function syncMode() {
  $("diffRow").hidden = mode !== "bots";
  $("countRow").hidden = mode !== "bots";
  $("roomRow").hidden = mode !== "online";
  $("play").textContent = mode === "bots" ? "Wejdź na halę" : "Dołącz do hali";
  $("status").textContent = "";
}

chips("modeRow", "mode", (v) => { mode = v as typeof mode; syncMode(); });
chips("diffRow", "diff", (v) => { diff = v as Difficulty; });
chips("countRow", "count", (v) => { count = Number(v); });
$<HTMLInputElement>("nick").value = store.get("efectivo.nick");
$<HTMLInputElement>("room").value = new URLSearchParams(location.search).get("hala") ?? store.get("efectivo.room");
if (new URLSearchParams(location.search).has("hala")) {
  mode = "online";
  for (const c of $("modeRow").querySelectorAll<HTMLButtonElement>("button")) c.setAttribute("aria-pressed", String(c.dataset.mode === "online"));
}
syncMode();
$("howBtn").addEventListener("click", () => $("how").scrollIntoView({ behavior: "smooth" }));

$("play").addEventListener("click", () => {
  initAudio();
  const name = $<HTMLInputElement>("nick").value.trim() || "Magazynier";
  store.set("efectivo.nick", name);
  let link;
  if (mode === "bots") link = new LocalLink(name, diff, count);
  else {
    const room = ($<HTMLInputElement>("room").value.trim().toUpperCase() || "HALA").replace(/[^A-Z0-9]/g, "").slice(0, 8) || "HALA";
    store.set("efectivo.room", room);
    history.replaceState(null, "", `?hala=${room}`);
    link = new WsLink(name, room);
  }
  stopPreview();
  $("title").hidden = true;
  game = new Game(link, (msg) => {
    game = null;
    $("title").hidden = false;
    $("status").textContent = msg ?? "";
    startPreview();
  });
  // the first click already counts as the gesture for pointer lock
  void $<HTMLCanvasElement>("view").requestPointerLock()?.catch?.(() => {});
});

// is the online server up?
fetch("/efectivo/health").then((r) => r.ok ? r.json() : Promise.reject()).then((h: { rooms: number; players: number }) => {
  $("srvPill").innerHTML = `<span class="dot"></span> SERWER ONLINE · ${h.players} GRACZY`;
}).catch(() => { $("srvPill").innerHTML = `<span class="dot"></span> TRENING Z BOTAMI`; });

// ------------------------------------------------------------------ title preview: a bot match on the Live map

let previewRaf = 0;
let previewSim: Sim | null = null;

function startPreview() {
  const canvas = $<HTMLCanvasElement>("preview");
  const dpr = Math.min(2, window.devicePixelRatio);
  const g = canvas.getContext("2d")!;
  previewSim = new Sim({ bots: true, difficulty: "normal", seed: 7, maxPlayers: 8 });
  const trails = new Map<number, [number, number][]>();
  let last = performance.now(), acc = 0;
  const loop = (t: number) => {
    previewRaf = requestAnimationFrame(loop);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    acc += Math.min(0.1, (t - last) / 1000); last = t;
    while (acc >= 1 / 30) { acc -= 1 / 30; previewSim!.step(1 / 30); previewSim!.drainEvents(); }
    const snap = previewSim!.snapshot(1);
    if (!snap || snap.t !== "snap") return;
    const W = canvas.width, H = canvas.height;
    const pad = 28 * dpr;
    const s = Math.min((W - pad * 2) / (HALL.x1 - HALL.x0), (H - pad * 2 - 30 * dpr) / (HALL.z1 - HALL.z0));
    const ox = (W - s * (HALL.x1 - HALL.x0)) / 2, oz = (H - s * (HALL.z1 - HALL.z0)) / 2 + 6 * dpr;
    const X = (x: number) => ox + (x - HALL.x0) * s, Z = (z: number) => oz + (z - HALL.z0) * s;
    g.fillStyle = "#1d1d1f"; g.fillRect(0, 0, W, H);
    g.fillStyle = "#000"; g.beginPath(); g.roundRect(X(HALL.x0), Z(HALL.z0), (HALL.x1 - HALL.x0) * s, (HALL.z1 - HALL.z0) * s, 10 * dpr); g.fill();
    for (const zn of ZONES) { g.fillStyle = zn.color + "1f"; g.fillRect(X(zn.x0), Z(zn.z0), (zn.x1 - zn.x0) * s, (zn.z1 - zn.z0) * s); }
    for (const b of BOXES) {
      if (b.kind === "wall") continue;
      g.fillStyle = b.kind === "rack" ? "rgba(245,245,247,0.2)" : "rgba(245,245,247,0.1)";
      g.fillRect(X(b.x0), Z(b.z0), (b.x1 - b.x0) * s, (b.z1 - b.z0) * s);
    }
    for (const p of snap.players) {
      let tr = trails.get(p.id);
      if (!tr) { tr = []; trails.set(p.id, tr); }
      if (!p.alive) { tr.length = 0; continue; }
      const lastPt = tr[tr.length - 1];
      if (!lastPt || Math.hypot(lastPt[0] - p.x, lastPt[1] - p.z) > 0.4) { tr.push([p.x, p.z]); if (tr.length > 40) tr.shift(); }
      const col = "#" + VEST_COLORS[p.c % VEST_COLORS.length].toString(16).padStart(6, "0");
      g.strokeStyle = col + "55"; g.lineWidth = 1.5 * dpr; g.beginPath();
      tr.forEach(([x, z], i) => i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))); g.stroke();
      if (p.fired < 0.3) { g.fillStyle = "rgba(71,79,255,0.25)"; g.beginPath(); g.arc(X(p.x), Z(p.z), 10 * dpr, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = col; g.beginPath(); g.arc(X(p.x), Z(p.z), 3.5 * dpr, 0, Math.PI * 2); g.fill();
    }
    $("previewCap").textContent = `${snap.players.filter((p) => p.alive).length} tagów UWB online`;
  };
  previewRaf = requestAnimationFrame(loop);
}

function stopPreview() { cancelAnimationFrame(previewRaf); previewSim = null; }

startPreview();
(window as unknown as { __ef: unknown }).__ef = { get game() { return game; } };
