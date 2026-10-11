'use client';
/**
 * <IsotopeChamber value onChange heavyAgent onHeavyAgentChange />
 * Reusable isotope picker (story ch06 and /launch). The nucleus re-forms as a
 * point cloud on a frosted pedestal; switching flows neutrons in/out. On C-13
 * the user drags the extra neutron onto a proton (or picks from the list).
 */
import { useMemo, useState } from 'react';
import type { AgentId, IsotopeId } from '@carbon/core/contracts';
import { COPY } from '../copy.js';
import { HudCorner, HudLeaders, HudSection } from '../hud/Hud.js';
import { LeaderRegistry } from '../hud/leaders.js';
import { ChamberHud } from '../hud/panels.js';
import { createDeviceQualityStore, type QualityStore } from '../quality/store.js';
import { useReducedMotion } from '../story/scroll.js';
import { CameraRig } from '../three/CameraRig.js';
import { ChamberObject } from '../three/Chamber.js';
import { Plain } from '../three/Plain.js';
import { Stage } from '../three/Stage.js';

export interface IsotopeChamberProps {
  value: IsotopeId;
  onChange: (v: IsotopeId) => void;
  heavyAgent: AgentId | null;
  onHeavyAgentChange: (a: AgentId | null) => void;
  reducedMotion?: boolean;
  quality?: QualityStore;
  className?: string;
}

export function IsotopeChamber({ value, onChange, heavyAgent, onHeavyAgentChange, reducedMotion, quality, className }: IsotopeChamberProps) {
  const reduced = useReducedMotion(reducedMotion);
  const q = useMemo(() => quality ?? createDeviceQualityStore(), [quality]);
  const leaders = useMemo(() => new LeaderRegistry(), []);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const plain = useMemo(() => ({ value: 0.35 }), []);
  const change = (v: IsotopeId) => {
    onChange(v);
    if (v !== 'C-13' && heavyAgent) onHeavyAgentChange(null);
  };
  return (
    <div className={`carbon-picker${className ? ' ' + className : ''}`} data-testid="isotope-chamber">
      <div ref={setFrame} className="carbon-frame carbon-frame--picker">
        <Stage quality={q} leaders={leaders} reducedMotion={reduced} eventSource={frame} ariaLabel="Isotope chamber: nucleus point cloud on a pedestal">
          <CameraRig position={[0, 2.4, 6.4]} target={[0, 0.2, 0]} fit={0.6} />
          <Plain visibility={plain} y={-1.05} />
          <ChamberObject isotope={value} heavyAgent={heavyAgent} onHeavyDrop={(a) => onHeavyAgentChange(a)} anchors={{ pedestal: leaders.anchor('pedestal'), extra: leaders.anchor('extra') }} />
        </Stage>
        <div className="carbon-hud">
          <HudLeaders registry={leaders} />
          <HudCorner at="tl">
            <HudSection>{COPY.chamber.head}</HudSection>
          </HudCorner>
          <HudCorner at="br">
            <div className="carbon-hud__label" ref={leaders.labelRef('pedestal')}>
              PEDESTAL
            </div>
          </HudCorner>
        </div>
      </div>
      <div className="carbon-picker__hud">
        <ChamberHud value={value} onChange={change} heavyAgent={heavyAgent} onHeavyAgentChange={onHeavyAgentChange} />
      </div>
    </div>
  );
}
