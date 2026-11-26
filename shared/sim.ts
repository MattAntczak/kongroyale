// The efectivo ARENA host: the warehouse workers (team 0, defending) against the efectivo technicians (team 1,
// attacking) over one mission in one of three hall configurations. A room goes lobby -> briefing -> play -> end and
// back to the lobby. The host owns health, ammo, kills, pickups, respawns, the mission and the bots. The same class runs inside the Node server (online rooms) and inside the browser (bot
// matches), so both play by identical rules.
//
// Authority: a human's movement is predicted by their own client and sent here; the host checks every step against
// the walls and a speed limit and sends a correction when one fails. Shots are decided here: each one launches real
// cardboard boxes that fly tick by tick, and a box tests players where the shooter saw them (up to 300 ms back).

import { BOXES, PICKUPS, SPAWNS, HALL, LAYOUTS, VEHICLE_SPAWNS, layout, useLayout, type Box as HallBox, type PickupKind, type PickupSpot } from "./map";
import { SEATS, VEH_MAX_SPEED, VEH_USE_R, seatPos, stepVehicle, vehicleBlocked, vehicleBox, type VehicleState } from "./vehicle";
import { EYE_H, PLAYER_H, SPRINT_SPEED, blocked, lineOfSight, rayPlayer, rayWorld, setDynamicBoxes, stepBody, viewDir, type Body } from "./physics";
import { BOX_GRAVITY, BOX_LIFE_S, GRENADE_FUSE_S, GRENADE_GRAVITY, GRENADE_R, WEAPONS, falloff, lobPitch, type WeaponId } from "./weapons";
import { findPath, freeAt, randomFree, walkable } from "./nav";
import type { ClientMsg, Config, Difficulty, Ev, HostMsg, Mission, ObjSnap, PlayerSnap, SelfSnap } from "./proto";

export const TICK_HZ = 60;
/** Most players in one team, people and bots together. */
export const MAX_TEAM = 20;
export const TEAM_NAMES = ["Pracownicy magazynu", "Technicy efectivo"] as const;
export const TEAM_SHORT = ["Pracownicy", "Technicy"] as const;
/** The technicians have this long; when it runs out the workers have held the hall. */
export const MISSION_TIME_S = 7 * 60;
/** The briefing (the loading screen with the mission's story). */
export const BRIEF_S = 20;
export const END_S = 12;
/**
 * Players come back in waves, so a team returns together instead of trickling in one by one: every WAVE_S seconds
 * for the workers and the technicians. The technicians' wave is shorter because they have the longer walk back.
 */
export const WAVE_S = [14, 9] as const;
export const MIN_OUT_S = 3;
/** Mission "server": how long a technician has to hold on at the cabinet, and how fast a lost connection decays. */
export const CONNECT_S = 12;
export const CONNECT_DECAY_S = 50;
export const CONNECT_R = 3;
/** Mission "tags": cases of watch tags the technicians have to bring to the charging stations. */
export const TAGS_NEED = 5;
export const TAG_DROP_S = 30;
export const SPAWN_PROTECT_S = 1.5;
export const GEO_S = 10;
export const MAX_REWIND_S = 0.3;
/** A drop of more than this (metres) hurts; each further metre costs FALL_DMG_PER_M health. */
export const SAFE_FALL_M = 4.5;
export const FALL_DMG_PER_M = 14;
const HIST = 48;
const leadPos = [0, 0, 0];
const tmpSeat = [0, 0, 0];
const goalTmp = [0, 0];

const BOT_NAMES = ["Zenek", "Halina", "Mirek", "Grażyna", "Waldek", "Bożena", "Rysiek", "Danuta", "Kazik", "Wiesia", "Janusz", "Krystyna", "Staszek", "Jadwiga", "Heniek", "Tereska", "Bogdan", "Irena"];
const PICKUP_RESPAWN_S: Record<PickupKind, number> = { med: 20, ammo: 15, shotgun: 25, geo: 45 };

const DIFF = {
  easy: { react: 0.6, aimErr: 0.11, turn: 3.2, view: 32, burst: 0.35, pause: 0.55, lead: 0.3 },
  normal: { react: 0.35, aimErr: 0.06, turn: 5.5, view: 45, burst: 0.5, pause: 0.35, lead: 0.7 },
  hard: { react: 0.2, aimErr: 0.03, turn: 9, view: 60, burst: 0.8, pause: 0.2, lead: 1 },
} as const;

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pellet directions (flat xyz list) inside a cone around the view, uniform over the disc. */
export function spreadDirs(yaw: number, pitch: number, cone: number, pellets: number, rand: () => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < pellets; i++) {
    const r = Math.sqrt(rand()) * cone, a = rand() * Math.PI * 2;
    const [x, y, z] = viewDir(yaw + Math.cos(a) * r / Math.max(0.2, Math.cos(pitch)), pitch + Math.sin(a) * r);
    out.push(x, y, z);
  }
  return out;
}

interface Brain {
  path: [number, number][] | null; pi: number; goalX: number; goalZ: number; repathAt: number;
  target: number; reactAt: number; strafe: number; strafeUntil: number;
  errYaw: number; errPitch: number; errUntil: number; nextThink: number;
  seenX: number; seenZ: number; seenT: number; lastX: number; lastZ: number; stuckCheck: number;
  burstUntil: number; pauseUntil: number; jump: boolean;
  /** Who last hit us, and until when we look for them beyond our normal view. */
  alertId: number; alertUntil: number;
  /** This life's job: work the mission (attack or guard the objective) or hunt the other team. */
  job: "mission" | "hunt"; station: number;
  /** The route a technician takes through the middle this life: −1 north floor, 0 main aisle, 1 south floor. */
  lane: number; laneDone: boolean;
}

export type Team = 0 | 1;

interface Player {
  id: number; name: string; bot: boolean; color: number; team: Team;
  body: Body; yaw: number; pitch: number; moving: boolean;
  hp: number; alive: boolean; respawnAt: number; killedBy: string;
  w: WeaponId; mag: Record<WeaponId, number>; res: Record<WeaponId, number>; owned: Set<WeaponId>;
  fireReady: number; lastFire: number; reloadUntil: number;
  k: number; d: number; spawn: number; protectUntil: number; geoUntil: number;
  lastStateT: number;
  hist: Float64Array; histN: number;
  brain: Brain | null;
  /** The forklift this player rides (-1 on foot) and the seat: 0 drives, 1 throws from the rear platform. */
  veh: number; seat: number;
  /** Where the current fall started (the highest point since we last stood still vertically). */
  fallFrom: number;
  /** Holding E at the server; carrying a case of watch tags. */
  acting: boolean; carry: boolean;
}

interface Forklift {
  id: number; st: VehicleState;
  /** Riders by seat (driver, thrower). */
  riders: [Player | null, Player | null];
  /** Bumped when the host overrules the driver's pose: the driver then takes the host's. */
  rev: number;
  lastDriveT: number;
}

/** A cardboard box in flight. */
interface Box {
  owner: Player; team: Team; w: WeaponId;
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  /** Metres flown, for damage falloff. */
  dist: number; born: number;
  /** How far behind the present the shooter was looking, seconds: targets are tested at that moment. */
  lag: number;
}

export interface SimOptions { seed?: number }

export class Sim {
  time = 0;
  phase: "lobby" | "brief" | "play" | "end" = "lobby";
  /** What the next shift will be: bots per team, the mission, the bots' level. Set in the lobby by the host. */
  config: Config = { bots: [5, 5], mission: "random", difficulty: "normal" };
  /** The hall configuration and the mission of this shift. */
  layout = 0;
  mission: Mission = "server";
  /** The first person in the room runs the lobby. */
  hostId = 0;
  private phaseEnd = 0;
  private players = new Map<number, Player>();
  private nextId = 1;
  private evs: Ev[] = [];
  private boxes: Box[] = [];
  private forklifts: Forklift[] = [];
  private dynBoxes: HallBox[] = [];
  private pickups: { spot: PickupSpot; readyAt: number }[] = [];
  private rand: () => number;
  private colorSeq = 0;
  /** Eliminations per team this shift (for the scoreboard; the mission decides who wins). */
  readonly score: [number, number] = [0, 0];
  private botName = 0;
  // mission state
  private progress = 0;
  private connecting = false;
  private lastConnectEv = -99;
  private delivered = 0;
  private drops: { x: number; z: number; until: number }[] = [];

  constructor(readonly opts: SimOptions = {}) {
    this.rand = mulberry32(opts.seed ?? 1234567);
    this.layout = Math.floor(this.rand() * LAYOUTS.length);
  }

  get humanCount() { let n = 0; for (const p of this.players.values()) if (!p.bot) n++; return n; }

  private newPlayer(name: string, bot: boolean, team: Team): Player {
    const p: Player = {
      id: this.nextId++, name, bot, color: this.colorSeq++ % 10, team,
      body: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: true }, yaw: 0, pitch: 0, moving: false,
      hp: 100, alive: true, respawnAt: 0, killedBy: "",
      w: "rifle", mag: { rifle: 0, pistol: 0, shotgun: 0, grenade: 0 }, res: { rifle: 0, pistol: 0, shotgun: 0, grenade: 0 }, owned: new Set(),
      fireReady: 0, lastFire: -99, reloadUntil: 0, k: 0, d: 0, spawn: 0, protectUntil: 0, geoUntil: 0, lastStateT: 0,
      hist: new Float64Array(HIST * 4), histN: 0,
      veh: -1, seat: 0, fallFrom: 0, acting: false, carry: false,
      brain: bot ? {
        path: null, pi: 0, goalX: 0, goalZ: 0, repathAt: 0, target: 0, reactAt: 0, strafe: 1, strafeUntil: 0,
        errYaw: 0, errPitch: 0, errUntil: 0, nextThink: 0, seenX: 0, seenZ: 0, seenT: -99, lastX: 0, lastZ: 0, stuckCheck: 0,
        burstUntil: 0, pauseUntil: 0, jump: false, alertId: 0, alertUntil: 0, job: "mission", station: 0, lane: 0, laneDone: false,
      } : null,
    };
    this.players.set(p.id, p);
    this.respawn(p);
    return p;
  }

  private teamCount(t: Team, humansOnly = false) {
    let n = 0;
    for (const p of this.players.values()) if (p.team === t && (!humansOnly || !p.bot)) n++;
    return n;
  }

  /**
   * Add a person; returns their id, or 0 when both teams are full of people. `pref` 0 or 1 asks for the workers or
   * the technicians; otherwise they go where fewer people are. Someone who joins a running shift takes a bot's place.
   */
  addHuman(name: string, pref = -1): number {
    useLayout(this.layout);
    const ha = this.teamCount(0, true), hb = this.teamCount(1, true);
    if (ha >= MAX_TEAM && hb >= MAX_TEAM) return 0;
    let team: Team = ha <= hb ? 0 : 1;
    if ((pref === 0 || pref === 1) && this.teamCount(pref, true) < MAX_TEAM) team = pref;
    if (this.teamCount(team, true) >= MAX_TEAM) team = team === 0 ? 1 : 0;
    if (this.phase !== "lobby") this.dropBot(team);
    const clean = name.replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 16) || "Magazynier";
    const p = this.newPlayer(clean, false, team);
    if (!this.hostId) this.hostId = p.id;
    this.evs.push({ k: "join", name: p.name });
    return p.id;
  }

  /** Make room in a team that is full by sending its weakest bot home. */
  private dropBot(team: Team) {
    if (this.teamCount(team) < MAX_TEAM) return;
    let worst: Player | null = null;
    for (const p of this.players.values()) if (p.bot && p.team === team && (!worst || p.k < worst.k)) worst = p;
    if (worst) { this.leaveForklift(worst, false); this.players.delete(worst.id); }
  }

  removePlayer(id: number) {
    const p = this.players.get(id);
    if (!p) return;
    this.leaveForklift(p, false);
    this.players.delete(id);
    this.boxes = this.boxes.filter((b) => b.owner !== p);
    this.evs.push({ k: "leave", name: p.name });
    if (p.carry) this.drops.push({ x: p.body.x, z: p.body.z, until: this.time + TAG_DROP_S });
    if (this.hostId === id) { this.hostId = 0; for (const q of this.players.values()) if (!q.bot) { this.hostId = q.id; break; } }
  }

  // ---------------------------------------------------------------- lobby and shift

  private setTeam(p: Player, team: number) {
    if (this.phase !== "lobby" || (team !== 0 && team !== 1) || p.team === team) return;
    if (this.teamCount(team as Team, true) >= MAX_TEAM) return;
    p.team = team as Team;
  }

  private setConfig(p: Player, c: Config) {
    if (this.phase !== "lobby" || p.id !== this.hostId || !c || !Array.isArray(c.bots)) return;
    const n = (v: unknown) => Math.max(0, Math.min(MAX_TEAM, Math.floor(Number(v) || 0)));
    this.config = {
      bots: [n(c.bots[0]), n(c.bots[1])],
      mission: c.mission === "server" || c.mission === "tags" ? c.mission : "random",
      difficulty: c.difficulty === "easy" || c.difficulty === "hard" ? c.difficulty : "normal",
    };
  }

  /** Start a shift: a new hall configuration, the mission, the bots, then the briefing. */
  begin(forceLayout = -1) {
    if (this.phase !== "lobby") return;
    // a different configuration from last time (tests may name one)
    this.layout = forceLayout >= 0 ? forceLayout : (this.layout + 1 + Math.floor(this.rand() * (LAYOUTS.length - 1))) % LAYOUTS.length;
    useLayout(this.layout);
    this.mission = this.config.mission === "random" ? (this.rand() < 0.5 ? "server" : "tags") : this.config.mission;
    for (const p of [...this.players.values()]) if (p.bot) this.players.delete(p.id);
    this.botName = Math.floor(this.rand() * BOT_NAMES.length);
    for (const t of [0, 1] as const) {
      const want = Math.min(this.config.bots[t], MAX_TEAM - this.teamCount(t, true));
      for (let i = 0; i < want; i++) this.newPlayer(BOT_NAMES[this.botName++ % BOT_NAMES.length], true, t);
    }
    this.score[0] = 0; this.score[1] = 0;
    this.progress = 0; this.connecting = false; this.delivered = 0; this.drops = []; this.boxes.length = 0;
    this.forklifts = VEHICLE_SPAWNS.map((v, i) => ({ id: i, st: { x: v.x, z: v.z, yaw: v.yaw, speed: 0 }, riders: [null, null], rev: 0, lastDriveT: 0 }));
    this.dynBoxes = VEHICLE_SPAWNS.map(() => ({ kind: "forklift", x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 }));
    this.pickups = PICKUPS.map((spot) => ({ spot, readyAt: 0 }));
    for (const p of this.players.values()) { p.k = 0; p.d = 0; p.veh = -1; this.respawn(p); }
    this.phase = "brief";
    this.phaseEnd = this.time + BRIEF_S;
    this.evs.push({ k: "start", layout: this.layout, mission: this.mission });
  }

  nameOf(id: number) { return this.players.get(id)?.name ?? "?"; }

  // ---------------------------------------------------------------- input from clients

  receive(id: number, m: ClientMsg) {
    const p = this.players.get(id);
    if (!p) return;
    useLayout(this.layout);
    switch (m.t) {
      case "state": this.onState(p, m); break;
      case "shoot": this.onShoot(p, m); break;
      case "reload": this.startReload(p); break;
      case "switch": if (p.owned.has(m.w) && p.w !== m.w) { p.w = m.w; p.reloadUntil = 0; p.fireReady = Math.max(p.fireReady, this.time + 0.25); } break;
      case "use": this.useForklift(p); break;
      case "act": p.acting = !!m.on; break;
      case "team": this.setTeam(p, m.team); break;
      case "config": this.setConfig(p, m.config); break;
      case "start": if (p.id === this.hostId) this.begin(); break;
      case "drive": this.onDrive(p, m); break;
      case "chat": { const text = String(m.text).slice(0, 120).trim(); if (text) this.evs.push({ k: "chat", name: p.name, text }); break; }
    }
  }

  private onState(p: Player, m: Extract<ClientMsg, { t: "state" }>) {
    if (!p.alive || m.spawn !== p.spawn || this.phase !== "play") return;
    if (![m.x, m.y, m.z, m.yaw, m.pitch].every(Number.isFinite)) return;
    p.yaw = m.yaw;
    p.pitch = Math.max(-1.5, Math.min(1.5, m.pitch));
    p.moving = !!m.moving;
    if (p.veh >= 0) return; // riders go where the forklift goes
    const dt = Math.max(0.016, Math.min(0.5, this.time - p.lastStateT));
    p.lastStateT = this.time;
    const b = p.body;
    const dh = Math.hypot(m.x - b.x, m.z - b.z);
    const okSpeed = dh <= SPRINT_SPEED * 1.4 * dt + 0.6;
    const okY = m.y >= -0.01 && m.y <= HALL.h && m.y - b.y <= 1.6 * Math.max(dt, 0.1) * 8;
    const inside = m.x > HALL.x0 && m.x < HALL.x1 && m.z > HALL.z0 && m.z < HALL.z1;
    // forklifts are left out: the client saw them a moment ago, the host sees them now
    if (okSpeed && okY && inside && !blocked(m.x, m.y + 0.01, m.z, false)) {
      // falls: a fast drop keeps its starting height; when it stops, anything past the safe drop hurts. Coming
      // down a ladder is slower than a fall, so it never counts
      const fallSpeed = (b.y - m.y) / dt;
      if (fallSpeed > 4.5) p.fallFrom = Math.max(p.fallFrom, b.y);
      else {
        const drop = p.fallFrom - m.y;
        if (drop > SAFE_FALL_M) this.damage(p, p, Math.round((drop - SAFE_FALL_M) * FALL_DMG_PER_M), false, m.x, m.y, m.z, p.w);
        p.fallFrom = m.y;
      }
      b.x = m.x; b.y = m.y; b.z = m.z;
    } else {
      p.spawn++; // the client snaps back to the host's position
    }
  }

  // ---------------------------------------------------------------- forklifts

  /** E near a forklift: take the driver's seat, or the thrower's if someone drives; E on board: get off. */
  private useForklift(p: Player) {
    if (!p.alive || this.phase !== "play") return;
    if (p.veh >= 0) { this.leaveForklift(p, true); return; }
    let best: Forklift | null = null, bd = VEH_USE_R;
    for (const f of this.forklifts) {
      const d = Math.hypot(f.st.x - p.body.x, f.st.z - p.body.z);
      if (d < bd && (!f.riders[0] || !f.riders[1])) {
        // a forklift belongs to whichever group gets on first
        const other = f.riders[0] ?? f.riders[1];
        if (other && other.team !== p.team) continue;
        bd = d; best = f;
      }
    }
    if (!best) return;
    const seat = best.riders[0] ? 1 : 0;
    best.riders[seat] = p;
    p.veh = best.id; p.seat = seat; p.reloadUntil = 0;
    if (seat === 0) { best.lastDriveT = this.time; best.rev++; }
    p.spawn++;
    this.placeRider(p, best);
    this.evs.push({ k: "ride", id: p.id, veh: best.id, seat });
  }

  private leaveForklift(p: Player, place: boolean) {
    if (p.veh < 0) return;
    const f = this.forklifts[p.veh];
    if (f.riders[p.seat] === p) f.riders[p.seat] = null;
    p.veh = -1;
    if (!place) return;
    // step off beside it: left, right, behind, in front; the first free spot
    const fx = Math.cos(f.st.yaw), fz = -Math.sin(f.st.yaw);
    for (const [ax, az] of [[0, 1.4], [0, -1.4], [-2.2, 0], [2.4, 0], [0, 2.2], [0, -2.2]]) {
      const x = f.st.x + fx * ax - fz * az, z = f.st.z + fz * ax + fx * az;
      if (x > HALL.x0 + 0.4 && x < HALL.x1 - 0.4 && z > HALL.z0 + 0.4 && z < HALL.z1 - 0.4 && !blocked(x, 0.01, z, false)) {
        p.body.x = x; p.body.y = 0; p.body.z = z; break;
      }
    }
    p.body.vx = p.body.vy = p.body.vz = 0; p.body.onGround = true;
    p.spawn++;
    this.evs.push({ k: "ride", id: p.id, veh: -1, seat: 0 });
  }

  private placeRider(p: Player, f: Forklift) {
    seatPos(f.st, p.seat, tmpSeat);
    p.body.x = tmpSeat[0]; p.body.y = tmpSeat[1]; p.body.z = tmpSeat[2];
    p.body.vx = p.body.vy = p.body.vz = 0;
  }

  /** The driver's predicted pose: accepted when it is a plausible drive from the last one. */
  private onDrive(p: Player, m: Extract<ClientMsg, { t: "drive" }>) {
    if (p.veh < 0 || p.seat !== 0 || !p.alive) return;
    const f = this.forklifts[p.veh];
    if (m.rev !== f.rev) return;
    if (![m.x, m.z, m.yaw, m.speed].every(Number.isFinite)) return;
    const dt = Math.max(0.016, Math.min(0.5, this.time - f.lastDriveT));
    f.lastDriveT = this.time;
    const next = { x: m.x, z: m.z, yaw: m.yaw, speed: Math.max(-VEH_MAX_SPEED, Math.min(VEH_MAX_SPEED, m.speed)) };
    const ok = Math.hypot(m.x - f.st.x, m.z - f.st.z) <= VEH_MAX_SPEED * 1.4 * dt + 0.6 && !vehicleBlocked(next)
      && m.x > HALL.x0 && m.x < HALL.x1 && m.z > HALL.z0 && m.z < HALL.z1;
    if (ok) f.st = next; else f.rev++;
  }

  private stepForklifts(dt: number) {
    const states = this.forklifts.map((f) => f.st);
    for (const f of this.forklifts) {
      // a driven forklift moves by its driver's reports; an empty one rolls to a stop
      if (!f.riders[0]) stepVehicle(f.st, 0, 0, dt, states);
      vehicleBox(f.st, this.dynBoxes[f.id]);
      for (const r of f.riders) if (r) this.placeRider(r, f);
    }
    setDynamicBoxes(this.dynBoxes);
  }

  private onShoot(p: Player, m: Extract<ClientMsg, { t: "shoot" }>) {
    if (!Array.isArray(m.dirs) || !m.dirs.every(Number.isFinite)) return;
    if (m.w !== p.w && p.owned.has(m.w)) p.w = m.w;
    this.fire(p, m.yaw, m.pitch, m.dirs, Number.isFinite(m.view) ? m.view : this.time, 0.04);
  }

  // ---------------------------------------------------------------- combat

  private startReload(p: Player) {
    const w = WEAPONS[p.w];
    if (!p.alive || p.reloadUntil || p.mag[p.w] >= w.mag || p.res[p.w] <= 0) return;
    p.reloadUntil = this.time + w.reloadS;
  }

  private posAt(p: Player, t: number, out: number[]) {
    const b = p.body;
    out[0] = b.x; out[1] = b.y; out[2] = b.z;
    if (t >= this.time - 1e-6 || p.histN === 0) return;
    const n = Math.min(p.histN, HIST);
    for (let i = 0; i < n; i++) {
      const idx = ((p.histN - 1 - i) % HIST) * 4;
      if (p.hist[idx] <= t) {
        if (i === 0) return;
        const nidx = ((p.histN - i) % HIST) * 4;
        const t0 = p.hist[idx], t1 = p.hist[nidx];
        const a = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
        out[0] = p.hist[idx + 1] + (p.hist[nidx + 1] - p.hist[idx + 1]) * a;
        out[1] = p.hist[idx + 2] + (p.hist[nidx + 2] - p.hist[idx + 2]) * a;
        out[2] = p.hist[idx + 3] + (p.hist[nidx + 3] - p.hist[idx + 3]) * a;
        return;
      }
    }
    const idx = ((p.histN - n) % HIST) * 4;
    out[0] = p.hist[idx + 1]; out[1] = p.hist[idx + 2]; out[2] = p.hist[idx + 3];
  }

  private fire(p: Player, yaw: number, pitch: number, dirs: number[], viewT: number, slack: number) {
    const w = WEAPONS[p.w];
    if (!p.alive || this.phase !== "play" || !p.owned.has(p.w) || p.reloadUntil) return;
    if (p.veh >= 0 && p.seat === 0) return; // the driver drives
    if (p.mag[p.w] <= 0 || this.time < p.fireReady - slack) return;
    if (dirs.length !== w.pellets * 3) return;
    p.fireReady = Math.max(this.time, p.fireReady) + 60 / w.rpm;
    p.mag[p.w]--;
    p.lastFire = this.time;
    p.protectUntil = 0;
    const [vx, vy, vz] = viewDir(yaw, pitch);
    const cosMax = Math.cos(w.spread + w.moveSpread + 0.03);
    const lag = Math.max(0, Math.min(MAX_REWIND_S, this.time - viewT));
    const ox = p.body.x, oy = p.body.y + EYE_H, oz = p.body.z;
    const sent: number[] = [];
    for (let i = 0; i < dirs.length; i += 3) {
      let dx = dirs[i], dy = dirs[i + 1], dz = dirs[i + 2];
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) continue;
      dx /= len; dy /= len; dz /= len;
      if (dx * vx + dy * vy + dz * vz < cosMax) { dx = vx; dy = vy; dz = vz; }
      this.boxes.push({ owner: p, team: p.team, w: p.w, x: ox, y: oy, z: oz, vx: dx * w.speed, vy: dy * w.speed, vz: dz * w.speed, dist: 0, born: this.time, lag });
      sent.push(+dx.toFixed(4), +dy.toFixed(4), +dz.toFixed(4));
    }
    this.evs.push({ k: "shot", id: p.id, w: p.w, o: [+ox.toFixed(2), +oy.toFixed(2), +oz.toFixed(2)], dirs: sent });
    if (p.w === "grenade" && p.mag.grenade === 0) { p.w = "rifle"; p.fireReady = this.time + 0.4; }
    else if (p.mag[p.w] === 0) this.startReload(p);
  }

  /** Fly every box one step: walls stop it, the first enemy it meets takes the hit. Teammates let it through. */
  private stepBoxes(dt: number) {
    const pos = [0, 0, 0], tOut = [0];
    for (let i = this.boxes.length - 1; i >= 0; i--) {
      const b = this.boxes[i];
      const nade = b.w === "grenade";
      b.vy -= (nade ? GRENADE_GRAVITY : BOX_GRAVITY) * dt;
      const sp = Math.hypot(b.vx, b.vy, b.vz);
      const dx = b.vx / sp, dy = b.vy / sp, dz = b.vz / sp, seg = sp * dt;
      const tWall = rayWorld(b.x, b.y, b.z, dx, dy, dz, seg);
      let tHit = tWall, hitP: Player | null = null, head = false;
      for (const q of this.players.values()) {
        if (q === b.owner || !q.alive || q.team === b.team) continue;
        this.posAt(q, this.time - b.lag, pos);
        const part = rayPlayer(b.x, b.y, b.z, dx, dy, dz, pos[0], pos[1], pos[2], tOut);
        if (part && tOut[0] < tHit) { tHit = tOut[0]; hitP = q; head = part === 2; }
      }
      b.x += dx * tHit; b.y += dy * tHit; b.z += dz * tHit; b.dist += tHit;
      const w = WEAPONS[b.w];
      if (nade) {
        if (hitP || tWall < seg || this.time - b.born > GRENADE_FUSE_S) { this.boxes.splice(i, 1); this.burst(b); }
      } else if (hitP) {
        const dmg = Math.round(w.dmg * (head ? w.headMul : 1) * falloff(w, b.dist));
        if (dmg > 0) this.damage(hitP, b.owner, dmg, head, b.x, b.y, b.z, b.w);
        this.boxes.splice(i, 1);
      } else if (tWall < seg || b.dist > w.range * 1.2 || this.time - b.born > BOX_LIFE_S) {
        this.boxes.splice(i, 1);
      }
    }
  }

  /** A cardboard grenade bursts: everyone of the other team in reach and in sight of it is hit, the thrower too. */
  private burst(b: Box) {
    // lift the centre off the surface it hit, so the floor or a pallet does not shadow the burst
    const cx = b.x, cy = Math.max(0.3, b.y + 0.2), cz = b.z;
    this.evs.push({ k: "boom", x: +cx.toFixed(2), y: +cy.toFixed(2), z: +cz.toFixed(2) });
    for (const q of this.players.values()) {
      if (!q.alive || (q.team === b.team && q !== b.owner)) continue;
      const d = Math.hypot(q.body.x - cx, q.body.y + 1 - cy, q.body.z - cz);
      if (d > GRENADE_R || !lineOfSight(cx, cy, cz, q.body.x, q.body.y + 1.1, q.body.z)) continue;
      const dmg = Math.round(WEAPONS.grenade.dmg * (1 - d / GRENADE_R) * (q === b.owner ? 0.5 : 1));
      if (dmg > 0) this.damage(q, b.owner, dmg, false, q.body.x, q.body.y + 1.1, q.body.z, "grenade");
    }
  }

  private damage(q: Player, by: Player, dmg: number, head: boolean, x: number, y: number, z: number, w: WeaponId) {
    if (!q.alive || this.time < q.protectUntil || dmg <= 0 || (q.team === by.team && q !== by)) return;
    q.hp -= dmg;
    this.evs.push({ k: "hit", by: by.id, on: q.id, dmg, head, x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2) });
    if (q.brain && by !== q) {
      // whoever hits a bot has its attention, however far away: a perch is no free shooting gallery
      q.brain.alertId = by.id; q.brain.alertUntil = this.time + 5;
      if (q.brain.target === 0) { q.brain.seenX = by.body.x; q.brain.seenZ = by.body.z; q.brain.seenT = this.time; }
    }
    if (q.hp > 0) return;
    this.leaveForklift(q, false);
    q.hp = 0; q.alive = false; q.d++; q.respawnAt = Math.ceil((this.time + MIN_OUT_S) / WAVE_S[q.team]) * WAVE_S[q.team]; q.killedBy = by.name; q.reloadUntil = 0; q.acting = false;
    if (q.carry) { q.carry = false; this.drops.push({ x: q.body.x, z: q.body.z, until: this.time + TAG_DROP_S }); this.evs.push({ k: "obj", what: "tagdrop", id: q.id }); }
    if (by !== q) { by.k++; this.score[by.team]++; }
    this.evs.push({ k: "kill", by: by.id, on: q.id, w, head });
  }

  private endMatch(winner: Team, reason: "server" | "tags" | "time") {
    if (this.phase !== "play") return;
    this.phase = "end";
    this.phaseEnd = this.time + END_S;
    let mvp: Player | null = null;
    for (const p of this.players.values()) if (!mvp || p.k > mvp.k || (p.k === mvp.k && p.d < mvp.d)) mvp = p;
    this.evs.push({ k: "end", winner, reason, mvp: mvp?.name ?? "" });
  }

  /** The mission, once a tick: the server connection, or the cases of watch tags on their way. */
  private stepMission(dt: number) {
    const l = layout();
    if (this.mission === "server") {
      let on = false;
      for (const p of this.players.values()) {
        if (p.team === 1 && p.alive && p.acting && p.veh < 0 && Math.hypot(p.body.x - l.server.x, p.body.z - l.server.z) <= CONNECT_R) { on = true; break; }
      }
      if (on && !this.connecting && this.time - this.lastConnectEv > 8) { this.lastConnectEv = this.time; this.evs.push({ k: "obj", what: "connect", id: 0 }); }
      this.connecting = on;
      this.progress = on ? this.progress + dt / CONNECT_S : Math.max(0, this.progress - dt / CONNECT_DECAY_S);
      if (this.progress >= 1) { this.progress = 1; this.endMatch(1, "server"); }
    } else {
      for (let i = this.drops.length - 1; i >= 0; i--) if (this.time >= this.drops[i].until) this.drops.splice(i, 1);
      for (const p of this.players.values()) {
        if (!p.alive || p.veh >= 0 && p.seat === 0 && false) continue;
        const b = p.body;
        // a dropped case: a technician picks it back up, a worker confiscates it
        for (let i = this.drops.length - 1; i >= 0; i--) {
          const d = this.drops[i];
          if (Math.hypot(b.x - d.x, b.z - d.z) > 1.6 || b.y > 1.5) continue;
          if (p.team === 1 && !p.carry) { p.carry = true; this.drops.splice(i, 1); this.evs.push({ k: "obj", what: "tagpick", id: p.id }); }
          else if (p.team === 0) { this.drops.splice(i, 1); this.evs.push({ k: "obj", what: "tagseized", id: p.id }); }
        }
        if (p.team !== 1) continue;
        if (!p.carry) {
          for (const s of l.supply) if (Math.hypot(b.x - s.x, b.z - s.z) <= 2.6) { p.carry = true; this.evs.push({ k: "obj", what: "tagpick", id: p.id }); break; }
        } else {
          for (const s of l.stations) {
            if (Math.hypot(b.x - s.x, b.z - s.z) > 2.6) continue;
            p.carry = false; this.delivered++;
            this.evs.push({ k: "obj", what: "tagdeliver", id: p.id });
            if (this.delivered >= TAGS_NEED) this.endMatch(1, "tags");
            break;
          }
        }
      }
    }
  }

  private respawn(p: Player) {
    // Grupa A holds the west of the hall, Grupa B the east: prefer a spawn on our own side, far from live enemies,
    // picked among the best three so it is not predictable
    const scored = SPAWNS.map(([x, z]) => {
      let near = 400;
      for (const q of this.players.values()) if (q !== p && q.alive && q.team !== p.team) near = Math.min(near, Math.hypot(q.body.x - x, q.body.z - z));
      // the hall is long: come back on our side, not on top of an enemy but not a minute's walk from the fight either
      const home = (p.team === 0 ? -x : x) > 0 ? 1000 : 0;
      return { x, z, near: home - Math.abs(near - 55) - (near < 25 ? 300 : 0) };
    }).sort((a, b) => b.near - a.near);
    const s = scored[Math.floor(this.rand() * Math.min(3, scored.length))];
    p.body.x = s.x; p.body.y = 0; p.body.z = s.z; p.body.vx = p.body.vy = p.body.vz = 0; p.body.onGround = true;
    p.yaw = Math.atan2(s.x, s.z); // face the middle of the hall
    p.pitch = 0;
    this.leaveForklift(p, false);
    p.hp = 100; p.alive = true; p.killedBy = "";
    p.owned = new Set<WeaponId>(["rifle", "pistol", "grenade"]);
    p.w = "rifle";
    p.mag = { rifle: WEAPONS.rifle.mag, pistol: WEAPONS.pistol.mag, shotgun: 0, grenade: WEAPONS.grenade.mag };
    p.res = { rifle: WEAPONS.rifle.reserve, pistol: WEAPONS.pistol.reserve, shotgun: 0, grenade: 0 };
    p.reloadUntil = 0; p.fireReady = this.time + 0.3;
    p.fallFrom = 0;
    p.spawn++; p.protectUntil = this.time + SPAWN_PROTECT_S; p.geoUntil = 0; p.histN = 0;
    p.lastStateT = this.time;
    p.acting = false; p.carry = false;
    if (p.brain) {
      p.brain.path = null; p.brain.target = 0; p.brain.seenT = -99; p.brain.repathAt = 0;
      // most technicians work the mission; most workers guard it, the rest go looking for trouble
      p.brain.job = this.rand() < (p.team === 1 ? 0.75 : 0.6) ? "mission" : "hunt";
      p.brain.station = Math.floor(this.rand() * 3);
      p.brain.lane = Math.floor(this.rand() * 3) - 1; p.brain.laneDone = false;
    }
  }

  // ---------------------------------------------------------------- the tick

  step(dt: number) {
    this.time += dt;
    useLayout(this.layout);
    if (this.phase === "lobby") return;
    if (this.phase === "brief") {
      if (this.time >= this.phaseEnd) { this.phase = "play"; this.phaseEnd = this.time + MISSION_TIME_S; for (const p of this.players.values()) { p.protectUntil = this.time + SPAWN_PROTECT_S; p.lastStateT = this.time; } }
      return;
    }
    if (this.phase === "end") {
      if (this.time >= this.phaseEnd) {
        // back to the lobby: the bots go home, the people stay in their teams
        for (const p of [...this.players.values()]) if (p.bot) this.players.delete(p.id);
        this.phase = "lobby";
        this.evs.push({ k: "lobby" });
      }
      return;
    }
    this.stepForklifts(dt);
    if (this.time >= this.phaseEnd) this.endMatch(0, "time");

    for (const p of this.players.values()) {
      if (!p.alive) { if (this.time >= p.respawnAt) this.respawn(p); continue; }
      if (p.reloadUntil && this.time >= p.reloadUntil) {
        const w = WEAPONS[p.w], need = w.mag - p.mag[p.w], take = Math.min(need, p.res[p.w]);
        p.mag[p.w] += take; if (p.res[p.w] < 900) p.res[p.w] -= take; p.reloadUntil = 0;
      }
      if (p.brain) this.botTick(p, dt);
      this.touchPickups(p);
      const idx = (p.histN % HIST) * 4;
      p.hist[idx] = this.time; p.hist[idx + 1] = p.body.x; p.hist[idx + 2] = p.body.y; p.hist[idx + 3] = p.body.z;
      p.histN++;
    }
    this.stepBoxes(dt);
    this.stepMission(dt);
  }

  private touchPickups(p: Player) {
    for (let i = 0; i < this.pickups.length; i++) {
      const pk = this.pickups[i];
      if (this.time < pk.readyAt) continue;
      if (Math.hypot(p.body.x - pk.spot.x, p.body.z - pk.spot.z) > 1.1 || p.body.y > 1.2) continue;
      let used = false;
      switch (pk.spot.kind) {
        case "med": if (p.hp < 100) { p.hp = Math.min(100, p.hp + 50); used = true; } break;
        case "ammo":
          if (p.res.rifle < WEAPONS.rifle.reserve || p.mag.grenade < WEAPONS.grenade.mag || (p.owned.has("shotgun") && p.res.shotgun < WEAPONS.shotgun.reserve)) {
            p.res.rifle = WEAPONS.rifle.reserve; p.mag.grenade = WEAPONS.grenade.mag;
            if (p.owned.has("shotgun")) p.res.shotgun = WEAPONS.shotgun.reserve;
            used = true;
          }
          break;
        case "shotgun":
          if (!p.owned.has("shotgun") || p.res.shotgun < WEAPONS.shotgun.reserve) {
            if (!p.owned.has("shotgun")) p.mag.shotgun = WEAPONS.shotgun.mag;
            p.owned.add("shotgun"); p.res.shotgun = WEAPONS.shotgun.reserve; used = true;
            if (p.bot) { p.w = "shotgun"; p.reloadUntil = 0; }
          }
          break;
        case "geo": p.geoUntil = this.time + GEO_S; used = true; break;
      }
      if (used) { pk.readyAt = this.time + PICKUP_RESPAWN_S[pk.spot.kind]; this.evs.push({ k: "pick", id: p.id, p: i, kind: pk.spot.kind }); }
    }
  }

  // ---------------------------------------------------------------- bots

  private botTick(p: Player, dt: number) {
    const br = p.brain!;
    const cfg = DIFF[this.config.difficulty];
    const b = p.body;
    const ex = b.x, ey = b.y + EYE_H, ez = b.z;

    if (this.time >= br.nextThink) {
      br.nextThink = this.time + 0.1 + this.rand() * 0.05;
      let best: Player | null = null, bestD = Infinity;
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      for (const q of this.players.values()) {
        if (q === p || !q.alive || q.team === p.team) continue;
        const dx = q.body.x - ex, dz = q.body.z - ez, d = Math.hypot(dx, dz);
        const alerted = q.id === br.alertId && this.time < br.alertUntil && d < 110;
        if (d > cfg.view && !alerted) continue;
        const heard = this.time - q.lastFire < 0.8 && d < 28;
        const inFov = (dx * fx + dz * fz) / (d || 1) > -0.25;
        if (!inFov && !heard && !alerted && d > 4) continue;
        if (!lineOfSight(ex, ey, ez, q.body.x, q.body.y + 1.3, q.body.z)) continue;
        if (d < bestD) { bestD = d; best = q; }
      }
      if (best) {
        if (br.target !== best.id) { br.target = best.id; br.reactAt = this.time + cfg.react * (0.7 + this.rand() * 0.6); }
        br.seenX = best.body.x; br.seenZ = best.body.z; br.seenT = this.time;
      } else br.target = 0;

      // where to walk when not fighting
      if (!best) {
        let gx = br.goalX, gz = br.goalZ, need = !br.path || br.pi >= br.path.length;
        if (this.time - br.seenT < 4 && Math.hypot(br.seenX - b.x, br.seenZ - b.z) > 1.5) { gx = br.seenX; gz = br.seenZ; need = need || Math.hypot(gx - br.goalX, gz - br.goalZ) > 2; }
        else if (p.hp < 45) {
          const med = this.nearestPickup(p, "med");
          if (med) { gx = med.x; gz = med.z; need = need || Math.hypot(gx - br.goalX, gz - br.goalZ) > 1; }
        } else if (br.job === "mission" && this.missionGoal(p, goalTmp)) {
          // the mission comes first: the technicians go for the objective, the workers stand around it
          if (Math.hypot(goalTmp[0] - br.goalX, goalTmp[1] - br.goalZ) > 1.5) { gx = goalTmp[0]; gz = goalTmp[1]; need = true; }
        } else if (need) {
          // the hall is big: mostly head for where an enemy is, so the teams meet instead of wandering apart
          const roll = this.rand();
          const foes = [...this.players.values()].filter((q) => q.alive && q.team !== p.team);
          if (roll < 0.65 && foes.length) {
            const foe = foes[Math.floor(this.rand() * foes.length)];
            gx = foe.body.x + (this.rand() - 0.5) * 16; gz = foe.body.z + (this.rand() - 0.5) * 16;
          } else if (roll < 0.85) {
            const near = this.pickups.filter((pk) => this.time >= pk.readyAt && Math.hypot(pk.spot.x - b.x, pk.spot.z - b.z) < 50);
            const pk = near[Math.floor(this.rand() * near.length)];
            if (pk) { gx = pk.spot.x; gz = pk.spot.z; } else [gx, gz] = randomFree(this.rand);
          } else [gx, gz] = randomFree(this.rand);
        }
        if (need || this.time >= br.repathAt) {
          br.goalX = gx; br.goalZ = gz;
          br.path = findPath(b.x, b.z, gx, gz); br.pi = 0;
          br.repathAt = this.time + 3.5 + this.rand() * 1.5;
        }
      }
      // stuck check once a second
      if (this.time >= br.stuckCheck) {
        if (br.path && Math.hypot(b.x - br.lastX, b.z - br.lastZ) < 0.3 && !best) { br.path = null; br.jump = true; }
        br.lastX = b.x; br.lastZ = b.z; br.stuckCheck = this.time + 1;
      }
    }

    let mx = 0, mz = 0, sprint = false;
    const srv = layout().server;
    p.acting = this.mission === "server" && p.team === 1 && br.job === "mission" && Math.hypot(b.x - srv.x, b.z - srv.z) <= CONNECT_R - 0.3;
    const tgt = br.target ? this.players.get(br.target) : undefined;
    if (tgt && tgt.alive) {
      const dx = tgt.body.x - ex, dz = tgt.body.z - ez, d = Math.hypot(dx, dz);
      // weapon choice
      // a grenade now and then at a target standing off at mid range; otherwise the right launcher for the distance
      if (p.w !== "grenade" && p.mag.grenade > 0 && d > 12 && d < 34 && this.time >= br.reactAt && this.rand() < 0.0012) { p.w = "grenade"; p.reloadUntil = 0; p.fireReady = Math.max(p.fireReady, this.time + 0.4); }
      const want: WeaponId = p.w === "grenade" && p.mag.grenade > 0 ? "grenade"
        : p.owned.has("shotgun") && p.mag.shotgun + p.res.shotgun > 0 && d < 11 ? "shotgun"
        : p.mag.rifle + p.res.rifle > 0 ? "rifle" : "pistol";
      if (want !== p.w && !p.reloadUntil) { p.w = want; p.fireReady = Math.max(p.fireReady, this.time + 0.3); }
      if (this.time >= br.errUntil) {
        const e = cfg.aimErr * (1 + Math.min(1.5, d / 30));
        br.errYaw = (this.rand() * 2 - 1) * e; br.errPitch = (this.rand() * 2 - 1) * e * 0.6; br.errUntil = this.time + 0.35 + this.rand() * 0.3;
      }
      const aimY = tgt.body.y + (this.config.difficulty === "hard" && this.rand() < 0.3 ? 1.6 : 1.25) - ey;
      // boxes take time to arrive and drop a little: lead a moving target (how well depends on the level) and aim
      // above it by the drop over the flight
      const speed = WEAPONS[p.w].speed;
      this.posAt(tgt, this.time - 0.1, leadPos);
      const flight = d / speed;
      const px = dx + (tgt.body.x - leadPos[0]) * 10 * flight * cfg.lead, pz = dz + (tgt.body.z - leadPos[2]) * 10 * flight * cfg.lead;
      const pd = Math.hypot(px, pz), pf = pd / speed;
      const wantYaw = Math.atan2(-px, -pz) + br.errYaw;
      // a grenade is lobbed: the low arc that lands at the target's feet
      const wantPitch = (p.w === "grenade" ? lobPitch(pd, tgt.body.y + 0.3 - ey) : Math.atan2(aimY + 0.5 * BOX_GRAVITY * pf * pf, pd)) + br.errPitch;
      let dy = wantYaw - p.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      const turn = cfg.turn * dt;
      p.yaw += Math.max(-turn, Math.min(turn, dy));
      p.pitch += Math.max(-turn, Math.min(turn, wantPitch - p.pitch));
      // strafe, close in or back off
      if (this.time >= br.strafeUntil) { br.strafe = this.rand() < 0.5 ? -1 : 1; br.strafeUntil = this.time + 0.5 + this.rand() * 1.1; }
      const ux = dx / (d || 1), uz = dz / (d || 1);
      const pref = p.w === "shotgun" ? 5 : 16;
      const fwd = d > pref * 1.3 ? 0.8 : d < pref * 0.5 ? -0.6 : 0;
      mx = ux * fwd + -uz * br.strafe * 0.8;
      mz = uz * fwd + ux * br.strafe * 0.8;
      if (!freeAt(b.x + mx * 0.8, b.z + mz * 0.8)) { br.strafe = -br.strafe; mx = ux * fwd; mz = uz * fwd; }
      // a technician at the server holds on to the cable and fights from there
      if (p.acting) { mx = 0; mz = 0; }
      // fire in bursts once the reaction time has passed and the aim is close
      if (this.time >= br.reactAt && Math.abs(dy) < 0.12 + 0.6 / Math.max(2, d)) {
        if (this.time < br.pauseUntil) { /* between bursts */ }
        else {
          if (!br.burstUntil) br.burstUntil = this.time + cfg.burst * (0.6 + this.rand() * 0.8);
          if (this.time < br.burstUntil) {
            const w = WEAPONS[p.w];
            const cone = w.spread + (Math.hypot(b.vx, b.vz) > 1 ? w.moveSpread * 0.5 : 0);
            if (this.time >= p.fireReady && p.mag[p.w] > 0 && !p.reloadUntil) this.fire(p, p.yaw, p.pitch, spreadDirs(p.yaw, p.pitch, cone, w.pellets, this.rand), this.time, 0);
            if (!w.auto) br.burstUntil = Math.min(br.burstUntil, p.fireReady + 0.05);
          } else { br.burstUntil = 0; br.pauseUntil = this.time + cfg.pause * (0.6 + this.rand() * 0.8); }
        }
      }
      if (p.mag[p.w] === 0) this.startReload(p);
    } else {
      if (p.mag[p.w] < WEAPONS[p.w].mag * 0.5) this.startReload(p);
      if (br.path && br.pi < br.path.length) {
        let [wx, wz] = br.path[br.pi];
        if (Math.hypot(wx - b.x, wz - b.z) < 0.6) { br.pi++; if (br.pi < br.path.length) [wx, wz] = br.path[br.pi]; }
        if (br.pi < br.path.length) {
          const dx = wx - b.x, dz = wz - b.z, d = Math.hypot(dx, dz) || 1;
          mx = dx / d; mz = dz / d; sprint = p.hp > 30;
          let dy = Math.atan2(-mx, -mz) - p.yaw;
          while (dy > Math.PI) dy -= Math.PI * 2;
          while (dy < -Math.PI) dy += Math.PI * 2;
          p.yaw += Math.max(-4 * dt, Math.min(4 * dt, dy));
          p.pitch *= 0.9;
        }
      }
    }
    const jump = br.jump; br.jump = false;
    stepBody(b, { mx, mz, jump, sprint }, dt);
    p.moving = Math.hypot(b.vx, b.vz) > 0.5;
  }

  /**
   * Where a bot on mission duty should be heading; false when it has nothing to do there right now.
   * Technicians: the server, or the delivery point and then a charging station. Workers: a post near the objective.
   */
  private missionGoal(p: Player, out: number[]): boolean {
    const l = layout(), br = p.brain!, b = p.body;
    if (p.team === 1) {
      // on the way west, first through the middle by this life's route, so the push does not always come the same way
      const loaded = this.mission === "server" || p.carry;
      if (loaded && !br.laneDone) {
        if (b.x < 12) br.laneDone = true;
        else { out[0] = 8; out[1] = br.lane * 30 + (br.lane === 0 ? 2 : 0); if (freeAt(out[0], out[1])) return true; br.laneDone = true; }
      }
      if (this.mission === "server") { out[0] = l.server.x; out[1] = l.server.z; return !p.acting; }
      if (!p.carry) {
        // a dropped case nearby is quicker than the walk back to the docks
        let best = null as { x: number; z: number } | null, bd = 60;
        for (const d of this.drops) { const dist = Math.hypot(d.x - b.x, d.z - b.z); if (dist < bd) { bd = dist; best = d; } }
        if (!best) { bd = Infinity; for (const sp of l.supply) { const dist = Math.hypot(sp.x - b.x, sp.z - b.z); if (dist < bd) { bd = dist; best = sp; } } }
        out[0] = best!.x; out[1] = best!.z; return true;
      }
      const st = l.stations[br.station % l.stations.length];
      out[0] = st.x; out[1] = st.z; return true;
    }
    // workers: keep a post within ~16 m of what they defend; pick a new post once the old one is reached
    let ox: number, oz: number;
    if (this.mission === "server") { ox = l.server.x; oz = l.server.z; }
    else if (this.drops.length) { ox = this.drops[0].x; oz = this.drops[0].z; out[0] = ox; out[1] = oz; return true; }
    else { const st = l.stations[br.station % l.stations.length]; ox = st.x; oz = st.z; }
    const atPost = Math.hypot(br.goalX - ox, br.goalZ - oz) < 18;
    if (atPost && Math.hypot(b.x - br.goalX, b.z - br.goalZ) > 1.5) { out[0] = br.goalX; out[1] = br.goalZ; return true; }
    if (atPost && this.rand() > 0.02) { out[0] = br.goalX; out[1] = br.goalZ; return true; }
    for (let tries = 0; tries < 12; tries++) {
      const x = ox + (this.rand() - 0.5) * 30, z = oz + (this.rand() - 0.5) * 30;
      if (freeAt(x, z)) { out[0] = x; out[1] = z; return true; }
    }
    out[0] = ox; out[1] = oz; return true;
  }

  private nearestPickup(p: Player, kind: PickupKind) {
    let best: { x: number; z: number } | null = null, bd = Infinity;
    for (const pk of this.pickups) {
      if (pk.spot.kind !== kind || this.time < pk.readyAt) continue;
      const d = Math.hypot(pk.spot.x - p.body.x, pk.spot.z - p.body.z);
      if (d < bd && walkable(pk.spot.x, pk.spot.z, pk.spot.x, pk.spot.z)) { bd = d; best = pk.spot; }
    }
    return best;
  }

  // ---------------------------------------------------------------- output

  drainEvents(): Ev[] { const e = this.evs; this.evs = []; return e; }

  private snapCache: { t: number; list: PlayerSnap[] } = { t: -1, list: [] };

  snapshot(forId: number): HostMsg | null {
    const me = this.players.get(forId);
    if (!me) return null;
    if (this.snapCache.t !== this.time) {
      const list: PlayerSnap[] = [];
      for (const p of this.players.values()) {
        list.push({
          id: p.id, n: p.name, bot: p.bot, c: p.color, tm: p.team, veh: p.veh, seat: p.seat, carry: p.carry,
          x: +p.body.x.toFixed(3), y: +p.body.y.toFixed(3), z: +p.body.z.toFixed(3), yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3),
          hp: p.hp, alive: p.alive, w: p.w, k: p.k, d: p.d, fired: +Math.min(99, this.time - p.lastFire).toFixed(2),
        });
      }
      this.snapCache = { t: this.time, list };
    }
    const self: SelfSnap = {
      hp: me.hp, alive: me.alive, w: me.w, team: me.team, mag: { ...me.mag }, res: { ...me.res }, owned: [...me.owned],
      spawn: me.spawn, x: me.body.x, y: me.body.y, z: me.body.z, yaw: me.yaw,
      veh: me.veh, seat: me.seat, vrev: me.veh >= 0 ? this.forklifts[me.veh].rev : 0,
      reloading: !!me.reloadUntil, respawnIn: me.alive ? 0 : Math.max(0, me.respawnAt - this.time),
      geo: Math.max(0, me.geoUntil - this.time), killedBy: me.killedBy, carry: me.carry,
    };
    const obj: ObjSnap = this.mission === "server" ? { p: +this.progress.toFixed(3), on: this.connecting }
      : { n: this.delivered, need: TAGS_NEED, drops: this.drops.map((d) => [+d.x.toFixed(1), +d.z.toFixed(1)]) };
    return {
      t: "snap", time: +this.time.toFixed(3), phase: this.phase,
      left: this.phase === "lobby" ? 0 : Math.max(0, this.phaseEnd - this.time),
      layout: this.layout, mission: this.mission, obj, config: this.config, host: this.hostId,
      score: [this.score[0], this.score[1]], players: this.snapCache.list,
      vehicles: this.forklifts.map((f) => ({ id: f.id, x: +f.st.x.toFixed(3), z: +f.st.z.toFixed(3), yaw: +f.st.yaw.toFixed(4), speed: +f.st.speed.toFixed(2), d: f.riders[0]?.id ?? 0, g: f.riders[1]?.id ?? 0 })), pickups: this.pickups.map((pk) => this.time >= pk.readyAt), me: self,
    };
  }
}

/** Every box the hall has, for a quick sanity check by tools. */
export const BOX_COUNT = BOXES.length;
export { PLAYER_H };
