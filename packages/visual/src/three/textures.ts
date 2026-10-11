/**
 * Procedural canvas textures: the six agent emblems (one 3x2 atlas, drawn as
 * thin engraved line marks; no images, no brand marks) and mono text quads
 * (hashes, CA). Created lazily on the client, cached, and disposed with an
 * LRU so hash churn never grows memory.
 */
import { CanvasTexture, LinearFilter, SRGBColorSpace, type Texture } from 'three';
import { AGENT_IDS, type AgentId } from '@carbon/core/contracts';
import { FONTS } from '../tokens.js';

const CELL = 128;

type Draw = (g: CanvasRenderingContext2D, s: number) => void;

/** Emblem drawings, centred in a unit cell of size s. Plain geometry. */
export const EMBLEMS: Record<AgentId, Draw> = {
  // SCOUT: radar arcs and a found point
  scout: (g, s) => {
    const c = s / 2;
    for (let i = 1; i <= 3; i++) {
      g.beginPath();
      g.arc(c, c + s * 0.18, s * 0.11 * i, -Math.PI * 0.85, -Math.PI * 0.15);
      g.stroke();
    }
    g.beginPath();
    g.arc(c + s * 0.17, c - s * 0.2, s * 0.045, 0, Math.PI * 2);
    g.fill();
  },
  // FORGE: a struck ingot (trapezoid) with a spark line
  forge: (g, s) => {
    g.beginPath();
    g.moveTo(s * 0.22, s * 0.66);
    g.lineTo(s * 0.78, s * 0.66);
    g.lineTo(s * 0.66, s * 0.48);
    g.lineTo(s * 0.34, s * 0.48);
    g.closePath();
    g.stroke();
    g.beginPath();
    g.moveTo(s * 0.5, s * 0.4);
    g.lineTo(s * 0.5, s * 0.22);
    g.moveTo(s * 0.38, s * 0.36);
    g.lineTo(s * 0.3, s * 0.24);
    g.moveTo(s * 0.62, s * 0.36);
    g.lineTo(s * 0.7, s * 0.24);
    g.stroke();
  },
  // HERALD: broadcast chevrons
  herald: (g, s) => {
    g.beginPath();
    g.arc(s * 0.3, s * 0.5, s * 0.06, 0, Math.PI * 2);
    g.fill();
    for (let i = 1; i <= 3; i++) {
      g.beginPath();
      g.arc(s * 0.3, s * 0.5, s * 0.12 * i, -Math.PI * 0.3, Math.PI * 0.3);
      g.stroke();
    }
  },
  // KEEPER: two linked rings
  keeper: (g, s) => {
    g.beginPath();
    g.arc(s * 0.4, s * 0.5, s * 0.17, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.arc(s * 0.6, s * 0.5, s * 0.17, 0, Math.PI * 2);
    g.stroke();
  },
  // TREASURER: a circle split 50 / 30 / 20
  treasurer: (g, s) => {
    const c = s / 2;
    const r = s * 0.24;
    g.beginPath();
    g.arc(c, c, r, 0, Math.PI * 2);
    g.stroke();
    const cuts = [0, 0.5, 0.8];
    for (const f of cuts) {
      const a = -Math.PI / 2 + f * Math.PI * 2;
      g.beginPath();
      g.moveTo(c, c);
      g.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
      g.stroke();
    }
  },
  // SENTINEL: shield outline with a gate bar
  sentinel: (g, s) => {
    g.beginPath();
    g.moveTo(s * 0.5, s * 0.2);
    g.lineTo(s * 0.74, s * 0.3);
    g.quadraticCurveTo(s * 0.72, s * 0.66, s * 0.5, s * 0.8);
    g.quadraticCurveTo(s * 0.28, s * 0.66, s * 0.26, s * 0.3);
    g.closePath();
    g.stroke();
    g.beginPath();
    g.moveTo(s * 0.38, s * 0.5);
    g.lineTo(s * 0.62, s * 0.5);
    g.stroke();
  },
};

let atlas: CanvasTexture | null = null;

/** 3x2 atlas, cell index = AGENT_IDS index. Alpha carries the engraving. */
export function getEmblemAtlas(): Texture | null {
  if (atlas) return atlas;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = CELL * 3;
  c.height = CELL * 2;
  const g = c.getContext('2d');
  if (!g) return null;
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  g.lineWidth = CELL * 0.045;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  AGENT_IDS.forEach((id, i) => {
    g.save();
    // canvas y grows down, texture v grows up: draw row 0 at the bottom
    const col = i % 3;
    const row = Math.floor(i / 3);
    g.translate(col * CELL, (1 - row) * CELL);
    EMBLEMS[id](g, CELL);
    g.restore();
  });
  atlas = new CanvasTexture(c);
  atlas.minFilter = LinearFilter;
  atlas.magFilter = LinearFilter;
  atlas.generateMipmaps = false;
  atlas.flipY = true;
  return atlas;
}

/** Small 2D emblem for DOM HUD (data URL), same drawings as the 3D engraving. */
const emblemUrls = new Map<AgentId, string>();
export function emblemDataUrl(agent: AgentId, stroke = '#2B313B'): string | null {
  const key = agent;
  const hit = emblemUrls.get(key);
  if (hit) return hit;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) return null;
  g.strokeStyle = stroke;
  g.fillStyle = stroke;
  g.lineWidth = 64 * 0.05;
  g.lineCap = 'round';
  EMBLEMS[agent](g, 64);
  const url = c.toDataURL('image/png');
  emblemUrls.set(key, url);
  return url;
}

// ───────────────────────────── mono text quads ─────────────────────────────

/** Resolved mono family for canvas text (next/font exposes a hashed family through the CSS var). */
function monoFamily(): string {
  let fromVar = '';
  try {
    fromVar = getComputedStyle(document.documentElement).getPropertyValue(FONTS.mono.cssVar).trim();
  } catch {
    /* no computed style (tests) */
  }
  return `${fromVar ? fromVar + ', ' : ''}'${FONTS.mono.family}', ui-monospace, monospace`;
}

interface TextEntry {
  tex: CanvasTexture;
  aspect: number;
}
const TEXT_CACHE_MAX = 96;
const textCache = new Map<string, TextEntry>();

/** Canvas texture of mono text; aspect = width/height. Cached (LRU, disposed on eviction). */
export function textTexture(text: string, opts: { bold?: boolean } = {}): TextEntry | null {
  if (typeof document === 'undefined') return null;
  const key = (opts.bold ? 'b:' : 'r:') + text;
  const hit = textCache.get(key);
  if (hit) {
    textCache.delete(key);
    textCache.set(key, hit);
    return hit;
  }
  const h = 48;
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  if (!g) return null;
  const font = `${opts.bold ? 700 : 400} ${h * 0.62}px ${monoFamily()}`;
  g.font = font;
  const w = Math.ceil(g.measureText(text).width + h * 0.4);
  c.width = Math.max(8, w);
  c.height = h;
  g.font = font;
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  g.fillText(text, h * 0.2, h / 2 + 1);
  const tex = new CanvasTexture(c);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = SRGBColorSpace;
  const entry = { tex, aspect: c.width / c.height };
  textCache.set(key, entry);
  if (textCache.size > TEXT_CACHE_MAX) {
    const oldest = textCache.keys().next().value as string;
    const old = textCache.get(oldest);
    textCache.delete(oldest);
    old?.tex.dispose();
  }
  return entry;
}
