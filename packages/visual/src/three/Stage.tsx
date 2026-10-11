'use client';
/**
 * The canvas every Carbon 3D view renders through: one WebGL renderer per
 * page (the story uses exactly one for all ten chapters), the merged post
 * pass, the frame driver (shared time, quality ladder sampling) and the HUD
 * leader projector.
 */
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { EffectComposer } from '@react-three/postprocessing';
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Color, HalfFloatType, LinearSRGBColorSpace, UnsignedByteType } from 'three';
import { PALETTE, hexToRgb01 } from '../tokens.js';
import type { LeaderRegistry } from '../hud/leaders.js';
import { settingsFor, useQualityLevel, type QualityStore } from '../quality/store.js';
import { createSharedUniforms, type SharedUniforms } from './materials.js';
import { CarbonPostEffect, createPostParams, type PostParams } from './post.js';

export interface Kit {
  shared: SharedUniforms;
  quality: QualityStore;
  post: PostParams;
  leaders: LeaderRegistry | null;
  reducedMotion: boolean;
}

const KitContext = createContext<Kit | null>(null);

export function useKit(): Kit {
  const k = useContext(KitContext);
  if (!k) throw new Error('Carbon 3D objects must render inside <Stage>');
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
}: StageProps) {
  const level = useQualityLevel(quality);
  const dpr = useDeviceDpr(Math.min(settingsFor(level).dpr, maxDpr ?? Infinity));
  const shared = useMemo(() => createSharedUniforms(), []);
  const postParams = useMemo(() => post ?? createPostParams(), [post]);
  const kit = useMemo<Kit>(
    () => ({ shared, quality, post: postParams, leaders, reducedMotion }),
    [shared, quality, postParams, leaders, reducedMotion],
  );
  postParams.still = reducedMotion;
  shared.uMotion.value = reducedMotion ? 0 : 1;

  return (
    <div className={className ?? 'carbon-canvas'} role="img" aria-label={ariaLabel}>
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
          {leaders ? <LeaderProjector leaders={leaders} /> : null}
        </KitContext.Provider>
      </Canvas>
    </div>
  );
}

function FrameDriver({ kit, onFirstFrame, onFrame }: { kit: Kit; onFirstFrame?: () => void; onFrame?: (dt: number) => void }) {
  const first = useRef(true);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    // clear to fog-light exactly (values passed through untouched: linear output, no tone mapping)
    const [r, g, b] = hexToRgb01(PALETTE.fogLight);
    scene.background = new Color().setRGB(r, g, b, LinearSRGBColorSpace);
  }, [scene]);
  useFrame((_, delta) => {
    const dtMs = delta * 1000;
    if (!kit.reducedMotion) kit.shared.uTime.value += Math.min(delta, 0.1);
    kit.shared.uPixelRatio.value = gl.getPixelRatio();
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
 * Memoised: EffectComposer rebuilds its EffectPass whenever its children change, so
 * this must never re-render with the parent (that would recompile the post shader
 * and leak passes on every chapter change).
 */
const Post = memo(function Post({ kit }: { kit: Kit }) {
  const effect = useMemo(() => new CarbonPostEffect(kit.post, () => kit.quality.settings), [kit.post, kit.quality]);
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
