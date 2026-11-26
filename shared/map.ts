// The efectivo warehouse: one hall, declared as data. Every solid thing is an axis-aligned box (collision and bullets
// use the same list on the client and the server); the client dresses each box up by its `kind` (client/world.ts).
// Units are metres, +Y up, +X east, +Z south. The hall floor is y = 0.

export type BoxKind = "wall" | "rack" | "stack" | "table" | "column" | "drum" | "office" | "forklift" | "cage";

export interface Box {
  x0: number; y0: number; z0: number;
  x1: number; y1: number; z1: number;
  kind: BoxKind;
  /** Facing for forklifts (radians around Y); 0 = forks toward +X. */
  rot?: number;
}

export interface Zone { name: string; color: string; x0: number; z0: number; x1: number; z1: number }

/** Inner extent of the hall; the walls sit just outside it. */
export const HALL = { x0: -40, x1: 40, z0: -25, z1: 25, h: 11 } as const;

const boxes: Box[] = [];
const add = (kind: BoxKind, cx: number, cz: number, sx: number, sz: number, h: number, y0 = 0, rot?: number) => {
  boxes.push({ kind, x0: cx - sx / 2, x1: cx + sx / 2, z0: cz - sz / 2, z1: cz + sz / 2, y0, y1: y0 + h, rot });
};

// walls (1 m thick, outside the playable floor)
const W = 1, WH = HALL.h + 1;
boxes.push({ kind: "wall", x0: HALL.x0 - W, x1: HALL.x0, y0: 0, y1: WH, z0: HALL.z0 - W, z1: HALL.z1 + W });
boxes.push({ kind: "wall", x0: HALL.x1, x1: HALL.x1 + W, y0: 0, y1: WH, z0: HALL.z0 - W, z1: HALL.z1 + W });
boxes.push({ kind: "wall", x0: HALL.x0, x1: HALL.x1, y0: 0, y1: WH, z0: HALL.z0 - W, z1: HALL.z0 });
boxes.push({ kind: "wall", x0: HALL.x0, x1: HALL.x1, y0: 0, y1: WH, z0: HALL.z1, z1: HALL.z1 + W });

// high-bay racks, west half: double (back-to-back) rows running east-west, a cross aisle at x = -26
const RACK_DEPTH = 2.4, RACK_H = 7.2;
for (const zc of [-19.5, -13, -6.5, 6.5, 13, 19.5]) {
  add("rack", -32.25, zc, 9.5, RACK_DEPTH, RACK_H);
  add("rack", -19.25, zc, 10.5, RACK_DEPTH, RACK_H);
}

// steel columns
for (const [x, z] of [[-12, -16], [-12, 0], [-12, 16], [13, -16], [13, 0], [13, 16], [26, -16], [26, 16]] as const) {
  add("column", x, z, 0.6, 0.6, HALL.h);
}

// packing zone (centre north): packing tables and pallet stacks
for (const x of [-7, -1, 5]) for (const z of [-19, -13]) add("table", x, z, 2.4, 1.2, 0.95);
add("stack", -4, -8, 1.4, 1.2, 1.25);
add("stack", 2, -7.5, 1.2, 1.4, 1.25);
add("stack", 9, -21.5, 1.4, 1.4, 2.5);
add("stack", 10, -10, 1.4, 1.2, 2.5);
add("stack", -8.5, -23, 1.2, 1.2, 1.25);
add("cage", 3, -23.2, 4, 1.4, 2.2);

// main aisle: a forklift and a few pallets
add("forklift", -20, 1.2, 2.6, 1.3, 2.2, 0, 0);
add("stack", -31, -1.8, 1.4, 1.2, 1.25);
add("stack", -6, 2.5, 1.2, 1.2, 2.5);
add("stack", 4, -2.2, 1.4, 1.2, 1.25);

// hazardous goods (centre south): drum clusters
for (const [cx, cz, nx, nz] of [[-6, 12, 2, 2], [-1.5, 18, 3, 2], [-7, 21.5, 2, 1], [0.5, 10.5, 1, 2]] as const) {
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) add("drum", cx + (i - (nx - 1) / 2) * 0.66, cz + (j - (nz - 1) / 2) * 0.66, 0.6, 0.6, 0.95);
}
add("office", 8, 19.5, 8, 9, 3.2);

// shipping (east): staged pallet blocks in lanes, two forklifts
const H = [1.25, 2.5, 1.25, 3.75, 2.5, 1.25];
let hi = 0;
for (const x of [19.5, 25.5, 31.5]) {
  for (const z of [-19, -12, -5, 5, 12, 19]) {
    if (x === 25.5 && (z === -5 || z === 5)) continue; // leave the dock lane open
    add("stack", x, z, 2.4, 2.0, H[hi++ % H.length]);
  }
}
add("forklift", 23.5, 0.2, 2.6, 1.3, 2.2, 0, Math.PI);
add("forklift", 35.5, -8.5, 1.3, 2.6, 2.2, 0, Math.PI / 2);

/** Every solid box in the hall. */
export const BOXES: readonly Box[] = boxes;

/** Floor zones, coloured like the efectivo Live map. Visual only. */
export const ZONES: readonly Zone[] = [
  { name: "KOMPLETACJA", color: "#8B5CF6", x0: -40, z0: -25, x1: -12.8, z1: -4.8 },
  { name: "SUROWIEC", color: "#10B981", x0: -40, z0: 4.8, x1: -12.8, z1: 25 },
  { name: "PAKOWANIE", color: "#3B82F6", x0: -11, z0: -25, x1: 12, z1: -5 },
  { name: "STREFA NIEBEZPIECZNA", color: "#EF4444", x0: -9.5, z0: 8.5, x1: 2.5, z1: 25 },
  { name: "WYSYŁKA", color: "#6366F1", x0: 15, z0: -25, x1: 40, z1: 25 },
];

/** Where players come back in. */
export const SPAWNS: readonly (readonly [number, number])[] = [
  [-38.5, -22], [-38.5, 22], [-26, -16.2], [-26, 16.2], [-30, 3], [-16, 3.5], [-3, -16], [7, -10],
  [-3, 5.5], [8, 10], [17, -23], [17, 23], [37.5, -14], [37.5, 13], [28.5, -2.5], [22, 8.5],
];

export type PickupKind = "med" | "ammo" | "shotgun" | "geo";
export interface PickupSpot { kind: PickupKind; x: number; z: number }

export const PICKUPS: readonly PickupSpot[] = [
  { kind: "med", x: -26, z: 0 }, { kind: "med", x: 8, z: -16 }, { kind: "med", x: 37.5, z: 0 }, { kind: "med", x: -26, z: 22.8 },
  { kind: "ammo", x: -38.5, z: 0 }, { kind: "ammo", x: 0, z: -23 }, { kind: "ammo", x: 28.5, z: -8.5 }, { kind: "ammo", x: -11, z: 8 },
  { kind: "shotgun", x: -26, z: -22.8 }, { kind: "shotgun", x: 0, z: 13.5 }, { kind: "shotgun", x: 28.5, z: 15.5 },
  { kind: "geo", x: 0.5, z: 0 },
];

/** Ceiling-mounted UWB anchors (the efectivo positioning network). Visual only. */
export const ANCHORS: readonly (readonly [number, number])[] = [
  [-39.6, -24.6], [-39.6, 24.6], [39.6, -24.6], [39.6, 24.6], [-12, 0], [13, 0], [-12, -16], [13, 16], [26, -16], [26, 16],
];

/** Dock doors on the east wall (z centre). Visual only. */
export const DOCKS: readonly number[] = [-18, -9, 0, 9, 18];
