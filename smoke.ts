// Headless check for efectivo ARENA: every spawn and pickup stands on free, reachable floor; the groups are balanced
// and honour a player's choice; a bot match produces kills and never friendly fire. Run with `npm run smoke`.

import { PICKUPS, SPAWNS } from "./shared/map";
import { blocked } from "./shared/physics";
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
process.exit(bad ? 1 : 0);
