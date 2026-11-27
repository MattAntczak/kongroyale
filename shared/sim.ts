// The efectivo ARENA host: the warehouse workers (role 0, defending) against the efectivo technicians (role 1,
// attacking), played in rounds like a bomb-defusal match. The technicians connect a server (or fit the watch tags)
// at point A or B; it then takes BOOT_S to start, and the workers have that long to disconnect it. Nobody comes back
// during a round; a round also ends when a whole team is out. The sides swap at half time, the first to ROUNDS_WIN
// rounds wins. A room goes lobby -> briefing -> rounds (freeze, play, round end) -> end and back to the lobby. The host owns health, ammo, kills, pickups, respawns, the mission and the bots. The same class runs inside the Node server (online rooms) and inside the browser (bot
// matches), so both play by identical rules.
//
// Authority: a human's movement is predicted by their own client and sent here; the host checks every step against
// the walls and a speed limit and sends a correction when one fails. Shots are decided here: each one launches real
// cardboard boxes that fly tick by tick, and a box tests players where the shooter saw them (up to 300 ms back).

import { BOXES, PICKUPS, SPAWNS, HALL, LAYOUTS, HALL_LAYOUTS, DEPOT_LAYOUT, SORT_LAYOUT, VEHICLE_SPAWNS, sites, useLayout, type Box as HallBox, type PickupKind, type PickupSpot } from "./map";
import { SEATS, VEH_MAX_SPEED, VEH_USE_R, rideSpeed, seatPos, stepVehicle, vehicleBlocked, vehicleBox, type VehicleState } from "./vehicle";
import { BOX_HIT_PAD, CROUCH_H, CROUCH_MUL, GRAVITY, JUMP_V, MAX_FOOT_SPEED, PLAYER_R, STEP_H, STEP_SPEED, STOP_DECEL, TUCK, PLAYER_H, blocked, ladderAt, bodyH, eyeH, lineOfSight, rayPlayer, rayWorld, setDynamicBoxes, stepBody, supported, viewDir, type Body } from "./physics";
import { BOX_GRAVITY, BOX_LIFE_S, GRENADE_FUSE_S, GRENADE_GRAVITY, GRENADE_R, WEAPONS, PRICES, SHOP, MONEY_START, MONEY_MAX, MONEY_WIN, MONEY_LOSS, MONEY_KILL, MONEY_POINT, BUY_S, falloff, lobPitch, maxSpeed, newAim, resetAim, settleAim, aimCone, kickAim, type AimState, type WeaponId } from "./weapons";
import { findPath, freeAt, randomFree, walkable } from "./nav";
import type { ClientMsg, Config, Difficulty, Ev, HostMsg, Mission, ObjSnap, PlayerSnap, SelfSnap } from "./proto";

export const TICK_HZ = 60;
/** Most players in one team, people and bots together. */
export const MAX_TEAM = 20;
export const TEAM_NAMES = ["Pracownicy magazynu", "Technicy efectivo"] as const;
export const TEAM_SHORT = ["Pracownicy", "Technicy"] as const;
/** A round: the technicians have this long to connect, unless the server is already starting. */
export const ROUND_S = 300;
/** Rounds needed to win the match; the sides swap after SWAP_AFTER rounds. */
export const ROUNDS_WIN = 4;
export const SWAP_AFTER = 3;
/** The briefing (the loading screen with the mission), the freeze before each round, the pause after it. */
export const BRIEF_S = 20;
export const FREEZE_S = 6;
export const ROUND_END_S = 6;
export const END_S = 12;
/** Connecting takes PLANT_S of holding E, the start-up BOOT_S, disconnecting DEFUSE_S. Letting go starts over. */
export const PLANT_S = 4;
export const BOOT_S = 40;
export const DEFUSE_S = 7;
/** How close to point A or B one has to stand. */
export const SITE_R = 3;
export const SPAWN_PROTECT_S = 1.5;
export const GEO_S = 10;
export const MAX_REWIND_S = 0.3;
/** A drop of more than this (metres) hurts; each further metre costs FALL_DMG_PER_M health. */
export const SAFE_FALL_M = 4.5;
export const FALL_DMG_PER_M = 14;
const HIST = 48;
/** One history entry: time, x, y, z, crouched. */
const HS = 5;
/** The host's movement check: a budget of metres that refills at the top speed of what the host saw (with slack)
 *  and holds at most MOVE_BURST, so bunched-up messages pass and a steady over-speed runs dry within a few seconds. */
const MOVE_SLACK = 1.05;
const MOVE_BURST = 1.5;
/** On the ground the top speed is the launcher's run (crouched: the crouch's share of it), with more slack than in the
 *  air: the budget spent on a lag burst comes back within a couple of seconds of running flat out. */
const GROUND_SLACK = 1.15;
const CROUCH_SLACK = 1.3;
/** The host's own speed of a person comes from the positions it accepted, at most one per tick (states chopped up or
 *  bunched into one tick count once), joined by straight lines and measured over windows of SPEED_WIN seconds. */
const SPEED_WIN = 1 / 60;
const SPEED_SAMPLES = 16;
/** How long after its latest state a throw may come and still be judged by it alone (the state and the throw are sent
 *  together and normally land in one tick): the time grace of a counter-strafe. */
const SHOT_GRACE_S = 0.01;
/** Gravity on the host: no state may put the feet higher than one jump (with the crouch-jump's tuck) above where the
 *  host last saw them held up, and once that jump would be past its top they have to come down at least as fast as
 *  they fall, AIR_JIT_S late (states sent between ticks and network jitter). JUMP_RISE ≈ 1.05 m, JUMP_UP_S ≈ 0.31 s. */
const JUMP_RISE = (JUMP_V * JUMP_V) / (2 * GRAVITY);
const JUMP_UP_S = JUMP_V / GRAVITY;
const RISE = JUMP_RISE + TUCK + 0.06;
const AIR_JIT_S = 0.2;
/** A state that comes late (a lag burst) does not count its wait into the fall: up to LAG_CREDIT_S of waiting is
 *  forgiven, refilled at a tenth of real time, so a client cannot slow the clock by sending rarely. */
const LAG_CREDIT_S = 0.4;
/** Bots hear someone running this close (metres): a little less than people do (25 m), they do not listen as well. */
const STEP_HEAR_M = 20;
const leadPos = [0, 0, 0];
const mvA = [0, 0], mvB = [0, 0];
const tmpSeat = [0, 0, 0];
const goalTmp = [0, 0];
/** The highest box top a body with its feet at `y` could step up onto (STEP_H, twice at most) on its way from
 *  (ax, az) to (bx, bz): a step-up and a jump can both fall between two states. */
function stepTop(ax: number, az: number, bx: number, bz: number, y: number): number {
  const x0 = Math.min(ax, bx) - PLAYER_R, x1 = Math.max(ax, bx) + PLAYER_R, z0 = Math.min(az, bz) - PLAYER_R, z1 = Math.max(az, bz) + PLAYER_R;
  let top = y;
  for (let pass = 0; pass < 2; pass++) {
    const from = top;
    for (const b of BOXES) if (b.y1 > top && b.y1 <= from + STEP_H + 0.002 && b.x1 > x0 && b.x0 < x1 && b.z1 > z0 && b.z0 < z1) top = b.y1;
  }
  return top;
}
/** The technicians' routes west: way points as [x, z]; the flank's z is mirrored for the north and the south. */
const ROUTE_MID = [[120, 2.5], [40, -12], [-45, 2.5]];
const ROUTE_FLANK = [[170, 102.5], [20, 106], [-66, 100]];

const BOT_NAMES = ["Zenek", "Halina", "Mirek", "Grażyna", "Waldek", "Bożena", "Rysiek", "Danuta", "Kazik", "Wiesia", "Janusz", "Krystyna", "Staszek", "Jadwiga", "Heniek", "Tereska", "Bogdan", "Irena"];
const PICKUP_RESPAWN_S: Record<PickupKind, number> = { med: 20, ammo: 15, geo: 45 };

// `still`: the speed under which a bot lets go of a throw (it stops first, as a player counter-strafes); `comp`: how
// much of the recoil punch it pulls down against; `crouch`: the chance it crouches for a burst at mid range;
// `holdCrouch`: the chance a guard that was holding an angle crouches for its first burst
const DIFF = {
  easy: { react: 0.6, aimErr: 0.11, turn: 3.2, view: 32, burst: 0.35, pause: 0.55, lead: 0.3, strafe: 0.45, still: 99, comp: 0.3, crouch: 0, holdCrouch: 0 },
  normal: { react: 0.35, aimErr: 0.06, turn: 5.5, view: 45, burst: 0.5, pause: 0.35, lead: 0.7, strafe: 0.75, still: 2.2, comp: 0.6, crouch: 0, holdCrouch: 0.5 },
  hard: { react: 0.2, aimErr: 0.03, turn: 9, view: 60, burst: 0.8, pause: 0.2, lead: 1, strafe: 1, still: 1.2, comp: 0.85, crouch: 0.4, holdCrouch: 0.7 },
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
  /** Crouching for this burst. */
  crouch: boolean;
  /** Who last hit us, and until when we look for them beyond our normal view. */
  alertId: number; alertUntil: number;
  /** This life's job: work the mission (attack or guard the objective) or hunt the other team. */
  job: "mission" | "hunt"; station: number;
  /** The route a technician takes through the middle this life: −1 north floor, 0 main aisle, 1 south floor. */
  lane: number; wp: number;
  /** A worker who walks between A and B instead of holding one: when they next change over. */
  roverAt: number;
  /** A worker who keeps their point when the other one is called (one per point); the way an idle guard faces,
   *  worked out once per post (NaN: not yet). */
  anchor: boolean; faceYaw: number; faceX: number; faceZ: number;
  /** This fight began with the bot holding an angle: it stands its ground (no side steps) until it has thrown once. */
  held: boolean;
  /** A technician who goes for the other point this round (a lurker): it pulls guards away from the main push. */
  lurk: boolean;
}

export type Team = 0 | 1;

interface Player {
  id: number; name: string; bot: boolean; color: number; team: Team;
  body: Body; yaw: number; pitch: number; moving: boolean;
  hp: number; alive: boolean; respawnAt: number; killedBy: string;
  w: WeaponId; mag: Record<WeaponId, number>; res: Record<WeaponId, number>; owned: Set<WeaponId>;
  /** Money for the shop. */
  money: number;
  fireReady: number; lastFire: number; reloadUntil: number;
  k: number; d: number; spawn: number; protectUntil: number; geoUntil: number;
  lastStateT: number;
  /** Accuracy and recoil of the launcher in hand. */
  aim: AimState;
  /** People: horizontal speed seen over the last 0.1 s of accepted positions, the movement budget (MOVE_BURST). */
  hspeed: number; budget: number;
  /** Accepted positions as [time, x, z], newest last (SPEED_SAMPLES of them): the host's own speed of this player. */
  mv: Float64Array; mvN: number;
  /** Gravity (see RISE): the highest the feet may go before they fall, the clock of that fall (0 at the jump's top),
   *  whether the last accepted pose was held up (ground, a box, a forklift, a ladder), the credit for late states, and
   *  a correction to start the next state from. */
  topY: number; fallT: number; held: boolean; lagCredit: number; vfix: boolean;
  hist: Float64Array; histN: number;
  brain: Brain | null;
  /** The forklift this player rides (-1 on foot) and the seat: 0 drives, 1 throws from the rear platform. */
  veh: number; seat: number;
  /** Where the current fall started (the highest point since we last stood still vertically). */
  fallFrom: number;
  /** Holding E at a point; carrying the case of watch tags. */
  acting: boolean; carry: boolean;
  /** The side this player joined in the lobby (their team for the whole match); `team` is their role this half. */
  group: Team;
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
  phase: "lobby" | "brief" | "freeze" | "play" | "round" | "end" = "lobby";
  /** What the next shift will be: bots per team, the mission, the bots' level. Set in the lobby by the host. */
  config: Config = { bots: [5, 5], mission: "random", map: "depot", difficulty: "normal" };
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
  // round state
  round = 0;
  /** Rounds won by each lobby team. */
  readonly wins: [number, number] = [0, 0];
  private swapped = false;
  /** Progress of a connection being made (0…1) and of a disconnection; which point is starting up (-1 = none). */
  private plant = 0;
  private defuse = 0;
  private armed = -1;
  private playStart = 0;
  private bootEnd = 0;
  /** The point the technicians' bots go for this round. */
  private botSite = 0;
  /** When a worker last saw a technician close to point A or B (the call that brings the other point's guards over),
   *  and where the technicians started this round (idle guards face the way in from there). */
  private seenAtSite = [-99, -99];
  private techFrom = [0, 0];
  /** The case of watch tags when it lies on the floor. */
  private caseAt: { x: number; z: number } | null = null;
  private lastActEv = -99;
  private spawnSeq: [number, number] = [0, 0];

  constructor(readonly opts: SimOptions = {}) {
    this.rand = mulberry32(opts.seed ?? 1234567);
    this.layout = Math.floor(this.rand() * HALL_LAYOUTS);
  }

  get humanCount() { let n = 0; for (const p of this.players.values()) if (!p.bot) n++; return n; }

  private newPlayer(name: string, bot: boolean, team: Team): Player {
    const p: Player = {
      id: this.nextId++, name, bot, color: this.colorSeq++ % 10, team,
      body: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: true }, yaw: 0, pitch: 0, moving: false,
      hp: 100, alive: true, respawnAt: 0, killedBy: "",
      money: MONEY_START, w: "pistol", mag: { rifle: 0, pistol: 0, shotgun: 0, sniper: 0, grenade: 0 }, res: { rifle: 0, pistol: 0, shotgun: 0, sniper: 0, grenade: 0 }, owned: new Set(),
      fireReady: 0, lastFire: -99, reloadUntil: 0, k: 0, d: 0, spawn: 0, protectUntil: 0, geoUntil: 0, lastStateT: 0,
      aim: newAim(), hspeed: 0, budget: MOVE_BURST, mv: new Float64Array(SPEED_SAMPLES * 3), mvN: 0,
      topY: 0, fallT: 0, held: true, lagCredit: LAG_CREDIT_S, vfix: false,
      hist: new Float64Array(HIST * HS), histN: 0,
      veh: -1, seat: 0, fallFrom: 0, acting: false, carry: false, group: team,
      brain: bot ? {
        path: null, pi: 0, goalX: 0, goalZ: 0, repathAt: 0, target: 0, reactAt: 0, strafe: 1, strafeUntil: 0,
        errYaw: 0, errPitch: 0, errUntil: 0, nextThink: 0, seenX: 0, seenZ: 0, seenT: -99, lastX: 0, lastZ: 0, stuckCheck: 0,
        burstUntil: 0, pauseUntil: 0, jump: false, crouch: false, alertId: 0, alertUntil: 0, job: "mission", station: 0, lane: 0, wp: 0, roverAt: 0,
        anchor: false, faceYaw: NaN, faceX: NaN, faceZ: NaN, held: false, lurk: false,
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
    if (p.carry) this.caseAt = { x: p.body.x, z: p.body.z };
    if (this.hostId === id) { this.hostId = 0; for (const q of this.players.values()) if (!q.bot) { this.hostId = q.id; break; } }
  }

  // ---------------------------------------------------------------- lobby and shift

  private setTeam(p: Player, team: number) {
    if (this.phase !== "lobby" || (team !== 0 && team !== 1) || p.team === team) return;
    if (this.teamCount(team as Team, true) >= MAX_TEAM) return;
    p.team = p.group = team as Team;
  }

  private setConfig(p: Player, c: Config) {
    if (this.phase !== "lobby" || p.id !== this.hostId || !c || !Array.isArray(c.bots)) return;
    const n = (v: unknown) => Math.max(0, Math.min(MAX_TEAM, Math.floor(Number(v) || 0)));
    this.config = {
      bots: [n(c.bots[0]), n(c.bots[1])],
      mission: c.mission === "server" || c.mission === "tags" ? c.mission : "random",
      map: c.map === "hall" || c.map === "sort" ? c.map : "depot",
      difficulty: c.difficulty === "easy" || c.difficulty === "hard" ? c.difficulty : "normal",
    };
  }

  /** Start a shift: a new hall configuration, the mission, the bots, then the briefing. */
  begin(forceLayout = -1) {
    if (this.phase !== "lobby") return;
    // a different configuration from last time (tests may name one)
    this.layout = forceLayout >= 0 ? forceLayout : this.config.map === "depot" ? DEPOT_LAYOUT : this.config.map === "sort" ? SORT_LAYOUT
      : ((this.layout % HALL_LAYOUTS) + 1 + Math.floor(this.rand() * (HALL_LAYOUTS - 1))) % HALL_LAYOUTS;
    useLayout(this.layout);
    this.mission = this.config.mission === "random" ? (this.rand() < 0.5 ? "server" : "tags") : this.config.mission;
    for (const p of [...this.players.values()]) if (p.bot) this.players.delete(p.id);
    this.botName = Math.floor(this.rand() * BOT_NAMES.length);
    for (const t of [0, 1] as const) {
      const want = Math.min(this.config.bots[t], MAX_TEAM - this.teamCount(t, true));
      for (let i = 0; i < want; i++) this.newPlayer(BOT_NAMES[this.botName++ % BOT_NAMES.length], true, t);
    }
    this.score[0] = 0; this.score[1] = 0;
    this.wins[0] = 0; this.wins[1] = 0; this.round = 0; this.swapped = false;
    this.boxes.length = 0;
    this.forklifts = VEHICLE_SPAWNS.map((v, i) => ({ id: i, st: { x: v.x, z: v.z, yaw: v.yaw, speed: 0 }, riders: [null, null], rev: 0, lastDriveT: 0 }));
    this.dynBoxes = VEHICLE_SPAWNS.map(() => ({ kind: "forklift", x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 }));
    this.pickups = PICKUPS.map((spot) => ({ spot, readyAt: 0 }));
    for (const p of this.players.values()) { p.k = 0; p.d = 0; p.veh = -1; p.team = p.group; p.money = MONEY_START; this.respawn(p, false); }
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
      case "switch": if (p.owned.has(m.w) && p.w !== m.w) { p.w = m.w; p.reloadUntil = 0; p.fireReady = Math.max(p.fireReady, this.time + 0.25); resetAim(p.aim); } break;
      case "use": this.useForklift(p); break;
      case "act": p.acting = !!m.on; break;
      case "team": this.setTeam(p, m.team); break;
      case "config": this.setConfig(p, m.config); break;
      case "start": if (p.id === this.hostId) this.begin(); break;
      case "buy": this.buy(p, m.item); break;
      case "drive": this.onDrive(p, m); break;
      case "chat": { const text = String(m.text).slice(0, 120).trim(); if (text) this.evs.push({ k: "chat", name: p.name, text }); break; }
    }
  }

  private onState(p: Player, m: Extract<ClientMsg, { t: "state" }>) {
    if (!p.alive || m.spawn !== p.spawn || (this.phase !== "play" && this.phase !== "round")) return;
    if (![m.x, m.y, m.z, m.yaw, m.pitch].every(Number.isFinite)) return;
    p.yaw = m.yaw;
    p.pitch = Math.max(-1.5, Math.min(1.5, m.pitch));
    p.moving = !!m.moving;
    if (p.veh >= 0) return; // riders go where the forklift goes
    const dt = Math.max(0, Math.min(0.5, this.time - p.lastStateT));
    p.lastStateT = this.time;
    const b = p.body;
    const crouch = !!m.crouch, h = crouch ? CROUCH_H : PLAYER_H;
    const dh = Math.hypot(m.x - b.x, m.z - b.z);
    // the speed limit as a budget of metres: it refills with the time between messages, so two messages that arrive
    // in one tick pass, while a client that keeps moving faster than it can runs it dry. How fast it can: on the ground
    // the running speed of the launcher in hand, crouched (in this state or the last) the crouch's share of it; in the
    // air (a crouch-jump keeps its run-up, an air strafe) or on a ladder, the fastest anyone moves on foot. Slowing
    // down after a landing, a crouch or a change of launcher takes a moment: the budget carries that
    const ground = this.standsAt(b.x, b.y, b.z) && this.standsAt(m.x, m.y, m.z);
    const cap = ground ? maxSpeed(p.w, false) * (crouch || b.crouch ? CROUCH_MUL * CROUCH_SLACK : GROUND_SLACK) : MAX_FOOT_SPEED * MOVE_SLACK;
    p.budget = Math.min(MOVE_BURST, p.budget + cap * dt);
    const okSpeed = dh <= p.budget + 0.05;
    const okY = m.y >= -0.01 && m.y <= HALL.h && m.y - b.y <= 1.6 * Math.max(dt, 0.1) * 8;
    const inside = m.x > HALL.x0 && m.x < HALL.x1 && m.z > HALL.z0 && m.z < HALL.z1;
    // gravity: the feet go up only by a jump (the tuck, a step-up just before it) from where they were last held up, or
    // on a ladder; in the air they come down. A state that arrives late does not count its wait
    const forgive = Math.min(p.lagCredit, Math.max(0, dt - 0.05));
    p.lagCredit = Math.min(LAG_CREDIT_S, p.lagCredit - forgive + dt * 0.1);
    let fallT = p.fallT + dt - forgive, top = p.topY, held0 = p.held;
    if (p.vfix) {
      // after a correction the client starts again from the host's pose, at rest: from there it only falls (or jumps,
      // when that pose stands on something), never higher than before
      p.vfix = false;
      held0 = this.standsAt(b.x, b.y, b.z) || !!ladderAt(b.x, b.y, b.z);
      if (held0) top = b.y + RISE; else { top = Math.min(top, b.y + TUCK + 0.06); fallT = 0; }
    }
    if (held0) top = Math.max(top, stepTop(b.x, b.z, m.x, m.z, b.y) + RISE);
    const onLadder = !!ladderAt(m.x, m.y, m.z);
    const okFall = onLadder || m.y <= top - 0.5 * GRAVITY * Math.max(0, fallT - AIR_JIT_S) ** 2;
    // standing (or claiming to) needs head room for the whole body: nobody stands up into a low ceiling. The test body
    // is lifted 1 cm off the floor and is 2 cm short, so one the client has just stopped against a ceiling
    // (stepBody leaves it 1 mm under) is not stuck in it. Forklifts are left out: the client saw them a moment ago
    if (okSpeed && okY && okFall && inside && !blocked(m.x, m.y + 0.01, m.z, false, h - 0.02)) {
      p.budget -= dh;
      b.crouch = crouch;
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
      this.sample(p);
      p.hspeed = this.winSpeed(p, p.mv[(p.mvN - 1) % SPEED_SAMPLES * 3], 0.1);
      p.held = this.standsAt(m.x, m.y, m.z) || onLadder;
      if (p.held) { p.topY = m.y + RISE; p.fallT = -JUMP_UP_S; } else { p.topY = top; p.fallT = fallT; }
    } else {
      p.spawn++; // the client snaps back to the host's position
      p.vfix = true;
    }
  }

  /** Feet held up at (x, y, z): the floor or a box top (supported), or the roof of a forklift (the client saw it a
   *  moment ago, the host sees it now: a metre of slack around it). */
  private standsAt(x: number, y: number, z: number): boolean {
    if (supported(x, y, z)) return true;
    for (const d of this.dynBoxes) {
      if (y - d.y1 > -0.02 && y - d.y1 < 0.08 && x + PLAYER_R + 1 > d.x0 && x - PLAYER_R - 1 < d.x1 && z + PLAYER_R + 1 > d.z0 && z - PLAYER_R - 1 < d.z1) return true;
    }
    return false;
  }

  /** Remember an accepted position (one per tick: a later state in the same tick replaces the earlier). */
  private sample(p: Player) {
    const last = (p.mvN - 1) % SPEED_SAMPLES * 3;
    if (p.mvN === 0 || p.mv[last] !== this.time) p.mvN++;
    const i = (p.mvN - 1) % SPEED_SAMPLES * 3;
    p.mv[i] = this.time; p.mv[i + 1] = p.body.x; p.mv[i + 2] = p.body.z;
  }

  /** Where the accepted positions put a player at time `t` (straight lines between them; the ends held). */
  private mvAt(p: Player, t: number, out: number[]) {
    const n = Math.min(p.mvN, SPEED_SAMPLES);
    let j = (p.mvN - 1) % SPEED_SAMPLES * 3;
    out[0] = p.mv[j + 1]; out[1] = p.mv[j + 2];
    if (t >= p.mv[j]) return;
    for (let i = 1; i < n; i++) {
      const k = (p.mvN - 1 - i) % SPEED_SAMPLES * 3;
      if (p.mv[k] <= t) {
        const a = (t - p.mv[k]) / (p.mv[j] - p.mv[k]);
        out[0] = p.mv[k + 1] + (p.mv[j + 1] - p.mv[k + 1]) * a; out[1] = p.mv[k + 2] + (p.mv[j + 2] - p.mv[k + 2]) * a;
        return;
      }
      j = k;
    }
    out[0] = p.mv[j + 1]; out[1] = p.mv[j + 2];
  }

  /** Horizontal speed over the `w` seconds up to `end`, from the accepted positions (never more than anyone runs). */
  private winSpeed(p: Player, end: number, w: number): number {
    if (p.mvN < 2) return 0;
    this.mvAt(p, end, mvA); this.mvAt(p, end - w, mvB);
    return Math.min(MAX_FOOT_SPEED, Math.hypot(mvA[0] - mvB[0], mvA[1] - mvB[1]) / w);
  }

  /** The least speed a person can have at a throw, from the host's own record: what the positions showed, SPEED_WIN
   *  by SPEED_WIN back from the latest, less what a body can shed since (STOP_DECEL: a counter-strafe) in the time
   *  since then plus SHOT_GRACE_S. The client sends its state right before every throw, so for it the latest position
   *  is the moment of the throw; one that holds its states back is judged by the last it sent. So a stop counts once
   *  the positions show it, and a runner that suddenly holds still has to hold still as long as stopping takes. */
  private seenSpeed(p: Player): number {
    if (p.mvN < 2) return 0;
    const tL = p.mv[(p.mvN - 1) % SPEED_SAMPLES * 3];
    let lb = 0;
    for (let k = 0; k < 8; k++) {
      lb = Math.max(lb, this.winSpeed(p, tL - k * SPEED_WIN, SPEED_WIN) - STOP_DECEL * (SPEED_WIN * (k + 0.5) + SHOT_GRACE_S));
    }
    return lb;
  }

  /** Start the host's record of a person's movement afresh where the body now is (a spawn, getting on or off). */
  private resetMove(p: Player) {
    p.mvN = 0; this.sample(p);
    p.hspeed = 0; p.budget = MOVE_BURST;
    p.topY = p.body.y + RISE; p.fallT = -JUMP_UP_S; p.held = true; p.vfix = false; p.lagCredit = LAG_CREDIT_S;
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
    // a rider stands (or sits) as the client shows it: onState skips the stance while riding
    p.body.crouch = false; p.body.tucked = false;
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
    p.body.crouch = false; p.body.tucked = false;
    this.resetMove(p);
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

  /**
   * A person's throw. The client only says where it looked (without the punch); the host works out the cone and the
   * punch from its own record of this player (the burst, the stance, the speed it saw) and draws the spread from its
   * own random numbers. So no client can throw a straight spray or a dead-on throw on the run: it can only aim. The
   * client's own speed and air claims count only where they are worse than what the host saw (seenSpeed: the positions
   * over time, less what a counter-strafe can shed since). A rider on the rear platform is never in the air and moves
   * as the forklift does (rideSpeed). The client predicts the same way and lines its boxes up with the host's when the
   * "shot" event comes back (by `n`).
   */
  private onShoot(p: Player, m: Extract<ClientMsg, { t: "shoot" }>) {
    if (![m.yaw, m.pitch].every(Number.isFinite)) return;
    if (m.w !== p.w && p.owned.has(m.w)) { p.w = m.w; resetAim(p.aim); }
    const b = p.body;
    const riding = p.veh >= 0;
    const seen = riding ? rideSpeed(this.forklifts[p.veh].st) : this.seenSpeed(p);
    const spd = riding ? seen : Math.max(Number.isFinite(m.spd) ? Math.max(0, m.spd as number) : 0, seen);
    const air = !riding && (!!m.air || !this.standsAt(b.x, b.y, b.z));
    const sight = !!m.sight && WEAPONS[p.w].zoom > 1;
    this.fire(p, m.yaw, m.pitch, Number.isFinite(m.view) ? m.view : this.time, 0.04, spd, air, sight, 0, Number.isFinite(m.n) ? m.n : undefined);
  }

  // ---------------------------------------------------------------- combat

  private startReload(p: Player) {
    const w = WEAPONS[p.w];
    if (!p.alive || p.reloadUntil || p.mag[p.w] >= w.mag || p.res[p.w] <= 0) return;
    p.reloadUntil = this.time + w.reloadS;
  }

  /** Where a player was at time `t` (lag compensation): x, y, z and whether crouched (1) in out[0…3]. */
  private posAt(p: Player, t: number, out: number[]) {
    const b = p.body;
    out[0] = b.x; out[1] = b.y; out[2] = b.z; out[3] = b.crouch ? 1 : 0;
    if (t >= this.time - 1e-6 || p.histN === 0) return;
    const n = Math.min(p.histN, HIST);
    for (let i = 0; i < n; i++) {
      const idx = ((p.histN - 1 - i) % HIST) * HS;
      if (p.hist[idx] <= t) {
        if (i === 0) return;
        const nidx = ((p.histN - i) % HIST) * HS;
        const t0 = p.hist[idx], t1 = p.hist[nidx];
        const a = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
        out[0] = p.hist[idx + 1] + (p.hist[nidx + 1] - p.hist[idx + 1]) * a;
        out[1] = p.hist[idx + 2] + (p.hist[nidx + 2] - p.hist[idx + 2]) * a;
        out[2] = p.hist[idx + 3] + (p.hist[nidx + 3] - p.hist[idx + 3]) * a;
        out[3] = p.hist[a < 0.5 ? idx + 4 : nidx + 4];
        return;
      }
    }
    const idx = ((p.histN - n) % HIST) * HS;
    out[0] = p.hist[idx + 1]; out[1] = p.hist[idx + 2]; out[2] = p.hist[idx + 3]; out[3] = p.hist[idx + 4];
  }

  /** The cone (radians) a player's next throw would have right now, from the host's own record. For tests and bots. */
  coneOf(id: number, spd = 0, air = false, sight = false): number {
    const p = this.players.get(id);
    if (!p) return 0;
    const w = WEAPONS[p.w];
    settleAim(p.aim, w, this.time);
    return aimCone(w, p.aim, spd, air, !!p.body.crouch, sight);
  }

  /**
   * Throw from `p`'s eye along the view (yaw, pitch) plus the recoil punch, spread over this player's cone. `comp` is
   * the share of the punch the thrower pulls down against (bots; people do it with the mouse, so 0).
   */
  private fire(p: Player, yaw: number, pitch: number, viewT: number, slack: number, spd: number, air: boolean, sight: boolean, comp: number, n?: number) {
    const w = WEAPONS[p.w];
    if (!p.alive || this.phase !== "play" || !p.owned.has(p.w) || p.reloadUntil) return;
    if (p.veh >= 0 && p.seat === 0) return; // the driver drives
    if (p.mag[p.w] <= 0 || this.time < p.fireReady - slack) return;
    p.fireReady = Math.max(this.time, p.fireReady) + 60 / w.rpm;
    p.mag[p.w]--;
    p.lastFire = this.time;
    p.protectUntil = 0;
    settleAim(p.aim, w, this.time);
    const cone = aimCone(w, p.aim, spd, air, !!p.body.crouch, sight);
    const dirs = spreadDirs(yaw + p.aim.py * (1 - comp), pitch + p.aim.pp * (1 - comp), cone, w.pellets, this.rand);
    kickAim(p.aim, p.w, this.time);
    const lag = Math.max(0, Math.min(MAX_REWIND_S, this.time - viewT));
    const ox = p.body.x, oy = p.body.y + eyeH(p.body.crouch), oz = p.body.z;
    const sent: number[] = [];
    for (let i = 0; i < dirs.length; i += 3) {
      const dx = dirs[i], dy = dirs[i + 1], dz = dirs[i + 2];
      this.boxes.push({ owner: p, team: p.team, w: p.w, x: ox, y: oy, z: oz, vx: dx * w.speed, vy: dy * w.speed, vz: dz * w.speed, dist: 0, born: this.time, lag });
      sent.push(+dx.toFixed(4), +dy.toFixed(4), +dz.toFixed(4));
    }
    this.evs.push({ k: "shot", id: p.id, w: p.w, o: [+ox.toFixed(2), +oy.toFixed(2), +oz.toFixed(2)], dirs: sent, ...(n !== undefined ? { n } : {}) });
    if (p.w === "grenade" && p.mag.grenade === 0) { p.owned.delete("grenade"); p.w = p.owned.has("rifle") ? "rifle" : p.owned.has("sniper") ? "sniper" : p.owned.has("shotgun") ? "shotgun" : "pistol"; p.fireReady = this.time + 0.4; }
    else if (p.mag[p.w] === 0) this.startReload(p);
  }

  /** Fly every box one step: walls stop it, the first enemy it meets takes the hit. Teammates let it through. */
  private stepBoxes(dt: number) {
    const pos = [0, 0, 0, 0], tOut = [0];
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
        const part = rayPlayer(b.x, b.y, b.z, dx, dy, dz, pos[0], pos[1], pos[2], tOut, BOX_HIT_PAD, pos[3] ? CROUCH_H : PLAYER_H);
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
      const mid = bodyH(q.body) * 0.6;
      const d = Math.hypot(q.body.x - cx, q.body.y + mid - cy, q.body.z - cz);
      if (d > GRENADE_R || !lineOfSight(cx, cy, cz, q.body.x, q.body.y + mid, q.body.z)) continue;
      const dmg = Math.round(WEAPONS.grenade.dmg * (1 - d / GRENADE_R) * (q === b.owner ? 0.5 : 1));
      if (dmg > 0) this.damage(q, b.owner, dmg, false, q.body.x, q.body.y + 1.1, q.body.z, "grenade");
    }
  }

  private damage(q: Player, by: Player, dmg: number, head: boolean, x: number, y: number, z: number, w: WeaponId) {
    if (!q.alive || this.time < q.protectUntil || dmg <= 0 || (q.team === by.team && q !== by)) return;
    q.hp -= dmg;
    this.evs.push({ k: "hit", by: by.id, on: q.id, dmg, head, x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2) });
    if (q.team === 0 && by.team === 1 && this.armed < 0) this.callSite(by.body.x, by.body.z);
    if (q.brain && by !== q) {
      // whoever hits a bot has its attention, however far away: a perch is no free shooting gallery
      q.brain.alertId = by.id; q.brain.alertUntil = this.time + 5;
      if (q.brain.target === 0) { q.brain.seenX = by.body.x; q.brain.seenZ = by.body.z; q.brain.seenT = this.time; }
    }
    if (q.hp > 0) return;
    this.leaveForklift(q, false);
    q.hp = 0; q.alive = false; q.d++; q.killedBy = by.name; q.reloadUntil = 0; q.acting = false;
    if (q.carry) { q.carry = false; this.caseAt = { x: q.body.x, z: q.body.z }; this.evs.push({ k: "obj", what: "casedrop", id: q.id, site: 0 }); }
    if (by !== q) { by.k++; this.score[by.team]++; this.pay(by, MONEY_KILL); }
    this.evs.push({ k: "kill", by: by.id, on: q.id, w, head });
  }

  // ---------------------------------------------------------------- rounds

  /** Everyone back on their side, the points reset, the case to one technician; then the freeze. */
  private startRound() {
    this.round++;
    let fresh = false;
    if (this.round === SWAP_AFTER + 1 && !this.swapped) {
      // half time: the teams trade roles, and everybody starts over with the starting money and the Paczkownik
      this.swapped = true; fresh = true;
      for (const p of this.players.values()) { p.team = (1 - p.group) as Team; p.money = MONEY_START; }
    }
    this.plant = 0; this.defuse = 0; this.armed = -1; this.caseAt = null; this.boxes.length = 0;
    this.botSite = this.rand() < 0.5 ? 0 : 1;
    this.forklifts = VEHICLE_SPAWNS.map((v, i) => ({ id: i, st: { x: v.x, z: v.z, yaw: v.yaw, speed: 0 }, riders: [null, null], rev: (this.forklifts[i]?.rev ?? 0) + 1, lastDriveT: 0 }));
    for (const pk of this.pickups) pk.readyAt = 0;
    this.spawnSeq = [Math.floor(this.rand() * 10), Math.floor(this.rand() * 10)];
    // whoever lived through the last round keeps their launchers; the others are back to the Paczkownik
    for (const p of this.players.values()) { p.veh = -1; this.respawn(p, p.alive && !fresh); if (p.bot) this.botBuy(p); }
    // the worker bots split evenly over A and B with one anchor on each, as a CS team sets up its defence
    this.seenAtSite = [-99, -99];
    const guards = [...this.players.values()].filter((p) => p.team === 0 && p.brain);
    const first = Math.floor(this.rand() * 2);
    guards.forEach((p, i) => { p.brain!.station = (first + i) % 2; p.brain!.anchor = i < 2; });
    const techs = [...this.players.values()].filter((p) => p.team === 1);
    // one technician bot in five lurks at the other point (with five or more of them); with the case it plants there
    const tbots = techs.filter((p) => p.brain);
    tbots.forEach((p) => { p.brain!.lurk = false; });
    if (tbots.length >= 4) for (let k = 0; k < Math.floor(tbots.length / 5); k++) tbots[Math.floor(this.rand() * tbots.length)].brain!.lurk = true;
    this.techFrom = techs.length ? [techs.reduce((a, p) => a + p.body.x, 0) / techs.length, techs.reduce((a, p) => a + p.body.z, 0) / techs.length] : [0, 0];
    if (this.mission === "tags") {
      const techs = [...this.players.values()].filter((p) => p.team === 1);
      const holder = techs[Math.floor(this.rand() * techs.length)];
      if (holder) holder.carry = true;
    }
    this.phase = "freeze";
    this.phaseEnd = this.time + FREEZE_S;
    this.evs.push({ k: "round", n: this.round, swapped: this.swapped });
  }

  /** `role` wins the round; the match ends when a team has ROUNDS_WIN. */
  private endRound(role: Team, reason: "plant" | "defuse" | "time" | "out") {
    if (this.phase !== "play") return;
    const group = this.swapped ? 1 - role : role;
    this.wins[group]++;
    this.phase = "round";
    this.phaseEnd = this.time + ROUND_END_S;
    for (const p of this.players.values()) { p.acting = false; this.pay(p, p.team === role ? MONEY_WIN : MONEY_LOSS); }
    this.evs.push({ k: "roundEnd", winner: role, group, reason, wins: [this.wins[0], this.wins[1]] });
  }

  private endMatch() {
    this.phase = "end";
    this.phaseEnd = this.time + END_S;
    let mvp: Player | null = null;
    for (const p of this.players.values()) if (!mvp || p.k > mvp.k || (p.k === mvp.k && p.d < mvp.d)) mvp = p;
    this.evs.push({ k: "end", group: this.wins[0] > this.wins[1] ? 0 : 1, wins: [this.wins[0], this.wins[1]], mvp: mvp?.name ?? "" });
  }

  /** The round, once a tick: connecting, the start-up, disconnecting, the case on the floor, who is still standing. */
  private stepRound(dt: number) {
    const pts = sites(this.mission);
    // a team with nobody in it at all cannot be "out" (someone trying the hall alone)
    let alive0 = 0, alive1 = 0, any0 = false, any1 = false;
    for (const p of this.players.values()) {
      if (p.team === 0) { any0 = true; if (p.alive) alive0++; } else { any1 = true; if (p.alive) alive1++; }
    }
    const at = (p: Player, i: number) => p.alive && p.veh < 0 && p.body.y < 1.5 && Math.hypot(p.body.x - pts[i].x, p.body.z - pts[i].z) <= SITE_R;

    if (this.mission === "tags" && this.caseAt) {
      // the case on the floor: the first technician to step on it carries it on
      for (const p of this.players.values()) {
        if (p.team !== 1 || !p.alive || p.body.y > 1.5 || Math.hypot(p.body.x - this.caseAt.x, p.body.z - this.caseAt.z) > 1.6) continue;
        p.carry = true; this.caseAt = null; this.evs.push({ k: "obj", what: "casepick", id: p.id, site: 0 });
        break;
      }
    }

    if (this.armed < 0) {
      // connecting: a technician holding E at A or B (with the case, when the mission is the tags)
      let who: Player | null = null, site = 0;
      for (const p of this.players.values()) {
        if (p.team !== 1 || !p.acting || (this.mission === "tags" && !p.carry)) continue;
        for (let i = 0; i < pts.length; i++) if (at(p, i)) { who = p; site = i; }
        if (who) break;
      }
      if (who) {
        if (this.plant === 0 && this.time - this.lastActEv > 5) { this.lastActEv = this.time; this.evs.push({ k: "obj", what: "plant", id: who.id, site }); }
        this.plant += dt / PLANT_S;
        if (this.plant >= 1) {
          this.armed = site; this.bootEnd = this.time + BOOT_S; this.plant = 0; who.carry = false; this.lastActEv = -99;
          this.evs.push({ k: "obj", what: "armed", id: who.id, site }); this.pay(who, MONEY_POINT);
        }
      } else this.plant = 0;
      if (this.armed < 0) {
        if (alive1 === 0 && any1) return this.endRound(0, "out");
        if (this.time >= this.phaseEnd) return this.endRound(0, "time");
      }
    } else {
      // starting up: a worker holding E at that point disconnects it
      let who: Player | null = null;
      for (const p of this.players.values()) if (p.team === 0 && p.acting && at(p, this.armed)) { who = p; break; }
      if (who) {
        if (this.defuse === 0 && this.time - this.lastActEv > 5) { this.lastActEv = this.time; this.evs.push({ k: "obj", what: "defuse", id: who.id, site: this.armed }); }
        this.defuse += dt / DEFUSE_S;
        if (this.defuse >= 1) { this.pay(who, MONEY_POINT); this.evs.push({ k: "obj", what: "defused", id: who.id, site: this.armed }); return this.endRound(0, "defuse"); }
      } else this.defuse = 0;
      if (this.time >= this.bootEnd) return this.endRound(1, "plant");
    }
    if (alive0 === 0 && any0) this.endRound(1, "out");
  }

  private pay(p: Player, sum: number) { p.money = Math.min(MONEY_MAX, p.money + sum); }

  /** The shop is open through the freeze and the first seconds of the round. */
  private canBuy(p: Player) { return p.alive && (this.phase === "freeze" || (this.phase === "play" && this.time < this.playStart + BUY_S)); }

  private buy(p: Player, item: WeaponId, open = this.canBuy(p)) {
    // the item comes straight from a client: only what the shop sells, and only with the money for it
    if (typeof item !== "string" || !SHOP.includes(item)) return;
    const price = PRICES[item];
    if (!open || !(p.money >= price)) return;
    if (item === "grenade") {
      if (p.mag.grenade >= WEAPONS.grenade.mag) return;
      p.mag.grenade++; p.owned.add("grenade");
    } else {
      if (p.owned.has(item)) return;
      p.owned.add(item); p.mag[item] = WEAPONS[item].mag; p.res[item] = WEAPONS[item].reserve;
      p.w = item; p.reloadUntil = 0;
    }
    p.money -= price;
  }

  /** A bot spends what it has (called while the round is being set up, just before the shop opens for people): usually the Kartonomiot, now and then the Paletówka or the Dalekomiot, then grenades. */
  private botBuy(p: Player) {
    const r = this.rand();
    if (!p.owned.has("rifle") && !p.owned.has("sniper") && !p.owned.has("shotgun")) {
      // the Dalekomiot only together with a Kartonomiot for close quarters
      if (p.money >= PRICES.sniper + PRICES.rifle && r < 0.2) { this.buy(p, "sniper", true); this.buy(p, "rifle", true); }
      else if (p.money >= PRICES.rifle) this.buy(p, "rifle", true);
      else if (p.money >= PRICES.shotgun && r < 0.5) this.buy(p, "shotgun", true);
    } else if (!p.owned.has("rifle") && p.money >= PRICES.rifle + 1000) this.buy(p, "rifle", true);
    for (let k = 0; k < WEAPONS.grenade.mag && p.money >= PRICES.grenade + 1500; k++) this.buy(p, "grenade", true);
  }

  /** Back to the spawn for a new round. `keep`: the launchers survive (their owner did); otherwise only the Paczkownik. */
  private respawn(p: Player, keep = false) {
    // the workers start in the west of the hall, the technicians at the docks in the east; each takes the next free
    // spawn of their side
    const mine = LAYOUTS[this.layout].teamSpawns?.[p.team] ?? SPAWNS.filter(([x]) => (p.team === 0 ? x < 0 : x > 0));
    const [sx, sz] = mine[this.spawnSeq[p.team]++ % mine.length];
    // more players than spawn points: later ones stand a step aside
    const lap = Math.floor((this.spawnSeq[p.team] - 1) / mine.length) % 4;
    let s = { x: sx, z: sz };
    for (const [ox, oz] of [[0, 0], [1.2, 0], [0, 1.2], [-1.2, 0], [0, -1.2]].slice(lap)) {
      if (!blocked(sx + ox, 0.01, sz + oz, false)) { s = { x: sx + ox, z: sz + oz }; break; }
    }
    p.body.x = s.x; p.body.y = 0; p.body.z = s.z; p.body.vx = p.body.vy = p.body.vz = 0; p.body.onGround = true;
    p.body.crouch = false; p.body.tucked = false;
    resetAim(p.aim); this.resetMove(p);
    p.yaw = Math.atan2(s.x, s.z); // face the middle of the hall
    p.pitch = 0;
    this.leaveForklift(p, false);
    p.hp = 100; p.alive = true; p.killedBy = "";
    const nades = keep ? p.mag.grenade : 0;
    if (!keep) p.owned = new Set<WeaponId>(["pistol"]);
    p.owned.add("pistol");
    // every launcher that is still owned starts the round full
    for (const w of ["rifle", "pistol", "shotgun", "sniper"] as const) { p.mag[w] = p.owned.has(w) ? WEAPONS[w].mag : 0; p.res[w] = p.owned.has(w) ? WEAPONS[w].reserve : 0; }
    p.mag.grenade = nades; p.res.grenade = 0;
    if (nades) p.owned.add("grenade"); else p.owned.delete("grenade");
    p.w = p.owned.has("rifle") ? "rifle" : p.owned.has("sniper") ? "sniper" : p.owned.has("shotgun") ? "shotgun" : "pistol";
    p.reloadUntil = 0; p.fireReady = this.time + 0.3;
    p.fallFrom = 0;
    p.spawn++; p.protectUntil = this.time + SPAWN_PROTECT_S; p.geoUntil = 0; p.histN = 0;
    p.lastStateT = this.time;
    p.acting = false; p.carry = false;
    if (p.brain) {
      p.brain.path = null; p.brain.target = 0; p.brain.seenT = -99; p.brain.repathAt = 0;
      // most technicians go for the point; most workers guard A or B, the rest go looking for trouble
      p.brain.job = "mission";
      p.brain.roverAt = this.rand() < 0.3 ? this.time + 20 + this.rand() * 20 : Infinity;
      p.brain.station = Math.floor(this.rand() * 2); p.brain.faceYaw = NaN; p.brain.faceX = NaN;
      p.brain.lane = Math.floor(this.rand() * 3) - 1; p.brain.wp = 0;
    }
  }

  // ---------------------------------------------------------------- the tick

  step(dt: number) {
    this.time += dt;
    useLayout(this.layout);
    if (this.phase === "lobby") return;
    if (this.phase === "brief") { if (this.time >= this.phaseEnd) this.startRound(); return; }
    if (this.phase === "freeze") {
      if (this.time >= this.phaseEnd) {
        this.phase = "play"; this.playStart = this.time; this.phaseEnd = this.time + (LAYOUTS[this.layout].roundS ?? ROUND_S);
        for (const p of this.players.values()) { p.protectUntil = this.time + SPAWN_PROTECT_S; p.lastStateT = this.time; }
      }
      return;
    }
    if (this.phase === "end") {
      if (this.time >= this.phaseEnd) {
        // back to the lobby: the bots go home, the people stay in the teams they chose
        for (const p of [...this.players.values()]) { if (p.bot) this.players.delete(p.id); else p.team = p.group; }
        this.phase = "lobby";
        this.evs.push({ k: "lobby" });
      }
      return;
    }
    if (this.phase === "round" && this.time >= this.phaseEnd) {
      if (Math.max(this.wins[0], this.wins[1]) >= ROUNDS_WIN) this.endMatch(); else this.startRound();
      return;
    }
    this.stepForklifts(dt);

    for (const p of this.players.values()) {
      if (!p.alive) continue; // out until the next round
      if (p.reloadUntil && this.time >= p.reloadUntil) {
        const w = WEAPONS[p.w], need = w.mag - p.mag[p.w], take = Math.min(need, p.res[p.w]);
        p.mag[p.w] += take; if (p.res[p.w] < 900) p.res[p.w] -= take; p.reloadUntil = 0;
      }
      if (p.brain && this.phase === "play") this.botTick(p, dt);
      this.touchPickups(p);
      const idx = (p.histN % HIST) * HS;
      p.hist[idx] = this.time; p.hist[idx + 1] = p.body.x; p.hist[idx + 2] = p.body.y; p.hist[idx + 3] = p.body.z; p.hist[idx + 4] = p.body.crouch ? 1 : 0;
      p.histN++;
    }
    this.stepBoxes(dt);
    if (this.phase === "play") this.stepRound(dt);
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
          // a refill for every launcher in hand (grenades are bought)
          for (const w of ["rifle", "shotgun", "sniper"] as const) if (p.owned.has(w) && p.res[w] < WEAPONS[w].reserve) { p.res[w] = WEAPONS[w].reserve; used = true; }
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
    const ex = b.x, ey = b.y + eyeH(b.crouch), ez = b.z;

    if (this.time >= br.nextThink) {
      br.nextThink = this.time + 0.1 + this.rand() * 0.05;
      let best: Player | null = null, bestD = Infinity;
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      // a guard standing at the post holds an angle: it sees a little further and fires a little sooner at what walks
      // into the way it watches, which is the defender's edge in CS (the attackers bring the numbers)
      const holding = p.team === 0 && this.armed < 0 && !br.target && Number.isFinite(br.faceYaw) && Math.hypot(b.vx, b.vz) < 0.5;
      for (const q of this.players.values()) {
        if (q === p || !q.alive || q.team === p.team) continue;
        const dx = q.body.x - ex, dz = q.body.z - ez, d = Math.hypot(dx, dz);
        const alerted = q.id === br.alertId && this.time < br.alertUntil && d < 110;
        if (d > cfg.view + (holding ? 15 : 0) && !alerted) continue;
        // heard: a throw close by, or the footsteps of someone running (a walk or a crouch is silent, as for people)
        const run = q.bot ? Math.hypot(q.body.vx, q.body.vz) : q.hspeed;
        const heard = this.time - q.lastFire < 0.8 && d < 28 || run > STEP_SPEED && !q.body.crouch && q.veh < 0 && d < STEP_HEAR_M;
        const inFov = (dx * fx + dz * fz) / (d || 1) > -0.25;
        if (!inFov && !heard && !alerted && d > 4) continue;
        if (!lineOfSight(ex, ey, ez, q.body.x, q.body.y + bodyH(q.body) * 0.74, q.body.z)) continue;
        if (d < bestD) { bestD = d; best = q; }
      }
      if (best && p.team === 0 && this.armed < 0) {
        // a guard who sees a technician near a point calls it: the other point's guards (but its anchor) come over
        this.callSite(best.body.x, best.body.z);
      }
      if (best) {
        if (br.target !== best.id) { if (!br.target) br.held = holding; br.target = best.id; br.reactAt = this.time + cfg.react * (holding ? 0.6 : 1) * (0.7 + this.rand() * 0.6); }
        br.seenX = best.body.x; br.seenZ = best.body.z; br.seenT = this.time;
      } else { br.target = 0; br.held = false; }

      // where to walk when not fighting
      if (!best) {
        let gx = br.goalX, gz = br.goalZ, need = !br.path || br.pi >= br.path.length;
        // (a guard before the plant does not chase beyond its point: it waits for them to come round the corner)
        const guard = p.team === 0 && this.armed < 0 && br.job === "mission";
        const chase = !guard || Math.hypot(br.seenX - br.goalX, br.seenZ - br.goalZ) < 10;
        if (this.time - br.seenT < 4 && chase && Math.hypot(br.seenX - b.x, br.seenZ - b.z) > 1.5) { gx = br.seenX; gz = br.seenZ; need = need || Math.hypot(gx - br.goalX, gz - br.goalZ) > 2; }
        else if (p.hp < 45) {
          const med = this.nearestPickup(p, "med");
          if (med) { gx = med.x; gz = med.z; need = need || Math.hypot(gx - br.goalX, gz - br.goalZ) > 1; }
        } else if (br.job === "mission") {
          // everyone works the round: the technicians come up their route to the point, the workers hold A and B.
          // Nobody goes looking for the other team, or all of them would meet in the middle of the hall
          if (!this.missionGoal(p, goalTmp)) { br.path = null; need = false; } // busy at the point: stay put
          else if (Math.hypot(goalTmp[0] - br.goalX, goalTmp[1] - br.goalZ) > 1.5) { gx = goalTmp[0]; gz = goalTmp[1]; need = true; }
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
          br.repathAt = this.time + 8 + this.rand() * 3;
        }
      }
      // stuck check once a second
      if (this.time >= br.stuckCheck) {
        if (br.path && Math.hypot(b.x - br.lastX, b.z - br.lastZ) < 0.3 && !best) { br.path = null; br.jump = true; }
        br.lastX = b.x; br.lastZ = b.z; br.stuckCheck = this.time + 1;
      }
    }

    let mx = 0, mz = 0, crouch = false;
    // at a point: a technician connects (with the case, when the mission is the tags), a worker disconnects
    const pts = sites(this.mission);
    const near = (i: number) => Math.hypot(b.x - pts[i].x, b.z - pts[i].z) <= SITE_R - 0.3;
    p.acting = p.team === 1 ? this.armed < 0 && (this.mission === "server" || p.carry) && (near(0) || near(1))
      : this.armed >= 0 && near(this.armed);
    const tgt = br.target ? this.players.get(br.target) : undefined;
    if (tgt && tgt.alive) {
      const dx = tgt.body.x - ex, dz = tgt.body.z - ez, d = Math.hypot(dx, dz);
      // weapon choice
      // a grenade now and then at a target standing off at mid range; otherwise the right launcher for the distance
      if (p.w !== "grenade" && p.mag.grenade > 0 && d > 12 && d < 34 && this.time >= br.reactAt && this.rand() < 0.0012) { p.w = "grenade"; p.reloadUntil = 0; p.fireReady = Math.max(p.fireReady, this.time + 0.4); }
      const want: WeaponId = p.w === "grenade" && p.mag.grenade > 0 ? "grenade"
        : p.owned.has("shotgun") && p.mag.shotgun + p.res.shotgun > 0 && d < 11 ? "shotgun"
        : p.owned.has("sniper") && p.mag.sniper + p.res.sniper > 0 && d > 40 ? "sniper"
        : p.owned.has("rifle") && p.mag.rifle + p.res.rifle > 0 ? "rifle"
        : p.owned.has("sniper") && p.mag.sniper + p.res.sniper > 0 ? "sniper"
        : p.owned.has("shotgun") && p.mag.shotgun + p.res.shotgun > 0 ? "shotgun" : "pistol";
      if (want !== p.w && !p.reloadUntil) { p.w = want; p.fireReady = Math.max(p.fireReady, this.time + 0.3); }
      if (this.time >= br.errUntil) {
        const e = cfg.aimErr * (1 + Math.min(1.5, d / 30));
        br.errYaw = (this.rand() * 2 - 1) * e; br.errPitch = (this.rand() * 2 - 1) * e * 0.6; br.errUntil = this.time + 0.35 + this.rand() * 0.3;
      }
      // the chest, or now and then (hard) the head, of the body as it stands or crouches
      const th = bodyH(tgt.body);
      const aimY = tgt.body.y + (this.config.difficulty === "hard" && this.rand() < 0.3 ? th - 0.15 : th * 0.71) - ey;
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
      // strafe, close in or back off: short side steps (wider with the level) that change direction every 0.5 to 1.4 s
      if (this.time >= br.strafeUntil) { br.strafe = this.rand() < 0.5 ? -1 : 1; br.strafeUntil = this.time + 0.5 + this.rand() * 0.9; }
      const ux = dx / (d || 1), uz = dz / (d || 1);
      const pref = p.w === "shotgun" ? 5 : 16;
      const fwd = d > pref * 1.3 ? 0.8 : d < pref * 0.5 ? -0.6 : 0;
      mx = ux * fwd + -uz * br.strafe * cfg.strafe;
      mz = uz * fwd + ux * br.strafe * cfg.strafe;
      if (!freeAt(b.x + mx * 0.8, b.z + mz * 0.8)) { br.strafe = -br.strafe; mx = ux * fwd; mz = uz * fwd; }
      // a guard that was holding the angle keeps still for its first burst, as a player does who waits on a corner
      if (br.held) { mx = 0; mz = 0; }
      // a technician at the server holds on to the cable and fights from there
      if (p.acting) { mx = 0; mz = 0; }
      // fire in bursts once the reaction time has passed and the aim is close; a burst wants a standstill, so the bot
      // stops first (it pushes against its own drift, a counter-strafe) and only lets go once it is slow enough
      const sp = Math.hypot(b.vx, b.vz);
      let still = false;
      if (this.time >= br.reactAt && Math.abs(dy) < 0.12 + 0.6 / Math.max(2, d)) {
        if (this.time < br.pauseUntil) { /* between bursts: side steps */ }
        else {
          if (!br.burstUntil) {
            br.burstUntil = this.time + cfg.burst * (0.6 + this.rand() * 0.8);
            // hard bots now and then crouch for a burst at mid range: a smaller target, a steadier throw
            br.crouch = d > 10 && d < 35 && this.rand() < cfg.crouch || br.held && this.rand() < cfg.holdCrouch;
          }
          if (this.time < br.burstUntil) {
            const w = WEAPONS[p.w];
            still = true;
            const sight = p.w === "sniper" || (p.w === "rifle" && d > 30);
            if (sp <= cfg.still && this.time >= p.fireReady && p.mag[p.w] > 0 && !p.reloadUntil) this.fire(p, p.yaw, p.pitch, this.time, 0, sp, !b.onGround, sight, cfg.comp);
            if (!w.auto) br.burstUntil = Math.min(br.burstUntil, Math.max(p.fireReady, this.time + 0.15) + 0.05);
          } else { br.burstUntil = 0; br.crouch = false; br.held = false; br.pauseUntil = this.time + cfg.pause * (0.6 + this.rand() * 0.8); }
        }
      }
      if (still) { if (sp > 0.4) { mx = -b.vx / sp; mz = -b.vz / sp; } else { mx = 0; mz = 0; } }
      crouch = br.crouch;
      if (p.mag[p.w] === 0) this.startReload(p);
    } else {
      if (p.mag[p.w] < WEAPONS[p.w].mag * 0.5) this.startReload(p);
      if (br.path && br.pi < br.path.length) {
        let [wx, wz] = br.path[br.pi];
        if (Math.hypot(wx - b.x, wz - b.z) < 0.6) { br.pi++; if (br.pi < br.path.length) [wx, wz] = br.path[br.pi]; }
        if (br.pi < br.path.length) {
          const dx = wx - b.x, dz = wz - b.z, d = Math.hypot(dx, dz) || 1;
          mx = dx / d; mz = dz / d;
          let dy = Math.atan2(-mx, -mz) - p.yaw;
          while (dy > Math.PI) dy -= Math.PI * 2;
          while (dy < -Math.PI) dy += Math.PI * 2;
          p.yaw += Math.max(-4 * dt, Math.min(4 * dt, dy));
          p.pitch *= 0.9;
        }
      } else if (p.team === 0 && this.armed < 0) {
        // a guard at the post stands still (its first throw is then dead on) and watches the way the technicians come
        // in: a few metres along the walk from here towards where they started
        if (!(Math.hypot(b.x - br.faceX, b.z - br.faceZ) < 1)) {
          br.faceX = b.x; br.faceZ = b.z; br.faceYaw = NaN;
          const way = findPath(b.x, b.z, this.techFrom[0], this.techFrom[1]);
          if (way) {
            let k = 0, run = 0;
            while (k < way.length - 1 && run < 7) { run += Math.hypot(way[k + 1][0] - way[k][0], way[k + 1][1] - way[k][1]); k++; }
            const fx = way[k][0] - b.x, fz = way[k][1] - b.z;
            if (Math.hypot(fx, fz) > 0.5) br.faceYaw = Math.atan2(-fx, -fz);
          }
        }
        if (Number.isFinite(br.faceYaw)) {
          let dy = br.faceYaw - p.yaw;
          while (dy > Math.PI) dy -= Math.PI * 2;
          while (dy < -Math.PI) dy += Math.PI * 2;
          p.yaw += Math.max(-2.5 * dt, Math.min(2.5 * dt, dy));
          p.pitch *= 0.9;
        }
      }
    }
    if (!tgt || !tgt.alive) br.crouch = false;
    const jump = br.jump; br.jump = false;
    stepBody(b, { mx, mz, jump, crouch, speed: maxSpeed(p.w, false) }, dt);
    p.moving = Math.hypot(b.vx, b.vz) > 0.5;
  }

  /**
   * Where a bot on mission duty should be heading; false when it has nothing to do there right now.
   * Technicians: the server, or the delivery point and then a charging station. Workers: a post near the objective.
   */
  private missionGoal(p: Player, out: number[]): boolean {
    const pts = sites(this.mission), br = p.brain!, b = p.body;
    /** A post within ~14 m of a point: kept until reached, then now and then changed. */
    // (a guard before the plant holds its post for about a minute: one that keeps walking about never holds an angle)
    const post = (ox: number, oz: number) => {
      const has = Math.hypot(br.goalX - ox, br.goalZ - oz) < 16;
      const stay = p.team === 0 && this.armed < 0 ? 0.998 : 0.98;
      if (has && (Math.hypot(b.x - br.goalX, b.z - br.goalZ) > 1.5 || this.rand() < stay)) { out[0] = br.goalX; out[1] = br.goalZ; return true; }
      for (let tries = 0; tries < 12; tries++) {
        const x = ox + (this.rand() - 0.5) * 26, z = oz + (this.rand() - 0.5) * 26;
        if (freeAt(x, z)) { out[0] = x; out[1] = z; return true; }
      }
      out[0] = ox; out[1] = oz; return true;
    };
    if (this.armed >= 0) {
      // it is starting up: the workers run to disconnect it, the technicians hold the point
      const s = pts[this.armed];
      if (p.team === 0) { out[0] = s.x; out[1] = s.z; return !p.acting; }
      return post(s.x, s.z);
    }
    if (p.team === 1) {
      // the case lies on the floor: whoever is near picks it up
      if (this.mission === "tags" && this.caseAt && Math.hypot(this.caseAt.x - b.x, this.caseAt.z - b.z) < 70) { out[0] = this.caseAt.x; out[1] = this.caseAt.z; return true; }
      // up this round's route (the north edge of the hall, the main aisle or the south edge) as far as the west
      // racking, and only there turn for the point: the push comes from three sides, not through the middle
      const site = br.lurk ? 1 - this.botSite : this.botSite;
      const lanes = LAYOUTS[this.layout].routes?.[site];
      if (lanes) {
        // the depot: one of three ways through the rooms to this round's point
        const way = lanes[br.lane + 1];
        while (br.wp < way.length && Math.hypot(way[br.wp][0] - b.x, way[br.wp][1] - b.z) < 4.5) br.wp++;
        if (br.wp < way.length) { out[0] = way[br.wp][0]; out[1] = way[br.wp][1]; return true; }
      }
      const route = lanes ? [] : br.lane === 0 ? ROUTE_MID : ROUTE_FLANK;
      while (br.wp < route.length && (b.x < route[br.wp][0] + 4 || Math.hypot(route[br.wp][0] - b.x, route[br.wp][1] * br.lane - b.z) < 7)) br.wp++;
      if (br.wp < route.length) { out[0] = route[br.wp][0]; out[1] = br.lane === 0 ? route[br.wp][1] : route[br.wp][1] * br.lane; return true; }
      const s = pts[site];
      // with the tags only the carrier goes to the point itself; the others cover it
      if (this.mission === "tags" && !p.carry) return post(s.x, s.z);
      out[0] = s.x; out[1] = s.z; return !p.acting;
    }
    // workers: split between A and B; a call from the other point (a technician seen there in the last 20 s) brings
    // everyone but this point's anchor over, and a rover changes over now and then
    const st = br.station % pts.length, other = 1 - st;
    if (!br.anchor && this.time - this.seenAtSite[other] < 20 && this.time - this.seenAtSite[st] > 6) { br.station = other; br.roverAt = Infinity; }
    else if (this.time >= br.roverAt) { br.station++; br.roverAt = this.time + 20 + this.rand() * 20; }
    const s = pts[br.station % pts.length];
    return post(s.x, s.z);
  }

  /** A technician was seen at (x, z), or hit a worker from there: if that is close to a point, call it. */
  private callSite(x: number, z: number) {
    const pts = sites(this.mission);
    for (let i = 0; i < pts.length; i++) if (Math.hypot(x - pts[i].x, z - pts[i].z) < 32) this.seenAtSite[i] = this.time;
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
          id: p.id, n: p.name, bot: p.bot, c: p.color, tm: p.team, g: p.group, veh: p.veh, seat: p.seat, carry: p.carry,
          x: +p.body.x.toFixed(3), y: +p.body.y.toFixed(3), z: +p.body.z.toFixed(3), yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3), crouch: !!p.body.crouch,
          hp: p.hp, alive: p.alive, w: p.w, k: p.k, d: p.d, fired: +Math.min(99, this.time - p.lastFire).toFixed(2),
        });
      }
      this.snapCache = { t: this.time, list };
    }
    const self: SelfSnap = {
      hp: me.hp, alive: me.alive, w: me.w, team: me.team, group: me.group, mag: { ...me.mag }, res: { ...me.res }, owned: [...me.owned],
      spawn: me.spawn, x: me.body.x, y: me.body.y, z: me.body.z, yaw: me.yaw,
      veh: me.veh, seat: me.seat, vrev: me.veh >= 0 ? this.forklifts[me.veh].rev : 0,
      reloading: !!me.reloadUntil,
      geo: Math.max(0, me.geoUntil - this.time), killedBy: me.killedBy, carry: me.carry,
      money: me.money, buy: this.canBuy(me),
    };
    const obj: ObjSnap = {
      round: this.round, wins: [this.wins[0], this.wins[1]], swapped: this.swapped,
      plant: +this.plant.toFixed(3), defuse: +this.defuse.toFixed(3), armed: this.armed,
      boot: this.armed >= 0 ? +Math.max(0, this.bootEnd - this.time).toFixed(2) : 0,
      case: this.caseAt ? [+this.caseAt.x.toFixed(1), +this.caseAt.z.toFixed(1)] : null,
    };
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
