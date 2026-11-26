// The efectivo warehouse: one hall of 240 × 130 m (31 200 m²) at real scale, in three configurations so nobody
// learns it by heart. Every solid thing is an axis-aligned box (collision and thrown boxes use the same list on the
// client and the server); the client dresses each box up by its `kind` (client/world.ts). Units are metres, +Y up,
// +X east, +Z south. The hall floor is y = 0.
//
// The warehouse workers hold the west (racking); the efectivo technicians arrive through the docks in the east.
// A configuration also places the mission objects: the local server the technicians must reconnect, the charging
// stations that take deliveries of watch tags, and the delivery point at the docks where the tags arrive.
//
// One configuration is current at a time: `useLayout(i)` swaps what BOXES, LADDERS and the rest point at (the
// exports are live bindings). A host that runs several rooms calls it before it touches a room.

export type BoxKind = "wall" | "rack" | "stack" | "table" | "column" | "drum" | "office" | "forklift" | "cage" | "server" | "panel";

export interface Box {
  x0: number; y0: number; z0: number;
  x1: number; y1: number; z1: number;
  kind: BoxKind;
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

export type PickupKind = "med" | "ammo" | "shotgun" | "geo";
export interface PickupSpot { kind: PickupKind; x: number; z: number }
export interface Point { x: number; z: number }

export interface Layout {
  name: string;
  boxes: Box[]; ladders: Ladder[]; zones: Zone[];
  /** Where players come back in: west points are the workers', east points the technicians'. */
  spawns: [number, number][];
  pickups: PickupSpot[];
  vehicles: { x: number; z: number; yaw: number }[];
  /** The local server (mission "server"). Also a solid box in `boxes`. */
  server: Point;
  /** Charging stations that take watch tags (mission "tags"). */
  stations: Point[];
  /** Where the tags arrive, by the docks. */
  supply: Point[];
}

/** Inner extent of the hall; the walls sit just outside it. */
export const HALL = { x0: -120, x1: 120, z0: -65, z1: 65, h: 13 } as const;

/** Ordinary racks: too tall to reach or to jump onto. */
export const RACK_H = 9;
/** Climbable racks are a level lower, with a deck on top. */
export const PERCH_H = 7.2;
const RACK_DEPTH = 2.4;
const WEST_ROWS = [11.5, 18, 24.5, 31, 37.5, 44, 50.5, 57];
const STACK_H = [1.25, 2.5, 1.25, 3.75, 2.5, 1.25, 2.5];

interface Cfg {
  name: string;
  /** −1 mirrors the packing floor, the hazardous yard, the office and the mission objects north-south. */
  flip: 1 | -1;
  /** West racking: the segments of every row, and which ones are perches as [row z, segment index]. */
  westSegs: [number, number][];
  westPerch: [number, number][];
  /** A block of buffer racking in the middle of the hall instead of an open floor. */
  centerRacks: boolean;
  eastRows: number[];
  eastSegs: [number, number][];
  eastPerch: [number, number][];
  /** Pallets left in the main aisle. */
  aisle: [number, number][];
  server: [number, number];
  stations: [number, number][];
}

function build(cfg: Cfg): Layout {
  const boxes: Box[] = [];
  const ladders: Ladder[] = [];
  const f = cfg.flip;
  let hi = 0;
  const add = (kind: BoxKind, cx: number, cz: number, sx: number, sz: number, h: number) => {
    boxes.push({ kind, x0: cx - sx / 2, x1: cx + sx / 2, z0: cz - sz / 2, z1: cz + sz / 2, y0: 0, y1: h });
  };
  const stack = (x: number, z: number, big = false) => add("stack", x, z, big ? 2.4 : 1.4, big ? 2.0 : 1.2, STACK_H[hi++ % STACK_H.length]);
  /** A double rack from x0 to x1 centred on zc; `ladderEnd` (±1) makes it a perch with a ladder on that end. */
  const rack = (x0: number, x1: number, zc: number, ladderEnd: number) => {
    const climb = ladderEnd !== 0;
    boxes.push({ kind: "rack", x0, x1, z0: zc - RACK_DEPTH / 2, z1: zc + RACK_DEPTH / 2, y0: 0, y1: climb ? PERCH_H : RACK_H, climb: climb || undefined });
    if (ladderEnd > 0) ladders.push({ x0: x1, x1: x1 + 0.9, z0: zc - 0.6, z1: zc + 0.6, top: PERCH_H, dx: -1 });
    if (ladderEnd < 0) ladders.push({ x0: x0 - 0.9, x1: x0, z0: zc - 0.6, z1: zc + 0.6, top: PERCH_H, dx: 1 });
  };
  const isPerch = (list: [number, number][], z: number, seg: number) => list.some(([pz, ps]) => pz === z && ps === seg);

  // walls (1 m thick, outside the playable floor)
  const W = 1, WH = HALL.h + 1;
  boxes.push({ kind: "wall", x0: HALL.x0 - W, x1: HALL.x0, y0: 0, y1: WH, z0: HALL.z0 - W, z1: HALL.z1 + W });
  boxes.push({ kind: "wall", x0: HALL.x1, x1: HALL.x1 + W, y0: 0, y1: WH, z0: HALL.z0 - W, z1: HALL.z1 + W });
  boxes.push({ kind: "wall", x0: HALL.x0, x1: HALL.x1, y0: 0, y1: WH, z0: HALL.z0 - W, z1: HALL.z0 });
  boxes.push({ kind: "wall", x0: HALL.x0, x1: HALL.x1, y0: 0, y1: WH, z0: HALL.z1, z1: HALL.z1 + W });

  // west racking: 8 rows on each side of the main aisle. Perch ladders face east, toward the middle of the hall.
  for (const s of [-1, 1]) for (const z of WEST_ROWS) cfg.westSegs.forEach(([x0, x1], i) => rack(x0, x1, s * z, isPerch(cfg.westPerch, z, i) ? 1 : 0));
  // east buffer racking in front of the docks. Perch ladders face west.
  for (const s of [-1, 1]) for (const z of cfg.eastRows) cfg.eastSegs.forEach(([x0, x1], i) => rack(x0, x1, s * z, isPerch(cfg.eastPerch, z, i) ? -1 : 0));

  // the middle of the hall
  if (cfg.centerRacks) {
    // buffer racking: two rows a side, two segments, a perch on each side looking down the main aisle
    for (const s of [-1, 1]) for (const z of [20, 33]) {
      rack(-20, 6, s * z, 0);
      rack(10, 30, s * z, z === 20 ? -1 : 0);
    }
    for (const x of [-20, -10, 0, 10, 20, 30]) for (const z of [-54, -46]) add("table", x, f * z, 2.4, 1.2, 0.95);
    for (const [x, z] of [[-25, -60], [15, -61], [5, -50]]) stack(x, f * z);
    for (const [cx, cz, nx, nz] of [[-20, 48, 2, 2], [-10, 54, 3, 2], [-3, 60, 2, 2], [-14, 61, 3, 1]] as const) {
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) add("drum", cx + (i - (nx - 1) / 2) * 0.66, f * (cz + (j - (nz - 1) / 2) * 0.66), 0.6, 0.6, 0.95);
    }
    for (const z of [-29, 29]) add("column", 96, z, 0.6, 0.6, HALL.h);
  } else {
    // packing floor on one side: rows of packing tables, pallets waiting between them
    for (const x of [-20, -10, 0, 10, 20, 30]) for (const z of [-54, -44, -34, -24]) add("table", x, f * z, 2.4, 1.2, 0.95);
    for (const [x, z] of [[-15, -14], [-5, -15], [6, -13.5], [16, -15], [27, -14], [-15, -39], [5, -49], [25, -39], [-25, -60], [15, -61]]) stack(x, f * z);
    // hazardous goods on the other: drum clusters, pallets around them
    for (const [cx, cz, nx, nz] of [[-20, 36, 2, 2], [-10, 44, 3, 2], [-21, 52, 2, 1], [-4, 34, 1, 2], [-14, 58, 3, 2], [-3, 52, 2, 2]] as const) {
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) add("drum", cx + (i - (nx - 1) / 2) * 0.66, f * (cz + (j - (nz - 1) / 2) * 0.66), 0.6, 0.6, 0.95);
    }
    for (const [x, z] of [[-18, 14], [-6, 20], [6, 13], [18, 21], [30, 14], [8, 30], [26, 34]]) stack(x, f * z, true);
    for (const x of [-24, 0, 24, 96]) for (const z of [-29, 0, 29]) { if (x !== 96 || z !== 0) add("column", x, z, 0.6, 0.6, HALL.h); }
  }
  add("cage", 33, f * -61.5, 5, 1.6, 2.2);
  add("office", 20, f * 55, 16, 18, 3.2);

  // partition walls along the main aisle through the middle of the hall, with two doorways a side. They split the
  // open middle into three routes (north floor, main aisle, south floor), so a push has to pick one
  for (const s of [-1, 1]) for (const [x0, x1] of [[-27, -12], [-8.5, 14], [17.5, 37]]) {
    boxes.push({ kind: "panel", x0, x1, z0: s * 8.2 - 0.15, z1: s * 8.2 + 0.15, y0: 0, y1: 3.4 });
  }

  // main aisle: pallets left in the way, good cover on the long run
  for (const [x, z] of cfg.aisle) stack(x, z, cfg.centerRacks);

  // shipping: pallets staged in two lines in front of the docks
  for (const x of [100, 108]) for (let z = -56; z <= 56; z += 8) { if (Math.abs(z) >= 7) stack(x, z, true); }

  // the local server: a cabinet the technicians have to reach
  const server = { x: cfg.server[0], z: f * cfg.server[1] };
  add("server", server.x, server.z, 1.0, 1.0, 2.1);

  const c1 = (cfg.westSegs[0][1] + cfg.westSegs[1][0]) / 2, c2 = (cfg.westSegs[1][1] + cfg.westSegs[2][0]) / 2;
  const e1 = cfg.eastSegs.length > 1 ? (cfg.eastSegs[0][1] + cfg.eastSegs[1][0]) / 2 : cfg.eastSegs[0][0] - 3;
  const eastAisle = (cfg.eastRows[0] + cfg.eastRows[1]) / 2;

  const zones: Zone[] = [
    { name: "KOMPLETACJA", color: "#8B5CF6", x0: -120, z0: -65, x1: -30, z1: -7.5 },
    { name: "SUROWIEC", color: "#10B981", x0: -120, z0: 7.5, x1: -30, z1: 65 },
    f > 0 ? { name: "PAKOWANIE", color: "#3B82F6", x0: -27, z0: -65, x1: 36, z1: cfg.centerRacks ? -42 : -8 }
      : { name: "PAKOWANIE", color: "#3B82F6", x0: -27, z0: cfg.centerRacks ? 42 : 8, x1: 36, z1: 65 },
    f > 0 ? { name: "STREFA NIEBEZPIECZNA", color: "#EF4444", x0: -25, z0: cfg.centerRacks ? 44 : 31, x1: 1, z1: 65 }
      : { name: "STREFA NIEBEZPIECZNA", color: "#EF4444", x0: -25, z0: -65, x1: 1, z1: cfg.centerRacks ? -44 : -31 },
    { name: "WYSYŁKA", color: "#6366F1", x0: 38, z0: -65, x1: 120, z1: 65 },
  ];

  return {
    name: cfg.name, boxes, ladders, zones, server,
    stations: cfg.stations.map(([x, z]) => ({ x, z: f * z })),
    supply: [{ x: 113, z: -32.5 }, { x: 113, z: 32.5 }],
    spawns: [
      [-117, -50], [-117, -30], [-117, -10], [-117, 10], [-117, 30], [-117, 50], [c1, -8.6], [c1, 8.6], [c2, -8.6], [c2, 8.6],
      [116, -52], [116, -28], [116, -12], [116, 12], [116, 28], [116, 52], [95, -8.6], [95, 8.6], [e1, -8.6], [e1, 8.6],
    ],
    pickups: [
      { kind: "med", x: -100, z: 3 }, { kind: "med", x: -29, z: f * -20 }, { kind: "med", x: -29, z: f * 20 }, { kind: "med", x: 5, z: f * -62 },
      { kind: "med", x: 36, z: f * -20 }, { kind: "med", x: 36, z: f * 24 }, { kind: "med", x: 96, z: 4 }, { kind: "med", x: c1, z: 40.75 },
      { kind: "ammo", x: -117, z: 0 }, { kind: "ammo", x: c2, z: -3 }, { kind: "ammo", x: -28, z: 0 }, { kind: "ammo", x: 5, z: f * -39 },
      { kind: "ammo", x: 4, z: f * 25 }, { kind: "ammo", x: 37, z: 0 }, { kind: "ammo", x: e1, z: 3 }, { kind: "ammo", x: 116, z: 0 },
      { kind: "shotgun", x: c1, z: -34.25 }, { kind: "shotgun", x: c1, z: 34.25 }, { kind: "shotgun", x: -5, z: f * -27 },
      { kind: "shotgun", x: 12, z: f * 39 }, { kind: "shotgun", x: e1, z: -eastAisle }, { kind: "shotgun", x: e1, z: eastAisle },
      { kind: "geo", x: 3, z: 3 }, { kind: "geo", x: c1 + 14, z: -2.2 }, { kind: "geo", x: 78, z: -2 },
    ],
    vehicles: [
      { x: -108, z: 3.5, yaw: 0 }, { x: c1 + 6, z: -3.6, yaw: 0 }, { x: -36, z: 4, yaw: 0 },
      { x: 46, z: -4, yaw: Math.PI }, { x: 76, z: 3.5, yaw: Math.PI }, { x: 113, z: -18, yaw: Math.PI / 2 },
    ],
  };
}

/** The three configurations of the hall. */
export const LAYOUTS: readonly Layout[] = [
  build({
    name: "A", flip: 1,
    westSegs: [[-114, -88], [-84, -58], [-54, -32]], westPerch: [[11.5, 2], [37.5, 1]],
    centerRacks: false,
    eastRows: [18, 31, 44], eastSegs: [[40, 66], [70, 92]], eastPerch: [[44, 0], [18, 1]],
    aisle: [[-100, -3], [-70, 3.5], [-44, -3.5], [-12, 3], [12, -3.2], [34, 3.4], [58, -3], [84, 3.2], [104, -2.5]],
    server: [-43, -27.75], stations: [[-56, 40.75], [-29, -36], [-64, -5]],
  }),
  build({
    name: "B", flip: 1,
    westSegs: [[-114, -96], [-92, -66], [-62, -32]], westPerch: [[24.5, 2], [50.5, 1]],
    centerRacks: true,
    eastRows: [18, 31, 44], eastSegs: [[44, 62], [66, 92]], eastPerch: [[31, 1], [44, 0]],
    aisle: [[-104, 3], [-78, -4], [-50, 3.6], [-24, -3.6], [8, 3.8], [36, -3.6], [58, 3.4], [88, -3.4]],
    server: [-47, 21.25], stations: [[-64, -21.25], [-94, 34.25], [-29, 5.5]],
  }),
  build({
    name: "C", flip: -1,
    westSegs: [[-114, -80], [-76, -54], [-50, -32]], westPerch: [[18, 2], [44, 1]],
    centerRacks: false,
    eastRows: [24.5, 40], eastSegs: [[44, 92]], eastPerch: [[24.5, 0], [40, 0]],
    aisle: [[-96, 3.2], [-66, -3.4], [-40, 3.4], [-14, -3.2], [14, 3], [30, -3.4], [60, 3], [86, -3.2], [104, 2.6]],
    server: [-41, 47.25], stations: [[-78, -14.75], [-29, 36], [-100, -3.5]],
  }),
];

/** Index of the current configuration. */
export let LAYOUT = 0;
/** Every solid box in the hall. */
export let BOXES: readonly Box[] = LAYOUTS[0].boxes;
/** The ladders of the climbable racks. */
export let LADDERS: readonly Ladder[] = LAYOUTS[0].ladders;
/** Floor zones, coloured like the efectivo Live map. Visual only. */
export let ZONES: readonly Zone[] = LAYOUTS[0].zones;
export let SPAWNS: readonly (readonly [number, number])[] = LAYOUTS[0].spawns;
export let PICKUPS: readonly PickupSpot[] = LAYOUTS[0].pickups;
/** Where the drivable forklifts stand at the start of a shift. */
export let VEHICLE_SPAWNS: readonly { x: number; z: number; yaw: number }[] = LAYOUTS[0].vehicles;

/** The current configuration. */
export const layout = () => LAYOUTS[LAYOUT];

/** Make configuration `i` the current one. Cheap: it only swaps what the exports point at. */
export function useLayout(i: number) {
  if (i === LAYOUT || !LAYOUTS[i]) return;
  const l = LAYOUTS[i];
  LAYOUT = i; BOXES = l.boxes; LADDERS = l.ladders; ZONES = l.zones; SPAWNS = l.spawns; PICKUPS = l.pickups; VEHICLE_SPAWNS = l.vehicles;
}

/** UWB anchors (the efectivo positioning network): along the walls. Visual only. */
export const ANCHORS: readonly (readonly [number, number])[] = (() => {
  const a: [number, number][] = [];
  for (let x = -100; x <= 100; x += 40) { a.push([x, HALL.z0 + 0.4]); a.push([x, HALL.z1 - 0.4]); }
  for (const z of [-40, 0, 40]) { a.push([HALL.x0 + 0.4, z]); a.push([HALL.x1 - 0.4, z]); }
  return a;
})();

/** Dock doors on the east wall (z centre). Visual only. */
export const DOCKS: readonly number[] = [-52, -39, -26, -13, 0, 13, 26, 39, 52];
