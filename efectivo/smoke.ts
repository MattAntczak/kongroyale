// Headless check for efectivo ARENA: every spawn and pickup stands on free, reachable floor, and a bot-only match
// produces kills. Run with `npm run efectivo:smoke`.

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
let kills = 0, shots = 0;
const t0 = performance.now();
for (let i = 0; i < TICK_HZ * 180; i++) {
  sim.step(1 / TICK_HZ);
  for (const e of sim.drainEvents()) { if (e.k === "kill") kills++; if (e.k === "shot") shots++; }
}
const ms = performance.now() - t0;
const snap = sim.snapshot(1);
console.log(`180 s bot match: ${kills} kills, ${shots} shots, ${(ms / (TICK_HZ * 180) * 1000).toFixed(0)} µs per tick`);
if (snap && snap.t === "snap") console.log(snap.players.map((p) => `${p.n} ${p.k}/${p.d}`).join(", "));
if (kills < 5) { console.log("too few kills: bots are not fighting"); bad++; }
process.exit(bad ? 1 : 0);
