/**
 * HUD leader lines: thin 1px frost lines from 3D anchors to DOM labels.
 * 3D components write world positions into anchors inside useFrame; one
 * projector per canvas updates the SVG imperatively (no React renders, no
 * per-frame allocations).
 */
import { Vector3, type Camera } from 'three';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface LeaderAnchor {
  readonly id: string;
  /** World position, written by the owning 3D component every frame. */
  readonly world: Vector3;
  /** 0..1, written by the owning component (chapter fade × object visibility). */
  opacity: number;
}

interface Entry {
  anchor: LeaderAnchor;
  label: HTMLElement | null;
  /** Chapter layer the label sits in (-1: none, always visible). */
  layer: number;
  line: SVGLineElement | null;
  dot: SVGCircleElement | null;
  rect: { x: number; y: number; w: number; h: number; ok: boolean };
  lx1: number;
  ly1: number;
  lx2: number;
  ly2: number;
  lo: number;
}

export class LeaderRegistry {
  private entries = new Map<string, Entry>();
  private svg: SVGSVGElement | null = null;
  private container: HTMLElement | null = null;
  private frame = 0;
  private readonly v = new Vector3();
  private readonly labelRefs = new Map<string, (el: HTMLElement | null) => void>();
  /** Opacity of each story chapter layer (written by the scroll scrub / stepped fades). */
  readonly layerFade = new Float32Array(16).fill(1);

  setLayerFade(i: number, v: number): void {
    if (i >= 0 && i < this.layerFade.length) this.layerFade[i] = v;
  }

  anchor(id: string): LeaderAnchor {
    return this.entry(id).anchor;
  }

  /** Stable ref callback for a label element. */
  labelRef(id: string): (el: HTMLElement | null) => void {
    let fn = this.labelRefs.get(id);
    if (!fn) {
      fn = (el) => {
        const e = this.entry(id);
        e.label = el;
        e.rect.ok = false;
        const host = el?.closest?.('[data-chapter]') as HTMLElement | null | undefined;
        e.layer = host ? Number(host.dataset.chapter) : -1;
      };
      this.labelRefs.set(id, fn);
    }
    return fn;
  }

  setSvg = (el: SVGSVGElement | null): void => {
    this.svg = el;
    this.container = (el?.parentElement as HTMLElement | null) ?? null;
    for (const e of this.entries.values()) {
      e.line = null;
      e.dot = null;
    }
  };

  /** Mark label rects stale (resize, chapter change). */
  invalidate(): void {
    for (const e of this.entries.values()) e.rect.ok = false;
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) {
      e = {
        anchor: { id, world: new Vector3(), opacity: 0 },
        label: null,
        layer: -1,
        line: null,
        dot: null,
        rect: { x: 0, y: 0, w: 0, h: 0, ok: false },
        lx1: -1,
        ly1: -1,
        lx2: -1,
        ly2: -1,
        lo: -1,
      };
      this.entries.set(id, e);
    }
    return e;
  }

  private ensureEls(e: Entry): void {
    if (!this.svg || e.line) return;
    const line = document.createElementNS(SVG_NS, 'line');
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('r', '1.75');
    line.setAttribute('data-leader', e.anchor.id);
    this.svg.appendChild(line);
    this.svg.appendChild(dot);
    e.line = line;
    e.dot = dot;
  }

  /** Project all anchors and update lines. Call once per frame after anchors are written. */
  project(camera: Camera, width: number, height: number): void {
    if (!this.svg || !this.container) return;
    this.frame++;
    const refresh = this.frame % 6 === 0;
    let cRect: DOMRect | null = null;
    for (const e of this.entries.values()) {
      const a = e.anchor;
      const label = e.label;
      let o = a.opacity * (e.layer >= 0 ? this.layerFade[e.layer]! : 1);
      if (!label || o < 0.01) {
        if (e.lo !== 0 && e.line && e.dot) {
          e.line.style.opacity = '0';
          e.dot.style.opacity = '0';
          e.lo = 0;
        }
        continue;
      }
      this.ensureEls(e);
      if (!e.line || !e.dot) continue;
      if (!e.rect.ok || refresh) {
        if (!cRect) cRect = this.container.getBoundingClientRect();
        const r = label.getBoundingClientRect();
        e.rect.x = r.left - cRect.left;
        e.rect.y = r.top - cRect.top;
        e.rect.w = r.width;
        e.rect.h = r.height;
        e.rect.ok = r.width > 0;
      }
      this.v.copy(a.world).project(camera);
      if (this.v.z > 1 || this.v.z < -1) o = 0;
      const ax = (this.v.x * 0.5 + 0.5) * width;
      const ay = (-this.v.y * 0.5 + 0.5) * height;
      // never draw a leader from an anchor that is off screen
      if (ax < 2 || ax > width - 2 || ay < 2 || ay > height - 2) o = 0;
      const { x, y, w, h } = e.rect;
      let tx: number;
      let ty: number;
      if (ax < x) {
        tx = x - 6;
        ty = y + Math.min(h, 14) / 2;
      } else if (ax > x + w) {
        tx = x + w + 6;
        ty = y + Math.min(h, 14) / 2;
      } else {
        tx = ax;
        ty = ay < y ? y - 4 : y + h + 4;
      }
      // label opacity follows the chapter layer it sits in
      const qx = Math.round(ax * 2) / 2;
      const qy = Math.round(ay * 2) / 2;
      const qtx = Math.round(tx * 2) / 2;
      const qty = Math.round(ty * 2) / 2;
      const qo = Math.round(o * 50) / 50;
      if (qx !== e.lx1 || qy !== e.ly1 || qtx !== e.lx2 || qty !== e.ly2) {
        e.line.setAttribute('x1', String(qx));
        e.line.setAttribute('y1', String(qy));
        e.line.setAttribute('x2', String(qtx));
        e.line.setAttribute('y2', String(qty));
        e.dot.setAttribute('cx', String(qx));
        e.dot.setAttribute('cy', String(qy));
        e.lx1 = qx;
        e.ly1 = qy;
        e.lx2 = qtx;
        e.ly2 = qty;
      }
      if (qo !== e.lo) {
        e.line.style.opacity = String(qo);
        e.dot.style.opacity = String(qo);
        e.lo = qo;
      }
    }
  }
}
