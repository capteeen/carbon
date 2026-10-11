'use client';
/**
 * ISOTOPE CHAMBER object: circular frosted pedestal with a glowing base ring;
 * the nucleus as a point cloud (6 proton clusters on a hexagon, 5-8 neutron
 * clusters inside). Switching isotope flows neutrons in/out through the
 * pedestal. Unstable isotopes shimmer. On C-13 the extra neutron hovers and
 * can be dragged onto a proton.
 */
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  Plane,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Points,
} from 'three';
import { AGENT_IDS, ISOTOPES, type AgentId, type IsotopeId } from '@carbon/core/contracts';
import type { LeaderAnchor } from '../hud/leaders.js';
import { COLORS, MAX_CLUSTERS, createClusterMaterial, createFrostMaterial } from './materials.js';
import type { MutableNumber } from './Molecule.js';
import { useKit } from './Stage.js';
import { inspectHandlers } from './inspect.js';

export const NUC_Y = 0.55;
const PROTON_R = 0.66;
/** Top face of the pedestal (chamber space). */
const PED_TOP = -0.5;
/** Pedestal top radius and base ring radius: a stand for the nucleus, not the subject. */
const PED_R = 1.15;
export const RING_R = PED_R + 0.19;
/**
 * The nucleus is drawn in its own frame, scaled so it is about as wide as the
 * pedestal top and resting just above it (it used to be a small speck on a
 * large pedestal on phones).
 */
export const NUC_SCALE = 1.6;
/** World (chamber-space) height of the nucleus centre: frame the camera on this. */
export const NUC_CENTER_Y = PED_TOP + (PROTON_R + 0.2) * NUC_SCALE + 0.12;
const NUC_LIFT = NUC_CENTER_Y - NUC_Y * NUC_SCALE;
/** Where neutrons flow to when they leave: inside the pedestal, below its top (nucleus space). */
const OUT_Y = (PED_TOP - 0.35 - NUC_LIFT) / NUC_SCALE;
const EXTRA = 12; // cluster index of the 7th neutron (C-13's extra / C-14's first extra)

const noRaycast = () => undefined;

function seeded(i: number): number {
  const x = Math.sin(i * 91.7 + 13.1) * 43758.5453;
  return x - Math.floor(x);
}

/** Pure: target centre, alpha and scale of each cluster for an isotope. Exported for tests. */
export function chamberTargets(isotope: IsotopeId, heavyAgent: AgentId | null): { center: [number, number, number]; alpha: number; scale: number }[] {
  const n = ISOTOPES[isotope].neutrons;
  const out: { center: [number, number, number]; alpha: number; scale: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    const heavy = heavyAgent === AGENT_IDS[i];
    out.push({ center: [Math.cos(a) * PROTON_R, NUC_Y, Math.sin(a) * PROTON_R], alpha: 1, scale: heavy ? 1.25 : 1 });
  }
  for (let k = 0; k < 8; k++) {
    const inside = k < n;
    let c: [number, number, number];
    if (k < 6) {
      const a = (k * Math.PI) / 3;
      c = [Math.cos(a) * 0.3, NUC_Y + (k % 2 ? 0.14 : -0.14), Math.sin(a) * 0.3];
    } else if (k === 6 && isotope === 'C-13') {
      if (heavyAgent) {
        const i = AGENT_IDS.indexOf(heavyAgent);
        const a = Math.PI / 6 + (i * Math.PI) / 3;
        c = [Math.cos(a) * (PROTON_R + 0.34), NUC_Y + 0.08, Math.sin(a) * (PROTON_R + 0.34)];
      } else c = [0, NUC_Y + 0.8, 0.25];
    } else {
      c = [0, NUC_Y + (k === 6 ? 0.36 : -0.36), 0];
    }
    if (!inside) c = [c[0] * 0.5, OUT_Y, c[2] * 0.5];
    out.push({ center: c, alpha: inside ? 1 : 0, scale: 1 });
  }
  return out;
}

export function ChamberObject({
  isotope,
  heavyAgent,
  visibility,
  onHeavyDrop,
  anchors,
  anchorFade,
  pointsPerCluster = 240,
}: {
  isotope: IsotopeId;
  heavyAgent: AgentId | null;
  visibility?: MutableNumber;
  /** When set (C-13), the extra neutron is draggable onto a proton. */
  onHeavyDrop?: (agent: AgentId) => void;
  anchors?: Partial<Record<AgentId | 'pedestal' | 'extra', LeaderAnchor>>;
  anchorFade?: MutableNumber;
  pointsPerCluster?: number;
}) {
  const kit = useKit();
  const group = useRef<Group>(null);
  const nucleus = useRef<Group>(null);
  const points = useRef<Points>(null);
  const handle = useRef<Mesh>(null);
  const protonHits = useRef<(Mesh | null)[]>([]);

  const res = useMemo(() => {
    const clusters = 14;
    const per = pointsPerCluster;
    const total = clusters * per;
    const pos = new Float32Array(total * 3);
    const off = new Float32Array(total * 3);
    const cl = new Float32Array(total);
    const seed = new Float32Array(total);
    for (let c = 0; c < clusters; c++) {
      for (let j = 0; j < per; j++) {
        const i = c * per + j;
        const u = seeded(i * 3 + 1) * 2 - 1;
        const th = seeded(i * 3 + 2) * Math.PI * 2;
        const r = 0.2 * Math.cbrt(seeded(i * 3 + 3));
        const s = Math.sqrt(1 - u * u);
        off[i * 3] = Math.cos(th) * s * r;
        off[i * 3 + 1] = u * r;
        off[i * 3 + 2] = Math.sin(th) * s * r;
        cl[i] = c;
        seed[i] = seeded(i + 7777);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('aOffset', new BufferAttribute(off, 3));
    geo.setAttribute('aCluster', new BufferAttribute(cl, 1));
    geo.setAttribute('aSeed', new BufferAttribute(seed, 1));
    const mat = createClusterMaterial(kit.shared, 14);
    // protons frost, neutrons slate: the two read apart, and both against the fog
    for (let i = 0; i < MAX_CLUSTERS; i++) mat.uniforms.uTone.value[i] = i < 6 ? 0 : 1;
    const pedestalGeo = new CylinderGeometry(PED_R, PED_R + 0.15, 0.5, 72, 1);
    const pedestalMat = createFrostMaterial(kit.shared, { base: COLORS.fogMid, shade: COLORS.slate, rough: 0.85 });
    const ringGeo = new TorusGeometry(RING_R, 0.022, 10, 144);
    ringGeo.rotateX(Math.PI / 2);
    const ringMat = createFrostMaterial(kit.shared, { base: COLORS.frost, rough: 0.3 });
    const haloGeo = new TorusGeometry(RING_R, 0.12, 10, 144);
    haloGeo.rotateX(Math.PI / 2);
    const haloMat = createFrostMaterial(kit.shared, { base: COLORS.frost, fresnelAlpha: 1, opacity: 0.5 });
    // touch-sized grab target around the extra neutron (nucleus space)
    const handleGeo = new SphereGeometry(0.38, 12, 8);
    const hitGeo = new SphereGeometry(0.3, 10, 6);
    const handleMat = createFrostMaterial(kit.shared, { opacity: 0, transparent: true });
    const targets = chamberTargets('C-12', null).map((t) => ({ ...t, center: new Vector3(...t.center) }));
    return { geo, mat, pedestalGeo, pedestalMat, ringGeo, ringMat, haloGeo, haloMat, handleGeo, handleMat, hitGeo, targets };
  }, [kit.shared, pointsPerCluster]);

  useEffect(
    () => () => {
      res.geo.dispose();
      res.mat.dispose();
      res.pedestalGeo.dispose();
      res.pedestalMat.dispose();
      res.ringGeo.dispose();
      res.ringMat.dispose();
      res.haloGeo.dispose();
      res.haloMat.dispose();
      res.handleGeo.dispose();
      res.handleMat.dispose();
      res.hitGeo.dispose();
    },
    [res],
  );

  // initial centres: everything starts below the pedestal and flows up
  useEffect(() => {
    const u = res.mat.uniforms;
    for (let i = 0; i < MAX_CLUSTERS; i++) u.uCenters.value[i]!.set(0, OUT_Y, 0);
  }, [res]);

  // targets follow props
  useEffect(() => {
    const t = chamberTargets(isotope, heavyAgent);
    t.forEach((x, i) => {
      const r = res.targets[i];
      if (!r) return;
      r.center.set(...x.center);
      r.alpha = x.alpha;
      r.scale = x.scale;
    });
  }, [isotope, heavyAgent, res]);

  const drag = useRef({ active: false, moved: 0, pos: new Vector3(), plane: new Plane(new Vector3(0, 0, 1), 0), hit: new Vector3() });
  const canDrag = isotope === 'C-13' && !!onHeavyDrop;

  // Touch: while the neutron is held, the finger drags it instead of scrolling the page.
  useEffect(() => {
    if (!canDrag || typeof document === 'undefined') return;
    const block = (e: TouchEvent) => {
      if (drag.current.active && e.cancelable) e.preventDefault();
    };
    document.addEventListener('touchmove', block, { passive: false });
    return () => document.removeEventListener('touchmove', block);
  }, [canDrag]);

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    if (!canDrag) return;
    e.stopPropagation();
    (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
    drag.current.active = true;
    drag.current.moved = 0;
    drag.current.pos.copy(res.mat.uniforms.uCenters.value[EXTRA]!);
  };
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    if (!drag.current.active) return;
    e.stopPropagation();
    const n = nucleus.current;
    if (!n) return;
    if (e.ray.intersectPlane(drag.current.plane, drag.current.hit)) {
      n.worldToLocal(drag.current.hit);
      drag.current.moved += drag.current.hit.distanceTo(drag.current.pos);
      drag.current.pos.copy(drag.current.hit);
    }
  };
  const onUp = (e: ThreeEvent<PointerEvent>) => {
    if (!drag.current.active) return;
    e.stopPropagation();
    drag.current.active = false;
    // drop on the nearest proton (in screen-ish space: ignore depth)
    let best: AgentId | null = null;
    let bestD = 0.6;
    const p = drag.current.pos;
    const u = res.mat.uniforms.uCenters.value;
    for (let i = 0; i < 6; i++) {
      const c = u[i]!;
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = AGENT_IDS[i]!;
      }
    }
    if (best && onHeavyDrop) onHeavyDrop(best);
  };
  // Tap a proton (touch or mouse) to give it the extra neutron: same choice as dragging.
  // Otherwise a tap opens that agent's detail panel (cursor shows it is clickable).
  const protonHandlers = useMemo(
    () => AGENT_IDS.map((a) => inspectHandlers(kit.inspect, () => ({ kind: 'agent', agent: a }))),
    [kit.inspect],
  );
  const onProtonTap = (agent: AgentId, i: number) => (e: ThreeEvent<MouseEvent>) => {
    if (drag.current.active) return;
    if (!canDrag) return protonHandlers[i]!.onClick(e);
    e.stopPropagation();
    onHeavyDrop?.(agent);
  };

  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;
    const vis = visibility ? visibility.value : 1;
    g.visible = vis > 0.005;
    if (!g.visible) {
      if (anchors) for (const k in anchors) anchors[k as AgentId]!.opacity = 0;
      return;
    }
    const k = kit.reducedMotion ? 1 : 1 - Math.exp(-Math.min(delta, 0.1) * 3.2);
    const u = res.mat.uniforms;
    const unstable = !ISOTOPES[isotope].stable;
    const t = kit.shared.uTime.value;
    for (let i = 0; i < 14; i++) {
      const tg = res.targets[i]!;
      const c = u.uCenters.value[i]!;
      if (i === EXTRA && drag.current.active) c.lerp(drag.current.pos, 0.5);
      else c.lerp(tg.center, k);
      if (i === EXTRA && isotope === 'C-13' && !heavyAgent && !drag.current.active) c.y = tg.center.y + 0.06 * Math.sin(t * 1.4);
      u.uAlphas.value[i] = u.uAlphas.value[i]! + (tg.alpha * vis - u.uAlphas.value[i]!) * k;
      u.uScales.value[i] = u.uScales.value[i]! + (tg.scale - u.uScales.value[i]!) * k;
      u.uShimmer.value[i] = unstable ? 0.7 : i === EXTRA && isotope === 'C-13' ? 0.25 : 0;
    }
    res.pedestalMat.uniforms.uOpacity.value = 1;
    res.ringMat.uniforms.uGlow.value = 0.9 + 0.1 * Math.sin(t * 1.3);
    res.haloMat.uniforms.uOpacity.value = 0.45 * vis;
    g.scale.setScalar(0.85 + 0.15 * vis);
    const h = handle.current;
    if (h) {
      h.position.copy(u.uCenters.value[EXTRA]!);
      h.visible = canDrag;
      h.raycast = canDrag ? Mesh.prototype.raycast : noRaycast;
    }
    for (let i = 0; i < 6; i++) {
      const m = protonHits.current[i];
      if (!m) continue;
      m.position.copy(u.uCenters.value[i]!);
      m.visible = vis > 0.3;
      m.raycast = m.visible ? Mesh.prototype.raycast : noRaycast;
    }
    if (anchors) {
      const f = vis * (anchorFade ? anchorFade.value : 1);
      g.updateMatrixWorld();
      const nm = nucleus.current ? nucleus.current.matrixWorld : g.matrixWorld;
      for (let i = 0; i < 6; i++) {
        const a = anchors[AGENT_IDS[i]!];
        if (!a) continue;
        a.world.copy(u.uCenters.value[i]!).applyMatrix4(nm);
        a.opacity = f;
      }
      if (anchors.pedestal) {
        anchors.pedestal.world.set(PED_R + 0.1, -0.6, 0).applyMatrix4(g.matrixWorld);
        anchors.pedestal.opacity = f;
      }
      if (anchors.extra) {
        anchors.extra.world.copy(u.uCenters.value[EXTRA]!).applyMatrix4(nm);
        anchors.extra.opacity = isotope === 'C-13' ? f : 0;
      }
    }
  });

  return (
    <group ref={group}>
      <mesh geometry={res.pedestalGeo} material={res.pedestalMat} position={[0, -0.75, 0]} />
      <mesh geometry={res.ringGeo} material={res.ringMat} position={[0, -1.0, 0]} />
      <mesh geometry={res.haloGeo} material={res.haloMat} position={[0, -1.0, 0]} />
      <group ref={nucleus} position={[0, NUC_LIFT, 0]} scale={NUC_SCALE}>
        <points ref={points} geometry={res.geo} material={res.mat} frustumCulled={false} />
        {AGENT_IDS.map((a, i) => (
          <mesh
            key={a}
            ref={(m) => {
              protonHits.current[i] = m;
            }}
            geometry={res.hitGeo}
            material={res.handleMat}
            onClick={onProtonTap(a, i)}
            onPointerOver={protonHandlers[i]!.onPointerOver}
            onPointerOut={protonHandlers[i]!.onPointerOut}
          />
        ))}
        <mesh
          ref={handle}
          geometry={res.handleGeo}
          material={res.handleMat}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      </group>
    </group>
  );
}
