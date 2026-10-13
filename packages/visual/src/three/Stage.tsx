'use client';
/**
 * The canvas every Argon 3D view renders through: one WebGL renderer per
 * page (the story uses exactly one for all ten chapters), the merged post
 * pass, the frame driver (shared time, quality ladder sampling) and the HUD
 * leader projector.
 */
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { EffectComposer } from '@react-three/postprocessing';
import { Component, createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { Color, HalfFloatType, LinearSRGBColorSpace, UnsignedByteType, type Camera, type Object3D, type Scene, type WebGLRenderer } from 'three';
import { PALETTE, hexToRgb01 } from '../tokens.js';
import type { LeaderRegistry } from '../hud/leaders.js';
import { settingsFor, useQualityLevel, type QualityStore } from '../quality/store.js';
import { createSharedUniforms, type SharedUniforms } from './materials.js';
import { ArgonPostEffect, createPostParams, type PostParams } from './post.js';
import type { InspectApi } from './inspect.js';

export interface Kit {
  shared: SharedUniforms;
  quality: QualityStore;
  post: PostParams;
  leaders: LeaderRegistry | null;
  reducedMotion: boolean;
  /** Click-an-agent detail panel; null where the page has none. */
  inspect: InspectApi | null;
}

const KitContext = createContext<Kit | null>(null);

export function useKit(): Kit {
  const k = useContext(KitContext);
  if (!k) throw new Error('Argon 3D objects must render inside <Stage>');
  return k;
}

export interface StageProps {
  children: ReactNode;
  quality: QualityStore;
  leaders?: LeaderRegistry | null;
  reducedMotion?: boolean;
  post?: PostParams;
  /** Element that receives pointer events (so the HUD overlay does not block them). */
  eventSource?: HTMLElement | null;
  camera?: { position: [number, number, number]; fov?: number };
  onFirstFrame?: () => void;
  className?: string;
  /** Exposed for perf tooling: called with every frame's delta (ms). */
  onFrame?: (dtMs: number) => void;
  ariaLabel?: string;
  /** Hard cap on device pixel ratio (the quality ladder may lower it further). */
  maxDpr?: number;
  inspect?: InspectApi | null;
}

/**
 * null until probed on the client (SSR and the first client render draw no canvas),
 * then whether a WebGL context can be created at all.
 */
function useWebGL(): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let gl: boolean;
    try {
      const c = document.createElement('canvas');
      gl = typeof c.getContext === 'function' && !!(c.getContext('webgl2') ?? c.getContext('webgl'));
    } catch {
      gl = false;
    }
    setOk(gl);
  }, []);
  return ok;
}

/**
 * No-WebGL path: the HUD (which carries every real value) stays; the 3D layer
 * is replaced by a plain fog panel with one honest line.
 */
function NoWebGL({ className, ariaLabel }: { className?: string; ariaLabel?: string }) {
  return (
    <div className={`${className ?? 'argon-canvas'} argon-canvas--nogl`} role="img" aria-label={ariaLabel} data-testid="no-webgl">
      <span className="argon-hud__meta argon-nogl__note">{'// 3D view unavailable on this device. Readouts are unaffected.'}</span>
    </div>
  );
}

class CanvasBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    // WebGL context creation can still fail after the probe (GPU blocklist, lost context).
    if (typeof console !== 'undefined') console.warn('[argon/visual] 3D disabled:', error instanceof Error ? error.message : error);
  }
  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function useDeviceDpr(cap: number): number {
  const [dpr, setDpr] = useState(1);
  useEffect(() => {
    setDpr(Math.max(0.2, Math.min(window.devicePixelRatio || 1, cap)));
  }, [cap]);
  return dpr;
}

export function Stage({
  children,
  quality,
  leaders = null,
  reducedMotion = false,
  post,
  eventSource,
  camera,
  onFirstFrame,
  className,
  onFrame,
  ariaLabel,
  maxDpr,
  inspect = null,
}: StageProps) {
  const level = useQualityLevel(quality);
  const dpr = useDeviceDpr(Math.min(settingsFor(level).dpr, maxDpr ?? Infinity));
  const shared = useMemo(() => createSharedUniforms(), []);
  const postParams = useMemo(() => post ?? createPostParams(), [post]);
  const kit = useMemo<Kit>(
    () => ({ shared, quality, post: postParams, leaders, reducedMotion, inspect }),
    [shared, quality, postParams, leaders, reducedMotion, inspect],
  );
  postParams.still = reducedMotion;
  shared.uMotion.value = reducedMotion ? 0 : 1;

  const webgl = useWebGL();
  if (webgl === null) return <div className={className ?? 'argon-canvas'} role="img" aria-label={ariaLabel} />;
  if (!webgl) return <NoWebGL className={className} ariaLabel={ariaLabel} />;

  return (
    <CanvasBoundary fallback={<NoWebGL className={className} ariaLabel={ariaLabel} />}>
    <div className={className ?? 'argon-canvas'} role="img" aria-label={ariaLabel}>
      <Canvas
        dpr={dpr}
        linear
        flat
        gl={{ antialias: false, alpha: false, stencil: false, depth: true, powerPreference: 'high-performance' }}
        camera={{ fov: camera?.fov ?? 38, near: 0.1, far: 60, position: camera?.position ?? [0, 0.45, 6.4] }}
        eventSource={eventSource ?? undefined}
        eventPrefix={eventSource ? 'client' : undefined}
        style={{ position: 'absolute', inset: 0 }}
      >
        <KitContext.Provider value={kit}>
          <FrameDriver kit={kit} onFirstFrame={onFirstFrame} onFrame={onFrame} />
          {children}
          <Post kit={kit} />
          <Precompiler />
          {leaders ? <LeaderProjector leaders={leaders} /> : null}
        </KitContext.Provider>
      </Canvas>
    </div>
    </CanvasBoundary>
  );
}

/**
 * Shader precompile: after the first frame, during idle time, compile every
 * material in the scene, including the ones of chapters not yet visible
 * (three's compile() only walks visible objects, so hidden ones are shown for
 * the duration of the synchronous call and restored before the next frame).
 * Avoids first-visit hitches when a later chapter's materials first draw.
 */
function precompile(gl: WebGLRenderer, scene: Scene, camera: Camera): void {
  const hidden: Object3D[] = [];
  scene.traverse((o) => {
    if (!o.visible) {
      hidden.push(o);
      o.visible = true;
    }
  });
  try {
    const anyGl = gl as WebGLRenderer & { compileAsync?: (s: Object3D, c: Camera) => Promise<unknown> };
    if (typeof anyGl.compileAsync === 'function') void anyGl.compileAsync(scene, camera).catch(() => undefined);
    else gl.compile(scene, camera);
  } finally {
    for (const o of hidden) o.visible = false;
  }
}

function Precompiler() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const done = useRef(false);
  useFrame(() => {
    if (done.current) return;
    done.current = true;
    const run = () => precompile(gl, scene, camera);
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 1500 });
    else setTimeout(run, 300);
  }, 20);
  return null;
}

/**
 * Real cursor / touch position over the canvas (window listeners, so HUD
 * overlays never block it). A mouse counts while it is over the canvas; a
 * touch while the finger is down.
 */
function usePointerTarget(canvas: HTMLCanvasElement) {
  const p = useRef({ x: 9, y: 9, active: false, moved: 0 });
  useEffect(() => {
    const t = p.current;
    const at = (e: { clientX: number; clientY: number }) => {
      const r = canvas.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const x = ((e.clientX - r.left) / r.width) * 2 - 1;
      const y = -((e.clientY - r.top) / r.height) * 2 + 1;
      const inside = x >= -1 && x <= 1 && y >= -1 && y <= 1;
      if (inside) {
        t.x = x;
        t.y = y;
        t.moved = performance.now();
      }
      return inside;
    };
    // mouse and pen: active while over the canvas
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') t.active = at(e);
    };
    const out = (e: PointerEvent) => {
      if (!e.relatedTarget) t.active = false;
    };
    // touch: touch events keep firing while the page scrolls (pointer events cancel)
    const touch = (e: TouchEvent) => {
      const f = e.touches[0];
      t.active = f ? at(f) : false;
    };
    const opts = { passive: true } as const;
    window.addEventListener('pointermove', move, opts);
    window.addEventListener('pointerdown', move, opts);
    document.addEventListener('pointerout', out, opts);
    window.addEventListener('touchstart', touch, opts);
    window.addEventListener('touchmove', touch, opts);
    window.addEventListener('touchend', touch, opts);
    window.addEventListener('touchcancel', touch, opts);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', move);
      document.removeEventListener('pointerout', out);
      window.removeEventListener('touchstart', touch);
      window.removeEventListener('touchmove', touch);
      window.removeEventListener('touchend', touch);
      window.removeEventListener('touchcancel', touch);
    };
  }, [canvas]);
  return p;
}

function FrameDriver({ kit, onFirstFrame, onFrame }: { kit: Kit; onFirstFrame?: () => void; onFrame?: (dt: number) => void }) {
  const first = useRef(true);
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  const scene = useThree((s) => s.scene);
  const target = usePointerTarget(gl.domElement);
  useEffect(() => {
    // clear to fog-light exactly (values passed through untouched: linear output, no tone mapping)
    const [r, g, b] = hexToRgb01(PALETTE.fogLight);
    scene.background = new Color().setRGB(r, g, b, LinearSRGBColorSpace);
  }, [scene]);
  useFrame((_, delta) => {
    const dtMs = delta * 1000;
    if (!kit.reducedMotion) kit.shared.uTime.value += Math.min(delta, 0.1);
    kit.shared.uPixelRatio.value = gl.getPixelRatio();
    kit.shared.uAspect.value = size.width / Math.max(1, size.height);
    easePointer(kit, target.current, Math.min(delta, 0.1));
    if (first.current) {
      first.current = false;
      onFirstFrame?.();
    } else {
      kit.quality.sample(dtMs);
    }
    kit.shared.uPoints.value = kit.quality.settings.points;
    onFrame?.(dtMs);
  }, -10);
  return null;
}

/**
 * Eases the shared pointer toward the real one, so particles push away from the
 * cursor and settle back when it stops or leaves (no motion without input).
 */
function easePointer(kit: Kit, t: { x: number; y: number; active: boolean; moved: number }, dt: number): void {
  const s = kit.shared;
  const p = s.uPointer.value;
  const v = s.uPointerVel.value;
  if (kit.reducedMotion) {
    s.uPointerForce.value = 0;
    v.set(0, 0);
    return;
  }
  if (dt <= 0) return;
  if (s.uPointerForce.value < 0.001 && t.active) p.set(t.x, t.y);
  const k = 1 - Math.exp(-dt * 14);
  const nx = p.x + (t.x - p.x) * k;
  const ny = p.y + (t.y - p.y) * k;
  // velocity in NDC-height units/s, eased; idle pointers stop dragging the cloud
  const aspect = s.uAspect.value;
  const idle = performance.now() - t.moved > 120;
  const vx = idle ? 0 : ((nx - p.x) * aspect) / dt;
  const vy = idle ? 0 : (ny - p.y) / dt;
  const kv = 1 - Math.exp(-dt * 8);
  v.set(v.x + (vx - v.x) * kv, v.y + (vy - v.y) * kv);
  const len = v.length();
  if (len > 3) v.multiplyScalar(3 / len);
  p.set(nx, ny);
  const goal = t.active ? 1 : 0;
  const kf = 1 - Math.exp(-dt * (goal > s.uPointerForce.value ? 6 : 2.2));
  s.uPointerForce.value += (goal - s.uPointerForce.value) * kf;
}

/**
 * Memoised: EffectComposer rebuilds its EffectPass whenever its children change, so
 * this must never re-render with the parent (that would recompile the post shader
 * and leak passes on every chapter change).
 */
const Post = memo(function Post({ kit }: { kit: Kit }) {
  const effect = useMemo(() => new ArgonPostEffect(kit.post, () => kit.quality.settings), [kit.post, kit.quality]);
  useEffect(() => () => effect.dispose(), [effect]);
  // Half-float buffers band less in the fog gradients; fall back to bytes where unsupported.
  const gl = useThree((s) => s.gl);
  const type = gl.capabilities.isWebGL2 ? HalfFloatType : UnsignedByteType;
  return (
    <EffectComposer multisampling={0} depthBuffer frameBufferType={type} enableNormalPass={false}>
      <primitive object={effect} />
    </EffectComposer>
  );
});

function LeaderProjector({ leaders }: { leaders: LeaderRegistry }) {
  useFrame((state) => {
    leaders.project(state.camera, state.size.width, state.size.height);
  }, 5);
  return null;
}
