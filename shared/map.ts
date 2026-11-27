// The efectivo maps. Two buildings: the railway depot (`buildDepot`, rooms around a track) and the warehouse hall of
// 540 × 290 m (156 600 m²) at real scale, in three configurations so nobody learns it by heart. A configuration is generated from a short description (where the rack blocks are cut by cross
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

export type BoxKind = "wall" | "rack" | "stack" | "table" | "column" | "drum" | "office" | "forklift" | "cage" | "server" | "panel" | "block";

export interface Box {
  x0: number; y0: number; z0: number;
  x1: number; y1: number; z1: number;
  kind: BoxKind;
  /** Top for thrown boxes when lower than y1 (a forklift stops boxes only up to its body). */
  shotY1?: number;
  /** A rack with a ladder and a deck on top: a sniper's perch. */
  climb?: boolean;
  /** Paint for a "block" (a container, a wagon, a crane leg) or a tint for a wall. */
  color?: number;
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

export type PickupKind = "med" | "ammo" | "geo";
export interface PickupSpot { kind: PickupKind; x: number; z: number }
export interface Point { x: number; z: number }

export interface Hall { x0: number; x1: number; z0: number; z1: number; h: number }

export interface Layout {
  name: string;
  /** "hall": the open warehouse with a main aisle. "depot": rooms and doorways around a railway track. */
  kind: "hall" | "depot";
  /** Inner extent of the building and the height of its ceiling. */
  hall: Hall;
  /** Spawns by role, [workers, technicians], when the side cannot be told from x. */
  teamSpawns?: [[number, number][], [number, number][]];
  /** Bot routes for the technicians: for each point (A, B) three lanes of waypoints. */
  routes?: [number, number][][][];
  /** Seconds a round lasts here (the default suits the big hall). */
  roundS?: number;
  /** A railway track painted on the floor, along x. */
  rails?: { x0: number; x1: number; z: number };
  anchors: [number, number][];
  /** Dock doors on the east wall (z centres). */
  docks: number[];
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
const BIG: Hall = { x0: -270, x1: 270, z0: -145, z1: 145, h: 13 };
/** Inner extent of the current building; the walls sit just outside it. Swapped by `useLayout`. */
export let HALL: Hall = BIG;

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

/** UWB anchors (the efectivo positioning network): along the walls. Visual only. */
function anchorsFor(h: Hall, step: number): [number, number][] {
  const a: [number, number][] = [];
  for (let x = h.x0 + step / 2; x < h.x1; x += step) { a.push([x, h.z0 + 0.4]); a.push([x, h.z1 - 0.4]); }
  for (let z = h.z0 + step / 2; z < h.z1; z += step) { a.push([h.x0 + 0.4, z]); a.push([h.x1 - 0.4, z]); }
  return a;
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
  for (const x of [...westCross, ...eastCross]) { pick("med", x, aisleZ(12)); pick("ammo", x, -aisleZ(12)); }
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
  return { name: cfg.name, kind: "hall", hall: BIG, anchors: anchorsFor(BIG, 60), docks: Array.from({ length: 21 }, (_, i) => -130 + i * 13), boxes, ladders, zones, servers, stations, spawns, pickups, vehicles };
}


// ---------------------------------------------------------------- the railway depot
//
// A smaller, closed arena in the manner of a CS map: 184 × 120 m of rooms joined by 4 m doorways. A track with a
// wagon runs through the central hall; point A is the heavy transshipment bay in the west (a big transport crate, a
// mezzanine with two stairs), point B the cold store in the east (its own chambers behind thick walls). Containers,
// the packing room, the workshop and the offices are ways round the central hall. The technicians start in the
// south-west, the workers in the south-east, the docks lie between them.
//
// The building is drawn as open rectangles (rooms and doorways) on a 1 m grid; everything else is solid wall.
// ---------------------------------------------------------------- the sorting centre
//
// PLACEHOLDER: a compact arena in the manner of a CS map, still to be designed. Until then it is the depot under
// another name, so the lobby, the host and the tests can already pick it.
function buildSort(): Layout {
  return { ...buildDepot(), name: "Sortownia" };
}

function buildDepot(): Layout {
  const D: Hall = { x0: -92, x1: 92, z0: -60, z1: 60, h: 8 };
  type R = [number, number, number, number]; // x0, x1, z0, z1
  const A: R = [-88, -40, -44, -10], CONT: R = [-88, -40, -8, 30], TROOM: R = [-88, -62, 32, 58], TPASS: R = [-62, -40, 40, 54];
  const YARD: R = [-40, 58, 34, 58], CENTRE: R = [-38, 30, -30, 22], NCORR: R = [-38, 40, -52, -32], WORK: R = [42, 68, -58, -34];
  const OFFICE: R = [70, 88, -54, -40], PACK: R = [32, 68, -30, -16], B: R = [32, 70, -14, 18], SECORR: R = [32, 80, 20, 32], CT: R = [60, 88, 34, 58];
  const CH1: R = [72, 90, -36, -22], CH2: R = [72, 90, -20, -4], CH3: R = [72, 90, -2, 18];
  const open: R[] = [A, CONT, TROOM, TPASS, YARD, CENTRE, NCORR, WORK, OFFICE, PACK, B, SECORR, CT, CH1, CH2, CH3,
    // doorways
    [-80, -76, -10, -8], [-52, -48, -10, -8],       // A – containers
    [-40, -38, -22, -18], [-40, -38, -42, -38],     // A – central hall, A – north corridor
    [-40, -38, 8, 12], [-46, -42, 30, 40],          // containers – central hall, containers – technicians' passage
    [-20, -15, 22, 34], [12, 17, 22, 34],           // docks – central hall (two passages)
    [58, 60, 44, 48], [46, 50, 32, 34], [72, 76, 32, 34], // docks – workers, docks – south-east corridor, workers – corridor
    [48, 52, 18, 20], [74, 78, 18, 20],             // corridor – cold store, corridor – chambers
    [30, 32, 0, 4], [30, 32, -26, -22],             // central hall – cold store, central hall – packing
    [-24, -20, -32, -30], [10, 14, -32, -30],       // central hall – north corridor
    [34, 38, -32, -30], [40, 42, -46, -42],         // north corridor – packing, north corridor – workshop
    [60, 64, -34, -30], [68, 70, -50, -46],         // workshop – packing, workshop – offices
    [82, 86, -40, -36], [74, 78, -22, -20], [84, 88, -4, -2], // offices – chambers, between the chambers
    [70, 72, -14, -10], [56, 60, -16, -14],         // cold store – chambers, cold store – packing
  ];
  const GW = D.x1 - D.x0, GH = D.z1 - D.z0;
  const solid = new Uint8Array(GW * GH).fill(1);
  for (const [x0, x1, z0, z1] of open) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) solid[(z - D.z0) * GW + (x - D.x0)] = 0;
  // the walls of the cold store and its chambers are insulated panels: a cold tint
  const COLD = 0xbfe3f5;
  const tint = (i: number, j: number) => { const x = i + D.x0, z = j + D.z0; return x >= 30 && z >= -38 && z < 20 ? 2 : 1; };
  const boxes: Box[] = [];
  let live = new Map<string, Box>();
  for (let j = 0; j < GH; j++) {
    const next = new Map<string, Box>();
    for (let i = 0; i < GW;) {
      if (!solid[j * GW + i]) { i++; continue; }
      const t = tint(i, j); let e = i;
      while (e < GW && solid[j * GW + e] && tint(e, j) === t) e++;
      const key = `${i}:${e}:${t}`, prev = live.get(key);
      if (prev) { prev.z1 = j + 1 + D.z0; next.set(key, prev); }
      else { const b: Box = { kind: "wall", x0: i + D.x0, x1: e + D.x0, z0: j + D.z0, z1: j + 1 + D.z0, y0: 0, y1: D.h + 1, color: t === 2 ? COLD : undefined }; boxes.push(b); next.set(key, b); }
      i = e;
    }
    live = next;
  }

  const keep: [number, number, number][] = [];
  const free = (x: number, z: number, m: number) => {
    for (const b of boxes) if (b.y0 < 2 && x + m > b.x0 && x - m < b.x1 && z + m > b.z0 && z - m < b.z1) return false;
    for (const [kx, kz, kr] of keep) if (Math.abs(kx - x) < kr + m && Math.abs(kz - z) < kr + m) return false;
    return true;
  };
  const blk = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, color: number) => { boxes.push({ kind: "block", x0, x1, z0, z1, y0, y1, color }); };
  const add = (kind: BoxKind, cx: number, cz: number, sx: number, sz: number, h: number) => { boxes.push({ kind, x0: cx - sx / 2, x1: cx + sx / 2, z0: cz - sz / 2, z1: cz + sz / 2, y0: 0, y1: h }); };

  // points A and B
  const servers = [{ x: -70, z: -22 }, { x: 52, z: 2 }];
  for (const sv of servers) add("server", sv.x, sv.z, 1.0, 1.0, 2.1);
  const stations = [{ x: -58, z: -33 }, { x: 44, z: -4 }];
  for (const st of stations) keep.push([st.x, st.z, 3]);
  for (const sv of servers) keep.push([sv.x, sv.z, 2.5]);

  // spawns
  const tSpawns: [number, number][] = [], wSpawns: [number, number][] = [];
  for (const z of [36, 40.5, 45, 49.5]) for (const x of [-85, -80.5, -76, -71.5, -67]) tSpawns.push([x, z]);
  for (const z of [38, 43, 48, 53]) for (const x of [64, 69, 74, 79, 84]) wSpawns.push([x, z]);
  for (const [x, z] of [...tSpawns, ...wSpawns]) keep.push([x, z, 1.5]);
  const vehicles = [{ x: -28, z: 38, yaw: 0 }, { x: 40, z: 54, yaw: Math.PI }];
  for (const v of vehicles) keep.push([v.x, v.z, 2.6]);

  // zone A, heavy transshipment: a mezzanine along the north wall with a stair at each end, and the big crate
  const STEEL = 0x4b5563, STEP = 0.3, RUN = 0.6;
  blk(-84, -44, -44, -38, 0, 2.7, STEEL);
  for (const [sx0, sx1] of [[-84, -81], [-47, -44]]) for (let k = 8; k >= 1; k--) {
    const z0 = -38 + (8 - k) * RUN;
    blk(sx0, sx1, z0, z0 + RUN, 0, k * STEP, 0xf2c200);
  }
  blk(-63, -52, -27, -16, 0, 4, 0xa37b4b);
  // containers: a small maze between the technicians' side and A
  const CONT_COLORS = [0x1d4ed8, 0xc2410c, 0x15803d, 0xb91c1c, 0x0e7490];
  const containers: [number, number, number, number, number][] = [
    [-84, -72, -2, 0.6, 2.6], [-68, -56, -2, 0.6, 5.2], [-62, -59.4, 6, 18, 2.6], [-80, -68, 10, 12.6, 2.6], [-56, -44, 20, 22.6, 2.6],
    [-84, -72, 20, 22.6, 5.2], [-52, -49.4, -2, 10, 2.6], [-34, -22, 44, 46.6, 2.6], [24, 36, 40, 42.6, 2.6], [-8, 4, 36, 38.6, 5.2],
  ];
  containers.forEach(([x0, x1, z0, z1, h], i) => blk(x0, x1, z0, z1, 0, h, CONT_COLORS[i % CONT_COLORS.length]));
  // the central hall: the track with a wagon, low concrete barriers along it, the gantry crane in the east
  const CONCRETE = 0x9ca3af, CRANE = 0xf2c200;
  blk(-10, 6, -6.6, -3.4, 0, 3.4, 0x7c2d12);
  for (const [x0, x1] of [[-36, -26], [-20, -12], [8, 16], [22, 28]]) blk(x0, x1, -8.3, -7.9, 0, 0.9, CONCRETE);
  for (const [x0, x1] of [[-32, -22], [-16, -11], [7, 12], [18, 26]]) blk(x0, x1, -2.1, -1.7, 0, 0.9, CONCRETE);
  blk(21.5, 22.5, -28.5, -27.5, 0, 7, CRANE); blk(21.5, 22.5, 19.5, 20.5, 0, 7, CRANE);
  blk(21.4, 22.6, -28.5, 20.5, 6.2, 7, CRANE); blk(21.1, 22.9, -6, -4, 4.8, 6.2, 0x1f2937);
  // packing: two conveyors; the workshop and the offices: benches and desks
  blk(38, 54, -20.6, -19.4, 0, 0.9, 0x6b7280); blk(44, 64, -27.6, -26.4, 0, 0.9, 0x6b7280);
  for (const [x, z] of [[48, -52], [56, -52], [62, -42], [48, -40], [76, -50], [82, -44], [40, -17.5], [60, -22.5]]) add("table", x, z, 2.4, 1.2, 0.95);
  for (const [x, z] of [[52, -38], [52.7, -38], [52.35, -37.4], [66, -56], [66, -55.3]]) add("drum", x, z, 0.6, 0.6, 0.95);
  // the docks: a truck backed up to a door, and the doors themselves on the south wall
  blk(0, 2.6, 44, 57.6, 0, 3.8, 0xe5e7eb); blk(0.1, 2.5, 40.6, 44, 0, 2.9, 0x474fff);
  for (const x of [-24, -12, 14, 26]) blk(x - 1.6, x + 1.6, 57.8, 58, 0, 3.8, 0xc9ccd2);

  // pallets: cover in every room
  let hi = 0;
  const stack = (x: number, z: number, big = false) => {
    const sx = big ? 2.4 : 1.4, sz = big ? 2.0 : 1.2;
    if (!free(x, z, Math.max(sx, sz) / 2 + 1.0)) return;
    add("stack", x, z, sx, sz, STACK_H[hi++ % STACK_H.length]);
  };
  const pickups: PickupSpot[] = [];
  const pick = (kind: PickupKind, x: number, z: number) => { if (free(x, z, 1.2)) { pickups.push({ kind, x, z }); keep.push([x, z, 1.6]); } };
  for (const [k, x, z] of [
    ["med", -44, -14], ["ammo", -84, -30], ["ammo", -70, 5], ["med", -50, 26], ["med", -34, 18], ["ammo", 26, -26], ["geo", -16, -5],
    ["med", 30, -36], ["ammo", 64, -54], ["geo", 84, -50], ["med", 64, -18], ["ammo", 36, 16], ["med", 66, -12],
    ["med", 88, 14], ["ammo", 56, 28], ["ammo", -30, 54], ["med", 30, 54], 
  ] as [PickupKind, number, number][]) pick(k, x, z);
  for (const [x, z, big] of [
    [-76, -30, 1], [-46, -28, 1], [-82, -14, 0], [-58, -12.5, 0], [-74, -14, 1], [-44, -20, 0],          // A
    [-76, 26, 0], [-44, 2, 1], [-86, 6, 0],                                                              // containers
    [-28, 10, 1], [-8, 14, 1], [8, -20, 1], [-20, -22, 1], [18, 10, 1], [-30, -14, 0], [0, 6, 0], [-4, -14, 0], [26, 14, 0], [-34, -26, 1], // centre
    [-10, -42, 1], [24, -40, 0], [-30, -48, 1], [8, -50, 0],                                             // north corridor
    [40, -8, 1], [62, -8, 0], [40, 12, 0], [62, 12, 1], [46, 6, 1], [58, -2, 1], [66, 2, 0],              // B, the cold store
    [80, -29, 1], [86, -12, 0], [78, 6, 1], [86, 10, 0], [76, -8, 0],                                    // chambers
    [40, 26, 1], [66, 24, 0], [-36, 52, 1], [18, 50, 1], [-16, 40, 0], [52, 52, 1], [-52, 44, 0],         // corridor, docks
  ] as [number, number, number][]) stack(x, z, !!big);

  const zones: Zone[] = [
    { name: "A · PRZEŁADUNEK", color: "#F59E0B", x0: A[0], x1: A[1], z0: A[2], z1: A[3] },
    { name: "KONTENERY", color: "#6366F1", x0: CONT[0], x1: CONT[1], z0: CONT[2], z1: CONT[3] },
    { name: "TOR", color: "#64748B", x0: CENTRE[0], x1: CENTRE[1], z0: CENTRE[2], z1: CENTRE[3] },
    { name: "B · CHŁODNIA", color: "#38BDF8", x0: B[0], x1: B[1], z0: B[2], z1: B[3] },
    { name: "KOMORY", color: "#0EA5E9", x0: CH1[0], x1: CH1[1], z0: CH1[2], z1: CH3[3] },
    { name: "PAKOWNIA", color: "#3B82F6", x0: PACK[0], x1: PACK[1], z0: PACK[2], z1: PACK[3] },
    { name: "WARSZTAT", color: "#EF4444", x0: WORK[0], x1: WORK[1], z0: WORK[2], z1: WORK[3] },
    { name: "BIURA", color: "#8B5CF6", x0: OFFICE[0], x1: OFFICE[1], z0: OFFICE[2], z1: OFFICE[3] },
    { name: "DOKI", color: "#10B981", x0: YARD[0], x1: YARD[1], z0: YARD[2], z1: YARD[3] },
    { name: "TECHNICY", color: "#474FFF", x0: TROOM[0], x1: TROOM[1], z0: TROOM[2], z1: TROOM[3] },
    { name: "PRACOWNICY", color: "#FF6A00", x0: CT[0], x1: CT[1], z0: CT[2], z1: CT[3] },
  ];
  // the technicians' bots: three ways to each point
  const routes: [number, number][][][] = [
    [[[-44, 36], [-48, 14], [-50, -6]], [[-30, 47], [-17.5, 28], [-30, -12], [-36, -20]], [[-30, 47], [14.5, 28], [12, -29], [-30, -42], [-36, -40]]],
    [[[40, 46], [48, 31], [50, 22]], [[-17.5, 28], [10, 8], [28, 2]], [[14.5, 28], [20, -24], [34, -24], [58, -18]]],
  ];
  return {
    name: "Zajezdnia", kind: "depot", hall: D, boxes, ladders: [], zones, servers, stations,
    spawns: [...wSpawns, ...tSpawns], teamSpawns: [wSpawns, tSpawns], routes, roundS: 150, rails: { x0: -38, x1: 30, z: -5 },
    pickups, vehicles, anchors: anchorsFor(D, 30), docks: [],
  };
}

/** The three configurations of the hall, then the railway depot. */
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
  buildDepot(),
  buildSort(),
];
/** How many of the layouts are configurations of the big hall (the depot comes after them). */
export const HALL_LAYOUTS = 3;
export const DEPOT_LAYOUT = 3;
export const SORT_LAYOUT = 4;

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
  LAYOUT = i; HALL = l.hall; BOXES = l.boxes; LADDERS = l.ladders; ZONES = l.zones; SPAWNS = l.spawns; PICKUPS = l.pickups; VEHICLE_SPAWNS = l.vehicles;
}


