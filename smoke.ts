// Headless check for efectivo ARENA. For each of the three hall configurations: every spawn, pickup and point
// (A and B) stands on free, reachable floor. Then whole bot matches of both missions (no friendly fire, rounds end
// every way they can, a team reaches the rounds it needs), the lobby rules, the forklift, the perches, connecting
// and disconnecting a server, and the cardboard grenade.
// Run with `npm run smoke`.

import { LADDERS, LAYOUTS, PERCH_H, VEHICLE_SPAWNS, useLayout } from "./shared/map";
import { blocked, stepBody } from "./shared/physics";
import { findPath } from "./shared/nav";
import { Sim, TICK_HZ, BRIEF_S, FREEZE_S, ROUNDS_WIN } from "./shared/sim";
import { lobPitch } from "./shared/weapons";
import type { Mission } from "./shared/proto";

let bad = 0;
const fail = (what: string) => { console.log(`FAILED: ${what}`); bad++; };

// ---- the three configurations
LAYOUTS.forEach((l, li) => {
  useLayout(li);
  const pts: [string, number, number][] = [
    ...l.spawns.map(([x, z], i) => [`spawn ${i}`, x, z] as [string, number, number]),
    ...l.pickups.map((p, i) => [`pickup ${i} ${p.kind}`, p.x, p.z] as [string, number, number]),
    ...l.vehicles.map((v, i) => [`forklift ${i}`, v.x, v.z] as [string, number, number]),
    ...l.stations.map((s, i) => [`station ${"AB"[i]}`, s.x, s.z] as [string, number, number]),
  ];
  let ok = 0;
  for (const [name, x, z] of pts) {
    if (blocked(x, 0.01, z, false)) fail(`layout ${l.name}: ${name} (${x}, ${z}) is inside something`);
    else if (!findPath(l.spawns[0][0], l.spawns[0][1], x, z)) fail(`layout ${l.name}: ${name} (${x}, ${z}) cannot be reached`);
    else ok++;
  }
  // the servers are solid cabinets: the walk has to end right beside each
  l.servers.forEach((sv, i) => {
    const path = findPath(l.spawns[12][0], l.spawns[12][1], sv.x, sv.z);
    const end = path?.[path.length - 1];
    if (!end || Math.hypot(end[0] - sv.x, end[1] - sv.z) > 2.2) fail(`layout ${l.name}: server ${"AB"[i]} cannot be reached`);
  });
  console.log(`layout ${l.name}: ${ok}/${pts.length} points free and reachable, ${l.boxes.filter((b) => b.kind === "rack").length} racks, ${l.ladders.length} perches`);
});

// ---- bot matches: whole matches of rounds
function match(mission: Mission, layout: number, seed: number) {
  const sim = new Sim({ seed });
  sim.config = { bots: [6, 6], mission, map: "hall", difficulty: "normal" };
  sim.begin(layout);
  let kills = 0, teamHits = 0, done = false;
  const reasons: Record<string, number> = { plant: 0, defuse: 0, time: 0, out: 0 };
  const roleWins = [0, 0];
  let wins = [0, 0];
  let tm = new Map<number, number>();
  const refresh = () => { const s = sim.snapshot(1); tm = new Map(); if (s && s.t === "snap") for (const p of s.players) tm.set(p.id, p.tm); };
  const t0 = performance.now();
  let n = 0;
  for (; n < TICK_HZ * 60 * 40 && !done; n++) {
    sim.step(1 / TICK_HZ);
    if (n % 60 === 0) refresh();
    for (const e of sim.drainEvents()) {
      if (e.k === "kill") kills++;
      if (e.k === "round") refresh();
      if (e.k === "hit" && e.by !== e.on && tm.get(e.by) === tm.get(e.on)) teamHits++;
      if (e.k === "roundEnd") { reasons[e.reason]++; roleWins[e.winner]++; }
      if (e.k === "end") { done = true; wins = e.wins; }
    }
  }
  const us = (performance.now() - t0) / n * 1000;
  console.log(`  ${mission} on ${LAYOUTS[layout].name}: ${wins[0]} : ${wins[1]} in ${sim.round} rounds and ${(sim.time / 60).toFixed(1)} min; rounds won by workers ${roleWins[0]}, technicians ${roleWins[1]}; ended by connect ${reasons.plant}, disconnect ${reasons.defuse}, time ${reasons.time}, team out ${reasons.out}; ${kills} eliminations, ${us.toFixed(0)} µs per tick`);
  if (!done) fail(`${mission} on ${LAYOUTS[layout].name}: the match never ended`);
  if (Math.max(wins[0], wins[1]) !== ROUNDS_WIN) fail("the match did not end at the rounds needed");
  if (teamHits) fail(`friendly fire: ${teamHits} hits`);
  if (kills < 10) fail("too few eliminations: the bots are not fighting");
  return roleWins;
}
console.log("bot matches, 6 v 6:");
const role = [0, 0];
const PLAN: [Mission, number][] = process.argv.includes("--balance")
  ? [["server", 3], ["tags", 3], ["server", 3], ["tags", 3], ["server", 0], ["tags", 0], ["server", 1], ["tags", 1], ["server", 2], ["tags", 2], ["server", 0], ["tags", 1], ["server", 2]]
  : [["server", 0], ["tags", 1], ["server", 2], ["server", 3], ["tags", 3]];
PLAN.forEach(([m, l], i) => { const r = match(m, l, 40 + i * 7); role[0] += r[0]; role[1] += r[1]; });
console.log(`  rounds overall: workers ${role[0]}, technicians ${role[1]}`);

// ---- the lobby: teams are chosen, only the host configures and starts, 20 a team at most
{
  const sim = new Sim({ seed: 9 });
  const a = sim.addHuman("Ania", 1), b = sim.addHuman("Bartek", 1), c = sim.addHuman("Celina");
  sim.receive(b, { t: "config", config: { bots: [20, 20], mission: "tags", map: "hall", difficulty: "hard" } }); // not the host: ignored
  sim.receive(b, { t: "start" });
  const stillLobby = sim.phase === "lobby" && sim.config.bots[0] === 5;
  sim.receive(c, { t: "team", team: 1 });
  sim.receive(a, { t: "config", config: { bots: [20, 20], mission: "tags", map: "hall", difficulty: "hard" } });
  sim.receive(a, { t: "start" });
  const s = sim.snapshot(a);
  const players = s && s.t === "snap" ? s.players : [];
  const w = players.filter((p) => p.tm === 0).length, t = players.filter((p) => p.tm === 1).length;
  console.log(`lobby: guest cannot start ${stillLobby}, phase ${sim.phase}, mission ${sim.mission}, workers ${w}, technicians ${t} (3 people among them)`);
  if (!stillLobby || sim.phase !== "brief" || sim.mission !== "tags" || w !== 20 || t !== 20) fail("lobby rules");
}

// ---- forklifts: two players of one team get on (driver, thrower), the driver drives, both get off
{
  const fs = new Sim({ seed: 3 });
  const d = fs.addHuman("Kierowca", 0), g = fs.addHuman("Rzucający", 0);
  fs.config = { bots: [0, 0], mission: "server", map: "hall", difficulty: "normal" };
  fs.begin(0);
  for (let i = 0; i < TICK_HZ * (BRIEF_S + FREEZE_S + 1); i++) fs.step(1 / TICK_HZ);
  const f0 = VEHICLE_SPAWNS[0];
  const P = (fs as unknown as { players: Map<number, { body: { x: number; z: number }; veh: number; seat: number }> }).players;
  for (const id of [d, g]) { const b = P.get(id)!.body; b.x = f0.x; b.z = f0.z + 1.8; }
  fs.receive(d, { t: "use" }); fs.receive(g, { t: "use" });
  const pd = P.get(d)!, pg = P.get(g)!;
  const okSeats = pd.veh === 0 && pd.seat === 0 && pg.veh === 0 && pg.seat === 1;
  const snap0 = fs.snapshot(d);
  const rev = snap0 && snap0.t === "snap" ? snap0.me.vrev : -1;
  let x = f0.x;
  for (let i = 1; i <= 120; i++) { x += 4 / 60; fs.receive(d, { t: "drive", x, z: f0.z, yaw: 0, speed: 4, rev }); fs.step(1 / 60); }
  const s1 = fs.snapshot(g);
  const fx = s1 && s1.t === "snap" ? s1.vehicles[0].x : 0;
  const thrower = s1 && s1.t === "snap" ? s1.players.find((p) => p.id === g)! : null;
  fs.receive(d, { t: "drive", x: f0.x + 60, z: f0.z, yaw: 0, speed: 4, rev }); fs.step(1 / 60);
  const s2 = fs.snapshot(d);
  const refused = s2 && s2.t === "snap" && s2.vehicles[0].x < f0.x + 20 && s2.me.vrev !== rev;
  fs.receive(d, { t: "use" }); fs.receive(g, { t: "use" });
  const off = pd.veh === -1 && pg.veh === -1;
  console.log(`forklift: seats ${okSeats}, drove to x=${fx.toFixed(1)}, thrower rode at x=${thrower?.x.toFixed(1)}, teleport refused ${refused}, got off ${off}`);
  if (!okSeats || Math.abs(fx - x) > 0.2 || !thrower || Math.abs(thrower.x - (fx - 1.25)) > 0.3 || !refused || !off) fail("forklift");
}

// ---- perches, the server and the grenade, with two people
{
  useLayout(0);
  const l = LADDERS[0];
  const cx = (l.x0 + l.x1) / 2, cz = (l.z0 + l.z1) / 2;
  const up = { x: cx, y: 0, z: cz, vx: 0, vy: 0, vz: 0, onGround: true };
  const bot = { ...up };
  for (let i = 0; i < 60 * 6; i++) {
    stepBody(up, { mx: l.dx, mz: 0, jump: false, sprint: false, climb: true }, 1 / 60);
    stepBody(bot, { mx: l.dx, mz: 0, jump: false, sprint: false }, 1 / 60);
  }
  const onDeck = Math.abs(up.y - l.top) < 0.01 && up.onGround;
  console.log(`perch: climbed to the deck ${onDeck} (y=${up.y.toFixed(2)}, deck ${PERCH_H}), a bot stays down ${bot.y < 0.01}`);
  if (!onDeck || bot.y > 0.01) fail("perch");

  const sim = new Sim({ seed: 5 });
  const w = sim.addHuman("Pracownik", 0), t = sim.addHuman("Technik", 1);
  sim.config = { bots: [0, 0], mission: "server", map: "hall", difficulty: "normal" };
  sim.begin(0);
  for (let i = 0; i < TICK_HZ * (BRIEF_S + FREEZE_S + 2); i++) sim.step(1 / TICK_HZ);
  sim.drainEvents();
  const P = (sim as unknown as { players: Map<number, { body: { x: number; y: number; z: number }; hp: number; mag: { grenade: number } }> }).players;
  const srv = LAYOUTS[0].servers[1];
  const pt = P.get(t)!, pw = P.get(w)!;
  const obj = () => { const s = sim.snapshot(t); return s && s.t === "snap" ? s.obj : null; };
  // the grenade first: thrown 12 m at a worker standing 16 m away along the main aisle, it bursts and hurts
  pt.body.x = 64; pt.body.z = 0; pw.body.x = 80; pw.body.z = 0;
  for (let i = 0; i < 10; i++) sim.step(1 / TICK_HZ);
  const moneyBefore = (pt as unknown as { money: number }).money = 700;
  sim.receive(t, { t: "buy", item: "sniper" }); // too dear: nothing happens
  sim.receive(t, { t: "buy", item: "grenade" }); sim.receive(t, { t: "buy", item: "grenade" }); sim.receive(t, { t: "buy", item: "grenade" });
  const left = (pt as unknown as { money: number }).money;
  console.log(`shop: ${moneyBefore} -> ${left} for ${pt.mag.grenade} grenades (a third does not fit)`);
  if (left !== 100 || pt.mag.grenade !== 2) fail("shop");
  sim.receive(t, { t: "switch", w: "grenade" });
  for (let i = 0; i < 40; i++) sim.step(1 / TICK_HZ);
  const pitch = lobPitch(12, 0.3 - 1.62);
  sim.receive(t, { t: "shoot", w: "grenade", yaw: -Math.PI / 2, pitch, dirs: [Math.cos(pitch), Math.sin(pitch), 0], view: sim.time });
  let boom = false;
  for (let i = 0; i < TICK_HZ * 3; i++) { sim.step(1 / TICK_HZ); for (const e of sim.drainEvents()) if (e.k === "boom") boom = true; }
  console.log(`grenade: burst ${boom}, worker health ${pw.hp}, grenades left ${pt.mag.grenade}`);
  if (!boom || pw.hp >= 100 || pw.hp <= 0 || pt.mag.grenade !== 1) fail("grenade");
  // a worker cannot connect; the technician lets go early and it starts over; then holds on and it starts up
  pw.body.x = srv.x - 1.6; pw.body.z = srv.z; sim.receive(w, { t: "act", on: true });
  for (let i = 0; i < TICK_HZ * 2; i++) sim.step(1 / TICK_HZ);
  const workerPlant = obj()!.plant;
  sim.receive(w, { t: "act", on: false });
  pt.body.x = srv.x + 1.6; pt.body.z = srv.z;
  sim.receive(t, { t: "act", on: true });
  for (let i = 0; i < TICK_HZ * 2; i++) sim.step(1 / TICK_HZ);
  const half = obj()!.plant;
  sim.receive(t, { t: "act", on: false }); sim.step(1 / TICK_HZ);
  const reset = obj()!.plant;
  sim.receive(t, { t: "act", on: true });
  for (let i = 0; i < TICK_HZ * 4.2; i++) sim.step(1 / TICK_HZ);
  const armed = obj()!.armed;
  // the worker disconnects it: the workers win the round
  sim.receive(w, { t: "act", on: true });
  let ended = "";
  for (let i = 0; i < TICK_HZ * 8 && !ended; i++) { sim.step(1 / TICK_HZ); for (const e of sim.drainEvents()) if (e.k === "roundEnd") ended = `${e.reason} by role ${e.winner}`; }
  console.log(`server B: a worker cannot connect ${workerPlant === 0}, half way ${(half * 100).toFixed(0)} %, letting go resets ${reset === 0}, starting up at point ${"AB"[armed] ?? "-"}, round ended: ${ended}, score ${sim.wins.join(" : ")}`);
  if (workerPlant !== 0 || half < 0.4 || reset !== 0 || armed !== 1 || ended !== "defuse by role 0" || sim.wins[0] !== 1) fail("connecting and disconnecting");
}

console.log(bad ? `${bad} check(s) failed` : "all checks passed");
process.exit(bad ? 1 : 0);
