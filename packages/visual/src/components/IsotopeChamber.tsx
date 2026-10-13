'use client';
/**
 * <IsotopeChamber value onChange heavyAgent onHeavyAgentChange />
 * Reusable isotope picker (story ch06 and /launch). The nucleus re-forms as a
 * point cloud on a frosted pedestal; switching flows neutrons in/out. On Ar-40
 * the user drags the extra neutron onto a proton (or picks from the list).
 */
import { useMemo, useState } from 'react';
import type { AgentId, IsotopeId } from '@argon/core/contracts';
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
    if (v !== 'Ar-40' && heavyAgent) onHeavyAgentChange(null);
  };
  return (
    <div className={`argon-picker${className ? ' ' + className : ''}`} data-testid="isotope-chamber">
      <div ref={setFrame} className="argon-frame argon-frame--picker argon-frame--chamber-picker">
        <Stage quality={q} leaders={leaders} reducedMotion={reduced} eventSource={frame} ariaLabel="Isotope chamber: nucleus point cloud on a pedestal">
          <CameraRig position={[0, 3.7, 7.05]} target={[0, 0.85, 0]} fit={0.6} />
          <Plain visibility={plain} y={-1.05} />
          <ChamberObject isotope={value} heavyAgent={heavyAgent} onHeavyDrop={(a) => onHeavyAgentChange(a)} anchors={{ pedestal: leaders.anchor('pedestal'), extra: leaders.anchor('extra') }} />
        </Stage>
        <div className="argon-hud">
          <HudLeaders registry={leaders} />
          <HudCorner at="tl">
            <HudSection>{COPY.chamber.head}</HudSection>
          </HudCorner>
          <HudCorner at="br">
            <div className="argon-hud__label" ref={leaders.labelRef('pedestal')}>
              PEDESTAL
            </div>
          </HudCorner>
        </div>
      </div>
      <div className="argon-picker__hud">
        <ChamberHud value={value} onChange={change} heavyAgent={heavyAgent} onHeavyAgentChange={onHeavyAgentChange} />
      </div>
    </div>
  );
}
