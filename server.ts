// efectivo ARENA game server: rooms over WebSocket, each running one Sim at 60 ticks a second and sending snapshots at
// 20 a second. With EF_SERVE=1 it also serves the built client from dist on the same port.
//
//   npm run server            (port 3030, rooms filled with bots)
//   EF_PORT=8080 npm start    (also serves the built client from dist/)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { Sim, TEAM_FRAG_LIMIT, TICK_HZ } from "./shared/sim";
import type { ClientMsg, Difficulty, HostMsg } from "./shared/proto";

const PORT = Number(process.env.EF_PORT || 3030);
const SERVE = process.env.EF_SERVE === "1";
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
const MAX_ROOMS = 50;
const MAX_MSG_PER_S = 200;
const SNAP_EVERY = 3;

interface Client { ws: WebSocket; id: number; room: Room; msgs: number; window: number }
interface Room { code: string; sim: Sim; clients: Set<Client>; tick: number; acc: number; last: number; timer: NodeJS.Timeout }

const rooms = new Map<string, Room>();

function makeRoom(code: string, difficulty: Difficulty): Room {
  const room: Room = {
    code, sim: new Sim({ bots: true, difficulty, seed: Math.floor(Math.random() * 2 ** 31) }), clients: new Set(), tick: 0, acc: 0,
    last: performance.now(), timer: setInterval(() => runRoom(room), 4),
  };
  rooms.set(code, room);
  console.log(`[efectivo] room ${code} opened`);
  return room;
}

function closeRoom(room: Room) {
  clearInterval(room.timer);
  rooms.delete(room.code);
  console.log(`[efectivo] room ${room.code} closed`);
}

const send = (ws: WebSocket, m: HostMsg) => { if (ws.readyState === ws.OPEN && ws.bufferedAmount < 256 * 1024) ws.send(JSON.stringify(m)); };

function runRoom(room: Room) {
  const now = performance.now();
  room.acc += Math.min(250, now - room.last) / 1000;
  room.last = now;
  let steps = 0;
  while (room.acc >= 1 / TICK_HZ && steps++ < 6) {
    room.acc -= 1 / TICK_HZ;
    try { room.sim.step(1 / TICK_HZ); } catch (e) { console.error(`[efectivo] room ${room.code} step failed`, e); }
    room.tick++;
    const evs = room.sim.drainEvents();
    if (evs.length) { const msg = JSON.stringify({ t: "ev", evs } satisfies HostMsg); for (const c of room.clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(msg); }
    if (room.tick % SNAP_EVERY === 0) for (const c of room.clients) { const s = room.sim.snapshot(c.id); if (s) send(c.ws, s); }
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://x");
  if (url.pathname === "/efectivo/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ rooms: rooms.size, players: [...rooms.values()].reduce((n, r) => n + r.clients.size, 0) }));
    return;
  }
  if (!SERVE) { res.writeHead(404); res.end(); return; }
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST + path.sep) && file !== DIST) { res.writeHead(403); res.end(); return; }
  const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(DIST, "index.html");
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
  res.writeHead(200, { "content-type": types[path.extname(target)] || "application/octet-stream" });
  fs.createReadStream(target).pipe(res);
});

const wss = new WebSocketServer({ server, path: "/efws", maxPayload: 16 * 1024 });

wss.on("connection", (ws) => {
  let client: Client | null = null;
  ws.on("message", (data) => {
    let m: ClientMsg;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (!m || typeof m !== "object") return;
    if (!client) {
      if (m.t !== "join") return;
      const code = String(m.room || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "HALA";
      const diff: Difficulty = "normal";
      let room = rooms.get(code);
      if (!room) {
        if (rooms.size >= MAX_ROOMS) { send(ws, { t: "error", text: "Serwer jest pełny." }); ws.close(); return; }
        room = makeRoom(code, diff);
      }
      const id = room.sim.addHuman(String(m.name || ""), Number(m.team) === 0 || Number(m.team) === 1 ? Number(m.team) : -1);
      if (!id) { send(ws, { t: "error", text: "Pokój jest pełny." }); ws.close(); return; }
      client = { ws, id, room, msgs: 0, window: Date.now() };
      room.clients.add(client);
      send(ws, { t: "welcome", id, room: code, fragLimit: TEAM_FRAG_LIMIT });
      return;
    }
    const now = Date.now();
    if (now - client.window > 1000) { client.window = now; client.msgs = 0; }
    if (++client.msgs > MAX_MSG_PER_S) return;
    client.room.sim.receive(client.id, m);
  });
  ws.on("close", () => {
    if (!client) return;
    const room = client.room;
    room.clients.delete(client);
    room.sim.removePlayer(client.id);
    if (room.clients.size === 0) closeRoom(room);
  });
});

server.listen(PORT, () => console.log(`[efectivo] ARENA server on :${PORT}${SERVE ? " (serving dist)" : ""}`));
