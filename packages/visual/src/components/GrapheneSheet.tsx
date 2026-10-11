'use client';
/**
 * <GrapheneSheet launches onOpenLaunch />: the live sheet of every real
 * launch, each a crystal in the frozen hex plain. Empty → EMPTY_GRAPHENE.
 */
import { useMemo, useRef, useState } from 'react';
import { Vector3 } from 'three';
import { useFrame } from '@react-three/fiber';
import { COPY } from '../copy.js';
import { validLaunches } from '../data/derive.js';
import { HudCorner, HudSection, HudTag } from '../hud/Hud.js';
import { GrapheneHud } from '../hud/panels.js';
import { createQualityStore, type QualityStore } from '../quality/store.js';
import { useReducedMotion } from '../story/scroll.js';
import { CameraRig } from '../three/CameraRig.js';
import { GrapheneCrystals, crystalsCentre, placeCrystals } from '../three/Graphene.js';
import { PLAIN_Y, Plain } from '../three/Plain.js';
import { Stage, useKit } from '../three/Stage.js';
import type { LaunchSummary } from '../types.js';

export interface GrapheneSheetProps {
  launches: readonly LaunchSummary[] | null | undefined;
  onOpenLaunch?: (ca: string) => void;
  onLaunch?: () => void;
  launchHref?: string;
  reducedMotion?: boolean;
  quality?: QualityStore;
  className?: string;
}

function Sheet({ launches, onOpen, onHover, hovered }: { launches: LaunchSummary[]; onOpen?: (ca: string) => void; onHover: (l: LaunchSummary | null) => void; hovered: string | null }) {
  const kit = useKit();
  const centre = useMemo(() => crystalsCentre(placeCrystals(launches), new Vector3()), [launches]);
  const spread = Math.min(14, 6 + Math.sqrt(launches.length) * 1.4);
  const focus = useRef({ t: 0, point: new Vector3(), go: false, ca: '' });
  const one = useMemo(() => ({ value: 1 }), []);
  useFrame((_, dt) => {
    const f = focus.current;
    if (!f.go) return;
    f.t = Math.min(1, f.t + dt / 1.1);
    if (f.t >= 1) {
      f.go = false;
      onOpen?.(f.ca);
      f.t = 0;
    }
  });
  return (
    <>
      <CameraRig position={[centre.x, PLAIN_Y + spread * 0.75, centre.z + spread * 0.55]} target={[centre.x, PLAIN_Y, centre.z]} fit={0.5} focus={focus.current} />
      <Plain visibility={one} graphene={one} />
      <GrapheneCrystals
        launches={launches}
        hovered={hovered}
        onHover={onHover}
        onSelect={(l, w) => {
          if (kit.reducedMotion) return onOpen?.(l.ca);
          focus.current.point.copy(w);
          focus.current.ca = l.ca;
          focus.current.t = 0;
          focus.current.go = true;
        }}
      />
    </>
  );
}

export function GrapheneSheet(props: GrapheneSheetProps) {
  const launches = useMemo(() => validLaunches(props.launches), [props.launches]);
  const reduced = useReducedMotion(props.reducedMotion);
  const q = useMemo(() => props.quality ?? createQualityStore(), [props.quality]);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [hovered, setHovered] = useState<LaunchSummary | null>(null);
  return (
    <div ref={setFrame} className={`carbon-frame carbon-frame--graphene${props.className ? ' ' + props.className : ''}`} data-testid="graphene-sheet">
      <Stage quality={q} reducedMotion={reduced || launches.length === 0} eventSource={frame} ariaLabel="Live graphene sheet of real launches">
        <Sheet launches={launches} onOpen={props.onOpenLaunch} onHover={setHovered} hovered={hovered?.ca ?? null} />
      </Stage>
      <div className="carbon-hud">
        <HudCorner at="tl">
          <HudSection>{COPY.live.head.replace('09 ', '')}</HudSection>
          <HudTag>{COPY.liveTag}</HudTag>
        </HudCorner>
        <HudCorner at="tr">
          <div data-interactive>
            <GrapheneHud launches={launches} hovered={hovered} onLaunch={props.onLaunch} launchHref={props.launchHref} />
          </div>
        </HudCorner>
      </div>
    </div>
  );
}
