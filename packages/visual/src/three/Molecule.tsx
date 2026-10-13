'use client';
/**
 * Molecules for the shape chapter / ShapePicker / launch views.
 *  - AgentAtoms: six instanced frosted spheres with engraved emblems.
 *  - BondInstances: many illustrative bonds in two draw calls (bridges +
 *    seams), no hashes (illustration never shows hashes).
 *  - Molecule: a shape's atoms + edges.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  CylinderGeometry,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Object3D,
  SphereGeometry,
  Vector3,
  type Mesh,
} from 'three';
import { AGENT_IDS, type AgentId, type ShapeId } from '@argon/core/contracts';
import type { LeaderAnchor } from '../hud/leaders.js';
import { moleculeLayout } from './layouts.js';
import { COLORS, createFrostMaterial, createSeamMaterial } from './materials.js';
import { useKit } from './Stage.js';
import { getEmblemAtlas } from './textures.js';
import { inspectHandlers } from './inspect.js';

export interface MutableNumber {
  value: number;
}

/** Six agent spheres. `positions` are read every frame (mutable). */
export function AgentAtoms({
  positions,
  radius = 0.26,
  visibility,
  dim,
  glow,
  highlight,
}: {
  positions: Record<AgentId, Vector3>;
  radius?: number;
  visibility?: MutableNumber;
  dim?: MutableNumber;
  /** Per-agent glow (0..1), mutable. */
  glow?: Record<AgentId, number>;
  /** Agent drawn larger (e.g. Ar-40 heavy agent). */
  highlight?: AgentId | null;
}) {
  const kit = useKit();
  const mesh = useRef<InstancedMesh>(null);
  const hovered = useRef<number | null>(null);
  const handlers = useMemo(
    () =>
      inspectHandlers(
        kit.inspect,
        (i) => ((visibility ? visibility.value : 1) > 0.3 && i !== undefined && i < 6 ? { kind: 'agent', agent: AGENT_IDS[i]! } : null),
        (i) => {
          hovered.current = i;
        },
      ),
    [kit.inspect, visibility],
  );
  const res = useMemo(() => {
    const geo = new SphereGeometry(radius, 32, 22);
    const emblem = new Float32Array(6);
    for (let i = 0; i < 6; i++) emblem[i] = i;
    const aGlow = new InstancedBufferAttribute(new Float32Array(6), 1);
    const aFade = new InstancedBufferAttribute(new Float32Array(6).fill(1), 1);
    geo.setAttribute('aEmblem', new InstancedBufferAttribute(emblem, 1));
    geo.setAttribute('aGlow', aGlow);
    geo.setAttribute('aFade', aFade);
    const mat = createFrostMaterial(kit.shared, { instancedAttrs: true, atlas: getEmblemAtlas(), emblemStrength: 0.7, rough: 0.6 });
    return { geo, mat, aGlow, aFade, o: new Object3D() };
  }, [kit.shared, radius]);
  useEffect(
    () => () => {
      res.geo.dispose();
      res.mat.dispose();
    },
    [res],
  );
  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    const vis = visibility ? visibility.value : 1;
    m.visible = vis > 0.005;
    if (!m.visible) return;
    const t = kit.shared.uTime.value;
    for (let i = 0; i < 6; i++) {
      const a = AGENT_IDS[i]!;
      res.o.position.copy(positions[a]);
      res.o.rotation.set(0, 0.5 * Math.sin(t * 0.3 + i), 0);
      res.o.scale.setScalar(vis * (highlight === a ? 1.35 : 1));
      res.o.updateMatrix();
      m.setMatrixAt(i, res.o.matrix);
      res.aGlow.setX(i, (glow ? glow[a] : 0) + (hovered.current === i ? 0.45 : 0));
      res.aFade.setX(i, vis);
    }
    m.instanceMatrix.needsUpdate = true;
    // instanced raycasts use a cached bounding sphere; keep it current so clicks land
    if (kit.inspect) m.computeBoundingSphere();
    res.aGlow.needsUpdate = true;
    res.aFade.needsUpdate = true;
    res.mat.uniforms.uDim.value = dim ? dim.value : 1;
  });
  return <instancedMesh ref={mesh} args={[res.geo, res.mat, 6]} frustumCulled={false} {...handlers} />;
}

/** Illustrative bonds, instanced. `edges` endpoints are read every frame. */
export function BondInstances({
  edges,
  visibility,
  grow,
  radius = 0.11,
}: {
  edges: { a: Vector3; b: Vector3; order: 1 | 2 | 3 }[];
  visibility?: MutableNumber;
  grow?: MutableNumber;
  radius?: number;
}) {
  const kit = useKit();
  const bridges = useRef<InstancedMesh>(null);
  const seams = useRef<InstancedMesh>(null);
  const maxSeams = edges.length * 3;
  const res = useMemo(() => {
    const bGeo = new CylinderGeometry(radius, radius, 1, 16, 1, true);
    bGeo.translate(0, 0.5, 0);
    const sGeo = new CylinderGeometry(0.016, 0.016, 1, 6, 1, true);
    sGeo.translate(0, 0.5, 0);
    const bMat = createFrostMaterial(kit.shared, { base: COLORS.frost, shade: COLORS.fogMid, fresnelAlpha: 0.75, opacity: 0.8, rough: 0.55, doubleSide: true });
    const sMat = createSeamMaterial(kit.shared);
    return { bGeo, sGeo, bMat, sMat, o: new Object3D(), dir: new Vector3(), up: new Vector3(0, 1, 0), off: new Vector3(), side: new Vector3() };
  }, [kit.shared, radius]);
  useEffect(
    () => () => {
      res.bGeo.dispose();
      res.sGeo.dispose();
      res.bMat.dispose();
      res.sMat.dispose();
    },
    [res],
  );
  useFrame(() => {
    const bm = bridges.current;
    const sm = seams.current;
    if (!bm || !sm) return;
    const vis = visibility ? visibility.value : 1;
    bm.visible = sm.visible = vis > 0.005;
    if (!bm.visible) return;
    const gr = grow ? grow.value : 1;
    let si = 0;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]!;
      res.dir.subVectors(e.b, e.a);
      const len = res.dir.length() * gr;
      res.dir.normalize();
      res.o.position.copy(e.a);
      res.o.quaternion.setFromUnitVectors(res.up, res.dir);
      res.o.scale.set(1, Math.max(0.0001, len), 1);
      res.o.updateMatrix();
      bm.setMatrixAt(i, res.o.matrix);
      // seams: offset perpendicular to the bond
      res.side.set(res.dir.y, -res.dir.x, 0);
      if (res.side.lengthSq() < 1e-4) res.side.set(1, 0, 0);
      res.side.normalize();
      for (let k = 0; k < e.order; k++) {
        const off = e.order === 1 ? 0 : (k - (e.order - 1) / 2) * 0.05;
        res.o.position.copy(e.a).addScaledVector(res.side, off);
        res.o.updateMatrix();
        sm.setMatrixAt(si++, res.o.matrix);
      }
    }
    sm.count = si;
    bm.count = edges.length;
    bm.instanceMatrix.needsUpdate = true;
    sm.instanceMatrix.needsUpdate = true;
    res.bMat.uniforms.uOpacity.value = 0.8 * vis;
    res.sMat.uniforms.uOpacity.value = vis;
  });
  return (
    <group>
      <instancedMesh ref={bridges} args={[res.bGeo, res.bMat, Math.max(1, edges.length)]} frustumCulled={false} />
      <instancedMesh ref={seams} args={[res.sGeo, res.sMat, Math.max(1, maxSeams)]} frustumCulled={false} />
    </group>
  );
}

export interface MoleculeHandle {
  group: Group | null;
}

/** A shape's molecule, illustrative. */
export function Molecule({
  shape,
  position,
  scale = 1,
  visibility,
  spin = 0.12,
  anchor,
  anchorFade,
  highlight,
}: {
  shape: ShapeId;
  position: Vector3;
  scale?: number;
  visibility?: MutableNumber;
  spin?: number;
  anchor?: LeaderAnchor;
  anchorFade?: MutableNumber;
  highlight?: AgentId | null;
}) {
  const kit = useKit();
  const group = useRef<Group>(null);
  const layout = useMemo(() => moleculeLayout(shape), [shape]);
  const positions = useMemo(
    () => Object.fromEntries(AGENT_IDS.map((a) => [a, new Vector3(...layout.atoms[a])])) as Record<AgentId, Vector3>,
    [layout],
  );
  const edges = useMemo(
    () =>
      layout.edges.map((k) => {
        const [a, b] = k.split('|') as [AgentId, AgentId];
        return { a: positions[a], b: positions[b], order: 1 as const };
      }),
    [layout, positions],
  );
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const vis = visibility ? visibility.value : 1;
    g.visible = vis > 0.005;
    g.position.copy(position);
    g.scale.setScalar(scale * (0.7 + 0.3 * vis));
    const t = kit.shared.uTime.value;
    g.rotation.set(shape === 'diamond' ? 0.5 : 0.15 * Math.sin(t * 0.2), t * spin, 0);
    if (anchor) {
      anchor.world.set(1.4, 1.2, 0).multiplyScalar(scale).add(position);
      anchor.opacity = vis * (anchorFade ? anchorFade.value : 1);
    }
  });
  return (
    <group ref={group}>
      <AgentAtoms positions={positions} visibility={visibility} highlight={highlight} />
      <BondInstances edges={edges} visibility={visibility} />
    </group>
  );
}

export type { Mesh };
