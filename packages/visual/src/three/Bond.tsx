'use client';
/**
 * BOND: a frosted bridge between two points with 1, 2 or 3 inner seams by
 * order. Seams glow frost-white; on each REAL hand-off (`flashKey` changes to
 * a new event id) they flicker iridescent. The hand-off hash (first 8 chars,
 * mono) rides the seam. `broken` draws the Sentinel block seam (red, gapped).
 *
 * Honesty: the hash text is only drawn when `hash` is a real event id; there
 * is no fallback text. Flashes only fire when `flashKey` is a real event id
 * not seen before by this bond.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { CylinderGeometry, Group, Mesh, PlaneGeometry, Quaternion, Vector3 } from 'three';
import { isEventId, shortHash } from '../hud/format.js';
import { COLORS, createFrostMaterial, createLabelMaterial, createSeamMaterial } from './materials.js';
import { useKit } from './Stage.js';
import { textTexture } from './textures.js';

export interface BondProps {
  from: Vector3;
  to: Vector3;
  order: 1 | 2 | 3;
  /** Real event id shown on the seam (first 8 chars). */
  hash?: string | null;
  /** Real event id of the latest hand-off; a new value triggers one flash. */
  flashKey?: string | null;
  /** Event ts (ms) of `flashKey`; an id present at mount flashes only if it is fresh (≤ 3 s old). */
  flashAt?: number | null;
  /** Mutable visibility 0..1 read every frame (lets timelines drive it without renders). */
  visibility?: { value: number };
  /** 0..1 bridge growth from `from` toward `to` (formation). */
  grow?: { value: number };
  broken?: boolean;
  radius?: number;
  /** Fire on each new real flash (sound). */
  onFlash?: (hash: string) => void;
}

const SEAM_OFFSETS: Record<1 | 2 | 3, [number, number][]> = {
  1: [[0, 0]],
  2: [[-0.055, 0], [0.055, 0]],
  3: [[-0.065, -0.035], [0.065, -0.035], [0, 0.065]],
};

export function Bond({ from, to, order, hash, flashKey, flashAt, visibility, grow, broken = false, radius = 0.15, onFlash }: BondProps) {
  const kit = useKit();
  const camera = useThree((s) => s.camera);
  const root = useRef<Group>(null);
  const bridge = useRef<Mesh>(null);
  const label = useRef<Mesh>(null);
  const seams = useRef<(Mesh | null)[]>([]);

  const res = useMemo(() => {
    const bridgeGeo = new CylinderGeometry(radius, radius, 1, 20, 1, true);
    bridgeGeo.translate(0, 0.5, 0);
    const seamGeo = new CylinderGeometry(0.02, 0.02, 1, 6, 1, true);
    seamGeo.translate(0, 0.5, 0);
    const bridgeMat = createFrostMaterial(kit.shared, { base: COLORS.frost, shade: COLORS.fogMid, fresnelAlpha: 0.75, opacity: 0.8, rough: 0.55, doubleSide: true });
    const seamMat = createSeamMaterial(kit.shared);
    const labelGeo = new PlaneGeometry(1, 1);
    const labelMat = createLabelMaterial(COLORS.ink);
    return { bridgeGeo, seamGeo, bridgeMat, seamMat, labelGeo, labelMat };
  }, [kit.shared, radius]);

  useEffect(
    () => () => {
      res.bridgeGeo.dispose();
      res.seamGeo.dispose();
      res.bridgeMat.dispose();
      res.seamMat.dispose();
      res.labelGeo.dispose();
      res.labelMat.dispose();
    },
    [res],
  );

  // hash text texture: only for real ids
  const text = useMemo(() => (isEventId(hash) ? textTexture(shortHash(hash)) : null), [hash]);
  useEffect(() => {
    res.labelMat.uniforms.uMap.value = text?.tex ?? null;
  }, [text, res]);

  // flashes: one per new real event id
  const flash = useRef({ seen: null as string | null, start: -1, mountedAt: 0 });
  useEffect(() => {
    flash.current.mountedAt = Date.now();
  }, []);
  useEffect(() => {
    if (!isEventId(flashKey)) return;
    const f = flash.current;
    if (flashKey === f.seen) return;
    const first = f.seen === null;
    f.seen = flashKey;
    // an id already present at mount is history unless it just happened
    if (first && !(typeof flashAt === 'number' && flashAt >= (f.mountedAt || Date.now()) - 3000)) return;
    f.start = kit.shared.uTime.value;
    onFlash?.(flashKey);
  }, [flashKey, flashAt, kit.shared, onFlash]);

  const s = useMemo(() => ({ dir: new Vector3(), up: new Vector3(0, 1, 0), q: new Quaternion(), mid: new Vector3() }), []);

  useFrame(() => {
    const r = root.current;
    if (!r) return;
    const vis = visibility ? visibility.value : 1;
    r.visible = vis > 0.005;
    if (!r.visible) return;
    const gr = grow ? grow.value : 1;
    s.dir.subVectors(to, from);
    const len = s.dir.length();
    s.dir.normalize();
    s.q.setFromUnitVectors(s.up, s.dir);
    r.position.copy(from);
    r.quaternion.copy(s.q);
    const L = Math.max(0.0001, len * gr);
    bridge.current!.scale.set(1, L, 1);
    res.bridgeMat.uniforms.uOpacity.value = 0.8 * vis;
    const offs = SEAM_OFFSETS[order];
    for (let i = 0; i < 3; i++) {
      const m = seams.current[i];
      if (!m) continue;
      const o = offs[i];
      m.visible = !!o;
      if (!o) continue;
      m.position.set(o[0], 0, o[1]);
      m.scale.set(1, L, 1);
    }
    const t = kit.shared.uTime.value;
    const f = flash.current;
    const age = f.start < 0 ? 99 : t - f.start;
    const fl = age < 1.6 ? Math.exp(-age * 2.2) : 0;
    res.seamMat.uniforms.uFlash.value = kit.reducedMotion ? Math.min(fl, 0.5) : fl;
    res.seamMat.uniforms.uOpacity.value = vis;
    res.seamMat.uniforms.uBroken.value = broken ? 1 : 0;
    res.bridgeMat.uniforms.uIrid.value = fl * 0.8;

    // hash rides the seam (slowly travelling along it), billboarded, in world space
    const lm = label.current;
    if (lm) {
      lm.visible = !!text && gr > 0.95;
      if (lm.visible && text) {
        r.updateMatrixWorld();
        const ride = kit.reducedMotion ? 0.5 : 0.2 + 0.6 * (0.5 + 0.5 * Math.sin(t * 0.35 + len));
        s.mid.copy(from).lerp(to, ride);
        lm.parent!.worldToLocal(s.mid);
        lm.position.copy(s.mid);
        lm.position.x += radius + 0.05;
        lm.quaternion.copy(r.quaternion).invert().multiply(camera.quaternion);
        const h = 0.24;
        lm.scale.set(h * text.aspect, h, 1);
        res.labelMat.uniforms.uOpacity.value = vis * (0.75 + 0.25 * fl);
      }
    }
  });

  return (
    <group ref={root}>
      <mesh ref={bridge} geometry={res.bridgeGeo} material={res.bridgeMat} frustumCulled={false} />
      {[0, 1, 2].map((i) => (
        <mesh
          key={i}
          ref={(m) => {
            seams.current[i] = m;
          }}
          geometry={res.seamGeo}
          material={res.seamMat}
          frustumCulled={false}
        />
      ))}
      <mesh ref={label} geometry={res.labelGeo} material={res.labelMat} renderOrder={10} frustumCulled={false} />
    </group>
  );
}
