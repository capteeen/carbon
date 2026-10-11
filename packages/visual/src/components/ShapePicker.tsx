'use client';
/**
 * <ShapePicker value onChange />: chain, benzene ring and diamond lattice side
 * by side (stacked on phones), HUD lines naming what each does (from the
 * SHAPES config table).
 */
import { useMemo, useState } from 'react';
import { Vector3 } from 'three';
import type { ShapeId } from '@carbon/core/contracts';
import { COPY } from '../copy.js';
import { HudCorner, HudLeaders, HudSection } from '../hud/Hud.js';
import { LeaderRegistry } from '../hud/leaders.js';
import { ShapesHud } from '../hud/panels.js';
import { createQualityStore, type QualityStore } from '../quality/store.js';
import { useReducedMotion } from '../story/scroll.js';
import { CameraRig } from '../three/CameraRig.js';
import { Molecule } from '../three/Molecule.js';
import { Stage } from '../three/Stage.js';
import { useThree } from '@react-three/fiber';

export interface ShapePickerProps {
  value?: ShapeId | null;
  onChange?: (s: ShapeId) => void;
  reducedMotion?: boolean;
  quality?: QualityStore;
  className?: string;
}

function Molecules({ leaders, value }: { leaders: LeaderRegistry; value: ShapeId | null }) {
  const size = useThree((s) => s.size);
  const portrait = size.width / Math.max(1, size.height) < 0.9;
  const pos = useMemo(
    () =>
      portrait
        ? { chain: new Vector3(0, 2.6, 0), ring: new Vector3(0, 0, 0), diamond: new Vector3(0, -2.6, 0) }
        : { chain: new Vector3(-3.3, 0, 0), ring: new Vector3(0, 0, 0), diamond: new Vector3(3.3, 0, 0) },
    [portrait],
  );
  const vis = useMemo(() => ({ chain: { value: 1 }, ring: { value: 1 }, diamond: { value: 1 } }), []);
  vis.chain.value = !value || value === 'chain' ? 1 : 0.55;
  vis.ring.value = !value || value === 'ring' ? 1 : 0.55;
  vis.diamond.value = !value || value === 'diamond' ? 1 : 0.55;
  const sc = portrait ? 0.62 : 0.8;
  return (
    <>
      <Molecule shape="chain" position={pos.chain} scale={sc} visibility={vis.chain} anchor={leaders.anchor('shape:chain')} />
      <Molecule shape="ring" position={pos.ring} scale={sc} visibility={vis.ring} anchor={leaders.anchor('shape:ring')} />
      <Molecule shape="diamond" position={pos.diamond} scale={sc} visibility={vis.diamond} anchor={leaders.anchor('shape:diamond')} />
    </>
  );
}

export function ShapePicker({ value = null, onChange, reducedMotion, quality, className }: ShapePickerProps) {
  const reduced = useReducedMotion(reducedMotion);
  const q = useMemo(() => quality ?? createQualityStore(), [quality]);
  const leaders = useMemo(() => new LeaderRegistry(), []);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  return (
    <div className={`carbon-picker${className ? ' ' + className : ''}`} data-testid="shape-picker">
      <div ref={setFrame} className="carbon-frame carbon-frame--picker">
        <Stage quality={q} leaders={leaders} reducedMotion={reduced} eventSource={frame} ariaLabel="Three molecule shapes: chain, ring, diamond">
          <CameraRig position={[0, 0.5, 9.5]} fit={1} />
          <Molecules leaders={leaders} value={value} />
        </Stage>
        <div className="carbon-hud">
          <HudLeaders registry={leaders} />
          <HudCorner at="tl">
            <HudSection>{COPY.shapes.head}</HudSection>
          </HudCorner>
        </div>
      </div>
      <div className="carbon-picker__hud">
        <ShapesHud value={value} onChange={onChange} />
      </div>
    </div>
  );
}
