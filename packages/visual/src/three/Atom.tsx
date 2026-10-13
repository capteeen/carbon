'use client';
/**
 * ATOM: a model of the agents' core, not argon's real 40-nucleon nucleus: 12 instanced frosted nucleons (6 protons engraved with agent emblems,
 * 6 plain neutrons) inside two translucent electron shells (inner 2, outer 4
 * electrons), an electron point cloud the cursor and touch disturb, and the 4 bond
 * arms the outer electrons become. Driven entirely by a mutable `drive`
 * object read in useFrame; nothing here keeps its own clock except idle spin.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Euler,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Object3D,
  Points,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Mesh,
} from 'three';
import type { LeaderAnchor } from '../hud/leaders.js';
import { COLORS, createCloudMaterial, createFrostMaterial } from './materials.js';
import { useKit } from './Stage.js';
import { getEmblemAtlas } from './textures.js';
import { inspectHandlers } from './inspect.js';
import { AGENT_IDS } from '@argon/core/contracts';

export interface AtomDrive {
  atom: number;
  explode: number;
  isolate: number;
  focus: number;
  focusSlide: number;
  shells: number;
  shellSpread: number;
  /** 0 = tilted orbits (hero), 1 = rings face the camera (fly-through). */
  shellAlign: number;
  coreGlow: number;
  arms: number;
  irid: number;
  /** Electron cloud visibility 0..1. */
  cloud: number;
}

export function createAtomDrive(): AtomDrive {
  return { atom: 1, explode: 0, isolate: 0, focus: -1, focusSlide: 0, shells: 1, shellSpread: 0, shellAlign: 0, coreGlow: 0, arms: 0, irid: 0, cloud: 1 };
}

export interface AtomPointer {
  /** Drag rotation (radians), already eased by the owner. */
  rotX: number;
  rotY: number;
}

export function createAtomPointer(): AtomPointer {
  return { rotX: 0, rotY: 0 };
}

export interface AtomAnchors {
  atom?: LeaderAnchor;
  focus?: LeaderAnchor;
  inner?: LeaderAnchor;
  outer?: LeaderAnchor;
  /** Fade applied to all anchors (chapter envelope), written by the owner. */
  fade?: { value: number };
}

const NUCLEON_R = 0.26;
const CLUSTER_R = 0.47;
const INNER_R = 1.15;
const OUTER_R = 1.95;
const FOCUS_SCALE = 3.4;
const PHI = (1 + Math.sqrt(5)) / 2;

/** Icosahedron vertices; protons take one of each antipodal pair, so the two kinds interleave. */
function nucleonLayout(): { pos: Vector3[]; proton: number[] } {
  const raw: [number, number, number][] = [
    [0, 1, PHI], [0, -1, PHI], [1, PHI, 0], [-1, PHI, 0], [PHI, 0, 1], [-PHI, 0, 1],
    [0, -1, -PHI], [0, 1, -PHI], [-1, -PHI, 0], [1, -PHI, 0], [-PHI, 0, -1], [PHI, 0, -1],
  ];
  const pos = raw.map(([x, y, z]) => new Vector3(x, y, z).normalize().multiplyScalar(CLUSTER_R));
  // indices 0..5 are protons (Scout..Sentinel), 6..11 their antipodal neutrons
  return { pos, proton: [0, 1, 2, 3, 4, 5] };
}

const TETRA = [new Vector3(1, 1, 1), new Vector3(1, -1, -1), new Vector3(-1, 1, -1), new Vector3(-1, -1, 1)].map((v) => v.normalize());

function seeded(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function Atom({ drive, pointer, anchors, cloudCount = 1600 }: { drive: AtomDrive; pointer?: AtomPointer; anchors?: AtomAnchors; cloudCount?: number }) {
  const kit = useKit();
  const group = useRef<Group>(null);
  const spin = useRef<Group>(null);
  const nucleons = useRef<InstancedMesh>(null);
  const hits = useRef<InstancedMesh>(null);
  const electrons = useRef<InstancedMesh>(null);
  const arms = useRef<InstancedMesh>(null);
  const innerRing = useRef<Mesh>(null);
  const outerRing = useRef<Mesh>(null);
  const cloud = useRef<Points>(null);
  const bubbles = useRef<Group>(null);
  const hovered = useRef<number | null>(null);
  // click a proton for its agent's detail panel; a neutron for what neutrons mean
  const handlers = useMemo(
    () =>
      inspectHandlers(
        kit.inspect,
        (i) => {
          if (i === undefined || drive.atom < 0.3) return null;
          if (drive.isolate > 0.5 && i !== drive.focus) return null;
          return i < 6 ? { kind: 'agent', agent: AGENT_IDS[i]! } : { kind: 'neutron' };
        },
        (i) => {
          hovered.current = i;
        },
      ),
    [kit.inspect, drive],
  );

  const res = useMemo(() => {
    const layout = nucleonLayout();
    const sphere = new SphereGeometry(NUCLEON_R, 40, 28);
    // click target: a coarser, larger sphere per nucleon so a tap lands even while the atom spins or glitches
    const hitGeo = new SphereGeometry(NUCLEON_R * 1.6, 10, 8);
    const emblem = new Float32Array(12);
    const glow = new Float32Array(12);
    const fade = new Float32Array(12).fill(1);
    for (let i = 0; i < 12; i++) emblem[i] = i < 6 ? i : -1;
    const aEmblem = new InstancedBufferAttribute(emblem, 1);
    const aGlow = new InstancedBufferAttribute(glow, 1);
    const aFade = new InstancedBufferAttribute(fade, 1);
    sphere.setAttribute('aEmblem', aEmblem);
    sphere.setAttribute('aGlow', aGlow);
    sphere.setAttribute('aFade', aFade);
    const nucleonMat = createFrostMaterial(kit.shared, { instancedAttrs: true, atlas: getEmblemAtlas(), rough: 0.66, emblemStrength: 0.6 });

    const eGeo = new SphereGeometry(0.075, 16, 12);
    const eMat = createFrostMaterial(kit.shared, { base: COLORS.frost, rough: 0.4 });
    eMat.uniforms.uGlow.value = 0.55;

    const ringMat = createFrostMaterial(kit.shared, { base: COLORS.frost, shade: COLORS.fogMid, rough: 0.5, fresnelAlpha: 0.6, opacity: 0.75, doubleSide: true });
    const innerGeo = new TorusGeometry(INNER_R, 0.045, 12, 120);
    const outerGeo = new TorusGeometry(OUTER_R, 0.05, 12, 160);

    // faint translucent shells (fresnel-only bubbles) around the orbits
    const bubbleGeo = new SphereGeometry(1, 48, 32);
    const bubbleMat = createFrostMaterial(kit.shared, { base: COLORS.frost, shade: COLORS.fogMid, fresnelAlpha: 1, opacity: 0.2, rough: 0.5 });

    const armGeo = new CylinderGeometry(0.075, 0.075, 1, 12, 1, true);
    armGeo.translate(0, 0.5, 0);
    const armMat = createFrostMaterial(kit.shared, { base: COLORS.frost, fresnelAlpha: 0.5, opacity: 0.85, rough: 0.45 });

    // electron cloud: shell-distributed points, one draw call
    const n = cloudCount;
    const cpos = new Float32Array(n * 3);
    const cseed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = seeded(i * 3 + 1) * 2 - 1;
      const th = seeded(i * 3 + 2) * Math.PI * 2;
      const rr = 0.75 + Math.pow(seeded(i * 3 + 3), 0.7) * 1.65;
      const s = Math.sqrt(1 - u * u);
      cpos[i * 3] = Math.cos(th) * s * rr;
      cpos[i * 3 + 1] = u * rr * 0.8;
      cpos[i * 3 + 2] = Math.sin(th) * s * rr;
      cseed[i] = seeded(i + 999);
    }
    const cloudGeo = new BufferGeometry();
    cloudGeo.setAttribute('position', new BufferAttribute(cpos, 3));
    cloudGeo.setAttribute('aSeed', new BufferAttribute(cseed, 1));
    const cloudMat = createCloudMaterial(kit.shared);

    const tumbleAxis = Array.from({ length: 12 }, (_, i) => new Vector3(seeded(i + 1) - 0.5, seeded(i + 2) - 0.5, seeded(i + 3) - 0.5).normalize());
    const lift = Array.from({ length: 12 }, (_, i) => 0.35 + seeded(i + 40) * 0.9);
    return { layout, sphere, hitGeo, aGlow, aFade, nucleonMat, eGeo, eMat, ringMat, innerGeo, outerGeo, bubbleGeo, bubbleMat, armGeo, armMat, cloudGeo, cloudMat, tumbleAxis, lift };
  }, [kit.shared, cloudCount]);

  useEffect(
    () => () => {
      res.sphere.dispose();
      res.hitGeo.dispose();
      res.nucleonMat.dispose();
      res.eGeo.dispose();
      res.eMat.dispose();
      res.ringMat.dispose();
      res.innerGeo.dispose();
      res.outerGeo.dispose();
      res.bubbleGeo.dispose();
      res.bubbleMat.dispose();
      res.armGeo.dispose();
      res.armMat.dispose();
      res.cloudGeo.dispose();
      res.cloudMat.dispose();
    },
    [res],
  );

  // scratch (no per-frame allocations)
  const s = useMemo(
    () => ({
      o: new Object3D(),
      q: new Quaternion(),
      q2: new Quaternion(),
      v: new Vector3(),
      v2: new Vector3(),
      e: new Euler(),
      m: new Matrix4(),
      up: new Vector3(0, 1, 0),
      focusPos: new Vector3(),
      orbit: Array.from({ length: 6 }, () => new Vector3()),
    }),
    [],
  );

  useFrame((state, delta) => {
    const g = group.current;
    const nm = nucleons.current;
    const em = electrons.current;
    const am = arms.current;
    if (!g || !nm || !em || !am || !spin.current) return;
    const d = drive;
    const t = kit.shared.uTime.value;
    const vis = d.atom;
    g.visible = vis > 0.003;
    if (!g.visible) {
      fadeAnchors(anchors, 0);
      return;
    }
    g.scale.setScalar(0.6 + 0.4 * vis);
    // idle spin + drag rotation (owner eases the drag)
    spin.current.rotation.set(pointer ? pointer.rotX : 0, (pointer ? pointer.rotY : 0) + t * 0.06 * (1 - d.isolate), 0);

    // nucleons
    const isolate = d.isolate;
    for (let i = 0; i < 12; i++) {
      const base = res.layout.pos[i]!;
      s.v.copy(base).normalize();
      const ex = d.explode;
      s.o.position.copy(base).addScaledVector(s.v, ex * 1.75);
      s.o.position.y += ex * res.lift[i]!;
      s.q.setFromAxisAngle(res.tumbleAxis[i]!, ex * (1.2 + seeded(i + 7) * 2.4));
      let scale = 1;
      let fade = vis;
      if (d.focus === i) {
        // the proton in focus moves to the centre of the frame, grows and turns its emblem to camera
        s.focusPos.set(d.focusSlide * 3.6, 0, 0);
        s.o.position.lerp(s.focusPos, isolate);
        scale = 1 + (FOCUS_SCALE - 1) * isolate;
        s.e.set(0.12 * Math.sin(t * 0.4), 0.35 * Math.sin(t * 0.5) - (pointer ? pointer.rotY : 0) * isolate, 0);
        s.q2.setFromEuler(s.e);
        s.q.slerp(s.q2, isolate);
        fade = vis * (1 - Math.abs(d.focusSlide) * 0.6);
      } else {
        scale = 1 - isolate;
        fade = vis * (1 - isolate);
      }
      s.o.quaternion.copy(s.q);
      s.o.scale.setScalar(Math.max(0.0001, scale));
      s.o.updateMatrix();
      nm.setMatrixAt(i, s.o.matrix);
      res.aFade.setX(i, fade);
      res.aGlow.setX(i, d.coreGlow * 0.9 + (hovered.current === i ? 0.45 : 0));
    }
    nm.instanceMatrix.needsUpdate = true;
    // click proxies follow the nucleons; instanced raycasts cache a bounding sphere, so refresh it
    const hm = hits.current;
    if (hm && kit.inspect) {
      for (let i = 0; i < 12; i++) {
        nm.getMatrixAt(i, s.m);
        hm.setMatrixAt(i, s.m);
      }
      hm.instanceMatrix.needsUpdate = true;
      hm.computeBoundingSphere();
    }
    res.aFade.needsUpdate = true;
    res.aGlow.needsUpdate = true;
    res.nucleonMat.uniforms.uIrid.value = d.irid;

    // shells: tilted orbits in the hero; aligned rings spread in depth for the fly-through
    const al = d.shellAlign;
    const shellVis = d.shells * vis;
    const ir = innerRing.current!;
    const or = outerRing.current!;
    ir.visible = or.visible = shellVis > 0.01;
    ir.rotation.set(1.15 * (1 - al), 0.0, 0.35 * (1 - al));
    or.rotation.set(1.42 * (1 - al), 0.2 * (1 - al), -0.55 * (1 - al));
    ir.position.set(0, 0, 1.3 * d.shellSpread);
    or.position.set(0, 0, 2.6 * d.shellSpread);
    res.ringMat.uniforms.uOpacity.value = 0.75 * shellVis;
    res.ringMat.uniforms.uIrid.value = d.irid * 0.6;
    const bub = bubbles.current;
    if (bub) {
      bub.visible = shellVis > 0.01 && al < 0.99;
      res.bubbleMat.uniforms.uOpacity.value = 0.2 * shellVis * (1 - al);
    }

    // electrons ride the rings; the 4 outer ones become the 4 bond arms
    for (let i = 0; i < 6; i++) {
      const inner = i < 2;
      const ring = inner ? ir : or;
      const r = inner ? INNER_R : OUTER_R;
      const phase = inner ? i * Math.PI : (i - 2) * (Math.PI / 2);
      const a = phase + t * (inner ? 0.9 : 0.55);
      s.v.set(Math.cos(a) * r, Math.sin(a) * r, 0);
      ring.updateMatrix();
      s.v.applyMatrix4(ring.matrix);
      if (!inner && d.arms > 0) {
        s.v2.copy(TETRA[i - 2]!).multiplyScalar(OUTER_R);
        s.v.lerp(s.v2, d.arms);
      }
      s.orbit[i]!.copy(s.v);
      s.o.position.copy(s.v);
      s.o.quaternion.identity();
      s.o.scale.setScalar(shellVis > 0.01 ? 1 + d.arms * (inner ? 0 : 0.6) : 0.0001);
      s.o.updateMatrix();
      em.setMatrixAt(i, s.o.matrix);
    }
    em.instanceMatrix.needsUpdate = true;
    em.visible = shellVis > 0.01;

    // bond arms
    am.visible = d.arms > 0.01 && vis > 0.01;
    if (am.visible) {
      for (let k = 0; k < 4; k++) {
        const tip = s.orbit[k + 2]!;
        const len = tip.length() * d.arms;
        s.v.copy(tip).normalize();
        s.o.position.set(0, 0, 0);
        s.o.quaternion.setFromUnitVectors(s.up, s.v);
        s.o.scale.set(1, Math.max(0.0001, len), 1);
        s.o.updateMatrix();
        am.setMatrixAt(k, s.o.matrix);
      }
      am.instanceMatrix.needsUpdate = true;
      res.armMat.uniforms.uOpacity.value = 0.85 * d.arms * vis;
      res.armMat.uniforms.uGlow.value = 0.2 * d.arms;
    }

    // electron cloud (the shared pointer push disturbs it, see materials.ts)
    const c = cloud.current!;
    const cv = d.cloud * shellVis;
    c.visible = cv > 0.01;
    res.cloudMat.uniforms.uOpacity.value = 0.55 * cv;

    // HUD anchors
    if (anchors) {
      const f = (anchors.fade?.value ?? 1) * vis;
      g.updateMatrixWorld();
      if (anchors.atom) {
        anchors.atom.world.set(OUTER_R * 0.55, OUTER_R * 0.6, 0).applyMatrix4(g.matrixWorld);
        anchors.atom.opacity = f * (1 - isolate);
      }
      if (anchors.focus) {
        if (d.focus >= 0) {
          nm.getMatrixAt(d.focus, s.m);
          anchors.focus.world.setFromMatrixPosition(s.m);
          anchors.focus.world.x += NUCLEON_R * FOCUS_SCALE * 0.62 * isolate;
          anchors.focus.world.y += NUCLEON_R * FOCUS_SCALE * 0.62 * isolate;
          anchors.focus.world.applyMatrix4(spin.current.matrixWorld);
          anchors.focus.opacity = f * isolate * (1 - Math.min(1, Math.abs(d.focusSlide) * 2.5));
        } else anchors.focus.opacity = 0;
      }
      if (anchors.inner) {
        anchors.inner.world.copy(s.orbit[0]!).applyMatrix4(spin.current.matrixWorld);
        anchors.inner.opacity = f * shellVis;
      }
      if (anchors.outer) {
        anchors.outer.world.copy(s.orbit[2]!).applyMatrix4(spin.current.matrixWorld);
        anchors.outer.opacity = f * shellVis;
      }
    }
    void state;
    void delta;
  });

  return (
    <group ref={group}>
      <group ref={spin}>
        <instancedMesh ref={nucleons} args={[res.sphere, res.nucleonMat, 12]} frustumCulled={false} />
        <instancedMesh ref={hits} args={[res.hitGeo, undefined, 12]} visible={false} userData={{ hitProxy: true }} frustumCulled={false} {...handlers} />
        <mesh ref={innerRing} geometry={res.innerGeo} material={res.ringMat} matrixAutoUpdate />
        <mesh ref={outerRing} geometry={res.outerGeo} material={res.ringMat} />
        <group ref={bubbles}>
          <mesh geometry={res.bubbleGeo} material={res.bubbleMat} scale={INNER_R} renderOrder={2} />
          <mesh geometry={res.bubbleGeo} material={res.bubbleMat} scale={OUTER_R} renderOrder={3} />
        </group>
        <instancedMesh ref={electrons} args={[res.eGeo, res.eMat, 6]} frustumCulled={false} />
        <instancedMesh ref={arms} args={[res.armGeo, res.armMat, 4]} frustumCulled={false} />
        <points ref={cloud} geometry={res.cloudGeo} material={res.cloudMat} frustumCulled={false} />
      </group>
    </group>
  );
}

function fadeAnchors(a: AtomAnchors | undefined, v: number): void {
  if (!a) return;
  if (a.atom) a.atom.opacity = v;
  if (a.focus) a.focus.opacity = v;
  if (a.inner) a.inner.opacity = v;
  if (a.outer) a.outer.opacity = v;
}
