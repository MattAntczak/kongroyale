// Headless check for efectivo ARENA. For each of the three hall configurations: every spawn, pickup and point
// (A and B) stands on free, reachable floor. Then whole bot matches of both missions (no friendly fire, rounds end
// every way they can, a team reaches the rounds it needs), the lobby rules, the forklift, the perches, connecting
// and disconnecting a server, and the cardboard grenade. Then the CS-style movement and aiming: counter-strafing,
// the crouch (a lower hitbox, no standing up under a low ceiling, the crouch-jump onto a pallet stack), the host's
// speed check, and first-throw accuracy against a spray. Then the host's own view of a person: its speed for a throw
// (states chopped up or held back do not hide a run), the forklift's thrower, the speed limit of the stance and the
// launcher, head room under Sortownia's roof, gravity (no climbing or hovering on states), and an honest minute of
// play on Sortownia and on Zajezdnia through a lossy network that the host must never correct.
// Run with `npm run smoke`.

import { BOXES, LADDERS, LAYOUTS, PERCH_H, VEHICLE_SPAWNS, useLayout, type Box } from "./shared/map";
import { BOX_HIT_PAD, CROUCH_H, PLAYER_H, PLAYER_R, RUN_SPEED, blocked, rayPlayer, setDynamicBoxes, stepBody, viewDir, type Body, type MoveInput } from "./shared/physics";
import { rideSpeed, seatPos, stepVehicle, type VehicleState } from "./shared/vehicle";
import { findPath } from "./shared/nav";
import { Sim, TICK_HZ, BRIEF_S, FREEZE_S, ROUNDS_WIN } from "./shared/sim";
import { WEAPONS, lobPitch, maxSpeed, type WeaponId } from "./shared/weapons";
import type { ClientMsg, Mission } from "./shared/proto";

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
  : [["server", 0], ["tags", 1], ["server", 2], ["server", 3], ["tags", 3], ["server", 4], ["tags", 4]];
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
    stepBody(up, { mx: l.dx, mz: 0, jump: false, climb: true }, 1 / 60);
    stepBody(bot, { mx: l.dx, mz: 0, jump: false }, 1 / 60);
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
  sim.receive(t, { t: "shoot", w: "grenade", yaw: -Math.PI / 2, pitch, view: sim.time });
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

// ---- movement and aiming like CS
{
  useLayout(0);
  const DT = 1 / 60;
  const body = (x: number, z: number): Body => ({ x, y: 0, z, vx: 0, vy: 0, vz: 0, onGround: true });
  /** A stretch of free floor `len` metres long along +x (with a metre either side), for the running tests. */
  const openFloor = (len: number): [number, number] => {
    for (let z = -100; z <= 100; z += 3) for (let x = -200; x <= 200; x += 3) {
      let ok = true;
      for (let d = -1; d <= len + 1 && ok; d += 0.5) for (const oz of [-1, 0, 1]) if (blocked(x + d, 0.01, z + oz, false)) { ok = false; break; }
      if (ok) return [x, z];
    }
    throw new Error("no open floor");
  };
  const [fx, fz] = openFloor(22);
  // (a) run at full speed, then press the opposite key: the body stops within ~0.15 s; letting go glides longer
  const run = (b: Body, s: number) => { for (let i = 0; i < 60; i++) stepBody(b, { mx: 1, mz: 0, jump: false, speed: s }, DT); };
  const cs = body(fx, fz); run(cs, RUN_SPEED);
  const top = cs.vx;
  let tStop = 0;
  while (cs.vx > 0 && tStop < 1) { stepBody(cs, { mx: -1, mz: 0, jump: false }, DT); tStop += DT; }
  const gl = body(fx, fz); run(gl, RUN_SPEED);
  let tGlide = 0;
  while (Math.hypot(gl.vx, gl.vz) > 0.05 && tGlide < 3) { stepBody(gl, { mx: 0, mz: 0, jump: false }, DT); tGlide += DT; }
  const wk = body(fx, fz); for (let i = 0; i < 60; i++) stepBody(wk, { mx: 1, mz: 0, jump: false, walk: true }, DT);
  const cr = body(fx, fz); for (let i = 0; i < 60; i++) stepBody(cr, { mx: 1, mz: 0, jump: false, crouch: true }, DT);
  const rf = body(fx, fz); run(rf, maxSpeed("rifle"));
  console.log(`movement: top speed ${top.toFixed(2)} m/s (rifle ${rf.vx.toFixed(2)}, walk ${wk.vx.toFixed(2)}, crouched ${cr.vx.toFixed(2)}), counter-strafe stops in ${tStop.toFixed(3)} s, letting go in ${tGlide.toFixed(2)} s`);
  if (Math.abs(top - RUN_SPEED) > 0.05 || tStop > 0.15 || tGlide < tStop || tGlide > 0.8 || wk.vx > 2.6 || wk.vx < 2.3 || cr.vx > 1.7 || cr.vx < 1.5 || rf.vx > 4.3) fail("counter-strafe / speeds");
  // hopping is not faster than running: from a run, 2.5 s of jumping at every landing against 2.5 s more running
  const hop = body(fx, fz), walkOn = body(fx, fz);
  run(hop, RUN_SPEED); run(walkOn, RUN_SPEED);
  const x0 = hop.x;
  for (let i = 0; i < 150; i++) { stepBody(hop, { mx: 1, mz: 0, jump: true }, DT); stepBody(walkOn, { mx: 1, mz: 0, jump: false }, DT); }
  console.log(`  2.5 s of jump-spam ${(hop.x - x0).toFixed(1)} m, of running ${(walkOn.x - x0).toFixed(1)} m`);
  if (hop.x > walkOn.x) fail("jump-spam outruns running");

  // (b) a crouched player is a lower target: a box at standing chest height flies over; the crouched body keeps to
  // its crouch under a 1.5 m ceiling, and the host refuses a "state" that stands up there
  const out = [0];
  const chest = 1.45;
  const hitStand = rayPlayer(fx, chest, fz + 10, 0, 0, -1, fx, 0, fz, out, BOX_HIT_PAD, PLAYER_H);
  const hitCrouch = rayPlayer(fx, chest, fz + 10, 0, 0, -1, fx, 0, fz, out, BOX_HIT_PAD, CROUCH_H);
  const ceil: Box = { kind: "block", x0: fx - 1, x1: fx + 1, y0: 1.5, y1: 2.5, z0: fz - 1, z1: fz + 1 };
  setDynamicBoxes([ceil]);
  const dk = body(fx, fz);
  for (let i = 0; i < 20; i++) stepBody(dk, { mx: 0, mz: 0, jump: false, crouch: true }, DT);
  for (let i = 0; i < 30; i++) stepBody(dk, { mx: 0, mz: 0, jump: false, crouch: false }, DT);
  const stayed = !!dk.crouch;
  setDynamicBoxes([]);
  for (let i = 0; i < 5; i++) stepBody(dk, { mx: 0, mz: 0, jump: false, crouch: false }, DT);
  const stoodUp = !dk.crouch;
  console.log(`crouch: chest-high box hits a standing player ${hitStand > 0}, misses a crouched one ${hitCrouch === 0}; under a 1.5 m ceiling stays crouched ${stayed}, stands once it is gone ${stoodUp}`);
  if (!hitStand || hitCrouch || !stayed || !stoodUp) fail("crouch");

  // (c) a 1.25 m pallet stack: a crouch-jump gets on top, a plain jump does not
  let stack: Box | undefined, side = 0;
  for (const b of BOXES) {
    if (b.kind !== "stack" || Math.abs(b.y1 - 1.25) > 0.01 || b.y0 > 0.01) continue;
    const cz = (b.z0 + b.z1) / 2;
    if (blocked((b.x0 + b.x1) / 2, b.y1 + 0.01, cz, false)) continue;
    for (const sd of [-1, 1]) {
      const fx0 = sd < 0 ? b.x0 : b.x1;
      let ok = true;
      for (let d = 0.4; d <= 4.5 && ok; d += 0.25) if (blocked(fx0 + sd * (PLAYER_R + d), 0.01, cz, false)) ok = false;
      if (ok) { stack = b; side = sd; break; }
    }
    if (stack) break;
  }
  if (!stack) fail("no free 1.25 m stack to jump on");
  else {
    const face = side < 0 ? stack.x0 : stack.x1, cz = (stack.z0 + stack.z1) / 2;
    const jumpOn = (tuck: boolean) => {
      const b = body(face + side * (PLAYER_R + 4.4), cz);
      let jumped = false, air = 0, top = false, high = 0;
      for (let i = 0; i < 100 && !top; i++) {
        const gap = Math.abs(b.x - face) - PLAYER_R;
        const go = !jumped && gap < 1.3;
        if (go) jumped = true;
        if (jumped && !b.onGround) air += DT;
        stepBody(b, { mx: -side, mz: 0, jump: go, crouch: tuck && jumped && air > 0.03 }, DT);
        top = b.onGround && Math.abs(b.y - stack!.y1) < 0.01;
        high = Math.max(high, b.y);
      }
      return { top, high };
    };
    const cj = jumpOn(true), pj = jumpOn(false);
    console.log(`crouch-jump onto a 1.25 m stack: lands on top ${cj.top}; a plain jump does not ${!pj.top} (its feet reach ${pj.high.toFixed(2)} m)`);
    if (!cj.top || pj.top) fail("crouch-jump");
  }

  // (d) and (e) with the host
  const sim = new Sim({ seed: 77 });
  const a = sim.addHuman("Ania", 0), t = sim.addHuman("Tomek", 1);
  sim.config = { bots: [0, 0], mission: "server", map: "hall", difficulty: "normal" };
  sim.begin(0);
  for (let i = 0; i < TICK_HZ * (BRIEF_S + FREEZE_S + 1); i++) sim.step(1 / TICK_HZ);
  type P = { body: Body; money: number; aim: { pp: number }; protectUntil: number; hp: number };
  const PL = (sim as unknown as { players: Map<number, P> }).players;
  const spawnOf = (id: number) => { const s = sim.snapshot(id); return s && s.t === "snap" ? s.me.spawn : -1; };
  const pa = PL.get(a)!, pt = PL.get(t)!;
  pa.body.x = fx; pa.body.z = fz; pa.body.y = 0;
  const sp0 = spawnOf(a);
  // a legal run at the top speed for 1.5 s, then a speed hack at 1.6 times that for 2 s
  let x = fx;
  const send = (v: number, secs: number) => {
    for (let i = 0; i < secs * 30; i++) {
      x += v / 30;
      sim.receive(a, { t: "state", x, y: 0, z: fz, yaw: 0, pitch: 0, moving: true, spawn: spawnOf(a) });
      for (let k = 0; k < 2; k++) sim.step(1 / TICK_HZ);
    }
  };
  send(RUN_SPEED, 1.5);
  const legal = spawnOf(a) === sp0;
  send(RUN_SPEED * 1.6, 2);
  const caught = spawnOf(a) !== sp0;
  console.log(`host speed check: a run at ${RUN_SPEED} m/s passes ${legal}, ${(RUN_SPEED * 1.6).toFixed(1)} m/s is sent back ${caught}`);
  if (!legal || !caught) fail("host speed check");

  // the host's crouch: a chest-high throw misses a crouched technician and hits a standing one; and a "state" that
  // stands up under a 1.5 m ceiling is refused
  pa.body.x = fx; pa.body.z = fz + 8; pa.body.y = 0;
  pt.body.x = fx; pt.body.z = fz; pt.body.y = 0;
  const hits = (crouch: boolean) => {
    sim.receive(t, { t: "state", x: fx, y: 0, z: fz, yaw: 0, pitch: 0, moving: false, spawn: spawnOf(t), crouch });
    for (let i = 0; i < 30; i++) sim.step(1 / TICK_HZ);
    sim.drainEvents();
    pt.protectUntil = 0;
    sim.receive(a, { t: "shoot", w: "pistol", yaw: 0, pitch: 0, view: sim.time });
    let hit = false;
    for (let i = 0; i < 30; i++) { sim.step(1 / TICK_HZ); for (const e of sim.drainEvents()) if (e.k === "hit" && e.on === t) hit = true; }
    return hit;
  };
  const hitUp = hits(false), hitDown = hits(true);
  const roof: Box = { kind: "block", x0: fx - 1, x1: fx + 1, y0: 1.5, y1: 2.5, z0: fz - 1, z1: fz + 1 };
  (LAYOUTS[0].boxes as Box[]).push(roof);
  const before = spawnOf(t);
  sim.receive(t, { t: "state", x: fx, y: 0, z: fz, yaw: 0, pitch: 0, moving: false, spawn: before, crouch: true });
  sim.step(1 / TICK_HZ);
  const crouchOk = spawnOf(t) === before;
  sim.receive(t, { t: "state", x: fx, y: 0, z: fz, yaw: 0, pitch: 0, moving: false, spawn: before, crouch: false });
  sim.step(1 / TICK_HZ);
  const standRefused = spawnOf(t) !== before;
  (LAYOUTS[0].boxes as Box[]).pop();
  console.log(`host crouch: chest-high throw hits a standing player ${hitUp}, misses a crouched one ${!hitDown}; crouched under a 1.5 m roof accepted ${crouchOk}, standing up there refused ${standRefused}`);
  if (!hitUp || hitDown || !crouchOk || !standRefused) fail("host crouch");

  // (e) first-throw accuracy against a spray: the host's cone after 10 quick Kartonomiot throws is far wider
  pa.money = 5000;
  pa.body.x = fx; pa.body.z = fz + 30;
  sim.receive(a, { t: "buy", item: "rifle" });
  for (let i = 0; i < 30; i++) sim.step(1 / TICK_HZ);
  const first = sim.coneOf(a);
  const gap = Math.ceil(60 / WEAPONS.rifle.rpm * TICK_HZ) + 1;
  for (let k = 0; k < 10; k++) { sim.receive(a, { t: "shoot", w: "rifle", yaw: 0, pitch: 0, view: sim.time }); for (let i = 0; i < gap; i++) sim.step(1 / TICK_HZ); }
  const spray = sim.coneOf(a), punch = pa.aim.pp;
  for (let i = 0; i < 40; i++) sim.step(1 / TICK_HZ);
  const rested = sim.coneOf(a), punchRested = pa.aim.pp;
  const runCone = sim.coneOf(a, maxSpeed("rifle")), airCone = sim.coneOf(a, 0, true);
  console.log(`aim: Kartonomiot cone ${(first * 1000).toFixed(1)} mrad first, ${(spray * 1000).toFixed(1)} after 10 throws (punch ${(punch * 57.3).toFixed(1)}°), ${(rested * 1000).toFixed(1)} after 0.67 s rest (punch ${(punchRested * 57.3).toFixed(2)}°); running ${(runCone * 1000).toFixed(1)}, in the air ${(airCone * 1000).toFixed(1)}`);
  if (!(spray > first * 8) || punch < 0.05 || rested > first * 1.01 || punchRested > 0.005 || runCone < first * 10 || airCone < runCone) fail("first-throw accuracy against a spray");
}

// ---- the host's own view of a person: its speed for throws, the stance, gravity, the forklift's thrower, and a whole
// honest minute of play (a client model with latency, jitter and lag bursts) that must never be corrected
{
  const DT = 1 / TICK_HZ;
  type HP = { body: Body; money: number; aim: { pp: number; py: number }; spawn: number; veh: number; seat: number; w: WeaponId; hp: number; protectUntil: number };
  /** A shift with people only (no bots), stepped into play. */
  const room = (layout: number, teams: number[], seed = 11) => {
    const sim = new Sim({ seed });
    const ids = teams.map((t, i) => sim.addHuman(`P${i}`, t));
    sim.config = { bots: [0, 0], mission: "server", map: "hall", difficulty: "normal" };
    sim.begin(layout);
    for (let i = 0; i < TICK_HZ * (BRIEF_S + FREEZE_S + 0.5); i++) sim.step(DT);
    sim.drainEvents();
    const PL = (sim as unknown as { players: Map<number, HP> }).players;
    for (const id of ids) { const p = PL.get(id)!; p.money = 9000; sim.receive(id, { t: "buy", item: "rifle" }); }
    return { sim, ids, P: (id: number) => PL.get(id)! };
  };
  /** Free floor for a circle of radius `r`. */
  const openDisc = (r: number): [number, number] => {
    for (let z = -100; z <= 100; z += 2) for (let x = -200; x <= 200; x += 2) {
      let ok = true;
      for (let a = 0; a < 24 && ok; a++) for (const rr of [0, r / 2, r, r + 0.8]) if (blocked(x + Math.cos(a / 24 * 6.283) * rr, 0.01, z + Math.sin(a / 24 * 6.283) * rr, false)) { ok = false; break; }
      if (ok) return [x, z];
    }
    throw new Error("no open floor");
  };
  /** The angle (rad) between the first box of a "shot" event and the view it was thrown along. */
  const devOf = (dirs: number[], yaw: number, pitch: number) => {
    const [vx, vy, vz] = viewDir(yaw, pitch);
    return Math.acos(Math.min(1, dirs[0] * vx + dirs[1] * vy + dirs[2] * vz));
  };
  const mr = (v: number) => (v * 1000).toFixed(1);

  /**
   * A browser client as game.ts runs one, for the host to check: stepBody at 60 Hz, its state every second frame and
   * right before a throw, through a network with latency, jitter and lag bursts both ways; a correction from the host
   * (a changed spawn counter in a snapshot) puts it back on the host's pose at rest. Corrections are counted on the
   * host: spawn bumps that are not getting on or off a forklift.
   */
  class Client {
    body: Body = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: true };
    spawn = -1; veh = -1; seat = 0; vrev = 0; corrections = 0; shots = 0;
    drive: VehicleState = { x: 0, z: 0, yaw: 0, speed: 0 };
    vehicles: VehicleState[] = [];
    private up: { at: number; m: ClientMsg }[] = [];
    private down: { at: number; s: { me: { spawn: number; x: number; y: number; z: number; veh: number; seat: number; vrev: number }; vehicles: VehicleState[] } }[] = [];
    private lastUp = 0; private lastDown = 0; private frameN = 0; private hostSpawn: number;
    stalls: [number, number][] = [];
    constructor(readonly sim: Sim, readonly id: number, readonly net = { lat: 0.04, jit: 0.025, rand: Math.random }) {
      const s = sim.snapshot(id);
      if (s && s.t === "snap") { this.spawn = s.me.spawn; this.body.x = s.me.x; this.body.y = s.me.y; this.body.z = s.me.z; this.vehicles = s.vehicles; }
      this.hostSpawn = this.hp().spawn;
    }
    private hp() { return (this.sim as unknown as { players: Map<number, HP> }).players.get(this.id)!; }
    private stalled(t: number) { for (const [a, b] of this.stalls) if (t >= a && t < b) return b; return t; }
    send(m: ClientMsg) {
      const at = Math.max(this.lastUp, this.stalled(this.sim.time + this.net.lat + this.net.rand() * this.net.jit));
      this.lastUp = at; this.up.push({ at, m });
    }
    state() { this.send({ t: "state", x: this.body.x, y: this.body.y, z: this.body.z, yaw: 0, pitch: 0, moving: Math.hypot(this.body.vx, this.body.vz) > 1, spawn: this.spawn, crouch: !!this.body.crouch }); }
    shoot(yaw = 0) {
      this.state();
      const v = this.veh >= 0 ? this.vehicles.find((q) => (q as unknown as { id: number }).id === this.veh) : undefined;
      const spd = v ? rideSpeed(v) : Math.hypot(this.body.vx, this.body.vz);
      this.send({ t: "shoot", w: "rifle", yaw, pitch: 0, view: this.sim.time - 0.1, spd, air: !this.body.onGround, n: ++this.shots });
    }
    /** One frame: snapshots in, the body moved (or carried), the state out; then the host's tick. */
    frame(inp: MoveInput, driveIn?: [number, number]) {
      const t = this.sim.time;
      while (this.down.length && this.down[0].at <= t) {
        const { s } = this.down.shift()!;
        this.vehicles = s.vehicles;
        if (s.me.spawn !== this.spawn) {
          this.spawn = s.me.spawn;
          Object.assign(this.body, { x: s.me.x, y: s.me.y, z: s.me.z, vx: 0, vy: 0, vz: 0 });
        }
        if (s.me.veh !== this.veh || s.me.seat !== this.seat || (s.me.veh >= 0 && s.me.vrev !== this.vrev)) {
          const v = s.vehicles.find((q) => (q as unknown as { id: number }).id === s.me.veh);
          if (v) this.drive = { x: v.x, z: v.z, yaw: v.yaw, speed: s.me.veh !== this.veh ? 0 : v.speed };
          this.veh = s.me.veh; this.seat = s.me.seat; this.vrev = s.me.vrev;
        }
      }
      if (this.veh >= 0) {
        if (this.seat === 0 && driveIn) stepVehicle(this.drive, driveIn[0], driveIn[1], DT, this.vehicles.filter((q) => (q as unknown as { id: number }).id !== this.veh));
        const pose = this.seat === 0 ? this.drive : this.vehicles.find((q) => (q as unknown as { id: number }).id === this.veh);
        if (pose) { const o = [0, 0, 0]; seatPos(pose, this.seat, o); this.body.x = o[0]; this.body.y = o[1]; this.body.z = o[2]; }
        this.body.vx = this.body.vz = 0; this.body.onGround = true; this.body.crouch = false; this.body.tucked = false;
      } else stepBody(this.body, inp, DT);
      if (this.frameN++ % 2 === 0) {
        this.state();
        if (this.veh >= 0 && this.seat === 0) this.send({ t: "drive", x: this.drive.x, z: this.drive.z, yaw: this.drive.yaw, speed: this.drive.speed, rev: this.vrev });
      }
    }
    /** Deliver what has arrived to the host (call before its step), and after it count corrections and take snapshots. */
    deliver() { while (this.up.length && this.up[0].at <= this.sim.time) this.sim.receive(this.id, this.up.shift()!.m); }
    after(evs: { k: string; id?: number }[], tick: number) {
      const sp = this.hp().spawn;
      if (sp !== this.hostSpawn) {
        const rides = evs.filter((e) => e.k === "ride" && e.id === this.id).length;
        this.corrections += Math.max(0, sp - this.hostSpawn - rides);
        this.hostSpawn = sp;
      }
      if (tick % 3 === 0) {
        const s = this.sim.snapshot(this.id);
        if (s && s.t === "snap") {
          const at = Math.max(this.lastDown, this.stalled(this.sim.time + this.net.lat + this.net.rand() * this.net.jit));
          this.lastDown = at;
          this.down.push({ at, s: JSON.parse(JSON.stringify({ me: s.me, vehicles: s.vehicles })) });
        }
      }
    }
  }
  type Gen = Generator<MoveInput, void, void>;
  const NONE: MoveInput = { mx: 0, mz: 0, jump: false, speed: maxSpeed("rifle"), climb: true };
  const inp = (o: Partial<MoveInput>): MoveInput => ({ ...NONE, ...o });
  function* idle(secs: number, o: Partial<MoveInput> = {}): Gen { for (let i = 0; i < secs * TICK_HZ; i++) yield inp(o); }
  function* walk(c: Client, x: number, z: number, o: Partial<MoveInput> = {}, tol = 0.3): Gen {
    let best = Infinity, since = 0, turn = 1;
    for (let i = 0; i < TICK_HZ * 25; i++) {
      const dx = x - c.body.x, dz = z - c.body.z, d = Math.hypot(dx, dz);
      if (d < tol) return;
      if (d < best - 0.05) { best = d; since = i; }
      if (i - since > 15) {
        // caught on a corner: side-step a little, the other way next time
        for (let k = 0; k < 12; k++) yield inp({ ...o, mx: -dz / d * turn, mz: dx / d * turn });
        turn = -turn; since = i; best = Infinity;
      }
      yield inp({ ...o, mx: dx / d, mz: dz / d });
    }
    throw new Error(`walk to (${x}, ${z}) stuck at (${c.body.x.toFixed(2)}, ${c.body.y.toFixed(2)}, ${c.body.z.toFixed(2)})`);
  }
  function* path(c: Client, x: number, z: number, o: Partial<MoveInput> = {}): Gen {
    const pts = findPath(c.body.x, c.body.z, x, z);
    if (!pts) throw new Error(`no path to (${x}, ${z})`);
    for (const [px, pz] of pts) yield* walk(c, px, pz, o, 0.25);
    yield* walk(c, x, z, o);
  }
  /** `n` jumps on the spot, crouching in the air (the tuck) when `tuck`. */
  function* hops(c: Client, n: number, tuck: boolean): Gen {
    for (let k = 0; k < n; k++) {
      while (!c.body.onGround) yield inp({});
      yield inp({ jump: true });
      for (let i = 0; !c.body.onGround && i < 120; i++) yield inp({ crouch: tuck && i > 3 && i < 30 });
      yield* idle(0.25);
    }
  }
  /** Run along (dx, dz) for `secs`, counter-strafe until the body stops, then throw. */
  function* counter(c: Client, dx: number, dz: number, secs: number): Gen {
    yield* idle(secs, { mx: dx, mz: dz });
    for (let i = 0; i < 30 && c.body.vx * dx + c.body.vz * dz > 0.05; i++) yield inp({ mx: -dx, mz: -dz });
    c.shoot(); yield inp({});
    yield* idle(0.3);
  }
  /** A 1.25 m pallet stack with free floor on one side: [stack, side]. */
  const stackNear = (x: number, z: number): [Box, number] => {
    let best: [Box, number] | null = null, bd = Infinity;
    for (const b of BOXES) {
      if (b.kind !== "stack" || Math.abs(b.y1 - 1.25) > 0.01 || b.y0 > 0.01) continue;
      const cz = (b.z0 + b.z1) / 2;
      if (blocked((b.x0 + b.x1) / 2, b.y1 + 0.01, cz, false)) continue;
      for (const sd of [-1, 1]) {
        const f = sd < 0 ? b.x0 : b.x1;
        let ok = true;
        for (let d = 0.4; d <= 5.5 && ok; d += 0.25) for (const oz of [-0.4, 0, 0.4]) if (blocked(f + sd * (PLAYER_R + d), 0.01, cz + oz, false)) ok = false;
        const dd = Math.hypot(f - x, cz - z);
        if (ok && dd < bd && findPath(x, z, f + sd * (PLAYER_R + 4.4), cz)) { bd = dd; best = [b, sd]; }
      }
    }
    if (!best) throw new Error("no free 1.25 m stack");
    return best;
  };
  /** Run up to a 1.25 m stack and crouch-jump onto it, stand on it, step back off. */
  function* ontoStack(c: Client): Gen {
    const [b, side] = stackNear(c.body.x, c.body.z);
    const face = side < 0 ? b.x0 : b.x1, cz = (b.z0 + b.z1) / 2;
    yield* path(c, face + side * (PLAYER_R + 4.4), cz);
    yield* idle(0.3);
    let jumped = false, air = 0;
    for (let i = 0; i < 120; i++) {
      const go = !jumped && Math.abs(c.body.x - face) - PLAYER_R < 1.3;
      if (go) jumped = true;
      if (jumped && !c.body.onGround) air += DT;
      yield inp({ mx: -side, mz: 0, jump: go, crouch: jumped && air > 0.03 && !(c.body.onGround && air > 0.1) });
      if (jumped && c.body.onGround && Math.abs(c.body.y - b.y1) < 0.01) break;
    }
    if (Math.abs(c.body.y - b.y1) > 0.01) throw new Error("the crouch-jump did not land on the stack");
    yield* idle(0.4);
    yield* idle(0.5, { mx: side, mz: 0 }); // and down again
    yield* idle(0.4);
  }
  /** Get on a forklift (whichever seat is free), ride `secs` throwing every 0.4 s, get off. */
  function* ride(c: Client, secs: number, throwing: boolean): Gen {
    c.send({ t: "use" });
    for (let i = 0; i < 60 && c.veh < 0; i++) yield inp({});
    if (c.veh < 0) throw new Error("could not get on the forklift");
    for (let i = 0; i < secs * TICK_HZ; i++) { if (throwing && i % 24 === 12) c.shoot(); yield inp({}); }
    c.send({ t: "use" });
    for (let i = 0; i < 60 && c.veh >= 0; i++) yield inp({});
    yield* idle(0.3);
  }

  /** Play a script (one generator per client) for at most `secs` with the network of `net`; returns the corrections. */
  const play = (sim: Sim, cs: Client[], scripts: Gen[], secs: number, drive?: (c: Client, i: number) => [number, number] | undefined) => {
    const done = cs.map(() => false);
    let t = 0;
    for (; t < secs * TICK_HZ && done.some((d) => !d); t++) {
      cs.forEach((c, k) => {
        let m = NONE;
        if (!done[k]) { const r = scripts[k].next(); if (r.done) done[k] = true; else m = r.value; }
        c.frame(m, drive?.(c, t));
      });
      for (const c of cs) c.deliver();
      sim.step(DT);
      const evs = sim.drainEvents();
      for (const c of cs) c.after(evs as { k: string; id?: number }[], t);
    }
    return t / TICK_HZ;
  };

  // (f) running throws: whatever the client claims and however it chops its states up, the host sees it run. 20 rifle
  // first throws (1 s apart) while circling at 4.2 m/s claiming "spd 0": at 30 Hz, chopped into 8 states a tick, and
  // with the last state before each throw held still (one state's worth: as long as a stop takes, at most); against
  // the same throws standing, running honestly, and after an honest counter-strafe
  {
    useLayout(0);
    const { sim, ids: [a], P } = room(0, [0]);
    const pa = P(a);
    const [cx, cz] = openDisc(4);
    const R = 4, V = 4.2;
    let ang = 0;
    const at = (q: number): [number, number] => [cx + Math.cos(q) * R, cz + Math.sin(q) * R];
    [pa.body.x, pa.body.z] = at(0); pa.body.y = 0;
    for (let i = 0; i < 30; i++) sim.step(DT);
    const throws = (mode: "still" | "30" | "240" | "hold", claimSpd: boolean) => {
      let sum = 0, n = 0, tick = 0;
      for (let s = 0; s < 20; s++) {
        for (let i = 0; i < TICK_HZ; i++, tick++) {
          const parts = mode === "240" ? 8 : tick % 2 === 0 ? 1 : 0;
          for (let k = 0; k < parts; k++) {
            if (mode !== "still") ang += (V / R) * DT * (mode === "240" ? 1 / 8 : 2);
            const hold = mode === "hold" && i >= TICK_HZ - 2;
            const [x, z] = at(hold ? ang - (V / R) * DT * 2 : ang);
            sim.receive(a, { t: "state", x, y: 0, z, yaw: 0, pitch: 0, moving: mode !== "still", spawn: pa.spawn });
          }
          sim.step(DT);
        }
        sim.coneOf(a); // settles the aim
        const yaw = 0.3, py = pa.aim.py, pp = pa.aim.pp;
        sim.receive(a, { t: "shoot", w: "rifle", yaw, pitch: 0, view: sim.time, spd: claimSpd ? (mode === "still" ? 0 : V) : 0, air: false });
        for (const e of sim.drainEvents()) if (e.k === "shot" && e.id === a) { sum += devOf(e.dirs, yaw + py, pp); n++; }
      }
      return n ? sum / n : NaN;
    };
    const still = throws("still", true), honest = throws("30", true), lie30 = throws("30", false), lie240 = throws("240", false), hold = throws("hold", false);
    // the honest counter-strafe, with the client model: 20 throws right as the body stops
    const c = new Client(sim, a, { lat: 0.04, jit: 0.02, rand: Math.random });
    let sum = 0, n = 0, dir = 1;
    const gen = (function* (): Gen { for (let k = 0; k < 20; k++) { yield* idle(0.3); yield* counter(c, dir, 0, 0.45); dir = -dir; yield* idle(0.7); } })();
    for (let t = 0; t < TICK_HZ * 40; t++) {
      const r = gen.next(); if (r.done) break;
      c.frame(r.value); c.deliver(); sim.coneOf(a);
      const py = pa.aim.py, pp = pa.aim.pp;
      sim.step(DT);
      const evs = sim.drainEvents();
      for (const e of evs) if (e.k === "shot" && e.id === a) { sum += devOf(e.dirs, py, pp); n++; }
      c.after(evs as { k: string; id?: number }[], t);
    }
    const cs = n ? sum / n : NaN;
    console.log(`host speed for throws (mean deviation, mrad): standing ${mr(still)}, running honestly ${mr(honest)}, after a counter-strafe ${mr(cs)} (${n} throws, ${c.corrections} corrections); claiming "standing" while running: at 30 Hz ${mr(lie30)}, chopped into 240 Hz ${mr(lie240)}, one state held back ${mr(hold)}`);
    if (!(lie30 > honest * 0.5 && lie240 > honest * 0.5)) fail("a runner's throws are as good as standing, by claiming it or by chopping its states");
    if (!(hold > still * 1.5)) fail("holding one state back makes a runner throw like a stander");
    if (!(cs < still * 1.4) || n < 18 || c.corrections) fail("an honest counter-strafe is not as accurate as standing");
  }

  // (g) the forklift's thrower: never "in the air", no stale crouch from boarding (host and snapshot), throws as
  // accurate as on foot while the forklift stands
  {
    useLayout(0);
    const { sim, ids: [d, g], P } = room(0, [0, 0]);
    const veh = (sim as unknown as { forklifts: { st: VehicleState }[] }).forklifts[0].st;
    for (const id of [d, g]) { const b = P(id).body; b.x = veh.x; b.z = veh.z + 1.8; b.y = 0; }
    const pg = P(g);
    sim.receive(g, { t: "state", x: pg.body.x, y: 0, z: pg.body.z, yaw: 0, pitch: 0, moving: false, spawn: pg.spawn, crouch: true });
    sim.step(DT);
    const crouchedBefore = !!pg.body.crouch;
    sim.receive(d, { t: "use" }); sim.receive(g, { t: "use" });
    for (let i = 0; i < 30; i++) { sim.receive(g, { t: "state", x: pg.body.x, y: pg.body.y, z: pg.body.z, yaw: 0, pitch: 0, moving: false, spawn: pg.spawn, crouch: false }); sim.step(DT); }
    const snap = sim.snapshot(d);
    const snapCrouch = snap && snap.t === "snap" ? snap.players.find((p) => p.id === g)!.crouch : true;
    let sum = 0, n = 0;
    for (let s = 0; s < 20; s++) {
      for (let i = 0; i < TICK_HZ; i++) sim.step(DT);
      sim.coneOf(g);
      const py = pg.aim.py, pp = pg.aim.pp;
      sim.receive(g, { t: "shoot", w: "rifle", yaw: 1, pitch: 0, view: sim.time, spd: 0, air: false });
      for (const e of sim.drainEvents()) if (e.k === "shot" && e.id === g) { sum += devOf(e.dirs, 1 + py, pp); n++; }
    }
    const dev = n ? sum / n : NaN;
    console.log(`forklift thrower: seat ${pg.veh}/${pg.seat}, crouched before boarding ${crouchedBefore}, after: host ${!!pg.body.crouch}, snapshot ${snapCrouch}; standing throws ${mr(dev)} mrad (${n})`);
    if (!crouchedBefore || pg.veh !== 0 || pg.seat !== 1 || pg.body.crouch || snapCrouch || !(dev < 0.006) || n < 20) fail("the forklift's thrower: air spread or a stale crouch");
  }

  // (h) the stance and the launcher set the speed limit: a "crouched" client at 6.2 m/s, a Dalekomiot carrier at 5.5
  // m/s (under the old limit for all, 6.3) are sent back; an honest crouch-walk, a crouch from a run, a crouch-jump are not
  {
    useLayout(0);
    const [cx, cz] = openDisc(4);
    const lie = (crouch: boolean, w: WeaponId, v: number) => {
      const { sim, ids: [a], P } = room(0, [0]);
      const pa = P(a);
      if (w !== "rifle") { sim.receive(a, { t: "buy", item: w }); sim.receive(a, { t: "switch", w }); }
      pa.body.x = cx + 4; pa.body.z = cz; pa.body.y = 0;
      for (let i = 0; i < 30; i++) sim.step(DT);
      const sp0 = pa.spawn;
      let ang = 0;
      for (let i = 0; i < 90; i++) {
        ang += v / 4 / 30;
        sim.receive(a, { t: "state", x: cx + Math.cos(ang) * 4, y: 0, z: cz + Math.sin(ang) * 4, yaw: 0, pitch: 0, moving: true, spawn: pa.spawn, crouch });
        sim.step(DT); sim.step(DT);
      }
      return pa.spawn - sp0;
    };
    const crouchRun = lie(true, "rifle", 6.2), sniperRun = lie(false, "sniper", 5.5), rifleRun = lie(false, "rifle", maxSpeed("rifle"));
    const { sim, ids: [a], P } = room(0, [0]);
    const pa = P(a); pa.body.x = cx - 3; pa.body.z = cz; pa.body.y = 0;
    for (let i = 0; i < 30; i++) sim.step(DT);
    const c = new Client(sim, a);
    play(sim, [c], [(function* (): Gen {
      yield* idle(1.2, { mx: 1, mz: 0, crouch: true });              // a crouch-walk
      yield* idle(0.8, { mx: -1, mz: 0 });                           // run
      yield* idle(1.2, { mx: -1, mz: 0, crouch: true });             // crouch from the run
      yield* idle(0.6, { mx: 1, mz: 0 });
      yield* hops(c, 2, true);                                       // crouch-jumps from a run-up
      for (let k = 0; k < 6; k++) yield* idle(0.1, { mx: k % 2 ? 1 : -1, mz: 0, crouch: k % 2 === 0 }); // crouch spam
    })()], 10);
    console.log(`stance speed: crouched at 6.2 m/s corrected ${crouchRun}x, Dalekomiot at 5.5 m/s ${sniperRun}x, Kartonomiot at its speed ${rifleRun}x; honest crouch-walk, crouch from a run, crouch-jumps, crouch spam: ${c.corrections} corrections`);
    if (!crouchRun || !sniperRun || rifleRun || c.corrections) fail("the speed limit of the stance and the launcher");
  }

  // (i) Sortownia's deck under the control room's roof: plain jumps and crouch-jumps on the deck (the head hits the
  // roof) are never corrected
  {
    useLayout(4);
    const { sim, ids: [a], P } = room(4, [1]);
    const pa = P(a); pa.body.x = -10; pa.body.y = 2.7; pa.body.z = -19.5;
    (sim as unknown as { resetMove(p: unknown): void }).resetMove(pa);
    for (let i = 0; i < 30; i++) sim.step(DT);
    const c = new Client(sim, a);
    play(sim, [c], [(function* (): Gen { yield* hops(c, 4, false); yield* hops(c, 3, true); yield* walk(c, -6, -19.5); yield* hops(c, 2, false); })()], 15);
    console.log(`Sortownia deck: 9 jumps under the 5.3 m roof, ${c.corrections} corrections (y ${c.body.y.toFixed(2)})`);
    if (c.corrections || Math.abs(c.body.y - 2.7) > 0.01) fail("jumping on Sortownia's deck is corrected");
  }

  // (j) gravity: a staircase of states up a 4.6 m rack and a hover at 1.2 m are sent back; the stairs to the deck, a
  // walk off its edge, a ladder to a perch, the crouch-jump onto a stack, standing and jumping on a forklift's roof
  // as it drives off are not
  {
    useLayout(4);
    const { sim, ids: [a], P } = room(4, [1]);
    const pa = P(a);
    const rack = BOXES.find((b) => b.kind === "rack" && b.y1 > 4.5)!;
    const rz = rack.z1 + PLAYER_R + 0.05, rx = (rack.x0 + rack.x1) / 2;
    pa.body.x = rx; pa.body.y = 0; pa.body.z = rz + 0.5;
    for (let i = 0; i < 30; i++) sim.step(DT);
    let sp0 = pa.spawn;
    for (const [y, z] of [[0, rz], [1.2, rz], [2.4, rz], [3.6, rz], [4.6, rz], [rack.y1, rack.z1 - 0.5], [rack.y1, rack.z1 - 0.8]]) {
      sim.receive(a, { t: "state", x: rx, y, z, yaw: 0, pitch: 0, moving: false, spawn: pa.spawn });
      for (let i = 0; i < 2; i++) sim.step(DT);
    }
    const climb = pa.spawn - sp0, climbY = pa.body.y;
    pa.body.x = -2; pa.body.y = 0; pa.body.z = 10;
    (sim as unknown as { resetMove(p: unknown): void }).resetMove(pa);
    for (let i = 0; i < 30; i++) sim.step(DT);
    sp0 = pa.spawn;
    for (let i = 0; i < 60; i++) {
      sim.receive(a, { t: "state", x: -2, y: Math.min(1.2, i * 0.2), z: 10 - i * 0.02, yaw: 0, pitch: 0, moving: false, spawn: pa.spawn });
      sim.step(DT); sim.step(DT);
    }
    const hover = pa.spawn - sp0;
    // the honest ways up and down
    const c = new Client(sim, a);
    play(sim, [c], [(function* (): Gen {
      yield* path(c, -12.8, -11.2);
      yield* walk(c, -12.8, -19.6);                      // up the stairs onto the deck
      yield* walk(c, -15, -19.6);
      yield* walk(c, -15, -12.6);                        // over the switch cabinet's edge: 2.7 m down
    })()], 25);
    const deckOk = c.corrections;
    useLayout(0);
    const h0 = room(0, [0]);
    const l = LADDERS[0];
    const p0 = h0.P(h0.ids[0]); p0.body.x = (l.x0 + l.x1) / 2; p0.body.z = (l.z0 + l.z1) / 2; p0.body.y = 0;
    (h0.sim as unknown as { resetMove(p: unknown): void }).resetMove(p0);
    for (let i = 0; i < 30; i++) h0.sim.step(DT);
    const c0 = new Client(h0.sim, h0.ids[0]);
    let perchY = 0;
    play(h0.sim, [c0], [(function* (): Gen { yield* idle(6, { mx: l.dx, mz: 0 }); perchY = c0.body.y; yield* ontoStackFrom(c0); })()], 30);
    // standing (and jumping) on the roof of a forklift that drives off under us, then the fall
    const h1 = room(0, [0, 0]);
    const [dr, ro] = h1.ids;
    const fst = (h1.sim as unknown as { forklifts: { st: VehicleState; rev: number }[] }).forklifts[0];
    const pd = h1.P(dr); pd.body.x = fst.st.x; pd.body.z = fst.st.z + 1.8;
    h1.sim.receive(dr, { t: "use" });
    const pr = h1.P(ro); pr.body.x = fst.st.x; pr.body.y = 2.3; pr.body.z = fst.st.z;
    (h1.sim as unknown as { resetMove(p: unknown): void }).resetMove(pr);
    h1.sim.step(DT);
    const cr = new Client(h1.sim, ro);
    const drv = { ...fst.st };
    let roofT = 0;
    play(h1.sim, [cr], [(function* (): Gen {
      yield* idle(0.5); yield* hops(cr, 1, false);
      for (let i = 0; i < 150; i++) {
        stepVehicle(drv, 1, 0, DT);
        if (i % 2 === 0) h1.sim.receive(dr, { t: "drive", x: drv.x, z: drv.z, yaw: drv.yaw, speed: drv.speed, rev: fst.rev });
        if (cr.body.y > 2.2) roofT += DT;
        yield inp({});
      }
    })()], 6);
    console.log(`gravity: a staircase of states up a ${rack.y1} m rack corrected ${climb}x (host y ${climbY.toFixed(2)}), a hover at 1.2 m ${hover}x; honest: stairs to the deck and off its edge ${deckOk}, a ladder to a perch and a crouch-jump onto a stack ${c0.corrections} (perch y ${perchY.toFixed(2)}), on a forklift's roof as it drives off (${roofT.toFixed(2)} s on it, then y ${cr.body.y.toFixed(2)}) ${cr.corrections} corrections`);
    if (!climb || climbY > 2 || !hover || deckOk || c0.corrections || Math.abs(perchY - l.top) > 0.01 || cr.corrections || roofT < 0.3 || cr.body.y > 0.01) fail("gravity on the host");
  }
  function* ontoStackFrom(c: Client): Gen {
    // down from the perch the way it came (the ladder), then over to a stack
    const l = LADDERS[0];
    yield* idle(0.5, { mx: -l.dx, mz: 0 });
    yield* idle(2.5, { mx: -l.dx, mz: 0 });
    yield* ontoStack(c);
  }

  // (k) a whole honest minute on Sortownia and on Zajezdnia, with 40 ms latency, 25 ms jitter and two 300 ms lag bursts
  // each way: walking, running, counter-strafes with throws, the crouch-jump onto a stack, the stairs, jumps on the
  // deck (Sortownia: under the roof), a ride as the forklift's thrower (throwing) with a teammate driving. No corrections
  for (const [layout, plan] of [[4, "sort"], [3, "depot"]] as const) {
    useLayout(layout);
    const { sim, ids: [g, d] } = room(layout, [1, 1], 5);
    let rnd = 1;
    const rand = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
    const cg = new Client(sim, g, { lat: 0.04, jit: 0.025, rand }), cd = new Client(sim, d, { lat: 0.05, jit: 0.02, rand });
    for (const c of [cg, cd]) c.stalls = [[sim.time + 9, sim.time + 9.3], [sim.time + 27, sim.time + 27.3]];
    const fk = (sim as unknown as { forklifts: { st: VehicleState }[] }).forklifts[0].st;
    const marks: string[] = [], t0 = sim.time;
    const mark = (what: string) => marks.push(`${what} ${(sim.time - t0).toFixed(0)} s`);
    const side = (o: number): [number, number] => [fk.x + o * 0.4, fk.z + 1.9];
    const gScript = (function* (): Gen {
      // to the forklift: the driver gets on first, we take the platform and throw for 6 s
      yield* path(cg, ...side(-1));
      while (cd.veh < 0) yield inp({});
      yield* ride(cg, 4, true); mark("ride");
      if (plan === "sort") { yield* counter(cg, 1, 0, 0.5); yield* counter(cg, -1, 0, 0.5); }
      yield* idle(0.8, { mx: 0, mz: -1, walk: true });
      if (plan === "sort") {
        yield* path(cg, -12.8, -11.2);
        yield* walk(cg, -12.8, -19.6);                   // the west stairs up to the deck
        yield* walk(cg, -10, -19.5);
        mark("deck"); yield* hops(cg, 3, false); yield* hops(cg, 2, true); mark("hops"); // jumps under the roof
        yield* counter(cg, 1, 0, 0.4);
        yield* walk(cg, 2.8, -19.5); yield* walk(cg, 2.8, -11.4); // along the deck, down the east stairs
      } else {
        yield* path(cg, -45.5, -32.4);
        yield* walk(cg, -45.5, -40.6);                   // the east stairs up to the mezzanine
        yield* walk(cg, -60, -41); mark("deck"); yield* hops(cg, 3, false); yield* hops(cg, 2, true); mark("hops");
        yield* counter(cg, -1, 0, 0.4);
        yield* walk(cg, -60, -36);                       // off its edge, 2.7 m down
      }
      yield* ontoStack(cg); mark("stack");
      yield* counter(cg, 0, 1, 0.5);
      for (;;) yield* idle(0.5, { mx: 0.6, mz: 0.8, crouch: false }), yield* counter(cg, -0.6, -0.8, 0.4);
    })();
    let driving = 0;
    const dScript = (function* (): Gen {
      yield* path(cd, ...side(1));
      cd.send({ t: "use" });
      for (let i = 0; i < 60 && cd.veh < 0; i++) yield inp({});
      // wait for the thrower, drive 5 s (forward, stop, back), get off once the thrower has
      while (cg.veh < 0) yield inp({});
      driving = 1; yield* idle(1.2); driving = -1; yield* idle(1); driving = -0.6; yield* idle(1); driving = 0; yield* idle(2);
      while (cg.veh >= 0) yield inp({});
      cd.send({ t: "use" });
      yield* idle(1);
      for (;;) yield* idle(1);
    })();
    let secs = 0;
    try {
      secs = play(sim, [cg, cd], [gScript, dScript], 60, (c) => (c === cd ? [driving, 0] : undefined));
    } catch (e) { fail(`honest minute on ${LAYOUTS[layout].name}: ${(e as Error).message}`); }
    console.log(`honest minute on ${LAYOUTS[layout].name}: ${secs.toFixed(1)} s (${marks.join(", ")}), ${cg.shots} throws, thrower ${cg.corrections} corrections, driver ${cd.corrections}`);
    if (cg.corrections || cd.corrections || secs < 59 || marks.length < 4) fail(`honest play on ${LAYOUTS[layout].name} is corrected`);
  }
}

console.log(bad ? `${bad} check(s) failed` : "all checks passed");
process.exit(bad ? 1 : 0);
