'use client';
/**
 * The story's 3D: one scene for all ten chapters, read from the progress
 * store every frame through evalStory (pure). Writes `data-chapter-3d` on the
 * pin element so the sync check can compare 3D, HUD and copy.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { memo, useEffect, useMemo, useReducer, useRef, type RefObject } from 'react';
import { Vector3, type PerspectiveCamera } from 'three';
import { AGENT_IDS, type AgentId, type IsotopeId, type ShapeId } from '@carbon/core/contracts';
import { chapterFade, chapterAt, chapterCenter, chapterLocal, replayedCountAt } from './chapters.js';
import { createStoryState, evalStory } from './timeline.js';
import type { ProgressStore } from './progress.js';
import type { LeaderRegistry } from '../hud/leaders.js';
import { Atom, createAtomDrive, createAtomPointer } from '../three/Atom.js';
import { Bond } from '../three/Bond.js';
import { ChamberObject } from '../three/Chamber.js';
import { Coin } from '../three/Coin.js';
import { GrapheneCrystals } from '../three/Graphene.js';
import { moleculeLayout } from '../three/layouts.js';
import { AgentAtoms, Molecule, type MutableNumber } from '../three/Molecule.js';
import { Plain } from '../three/Plain.js';
import { useKit } from '../three/Stage.js';
import type { BondFlash, LaunchReplay, LaunchSummary } from '../types.js';
import { pairAgents } from '../data/derive.js';

/** Drag-to-rotate: radians per pixel dragged, max coasting speed (rad/s) and how fast coasting stops. */
const DRAG_RAD_PER_PX = 0.0042;
const DRAG_MAX_SPEED = 2.4;
const DRAG_COAST_DAMP = 3.2;

export interface StorySceneProps {
  store: ProgressStore;
  leaders: LeaderRegistry;
  pin: HTMLElement | null;
  recent: readonly BondFlash[];
  replay: LaunchReplay | null;
  launches: readonly LaunchSummary[];
  isotope: IsotopeId;
  heavyAgent: AgentId | null;
  onHeavyDrop: (a: AgentId) => void;
  shape: ShapeId;
  onSelectLaunch: (l: LaunchSummary) => void;
  onHoverLaunch: (l: LaunchSummary | null) => void;
  hovered: string | null;
}

const num = (v = 0): MutableNumber => ({ value: v });

export const StoryScene = memo(function StoryScene(props: StorySceneProps) {
  const { store, leaders, pin } = props;
  const kit = useKit();
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const st = useMemo(() => createStoryState(), []);
  const drive = useMemo(() => createAtomDrive(), []);
  const pointer = useMemo(() => createAtomPointer(), []);
  const v = useMemo(
    () => ({
      plain: num(1),
      graphene: num(0),
      bonds: num(0),
      chamber: num(0),
      shapes: num(0),
      coin: num(0),
      replayMol: num(0),
      grow: [num(0), num(0), num(0)],
      fade: num(1),
      atomFade: { value: 1 },
    }),
    [],
  );
  const anchors = useMemo(
    () => ({
      atom: leaders.anchor('atom'),
      focus: leaders.anchor('focus'),
      inner: leaders.anchor('inner'),
      outer: leaders.anchor('outer'),
      fade: v.atomFade,
    }),
    [leaders, v],
  );
  const bondAnchors = useMemo(() => [leaders.anchor('bond:1'), leaders.anchor('bond:2'), leaders.anchor('bond:3')], [leaders]);
  const chamberAnchors = useMemo(
    () => ({ pedestal: leaders.anchor('pedestal'), extra: leaders.anchor('extra'), ...Object.fromEntries(AGENT_IDS.map((a) => [a, leaders.anchor(`chamber:${a}`)])) }),
    [leaders],
  );
  const shapeAnchors = useMemo(
    () => ({ chain: leaders.anchor('shape:chain'), ring: leaders.anchor('shape:ring'), diamond: leaders.anchor('shape:diamond') }),
    [leaders],
  );
  const coinAnchor = useMemo(() => leaders.anchor('coin'), [leaders]);

  // ch05 illustrative bond endpoints (stacked: single, double, triple); shifted left on phones for the labels
  const portraitEarly = size.width / Math.max(1, size.height) < 0.9;
  const bondEnds = useMemo(() => {
    const cx = portraitEarly ? -0.75 : 0;
    return [1.7, 0, -1.7].map((y) => ({ a: new Vector3(cx - 1.0, y, 0), b: new Vector3(cx + 1.0, y, 0) }));
  }, [portraitEarly]);
  const bondAtomPos = useMemo(() => {
    // emblems are just for texture here: pairs are illustrative
    const order: AgentId[] = ['scout', 'forge', 'herald', 'keeper', 'treasurer', 'sentinel'];
    const out = {} as Record<AgentId, Vector3>;
    order.forEach((a, i) => {
      const e = bondEnds[Math.floor(i / 2)]!;
      out[a] = (i % 2 === 0 ? e.a : e.b).clone();
    });
    return out;
  }, [bondEnds]);

  // shapes (ch07) positions; portrait stacks them
  const shapePos = useMemo(() => ({ chain: new Vector3(), ring: new Vector3(), diamond: new Vector3() }), []);
  const portrait = size.width / Math.max(1, size.height) < 0.9;

  // replay molecule (ch08): bonds at deploy, drawn with core's orders and hashes only
  const replayShape = props.replay?.shape ?? props.shape;
  const replayLayout = useMemo(() => moleculeLayout(replayShape), [replayShape]);
  const replayPos = useMemo(
    () => Object.fromEntries(AGENT_IDS.map((a) => [a, new Vector3(...replayLayout.atoms[a])])) as Record<AgentId, Vector3>,
    [replayLayout],
  );

  // replay: hand-offs replayed so far (scroll-driven), the latest per pair flashes on its bond
  const replayFlash = useRef<Map<string, string>>(new Map());
  const replayState = useRef({ count: -1 });

  // drag rotation (hero only): the atom follows the drag at a calm rate, then
  // coasts to a stop with a capped speed. The cursor push itself lives in Stage.
  const drag = useRef({ down: false, x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, lastTx: 0, lastTy: 0 });
  useEffect(() => {
    if (!pin) return;
    const d = drag.current;
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement)?.closest?.('button,a,[data-interactive]')) return;
      d.down = true;
      d.x = e.clientX;
      d.y = e.clientY;
    };
    const move = (e: PointerEvent) => {
      if (!d.down || !st.drag) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      d.ty += dx * DRAG_RAD_PER_PX;
      if (e.pointerType !== 'touch') d.tx = Math.max(-0.6, Math.min(0.6, d.tx + dy * DRAG_RAD_PER_PX * 0.7));
    };
    const up = () => {
      d.down = false;
    };
    const leave = () => {
      d.down = false;
    };
    pin.addEventListener('pointerdown', down);
    pin.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    pin.addEventListener('pointerleave', leave);
    pin.addEventListener('pointercancel', leave);
    return () => {
      pin.removeEventListener('pointerdown', down);
      pin.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      pin.removeEventListener('pointerleave', leave);
      pin.removeEventListener('pointercancel', leave);
    };
  }, [pin, st]);

  // click a crystal → fly in, then open
  const fly = useRef({ active: false, t: 0, target: new Vector3(), launch: null as LaunchSummary | null });
  const onSelect = (l: LaunchSummary, world: Vector3) => {
    if (kit.reducedMotion) {
      props.onSelectLaunch(l);
      return;
    }
    fly.current.active = true;
    fly.current.t = 0;
    fly.current.target.copy(world);
    fly.current.launch = l;
  };

  const lastChapter = useRef(-1);
  const look = useMemo(() => new Vector3(), []);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    // reduced motion: stepped — each chapter shows its key pose, no scrubbing
    const raw = store.get();
    const p = kit.reducedMotion ? chapterCenter(chapterAt(raw)) : raw;
    evalStory(p, size.width / Math.max(1, size.height), st);
    if (kit.reducedMotion) {
      st.chapter = chapterAt(raw);
    }

    // camera
    camera.position.set(st.camX, st.camY, st.camZ);
    look.set(st.tgtX, st.tgtY, st.tgtZ);
    const f = fly.current;
    if (f.active) {
      f.t += dt / 1.1;
      const k = Math.min(1, f.t);
      const e = k * k * (3 - 2 * k);
      camera.position.lerp(look.set(f.target.x, f.target.y + 1.6, f.target.z + 1.8), e);
      look.set(st.tgtX, st.tgtY, st.tgtZ).lerp(f.target, e);
      if (k >= 1) {
        f.active = false;
        if (f.launch) props.onSelectLaunch(f.launch);
      }
    }
    camera.lookAt(look);
    if (Math.abs(camera.fov - st.fov) > 0.01) {
      camera.fov = st.fov;
      camera.updateProjectionMatrix();
    }

    // drag inertia + cursor
    const d = drag.current;
    const sdt = Math.max(dt, 1e-3);
    if (d.down && st.drag) {
      // release speed: eased estimate of how fast the drag was moving (rad/s), capped
      const k = 1 - Math.exp(-sdt * 14);
      d.vy += ((d.ty - d.lastTy) / sdt - d.vy) * k;
      d.vx += ((d.tx - d.lastTx) / sdt - d.vx) * k;
    } else {
      d.ty += d.vy * sdt;
      d.tx = Math.max(-0.6, Math.min(0.6, d.tx + d.vx * sdt));
      const damp = Math.exp(-sdt * DRAG_COAST_DAMP);
      d.vy *= damp;
      d.vx *= damp;
    }
    d.vy = Math.max(-DRAG_MAX_SPEED, Math.min(DRAG_MAX_SPEED, d.vy));
    d.vx = Math.max(-DRAG_MAX_SPEED, Math.min(DRAG_MAX_SPEED, d.vx));
    if (!st.drag) {
      // outside the hero the atom eases back to its rest orientation
      d.vx = d.vy = 0;
      d.ty *= Math.exp(-sdt * 2.2);
      d.tx *= Math.exp(-sdt * 2.2);
    }
    d.lastTy = d.ty;
    d.lastTx = d.tx;
    const follow = 1 - Math.exp(-sdt * 9);
    pointer.rotY += (d.ty - pointer.rotY) * follow;
    pointer.rotX += (d.tx - pointer.rotX) * follow;

    // atom
    drive.atom = st.atom;
    drive.explode = st.explode;
    drive.isolate = st.isolate;
    drive.focus = st.focus;
    drive.focusSlide = st.focusSlide;
    drive.shells = st.shells;
    drive.shellSpread = st.shellSpread;
    drive.shellAlign = st.chapter === 4 || st.chapter === 5 ? 1 : 0;
    drive.coreGlow = st.coreGlow;
    drive.arms = st.arms;
    drive.irid = kit.reducedMotion ? 0 : st.irid;
    drive.cloud = st.chapter === 0 || st.chapter === 9 ? 1 : 0.35;
    const fade = chapterFade(st.local, st.chapter);
    v.fade.value = fade;
    v.atomFade.value = st.chapter <= 4 ? fade : 0;

    // scene objects
    v.plain.value = st.plain;
    v.graphene.value = st.graphene;
    v.bonds.value = st.bonds;
    for (let k = 0; k < 3; k++) v.grow[k]!.value = Math.max(0, Math.min(1, st.bondStage - k));
    v.chamber.value = st.chamber;
    v.shapes.value = st.chapter === 7 ? st.shapes : 0;
    v.replayMol.value = st.chapter === 8 ? st.shapes : 0;
    v.coin.value = st.coin;
    for (let k = 0; k < 3; k++) {
      const a = bondAnchors[k]!;
      a.world.copy(bondEnds[k]!.b).x += 0.35;
      a.opacity = st.chapter === 5 ? fade * Math.min(1, Math.max(0, st.bondStage - k)) : 0;
    }
    if (portrait) {
      shapePos.chain.set(-1.25, 2.7, 0);
      shapePos.ring.set(-1.25, 0, 0);
      shapePos.diamond.set(-1.25, -2.7, 0);
    } else {
      shapePos.chain.set(-3.3, 0, 0);
      shapePos.ring.set(0, 0, 0);
      shapePos.diamond.set(3.3, 0, 0);
    }

    // replay progress → which recorded hand-offs have happened (latest per pair flashes)
    const rp = props.replay;
    if (rp && st.chapter === 8) {
      const n = replayedCountAt(chapterLocal(raw, 8), rp.handoffs.length);
      if (n !== replayState.current.count) {
        replayState.current.count = n;
        replayFlash.current.clear();
        for (let i = 0; i < n; i++) {
          const h = rp.handoffs[i]!;
          const a = h.payload.from;
          const b = h.payload.to;
          const key = AGENT_IDS.indexOf(a) <= AGENT_IDS.indexOf(b) ? `${a}|${b}` : `${b}|${a}`;
          replayFlash.current.set(key, h.id);
        }
      }
    }

    // sync markers for tests/perf (DOM writes only on change)
    if (pin && st.chapter !== lastChapter.current) {
      lastChapter.current = st.chapter;
      pin.dataset.chapter3d = String(st.chapter);
      leaders.invalidate();
    }

    // post
    kit.post.glitch = kit.reducedMotion ? 0 : st.glitch;
    kit.post.aberration = st.aberration;
    kit.post.flash = kit.reducedMotion ? 0 : st.flash;
    kit.post.fog = st.fog;
    kit.post.fogDensity = st.chapter === 9 ? 0.06 : 0.085;
    // fog starts just past the subject so the centre object stays crisp
    kit.post.fogStart = Math.max(2, Math.hypot(st.camX - st.tgtX, st.camY - st.tgtY, st.camZ - st.tgtZ) - 1.5);
  }, -1);

  const recent = props.recent;
  const seamHashes = [recent[recent.length - 1], recent[recent.length - 2], recent[recent.length - 3]];
  const replayBonds = props.replay?.bondsAtDeploy ?? [];

  return (
    <>
      <Plain visibility={v.plain} graphene={v.graphene} />
      <Atom drive={drive} pointer={pointer} anchors={anchors} />

      {/* 05 bonding: real hashes only (latest real hand-offs), else bare seams */}
      <AgentAtoms positions={bondAtomPos} visibility={v.bonds} radius={0.3} />
      {bondEnds.map((e, k) => (
        <Bond
          key={k}
          from={e.a}
          to={e.b}
          order={(k + 1) as 1 | 2 | 3}
          hash={seamHashes[k]?.hash ?? null}
          flashKey={seamHashes[k]?.hash ?? null}
          flashAt={seamHashes[k]?.at ?? null}
          visibility={v.bonds}
          grow={v.grow[k]}
        />
      ))}

      {/* 06 isotope chamber */}
      <group position={[0, -0.2, 0]}>
        <ChamberObject
          isotope={props.isotope}
          heavyAgent={props.heavyAgent}
          visibility={v.chamber}
          onHeavyDrop={props.onHeavyDrop}
          anchors={chamberAnchors}
          anchorFade={v.fade}
        />
      </group>

      {/* 07 shapes */}
      <Molecule shape="chain" position={shapePos.chain} scale={portrait ? 0.62 : 0.8} visibility={v.shapes} anchor={shapeAnchors.chain} anchorFade={v.fade} />
      <Molecule shape="ring" position={shapePos.ring} scale={portrait ? 0.62 : 0.8} visibility={v.shapes} anchor={shapeAnchors.ring} anchorFade={v.fade} />
      <Molecule shape="diamond" position={shapePos.diamond} scale={portrait ? 0.62 : 0.8} visibility={v.shapes} anchor={shapeAnchors.diamond} anchorFade={v.fade} />

      {/* 08 the launch: replayed molecule (core's bonds at deploy) condensing into the coin */}
      <group scale={0.8}>
        <AgentAtoms positions={replayPos} visibility={v.replayMol} highlight={props.replay?.heavyAgent ?? null} />
        {replayBonds.map((b) => {
          const [x, y] = pairAgents(b.pair);
          return (
            <ReplayBond key={b.pair} from={replayPos[x]} to={replayPos[y]} order={b.order as 1 | 2 | 3} pair={b.pair} flashes={replayFlash} visibility={v.replayMol} />
          );
        })}
      </group>
      <Coin visibility={v.coin} ticker={props.replay?.ticker ?? null} anchor={coinAnchor} anchorFade={v.fade} />

      {/* 09 live graphene */}
      <GrapheneCrystals launches={props.launches} visibility={v.graphene} onSelect={onSelect} hovered={props.hovered} onHover={props.onHoverLaunch} />
    </>
  );
});

/** A bond of the replayed launch: core's order; the seam shows the latest replayed hand-off on that pair. */
function ReplayBond({
  from,
  to,
  order,
  pair,
  flashes,
  visibility,
}: {
  from: Vector3;
  to: Vector3;
  order: 1 | 2 | 3;
  pair: string;
  flashes: RefObject<Map<string, string>>;
  visibility: MutableNumber;
}) {
  const hash = useHashFromRef(flashes, pair);
  return <Bond from={from} to={to} order={order} hash={hash} flashKey={hash} flashAt={hash ? Date.now() : null} visibility={visibility} />;
}

/** Reads a ref map once per frame and re-renders only when this pair's hash changes. */
function useHashFromRef(ref: RefObject<Map<string, string>>, key: string): string | null {
  const hashRef = useRef<string | null>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useFrame(() => {
    const h = ref.current?.get(key) ?? null;
    if (h !== hashRef.current) {
      hashRef.current = h;
      bump();
    }
  });
  return hashRef.current;
}
