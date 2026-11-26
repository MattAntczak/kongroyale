// One efectivo ARENA session in the browser: renders the hall, reads mouse and keyboard, predicts our own movement and
// shots, interpolates everyone else from snapshots, and keeps the HUD current. The host (in-page or server) decides
// health, ammo and kills; this file only predicts what the host will most likely say and accepts what it does say.

import * as THREE from "three";
import { EYE_H, rayPlayer, rayWorld, stepBody, viewDir, type Body } from "../shared/physics";
import { WEAPONS, WEAPON_ORDER, type WeaponId } from "../shared/weapons";
import { spreadDirs } from "../shared/sim";
import type { Ev, HostMsg, PlayerSnap, VehicleSnap } from "../shared/proto";
import { VEH_USE_R, seatPos, stepVehicle, vehicleBox as vehicleBoxInto, type VehicleState } from "../shared/vehicle";
import { setDynamicBoxes } from "../shared/physics";
import type { Box } from "../shared/map";
import { buildWorld, forkliftModel, type WorldHandle } from "./world";
import { Human, TEAM_COLORS, TEAM_CSS, gunModel } from "./human";
import { TEAM_FRAG_LIMIT, TEAM_NAMES } from "../shared/sim";
import { Fx } from "./fx";
import { drawMinimap } from "./minimap";
import * as sfx from "./audio";
import type { Link } from "./net";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const INTERP_S = 0.1;
const VM_GUN = new THREE.MeshStandardMaterial({ color: 0xc29a66, roughness: 0.85 });
const STATE_HZ = 30;

export interface Settings { sens: number; vol: number; fov: number }
export function loadSettings(): Settings {
  const d: Settings = { sens: 1, vol: 0.7, fov: 80 };
  try { return { ...d, ...JSON.parse(localStorage.getItem("efectivo.settings") || "{}") }; } catch { return d; }
}
function saveSettings(s: Settings) { try { localStorage.setItem("efectivo.settings", JSON.stringify(s)); } catch { /* private mode */ } }

interface Snap { time: number; players: Map<number, PlayerSnap>; vehicles: VehicleSnap[] }

const PICK_TEXT = { med: "Apteczka · +50 zdrowia", ammo: "Zapas paczek uzupełniony", shotgun: "Paletówka w ręku · klawisz 3", geo: "efectivo GEO · widzisz wszystkich przez 10 s" } as const;

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private vmScene = new THREE.Scene();
  private vmCam = new THREE.PerspectiveCamera(58, 1, 0.01, 10);
  private vm = new THREE.Group();
  private vmGun: THREE.Group | null = null;
  private vmGunId: WeaponId | null = null;
  private vmFlash: THREE.Mesh;
  private vmFlashT = 0;
  private vmKick = 0;
  private sleeveMat = new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.6 });
  private world: WorldHandle;
  private fx: Fx;
  private humans = new Map<number, Human>();
  private snaps: Snap[] = [];
  private latest: Extract<HostMsg, { t: "snap" }> | null = null;
  private names = new Map<number, PlayerSnap>();
  private myId = 0;
  /** The forklift we ride (-1 on foot), our seat, and, when we drive it, our predicted pose of it. */
  private veh = -1; private seat = 0; private vrev = -1;
  private drive: VehicleState = { x: 0, z: 0, yaw: 0, speed: 0 };
  private camOffset = 0;
  private forklifts = new Map<number, THREE.Group>();
  private vehPoses = new Map<number, VehicleState>();
  private dynBoxes: Box[] = [];
  private beepT = 0;
  private seatTmp = [0, 0, 0];
  /** Our own worker, drawn only while we drive (the chase camera sees us). */
  private selfHuman: Human | null = null;
  private myTeam = -1;
  private announced = false;
  private endMvp = "";
  private room = "";
  private body: Body = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: true };
  private yaw = 0; private pitch = 0;
  private spawn = -1;
  private alive = false;
  private keys = new Set<string>();
  private mouseDown = false; private clicked = false;
  private w: WeaponId = "rifle";
  private mag: Record<WeaponId, number> = { rifle: 30, pistol: 12, shotgun: 0 };
  private res: Record<WeaponId, number> = { rifle: 120, pistol: 999, shotgun: 0 };
  private owned = new Set<WeaponId>(["rifle", "pistol"]);
  private reloadUntil = 0; private reloadStart = 0;
  private fireReady = 0; private lastShotAt = -9; private lastSwitchAt = -9;
  private offset: number | null = null;
  private acc = 0; private sendAcc = 0;
  private last = performance.now();
  private raf = 0;
  private stepT = 0; private bob = 0; private shake = 0;
  private mapCtx: CanvasRenderingContext2D;
  private hitT = 0; private hurtT = 0; private toastT = 0;
  private chatting = false; private paused = false; private quitting = false;
  private settings = loadSettings();
  private hudCache: Record<string, string> = {};
  private disposers: (() => void)[] = [];

  constructor(private link: Link, private onQuit: (msg?: string) => void) {
    const canvas = $<HTMLCanvasElement>("view");
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.autoClear = false;
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, 1, 0.05, 200);
    this.scene.background = new THREE.Color(0x07070a);
    this.scene.fog = new THREE.Fog(0x07070a, 35, 95);

    // light: a cool sky fill, a key from the roof lights with shadows, a few warm points down the hall
    this.scene.add(new THREE.HemisphereLight(0xdfe4ff, 0x2a2622, 1.25));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-12, 30, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -45, right: 45, top: 30, bottom: -30, near: 1, far: 80 });
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.03;
    this.scene.add(key);
    for (const [x, z] of [[-26, 0], [0, -14], [0, 14], [26, 0], [-26, -18], [-26, 18]]) {
      const p = new THREE.PointLight(0xfff1dc, 40, 26, 1.6); p.position.set(x, 9.5, z); this.scene.add(p);
    }
    this.world = buildWorld(this.scene);
    this.fx = new Fx(this.scene, this.boxHit);

    // first-person view model
    this.vmScene.add(new THREE.HemisphereLight(0xdfe4ff, 0x2a2622, 1.6));
    const vk = new THREE.DirectionalLight(0xffffff, 1.4); vk.position.set(1, 2, 1); this.vmScene.add(vk);
    this.vmScene.add(this.vm);
    const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.4), this.sleeveMat); sleeve.position.set(0.05, -0.06, 0.2); this.vm.add(sleeve);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.08), new THREE.MeshStandardMaterial({ color: 0xe0b08c, roughness: 0.7 })); hand.position.set(0.015, -0.055, 0.03); this.vm.add(hand);
    const flashTex = (() => { const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d")!; const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, "rgba(235,238,255,1)"); gr.addColorStop(0.3, "rgba(120,128,255,0.7)"); gr.addColorStop(1, "rgba(71,79,255,0)"); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
    this.vmFlash = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), new THREE.MeshBasicMaterial({ map: flashTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.vmFlash.visible = false;
    this.vm.add(this.vmFlash);
    this.setVmGun("rifle");

    this.mapCtx = $<HTMLCanvasElement>("mapc").getContext("2d")!;
    sfx.setVolume(this.settings.vol);
    this.bindInput();
    this.bindPause();
    $("hud").hidden = false;
    this.resize();
    link.onMessage = (m) => this.onMessage(m);
    link.onClose = (reason) => this.quit(reason);
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  // ---------------------------------------------------------------- input

  private hitOut = [0];
  private hitRes = { t: 0, player: false };

  /** What a visual box meets first: a wall, or an alive player of the other group (never its own thrower). */
  private boxHit = (x: number, y: number, z: number, dx: number, dy: number, dz: number, seg: number, team: number, owner: number) => {
    const out = this.hitOut, r = this.hitRes;
    r.t = rayWorld(x, y, z, dx, dy, dz, seg); r.player = false;
    for (const [id, h] of this.humans) {
      const o = this.names.get(id);
      if (id === owner || !o?.alive || o.tm === team) continue;
      const p = h.root.position;
      if (rayPlayer(x, y, z, dx, dy, dz, p.x, p.y, p.z, out) && out[0] < r.t) { r.t = out[0]; r.player = true; }
    }
    if (this.alive && owner !== this.myId && team !== this.myTeam && rayPlayer(x, y, z, dx, dy, dz, this.body.x, this.body.y, this.body.z, out) && out[0] < r.t) { r.t = out[0]; r.player = true; }
    return r;
  };

  private on<K extends keyof WindowEventMap>(target: Window | Document | HTMLElement, type: K | string, fn: (e: any) => void, opts?: AddEventListenerOptions) {
    target.addEventListener(type, fn, opts);
    this.disposers.push(() => target.removeEventListener(type, fn, opts));
  }

  private get locked() { return document.pointerLockElement === this.renderer.domElement; }

  private lock() { void this.renderer.domElement.requestPointerLock()?.catch?.(() => {}); }

  private bindInput() {
    const canvas = this.renderer.domElement;
    this.on(window, "resize", () => this.resize());
    this.on(canvas, "click", () => { sfx.initAudio(); if (!this.locked) this.lock(); });
    this.on(document, "pointerlockchange", () => {
      if (this.locked) { this.paused = false; $("pause").hidden = true; return; }
      this.mouseDown = false; this.keys.clear();
      if (!this.chatting && !this.quitting) { this.paused = true; $("pause").hidden = false; }
    });
    this.on(document, "mousemove", (e: MouseEvent) => {
      if (!this.locked) return;
      // Chrome sometimes reports one huge jump right after the pointer is captured; drop it
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      const k = 0.0022 * this.settings.sens;
      if (this.veh >= 0 && this.seat === 0) { this.camOffset -= e.movementX * k; this.pitch = Math.max(-0.6, Math.min(0.5, this.pitch - e.movementY * k)); return; }
      this.yaw -= e.movementX * k;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - e.movementY * k));
    });
    this.on(document, "mousedown", (e: MouseEvent) => { if (this.locked && e.button === 0) { this.mouseDown = true; this.clicked = true; } });
    this.on(document, "mouseup", (e: MouseEvent) => { if (e.button === 0) this.mouseDown = false; });
    this.on(window, "wheel", (e: WheelEvent) => { if (this.locked) this.cycleWeapon(e.deltaY > 0 ? 1 : -1); }, { passive: true });
    this.on(window, "keydown", (e: KeyboardEvent) => {
      if (this.chatting) return;
      if (e.code === "Tab") { e.preventDefault(); this.showBoard(true); return; }
      if (!this.locked) return;
      this.keys.add(e.code);
      if (e.code === "KeyR") this.reload();
      if (e.code === "KeyE") this.link.send({ t: "use" });
      if (e.code === "Digit1") this.switchTo("rifle");
      if (e.code === "Digit2") this.switchTo("pistol");
      if (e.code === "Digit3") this.switchTo("shotgun");
      if (e.code === "KeyT" || e.code === "Enter") { e.preventDefault(); this.openChat(); }
    });
    this.on(window, "keyup", (e: KeyboardEvent) => { this.keys.delete(e.code); if (e.code === "Tab") this.showBoard(false); });
    this.on(window, "blur", () => { this.keys.clear(); this.mouseDown = false; });
    const box = $<HTMLInputElement>("chatbox");
    this.on(box, "keydown", (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Enter") { const text = box.value.trim(); if (text) this.link.send({ t: "chat", text }); this.closeChat(); }
      if (e.key === "Escape") this.closeChat();
    });
  }

  private openChat() {
    this.chatting = true;
    const box = $<HTMLInputElement>("chatbox");
    box.hidden = false; box.value = "";
    document.exitPointerLock();
    setTimeout(() => box.focus(), 0);
  }

  private closeChat() {
    const box = $<HTMLInputElement>("chatbox");
    box.blur(); box.hidden = true;
    this.lock();
    setTimeout(() => { this.chatting = false; }, 200);
  }

  private bindPause() {
    const sens = $<HTMLInputElement>("sens"), vol = $<HTMLInputElement>("vol"), fov = $<HTMLInputElement>("fov");
    const show = () => { $("sensOut").textContent = this.settings.sens.toFixed(2); $("volOut").textContent = Math.round(this.settings.vol * 100) + "%"; $("fovOut").textContent = this.settings.fov + "°"; };
    sens.value = String(this.settings.sens); vol.value = String(this.settings.vol); fov.value = String(this.settings.fov); show();
    this.on(sens, "input", () => { this.settings.sens = +sens.value; saveSettings(this.settings); show(); });
    this.on(vol, "input", () => { this.settings.vol = +vol.value; sfx.setVolume(this.settings.vol); saveSettings(this.settings); show(); });
    this.on(fov, "input", () => { this.settings.fov = +fov.value; this.camera.fov = this.settings.fov; this.camera.updateProjectionMatrix(); saveSettings(this.settings); show(); });
    this.on($("resume"), "click", () => { sfx.initAudio(); this.lock(); });
    this.on($("quit"), "click", () => this.quit());
  }

  private resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.vmCam.aspect = w / h; this.vmCam.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- weapons

  private get nowS() { return performance.now() / 1000; }

  private switchTo(w: WeaponId) {
    if (!this.owned.has(w) || w === this.w || !this.alive) return;
    this.w = w; this.reloadUntil = 0;
    this.fireReady = this.nowS + 0.25; this.lastSwitchAt = this.nowS;
    this.link.send({ t: "switch", w });
    this.setVmGun(w);
  }

  private cycleWeapon(dir: number) {
    const list = WEAPON_ORDER.filter((w) => this.owned.has(w));
    const i = list.indexOf(this.w);
    this.switchTo(list[(i + dir + list.length) % list.length]);
  }

  private reload() {
    const w = WEAPONS[this.w];
    if (this.reloadUntil || !this.alive || this.mag[this.w] >= w.mag || this.res[this.w] <= 0) return;
    this.reloadStart = this.nowS;
    this.reloadUntil = this.nowS + w.reloadS;
    this.link.send({ t: "reload" });
    sfx.reload(w.reloadS);
  }

  private setVmGun(w: WeaponId) {
    if (this.vmGunId === w) return;
    if (this.vmGun) this.vm.remove(this.vmGun);
    this.vmGun = gunModel(w, VM_GUN);
    this.vmGun.scale.setScalar(0.48);
    this.vmGun.position.z = -0.08;
    this.vm.add(this.vmGun);
    this.vmGunId = w;
    this.vmFlash.position.set(0, 0.01, (w === "pistol" ? -0.2 : w === "rifle" ? -0.6 : -0.42) * 0.48 - 0.08);
  }

  private serverNow() { return this.nowS + (this.offset ?? 0); }

  private tryFire() {
    const w = WEAPONS[this.w];
    const want = w.auto ? this.mouseDown : this.clicked;
    this.clicked = false;
    if (!want || !this.alive || !this.locked || this.latest?.phase !== "play") return;
    const now = this.nowS;
    if (this.reloadUntil || now < this.fireReady) return;
    if (this.mag[this.w] <= 0) { sfx.dryFire(); this.fireReady = now + 0.25; this.reload(); return; }
    this.fireReady = (now - this.fireReady > 0.1 ? now : this.fireReady) + 60 / w.rpm;
    this.mag[this.w]--;
    this.lastShotAt = now;
    const moving = Math.hypot(this.body.vx, this.body.vz) > 1.2 || !this.body.onGround;
    const cone = w.spread + (moving ? w.moveSpread : 0);
    const dirs = spreadDirs(this.yaw, this.pitch, cone, w.pellets, Math.random);
    const view = this.serverNow() - INTERP_S;
    this.link.send({ t: "shoot", w: this.w, yaw: this.yaw, pitch: this.pitch, dirs, view });
    // our own boxes fly from the eye like the host's do, so they land where the host's land
    const ox = this.body.x, oy = this.body.y + EYE_H, oz = this.body.z;
    for (let i = 0; i < dirs.length; i += 3) this.fx.launch(ox, oy, oz, dirs[i], dirs[i + 1], dirs[i + 2], this.w, this.myTeam, this.myId);
    this.fx.muzzle(ox + dirs[0] * 0.8, oy, oz + dirs[2] * 0.8);
    sfx.shot(this.w);
    this.pitch = Math.min(1.5, this.pitch + w.kick * (0.6 + Math.random() * 0.5));
    this.yaw += (Math.random() - 0.5) * w.kick * 0.5;
    this.vmKick = 1; this.vmFlashT = 0.045; this.shake = Math.min(1, this.shake + w.kick * 8);
    if (this.mag[this.w] === 0) this.reload();
  }

  // ---------------------------------------------------------------- messages

  private onMessage(m: HostMsg) {
    switch (m.t) {
      case "welcome": this.myId = m.id; this.room = m.room; this.announced = false; break;
      case "error": this.quit(m.text); break;
      case "snap": this.onSnap(m); break;
      case "ev": for (const e of m.evs) this.onEvent(e); break;
    }
  }

  private onSnap(m: Extract<HostMsg, { t: "snap" }>) {
    const o = m.time - this.nowS;
    if (this.offset === null || Math.abs(o - this.offset) > 1) this.offset = o;
    else this.offset += (o - this.offset) * (o > this.offset ? 0.2 : 0.04);
    const players = new Map<number, PlayerSnap>();
    for (const p of m.players) players.set(p.id, p);
    this.names = players;
    this.snaps.push({ time: m.time, players, vehicles: m.vehicles });
    while (this.snaps.length > 30) this.snaps.shift();
    const prevPhase = this.latest?.phase;
    this.latest = m;
    const me = m.me;
    const now = this.nowS;
    if (me.spawn !== this.spawn) {
      // a respawn or a correction: take the host's position
      const respawned = !this.alive || me.spawn > this.spawn + 0 && Math.hypot(me.x - this.body.x, me.z - this.body.z) > 3;
      this.spawn = me.spawn;
      this.body.x = me.x; this.body.y = me.y; this.body.z = me.z; this.body.vx = this.body.vy = this.body.vz = 0;
      if (respawned) { this.yaw = me.yaw; this.pitch = 0; }
    }
    this.alive = me.alive;
    this.owned = new Set(me.owned);
    // forklift: on getting into the driver's seat, or when the host overrules our driving, take its pose
    if (me.veh !== this.veh || me.seat !== this.seat || (me.veh >= 0 && me.seat === 0 && me.vrev !== this.vrev)) {
      const v = m.vehicles.find((q) => q.id === me.veh);
      const newlyDriving = me.veh >= 0 && me.seat === 0 && (this.veh !== me.veh || this.seat !== 0);
      if (v) { this.drive.x = v.x; this.drive.z = v.z; this.drive.yaw = v.yaw; this.drive.speed = newlyDriving ? 0 : v.speed; }
      if (newlyDriving) { this.camOffset = 0; this.toast("Jedziesz: W/S gaz i wsteczny, A/D skręt, E wysiada"); }
      else if (me.veh >= 0 && me.seat === 1 && this.veh !== me.veh) this.toast("Rzucasz z wózka · E wysiada");
      this.veh = me.veh; this.seat = me.seat; this.vrev = me.vrev;
    }
    if (this.myTeam !== me.team) {
      // our group decides every teammate's tag colour, so rebuild the others when it changes
      this.myTeam = me.team;
      for (const h of this.humans.values()) { this.scene.remove(h.root); h.dispose(); }
      this.humans.clear();
    }
    this.sleeveMat.color.setHex(TEAM_COLORS[me.team & 1]);
    if (!this.announced) { this.announced = true; this.toast(`Grasz w: ${TEAM_NAMES[me.team & 1]}`); }
    if (now - this.lastSwitchAt > 0.6 && me.w !== this.w) { this.w = me.w; this.setVmGun(me.w); }
    const quietGun = now - this.lastShotAt > 0.4;
    const reloadDone = !this.reloadUntil || now > this.reloadUntil + 0.25;
    if (quietGun && reloadDone && !me.reloading) { this.mag = { ...me.mag }; this.res = { ...me.res }; this.reloadUntil = 0; }
    if (!me.alive) { this.reloadUntil = 0; }
    if (!this.owned.has(this.w)) this.switchTo("rifle");
    this.world.setPickups(m.pickups);
    if (prevPhase === "play" && m.phase === "end") this.showEnd(true);
    if (m.phase === "play") $("end").hidden = true;
  }

  private onEvent(e: Ev) {
    const name = (id: number) => this.names.get(id)?.n ?? "?";
    switch (e.k) {
      case "shot": {
        if (e.id === this.myId) return;
        const [ox, oy, oz] = e.o;
        const dist = Math.hypot(ox - this.body.x, oz - this.body.z);
        const team = this.names.get(e.id)?.tm ?? -1;
        for (let i = 0; i < e.dirs.length; i += 3) this.fx.launch(ox, oy, oz, e.dirs[i], e.dirs[i + 1], e.dirs[i + 2], e.w, team, e.id);
        if (dist < 40) this.fx.muzzle(ox, oy, oz);
        sfx.shot(e.w, dist);
        break;
      }
      case "hit":
        if (e.by === this.myId && e.on !== this.myId) {
          this.hitT = 0.15;
          $("hitmark").className = e.head ? "on head" : "on";
          sfx.hitMarker(e.head);
        }
        this.fx.bits(e.x, e.y, e.z, 8);
        if (e.on === this.myId) { this.hurtT = 0.6; sfx.hurt(); this.shake = Math.min(1, this.shake + 0.4); }
        break;
      case "kill": {
        const mine = e.by === this.myId || e.on === this.myId;
        const col = (id: number) => TEAM_CSS[(this.names.get(id)?.tm ?? 0) & 1];
        this.feed(`<b style="color:${col(e.by)}">${esc(name(e.by))}</b><span class="w">${WEAPONS[e.w].name}${e.head ? " · w kask" : ""}</span><b style="color:${col(e.on)}">${esc(name(e.on))}</b>`, mine);
        if (e.by === this.myId && e.on !== this.myId) {
          this.toast(`Wyeliminowano: ${name(e.on)}`); sfx.killConfirm();
          this.hitT = 0.3; $("hitmark").className = "on kill";
        }
        if (e.on === this.myId) {
          $("deathBy").textContent = e.by === this.myId ? "Własny karton. Zdarza się." : `Trafił(a) cię: ${name(e.by)}`;
          $("deathSub").textContent = `${WEAPONS[e.w].name}${e.head ? " · trafienie w kask" : ""}. Wracasz na halę za chwilę.`;
        }
        break;
      }
      case "pick": if (e.id === this.myId) { this.toast(PICK_TEXT[e.kind]); sfx.pickup(); if (e.kind === "shotgun" && !this.owned.has("shotgun")) this.owned.add("shotgun"); } break;
      case "join": this.feed(`<b>${esc(e.name)}</b> wchodzi na halę`, false); break;
      case "leave": this.feed(`<b>${esc(e.name)}</b> kończy zmianę`, false); break;
      case "chat": this.chat(e.name, e.text); break;
      case "end":
        $("endTitle").textContent = e.winner < 0 ? "Remis: obie grupy równo" : `${TEAM_NAMES[e.winner]} wygrywa zmianę`;
        this.endMvp = e.mvp;
        break;
      case "start": $("end").hidden = true; break;
    }
  }

  private feed(html: string, mine: boolean) {
    const el = document.createElement("div");
    el.className = "glass" + (mine ? " mine" : "");
    el.innerHTML = html;
    const f = $("feed");
    f.prepend(el);
    while (f.children.length > 5) f.lastElementChild!.remove();
    setTimeout(() => el.remove(), 6000);
  }

  private chat(name: string, text: string) {
    const el = document.createElement("div");
    el.innerHTML = `<b>${esc(name)}:</b> ${esc(text)}`;
    const c = $("chat"); c.append(el);
    while (c.children.length > 6) c.firstElementChild!.remove();
    setTimeout(() => el.remove(), 12000);
  }

  private toast(text: string) { const t = $("toast"); t.textContent = text; t.classList.add("on"); this.toastT = 2.2; }

  private boardHtml() {
    const score = this.latest?.score ?? [0, 0];
    let html = "";
    for (const t of [this.myTeam & 1, (this.myTeam & 1) ^ 1]) {
      const list = [...this.names.values()].filter((p) => p.tm === t).sort((a, b) => b.k - a.k || a.d - b.d);
      html += `<tr class="team"><th style="color:${TEAM_CSS[t]}"><span class="swatch" style="background:${TEAM_CSS[t]}"></span>${TEAM_NAMES[t]}${t === this.myTeam ? " · twoja" : ""}</th><th class="num" colspan="3" style="color:var(--text)">${score[t]} / ${TEAM_FRAG_LIMIT}</th></tr>`;
      html += list.map((p) =>
        `<tr class="${p.id === this.myId ? "me" : ""}"><td>${esc(p.n)}${p.bot ? '<span class="botmark">BOT</span>' : ""}</td><td class="num">${p.k}</td><td class="num">${p.d}</td><td class="num">${(p.k / Math.max(1, p.d)).toFixed(2)}</td></tr>`).join("");
    }
    return `<tr><th>Pracownik</th><th class="num">Eliminacje</th><th class="num">Zgony</th><th class="num">K/D</th></tr>` + html;
  }

  private showBoard(on: boolean) {
    $("board").hidden = !on;
    if (on) { $("boardTable").innerHTML = this.boardHtml(); $("boardRoom").textContent = this.room === "LOKALNY" ? "trening z botami" : `hala ${this.room}`; }
  }

  private showEnd(on: boolean) {
    $("end").hidden = !on;
    if (on) {
      $("endTable").innerHTML = this.boardHtml();
      const me = this.names.get(this.myId);
      const s = this.latest?.score ?? [0, 0];
      $("endSub").textContent = `${TEAM_NAMES[0]} ${s[0]} : ${s[1]} ${TEAM_NAMES[1]}. Najlepszy pracownik zmiany: ${this.endMvp || "–"}.` + (me ? ` Twój wynik: ${me.k} eliminacji, ${me.d} zgonów.` : "");
    }
  }

  // ---------------------------------------------------------------- frame

  private frame(t: number) {
    this.raf = requestAnimationFrame((tt) => this.frame(tt));
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    const nowS = t / 1000;

    // own movement at 60 Hz
    const f = viewDir(this.yaw, 0), r = [Math.cos(this.yaw), 0, -Math.sin(this.yaw)];
    const fw = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
    const st = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
    const riding = this.veh >= 0 && this.alive;
    const driving = riding && this.seat === 0;
    const canMove = this.alive && this.latest?.phase === "play" && !riding;
    const inp = {
      mx: canMove ? f[0] * fw + r[0] * st : 0, mz: canMove ? f[2] * fw + r[2] * st : 0,
      jump: canMove && this.keys.has("Space"), sprint: this.keys.has("ShiftLeft") && fw > 0,
    };
    this.acc += dt;
    // forklifts first: where they are decides what we bump into this frame
    const renderT = this.serverNow() - INTERP_S;
    const [a, b] = this.bracket(renderT);
    this.updateForklifts(a, b, renderT);
    const throttle = driving && this.latest?.phase === "play" ? fw : 0, steer = driving ? -st : 0;
    while (this.acc >= 1 / 60) {
      this.acc -= 1 / 60;
      if (driving) stepVehicle(this.drive, throttle, steer, 1 / 60, [...this.vehPoses.values()].filter((v) => v !== this.vehPoses.get(this.veh)));
      else if (this.alive && !riding) stepBody(this.body, inp, 1 / 60);
    }
    if (riding) {
      const pose = driving ? this.drive : this.vehPoses.get(this.veh);
      if (pose) { seatPos(pose, this.seat, this.seatTmp); this.body.x = this.seatTmp[0]; this.body.y = this.seatTmp[1]; this.body.z = this.seatTmp[2]; }
      this.body.vx = this.body.vz = 0; this.body.onGround = true;
    }
    if (driving && this.drive.speed < -0.3) { this.beepT -= dt; if (this.beepT <= 0) { this.beepT = 0.7; sfx.reverseBeep(); } }
    this.sendAcc += dt;
    if (this.sendAcc >= 1 / STATE_HZ && this.myId) {
      this.sendAcc = 0;
      if (this.alive) this.link.send({ t: "state", x: this.body.x, y: this.body.y, z: this.body.z, yaw: this.yaw, pitch: this.pitch, moving: Math.hypot(this.body.vx, this.body.vz) > 1, spawn: this.spawn });
      if (driving) this.link.send({ t: "drive", x: this.drive.x, z: this.drive.z, yaw: this.drive.yaw, speed: this.drive.speed, rev: this.vrev });
    }
    if (this.reloadUntil && nowS >= this.reloadUntil) {
      const w = WEAPONS[this.w], take = Math.min(w.mag - this.mag[this.w], this.res[this.w]);
      this.mag[this.w] += take; if (this.res[this.w] < 900) this.res[this.w] -= take; this.reloadUntil = 0;
    }
    this.tryFire();

    // others, interpolated
    const seen = new Set<number>();
    if (b) {
      for (const [id, pb] of b.players) {
        if (id === this.myId) continue;
        seen.add(id);
        let h = this.humans.get(id);
        if (!h) { h = new Human(pb.n, pb.c, pb.bot, pb.tm, pb.tm === this.myTeam); this.humans.set(id, h); this.scene.add(h.root); }
        const pa = a?.players.get(id);
        let x = pb.x, y = pb.y, z = pb.z, yaw = pb.yaw, pitch = pb.pitch;
        if (pa && a && b.time > a.time && pa.alive === pb.alive) {
          const k = Math.max(0, Math.min(1, (renderT - a.time) / (b.time - a.time)));
          x = pa.x + (pb.x - pa.x) * k; y = pa.y + (pb.y - pa.y) * k; z = pa.z + (pb.z - pa.z) * k;
          let dy = pb.yaw - pa.yaw; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
          yaw = pa.yaw + dy * k; pitch = pa.pitch + (pb.pitch - pa.pitch) * k;
        }
        h.setWeapon(pb.w);
        const d = Math.hypot(x - this.body.x, z - this.body.z);
        // a driver faces where the forklift faces, sitting; a thrower stands and aims freely
        const ride = pb.veh >= 0 ? this.vehPoses.get(pb.veh) : undefined;
        if (ride && pb.seat === 0) yaw = ride.yaw - Math.PI / 2;
        const mate = riding && pb.veh === this.veh; // no name tag in the face of whoever rides with us
        h.update(x, y, z, yaw, pitch, pb.alive, dt, !mate && (h.ally ? d < 80 : d < 25), !!ride && pb.seat === 0);
        if (pb.alive && d < 14 && Math.hypot(x - h.root.position.x, z - h.root.position.z) >= 0) { /* footsteps below */ }
      }
    }
    for (const [id, h] of this.humans) if (!seen.has(id)) { this.scene.remove(h.root); h.dispose(); this.humans.delete(id); }

    // camera
    const speed = Math.hypot(this.body.vx, this.body.vz);
    if (this.body.onGround && this.alive) {
      this.bob += dt * speed * 1.6;
      this.stepT -= dt * speed;
      if (this.stepT <= 0 && speed > 2) { this.stepT = 2.1; sfx.step(); }
    }
    const bobY = Math.sin(this.bob * 2) * 0.035 * Math.min(1, speed / 6);
    this.shake = Math.max(0, this.shake - dt * 4);
    const deadDrop = this.alive ? 0 : 1.1;
    this.camera.position.set(this.body.x, this.body.y + EYE_H + bobY - deadDrop, this.body.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = this.yaw + (Math.random() - 0.5) * this.shake * 0.01;
    this.camera.rotation.x = (this.alive ? this.pitch : -0.35) + (Math.random() - 0.5) * this.shake * 0.01;
    this.camera.rotation.z = this.alive ? 0 : 0.35;
    if (driving) {
      // the driver watches the forklift from behind; the mouse swings the view and it settles back
      this.camOffset *= Math.max(0, 1 - dt * 1.5);
      const cy = this.drive.yaw - Math.PI / 2 + this.camOffset;
      const back = 6.2, up = 3.4 - this.pitch * 3;
      const cx = this.drive.x + Math.sin(cy) * back, cz = this.drive.z + Math.cos(cy) * back;
      const t = Math.min(1, 1 - this.wallHit(this.drive.x, 1.6, this.drive.z, cx, up, cz));
      this.camera.position.set(this.drive.x + (cx - this.drive.x) * t, 1.6 + (up - 1.6) * t, this.drive.z + (cz - this.drive.z) * t);
      this.camera.lookAt(this.drive.x, 1.5, this.drive.z);
      this.yaw = cy;
    }
    if (driving && !this.selfHuman) {
      const me = this.names.get(this.myId);
      this.selfHuman = new Human(me?.n ?? "", me?.c ?? 0, false, this.myTeam, true);
      this.selfHuman.setWeapon(this.w);
      this.scene.add(this.selfHuman.root);
    }
    if (this.selfHuman) {
      this.selfHuman.root.visible = driving;
      if (driving) this.selfHuman.update(this.body.x, this.body.y, this.body.z, this.drive.yaw - Math.PI / 2, 0, true, dt, false, true);
    }

    // view model
    this.vmKick = Math.max(0, this.vmKick - dt * 9);
    const reloadK = this.reloadUntil ? Math.sin(Math.min(1, (nowS - this.reloadStart) / WEAPONS[this.w].reloadS) * Math.PI) : 0;
    this.vm.visible = this.alive && !driving;
    $("cross").hidden = driving;
    this.vm.position.set(0.21 + Math.cos(this.bob) * 0.012 * Math.min(1, speed / 5), -0.2 + bobY * 0.5 - reloadK * 0.12, -0.38 + this.vmKick * 0.05);
    this.vm.rotation.set(this.vmKick * 0.12 - reloadK * 0.7, 0, reloadK * 0.3);
    this.vmFlashT -= dt;
    this.vmFlash.visible = this.vmFlashT > 0;
    if (this.vmFlash.visible) this.vmFlash.rotation.z = Math.random() * Math.PI;

    this.fx.update(dt);
    this.world.update(nowS);
    this.updateHud(dt, nowS);

    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.vmScene, this.vmCam);
  }

  /** Draw every forklift (ours from our own driving, the rest interpolated) and give them to the collision world. */
  private updateForklifts(a: Snap | undefined, b: Snap | undefined, t: number) {
    if (!b) return;
    const k = a && b.time > a.time ? Math.max(0, Math.min(1, (t - a.time) / (b.time - a.time))) : 1;
    for (const vb of b.vehicles) {
      let pose = this.vehPoses.get(vb.id);
      if (!pose) { pose = { x: vb.x, z: vb.z, yaw: vb.yaw, speed: 0 }; this.vehPoses.set(vb.id, pose); this.dynBoxes.push({ kind: "forklift", x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 }); }
      if (vb.id === this.veh && this.seat === 0 && this.alive) { pose.x = this.drive.x; pose.z = this.drive.z; pose.yaw = this.drive.yaw; pose.speed = this.drive.speed; }
      else {
        const va = a?.vehicles.find((q) => q.id === vb.id) ?? vb;
        let dy = vb.yaw - va.yaw; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
        pose.x = va.x + (vb.x - va.x) * k; pose.z = va.z + (vb.z - va.z) * k; pose.yaw = va.yaw + dy * k; pose.speed = vb.speed;
      }
      let g = this.forklifts.get(vb.id);
      if (!g) { g = forkliftModel(); this.forklifts.set(vb.id, g); this.scene.add(g); }
      g.position.set(pose.x, 0, pose.z);
      g.rotation.y = pose.yaw;
      vehicleBoxInto(pose, this.dynBoxes[vb.id]);
    }
    setDynamicBoxes(this.dynBoxes);
  }

  /** Fraction (0…1) along a segment where it first meets a wall, for the chase camera. */
  private wallHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, d = Math.hypot(dx, dy, dz) || 1;
    const hit = rayWorld(ax, ay, az, dx / d, dy / d, dz / d, d);
    return hit >= d ? 0 : 1 - Math.max(0, hit - 0.3) / d;
  }

  /** Nearest forklift we could get on, or null. */
  private usable(): { id: number; seat: number } | null {
    if (!this.latest || this.veh >= 0 || !this.alive) return null;
    let best: { id: number; seat: number } | null = null, bd = VEH_USE_R;
    for (const v of this.latest.vehicles) {
      const pose = this.vehPoses.get(v.id) ?? v;
      const d = Math.hypot(pose.x - this.body.x, pose.z - this.body.z);
      if (d >= bd || (v.d && v.g)) continue;
      const other = this.names.get(v.d || v.g);
      if (other && other.tm !== this.myTeam) continue;
      bd = d; best = { id: v.id, seat: v.d ? 1 : 0 };
    }
    return best;
  }

  private bracket(t: number): [Snap | undefined, Snap | undefined] {
    const s = this.snaps;
    if (!s.length) return [undefined, undefined];
    for (let i = s.length - 1; i > 0; i--) if (s[i - 1].time <= t) return [s[i - 1], s[i]];
    return [undefined, s[0]];
  }

  private set(id: string, text: string, html = false) {
    if (this.hudCache[id] === text) return;
    this.hudCache[id] = text;
    if (html) $(id).innerHTML = text; else $(id).textContent = text;
  }

  private updateHud(dt: number, nowS: number) {
    const m = this.latest;
    if (!m) return;
    const left = Math.ceil(m.left);
    this.set("timer", `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`);
    const me = this.names.get(this.myId);
    const sc = m.score, mt = this.myTeam & 1;
    this.set("score", `<div class="${mt === 0 ? "me" : ""}"><i class="tdot" style="background:${TEAM_CSS[0]}"></i>${TEAM_NAMES[0]} <b>${sc[0]}</b></div><div class="${mt === 1 ? "me" : ""}"><i class="tdot" style="background:${TEAM_CSS[1]}"></i>${TEAM_NAMES[1]} <b>${sc[1]}</b></div><div>Ty <b>${me?.k ?? 0}</b> · do <b>${TEAM_FRAG_LIMIT}</b></div>`, true);
    const hp = Math.max(0, m.me.hp);
    this.set("hp", String(hp));
    ($("hpbar").firstElementChild as HTMLElement).style.width = hp + "%";
    $("hpbar").classList.toggle("low", hp <= 35);
    const w = WEAPONS[this.w];
    this.set("wname", w.name);
    this.set("mag", String(this.mag[this.w]));
    this.set("res", this.res[this.w] >= 900 ? "/ ∞" : `/ ${this.res[this.w]}`);
    this.set("weps", WEAPON_ORDER.map((id, i) => `<span class="${id === this.w ? "on" : this.owned.has(id) ? "" : "off"}">${i + 1} ${WEAPONS[id].name}</span>`).join(""), true);
    $("reloadHint").hidden = !this.reloadUntil;
    const use = this.usable();
    const prompt = this.veh >= 0 && m.me.alive ? (this.seat === 0 ? "Wysiądź z wózka" : "Zejdź z wózka") : use ? (use.seat === 0 ? "Wsiądź do wózka jako kierowca" : "Wskocz na wózek jako rzucający") : "";
    $("usePrompt").hidden = !prompt;
    if (prompt) this.set("usePromptText", prompt);
    // crosshair opens with spread
    const moving = Math.hypot(this.body.vx, this.body.vz) > 1.2 || !this.body.onGround;
    const gap = 4 + (w.spread + (moving ? w.moveSpread : 0)) * 420 + this.vmKick * 6;
    const ci = $("cross").children as HTMLCollectionOf<HTMLElement>;
    ci[0].style.top = `${-gap - 8}px`; ci[1].style.top = `${gap}px`; ci[2].style.left = `${-gap - 8}px`; ci[3].style.left = `${gap}px`;
    if (this.hitT > 0) { this.hitT -= dt; if (this.hitT <= 0) $("hitmark").className = ""; }
    this.hurtT = Math.max(0, this.hurtT - dt);
    $("vignette").style.opacity = String(Math.max(this.hurtT * 1.4, hp < 30 && m.me.alive ? 0.35 + Math.sin(nowS * 4) * 0.1 : 0));
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) $("toast").classList.remove("on"); }
    // death screen
    $("death").hidden = m.me.alive || m.phase !== "play";
    if (!m.me.alive) this.set("deathCount", `Powrót na halę za ${Math.ceil(m.me.respawnIn)} s`);
    if (m.phase === "end") this.set("endCount", `Nowa zmiana za ${Math.ceil(m.left)} s`);
    // Live map
    $("geo").hidden = m.me.geo <= 0;
    drawMinimap(this.mapCtx, m.players, [...this.vehPoses.values()], this.myId, this.myTeam, { x: this.body.x, z: this.body.z, yaw: this.yaw }, m.me.geo > 0, nowS);
  }

  quit(msg?: string) {
    if (this.quitting) return;
    this.quitting = true;
    cancelAnimationFrame(this.raf);
    for (const d of this.disposers) d();
    this.link.close();
    if (document.pointerLockElement) document.exitPointerLock();
    for (const id of ["hud", "pause", "board", "end", "death"]) $(id).hidden = true;
    $("feed").innerHTML = ""; $("chat").innerHTML = "";
    this.renderer.dispose();
    this.onQuit(msg);
  }
}

function esc(s: string) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
