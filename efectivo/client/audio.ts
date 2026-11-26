// Every sound in efectivo ARENA is synthesised with WebAudio at run time (filtered noise and oscillators), so the game
// ships no audio files. Positional sounds fall off with distance from the listener.

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

const SHOT = {
  rifle: { f: 1400, q: 0.8, g: 0.9, d: 0.16, body: 120 },
  pistol: { f: 1900, q: 1.0, g: 0.75, d: 0.12, body: 160 },
  shotgun: { f: 800, q: 0.6, g: 1.2, d: 0.32, body: 70 },
} as const;

/** A gunshot; `dist` in metres from the listener (0 = our own gun). */
export function shot(w: WeaponId, dist = 0) {
  if (!ctx) return;
  const s = SHOT[w];
  const att = 1 / (1 + dist * 0.09);
  const t = ctx.currentTime;
  const far = dist > 25;
  noise(t, s.d, far ? s.f * 0.5 : s.f, s.q, s.g * att, "bandpass", s.d);
  noise(t, s.d * 2.5, 400, 0.7, s.g * 0.35 * att, "lowpass", s.d * 2.5); // the hall's tail
  tone(t, s.body * 2, s.body * 0.5, 0.09, 0.5 * att, "triangle");
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

export function step(dist = 0) {
  if (!ctx) return;
  noise(ctx.currentTime, 0.06, 180 + Math.random() * 60, 1.2, 0.18 / (1 + dist * 0.2), "lowpass", 0.06);
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
