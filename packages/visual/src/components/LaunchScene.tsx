'use client';
/**
 * <LaunchScene events bonds sentinel decay daughter /> for /l/[ca]. Fully live:
 *  - the launch's six agent atoms in its shape;
 *  - bonds drawn from core's Bond[] (orders exactly as core recomputes them),
 *    seams flash on each real hand-off event, hash riding the seam;
 *  - Sentinel's check on a real sentinel.score event: seams to every atom at
 *    once, ring gauge filling input by input, lock flash on pass, red broken
 *    seams on block;
 *  - decay: dimming nucleus shedding particles; the daughter forms beside it.
 * With no events the view is still and shows honest empty readouts.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BufferAttribute, BufferGeometry, Group, PlaneGeometry, TorusGeometry, Vector3, type Mesh, type Points } from 'three';
import {
  AGENT_IDS,
  EMPTY_READOUT,
  SHAPE_IDS,
  type AgentId,
  type Bond as CoreBond,
  type ArgonEvent,
  type SentinelReport,
  type ShapeId,
} from '@argon/core/contracts';
import { COPY } from '../copy.js';
import { flashesFromEvents, latestSentinel, pairAgents, realEvents, validBonds } from '../data/derive.js';
import { gaugeSegments, sentinelPhase } from '../data/sentinel.js';
import { HudCorner, HudLabel, HudLeaders, HudMeta, HudReadout, HudSection, HudTag } from '../hud/Hud.js';
import { LeaderRegistry } from '../hud/leaders.js';
import { fmtBonds, fmtCountdown, shortCa, shortHash } from '../hud/format.js';
import { SentinelHud } from '../hud/panels.js';
import { createDeviceQualityStore, type QualityStore } from '../quality/store.js';
import { SoundToggle } from '../sound/SoundToggle.js';
import { useBondChimes } from '../sound/sound.js';
import { useReducedMotion } from '../story/scroll.js';
import { Bond } from '../three/Bond.js';
import { CameraRig } from '../three/CameraRig.js';
import { moleculeLayout } from '../three/layouts.js';
import { COLORS, createFrostMaterial, createGaugeMaterial, createShedMaterial } from '../three/materials.js';
import { AgentAtoms, Molecule, type MutableNumber } from '../three/Molecule.js';
import { Stage, useKit } from '../three/Stage.js';
import type { BondFlash, DaughterView, DecayView } from '../types.js';

export interface LaunchSceneProps {
  /** The launch's logged events (any order; only real ids are used). */
  events: readonly ArgonEvent[];
  /** Core's current bonds for this launch (Handoffs.bonds). Orders are drawn exactly as given. */
  bonds: readonly CoreBond[];
  /** Override the Sentinel report (defaults to the latest sentinel.score event). */
  sentinel?: SentinelReport | null;
  /** Decay clock (Ar-41 / Ar-39), from the config table + trade data. */
  decay?: DecayView | null;
  /** Daughter coin once daughter.launched exists. */
  daughter?: DaughterView | null;
  /** Shape override (defaults to launch.created). */
  shape?: ShapeId;
  /** Compact chrome (embed player). */
  compact?: boolean;
  /** Render the scene's own "Sound: On/Off" toggle (default true unless compact). */
  soundToggle?: boolean;
  reducedMotion?: boolean;
  quality?: QualityStore;
  className?: string;
}

interface Derived {
  shape: ShapeId;
  heavy: AgentId | null;
  flashes: BondFlash[];
  lastFlash: Map<string, BondFlash>;
  sentinel: { report: SentinelReport; eventId: string; ts: number } | null;
  hasEvents: boolean;
}

function derive(props: LaunchSceneProps): Derived {
  const evs = realEvents(props.events);
  const created = evs.find((e): e is ArgonEvent<'launch.created'> => e.kind === 'launch.created');
  const shape = props.shape ?? (created && SHAPE_IDS.includes(created.payload.shape) ? created.payload.shape : 'ring');
  const flashes = flashesFromEvents(evs);
  const lastFlash = new Map<string, BondFlash>();
  for (const f of flashes) lastFlash.set(f.pairKey, f);
  const ls = latestSentinel(evs);
  const sev = ls ? evs.find((e) => e.id === ls.eventId) : undefined;
  const sentinel = props.sentinel
    ? { report: props.sentinel, eventId: ls?.eventId ?? '', ts: sev?.ts ?? 0 }
    : ls
      ? { report: ls.report, eventId: ls.eventId, ts: sev?.ts ?? 0 }
      : null;
  return { shape, heavy: created?.payload.heavyAgent ?? null, flashes, lastFlash, sentinel, hasEvents: evs.length > 0 };
}

const SCALE = 1.45;

function LaunchObjects({ d, bonds, decay, daughter, leaders }: { d: Derived; bonds: CoreBond[]; decay: DecayView | null; daughter: DaughterView | null; leaders: LeaderRegistry }) {
  const kit = useKit();
  const layout = useMemo(() => moleculeLayout(d.shape), [d.shape]);
  const mother = useRef<Group>(null);
  const offset = daughter ? -1.7 : 0;
  const pos = useMemo(
    () => Object.fromEntries(AGENT_IDS.map((a) => [a, new Vector3(...layout.atoms[a]).multiplyScalar(SCALE)])) as Record<AgentId, Vector3>,
    [layout],
  );
  const dim = useMemo(() => ({ value: 1 }), []);
  const glow = useMemo(() => Object.fromEntries(AGENT_IDS.map((a) => [a, 0])) as Record<AgentId, number>, []);

  // Sentinel check: starts when a NEW sentinel.score event arrives; a report present at mount is final.
  const check = useRef({ id: null as string | null, start: -Infinity, mountedAt: Date.now() });
  useEffect(() => {
    const s = d.sentinel;
    if (!s || !s.eventId || s.eventId === check.current.id) return;
    const first = check.current.id === null;
    check.current.id = s.eventId;
    const fresh = s.ts >= check.current.mountedAt - 3000;
    check.current.start = first && !fresh ? -Infinity : kit.shared.uTime.value;
  }, [d.sentinel, kit.shared]);

  const gauge = useMemo(() => {
    const geo = new PlaneGeometry(1.7, 1.7);
    const mat = createGaugeMaterial();
    const lockGeo = new TorusGeometry(0.62, 0.02, 8, 64);
    const lockMat = createFrostMaterial(kit.shared, { base: COLORS.frost });
    return { geo, mat, lockGeo, lockMat };
  }, [kit.shared]);
  useEffect(
    () => () => {
      gauge.geo.dispose();
      gauge.mat.dispose();
      gauge.lockGeo.dispose();
      gauge.lockMat.dispose();
    },
    [gauge],
  );
  const segs = useMemo(() => gaugeSegments(d.sentinel?.report ?? null), [d.sentinel]);
  const gaugeMesh = useRef<Mesh>(null);
  const lockMesh = useRef<Mesh>(null);
  const checkVis = useMemo(() => ({ value: 0 }), []);
  const checkGrow = useMemo(() => ({ value: 0 }), []);
  const [broken, setBroken] = useState(false);

  // decay particles
  const shed = useMemo(() => {
    const n = 900;
    const p = new Float32Array(n * 3);
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = Math.sin(i * 12.9898) * 43758.5453;
      const r1 = u - Math.floor(u);
      const v2 = Math.sin(i * 78.233) * 12543.123;
      const r2 = v2 - Math.floor(v2);
      const th = r1 * Math.PI * 2;
      const z = r2 * 2 - 1;
      const k = Math.sqrt(1 - z * z);
      p[i * 3] = Math.cos(th) * k;
      p[i * 3 + 1] = z;
      p[i * 3 + 2] = Math.sin(th) * k;
      const w = Math.sin(i * 3.1 + 1.7) * 9631.7;
      s[i] = w - Math.floor(w);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(p, 3));
    geo.setAttribute('aSeed', new BufferAttribute(s, 1));
    return { geo, mat: createShedMaterial(kit.shared) };
  }, [kit.shared]);
  useEffect(
    () => () => {
      shed.geo.dispose();
      shed.mat.dispose();
    },
    [shed],
  );
  const shedRef = useRef<Points>(null);

  // daughter forms beside the mother on collapse
  const daughterVis = useMemo(() => ({ value: 0 }), []);
  const daughterAt = useRef<number | null>(null);
  useEffect(() => {
    if (daughter && daughterAt.current === null) daughterAt.current = kit.shared.uTime.value;
    if (!daughter) daughterAt.current = null;
  }, [daughter, kit.shared]);
  const daughterPos = useMemo(() => new Vector3(2.9, -0.2, 0), []);

  const sentinelAnchor = useMemo(() => leaders.anchor('sentinel'), [leaders]);
  const decayAnchor = useMemo(() => leaders.anchor('decay'), [leaders]);
  const daughterAnchor = useMemo(() => leaders.anchor('daughter'), [leaders]);
  const daughterFade = useMemo(() => ({ value: 1 }), []);

  useFrame(() => {
    const t = kit.shared.uTime.value;
    const m = mother.current;
    if (m) m.position.x += (offset - m.position.x) * 0.08;

    // sentinel check
    const s = d.sentinel;
    if (s && segs.length) {
      const age = t - check.current.start;
      const ph = sentinelPhase(s.report, kit.reducedMotion ? Infinity : age);
      const live = Number.isFinite(age);
      const u = gauge.mat.uniforms;
      u.uCount.value = segs.length;
      for (let i = 0; i < segs.length; i++) {
        const g = segs[i]!;
        u.uSegStart.value[i] = g.start;
        u.uSegEnd.value[i] = g.end;
        u.uSegFill.value[i] = g.fill * (ph.fills[i] ?? 1);
        u.uSegHard.value[i] = g.hardFail ? 1 : 0;
      }
      u.uLock.value = ph.lock;
      checkGrow.value = ph.seams;
      // seams visible while checking; after a pass they fade, after a block they stay (broken, red)
      checkVis.value = !live ? (s.report.passed ? 0 : 1) : ph.done ? (s.report.passed ? Math.max(0, 1 - (age - 0.45 - segs.length * 0.4) / 2.5) : 1) : 1;
      if (ph.broken !== broken) setBroken(ph.broken);
      kit.post.flash = ph.lock * 0.45;
      glow.sentinel = live && !ph.done ? 0.35 : ph.lock * 0.8;
      if (lockMesh.current) {
        lockMesh.current.visible = s.report.passed && ph.done;
        lockMesh.current.scale.setScalar(1 + 0.3 * ph.lock);
      }
    } else {
      checkVis.value = 0;
      kit.post.flash = 0;
    }
    const gm = gaugeMesh.current;
    if (gm) {
      gm.visible = !!s && segs.length > 0;
      gm.position.copy(pos.sentinel);
      gm.quaternion.copy(gm.parent!.quaternion).invert();
    }
    if (lockMesh.current) lockMesh.current.position.copy(pos.sentinel);
    if (m) {
      m.updateMatrixWorld();
      sentinelAnchor.world.copy(pos.sentinel).applyMatrix4(m.matrixWorld);
      sentinelAnchor.opacity = s ? 1 : 0;
    }

    // decay: dimming nucleus shedding particles
    let frac = 0;
    if (decay) {
      const now = Date.now();
      const span = Math.max(1, decay.deadline - decay.startedAt);
      frac = decay.collapsedEventId ? 1 : Math.max(0, Math.min(1, (now - decay.startedAt) / span));
    }
    dim.value = decay ? (decay.collapsedEventId ? 0.35 : 1 - 0.5 * frac) : 1;
    shed.mat.uniforms.uAmount.value = decay ? (decay.collapsedEventId ? 0.15 : 0.1 + 0.9 * frac) : 0;
    if (shedRef.current) shedRef.current.visible = !!decay;
    if (m && decay) {
      decayAnchor.world.set(0, -1.6, 0).applyMatrix4(m.matrixWorld);
      decayAnchor.opacity = 1;
    } else decayAnchor.opacity = 0;

    // daughter
    if (daughter && daughterAt.current !== null) {
      daughterVis.value = kit.reducedMotion ? 1 : Math.min(1, (t - daughterAt.current) / 1.6);
      daughterAnchor.opacity = daughterVis.value;
    } else {
      daughterVis.value = 0;
      daughterAnchor.opacity = 0;
    }
  });

  const checkTargets = AGENT_IDS.filter((a) => a !== 'sentinel');

  return (
    <>
      <group ref={mother}>
        <AgentAtoms positions={pos} radius={0.32} dim={dim} glow={glow} highlight={d.heavy} />
        {bonds.map((b) => {
          const [x, y] = pairAgents(b.pair);
          const f = d.lastFlash.get(b.pair);
          return (
            <Bond key={b.pair} from={pos[x]} to={pos[y]} order={b.order as 1 | 2 | 3} hash={b.lastHash} flashKey={f?.hash ?? b.lastHash} flashAt={f?.at ?? null} radius={0.13} />
          );
        })}
        {checkTargets.map((a) => (
          <Bond key={`check-${a}`} from={pos.sentinel} to={pos[a]} order={1} visibility={checkVis} grow={checkGrow} broken={broken} radius={0.05} />
        ))}
        <mesh ref={gaugeMesh} geometry={gauge.geo} material={gauge.mat} renderOrder={5} />
        <mesh ref={lockMesh} geometry={gauge.lockGeo} material={gauge.lockMat} />
        <points ref={shedRef} geometry={shed.geo} material={shed.mat} frustumCulled={false} />
      </group>
      {daughter ? <Molecule shape={d.shape} position={daughterPos} scale={0.6} visibility={daughterVis} anchor={daughterAnchor} anchorFade={daughterFade} /> : null}
    </>
  );
}

export function LaunchScene(props: LaunchSceneProps) {
  const d = useMemo(() => derive(props), [props.events, props.sentinel, props.shape]); // eslint-disable-line react-hooks/exhaustive-deps
  const bonds = useMemo(() => validBonds(props.bonds), [props.bonds]);
  const decay = props.decay ?? null;
  const daughter = props.daughter ?? null;
  const reducedPref = useReducedMotion(props.reducedMotion);
  // an empty stream is a still view
  const still = reducedPref || !d.hasEvents;
  const q = useMemo(() => props.quality ?? createDeviceQualityStore(), [props.quality]);
  const leaders = useMemo(() => new LeaderRegistry(), []);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  useBondChimes(d.flashes);

  // countdown re-render once a second (real deadline only)
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!decay || decay.collapsedEventId) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [decay]);

  const orders = useMemo(() => {
    const o = Object.fromEntries(AGENT_IDS.map((a) => [a, 0])) as Record<AgentId, number>;
    for (const b of bonds) {
      const [x, y] = pairAgents(b.pair);
      o[x] += b.order;
      o[y] += b.order;
    }
    return o;
  }, [bonds]);

  return (
    <div ref={setFrame} className={`argon-frame ${props.compact ? 'argon-frame--embed' : 'argon-frame--launch'}${props.className ? ' ' + props.className : ''}`} data-testid="launch-scene">
      <Stage quality={q} leaders={leaders} reducedMotion={still} eventSource={frame} ariaLabel="Live launch molecule: agents, bonds and Sentinel check">
        {/* the HUD stacks are taller at the top (bonds, Sentinel) than at the bottom: aim a little high so the molecule sits centre-low */}
        <CameraRig position={[0, props.compact ? 0.6 : 1.0, 9]} target={[0, props.compact ? 0 : 0.45, 0]} fit={props.compact ? 1 : 0.78} fogMargin={3} />
        <LaunchObjects d={d} bonds={bonds} decay={decay} daughter={daughter} leaders={leaders} />
      </Stage>
      <div className="argon-hud">
        <HudLeaders registry={leaders} />
        <HudCorner at="tl">
          <HudSection>{props.compact ? '////// Argon' : '////// Live launch'}</HudSection>
          <HudTag testId="launch-live-tag">{COPY.liveTag}</HudTag>
          {!d.hasEvents ? <HudMeta>no events logged yet</HudMeta> : null}
          {!props.compact ? (
            <div style={{ marginTop: 6 }} data-testid="launch-bonds">
              {AGENT_IDS.map((a) => (
                <HudReadout key={a} label={a.toUpperCase().padEnd(9, ' ')} value={d.hasEvents ? fmtBonds(orders[a]) : fmtBonds(null)} />
              ))}
              {bonds.length > 0 ? <HudMeta>{`last seam ${shortHash(bonds[bonds.length - 1]!.lastHash)}`}</HudMeta> : null}
            </div>
          ) : null}
        </HudCorner>
        {!props.compact ? (
          <HudCorner at="tr">
            <div ref={leaders.labelRef('sentinel')}>
              <SentinelHud report={d.sentinel?.report ?? null} />
            </div>
          </HudCorner>
        ) : null}
        {decay ? (
          <HudCorner at="br" testId="decay-hud">
            <HudLabel leaderRef={leaders.labelRef('decay')}>{decay.collapsedEventId ? 'DECAYED' : 'DECAY_CLOCK'}</HudLabel>
            <HudReadout value={decay.collapsedEventId ? `collapsed · ${shortHash(decay.collapsedEventId)}` : fmtCountdown(decay.deadline - now)} testId="decay-countdown" />
            <HudMeta>{decay.kind === 'quiet' ? 'resets on every trade' : 'fixed clock; trades do not reset it'}</HudMeta>
          </HudCorner>
        ) : null}
        {daughter ? (
          <HudCorner at="mr" testId="daughter-hud">
            <HudLabel leaderRef={leaders.labelRef('daughter')}>{daughter.ticker ? `DAUGHTER_${daughter.ticker.replace(/^\$/, '')}` : 'DAUGHTER'}</HudLabel>
            <HudReadout label="CA" value={shortCa(daughter.daughterCa)} />
            <HudMeta>{shortHash(daughter.eventId)}</HudMeta>
          </HudCorner>
        ) : null}
        {!props.compact && props.soundToggle !== false ? <SoundToggle /> : null}
        {props.compact && !d.hasEvents ? (
          <HudCorner at="bc">
            <HudReadout value={EMPTY_READOUT} />
          </HudCorner>
        ) : null}
      </div>
    </div>
  );
}
