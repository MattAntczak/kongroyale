// One efectivo ARENA session in the browser: renders the hall, reads mouse and keyboard, predicts our own movement and
// shots, interpolates everyone else from snapshots, and keeps the HUD current. The host (in-page or server) decides
// health, ammo and kills; this file only predicts what the host will most likely say and accepts what it does say.

import * as THREE from "three";
import { BOX_HIT_PAD, CROUCH_H, EYE_H, PLAYER_H, STEP_SPEED, blocked, bodyH, eyeH, rayPlayer, rayWorld, stepBody, viewDir, type Body } from "../shared/physics";
import { MONEY_START, PRICES, SHOP, WEAPONS, WEAPON_ORDER, aimCone, kickAim, maxSpeed, newAim, resetAim, settleAim, type WeaponId } from "../shared/weapons";
import { spreadDirs } from "../shared/sim";
import type { Ev, HostMsg, PlayerSnap, VehicleSnap } from "../shared/proto";
import { VEH_USE_R, rideSpeed, seatPos, stepVehicle, vehicleBox as vehicleBoxInto, type VehicleState } from "../shared/vehicle";
import { setDynamicBoxes } from "../shared/physics";
import type { Box } from "../shared/map";
import { buildWorld, forkliftModel, type WorldHandle } from "./world";
import { Human, TEAM_COLORS, TEAM_CSS, gunModel } from "./human";
import { ROUNDS_WIN, SITE_R, TEAM_NAMES, TEAM_SHORT } from "../shared/sim";
import { sites, useLayout, HALL, LAYOUTS } from "../shared/map";
import { STORIES } from "./story";
import { Fx } from "./fx";
import { drawMinimap } from "./minimap";
import * as sfx from "./audio";
import type { Link } from "./net";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const INTERP_S = 0.1;
const VM_GUN = new THREE.MeshStandardMaterial({ color: 0xc29a66, roughness: 0.85 });
const STATE_HZ = 30;
/** Others' footsteps carry this far (metres); one step every STRIDE metres run. */
const STEP_HEAR_M = 25;
const STRIDE = 2.1;
/** The camera follows a crouch or a stand-up with this time constant (s): about 0.12 s to settle. */
const EYE_TAU = 0.04;

export interface Settings { sens: number; vol: number; fov: number }
export function loadSettings(): Settings {
  const d: Settings = { sens: 1, vol: 0.7, fov: 80 };
  try { return { ...d, ...JSON.parse(localStorage.getItem("efectivo.settings") || "{}") }; } catch { return d; }
}
function saveSettings(s: Settings) { try { localStorage.setItem("efectivo.settings", JSON.stringify(s)); } catch { /* private mode */ } }

interface Snap { time: number; players: Map<number, PlayerSnap>; vehicles: VehicleSnap[] }

const PICK_TEXT = { med: "Apteczka · +50 zdrowia", ammo: "Zapas paczek uzupełniony", geo: "efectivo GEO · widzisz wszystkich przez 10 s" } as const;

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
  private boardT = 0;
  private rideT = 0;
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
  /** Our lobby team: it keeps its score when the roles swap at half time. */
  private myGroup = 0;
  private endMvp = "";
  private room = "";
  private body: Body = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: true };
  private yaw = 0; private pitch = 0;
  private spawn = -1;
  private alive = false;
  private keys = new Set<string>();
  private mouseDown = false; private clicked = false;
  private w: WeaponId = "pistol";
  /** The shop panel: open by itself at the start of a round, B toggles it; while open the number keys buy. */
  private shopOpen = false;
  private couldBuy = false;
  private mag: Record<WeaponId, number> = { rifle: 30, pistol: 12, shotgun: 0, sniper: 0, grenade: 2 };
  private res: Record<WeaponId, number> = { rifle: 120, pistol: 999, shotgun: 0, sniper: 0, grenade: 0 };
  /** Holding E on the server cable. */
  private acting = false;
  private caseMesh: THREE.Mesh;
  /** Who we watch while we are out, and when the next start-up beep is due. */
  private specId = 0;
  private specClick = false;
  /** Looking through the sight: the button, how far in we are (0…1), and the magnification right now. */
  private aiming = false;
  private zoomK = 0;
  private zoomNow = 1;
  private beepAt = 0;
  private bannerT = 0;
  private proj = new THREE.Vector3();
  private disposed = false;
  private owned = new Set<WeaponId>(["pistol"]);
  private reloadUntil = 0; private reloadStart = 0;
  private fireReady = 0; private lastShotAt = -9; private lastSwitchAt = -9;
  /** Our accuracy and recoil (the same model the host keeps for us), our throw count, and the predicted boxes of each
   *  throw the host has not answered yet: its "shot" event puts them on the host's lines. */
  private aim = newAim();
  private shotN = 0;
  private pending = new Map<number, number[]>();
  /** The eye height as the camera shows it (eased), the crosshair's gap in pixels, Space held since the last jump. */
  private eyeOff = EYE_H;
  private crossGap = 4;
  private jumpLatch = false;
  /** Metres run by each other player since their last footstep. */
  private strides = new Map<number, number>();
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

  /** A prefiltered environment map of a generic warehouse interior: pale floor, grey-blue walls, a dim roof with
   *  bright lamp strips (cool ones over the far end in the depot, for the cold store). 20 unlit meshes rendered once. */
  private static roomEnvironment(renderer: THREE.WebGLRenderer, depot: boolean): THREE.WebGLRenderTarget {
    const room = new THREE.Scene();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mats: THREE.MeshBasicMaterial[] = [];
    // colours above 1 are fine: the PMREM target is half-float and the lamps should give highlights
    const slab = (r: number, g: number, b: number, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
      const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }); mat.color.setRGB(r, g, b); mats.push(mat);
      const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.scale.set(sx, sy, sz); room.add(m);
    };
    slab(0.5, 0.48, 0.45, 0, -4, 0, 40, 0.2, 40); // concrete floor
    slab(0.1, 0.11, 0.13, 0, 4, 0, 40, 0.2, 40); // roof
    slab(0.3, 0.33, 0.38, -20, 0, 0, 0.2, 8, 40); slab(0.3, 0.33, 0.38, 20, 0, 0, 0.2, 8, 40); // walls
    slab(0.26, 0.29, 0.34, 0, 0, -20, 40, 8, 0.2); slab(0.34, 0.36, 0.4, 0, 0, 20, 40, 8, 0.2);
    for (let i = 0; i < 12; i++) {
      const x = (i % 4) * 9 - 13.5, z = Math.floor(i / 4) * 12 - 12, cool = depot && i % 4 === 3;
      slab(cool ? 7 : 9, cool ? 9 : 8.6, cool ? 12 : 7.8, x, 3.8, z, 3.2, 0.05, 0.6);
    }
    slab(1.6, 1.7, 2.0, 0, 1, 19.8, 9, 5, 0.1); // an open dock door: a soft, large highlight for glossy things
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromScene(room, 0.03, 0.1, 100);
    pmrem.dispose(); geo.dispose(); for (const m of mats) m.dispose();
    return rt;
  }

  /** `first` is the snapshot that told us a shift is on: it names the hall configuration and the mission. */
  constructor(private link: Link, myId: number, room: string, first: Extract<HostMsg, { t: "snap" }>, private onQuit: (msg?: string) => void) {
    this.myId = myId; this.room = room;
    useLayout(first.layout);
    const canvas = $<HTMLCanvasElement>("view");
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    // three r186 folded the soft filter into PCFShadowMap (PCFSoftShadowMap only warns now); shadow.radius below sets the blur
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.autoClear = false;
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, 1, 0.05, 700);

    // light: image-based fill from a tiny hand-built room, a sky/floor-bounce hemisphere, one shadowed key from the
    // roof lights and six shadowless points. That is 8 lights per fragment, the same count as before.
    const depot = LAYOUTS[first.layout].kind === "depot";
    // haze instead of black: far things fade into a dim blue-grey, which reads as depth; the far wall of the
    // longest sightline (184 m depot, ~610 m hall diagonal) keeps roughly two thirds / one third of its contrast
    const haze = depot ? 0x3a424e : 0x363d48;
    this.scene.background = new THREE.Color(haze);
    this.scene.fog = depot ? new THREE.Fog(haze, 45, 560) : new THREE.Fog(haze, 90, 860);
    // environment map: without one every metallic material (cladding, racks, trusses, forks) loses its specular
    // half and renders near-black. Rendered once at start-up into a small PMREM atlas; no per-frame cost.
    const env = Game.roomEnvironment(this.renderer, depot);
    this.scene.environment = env.texture; this.scene.environmentIntensity = depot ? 0.75 : 0.85;
    this.vmScene.environment = env.texture; this.vmScene.environmentIntensity = 0.9;
    this.disposers.push(() => env.dispose());
    // the ground colour is the bounce off the pale concrete floor: it is what lights walls from below and the ceiling
    this.scene.add(new THREE.HemisphereLight(0xe6ebff, depot ? 0x8f887c : 0x7d776d, depot ? 1.5 : 1.35));
    const key = new THREE.DirectionalLight(0xfff6e8, depot ? 1.9 : 2.1);
    // in the depot the light is steep but not vertical: a person throws a half-metre shadow and a pallet stack a
    // visible one, which is what makes things stand on the floor instead of floating over it. The walls between the
    // rooms do not cast (see world.ts), so they shade no floors.
    // (only the direction matters; the hall's light sits far out so that no corner of the 540 m hall is behind it)
    if (depot) key.position.set(-30, 120, 20); else key.position.set(-180, 360, 120);
    key.castShadow = true;
    key.shadow.mapSize.set(4096, 4096);
    // Fit the shadow camera to the building. With `up` along -z its axes line up with the hall's (the default +y up
    // turns the frustum by the light's heading, which left the corners of both maps without shadows), and tight
    // near/far planes keep the depth precision, so the bias can be centimetres instead of the old ~20 cm.
    const sc = key.shadow.camera;
    sc.up.set(0, 0, -1);
    const view = new THREE.Matrix4().lookAt(key.position, key.target.position, sc.up).setPosition(key.position).invert();
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity), c = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      c.set(i & 1 ? HALL.x1 : HALL.x0, i & 2 ? HALL.h + 1 : 0, i & 4 ? HALL.z1 : HALL.z0).applyMatrix4(view);
      lo.min(c); hi.max(c);
    }
    sc.left = lo.x - 2; sc.right = hi.x + 2; sc.bottom = lo.y - 2; sc.top = hi.y + 2; sc.near = Math.max(1, -hi.z - 2); sc.far = -lo.z + 2;
    sc.updateProjectionMatrix();
    // bias is in units of the depth range: about 1.5 cm of depth plus a normal offset of about one shadow texel
    key.shadow.bias = -0.015 / (sc.far - sc.near);
    key.shadow.normalBias = 0.7 * (sc.right - sc.left) / 4096;
    key.shadow.radius = depot ? 2.5 : 1.5;
    this.scene.add(key);
    // depot: one lamp per room (A bay, containers, central hall, cold store B, docks, packing); the cold store is blue-white
    // a building that brings its own lamps (Sortownia) lights its own rooms; it still uses the depot's look otherwise
    const points: [number, number, number][] = LAYOUTS[first.layout].lights ?? (depot
      ? [[-64, -27, 0xffe9c8], [-64, 11, 0xffe2b8], [-4, -4, 0xfff1dc], [51, 2, 0xbfdcff], [0, 46, 0xffe6c0], [50, -23, 0xfff4e6]]
      : [[-200, 0, 0xfff1dc], [-100, 0, 0xfff1dc], [0, -60, 0xfff1dc], [0, 60, 0xfff1dc], [100, 0, 0xfff1dc], [200, 0, 0xfff1dc]]);
    for (const [x, z, col] of points) {
      // decay 1.4 and a long range: a broad pool that still reaches the walls of its room, cut off before the next one
      const p = new THREE.PointLight(col, depot ? 45 : 80, depot ? 60 : 110, 1.4); p.position.set(x, depot ? 6.6 : 9.5, z); this.scene.add(p);
    }
    this.world = buildWorld(this.scene, first.mission);
    const caseMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.3, metalness: 0.5, emissive: 0x474fff, emissiveIntensity: 0.25 });
    this.caseMesh = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.3, 0.3), caseMat); this.caseMesh.visible = false; this.scene.add(this.caseMesh);
    this.fx = new Fx(this.scene, this.boxHit);

    // first-person view model
    // lit like the hall (same environment map, same hemisphere and key colours) so the hands do not look pasted on
    this.vmScene.add(new THREE.HemisphereLight(0xe6ebff, 0x8f887c, 1.1));
    const vk = new THREE.DirectionalLight(0xfff6e8, 1.7); vk.position.set(1, 2.4, 1.2); this.vmScene.add(vk);
    // a weak cool rim from behind-left separates the dark weapon from dark walls
    const vr = new THREE.DirectionalLight(0xaec4ff, 0.6); vr.position.set(-1.5, 0.6, -1); this.vmScene.add(vr);
    this.vmScene.add(this.vm);
    const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.4), this.sleeveMat); sleeve.position.set(0.05, -0.06, 0.2); this.vm.add(sleeve);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.08), new THREE.MeshStandardMaterial({ color: 0xe0b08c, roughness: 0.7 })); hand.position.set(0.015, -0.055, 0.03); this.vm.add(hand);
    const flashTex = (() => { const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d")!; const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, "rgba(235,238,255,1)"); gr.addColorStop(0.3, "rgba(120,128,255,0.7)"); gr.addColorStop(1, "rgba(71,79,255,0)"); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
    this.vmFlash = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), new THREE.MeshBasicMaterial({ map: flashTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.vmFlash.visible = false;
    this.vm.add(this.vmFlash);
    this.setVmGun("pistol");

    this.mapCtx = $<HTMLCanvasElement>("mapc").getContext("2d")!;
    sfx.setVolume(this.settings.vol);
    this.bindInput();
    this.bindPause();
    $("hud").hidden = false;
    this.resize();
    this.showBrief(first);
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
      if (rayPlayer(x, y, z, dx, dy, dz, p.x, p.y, p.z, out, BOX_HIT_PAD, o.crouch ? CROUCH_H : PLAYER_H) && out[0] < r.t) { r.t = out[0]; r.player = true; }
    }
    if (this.alive && owner !== this.myId && team !== this.myTeam && rayPlayer(x, y, z, dx, dy, dz, this.body.x, this.body.y, this.body.z, out, BOX_HIT_PAD, bodyH(this.body)) && out[0] < r.t) { r.t = out[0]; r.player = true; }
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
      if (!this.chatting && !this.quitting && this.latest?.phase === "play") { this.paused = true; $("pause").hidden = false; }
    });
    this.on(document, "mousemove", (e: MouseEvent) => {
      if (!this.locked) return;
      // Chrome sometimes reports one huge jump right after the pointer is captured; drop it
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      const k = 0.0022 * this.settings.sens / this.zoomNow; // the sight slows the hand as much as it magnifies
      if (this.veh >= 0 && this.seat === 0) { this.camOffset -= e.movementX * k; this.pitch = Math.max(-0.6, Math.min(0.5, this.pitch - e.movementY * k)); return; }
      this.yaw -= e.movementX * k;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - e.movementY * k));
    });
    this.on(document, "mousedown", (e: MouseEvent) => {
      if (!this.locked) return;
      if (e.button === 0) { this.mouseDown = true; this.clicked = true; }
      if (e.button === 2) this.aiming = true; // hold the right button: look through the sight
    });
    this.on(document, "mouseup", (e: MouseEvent) => { if (e.button === 0) this.mouseDown = false; if (e.button === 2) this.aiming = false; });
    this.on(document, "contextmenu", (e: Event) => e.preventDefault());
    this.on(window, "wheel", (e: WheelEvent) => { if (this.locked) this.cycleWeapon(e.deltaY > 0 ? 1 : -1); }, { passive: true });
    this.on(window, "keydown", (e: KeyboardEvent) => {
      if (this.chatting) return;
      if (e.code === "Tab") { e.preventDefault(); this.showBoard(true); return; }
      if (!this.locked) return;
      // Ctrl held for a crouch must not turn W, S or D into browser shortcuts
      if (e.ctrlKey) e.preventDefault();
      this.keys.add(e.code);
      if (e.code === "KeyR") this.reload();
      if (e.code === "KeyE" && !e.repeat) {
        // at the server a technician holds E to connect it; anywhere else E is the forklift
        if (this.canAct()) { this.acting = true; this.link.send({ t: "act", on: true }); }
        else this.link.send({ t: "use" });
      }
      if (e.code === "KeyB" && this.latest?.me.buy) this.shopOpen = !this.shopOpen;
      if (this.shopOpen && /^Digit[1-4]$/.test(e.code)) {
        const item = SHOP[Number(e.code[5]) - 1], me = this.latest?.me;
        const have = item === "grenade" ? this.mag.grenade >= WEAPONS.grenade.mag : this.owned.has(item);
        if (!me?.buy || !this.alive || have) sfx.dryFire();
        else if (me.money < PRICES[item]) { sfx.dryFire(); this.toast("Za mało pieniędzy"); }
        else { this.link.send({ t: "buy", item }); sfx.pickup(); }
        return;
      }
      if (e.code === "Digit1") this.switchTo("rifle");
      if (e.code === "Digit2") this.switchTo("pistol");
      if (e.code === "Digit3") this.switchTo("shotgun");
      if (e.code === "Digit4") this.switchTo("sniper");
      if ((e.code === "Digit5" || e.code === "KeyG") && this.mag.grenade > 0) this.switchTo("grenade");
      if (e.code === "KeyT" || e.code === "Enter") { e.preventDefault(); this.openChat(); }
    });
    this.on(window, "keyup", (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      if (e.code === "Space") this.jumpLatch = false;
      if (e.code === "Tab") this.showBoard(false);
      if (e.code === "KeyE" && this.acting) { this.acting = false; this.link.send({ t: "act", on: false }); }
    });
    this.on(window, "blur", () => { this.keys.clear(); this.mouseDown = false; });
    // Ctrl is the crouch key, and Ctrl+W would close the tab mid-round: the browser asks first while a match is on
    this.on(window, "beforeunload", (e: BeforeUnloadEvent) => { if (!this.quitting && this.latest?.phase !== "lobby") { e.preventDefault(); e.returnValue = ""; } });
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
    this.on(fov, "input", () => { this.settings.fov = +fov.value; saveSettings(this.settings); show(); });
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
    this.w = w; this.reloadUntil = 0; resetAim(this.aim);
    this.fireReady = this.nowS + 0.25; this.lastSwitchAt = this.nowS;
    this.link.send({ t: "switch", w });
    this.setVmGun(w);
  }

  /** The launcher to fall back on: the best one in hand. */
  private best(): WeaponId { return (["rifle", "sniper", "shotgun"] as const).find((w) => this.owned.has(w)) ?? "pistol"; }

  private cycleWeapon(dir: number) {
    const list = WEAPON_ORDER.filter((w) => this.owned.has(w));
    const i = list.indexOf(this.w);
    this.switchTo(list[(i + dir + list.length) % list.length]);
  }

  private reload() {
    const w = WEAPONS[this.w];
    if (this.reloadUntil || !this.alive || !w.reloadS || this.mag[this.w] >= w.mag || this.res[this.w] <= 0) return;
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
    this.vmFlash.position.set(0, 0.01, (w === "pistol" ? -0.2 : w === "rifle" ? -0.6 : w === "sniper" ? -0.86 : -0.42) * 0.48 - 0.08);
  }

  private serverNow() { return this.nowS + (this.offset ?? 0); }

  private tryFire() {
    const w = WEAPONS[this.w];
    const want = w.auto ? this.mouseDown : this.clicked;
    this.specClick = this.clicked;
    this.clicked = false;
    if (!want || !this.alive || !this.locked || this.latest?.phase !== "play") return;
    const now = this.nowS;
    if (this.reloadUntil || now < this.fireReady) return;
    if (this.mag[this.w] <= 0) { sfx.dryFire(); this.fireReady = now + 0.25; if (this.w === "grenade") this.switchTo(this.best()); else this.reload(); return; }
    this.fireReady = (now - this.fireReady > 0.1 ? now : this.fireReady) + 60 / w.rpm;
    this.mag[this.w]--;
    this.lastShotAt = now;
    // the host decides the throw from our view and its own copy of this model; we predict it with the same numbers
    // (our own random draw: the host's "shot" event moves the boxes onto its lines a moment later)
    settleAim(this.aim, w, now);
    const spd = this.moveSpeed(), air = !this.body.onGround, sight = this.zoomK > 0.8 && w.zoom > 1;
    const cone = aimCone(w, this.aim, spd, air, !!this.body.crouch, sight);
    // the host judges the speed of a throw by the positions it has: give it the one of this moment
    this.sendState();
    const dirs = spreadDirs(this.yaw + this.aim.py, this.pitch + this.aim.pp, cone, w.pellets, Math.random);
    kickAim(this.aim, this.w, now);
    const view = this.serverNow() - INTERP_S, n = ++this.shotN;
    this.link.send({ t: "shoot", w: this.w, yaw: this.yaw, pitch: this.pitch, view, spd: +spd.toFixed(2), air, sight, n });
    // our own boxes fly from the eye like the host's do, so they land where the host's land
    const ox = this.body.x, oy = this.body.y + eyeH(this.body.crouch), oz = this.body.z;
    const ids: number[] = [];
    for (let i = 0; i < dirs.length; i += 3) ids.push(this.fx.launch(ox, oy, oz, dirs[i], dirs[i + 1], dirs[i + 2], this.w, this.myTeam, this.myId));
    this.pending.set(n, ids);
    if (this.pending.size > 40) this.pending.delete(this.pending.keys().next().value!);
    this.fx.muzzle(ox + dirs[0] * 0.8, oy, oz + dirs[2] * 0.8);
    sfx.shot(this.w);
    this.vmKick = 1; this.vmFlashT = 0.045; this.shake = Math.min(1, this.shake + w.kick * 8);
    if (this.w === "grenade") { if (this.mag.grenade === 0) this.switchTo(this.best()); }
    else if (this.mag[this.w] === 0) this.reload();
  }

  /**
   * What holding E would do here: a technician at A or B connects (with the case, when the mission is the tags), a
   * worker at the point that is starting up disconnects it.
   */
  private canAct(): "plant" | "defuse" | null {
    const m = this.latest;
    if (!m || m.phase !== "play" || !this.alive || this.veh >= 0) return null;
    const pts = sites(m.mission);
    const near = (i: number) => Math.hypot(this.body.x - pts[i].x, this.body.z - pts[i].z) <= SITE_R;
    if (this.myTeam === 1 && m.obj.armed < 0 && (m.mission === "server" || m.me.carry) && (near(0) || near(1))) return "plant";
    if (this.myTeam === 0 && m.obj.armed >= 0 && near(m.obj.armed)) return "defuse";
    return null;
  }

  /** The loading screen: the mission's story scrolls up while the hall is built, then our own task. */
  private showBrief(m: Extract<HostMsg, { t: "snap" }>) {
    const st = STORIES[m.mission];
    $("crawlText").innerHTML = `<p class="ep">${st.episode}</p><h1>${st.title}</h1>` + st.text.map((t) => `<p>${t}</p>`).join("");
    const team = m.me.team & 1;
    $("briefRole").innerHTML = `<span class="badge" style="background:${TEAM_CSS[team]};color:#fff">${TEAM_NAMES[team]}</span><b>${st.task[team]}</b>`;
    $("briefLayout").textContent = LAYOUTS[m.layout].kind === "depot" ? `Mapa: ${LAYOUTS[m.layout].name}` : `Hala magazynowa, konfiguracja ${LAYOUTS[m.layout].name}`;
    $("brief").hidden = m.phase !== "brief";
    // restart the crawl
    const el = $("crawlText"); el.style.animation = "none"; void el.offsetHeight; el.style.animation = "";
  }

  // ---------------------------------------------------------------- messages

  /** A message from the host, routed here by main.ts while a shift is on. */
  handle(m: HostMsg) {
    if (this.disposed) return;
    if (m.t === "snap") this.onSnap(m);
    else if (m.t === "ev") for (const e of m.evs) this.onEvent(e);
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
      if (respawned) { this.yaw = me.yaw; this.pitch = 0; this.body.crouch = false; this.body.tucked = false; resetAim(this.aim); }
      else {
        // a correction: the host's stance too (and crouched wherever standing does not fit, or the head would be in a
        // roof and every later state refused), and its fall speed, so the body falls on as the host's clock says
        this.body.crouch = !!me.crouch || blocked(me.x, me.y + 0.01, me.z, false, PLAYER_H - 0.02);
        this.body.tucked = false; this.body.onGround = false;
        this.body.vy = Number.isFinite(me.vy) ? Math.min(0, me.vy) : 0;
      }
    }
    this.alive = me.alive; this.myGroup = me.group & 1;
    // a launcher we did not have a snap ago: just bought, the host has put it in our hands, full
    const bought = me.owned.some((w) => w !== "grenade" && !this.owned.has(w));
    this.owned = new Set(me.owned);
    // forklift: on getting into the driver's seat, or when the host overrules our driving, take its pose
    if (me.veh !== this.veh || me.seat !== this.seat || (me.veh >= 0 && me.seat === 0 && me.vrev !== this.vrev)) {
      const v = m.vehicles.find((q) => q.id === me.veh);
      const newlyDriving = me.veh >= 0 && me.seat === 0 && (this.veh !== me.veh || this.seat !== 0);
      if (v) { this.drive.x = v.x; this.drive.z = v.z; this.drive.yaw = v.yaw; this.drive.speed = newlyDriving ? 0 : v.speed; }
      if (newlyDriving) this.camOffset = 0;
      if (me.veh !== this.veh) this.rideT = now;
      this.veh = me.veh; this.seat = me.seat; this.vrev = me.vrev;
    }
    if (this.myTeam !== me.team) {
      // our group decides every teammate's tag colour, so rebuild the others when it changes
      this.myTeam = me.team;
      for (const h of this.humans.values()) { this.scene.remove(h.root); h.dispose(); }
      this.humans.clear();
    }
    this.sleeveMat.color.setHex(TEAM_COLORS[me.team & 1]);
    if ((bought || now - this.lastSwitchAt > 0.6) && me.w !== this.w) { this.w = me.w; this.setVmGun(me.w); }
    // the host dropped any reload when it handed over the launcher; a stale local timer or shot must not hold back its ammo
    if (bought) { this.reloadUntil = 0; this.lastShotAt = -9; this.fireReady = Math.max(this.fireReady, now + 0.25); }
    const quietGun = now - this.lastShotAt > 0.4;
    const reloadDone = !this.reloadUntil || now > this.reloadUntil + 0.25;
    if (quietGun && reloadDone && !me.reloading) { this.mag = { ...me.mag }; this.res = { ...me.res }; this.reloadUntil = 0; }
    if (!me.alive) { this.reloadUntil = 0; }
    if (!this.owned.has(this.w)) this.switchTo(this.best());
    // the shop opens by itself when buying becomes possible and shuts when the time is up
    // (for the freeze only: once the round is live 1-4 are weapon slots again, and B reopens the shop while buying lasts)
    const autoShop = me.buy && m.phase === "freeze";
    if (autoShop !== this.couldBuy) { this.couldBuy = autoShop; this.shopOpen = autoShop; }
    if (!me.buy) this.shopOpen = false;
    this.world.setPickups(m.pickups);
    if (prevPhase === "play" && m.phase === "end") this.showEnd(true);
    if (m.phase === "play") $("end").hidden = true;
    $("brief").hidden = m.phase !== "brief";

    if (this.acting && !this.canAct()) { this.acting = false; this.link.send({ t: "act", on: false }); }
  }

  private onEvent(e: Ev) {
    const name = (id: number) => this.names.get(id)?.n ?? "?";
    switch (e.k) {
      case "shot": {
        if (e.id === this.myId) {
          // the host's own lines for our throw: move the boxes we predicted onto them
          const ids = e.n !== undefined ? this.pending.get(e.n) : undefined;
          if (ids) {
            this.pending.delete(e.n!);
            ids.forEach((i, k) => this.fx.reaim(i, this.myId, e.o[0], e.o[1], e.o[2], e.dirs[k * 3], e.dirs[k * 3 + 1], e.dirs[k * 3 + 2]));
          }
          return;
        }
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
        this.fx.bits(e.x, e.y, e.z, 5);
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
          $("deathBy").textContent = e.by === this.myId ? "Upadek z wysokości" : `Trafił(a) cię: ${name(e.by)}`;
          $("deathSub").textContent = `${WEAPONS[e.w].name}${e.head ? " · trafienie w kask" : ""}`;
        }
        break;
      }
      case "pick": if (e.id === this.myId) { this.toast(PICK_TEXT[e.kind]); sfx.pickup(); } break;
      case "join": this.feed(`<b>${esc(e.name)}</b> wchodzi na halę`, false); break;
      case "leave": this.feed(`<b>${esc(e.name)}</b> kończy zmianę`, false); break;
      case "chat": this.chat(e.name, e.text); break;
      case "boom": {
        const d = Math.hypot(e.x - this.body.x, e.z - this.body.z);
        this.fx.bits(e.x, e.y, e.z, 70);
        sfx.boom(d);
        if (d < 12) this.shake = Math.min(1, this.shake + (1 - d / 12) * 0.9);
        break;
      }
      case "obj": {
        const who = name(e.id), mine = e.id === this.myId, tags = this.latest?.mission === "tags";
        const pt = (tags ? "stacja " : "serwer ") + "AB"[e.site];
        if (e.what === "plant") { this.feed(`<b style="color:${TEAM_CSS[1]}">${esc(who)}</b> ${tags ? "montuje tagi" : "podłącza"}: ${pt}`, true); if (this.myTeam === 0) sfx.alert(); }
        else if (e.what === "armed") { this.banner(tags ? `Tagi zamontowane: stacja ${"AB"[e.site]}` : `Serwer ${"AB"[e.site]} się uruchamia`, this.myTeam === 0 ? "Odłącz go, zanim skończy się odliczanie" : "Broń punktu do końca odliczania"); sfx.alert(); }
        else if (e.what === "defuse") { this.feed(`<b style="color:${TEAM_CSS[0]}">${esc(who)}</b> odłącza: ${pt}`, true); if (this.myTeam === 1) sfx.alert(); }
        else if (e.what === "casepick") { if (mine) { this.toast("Masz tagi zegarkowe. Zanieś je do stacji A albo B"); sfx.pickup(); } }
        else if (e.what === "casedrop") this.feed(`<b>${esc(who)}</b> upuszcza skrzynkę tagów`, mine);
        break;
      }
      case "round":
        $("end").hidden = true;
        if (e.swapped && e.n > 1 && this.latest && !this.latest.obj.swapped) this.banner("Zmiana stron", `Drużyny zamieniają się rolami · wszyscy zaczynają od ${MONEY_START} zł i Paczkownika`);
        break;
      case "roundEnd": {
        const tags = this.latest?.mission === "tags";
        const why = e.reason === "plant" ? (tags ? "tagi działają" : "serwer uruchomiony") : e.reason === "defuse" ? (tags ? "tagi zdjęte" : "serwer odłączony")
          : e.reason === "time" ? "czas minął" : "cała drużyna rywali wyeliminowana";
        this.banner(`Rundę wygrywają ${e.winner === 0 ? "pracownicy" : "technicy"}`, `${why} · ${e.wins[this.myGroup]} : ${e.wins[1 - this.myGroup]}`);
        if (e.group === this.myGroup) sfx.killConfirm(); else sfx.hurt();
        break;
      }
      case "end":
        $("endTitle").textContent = e.group === this.myGroup ? "Wygrana: twoja drużyna bierze mecz" : "Przegrana: mecz dla rywali";
        this.endMvp = e.mvp;
        break;
    }
  }

  /** The big line in the middle of the screen: a point starting up, the end of a round. */
  private banner(title: string, sub: string) {
    $("bannerTitle").textContent = title; $("bannerSub").textContent = sub;
    $("banner").hidden = false; this.bannerT = 4;
  }

  private feed(html: string, mine: boolean) {
    const el = document.createElement("div");
    el.className = mine ? "mine" : "";
    el.innerHTML = html;
    const f = $("feed");
    f.prepend(el);
    while (f.children.length > 3) f.lastElementChild!.remove();
    setTimeout(() => el.remove(), 4000);
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
      const wins = this.latest ? this.latest.obj.wins[this.latest.obj.swapped ? 1 - t : t] : 0;
      html += `<tr class="team"><th style="color:${TEAM_CSS[t]}"><span class="swatch" style="background:${TEAM_CSS[t]}"></span>${TEAM_NAMES[t]}${t === this.myTeam ? " · twoja drużyna" : ""}</th><th class="num" colspan="3" style="color:var(--text)">${wins} rund · ${score[t]} eliminacji</th></tr>`;
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
      const wn = this.latest?.obj.wins ?? [0, 0];
      $("endSub").textContent = `Rundy: ${wn[this.myGroup]} : ${wn[1 - this.myGroup]}. Najlepszy w meczu: ${this.endMvp || "–"}.` + (me ? ` Ty: ${me.k} eliminacji, ${me.d} zgonów.` : "");
    }
  }

  // ---------------------------------------------------------------- frame

  /** Our state as the host checks it (sent at STATE_HZ and right before every throw). */
  private sendState() {
    this.link.send({ t: "state", x: this.body.x, y: this.body.y, z: this.body.z, yaw: this.yaw, pitch: this.pitch, moving: Math.hypot(this.body.vx, this.body.vz) > 1, spawn: this.spawn, crouch: !!this.body.crouch });
  }

  /** How fast we move for the spread of a throw: on foot our own speed, on the rear platform the forklift's share. */
  private moveSpeed(): number {
    const ride = this.veh >= 0 && this.alive ? this.vehPoses.get(this.veh) : undefined;
    return ride ? rideSpeed(ride) : Math.hypot(this.body.vx, this.body.vz);
  }

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
    // Shift walks quietly, Ctrl or C crouches; Space jumps once per press (holding it does not hop on its own)
    const scopedRun = WEAPONS[this.w].zoom >= 3 && this.zoomK > 0.6;
    const inp = {
      mx: canMove ? f[0] * fw + r[0] * st : 0, mz: canMove ? f[2] * fw + r[2] * st : 0,
      jump: canMove && this.keys.has("Space") && !this.jumpLatch,
      walk: this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"),
      crouch: this.alive && !riding && (this.keys.has("ControlLeft") || this.keys.has("ControlRight") || this.keys.has("KeyC")),
      speed: maxSpeed(this.w, scopedRun), climb: true,
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
      else if (this.alive && !riding) {
        const wasGround = this.body.onGround;
        stepBody(this.body, inp, 1 / 60);
        if (inp.jump && wasGround && !this.body.onGround && this.body.vy > 0) { this.jumpLatch = true; inp.jump = false; }
        // a landing goes to the host at once: a hop right after it (Space pressed again in the air) leaves the
        // ground the next step, and a host that never saw the feet down would keep counting the last jump's fall
        if (!wasGround && this.body.onGround && this.myId && this.alive) this.sendState();
        // a crouch in the air lifts the feet: keep the eye where it was and let it ease from there
        if (this.body.shift) { this.eyeOff -= this.body.shift; this.body.shift = 0; }
      }
    }
    if (riding) { this.body.crouch = false; this.body.tucked = false; }
    if (riding) {
      const pose = driving ? this.drive : this.vehPoses.get(this.veh);
      if (pose) { seatPos(pose, this.seat, this.seatTmp); this.body.x = this.seatTmp[0]; this.body.y = this.seatTmp[1]; this.body.z = this.seatTmp[2]; }
      this.body.vx = this.body.vz = 0; this.body.onGround = true;
    }
    if (driving && this.drive.speed < -0.3) { this.beepT -= dt; if (this.beepT <= 0) { this.beepT = 0.7; sfx.reverseBeep(); } }
    this.sendAcc += dt;
    if (this.sendAcc >= 1 / STATE_HZ && this.myId) {
      this.sendAcc = 0;
      if (this.alive) this.sendState();
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
        h.setCarry(pb.carry);
        h.setCrouch(!!pb.crouch);
        const d = Math.hypot(x - this.body.x, z - this.body.z);
        // a driver faces where the forklift faces, sitting; a thrower stands and aims freely
        const ride = pb.veh >= 0 ? this.vehPoses.get(pb.veh) : undefined;
        if (ride && pb.seat === 0) yaw = ride.yaw - Math.PI / 2;
        const mate = riding && pb.veh === this.veh; // no name tag in the face of whoever rides with us
        h.update(x, y, z, yaw, pitch, pb.alive, dt, !mate && (h.ally ? d < 80 : d < 25), !!ride && pb.seat === 0);
        // footsteps: someone running on the floor (not walking, not crouched, not riding) is heard within STEP_HEAR_M
        const run = pa && a && b.time > a.time && pa.alive ? Math.hypot(pb.x - pa.x, pb.z - pa.z) / (b.time - a.time) : 0;
        const rise = pa && a && b.time > a.time ? Math.abs(pb.y - pa.y) / (b.time - a.time) : 0;
        if (pb.alive && pb.veh < 0 && !pb.crouch && run > STEP_SPEED && rise < 1 && d < STEP_HEAR_M) {
          let m = (this.strides.get(id) ?? Math.random() * STRIDE) + run * dt;
          if (m >= STRIDE) { m -= STRIDE; sfx.step(d); }
          this.strides.set(id, m);
        }
      }
    }
    for (const [id, h] of this.humans) if (!seen.has(id)) { this.scene.remove(h.root); h.dispose(); this.humans.delete(id); this.strides.delete(id); }

    // camera
    const speed = Math.hypot(this.body.vx, this.body.vz);
    if (this.body.onGround && this.alive) {
      this.bob += dt * speed * 1.6;
      // only running is heard: a walk (Shift) or a crouch is silent, for us as for everyone else
      this.stepT -= dt * speed;
      if (this.stepT <= 0 && speed > STEP_SPEED) { this.stepT = STRIDE; sfx.step(); }
    }
    const bobY = Math.sin(this.bob * 2) * 0.035 * Math.min(1, speed / 6);
    this.shake = Math.max(0, this.shake - dt * 4);
    this.eyeOff += (eyeH(this.body.crouch) - this.eyeOff) * Math.min(1, dt / EYE_TAU);
    // the recoil punch moves the view itself: the boxes follow it, and pulling the mouse down works against it
    settleAim(this.aim, WEAPONS[this.w], this.nowS);
    this.camera.position.set(this.body.x, this.body.y + this.eyeOff + bobY, this.body.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = this.yaw + this.aim.py + (Math.random() - 0.5) * this.shake * 0.01;
    this.camera.rotation.x = this.pitch + this.aim.pp + (Math.random() - 0.5) * this.shake * 0.01;
    this.camera.rotation.z = 0;
    if (!this.alive) {
      // out for the round: watch a teammate from behind (left click picks the next one)
      const mates = [...this.names.values()].filter((q) => q.alive && q.id !== this.myId && q.tm === this.myTeam);
      const pool = mates.length ? mates : [...this.names.values()].filter((q) => q.alive && q.id !== this.myId);
      if (this.specClick && pool.length) this.specId = pool[(pool.findIndex((q) => q.id === this.specId) + 1) % pool.length].id;
      let tgt = pool.find((q) => q.id === this.specId);
      if (!tgt && pool.length) { tgt = pool[0]; this.specId = tgt.id; }
      const h = tgt ? this.humans.get(tgt.id) : undefined;
      if (tgt && h) {
        const p = h.root.position, cy = tgt.yaw;
        const cx = p.x + Math.sin(cy) * 3.6, cz = p.z + Math.cos(cy) * 3.6;
        const t = Math.min(1, 1 - this.wallHit(p.x, p.y + 1.7, p.z, cx, p.y + 2.6, cz));
        this.camera.position.set(p.x + (cx - p.x) * t, p.y + 1.7 + 0.9 * t, p.z + (cz - p.z) * t);
        this.camera.lookAt(p.x - Math.sin(cy) * 4, p.y + 1.5 + Math.sin(tgt.pitch) * 4, p.z - Math.cos(cy) * 4);
        this.set("deathCount", `Obserwujesz: ${tgt.n} · LPM zmienia · wracasz w następnej rundzie`);
      } else this.set("deathCount", "Wracasz w następnej rundzie");
    }
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
    // the sight: the right button narrows the view by the launcher's zoom; a scope (3x and up) fills the screen
    const zoom = WEAPONS[this.w].zoom;
    const wantAim = this.aiming && this.alive && !driving && zoom > 1 && !this.reloadUntil && this.latest?.phase !== "brief";
    this.zoomK += ((wantAim ? 1 : 0) - this.zoomK) * Math.min(1, dt * 14);
    this.zoomNow = 1 + (zoom - 1) * this.zoomK;
    const fov = 2 * Math.atan(Math.tan(this.settings.fov * Math.PI / 360) / this.zoomNow) * 180 / Math.PI;
    if (Math.abs(fov - this.camera.fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    const scoped = zoom >= 3 && this.zoomK > 0.6;
    $("scope").hidden = !scoped;
    this.vm.visible = this.alive && !driving && !scoped;
    $("cross").hidden = driving || scoped || !this.alive;
    this.vm.position.set(0.21 * (1 - this.zoomK * 0.85) + Math.cos(this.bob) * 0.012 * Math.min(1, speed / 5), -0.2 + this.zoomK * 0.07 + bobY * 0.5 - reloadK * 0.12, -0.38 + this.vmKick * 0.05);
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
    const clock = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
    const mt = this.myTeam & 1, o = m.obj, tags = m.mission === "tags";
    // the top pill: rounds won (ours first), the round clock, or the countdown of a point that is starting up
    const mine = o.wins[this.myGroup], theirs = o.wins[1 - this.myGroup];
    const mid = o.armed >= 0 && (m.phase === "play" || m.phase === "round")
      ? `<time class="boot">${tags ? "Stacja" : "Serwer"} ${"AB"[o.armed]} · ${Math.ceil(o.boot)} s</time>`
      : `<time>${m.phase === "play" ? clock : m.phase === "freeze" ? `Runda ${o.round} · ${Math.ceil(m.left)}` : `Runda ${o.round}`}</time>`;
    this.set("score", `<span class="me"><i style="background:${TEAM_CSS[mt]}"></i>${mine}</span>${mid}<span>${theirs}<i style="background:${TEAM_CSS[1 - mt]}"></i></span>`, true);
    this.set("teamChip", `<i style="background:${TEAM_CSS[mt]}"></i>${TEAM_NAMES[mt]}<small>${mt === 0 ? "obrona" : "atak"} · do ${ROUNDS_WIN} rund</small>`, true);
    $("carry").hidden = !m.me.carry;
    // connecting or disconnecting: one bar under the crosshair for whoever is at it (ours or theirs)
    const prog = o.armed < 0 ? o.plant : o.defuse;
    $("actBar").hidden = prog <= 0 || m.phase !== "play";
    if (prog > 0) { ($("actBar").firstElementChild as HTMLElement).style.width = Math.round(prog * 100) + "%"; this.set("actText", o.armed < 0 ? (tags ? "Montowanie tagów" : "Podłączanie serwera") : (tags ? "Zdejmowanie tagów" : "Odłączanie serwera")); }
    // the case of watch tags on the floor
    this.caseMesh.visible = !!o.case;
    if (o.case) { this.caseMesh.position.set(o.case[0], 0.22 + Math.sin(nowS * 3) * 0.05, o.case[1]); this.caseMesh.rotation.y = nowS; }
    // a point that is starting up beeps, faster and faster
    if (o.armed >= 0 && m.phase === "play" && nowS >= this.beepAt) {
      const s = sites(m.mission)[o.armed];
      this.beepAt = nowS + Math.max(0.12, o.boot / 40);
      sfx.bootBeep(Math.hypot(s.x - this.body.x, s.z - this.body.z));
    }
    if (this.bannerT > 0) { this.bannerT -= dt; if (this.bannerT <= 0) $("banner").hidden = true; }
    this.updateMarker(m);
    if (!$("board").hidden && nowS - this.boardT > 0.5) { this.boardT = nowS; $("boardTable").innerHTML = this.boardHtml(); }
    const hp = Math.max(0, m.me.hp);
    this.set("hp", String(hp));
    ($("hpbar").firstElementChild as HTMLElement).style.width = hp + "%";
    $("hpbar").classList.toggle("low", hp <= 35);
    this.set("money", `${m.me.money} zł`);
    $("shop").hidden = !(this.shopOpen && m.me.buy && this.alive);
    if (!$("shop").hidden) {
      const left = m.phase === "freeze" ? "do startu rundy" : "jeszcze kilka sekund";
      this.set("shop", `<h3>Sklep <span>${left} · B zamyka</span></h3>` + SHOP.map((id, k) => {
        const have = id === "grenade" ? this.mag.grenade >= WEAPONS.grenade.mag : this.owned.has(id);
        const cls = have ? "have" : m.me.money < PRICES[id] ? "no" : "";
        const note = id === "rifle" ? "serie, celownik 2×" : id === "shotgun" ? "garść paczek, z bliska" : id === "sniper" ? "luneta 4×, daleki zasięg" : `rzut łukiem, masz ${this.mag.grenade} z ${WEAPONS.grenade.mag}`;
        return `<div class="${cls}"><kbd>${k + 1}</kbd><span>${WEAPONS[id].name}<small>${note}</small></span><b>${have ? "masz" : PRICES[id] + " zł"}</b></div>`;
      }).join(""), true);
    }
    const w = WEAPONS[this.w];
    // five slots, always in the same place: 1 2 3 4 5
    this.set("slots", WEAPON_ORDER.map((id, k) => {
      const def = WEAPONS[id], own = this.owned.has(id) && (id !== "grenade" || this.mag.grenade > 0);
      const count = !this.owned.has(id) ? "" : id === "grenade" ? `${this.mag.grenade}` : `${this.mag[id]}<small>/${this.res[id] >= 900 ? "∞" : this.res[id]}</small>`;
      return `<div class="${id === this.w ? "on" : own ? "" : "off"}"><kbd>${k + 1}</kbd><span>${id === this.w && this.reloadUntil ? "Przeładowanie…" : def.name}</span><b>${count}</b></div>`;
    }).join(""), true);
    const use = this.usable();
    // on board the prompt shows only for the first seconds: the ride itself needs no label
    const act = this.canAct();
    const prompt = this.acting ? "" : act === "plant" ? (tags ? "Przytrzymaj: zamontuj tagi" : "Przytrzymaj: podłącz serwer") : act === "defuse" ? (tags ? "Przytrzymaj: zdejmij tagi" : "Przytrzymaj: odłącz serwer")
      : this.veh >= 0 && m.me.alive ? (nowS - this.rideT < 4 ? "Wysiądź" : "") : use ? (use.seat === 0 ? "Prowadź wózek" : "Wskocz na wózek") : "";
    $("usePrompt").hidden = !prompt;
    if (prompt) this.set("usePromptText", prompt);
    // the crosshair shows the real cone of the next throw: it opens with a spray, running or a jump and closes as the
    // aim recovers (the gap is the cone's radius on the screen, so a box lands inside it)
    const cone = aimCone(w, this.aim, this.moveSpeed(), !this.body.onGround, !!this.body.crouch, this.zoomK > 0.8 && w.zoom > 1);
    const want = 3 + Math.tan(cone) / Math.tan(this.camera.fov * Math.PI / 360) * window.innerHeight / 2;
    this.crossGap += (want - this.crossGap) * Math.min(1, dt * 30);
    const gap = this.crossGap.toFixed(1);
    if (this.hudCache.crossGap !== gap) { this.hudCache.crossGap = gap; $("cross").style.setProperty("--gap", `${gap}px`); }
    if (this.hitT > 0) { this.hitT -= dt; if (this.hitT <= 0) $("hitmark").className = ""; }
    this.hurtT = Math.max(0, this.hurtT - dt);
    $("vignette").style.opacity = String(Math.max(this.hurtT * 1.4, hp < 30 && m.me.alive ? 0.35 + Math.sin(nowS * 4) * 0.1 : 0));
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) $("toast").classList.remove("on"); }
    // death screen
    $("death").hidden = m.me.alive || (m.phase !== "play" && m.phase !== "round");
    if (m.phase === "end") this.set("endCount", `Powrót do lobby za ${Math.ceil(m.left)} s`);
    if (m.phase === "brief") this.set("briefCount", `Start za ${Math.ceil(m.left)} s`);
    // Live map
    $("geo").hidden = m.me.geo <= 0;
    drawMinimap(this.mapCtx, m.players, [...this.vehPoses.values()], this.myId, this.myTeam, { x: this.body.x, z: this.body.z, yaw: this.yaw }, m.me.geo > 0, nowS, { mission: m.mission, case: o.case, armed: o.armed });
  }

  /** The pointer to where we have to go: projected on the screen, pinned to its edge when the place is off it. */
  private updateMarker(m: Extract<HostMsg, { t: "snap" }>) {
    const pts = sites(m.mission), o = m.obj;
    const d = (p: { x: number; z: number }) => Math.hypot(p.x - this.body.x, p.z - this.body.z);
    // where to: the point that is starting up; else the case on the floor (technicians); else the nearer of A and B
    let i = o.armed >= 0 ? o.armed : d(pts[0]) <= d(pts[1]) ? 0 : 1;
    let tx = pts[i].x, tz = pts[i].z, label = "AB"[i];
    if (o.armed < 0 && o.case && this.myTeam === 1) { tx = o.case[0]; tz = o.case[1]; label = "Tagi"; i = -1; }
    const el = $("marker");
    const dist = Math.hypot(tx - this.body.x, tz - this.body.z);
    el.hidden = m.phase !== "play" || dist < 4;
    if (el.hidden) return;
    const v = this.proj.set(tx, 2.6, tz).project(this.camera);
    const w = window.innerWidth, h = window.innerHeight;
    let sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
    if (v.z > 1) { sx = w - sx; sy = h - 40; } // behind us: show it low, mirrored
    sx = Math.max(40, Math.min(w - 40, sx)); sy = Math.max(110, Math.min(h - 120, sy));
    el.style.transform = `translate(${sx.toFixed(0)}px, ${sy.toFixed(0)}px)`;
    this.set("markerText", `${label} ${Math.round(dist)} m`);
  }

  /** Leave the shift's screen. The room and its link stay: main.ts shows the lobby again. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.quitting = true;
    cancelAnimationFrame(this.raf);
    for (const d of this.disposers) d();
    // Every match builds its own renderer on the same canvas, so the same WebGL context: what this match put on the
    // GPU (the floor and wall textures, the atlases, the 4096 px shadow map) stays there until it is freed here.
    // Shared, module-level geometry and materials (characters, launchers, forklifts) are freed too: three.js uploads
    // them again when the next match first draws them.
    for (const root of [this.scene, this.vmScene]) root.traverse((o) => {
      if (o instanceof THREE.Light) { o.dispose(); return; }
      if (o instanceof THREE.InstancedMesh) o.dispose();
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) {
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
        mat.dispose();
      }
    });
    if (document.pointerLockElement) document.exitPointerLock();
    for (const id of ["hud", "pause", "board", "end", "death", "brief", "scope"]) $(id).hidden = true;
    $("feed").innerHTML = ""; $("chat").innerHTML = "";
    // back to the context's defaults (texture flipping above all), which the next match's renderer takes for granted
    this.renderer.resetState();
    this.renderer.dispose();
  }

  /** Leave the room altogether (the pause menu, or a lost connection). */
  quit(msg?: string) {
    if (this.disposed) return;
    this.dispose();
    this.link.close();
    this.onQuit(msg);
  }
}

function esc(s: string) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
