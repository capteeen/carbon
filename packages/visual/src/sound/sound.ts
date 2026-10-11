'use client';
/**
 * Procedural sound: wind (filtered noise with slow LFOs) and soft crystalline
 * tones (inharmonic bell partials). OFF by default; the AudioContext is only
 * created by a user gesture (the toggle). Tones fire ONLY for real bond
 * events: `chime(hash)` requires a real event id and each id chimes once.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { isEventId } from '../hud/format.js';
import { hash32 } from '../data/derive.js';
import type { BondFlash } from '../types.js';

const PENTATONIC = [0, 3, 5, 7, 10, 12, 15];

class CarbonSound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private delay: DelayNode | null = null;
  private chimed = new Set<string>();
  private subs = new Set<() => void>();
  enabled = false;

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };
  isEnabled = () => this.enabled;

  private build(): void {
    const AC: typeof AudioContext | undefined =
      typeof window !== 'undefined' ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined;
    if (!AC) return;
    const ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    // wind: 2 s looping noise → band-pass (LFO-swept) → low-pass → gain (LFO)
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // brown-ish noise
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 420;
    bp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.22;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 260;
    lfo.connect(lfoAmt).connect(bp.frequency);
    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.11;
    const lfo2Amt = ctx.createGain();
    lfo2Amt.gain.value = 0.09;
    lfo2.connect(lfo2Amt).connect(windGain.gain);
    src.connect(bp).connect(lp).connect(windGain).connect(master);
    src.start();
    lfo.start();
    lfo2.start();

    // tones go through a soft feedback delay for a crystalline tail
    const delay = ctx.createDelay(1.5);
    delay.delayTime.value = 0.31;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    delay.connect(fb).connect(delay);
    delay.connect(wet).connect(master);

    this.ctx = ctx;
    this.master = master;
    this.delay = delay;
  }

  setEnabled(on: boolean): void {
    if (on && !this.ctx) this.build();
    this.enabled = on && !!this.ctx;
    const ctx = this.ctx;
    if (ctx && this.master) {
      const now = ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(this.enabled ? 0.9 : 0, now, 0.25);
      if (this.enabled) void ctx.resume();
    }
    this.subs.forEach((f) => f());
  }

  toggle(): void {
    this.setEnabled(!this.enabled);
  }

  /** One soft crystalline tone for a real bond event. Ignores non-ids and repeats. */
  chime(eventId: string): boolean {
    if (!isEventId(eventId) || this.chimed.has(eventId)) return false;
    this.chimed.add(eventId);
    if (this.chimed.size > 512) this.chimed.delete(this.chimed.values().next().value as string);
    const ctx = this.ctx;
    if (!this.enabled || !ctx || !this.master || !this.delay) return false;
    const h = hash32(eventId);
    const semis = PENTATONIC[h % PENTATONIC.length]!;
    const f0 = 1046.5 * Math.pow(2, semis / 12); // C6 pentatonic
    const now = ctx.currentTime + 0.01;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.master);
    out.connect(this.delay);
    out.gain.setValueAtTime(0, now);
    out.gain.linearRampToValueAtTime(0.07, now + 0.006);
    out.gain.exponentialRampToValueAtTime(0.0001, now + 2.2);
    const partials = [1, 2.76, 5.4];
    const amps = [1, 0.35, 0.12];
    partials.forEach((p, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f0 * p * (1 + ((h >> (i * 4)) & 7) * 0.0007);
      const g = ctx.createGain();
      g.gain.value = amps[i]!;
      o.connect(g).connect(out);
      o.start(now);
      o.stop(now + 2.3);
    });
    return true;
  }

  /** For tests. */
  _reset(): void {
    this.chimed.clear();
  }
}

export const sound = new CarbonSound();

export function useSoundEnabled(): boolean {
  return useSyncExternalStore(sound.subscribe, sound.isEnabled, () => false);
}

/**
 * Chimes once for each real hand-off that arrives while mounted. Hand-offs
 * already present at mount are history and stay silent unless they are
 * fresher than `freshMs`.
 */
export function useBondChimes(flashes: readonly BondFlash[] | null | undefined, freshMs = 5000): void {
  const mountedAt = useRef(0);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    mountedAt.current = Date.now();
  }, []);
  useEffect(() => {
    const list = flashes ?? [];
    if (!seen.current) {
      seen.current = new Set();
      for (const f of list) {
        seen.current.add(f.hash);
        if (isEventId(f.hash) && f.at >= (mountedAt.current || Date.now()) - freshMs) sound.chime(f.hash);
      }
      return;
    }
    for (const f of list) {
      if (seen.current.has(f.hash)) continue;
      seen.current.add(f.hash);
      sound.chime(f.hash);
    }
  }, [flashes, freshMs]);
}
