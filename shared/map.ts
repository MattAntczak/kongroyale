// The efectivo warehouse: one hall of 540 × 290 m (156 600 m²) at real scale, in three configurations so nobody
// learns it by heart. A configuration is generated from a short description (where the rack blocks are cut by cross
// aisles, which racks are perches, what stands in the middle), so the floor fills itself at any size. Every solid thing is an axis-aligned box (collision and thrown boxes use the same list on the
// client and the server); the client dresses each box up by its `kind` (client/world.ts). Units are metres, +Y up,
// +X east, +Z south. The hall floor is y = 0.
//
// The warehouse workers hold the west (racking); the efectivo technicians arrive through the docks in the east.
// A configuration also places the two points, A and B, a round is fought over: two local servers (the technicians
// have to connect one) or two charging stations (they have to fit the watch tags on one).
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
  /** The two local servers, A and B (mission "server"). Also solid boxes in `boxes`. */
  servers: Point[];
  /** The two charging stations, A and B, where watch tags can be fitted (mission "tags"). */
  stations: Point[];
}

/** Inner extent of the hall; the walls sit just outside it. */
export const HALL = { x0: -270, x1: 270, z0: -145, z1: 145, h: 13 } as const;

/** Ordinary racks: too tall to reach or to jump onto. */
export const RACK_H = 9;
/** Climbable racks are a level lower, with a deck on top. */
export const PERCH_H = 7.2;
const RACK_DEPTH = 2.4;
/** Rack rows on each side of the main aisle: every 6.5 m (a double rack and a 4.1 m aisle). */
const ROW0 = 11.5, ROW_STEP = 6.5;
const WEST_ROWS = Array.from({ length: 20 }, (_, i) => ROW0 + i * ROW_STEP);
/** The middle of the aisle just north of rack row `i` (0 = the row nearest the main aisle). */
const aisleZ = (i: number) => ROW0 + i * ROW_STEP + ROW_STEP / 2;
const STACK_H = [1.25, 2.5, 1.25, 3.75, 2.5, 1.25, 2.5];
/** The middle of the hall between the west racking and the east buffer racking. */
const MID_X0 = -64, MID_X1 = 84;

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
  /** Points A and B for each mission, before the flip. */
  servers: [number, number][];
  stations: [number, number][];
}

function build(cfg: Cfg): Layout {
  const boxes: Box[] = [];
  const ladders: Ladder[] = [];
  const f = cfg.flip;
  let hi = 0, seed = cfg.name.charCodeAt(0) * 7919;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  /** Places that have to stay clear: spawns, forklifts, pickups, the stations. */
  const keep: [number, number, number][] = [];
  /** True when a square of half-size `m` around (x, z) touches nothing solid and no kept place. */
  const free = (x: number, z: number, m: number) => {
    if (x - m < HALL.x0 + 0.5 || x + m > HALL.x1 - 0.5 || z - m < HALL.z0 + 0.5 || z + m > HALL.z1 - 0.5) return false;
    for (const b of boxes) if (b.y0 < 2 && x + m > b.x0 && x - m < b.x1 && z + m > b.z0 && z - m < b.z1) return false;
    for (const [kx, kz, kr] of keep) if (Math.abs(kx - x) < kr + m && Math.abs(kz - z) < kr + m) return false;
    return true;
  };
  const add = (kind: BoxKind, cx: number, cz: number, sx: number, sz: number, h: number) => {
    boxes.push({ kind, x0: cx - sx / 2, x1: cx + sx / 2, z0: cz - sz / 2, z1: cz + sz / 2, y0: 0, y1: h });
  };
  /** A pallet stack, if there is room for it and a way round it. */
  const stack = (x: number, z: number, big = false) => {
    const sx = big ? 2.4 : 1.4, sz = big ? 2.0 : 1.2;
    if (!free(x, z, Math.max(sx, sz) / 2 + 1.1)) return;
    add("stack", x, z, sx, sz, STACK_H[hi++ % STACK_H.length]);
  };
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

  // west racking: 20 rows on each side of the main aisle. Perch ladders face east, toward the middle of the hall.
  for (const s of [-1, 1]) for (const z of WEST_ROWS) cfg.westSegs.forEach(([x0, x1], i) => rack(x0, x1, s * z, isPerch(cfg.westPerch, z, i) ? 1 : 0));
  // east buffer racking in front of the docks. Perch ladders face west.
  for (const s of [-1, 1]) for (const z of cfg.eastRows) cfg.eastSegs.forEach(([x0, x1], i) => rack(x0, x1, s * z, isPerch(cfg.eastPerch, z, i) ? -1 : 0));

  // partition walls along the main aisle through the middle of the hall, with a doorway every ~36 m. They split
  // the middle into three routes (north floor, main aisle, south floor), so a push has to pick one
  for (const s of [-1, 1]) for (const [x0, x1] of [[-66, -44], [-40, -6], [-2, 32], [36, 70], [74, 86]]) {
    boxes.push({ kind: "panel", x0, x1, z0: s * 8.2 - 0.15, z1: s * 8.2 + 0.15, y0: 0, y1: 3.4 });
  }

  // the main aisle is closed off in the middle of the hall: nobody runs the whole length in a straight line, the
  // way west leads through a doorway onto the north or the south floor
  boxes.push({ kind: "panel", x0: 14.85, x1: 15.15, z0: -8.2, z1: 8.2, y0: 0, y1: 3.4 });

  // the local servers A and B: cabinets the technicians have to reach
  const servers = cfg.servers.map(([x, z]) => ({ x, z: f * z }));
  for (const sv of servers) add("server", sv.x, sv.z, 1.0, 1.0, 2.1);
  const stations = cfg.stations.map(([x, z]) => ({ x, z: f * z }));
  for (const st of stations) keep.push([st.x, st.z, 3]);

  // the middle of the hall
  add("office", 56, f * 122, 30, 34, 3.2);
  add("cage", 74, f * -140, 8, 1.6, 2.2);
  if (cfg.centerRacks) {
    // buffer racking: six rows a side in three segments, a perch on each side looking down the main aisle
    for (const s of [-1, 1]) for (const z of [20, 33, 46, 59, 72, 85]) {
      rack(-58, -22, s * z, 0);
      rack(-18, 18, s * z, z === 20 || z === 59 ? -1 : 0);
      rack(22, 38, s * z, 0);
    }
    for (let x = -56; x <= 76; x += 16) for (const z of [-132, -116, -100]) add("table", x, f * z, 2.4, 1.2, 0.95);
  } else {
    // packing floor on one side: rows of packing tables
    for (let x = -56; x <= 76; x += 16) for (let z = -24; z >= -132; z -= 18) add("table", x, f * z, 2.4, 1.2, 0.95);
    for (const x of [-60, -24, 12, 48, 84]) for (const z of [-115, -72, -29, 0, 29, 72, 115]) { if (free(x, z, 1)) add("column", x, z, 0.6, 0.6, HALL.h); }
  }
  // hazardous goods on the other side: clusters of drums
  for (let cx = -54; cx <= -6; cx += 16) for (let cz = cfg.centerRacks ? 102 : 40; cz <= 134; cz += 16) {
    const nx = 1 + Math.floor(rnd() * 3), nz = 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) add("drum", cx + (i - (nx - 1) / 2) * 0.66, f * (cz + (j - (nz - 1) / 2) * 0.66), 0.6, 0.6, 0.95);
  }
  for (const z of [-115, -72, 72, 115]) add("column", 226, z, 0.6, 0.6, HALL.h);

  // where the cross aisles are
  const westCross = cfg.westSegs.slice(1).map(([x0], i) => (cfg.westSegs[i][1] + x0) / 2);
  const eastCross = cfg.eastSegs.slice(1).map(([x0], i) => (cfg.eastSegs[i][1] + x0) / 2);
  const eastAisle = (cfg.eastRows[0] + cfg.eastRows[1]) / 2;

  // spawns: the workers start in a cross aisle some 50 m behind points A and B, the technicians along the docks
  const spawns: [number, number][] = [];
  const wx = westCross[westCross.length - 2] ?? westCross[0];
  for (const s of [-1, 1]) { spawns.push([wx, s * 8.6]); for (let i = 0; i < 18; i += 2) spawns.push([wx, s * aisleZ(i)]); }
  for (let z = -133; z <= 133; z += 14) spawns.push([263, z]);
  for (const [x, z] of spawns) keep.push([x, z, 1.5]);

  // forklifts: five toward each team
  const vehicles = [
    { x: wx + 8, z: 3.6, yaw: 0 }, { x: wx - 12, z: -3.6, yaw: 0 }, { x: wx + 30, z: -3.6, yaw: 0 }, { x: -230, z: 3.6, yaw: 0 }, { x: -50, z: 3.6, yaw: 0 },
    { x: 255, z: -34, yaw: Math.PI }, { x: 255, z: -12, yaw: Math.PI }, { x: 255, z: 12, yaw: Math.PI }, { x: 255, z: 34, yaw: Math.PI }, { x: 190, z: -3.6, yaw: Math.PI },
  ];
  for (const v of vehicles) keep.push([v.x, v.z, 2.6]);

  // pickups: down the main aisle, at the cross aisles, around the middle. Anything that would not stand free is left out
  const pickups: PickupSpot[] = [];
  const pick = (kind: PickupKind, x: number, z: number) => { if (free(x, z, 1.2)) { pickups.push({ kind, x, z }); keep.push([x, z, 1.6]); } };
  let n = 0;
  for (let x = -252; x <= 252; x += 36) pick(n++ % 2 ? "ammo" : "med", x, n % 4 < 2 ? 2.2 : -2.2);
  for (const x of [-190, 4, 200]) pick("geo", x, -5);
  for (const x of [...westCross, ...eastCross]) { pick("shotgun", x, aisleZ(5)); pick("shotgun", x, -aisleZ(5)); pick("med", x, aisleZ(12)); pick("ammo", x, -aisleZ(12)); }
  for (const x of eastCross) { pick("med", x, eastAisle); pick("ammo", x, -eastAisle); }
  for (const [x, z] of [[-68, 60], [-68, -60], [88, 60], [88, -60], [10, f * 20], [10, f * -20], [-30, f * -90], [50, f * -90], [30, f * 60], [-68, 120], [-68, -120], [88, 120], [88, -120]]) pick(n++ % 2 ? "ammo" : "med", x, z);

  // pallets: left in the main aisle, between the packing tables, around the hazardous yard, staged at the docks
  for (let x = -250; x <= 228; x += 24) stack(x + (rnd() - 0.5) * 6, (rnd() < 0.5 ? -1 : 1) * (3 + rnd()), cfg.centerRacks);
  if (!cfg.centerRacks) {
    for (let k = 0; k < 70; k++) stack(-58 + rnd() * 136, f * -(14 + rnd() * 122), rnd() < 0.3);
    for (let k = 0; k < 60; k++) stack(-58 + rnd() * 136, f * (14 + rnd() * 88), true);
  } else {
    for (let k = 0; k < 24; k++) stack(-58 + rnd() * 136, f * -(96 + rnd() * 42));
    for (let k = 0; k < 16; k++) stack(4 + rnd() * 30, f * (96 + rnd() * 8), true);
  }
  for (const x of [236, 246]) for (let z = -136; z <= 136; z += 8) { if (Math.abs(z) >= 7) stack(x, z, true); }
  for (let k = 0; k < 30; k++) stack(216 + rnd() * 12, (rnd() - 0.5) * 260, true);

  const zones: Zone[] = [
    { name: "KOMPLETACJA", color: "#8B5CF6", x0: HALL.x0, z0: HALL.z0, x1: -68, z1: -7.5 },
    { name: "SUROWIEC", color: "#10B981", x0: HALL.x0, z0: 7.5, x1: -68, z1: HALL.z1 },
    f > 0 ? { name: "PAKOWANIE", color: "#3B82F6", x0: -64, z0: HALL.z0, x1: 86, z1: cfg.centerRacks ? -92 : -8.5 }
      : { name: "PAKOWANIE", color: "#3B82F6", x0: -64, z0: cfg.centerRacks ? 92 : 8.5, x1: 86, z1: HALL.z1 },
    f > 0 ? { name: "STREFA NIEBEZPIECZNA", color: "#EF4444", x0: -62, z0: cfg.centerRacks ? 96 : 34, x1: 2, z1: HALL.z1 }
      : { name: "STREFA NIEBEZPIECZNA", color: "#EF4444", x0: -62, z0: HALL.z0, x1: 2, z1: cfg.centerRacks ? -96 : -34 },
    { name: "WYSYŁKA", color: "#6366F1", x0: 88, z0: HALL.z0, x1: HALL.x1, z1: HALL.z1 },
  ];
  void MID_X0; void MID_X1;
  return { name: cfg.name, boxes, ladders, zones, servers, stations, spawns, pickups, vehicles };
}

/** The three configurations of the hall. */
export const LAYOUTS: readonly Layout[] = [
  build({
    name: "A", flip: 1,
    westSegs: [[-264, -236], [-232, -204], [-200, -172], [-168, -140], [-136, -108], [-104, -72]],
    westPerch: [[11.5, 5], [57, 5], [102.5, 5], [37.5, 3], [83, 3]],
    centerRacks: false,
    eastRows: [18, 31, 44, 57, 70, 83, 96, 109, 122], eastSegs: [[92, 118], [122, 150], [154, 182], [186, 212]],
    eastPerch: [[18, 0], [70, 0], [109, 0], [44, 2]],
    servers: [[-88, -27.75], [-88, 79.75]], stations: [[-106, -53.75], [-106, 66.75]],
  }),
  build({
    name: "B", flip: 1,
    westSegs: [[-264, -228], [-224, -190], [-186, -150], [-146, -112], [-108, -72]],
    westPerch: [[24.5, 4], [70, 4], [115.5, 4], [50.5, 2]],
    centerRacks: true,
    eastRows: [18, 31, 44, 57, 70, 83, 96, 109, 122], eastSegs: [[96, 126], [130, 168], [172, 212]],
    eastPerch: [[31, 0], [83, 0], [57, 1], [109, 1]],
    servers: [[-90, -47.25], [-90, 99.25]], stations: [[-110, -27.75], [-110, 86.25]],
  }),
  build({
    name: "C", flip: -1,
    westSegs: [[-264, -240], [-236, -200], [-196, -164], [-160, -124], [-120, -96], [-92, -72]],
    westPerch: [[18, 5], [63.5, 5], [109, 5], [44, 3], [89.5, 3]],
    centerRacks: false,
    eastRows: [24.5, 40, 55.5, 71, 86.5, 102, 117.5], eastSegs: [[92, 150], [156, 212]],
    eastPerch: [[24.5, 0], [71, 0], [117.5, 0], [55.5, 1]],
    servers: [[-82, 34.25], [-82, -92.75]], stations: [[-94, 60.25], [-94, -40.75]],
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
/** Where the drivable forklifts stand at the start of a round. */
export let VEHICLE_SPAWNS: readonly { x: number; z: number; yaw: number }[] = LAYOUTS[0].vehicles;

/** The current configuration. */
export const layout = () => LAYOUTS[LAYOUT];

/** The two points, A and B, the round is fought over: the servers, or the charging stations. */
export const sites = (mission: "server" | "tags"): readonly Point[] => mission === "server" ? LAYOUTS[LAYOUT].servers : LAYOUTS[LAYOUT].stations;

/** Make configuration `i` the current one. Cheap: it only swaps what the exports point at. */
export function useLayout(i: number) {
  if (i === LAYOUT || !LAYOUTS[i]) return;
  const l = LAYOUTS[i];
  LAYOUT = i; BOXES = l.boxes; LADDERS = l.ladders; ZONES = l.zones; SPAWNS = l.spawns; PICKUPS = l.pickups; VEHICLE_SPAWNS = l.vehicles;
}

/** UWB anchors (the efectivo positioning network): along the walls. Visual only. */
export const ANCHORS: readonly (readonly [number, number])[] = (() => {
  const a: [number, number][] = [];
  for (let x = HALL.x0 + 30; x < HALL.x1; x += 60) { a.push([x, HALL.z0 + 0.4]); a.push([x, HALL.z1 - 0.4]); }
  for (let z = HALL.z0 + 25; z < HALL.z1; z += 60) { a.push([HALL.x0 + 0.4, z]); a.push([HALL.x1 - 0.4, z]); }
  return a;
})();

/** Dock doors on the east wall (z centre). Visual only. */
export const DOCKS: readonly number[] = Array.from({ length: 21 }, (_, i) => -130 + i * 13);
