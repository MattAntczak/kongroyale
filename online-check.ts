// Online check for efectivo ARENA against a server you run (`npm run server`): two clients join one room as
// workers, go through the lobby (only the host starts the shift), sit through the briefing, walk to a forklift, get on as driver and thrower, drive it, throw from the platform (the driver cannot), and get
// off. Run with `npm run check:online` (EF_PORT picks the port, default 3030).

import WebSocket from "ws";
import { findPath } from "./shared/nav";
const url = `ws://127.0.0.1:${process.env.EF_PORT || 3030}/efws`;
let bad = 0;
const ROOM = "WS" + Math.floor(Math.random() * 1e5);
const check = (ok: boolean, what: string) => { if (!ok) { console.log(`FAILED: ${what}`); bad++; } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Snap = any;
function client(name: string) {
  const ws = new WebSocket(url);
  const st: { id: number; snap: Snap | null; ws: WebSocket } = { id: 0, snap: null, ws };
  ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.t === "welcome") st.id = m.id; if (m.t === "snap") st.snap = m; });
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", name, room: ROOM, team: 0 })));
  return st;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const a = client("Ania"), b = client("Bartek");
await sleep(1500);
// the lobby: both are workers, Ania (first in) is the host; she sets a small shift up and starts it
check(a.snap.phase === "lobby" && a.snap.host === a.id, "the first player hosts the lobby");
b.ws.send(JSON.stringify({ t: "start" }));
await sleep(300);
check(a.snap.phase === "lobby", "a guest cannot start the shift");
a.ws.send(JSON.stringify({ t: "config", config: { bots: [0, 2], mission: "server", difficulty: "easy" } }));
a.ws.send(JSON.stringify({ t: "start" }));
await sleep(500);
console.log("phase", a.snap.phase, "layout", a.snap.layout, "mission", a.snap.mission, "players", a.snap.players.length);
check(a.snap.phase === "brief" && a.snap.players.length === 4, "the shift starts with the briefing and two bots");
while (a.snap.phase !== "play") await sleep(500); // the briefing, then the freeze before round 1
const { useLayout } = await import("./shared/map");
useLayout(a.snap.layout);
async function walkTo(c: ReturnType<typeof client>, tx: number, tz: number) {
  for (let tries = 0; tries < 5; tries++) {
    const me = c.snap.me; let x = me.x, z = me.z;
    for (const [px, pz] of findPath(x, z, tx, tz) ?? []) {
      while (Math.hypot(px - x, pz - z) > 0.05) {
        const d = Math.hypot(px - x, pz - z), s = Math.min(d, 0.25);
        x += (px - x) / d * s; z += (pz - z) / d * s;
        c.ws.send(JSON.stringify({ t: "state", x, y: 0, z, yaw: 0, pitch: 0, moving: true, spawn: c.snap.me.spawn }));
        await sleep(25);
      }
    }
    await sleep(200);
    if (Math.hypot(c.snap.me.x - tx, c.snap.me.z - tz) < 1) return true;
  }
  return false;
}
const v0 = a.snap.vehicles[0];
const wa = await walkTo(a, v0.x, v0.z + 1.8), wb = await walkTo(b, v0.x, v0.z + 1.8);
console.log("walked to the forklift:", wa, wb);
check(wa && wb, "both players reach the forklift");
a.ws.send(JSON.stringify({ t: "use" })); await sleep(150); b.ws.send(JSON.stringify({ t: "use" })); await sleep(300);
console.log("seats A", a.snap.me.veh, a.snap.me.seat, "B", b.snap.me.veh, b.snap.me.seat);
check(a.snap.me.veh === 0 && a.snap.me.seat === 0 && b.snap.me.veh === 0 && b.snap.me.seat === 1, "A drives, B throws");
// drive east 2 s
let { x, z, yaw } = a.snap.vehicles[0]; const rev = a.snap.me.vrev;
for (let i = 0; i < 60; i++) { x += 4 / 30; a.ws.send(JSON.stringify({ t: "drive", x, z, yaw, speed: 4, rev })); await sleep(33); }
await sleep(300);
const vb = b.snap.vehicles[0], meB = b.snap.players.find((p: any) => p.id === b.id);
console.log("forklift seen by B", vb.x.toFixed(1), "driver", vb.d === a.id, "thrower", vb.g === b.id, "B rides at", meB.x.toFixed(1), meB.y);
check(vb.x > v0.x + 1 && Math.hypot(meB.x - vb.x, meB.z - vb.z) < 1.6, "the forklift moved and carried the thrower");
// B throws a box from the platform
const shotsBefore = b.snap.me.mag.rifle;
b.ws.send(JSON.stringify({ t: "shoot", w: "rifle", yaw: 0, pitch: 0, dirs: [0, 0, -1], view: b.snap.time }));
a.ws.send(JSON.stringify({ t: "shoot", w: "rifle", yaw: 0, pitch: 0, dirs: [0, 0, -1], view: a.snap.time }));
await sleep(600);
console.log("thrower mag", shotsBefore, "->", b.snap.me.mag.rifle, "| driver mag", a.snap.me.mag.rifle, "(driver cannot throw)");
check(b.snap.me.mag.rifle === shotsBefore - 1 && a.snap.me.mag.rifle === 30, "only the thrower throws");
a.ws.send(JSON.stringify({ t: "use" })); b.ws.send(JSON.stringify({ t: "use" })); await sleep(300);
console.log("off", a.snap.me.veh, b.snap.me.veh);
check(a.snap.me.veh === -1 && b.snap.me.veh === -1, "both got off");
a.ws.close(); b.ws.close();
console.log(bad ? `${bad} check(s) failed` : "online forklift check passed");
process.exit(bad ? 1 : 0);
