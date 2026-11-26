// Floor navigation for bots: a 0.5 m occupancy grid over the hall, A* with 8-way moves and string-pulling so paths
// cut corners instead of zig-zagging cell to cell.

import { BOXES, HALL } from "./map";

export const CELL = 0.5;
const CLEAR = 0.5; // how far a bot keeps its centre from any obstacle
export const GW = Math.round((HALL.x1 - HALL.x0) / CELL);
export const GH = Math.round((HALL.z1 - HALL.z0) / CELL);
const solid = new Uint8Array(GW * GH);

for (let j = 0; j < GH; j++) {
  for (let i = 0; i < GW; i++) {
    const x = HALL.x0 + (i + 0.5) * CELL, z = HALL.z0 + (j + 0.5) * CELL;
    let s = x - HALL.x0 < CLEAR || HALL.x1 - x < CLEAR || z - HALL.z0 < CLEAR || HALL.z1 - z < CLEAR ? 1 : 0;
    if (!s) for (const b of BOXES) {
      if (b.y0 > 1.8) continue;
      if (x > b.x0 - CLEAR && x < b.x1 + CLEAR && z > b.z0 - CLEAR && z < b.z1 + CLEAR) { s = 1; break; }
    }
    solid[j * GW + i] = s;
  }
}

export const cellOf = (x: number, z: number): [number, number] => [
  Math.max(0, Math.min(GW - 1, Math.floor((x - HALL.x0) / CELL))),
  Math.max(0, Math.min(GH - 1, Math.floor((z - HALL.z0) / CELL))),
];
export const isFree = (i: number, j: number) => i >= 0 && j >= 0 && i < GW && j < GH && solid[j * GW + i] === 0;
export const freeAt = (x: number, z: number) => { const [i, j] = cellOf(x, z); return isFree(i, j); };
const centre = (i: number, j: number): [number, number] => [HALL.x0 + (i + 0.5) * CELL, HALL.z0 + (j + 0.5) * CELL];

/** True when a straight walk between two points crosses only free cells. */
export function walkable(ax: number, az: number, bx: number, bz: number): boolean {
  const d = Math.hypot(bx - ax, bz - az);
  const n = Math.ceil(d / (CELL * 0.5));
  for (let s = 0; s <= n; s++) {
    const t = n === 0 ? 0 : s / n;
    if (!freeAt(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
  }
  return true;
}

function nearestFree(i: number, j: number): [number, number] | null {
  if (isFree(i, j)) return [i, j];
  for (let r = 1; r < 8; r++) {
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      if (isFree(i + di, j + dj)) return [i + di, j + dj];
    }
  }
  return null;
}

const gScore = new Float32Array(GW * GH);
const came = new Int32Array(GW * GH);
const stamp = new Uint32Array(GW * GH);
const closedStamp = new Uint32Array(GW * GH);
let curStamp = 0;

// binary heap of [f, index]
const heapF: number[] = [], heapI: number[] = [];
function push(f: number, i: number) {
  let n = heapF.length; heapF.push(f); heapI.push(i);
  while (n > 0) { const p = (n - 1) >> 1; if (heapF[p] <= f) break; heapF[n] = heapF[p]; heapI[n] = heapI[p]; n = p; }
  heapF[n] = f; heapI[n] = i;
}
function pop(): number {
  const top = heapI[0];
  const lf = heapF.pop()!, li = heapI.pop()!;
  const len = heapF.length;
  if (len > 0) {
    let n = 0;
    for (;;) {
      const l = 2 * n + 1, r = l + 1;
      let m = n, mf = lf;
      if (l < len && heapF[l] < mf) { m = l; mf = heapF[l]; }
      if (r < len && heapF[r] < mf) { m = r; mf = heapF[r]; }
      if (m === n) break;
      heapF[n] = heapF[m]; heapI[n] = heapI[m]; n = m;
    }
    heapF[n] = lf; heapI[n] = li;
  }
  return top;
}

const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]] as const;

/** A smoothed path of world points from a to b (excluding a), or null when unreachable. */
export function findPath(ax: number, az: number, bx: number, bz: number): [number, number][] | null {
  if (walkable(ax, az, bx, bz)) return [[bx, bz]];
  const s = nearestFree(...cellOf(ax, az)), g = nearestFree(...cellOf(bx, bz));
  if (!s || !g) return null;
  curStamp++;
  heapF.length = 0; heapI.length = 0;
  const si = s[1] * GW + s[0], gi = g[1] * GW + g[0];
  stamp[si] = curStamp; gScore[si] = 0; came[si] = -1;
  push(0, si);
  let found = false, iters = 0;
  while (heapF.length && iters++ < 20000) {
    const cur = pop();
    if (cur === gi) { found = true; break; }
    if (closedStamp[cur] === curStamp) continue;
    closedStamp[cur] = curStamp;
    const ci = cur % GW, cj = (cur / GW) | 0;
    for (const [di, dj, c] of DIRS) {
      const ni = ci + di, nj = cj + dj;
      if (!isFree(ni, nj)) continue;
      if (di && dj && (!isFree(ci + di, cj) || !isFree(ci, cj + dj))) continue;
      const n = nj * GW + ni;
      const ng = gScore[cur] + c;
      if (stamp[n] === curStamp && ng >= gScore[n]) continue;
      stamp[n] = curStamp; gScore[n] = ng; came[n] = cur;
      const hx = Math.abs(ni - g[0]), hz = Math.abs(nj - g[1]);
      push(ng + Math.max(hx, hz) + 0.4142 * Math.min(hx, hz), n);
    }
  }
  if (!found) return null;
  const cells: [number, number][] = [];
  for (let c = gi; c !== -1; c = came[c]) cells.push(centre(c % GW, (c / GW) | 0));
  cells.reverse();
  cells[cells.length - 1] = [bx, bz];
  if (!freeAt(bx, bz)) cells[cells.length - 1] = centre(g[0], g[1]);
  // string-pull
  const out: [number, number][] = [];
  let px = ax, pz = az, k = 0;
  while (k < cells.length) {
    let far = k;
    for (let m = cells.length - 1; m > k; m--) if (walkable(px, pz, cells[m][0], cells[m][1])) { far = m; break; }
    out.push(cells[far]);
    [px, pz] = cells[far];
    k = far + 1;
  }
  return out;
}

/** A random free floor point (uniform over free cells). */
export function randomFree(rand: () => number): [number, number] {
  for (let tries = 0; tries < 200; tries++) {
    const i = Math.floor(rand() * GW), j = Math.floor(rand() * GH);
    if (isFree(i, j)) return centre(i, j);
  }
  return [0, 0];
}
