// Headless check for efectivo ARENA: every spawn and pickup stands on free, reachable floor; the groups are balanced
// and honour a player's choice; a bot match produces kills and never friendly fire. Run with `npm run smoke`.

import { LADDERS, PERCH_H, PICKUPS, SPAWNS, VEHICLE_SPAWNS } from "./shared/map";
import { blocked, stepBody } from "./shared/physics";
import { findPath, freeAt } from "./shared/nav";
import { Sim, TICK_HZ } from "./shared/sim";

let bad = 0;
const pts: [string, number, number][] = [...SPAWNS.map(([x, z], i) => [`spawn ${i}`, x, z] as [string, number, number]), ...PICKUPS.map((p, i) => [`pickup ${i} ${p.kind}`, p.x, p.z] as [string, number, number])];
for (const [name, x, z] of pts) {
  if (blocked(x, 0.01, z)) { console.log(`BLOCKED ${name} (${x}, ${z})`); bad++; }
  else if (!freeAt(x, z)) console.log(`note: ${name} is in a no-nav cell (${x}, ${z})`);
  if (!findPath(SPAWNS[0][0], SPAWNS[0][1], x, z)) { console.log(`UNREACHABLE ${name}`); bad++; }
}

const sim = new Sim({ bots: true, difficulty: "normal", seed: 42 });
const human = sim.addHuman("Tester", 1);
const teamOf = () => { const s = sim.snapshot(human); const m = new Map<number, number>(); if (s && s.t === "snap") for (const p of s.players) m.set(p.id, p.tm); return m; };
let tm = teamOf();
const sizes = [0, 0]; for (const t of tm.values()) sizes[t]++;
console.log(`groups: A ${sizes[0]}, B ${sizes[1]}; Tester in ${tm.get(human) === 1 ? "B" : "A"}`);
if (sizes[0] !== sizes[1] || tm.get(human) !== 1) { console.log("groups are not balanced or the group choice was ignored"); bad++; }
let kills = 0, shots = 0, teamKills = 0, teamHits = 0;
const t0 = performance.now();
for (let i = 0; i < TICK_HZ * 180; i++) {
  sim.step(1 / TICK_HZ);
  if (i % 60 === 0) tm = teamOf();
  for (const e of sim.drainEvents()) {
    if (e.k === "shot") shots++;
    if (e.k === "end") console.log(`shift over at ${sim.time.toFixed(0)} s: Grupa A ${sim.score[0]} : ${sim.score[1]} Grupa B`);
    if (e.k === "kill") { kills++; if (e.by !== e.on && tm.get(e.by) === tm.get(e.on)) teamKills++; }
    if (e.k === "hit" && e.by !== e.on && tm.get(e.by) === tm.get(e.on)) teamHits++;
  }
}
const ms = performance.now() - t0;
const snap = sim.snapshot(human);
console.log(`180 s match: ${kills} kills, ${shots} shots, ${(ms / (TICK_HZ * 180) * 1000).toFixed(0)} µs per tick`);
if (snap && snap.t === "snap") {
  console.log(`score: Grupa A ${snap.score[0]} : ${snap.score[1]} Grupa B`);
  for (const t of [0, 1]) console.log(`  ${t ? "B" : "A"}: ` + snap.players.filter((p) => p.tm === t).map((p) => `${p.n} ${p.k}/${p.d}`).join(", "));
}
if (teamKills || teamHits) { console.log(`friendly fire happened: ${teamHits} hits, ${teamKills} kills`); bad++; }
if (kills < 5) { console.log("too few kills: bots are not fighting"); bad++; }
// forklifts: two players of one group get on (driver, thrower), the driver drives, both get off
{
  const fs = new Sim({ bots: false, difficulty: "normal", seed: 3 });
  const f0 = VEHICLE_SPAWNS[0];
  const d = fs.addHuman("Kierowca", 0), g = fs.addHuman("Rzucający", 0);
  const P = (fs as unknown as { players: Map<number, { body: { x: number; z: number }; veh: number; seat: number; spawn: number }> }).players;
  for (const id of [d, g]) { const b = P.get(id)!.body; b.x = f0.x; b.z = f0.z + 1.8; }
  fs.receive(d, { t: "use" }); fs.receive(g, { t: "use" });
  const pd = P.get(d)!, pg = P.get(g)!;
  const okSeats = pd.veh === 0 && pd.seat === 0 && pg.veh === 0 && pg.seat === 1;
  const snap0 = fs.snapshot(d);
  const rev = snap0 && snap0.t === "snap" ? snap0.me.vrev : -1;
  // drive 2 s east along the main aisle at 4 m/s
  let x = f0.x;
  for (let i = 1; i <= 120; i++) { x += 4 / 60; fs.receive(d, { t: "drive", x, z: f0.z, yaw: 0, speed: 4, rev }); fs.step(1 / 60); }
  const s1 = fs.snapshot(g);
  const fx = s1 && s1.t === "snap" ? s1.vehicles[0].x : 0;
  const thrower = s1 && s1.t === "snap" ? s1.players.find((p) => p.id === g)! : null;
  // a teleport is refused and bumps the revision
  fs.receive(d, { t: "drive", x: f0.x + 60, z: f0.z, yaw: 0, speed: 4, rev }); fs.step(1 / 60);
  const s2 = fs.snapshot(d);
  const refused = s2 && s2.t === "snap" && s2.vehicles[0].x < f0.x + 20 && s2.me.vrev !== rev;
  fs.receive(d, { t: "use" }); fs.receive(g, { t: "use" });
  const off = pd.veh === -1 && pg.veh === -1;
  console.log(`forklift: seats ${okSeats}, drove to x=${fx.toFixed(1)}, thrower rode at x=${thrower?.x.toFixed(1)}, teleport refused ${refused}, got off ${off}`);
  if (!okSeats || Math.abs(fx - x) > 0.2 || !thrower || Math.abs(thrower.x - (fx - 1.2)) > 0.3 || !refused || !off) { console.log("forklift check failed"); bad++; }
}
// perches: a ladder takes a player up to the deck, a bot (no climbing) stays down, a jump off the deck hurts
{
  const l = LADDERS[0];
  const cx = (l.x0 + l.x1) / 2, cz = (l.z0 + l.z1) / 2;
  const up = { x: cx, y: 0, z: cz, vx: 0, vy: 0, vz: 0, onGround: true };
  const bot = { ...up };
  for (let i = 0; i < 60 * 6; i++) {
    stepBody(up, { mx: l.dx, mz: 0, jump: false, sprint: false, climb: true }, 1 / 60);
    stepBody(bot, { mx: l.dx, mz: 0, jump: false, sprint: false }, 1 / 60);
  }
  const onDeck = Math.abs(up.y - l.top) < 0.01 && up.onGround;
  // slide back down the ladder: slow, lands on the floor
  const down = { x: cx, y: l.top - 0.5, z: cz, vx: 0, vy: 0, vz: 0, onGround: false };
  let maxFall = 0;
  for (let i = 0; i < 60 * 4; i++) { const y0 = down.y; stepBody(down, { mx: 0, mz: 0, jump: false, sprint: false, climb: true }, 1 / 60); maxFall = Math.max(maxFall, (y0 - down.y) * 60); }
  const fs = new Sim({ bots: false, difficulty: "normal", seed: 5 });
  const id = fs.addHuman("Skoczek", 0);
  for (let i = 0; i < 120; i++) fs.step(1 / 60); // past the spawn protection
  const me0 = fs.snapshot(id); const sp = me0 && me0.t === "snap" ? me0.me : null;
  let hp = 100;
  if (sp) {
    // the same spot, 7.2 m up, then a free fall to the floor
    let y = PERCH_H, vy = 0;
    fs.receive(id, { t: "state", x: sp.x, y: 0.5, z: sp.z, yaw: 0, pitch: 0, moving: false, spawn: sp.spawn }); fs.step(1 / 60);
    for (let k = 1; k <= 12; k++) { fs.receive(id, { t: "state", x: sp.x, y: Math.min(PERCH_H, 0.5 + k * 0.6), z: sp.z, yaw: 0, pitch: 0, moving: false, spawn: sp.spawn }); fs.step(1 / 60); fs.step(1 / 60); }
    while (y > 0) { vy -= 22 / 30; y = Math.max(0, y + vy / 30); fs.receive(id, { t: "state", x: sp.x, y, z: sp.z, yaw: 0, pitch: 0, moving: false, spawn: sp.spawn }); fs.step(1 / 60); fs.step(1 / 60); }
    fs.receive(id, { t: "state", x: sp.x, y: 0, z: sp.z, yaw: 0, pitch: 0, moving: false, spawn: sp.spawn }); fs.step(1 / 60);
    const s2 = fs.snapshot(id); if (s2 && s2.t === "snap") hp = s2.me.hp;
  }
  console.log(`perch: climbed to deck ${onDeck} (y=${up.y.toFixed(2)}), bot stayed down ${bot.y < 0.01}, ladder descent ${maxFall.toFixed(1)} m/s, health after a ${PERCH_H} m jump: ${hp}`);
  if (!onDeck || bot.y > 0.01 || maxFall > 4 || down.y > 0.01 || hp >= 100 || hp <= 0) { console.log("perch check failed"); bad++; }
}
process.exit(bad ? 1 : 0);
