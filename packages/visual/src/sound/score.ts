'use client';
/**
 * The scroll story's own sound. Scroll progress is its only clock (the same
 * store the 3D and HUD read, written once per frame by the shared ticker):
 *
 *  - a soft ambient bed per chapter (a three-voice pad plus the engine's wind),
 *    gliding between neighbouring chapters near their edges, so scrubbing in
 *    either direction always sounds like the scene on screen;
 *  - short cues at each chapter's moments (nucleons splitting, the glitch, each
 *    proton arriving, shells and bond arms forming, bond orders, the chamber's
 *    isotope, the shape picked, the replayed launch condensing into the coin).
 *
 * Synthesized with Web Audio (no assets). Silent until the visitor turns sound
 * on (sound.ts owns the AudioContext and the toggle). HONESTY: none of these
 * cues is the crystalline chime, which stays reserved for real hand-offs, and
 * chapter 08 cues only play over a real recorded launch.
 */
import { useEffect, useRef } from 'react';
import { ISOTOPES, type IsotopeId, type ShapeId } from '@carbon/core/contracts';
import { bondStageAt, clamp01, locate, protonAt, replayedCountAt, smoothstep } from '../story/chapters.js';
import type { ProgressStore } from '../story/progress.js';
import { sound } from './sound.js';

// ───────────────────────────── pure: beds and cue stages ─────────────────────────────

export interface Bed {
  /** Root of the pad (Hz). */
  root: number;
  /** Pad voices, semitones above the root. */
  chord: [number, number, number];
  /** Pad low-pass cutoff (Hz). */
  cutoff: number;
  /** Pad level. */
  level: number;
  /** Wind level (the engine's existing wind bed). */
  wind: number;
}

/** One bed per chapter, in CHAPTERS order. Quiet on purpose: the pad sits under the wind. */
export const BEDS: readonly Bed[] = [
  { root: 110.0, chord: [0, 7, 12], cutoff: 650, level: 0.045, wind: 0.22 }, // 00 hero: open fifth in the fog
  { root: 110.0, chord: [0, 7, 10], cutoff: 850, level: 0.05, wind: 0.2 }, // 01 dismantle
  { root: 116.5, chord: [0, 6, 13], cutoff: 1500, level: 0.04, wind: 0.28 }, // 02 glitch: tritone, brighter
  { root: 130.8, chord: [0, 7, 16], cutoff: 1050, level: 0.05, wind: 0.14 }, // 03 six protons
  { root: 146.8, chord: [0, 7, 14], cutoff: 1250, level: 0.05, wind: 0.14 }, // 04 shells
  { root: 130.8, chord: [0, 4, 7], cutoff: 1150, level: 0.055, wind: 0.12 }, // 05 bonding
  { root: 98.0, chord: [0, 7, 15], cutoff: 780, level: 0.05, wind: 0.18 }, // 06 isotope chamber
  { root: 123.5, chord: [0, 7, 11], cutoff: 1150, level: 0.05, wind: 0.15 }, // 07 shapes
  { root: 110.0, chord: [0, 7, 12], cutoff: 1400, level: 0.055, wind: 0.1 }, // 08 the launch
  { root: 87.3, chord: [0, 7, 12], cutoff: 700, level: 0.045, wind: 0.2 }, // 09 live graphene
];

/** Share of a chapter at each edge over which its bed glides into the neighbour's. */
const GLIDE = 0.18;

export interface BedState {
  freqs: [number, number, number];
  cutoff: number;
  level: number;
  wind: number;
}

/** The bed at global progress p: the chapter's own, gliding (log-frequency) toward its neighbour near the edges. */
export function bedAt(p: number): BedState {
  const { index, local } = locate(clamp01(p));
  let j = index;
  let t = 0;
  if (local < GLIDE && index > 0) {
    j = index - 1;
    t = 0.5 * (1 - local / GLIDE);
  } else if (local > 1 - GLIDE && index < BEDS.length - 1) {
    j = index + 1;
    t = 0.5 * (1 - (1 - local) / GLIDE);
  }
  const a = BEDS[index]!;
  const b = BEDS[j]!;
  const mix = (x: number, y: number) => x + (y - x) * t;
  const logMix = (x: number, y: number) => Math.exp(mix(Math.log(x), Math.log(y)));
  const freq = (bed: Bed, k: number) => bed.root * Math.pow(2, bed.chord[k]! / 12);
  return {
    freqs: [logMix(freq(a, 0), freq(b, 0)), logMix(freq(a, 1), freq(b, 1)), logMix(freq(a, 2), freq(b, 2))],
    cutoff: logMix(a.cutoff, b.cutoff),
    level: mix(a.level, b.level),
    wind: mix(a.wind, b.wind),
  };
}

export interface ScoreInputs {
  isotope: IsotopeId;
  shape: ShapeId;
  /** Hand-offs in the real recorded launch (0 = none recorded: chapter 08 stays quiet). */
  replayHandoffs: number;
}

/** The moment a chapter is at: cues fire when this changes inside one chapter. */
export function cueStage(p: number, inputs: ScoreInputs): { chapter: number; stage: number } {
  const { index, local } = locate(clamp01(p));
  let stage = 0;
  switch (index) {
    case 1: // nucleons lift apart
      stage = local > 0.35 ? 1 : 0;
      break;
    case 2: // the glitch
      stage = local > 0.25 ? (local > 0.6 ? 2 : 1) : 0;
      break;
    case 3: // each proton arrives
      stage = protonAt(local);
      break;
    case 4: // shells appear, then the four bond arms
      stage = smoothstep(0, 0.15, local) > 0.5 ? (local > 0.78 ? 2 : 1) : 0;
      break;
    case 5: // single, double, triple
      stage = bondStageAt(local);
      break;
    case 8: // the real recorded launch replays, then condenses into the coin
      if (inputs.replayHandoffs > 0) stage = replayedCountAt(local, inputs.replayHandoffs) + (local > 0.82 ? 1000 : 0);
      break;
    default:
      stage = 0;
  }
  return { chapter: index, stage };
}

// ───────────────────────────── synthesis ─────────────────────────────

type Graph = NonNullable<ReturnType<typeof sound.graph>>;

function env(g: Graph, at: number, peak: number, attack: number, decay: number): GainNode {
  const n = g.ctx.createGain();
  n.gain.setValueAtTime(0, at);
  n.gain.linearRampToValueAtTime(peak, at + attack);
  n.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  return n;
}

let noiseBuf: AudioBuffer | null = null;
function noise(g: Graph): AudioBufferSourceNode {
  if (!noiseBuf || noiseBuf.sampleRate !== g.ctx.sampleRate) {
    noiseBuf = g.ctx.createBuffer(1, g.ctx.sampleRate, g.ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = g.ctx.createBufferSource();
  s.buffer = noiseBuf;
  return s;
}

/** Soft low thump with a breath of noise (things coming apart or together). */
function thump(g: Graph, at: number, amp: number): void {
  const o = g.ctx.createOscillator();
  o.frequency.setValueAtTime(120, at);
  o.frequency.exponentialRampToValueAtTime(48, at + 0.35);
  const e = env(g, at, 0.22 * amp, 0.008, 0.5);
  o.connect(e).connect(g.master);
  o.start(at);
  o.stop(at + 0.6);
  const n = noise(g);
  const bp = g.ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 900;
  bp.Q.value = 0.8;
  const ne = env(g, at, 0.05 * amp, 0.01, 0.35);
  n.connect(bp).connect(ne).connect(g.master);
  n.start(at);
  n.stop(at + 0.4);
}

/** Rising (or falling) breath of filtered noise. */
function whoosh(g: Graph, at: number, amp: number, up = true): void {
  const n = noise(g);
  const bp = g.ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.4;
  bp.frequency.setValueAtTime(up ? 300 : 1800, at);
  bp.frequency.exponentialRampToValueAtTime(up ? 1800 : 300, at + 0.7);
  const e = env(g, at, 0.06 * amp, 0.25, 0.6);
  n.connect(bp).connect(e).connect(g.master);
  n.start(at);
  n.stop(at + 1);
}

/** Muted pluck (triangle through a closing low-pass). */
function pluck(g: Graph, at: number, f: number, amp: number): void {
  const o = g.ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.value = f;
  const lp = g.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(f * 6, at);
  lp.frequency.exponentialRampToValueAtTime(f * 1.2, at + 0.35);
  const e = env(g, at, 0.07 * amp, 0.004, 0.55);
  o.connect(lp).connect(e).connect(g.master);
  e.connect(g.delay);
  o.start(at);
  o.stop(at + 0.65);
}

/** Round, harmonic glass tone (sine + octave), distinct from the inharmonic real-hand-off chime. */
function glass(g: Graph, at: number, f: number, amp: number): void {
  const e = env(g, at, 0.05 * amp, 0.02, 1.4);
  e.connect(g.master);
  e.connect(g.delay);
  for (const [mult, a] of [
    [1, 1],
    [2, 0.25],
  ] as const) {
    const o = g.ctx.createOscillator();
    o.frequency.value = f * mult;
    const ga = g.ctx.createGain();
    ga.gain.value = a;
    o.connect(ga).connect(e);
    o.start(at);
    o.stop(at + 1.5);
  }
}

/** A few digital blips (the glitch). */
function glitch(g: Graph, at: number, amp: number): void {
  for (let i = 0; i < 6; i++) {
    const t = at + i * 0.035 + Math.random() * 0.02;
    const o = g.ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = 300 + Math.random() * 1400;
    const e = env(g, t, 0.025 * amp, 0.002, 0.03);
    o.connect(e).connect(g.master);
    o.start(t);
    o.stop(t + 0.05);
  }
}

/** One geiger tick (unstable isotopes in the chamber). */
function tick(g: Graph, at: number, amp: number): void {
  const n = noise(g);
  const hp = g.ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2500;
  const e = env(g, at, 0.05 * amp, 0.001, 0.012);
  n.connect(hp).connect(e).connect(g.master);
  n.start(at, Math.random() * 0.5);
  n.stop(at + 0.03);
}

const PENTA = [0, 2, 4, 7, 9, 12];
const SHAPE_NOTES: Record<ShapeId, number[]> = { chain: [0, 7, 14], ring: [0, 4, 7, 12], diamond: [0, 5, 7, 12, 17] };
const note = (root: number, semis: number) => root * Math.pow(2, semis / 12);

function playCue(g: Graph, chapter: number, stage: number, prev: number, forward: boolean): void {
  const at = g.ctx.currentTime + 0.01;
  const amp = forward ? 1 : 0.55;
  switch (chapter) {
    case 1:
      if (stage === 1) thump(g, at, amp);
      else whoosh(g, at, amp * 0.7, false);
      break;
    case 2:
      if (stage > 0) glitch(g, at, amp);
      break;
    case 3:
      glass(g, at, note(523.25, PENTA[stage]!), amp);
      break;
    case 4:
      if (stage === 1) whoosh(g, at, amp);
      if (stage === 2) for (let k = 0; k < 4; k++) pluck(g, at + k * 0.09, note(293.66, [0, 7, 12, 19][k]!), amp);
      break;
    case 5:
      for (let k = 0; k < stage; k++) pluck(g, at + k * 0.07, note(261.63, [0, 4, 7][k]!), amp);
      break;
    case 8:
      if (stage >= 1000 && prev < 1000) {
        thump(g, at, amp);
        whoosh(g, at, amp);
      } else if (stage % 1000 > prev % 1000) pluck(g, at, note(220, PENTA[(stage % 1000) % PENTA.length]!), amp * 0.8);
      break;
  }
}

// ───────────────────────────── the score ─────────────────────────────

/** Minimum gap between cues, so a fast fling does not machine-gun. */
const CUE_GAP_MS = 90;

class ScrollScore {
  private voices: { osc: OscillatorNode; gain: GainNode }[] = [];
  private lp: BiquadFilterNode | null = null;
  private out: GainNode | null = null;
  private ctx: AudioContext | null = null;
  private last = { chapter: -1, stage: 0, p: 0, at: 0, cueAt: 0 };
  private geiger = 0;
  inputs: ScoreInputs = { isotope: 'C-12', shape: 'ring', replayHandoffs: 0 };

  private ensure(g: Graph): void {
    if (this.ctx === g.ctx && this.out) return;
    const lp = g.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.5;
    lp.frequency.value = 800;
    const out = g.ctx.createGain();
    out.gain.value = 0;
    lp.connect(out).connect(g.master);
    out.connect(g.delay);
    this.voices = [0, 1, 2].map((k) => {
      const osc = g.ctx.createOscillator();
      osc.type = k === 0 ? 'sine' : 'triangle';
      osc.frequency.value = 110;
      const gain = g.ctx.createGain();
      gain.gain.value = k === 0 ? 0.6 : 0.3;
      // slow breathing on each voice
      const lfo = g.ctx.createOscillator();
      lfo.frequency.value = 0.07 + k * 0.03;
      const amt = g.ctx.createGain();
      amt.gain.value = 0.12;
      lfo.connect(amt).connect(gain.gain);
      osc.connect(gain).connect(lp);
      osc.start();
      lfo.start();
      return { osc, gain };
    });
    this.lp = lp;
    this.out = out;
    this.ctx = g.ctx;
  }

  /** Called on every progress change (the shared frame clock) and on toggles. */
  update(p: number): void {
    const g = sound.graph();
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!g) {
      this.fadeOut();
      this.last = { ...this.last, chapter: -1, p, at: nowMs };
      return;
    }
    this.ensure(g);
    const t = g.ctx.currentTime;
    const bed = bedAt(p);
    // scroll speed opens the filter a little: moving through a scene sounds like moving
    const dt = Math.max(1, nowMs - this.last.at);
    const speed = Math.min(1, (Math.abs(p - this.last.p) / dt) * 1000 * 8);
    this.voices.forEach((v, k) => v.osc.frequency.setTargetAtTime(bed.freqs[k]!, t, 0.12));
    this.lp!.frequency.setTargetAtTime(bed.cutoff * (1 + speed * 1.5), t, 0.15);
    this.out!.gain.setTargetAtTime(bed.level * (1 + speed * 0.5), t, 0.3);
    g.wind.gain.setTargetAtTime(bed.wind, t, 0.4);

    const cur = cueStage(p, this.inputs);
    const prev = this.last;
    if (cur.chapter === prev.chapter && cur.stage !== prev.stage && nowMs - prev.cueAt >= CUE_GAP_MS) {
      playCue(g, cur.chapter, cur.stage, prev.stage, cur.stage > prev.stage);
      this.last.cueAt = nowMs;
    }
    this.last = { chapter: cur.chapter, stage: cur.stage, p, at: nowMs, cueAt: this.last.cueAt };
    this.syncGeiger(cur.chapter);
  }

  /** Chamber choices (made by the visitor) get their own cue. */
  isotopeChanged(iso: IsotopeId): void {
    this.inputs.isotope = iso;
    const g = sound.graph();
    if (!g || this.last.chapter !== 6) return;
    const n = ISOTOPES[iso].neutrons;
    glass(g, g.ctx.currentTime + 0.01, note(196, (n - 5) * 3), 1);
  }

  shapeChanged(shape: ShapeId): void {
    this.inputs.shape = shape;
    const g = sound.graph();
    if (!g || this.last.chapter !== 7) return;
    const at = g.ctx.currentTime + 0.01;
    SHAPE_NOTES[shape].forEach((s, k) => pluck(g, at + k * 0.08, note(246.94, s), 0.9));
  }

  /** Unstable isotopes tick while the chamber is on screen: C-11 fast, C-14 slow. */
  private syncGeiger(chapter: number): void {
    const iso = ISOTOPES[this.inputs.isotope];
    const want = chapter === 6 && !iso.stable && !!sound.graph();
    if (!want) {
      if (this.geiger) clearTimeout(this.geiger);
      this.geiger = 0;
      return;
    }
    if (this.geiger) return;
    const loop = () => {
      const g = sound.graph();
      const cur = ISOTOPES[this.inputs.isotope];
      if (!g || this.last.chapter !== 6 || cur.stable) {
        this.geiger = 0;
        return;
      }
      tick(g, g.ctx.currentTime + 0.005, 0.8 + Math.random() * 0.4);
      const mean = cur.decay.kind === 'quiet' ? 160 : 520; // C-11 decays fast, C-14 slowly
      this.geiger = window.setTimeout(loop, -Math.log(1 - Math.random()) * mean + 30);
    };
    this.geiger = window.setTimeout(loop, 60);
  }

  fadeOut(): void {
    if (this.out && this.ctx) this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
    if (this.geiger) clearTimeout(this.geiger);
    this.geiger = 0;
  }
}

export const scrollScore = new ScrollScore();

/** Drives the score from the story's progress store and the visitor's chamber / shape choices. */
export function useScrollScore(store: ProgressStore, inputs: ScoreInputs): void {
  const first = useRef(true);
  useEffect(() => {
    const run = () => scrollScore.update(store.get());
    run();
    const offStore = store.subscribe(run);
    const offSound = sound.subscribe(run);
    return () => {
      offStore();
      offSound();
      scrollScore.fadeOut();
    };
  }, [store]);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      scrollScore.inputs.isotope = inputs.isotope;
      return;
    }
    scrollScore.isotopeChanged(inputs.isotope);
  }, [inputs.isotope]);
  const firstShape = useRef(true);
  useEffect(() => {
    if (firstShape.current) {
      firstShape.current = false;
      scrollScore.inputs.shape = inputs.shape;
      return;
    }
    scrollScore.shapeChanged(inputs.shape);
  }, [inputs.shape]);
  useEffect(() => {
    scrollScore.inputs.replayHandoffs = inputs.replayHandoffs;
  }, [inputs.replayHandoffs]);
}

