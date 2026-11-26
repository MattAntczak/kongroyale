// The efectivo ARENA host: one team deathmatch in the warehouse, Grupa A against Grupa B. It owns health, ammo, kills, pickups,
// respawns and the bots. The same class runs inside the Node server (online rooms) and inside the browser (bot
// matches), so both play by identical rules.
//
// Authority: a human's movement is predicted by their own client and sent here; the host checks every step against
// the walls and a speed limit and sends a correction when one fails. Shots are decided here: the host re-runs the ray
// test against where everyone was at the moment the shooter saw them (up to 300 ms back).

import { BOXES, PICKUPS, SPAWNS, HALL, type PickupKind } from "./map";
import { EYE_H, PLAYER_H, SPRINT_SPEED, blocked, lineOfSight, rayPlayer, rayWorld, stepBody, viewDir, type Body } from "./physics";
import { WEAPONS, falloff, type WeaponId } from "./weapons";
import { findPath, freeAt, randomFree, walkable } from "./nav";
import type { ClientMsg, Difficulty, Ev, HostMsg, PlayerSnap, SelfSnap } from "./proto";

export const TICK_HZ = 60;
export const MAX_PLAYERS = 10;
/** Team eliminations that win the shift. */
export const TEAM_FRAG_LIMIT = 40;
export const TEAM_NAMES = ["Grupa A", "Grupa B"] as const;
export const TIME_LIMIT_S = 6 * 60;
export const END_S = 10;
export const RESPAWN_S = 3;
export const SPAWN_PROTECT_S = 1.5;
export const GEO_S = 10;
export const MAX_REWIND_S = 0.3;
const HIST = 48;

const BOT_NAMES = ["Zenek", "Halina", "Mirek", "Grażyna", "Waldek", "Bożena", "Rysiek", "Danuta", "Kazik", "Wiesia", "Janusz", "Krystyna"];
const PICKUP_RESPAWN_S: Record<PickupKind, number> = { med: 20, ammo: 15, shotgun: 25, geo: 45 };

const DIFF = {
  easy: { react: 0.6, aimErr: 0.11, turn: 3.2, view: 32, burst: 0.35, pause: 0.55 },
  normal: { react: 0.35, aimErr: 0.06, turn: 5.5, view: 45, burst: 0.5, pause: 0.35 },
  hard: { react: 0.2, aimErr: 0.03, turn: 9, view: 60, burst: 0.8, pause: 0.2 },
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
}

export interface SimOptions { bots: boolean; difficulty: Difficulty; seed?: number; maxPlayers?: number }

export class Sim {
  time = 0;
  phase: "play" | "end" = "play";
  private endAt = 0;
  private matchEndT = TIME_LIMIT_S;
  private players = new Map<number, Player>();
  private nextId = 1;
  private evs: Ev[] = [];
  private pickups = PICKUPS.map((spot) => ({ spot, readyAt: 0 }));
  private rand: () => number;
  private colorSeq = 0;
  /** Eliminations per team this shift. */
  readonly score: [number, number] = [0, 0];
  private botName = 0;
  readonly maxPlayers: number;

  constructor(readonly opts: SimOptions) {
    this.rand = mulberry32(opts.seed ?? 1234567);
    this.maxPlayers = opts.maxPlayers ?? MAX_PLAYERS;
    this.fillBots();
  }

  get humanCount() { let n = 0; for (const p of this.players.values()) if (!p.bot) n++; return n; }

  private newPlayer(name: string, bot: boolean, team: Team): Player {
    const p: Player = {
      id: this.nextId++, name, bot, color: this.colorSeq++ % 10, team,
      body: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: true }, yaw: 0, pitch: 0, moving: false,
      hp: 100, alive: true, respawnAt: 0, killedBy: "",
      w: "rifle", mag: { rifle: 0, pistol: 0, shotgun: 0 }, res: { rifle: 0, pistol: 0, shotgun: 0 }, owned: new Set(),
      fireReady: 0, lastFire: -99, reloadUntil: 0, k: 0, d: 0, spawn: 0, protectUntil: 0, geoUntil: 0, lastStateT: 0,
      hist: new Float64Array(HIST * 4), histN: 0,
      brain: bot ? {
        path: null, pi: 0, goalX: 0, goalZ: 0, repathAt: 0, target: 0, reactAt: 0, strafe: 1, strafeUntil: 0,
        errYaw: 0, errPitch: 0, errUntil: 0, nextThink: 0, seenX: 0, seenZ: 0, seenT: -99, lastX: 0, lastZ: 0, stuckCheck: 0,
        burstUntil: 0, pauseUntil: 0, jump: false,
      } : null,
    };
    this.players.set(p.id, p);
    this.respawn(p);
    return p;
  }

  private get perTeam() { return Math.max(1, Math.floor(this.maxPlayers / 2)); }

  private teamCount(t: Team, humansOnly = false) {
    let n = 0;
    for (const p of this.players.values()) if (p.team === t && (!humansOnly || !p.bot)) n++;
    return n;
  }

  /** Top each team up with bots to half the room. */
  private fillBots() {
    if (!this.opts.bots) return;
    for (const t of [0, 1] as const) {
      while (this.teamCount(t) < this.perTeam) {
        const name = BOT_NAMES[this.botName++ % BOT_NAMES.length];
        this.newPlayer(name, true, t);
      }
    }
  }

  /**
   * Add a human; returns their id, or 0 when the room is full of humans. `pref` 0 or 1 asks for Grupa A or B; the
   * human gets it while that group has a free human seat, otherwise the group with fewer humans.
   */
  addHuman(name: string, pref = -1): number {
    if (this.humanCount >= this.perTeam * 2) return 0;
    const ha = this.teamCount(0, true), hb = this.teamCount(1, true);
    let team: Team = ha < hb ? 0 : hb < ha ? 1 : this.teamCount(0) <= this.teamCount(1) ? 0 : 1;
    if ((pref === 0 || pref === 1) && this.teamCount(pref, true) < this.perTeam) team = pref;
    if (this.teamCount(team, true) >= this.perTeam) team = team === 0 ? 1 : 0;
    // a human takes a bot's seat in that group
    if (this.teamCount(team) >= this.perTeam) {
      let worst: Player | null = null;
      for (const p of this.players.values()) if (p.bot && p.team === team && (!worst || p.k < worst.k)) worst = p;
      if (worst) this.players.delete(worst.id);
    }
    const clean = name.replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 16) || "Magazynier";
    const p = this.newPlayer(clean, false, team);
    this.evs.push({ k: "join", name: p.name });
    return p.id;
  }

  removePlayer(id: number) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.evs.push({ k: "leave", name: p.name });
    this.fillBots();
  }

  nameOf(id: number) { return this.players.get(id)?.name ?? "?"; }

  // ---------------------------------------------------------------- input from clients

  receive(id: number, m: ClientMsg) {
    const p = this.players.get(id);
    if (!p) return;
    switch (m.t) {
      case "state": this.onState(p, m); break;
      case "shoot": this.onShoot(p, m); break;
      case "reload": this.startReload(p); break;
      case "switch": if (p.owned.has(m.w) && p.w !== m.w) { p.w = m.w; p.reloadUntil = 0; p.fireReady = Math.max(p.fireReady, this.time + 0.25); } break;
      case "chat": { const text = String(m.text).slice(0, 120).trim(); if (text) this.evs.push({ k: "chat", name: p.name, text }); break; }
    }
  }

  private onState(p: Player, m: Extract<ClientMsg, { t: "state" }>) {
    if (!p.alive || m.spawn !== p.spawn) return;
    if (![m.x, m.y, m.z, m.yaw, m.pitch].every(Number.isFinite)) return;
    p.yaw = m.yaw;
    p.pitch = Math.max(-1.5, Math.min(1.5, m.pitch));
    p.moving = !!m.moving;
    const dt = Math.max(0.016, Math.min(0.5, this.time - p.lastStateT));
    p.lastStateT = this.time;
    const b = p.body;
    const dh = Math.hypot(m.x - b.x, m.z - b.z);
    const okSpeed = dh <= SPRINT_SPEED * 1.4 * dt + 0.6;
    const okY = m.y >= -0.01 && m.y <= HALL.h && m.y - b.y <= 1.6 * Math.max(dt, 0.1) * 8;
    const inside = m.x > HALL.x0 && m.x < HALL.x1 && m.z > HALL.z0 && m.z < HALL.z1;
    if (okSpeed && okY && inside && !blocked(m.x, m.y + 0.01, m.z)) {
      b.x = m.x; b.y = m.y; b.z = m.z;
    } else {
      p.spawn++; // the client snaps back to the host's position
    }
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
    if (p.mag[p.w] <= 0 || this.time < p.fireReady - slack) return;
    if (dirs.length !== w.pellets * 3) return;
    p.fireReady = Math.max(this.time, p.fireReady) + 60 / w.rpm;
    p.mag[p.w]--;
    p.lastFire = this.time;
    p.protectUntil = 0;
    const [vx, vy, vz] = viewDir(yaw, pitch);
    const cosMax = Math.cos(w.spread + w.moveSpread + 0.03);
    const rewind = Math.max(this.time - MAX_REWIND_S, Math.min(this.time, viewT));
    const ox = p.body.x, oy = p.body.y + EYE_H, oz = p.body.z;
    const ends: number[] = [];
    const dmgBy = new Map<Player, { dmg: number; head: boolean; x: number; y: number; z: number }>();
    const pos = [0, 0, 0], tOut = [0];
    for (let i = 0; i < dirs.length; i += 3) {
      let dx = dirs[i], dy = dirs[i + 1], dz = dirs[i + 2];
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) continue;
      dx /= len; dy /= len; dz /= len;
      if (dx * vx + dy * vy + dz * vz < cosMax) { dx = vx; dy = vy; dz = vz; }
      let best = rayWorld(ox, oy, oz, dx, dy, dz, 200);
      let hitP: Player | null = null, head = false;
      for (const q of this.players.values()) {
        if (q === p || !q.alive || q.team === p.team) continue; // bullets pass teammates: no friendly fire
        this.posAt(q, rewind, pos);
        const part = rayPlayer(ox, oy, oz, dx, dy, dz, pos[0], pos[1], pos[2], tOut);
        if (part && tOut[0] < best) { best = tOut[0]; hitP = q; head = part === 2; }
      }
      ends.push(+(ox + dx * best).toFixed(2), +(oy + dy * best).toFixed(2), +(oz + dz * best).toFixed(2));
      if (hitP) {
        const dmg = w.dmg * (head ? w.headMul : 1) * falloff(w, best);
        if (dmg <= 0) continue;
        const e = dmgBy.get(hitP) ?? { dmg: 0, head: false, x: 0, y: 0, z: 0 };
        e.dmg += dmg; e.head ||= head;
        e.x = ox + dx * best; e.y = oy + dy * best; e.z = oz + dz * best;
        dmgBy.set(hitP, e);
      }
    }
    this.evs.push({ k: "shot", id: p.id, w: p.w, o: [+ox.toFixed(2), +oy.toFixed(2), +oz.toFixed(2)], ends });
    for (const [q, e] of dmgBy) this.damage(q, p, Math.round(e.dmg), e.head, e.x, e.y, e.z);
    if (p.mag[p.w] === 0) this.startReload(p);
  }

  private damage(q: Player, by: Player, dmg: number, head: boolean, x: number, y: number, z: number) {
    if (!q.alive || this.time < q.protectUntil || dmg <= 0 || (q.team === by.team && q !== by)) return;
    q.hp -= dmg;
    this.evs.push({ k: "hit", by: by.id, on: q.id, dmg, head, x: +x.toFixed(2), y: +y.toFixed(2), z: +z.toFixed(2) });
    if (q.brain && q.brain.target === 0) { q.brain.seenX = by.body.x; q.brain.seenZ = by.body.z; q.brain.seenT = this.time; }
    if (q.hp > 0) return;
    q.hp = 0; q.alive = false; q.d++; q.respawnAt = this.time + RESPAWN_S; q.killedBy = by.name; q.reloadUntil = 0;
    if (by !== q) { by.k++; this.score[by.team]++; }
    this.evs.push({ k: "kill", by: by.id, on: q.id, w: by.w, head });
    if (this.score[by.team] >= TEAM_FRAG_LIMIT) this.endMatch();
  }

  private endMatch() {
    if (this.phase === "end") return;
    this.phase = "end";
    this.endAt = this.time + END_S;
    const winner = this.score[0] === this.score[1] ? -1 : this.score[0] > this.score[1] ? 0 : 1;
    let mvp: Player | null = null;
    for (const p of this.players.values()) if (!mvp || p.k > mvp.k || (p.k === mvp.k && p.d < mvp.d)) mvp = p;
    this.evs.push({ k: "end", winner, mvp: mvp?.name ?? "" });
  }

  private restart() {
    this.phase = "play";
    this.matchEndT = this.time + TIME_LIMIT_S;
    this.score[0] = 0; this.score[1] = 0;
    for (const p of this.players.values()) { p.k = 0; p.d = 0; this.respawn(p); }
    for (const pk of this.pickups) pk.readyAt = 0;
    this.evs.push({ k: "start" });
  }

  private respawn(p: Player) {
    // Grupa A holds the west of the hall, Grupa B the east: prefer a spawn on our own side, far from live enemies,
    // picked among the best three so it is not predictable
    const scored = SPAWNS.map(([x, z]) => {
      let near = 60;
      for (const q of this.players.values()) if (q !== p && q.alive && q.team !== p.team) near = Math.min(near, Math.hypot(q.body.x - x, q.body.z - z));
      const home = (p.team === 0 ? -x : x) > 0 ? 40 : 0;
      return { x, z, near: near + home };
    }).sort((a, b) => b.near - a.near);
    const s = scored[Math.floor(this.rand() * Math.min(3, scored.length))];
    p.body.x = s.x; p.body.y = 0; p.body.z = s.z; p.body.vx = p.body.vy = p.body.vz = 0; p.body.onGround = true;
    p.yaw = Math.atan2(s.x, s.z); // face the middle of the hall
    p.pitch = 0;
    p.hp = 100; p.alive = true; p.killedBy = "";
    p.owned = new Set<WeaponId>(["rifle", "pistol"]);
    p.w = "rifle";
    p.mag = { rifle: WEAPONS.rifle.mag, pistol: WEAPONS.pistol.mag, shotgun: 0 };
    p.res = { rifle: WEAPONS.rifle.reserve, pistol: WEAPONS.pistol.reserve, shotgun: 0 };
    p.reloadUntil = 0; p.fireReady = this.time + 0.3;
    p.spawn++; p.protectUntil = this.time + SPAWN_PROTECT_S; p.geoUntil = 0; p.histN = 0;
    p.lastStateT = this.time;
    if (p.brain) { p.brain.path = null; p.brain.target = 0; p.brain.seenT = -99; p.brain.repathAt = 0; }
  }

  // ---------------------------------------------------------------- the tick

  step(dt: number) {
    this.time += dt;
    if (this.phase === "end") {
      if (this.time >= this.endAt) this.restart();
    } else if (this.time >= this.matchEndT) this.endMatch();

    for (const p of this.players.values()) {
      if (!p.alive) { if (this.time >= p.respawnAt && this.phase === "play") this.respawn(p); continue; }
      if (p.reloadUntil && this.time >= p.reloadUntil) {
        const w = WEAPONS[p.w], need = w.mag - p.mag[p.w], take = Math.min(need, p.res[p.w]);
        p.mag[p.w] += take; if (p.res[p.w] < 900) p.res[p.w] -= take; p.reloadUntil = 0;
      }
      if (p.brain && this.phase === "play") this.botTick(p, dt);
      this.touchPickups(p);
      const idx = (p.histN % HIST) * 4;
      p.hist[idx] = this.time; p.hist[idx + 1] = p.body.x; p.hist[idx + 2] = p.body.y; p.hist[idx + 3] = p.body.z;
      p.histN++;
    }
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
          if (p.res.rifle < WEAPONS.rifle.reserve || (p.owned.has("shotgun") && p.res.shotgun < WEAPONS.shotgun.reserve)) {
            p.res.rifle = WEAPONS.rifle.reserve;
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
    const cfg = DIFF[this.opts.difficulty];
    const b = p.body;
    const ex = b.x, ey = b.y + EYE_H, ez = b.z;

    if (this.time >= br.nextThink) {
      br.nextThink = this.time + 0.1 + this.rand() * 0.05;
      let best: Player | null = null, bestD = Infinity;
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      for (const q of this.players.values()) {
        if (q === p || !q.alive || q.team === p.team) continue;
        const dx = q.body.x - ex, dz = q.body.z - ez, d = Math.hypot(dx, dz);
        if (d > cfg.view) continue;
        const heard = this.time - q.lastFire < 0.8 && d < 28;
        const inFov = (dx * fx + dz * fz) / (d || 1) > -0.25;
        if (!inFov && !heard && d > 4) continue;
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
        } else if (need) {
          if (this.rand() < 0.45) {
            const ready = this.pickups.filter((pk) => this.time >= pk.readyAt);
            const pk = ready[Math.floor(this.rand() * ready.length)];
            if (pk) { gx = pk.spot.x; gz = pk.spot.z; } else [gx, gz] = randomFree(this.rand);
          } else [gx, gz] = randomFree(this.rand);
        }
        if (need || this.time >= br.repathAt) {
          br.goalX = gx; br.goalZ = gz;
          br.path = findPath(b.x, b.z, gx, gz); br.pi = 0;
          br.repathAt = this.time + 2.5 + this.rand();
        }
      }
      // stuck check once a second
      if (this.time >= br.stuckCheck) {
        if (br.path && Math.hypot(b.x - br.lastX, b.z - br.lastZ) < 0.3 && !best) { br.path = null; br.jump = true; }
        br.lastX = b.x; br.lastZ = b.z; br.stuckCheck = this.time + 1;
      }
    }

    let mx = 0, mz = 0, sprint = false;
    const tgt = br.target ? this.players.get(br.target) : undefined;
    if (tgt && tgt.alive) {
      const dx = tgt.body.x - ex, dz = tgt.body.z - ez, d = Math.hypot(dx, dz);
      // weapon choice
      const want: WeaponId = p.owned.has("shotgun") && p.mag.shotgun + p.res.shotgun > 0 && d < 11 ? "shotgun"
        : p.mag.rifle + p.res.rifle > 0 ? "rifle" : "pistol";
      if (want !== p.w && !p.reloadUntil) { p.w = want; p.fireReady = Math.max(p.fireReady, this.time + 0.3); }
      if (this.time >= br.errUntil) {
        const e = cfg.aimErr * (1 + Math.min(1.5, d / 30));
        br.errYaw = (this.rand() * 2 - 1) * e; br.errPitch = (this.rand() * 2 - 1) * e * 0.6; br.errUntil = this.time + 0.35 + this.rand() * 0.3;
      }
      const aimY = tgt.body.y + (this.opts.difficulty === "hard" && this.rand() < 0.3 ? 1.6 : 1.25) - ey;
      const wantYaw = Math.atan2(-dx, -dz) + br.errYaw;
      const wantPitch = Math.atan2(aimY, d) + br.errPitch;
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
          id: p.id, n: p.name, bot: p.bot, c: p.color, tm: p.team,
          x: +p.body.x.toFixed(3), y: +p.body.y.toFixed(3), z: +p.body.z.toFixed(3), yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3),
          hp: p.hp, alive: p.alive, w: p.w, k: p.k, d: p.d, fired: +Math.min(99, this.time - p.lastFire).toFixed(2),
        });
      }
      this.snapCache = { t: this.time, list };
    }
    const self: SelfSnap = {
      hp: me.hp, alive: me.alive, w: me.w, team: me.team, mag: { ...me.mag }, res: { ...me.res }, owned: [...me.owned],
      spawn: me.spawn, x: me.body.x, y: me.body.y, z: me.body.z, yaw: me.yaw,
      reloading: !!me.reloadUntil, respawnIn: me.alive ? 0 : Math.max(0, me.respawnAt - this.time),
      geo: Math.max(0, me.geoUntil - this.time), killedBy: me.killedBy,
    };
    return {
      t: "snap", time: +this.time.toFixed(3), phase: this.phase,
      left: this.phase === "end" ? Math.max(0, this.endAt - this.time) : Math.max(0, this.matchEndT - this.time),
      score: [this.score[0], this.score[1]], players: this.snapCache.list, pickups: this.pickups.map((pk) => this.time >= pk.readyAt), me: self,
    };
  }
}

/** Every box the hall has, for a quick sanity check by tools. */
export const BOX_COUNT = BOXES.length;
export { PLAYER_H };
