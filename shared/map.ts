// The efectivo warehouse: one hall of 240 × 130 m (31 200 m²) at real scale, declared as data. Every solid thing is
// an axis-aligned box (collision and thrown boxes use the same list on the client and the server); the client dresses
// each box up by its `kind` (client/world.ts). Units are metres, +Y up, +X east, +Z south. The hall floor is y = 0.
//
// Layout, west to east: high-bay racking (Kompletacja north, Surowiec south) where Grupa A starts, the packing floor
// and the hazardous-goods yard in the middle, then buffer racking and the staged pallets by the docks (Wysyłka) where
// Grupa B starts. One main aisle runs the whole length at z = 0.

export type BoxKind = "wall" | "rack" | "stack" | "table" | "column" | "drum" | "office" | "forklift" | "cage";

export interface Box {
  x0: number; y0: number; z0: number;
  x1: number; y1: number; z1: number;
  kind: BoxKind;
  /** Facing for forklifts (radians around Y); 0 = forks toward +X. */
  rot?: number;
  /** Top for thrown boxes when lower than y1 (a forklift stops boxes only up to its body). */
  shotY1?: number;
  /** A rack with a ladder and a deck on top: a sniper's perch. */
  climb?: boolean;
}

export interface Zone { name: string; color: string; x0: number; z0: number; x1: number; z1: number }

/** A ladder on the end of a climbable rack: stand in the zone and push toward the rack to climb. */
export interface Ladder {
  x0: number; x1: number; z0: number; z1: number;
  /** Height of the deck it reaches. */
  top: number;
  /** Unit direction from the ladder toward its rack along X (+1 or −1). */
  dx: number;
}

/** Inner extent of the hall; the walls sit just outside it. */
export const HALL = { x0: -120, x1: 120, z0: -65, z1: 65, h: 13 } as const;

/** Ordinary racks: too tall to reach or to jump onto. */
export const RACK_H = 9;
/** Climbable racks are a level lower, with a deck on top. */
export const PERCH_H = 7.2;
const RACK_DEPTH = 2.4;

const boxes: Box[] = [];
const ladders: Ladder[] = [];
const add = (kind: BoxKind, cx: number, cz: number, sx: number, sz: number, h: number, y0 = 0) => {
  boxes.push({ kind, x0: cx - sx / 2, x1: cx + sx / 2, z0: cz - sz / 2, z1: cz + sz / 2, y0, y1: y0 + h });
};

// walls (1 m thick, outside the playable floor)
const W = 1, WH = HALL.h + 1;
boxes.push({ kind: "wall", x0: HALL.x0 - W, x1: HALL.x0, y0: 0, y1: WH, z0: HALL.z0 - W, z1: HALL.z1 + W });
boxes.push({ kind: "wall", x0: HALL.x1, x1: HALL.x1 + W, y0: 0, y1: WH, z0: HALL.z0 - W, z1: HALL.z1 + W });
boxes.push({ kind: "wall", x0: HALL.x0, x1: HALL.x1, y0: 0, y1: WH, z0: HALL.z0 - W, z1: HALL.z0 });
boxes.push({ kind: "wall", x0: HALL.x0, x1: HALL.x1, y0: 0, y1: WH, z0: HALL.z1, z1: HALL.z1 + W });

/** A double (back-to-back) rack from x0 to x1 centred on zc; `ladderEnd` (±1) makes it a perch with a ladder there. */
function rack(x0: number, x1: number, zc: number, ladderEnd = 0) {
  const climb = ladderEnd !== 0;
  boxes.push({ kind: "rack", x0, x1, z0: zc - RACK_DEPTH / 2, z1: zc + RACK_DEPTH / 2, y0: 0, y1: climb ? PERCH_H : RACK_H, climb: climb || undefined });
  if (ladderEnd > 0) ladders.push({ x0: x1, x1: x1 + 0.9, z0: zc - 0.6, z1: zc + 0.6, top: PERCH_H, dx: -1 });
  if (ladderEnd < 0) ladders.push({ x0: x0 - 0.9, x1: x0, z0: zc - 0.6, z1: zc + 0.6, top: PERCH_H, dx: 1 });
}

// west racking: 8 rows on each side of the main aisle, three segments each, cross aisles at x = −86 and −56.
// Four of the 48 are perches: the ends that look out over the packing floor, and one deeper in on each side.
const WEST_ROWS = [11.5, 18, 24.5, 31, 37.5, 44, 50.5, 57];
for (const s of [-1, 1]) {
  for (const z of WEST_ROWS) {
    rack(-114, -88, s * z);
    rack(-84, -58, s * z, z === 37.5 ? 1 : 0);
    rack(-54, -32, s * z, z === 11.5 ? 1 : 0);
  }
}

// east buffer racking in front of the docks: 3 rows a side, two segments, cross aisle at x = 68. Four perches.
for (const s of [-1, 1]) {
  for (const z of [18, 31, 44]) {
    rack(40, 66, s * z, z === 44 ? -1 : 0);
    rack(70, 92, s * z, z === 18 ? -1 : 0);
  }
}

// steel columns where no racking carries the roof
for (const x of [-24, 0, 24, 96]) for (const z of [-29, 0, 29]) {
  if (x === 96 && z === 0) continue;
  add("column", x, z, 0.6, 0.6, HALL.h);
}

// packing floor (centre north): rows of packing tables, pallets waiting between them, a returns cage
for (const x of [-20, -10, 0, 10, 20, 30]) for (const z of [-54, -44, -34, -24]) add("table", x, z, 2.4, 1.2, 0.95);
const H = [1.25, 2.5, 1.25, 3.75, 2.5, 1.25, 2.5];
let hi = 0;
for (const [x, z] of [[-15, -14], [-5, -15], [6, -13.5], [16, -15], [27, -14], [-15, -39], [5, -49], [25, -39], [-25, -60], [15, -61]]) {
  add("stack", x, z, 1.4, 1.2, H[hi++ % H.length]);
}
add("cage", 33, -61.5, 5, 1.6, 2.2);

// main aisle: a few pallets left in the way, good cover on the long run
for (const [x, z] of [[-100, -3], [-70, 3.5], [-44, -3.5], [-12, 3], [12, -3.2], [34, 3.4], [58, -3], [84, 3.2], [104, -2.5]]) {
  add("stack", x, z, 1.4, 1.2, H[hi++ % H.length]);
}

// hazardous goods (centre south): drum clusters, the shift office beside them
for (const [cx, cz, nx, nz] of [[-20, 36, 2, 2], [-10, 44, 3, 2], [-21, 52, 2, 1], [-4, 34, 1, 2], [-14, 58, 3, 2], [-3, 52, 2, 2]] as const) {
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) add("drum", cx + (i - (nx - 1) / 2) * 0.66, cz + (j - (nz - 1) / 2) * 0.66, 0.6, 0.6, 0.95);
}
add("office", 20, 55, 16, 18, 3.2);
for (const [x, z] of [[-18, 14], [-6, 20], [6, 13], [18, 21], [30, 14], [8, 30], [26, 34]]) add("stack", x, z, 2.4, 2.0, H[hi++ % H.length]);

// shipping (east): pallets staged in two lines in front of the docks
for (const x of [100, 108]) {
  for (let z = -56; z <= 56; z += 8) {
    if (Math.abs(z) < 7) continue; // the dock lane stays open
    add("stack", x, z, 2.4, 2.0, H[hi++ % H.length]);
  }
}

/** Every solid box in the hall. */
export const BOXES: readonly Box[] = boxes;

/** The ladders of the climbable racks. */
export const LADDERS: readonly Ladder[] = ladders;

/** Floor zones, coloured like the efectivo Live map. Visual only. */
export const ZONES: readonly Zone[] = [
  { name: "KOMPLETACJA", color: "#8B5CF6", x0: -120, z0: -65, x1: -30, z1: -7.5 },
  { name: "SUROWIEC", color: "#10B981", x0: -120, z0: 7.5, x1: -30, z1: 65 },
  { name: "PAKOWANIE", color: "#3B82F6", x0: -27, z0: -65, x1: 36, z1: -8 },
  { name: "STREFA NIEBEZPIECZNA", color: "#EF4444", x0: -25, z0: 31, x1: 1, z1: 65 },
  { name: "WYSYŁKA", color: "#6366F1", x0: 38, z0: -65, x1: 120, z1: 65 },
];

/** Where players come back in: the west points are Grupa A's, the east points Grupa B's. */
export const SPAWNS: readonly (readonly [number, number])[] = [
  [-117, -50], [-117, -30], [-117, -10], [-117, 10], [-117, 30], [-117, 50], [-86, -8.6], [-86, 8.6], [-56, -8.6], [-56, 8.6],
  [116, -52], [116, -28], [116, -12], [116, 12], [116, 28], [116, 52], [95, -8.6], [95, 8.6], [68, -8.6], [68, 8.6],
];

export type PickupKind = "med" | "ammo" | "shotgun" | "geo";
export interface PickupSpot { kind: PickupKind; x: number; z: number }

export const PICKUPS: readonly PickupSpot[] = [
  { kind: "med", x: -100, z: 3 }, { kind: "med", x: -29, z: -20 }, { kind: "med", x: -29, z: 20 }, { kind: "med", x: 5, z: -62 },
  { kind: "med", x: 36, z: -20 }, { kind: "med", x: 36, z: 24 }, { kind: "med", x: 96, z: 4 }, { kind: "med", x: -86, z: 40.75 },
  { kind: "ammo", x: -117, z: 0 }, { kind: "ammo", x: -56, z: -3 }, { kind: "ammo", x: -28, z: 0 }, { kind: "ammo", x: 5, z: -39 },
  { kind: "ammo", x: 4, z: 24 }, { kind: "ammo", x: 37, z: 0 }, { kind: "ammo", x: 68, z: 3 }, { kind: "ammo", x: 116, z: 0 },
  { kind: "shotgun", x: -86, z: -34.25 }, { kind: "shotgun", x: -86, z: 34.25 }, { kind: "shotgun", x: -5, z: -29 },
  { kind: "shotgun", x: 12, z: 38 }, { kind: "shotgun", x: 68, z: -24.5 }, { kind: "shotgun", x: 68, z: 24.5 },
  { kind: "geo", x: 3, z: 3 }, { kind: "geo", x: -70, z: -2 }, { kind: "geo", x: 78, z: -2 },
];

/** Where the drivable forklifts stand at the start of a shift: three toward each group's side. */
export const VEHICLE_SPAWNS: readonly { x: number; z: number; yaw: number }[] = [
  { x: -108, z: 3.5, yaw: 0 }, { x: -78, z: -3.5, yaw: 0 }, { x: -36, z: 4, yaw: 0 },
  { x: 46, z: -4, yaw: Math.PI }, { x: 76, z: 3.5, yaw: Math.PI }, { x: 113, z: -18, yaw: Math.PI / 2 },
];

/** UWB anchors (the efectivo positioning network): along the walls and on the columns. Visual only. */
export const ANCHORS: readonly (readonly [number, number])[] = (() => {
  const a: [number, number][] = [];
  for (let x = -100; x <= 100; x += 40) { a.push([x, HALL.z0 + 0.4]); a.push([x, HALL.z1 - 0.4]); }
  for (const z of [-40, 0, 40]) { a.push([HALL.x0 + 0.4, z]); a.push([HALL.x1 - 0.4, z]); }
  for (const x of [-24, 0, 24]) for (const z of [-29, 0, 29]) a.push([x, z]);
  return a;
})();

/** Dock doors on the east wall (z centre). Visual only. */
export const DOCKS: readonly number[] = [-52, -39, -26, -13, 0, 13, 26, 39, 52];
