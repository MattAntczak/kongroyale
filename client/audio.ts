// Every sound in efectivo ARENA is synthesised with WebAudio at run time (filtered noise and oscillators), so the game
// ships no audio files. The launchers beep like barcode scanners; there are no gunshots. Positional sounds fall off with distance from the listener.

import type { WeaponId } from "../shared/weapons";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let volume = 0.7;

export function initAudio() {
  if (ctx) { if (ctx.state === "suspended") void ctx.resume(); return; }
  ctx = new AudioContext();
  master = ctx.createGain(); master.gain.value = volume;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 6;
  master.connect(comp).connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  startAmbience();
}

export function setVolume(v: number) { volume = v; if (master) master.gain.value = v; }

function noise(t: number, dur: number, freq: number, q: number, gain: number, type: BiquadFilterType = "bandpass", decay = dur) {
  if (!ctx || !master || !noiseBuf) return;
  const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0005, t + decay);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.5, dur + 0.05);
}

function tone(t: number, f0: number, f1: number, dur: number, gain: number, type: OscillatorType = "sine") {
  if (!ctx || !master) return;
  const o = ctx.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}

// Each launcher "fires" with a barcode-scanner beep: a clean square-ish tone with a fast attack, plus a soft cardboard
// thump from the launch. The rifle beeps high and short, the pistol a touch longer, the Paletówka a double beep.
const BEEP = {
  rifle: { f: 2750, d: 0.055, n: 1 },
  pistol: { f: 3150, d: 0.08, n: 1 },
  shotgun: { f: 2250, d: 0.06, n: 2 },
  sniper: { f: 3600, d: 0.14, n: 1 },
  grenade: { f: 1500, d: 0.11, n: 1 },
} as const;

function beep(t: number, f: number, dur: number, gain: number, muffled: boolean) {
  if (!ctx || !master) return;
  const o = ctx.createOscillator(); o.type = "square"; o.frequency.value = f;
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = muffled ? 1800 : 6000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.004);
  g.gain.setValueAtTime(gain, t + dur - 0.01); g.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(lp).connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}

/** A launch: scanner beep plus a cardboard thump; `dist` in metres from the listener (0 = our own launcher). */
export function shot(w: WeaponId, dist = 0) {
  if (!ctx) return;
  const b = BEEP[w];
  const att = 1 / (1 + dist * 0.08);
  const t = ctx.currentTime;
  for (let i = 0; i < b.n; i++) beep(t + i * (b.d + 0.035), b.f, b.d, 0.16 * att, dist > 25);
  noise(t, 0.07, 260, 0.9, 0.35 * att, "lowpass", 0.07);
}

/** A cardboard grenade bursting: a soft thump and a rustle of scraps. */
export function boom(dist = 0) {
  if (!ctx) return;
  const att = 1 / (1 + dist * 0.05), t = ctx.currentTime;
  noise(t, 0.35, 140, 0.7, 1.1 * att, "lowpass", 0.35);
  noise(t + 0.03, 0.5, 2200, 0.6, 0.3 * att, "bandpass", 0.5);
  tone(t, 110, 45, 0.3, 0.6 * att, "sine");
}

/** The alarm when the server is being reconnected, or a delivery lands. */
export function alert() {
  if (!ctx) return;
  const t = ctx.currentTime;
  for (let i = 0; i < 3; i++) tone(t + i * 0.16, 1320, 1320, 0.1, 0.12, "square");
}

/** The beep of a point that is starting up; `dist` in metres. */
export function bootBeep(dist = 0) {
  if (!ctx) return;
  tone(ctx.currentTime, 1900, 1900, 0.07, 0.22 / (1 + dist * 0.04), "square");
}

/** The forklift's reversing beep. */
export function reverseBeep() {
  if (!ctx) return;
  tone(ctx.currentTime, 1050, 1050, 0.3, 0.06, "square");
}

export function hitMarker(head: boolean) {
  if (!ctx) return;
  const t = ctx.currentTime;
  tone(t, head ? 2400 : 1700, head ? 2200 : 1500, 0.06, 0.25, "square");
}

export function killConfirm() {
  if (!ctx) return;
  const t = ctx.currentTime;
  tone(t, 880, 880, 0.09, 0.22, "sine"); tone(t + 0.09, 1320, 1320, 0.14, 0.22, "sine");
}

export function hurt() {
  if (!ctx) return;
  const t = ctx.currentTime;
  noise(t, 0.12, 300, 0.5, 0.6, "lowpass");
  tone(t, 140, 70, 0.15, 0.35, "sine");
}

export function pickup() {
  if (!ctx) return;
  const t = ctx.currentTime;
  tone(t, 660, 660, 0.08, 0.2); tone(t + 0.07, 990, 990, 0.12, 0.2);
}

export function reload(dur: number) {
  if (!ctx) return;
  const t = ctx.currentTime;
  noise(t + 0.05, 0.05, 3000, 2, 0.35, "bandpass");
  noise(t + dur * 0.55, 0.05, 2500, 2, 0.4, "bandpass");
  noise(t + dur * 0.9, 0.06, 2000, 2, 0.45, "bandpass");
}

export function dryFire() {
  if (!ctx) return;
  noise(ctx.currentTime, 0.03, 4000, 3, 0.25, "bandpass");
}

/** A boot on concrete; `dist` in metres (0 = our own). Someone else's step fades out by ~25 m, a scuff of grit with
 *  it so a near one can be placed by ear. */
export function step(dist = 0) {
  if (!ctx) return;
  const att = dist <= 0 ? 1 : Math.max(0, 1 - dist / 26) ** 1.5;
  if (att <= 0.01) return;
  const t = ctx.currentTime;
  noise(t, 0.06, 180 + Math.random() * 60, 1.2, 0.2 * att, "lowpass", 0.06);
  noise(t + 0.01, 0.03, 2200 + Math.random() * 800, 1.5, 0.035 * att, "bandpass", 0.03);
}

/** A quiet hall: a low hum, and now and then a far forklift reversing. */
function startAmbience() {
  if (!ctx || !master || !noiseBuf) return;
  const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 160;
  const g = ctx.createGain(); g.gain.value = 0.06;
  src.connect(f).connect(g).connect(master); src.start();
  const beep = () => {
    if (!ctx) return;
    const t = ctx.currentTime;
    for (let i = 0; i < 4; i++) tone(t + i * 0.7, 1050, 1050, 0.32, 0.02, "square");
    setTimeout(beep, 25000 + Math.random() * 30000);
  };
  setTimeout(beep, 12000);
}
