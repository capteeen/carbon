'use client';
/**
 * Live graphene crystals: every REAL launch is a crystal standing in a hex
 * cell of the frozen sheet. Crystal form = shape (chain prism / ring /
 * diamond octahedron); height = neutron count (isotope); unstable isotopes
 * shimmer; collapsed launches are dimmed. Clicking one calls onSelect.
 * With zero launches nothing is drawn here; the HUD shows the empty state.
 */
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  CylinderGeometry,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Object3D,
  OctahedronGeometry,
  TorusGeometry,
  Vector3,
  type BufferGeometry,
} from 'three';
import { ISOTOPES, SHAPE_IDS, type ShapeId } from '@carbon/core/contracts';
import type { LaunchSummary } from '../types.js';
import { hexCellWorld, hexSpiral } from './layouts.js';
import { COLORS, createFrostMaterial, type FrostMaterial } from './materials.js';
import type { MutableNumber } from './Molecule.js';
import { PLAIN_Y } from './Plain.js';
import { useKit } from './Stage.js';

export interface CrystalPlacement {
  launch: LaunchSummary;
  x: number;
  z: number;
  height: number;
}

/** Pure placement: oldest launch at the centre, spiralling outward. */
export function placeCrystals(launches: readonly LaunchSummary[]): CrystalPlacement[] {
  return launches.map((l, i) => {
    const [q, r] = hexSpiral(i);
    const [x, z] = hexCellWorld(q, r);
    return { launch: l, x, z, height: 0.35 + (ISOTOPES[l.isotope].neutrons - 5) * 0.12 };
  });
}

/** World centre of the placed crystals (for camera framing). */
export function crystalsCentre(p: readonly CrystalPlacement[], out: Vector3): Vector3 {
  if (p.length === 0) return out.set(0, PLAIN_Y, 0);
  let x = 0;
  let z = 0;
  for (const c of p) {
    x += c.x;
    z += c.z;
  }
  return out.set(x / p.length, PLAIN_Y, z / p.length);
}

function shapeGeometry(shape: ShapeId): BufferGeometry {
  switch (shape) {
    case 'chain': {
      const g = new CylinderGeometry(0.16, 0.2, 1, 6, 1);
      g.translate(0, 0.5, 0);
      return g;
    }
    case 'ring': {
      const g = new TorusGeometry(0.24, 0.07, 8, 6);
      g.translate(0, 0.32, 0);
      return g;
    }
    case 'diamond': {
      const g = new OctahedronGeometry(0.3, 0);
      g.scale(1, 1.5, 1);
      g.translate(0, 0.45, 0);
      return g;
    }
  }
}

export function GrapheneCrystals({
  launches,
  visibility,
  onSelect,
  hovered,
  onHover,
  y = PLAIN_Y,
}: {
  launches: readonly LaunchSummary[];
  visibility?: MutableNumber;
  onSelect?: (l: LaunchSummary, world: Vector3) => void;
  hovered?: string | null;
  onHover?: (l: LaunchSummary | null) => void;
  y?: number;
}) {
  const kit = useKit();
  const group = useRef<Group>(null);
  const placed = useMemo(() => placeCrystals(launches), [launches]);
  const byShape = useMemo(() => {
    const m = new Map<ShapeId, CrystalPlacement[]>();
    for (const s of SHAPE_IDS) m.set(s, []);
    for (const p of placed) m.get(p.launch.shape)!.push(p);
    return m;
  }, [placed]);

  return (
    <group ref={group} position={[0, y, 0]}>
      {SHAPE_IDS.map((s) => {
        const list = byShape.get(s)!;
        if (list.length === 0) return null;
        return <CrystalSet key={s} shape={s} items={list} visibility={visibility} onSelect={onSelect} hovered={hovered} onHover={onHover} shared={kit.shared} />;
      })}
    </group>
  );
}

function CrystalSet({
  shape,
  items,
  visibility,
  onSelect,
  hovered,
  onHover,
  shared,
}: {
  shape: ShapeId;
  items: CrystalPlacement[];
  visibility?: MutableNumber;
  onSelect?: (l: LaunchSummary, world: Vector3) => void;
  hovered?: string | null;
  onHover?: (l: LaunchSummary | null) => void;
  shared: ReturnType<typeof useKit>['shared'];
}) {
  const kit = useKit();
  const mesh = useRef<InstancedMesh>(null);
  const res = useMemo(() => {
    const geo = shapeGeometry(shape);
    const n = Math.max(1, items.length);
    const aGlow = new InstancedBufferAttribute(new Float32Array(n), 1);
    const aFade = new InstancedBufferAttribute(new Float32Array(n).fill(1), 1);
    const aEmblem = new InstancedBufferAttribute(new Float32Array(n).fill(-1), 1);
    geo.setAttribute('aGlow', aGlow);
    geo.setAttribute('aFade', aFade);
    geo.setAttribute('aEmblem', aEmblem);
    const mat: FrostMaterial = createFrostMaterial(shared, { instancedAttrs: true, base: COLORS.frost, shade: COLORS.slate, rough: 0.35 });
    return { geo, mat, aGlow, aFade, o: new Object3D(), w: new Vector3() };
  }, [shape, items.length, shared]);
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
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const unstable = !ISOTOPES[it.launch.isotope].stable;
      const grow = Math.min(1, vis * 1.3 - (i % 7) * 0.03);
      res.o.position.set(it.x, 0, it.z);
      res.o.rotation.set(0, t * 0.15 + i, 0);
      res.o.scale.set(1, Math.max(0.001, it.height * 2.2 * grow), 1);
      res.o.updateMatrix();
      m.setMatrixAt(i, res.o.matrix);
      const hov = hovered === it.launch.ca ? 0.6 : 0;
      res.aGlow.setX(i, hov + (unstable && !it.launch.collapsed ? 0.15 + 0.15 * Math.sin(t * 2.3 + i) : 0));
      res.aFade.setX(i, (it.launch.collapsed ? 0.35 : 1) * Math.max(0, grow));
    }
    m.count = items.length;
    m.instanceMatrix.needsUpdate = true;
    res.aGlow.needsUpdate = true;
    res.aFade.needsUpdate = true;
  });
  const pick = (e: ThreeEvent<MouseEvent | PointerEvent>) => {
    const id = e.instanceId;
    if (id === undefined) return null;
    return items[id] ?? null;
  };
  return (
    <instancedMesh
      ref={mesh}
      args={[res.geo, res.mat, Math.max(1, items.length)]}
      frustumCulled={false}
      onClick={(e) => {
        const it = pick(e);
        if (!it || !onSelect) return;
        e.stopPropagation();
        res.w.set(it.x, 0, it.z);
        mesh.current?.parent?.localToWorld(res.w);
        onSelect(it.launch, res.w.clone());
      }}
      onPointerOver={(e) => {
        const it = pick(e);
        if (it) onHover?.(it.launch);
      }}
      onPointerOut={() => onHover?.(null)}
    />
  );
}
