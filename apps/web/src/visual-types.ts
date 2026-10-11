/**
 * Prop contracts between apps/web and @carbon/visual. apps/web passes exactly
 * these props; the 2D fallbacks in visual-fallback.tsx accept the same ones.
 */
import type { AgentId, Bond, CarbonEvent, EventPayloads, IsotopeId, SentinelReport, ShapeId } from '@carbon/core/contracts';
import type { ReactNode } from 'react';
import type { DecayView } from '@/lib/launch-view';
import type { LaunchSummary, ReplayData } from '@/lib/types';

export interface CarbonStoryProps {
  /** Latest real global events (any launch) and the seq they end at. Empty log → events: []. */
  live: { events: CarbonEvent[]; lastSeq: number };
  /** The most recent real deployed launch for chapter 08, or null when none exists yet. */
  replay: ReplayData | null;
  /** Every deployed launch, for the chapter 09 graphene. */
  launches: LaunchSummary[];
  onOpenAgent: (agent: AgentId) => void;
  onOpenLaunch: (ca: string) => void;
}

export interface IsotopeChamberProps {
  value: IsotopeId;
  onChange: (v: IsotopeId) => void;
  /** C-13 only: the agent the extra neutron strengthens. */
  heavyAgent: AgentId | null;
  onHeavyAgentChange: (a: AgentId | null) => void;
}

export interface ShapePickerProps {
  value: ShapeId;
  onChange: (v: ShapeId) => void;
}

export interface LaunchSceneProps {
  /** The launch's events in seq order (every visual maps to one of these by id). */
  events: CarbonEvent[];
  /** computeBonds(events, now): THE display bonds. */
  bonds: Bond[];
  /** Latest sentinel.score payload, null before the first check. */
  sentinel: SentinelReport | null;
  decay: DecayView;
  daughter: EventPayloads['daughter.launched'] | null;
}

export interface GrapheneSheetProps {
  launches: LaunchSummary[];
  onOpenLaunch: (ca: string) => void;
}

export interface EmbedPlayerProps {
  launch: LaunchSummary;
  events: CarbonEvent[];
  bonds: Bond[];
}

export interface HudReadoutProps {
  label: string;
  /** null → "--.--". */
  value: number | null;
  delta?: number | null;
  digits?: number;
}

export interface HudLabelProps {
  children: ReactNode;
  as?: 'span' | 'div' | 'h2' | 'h3';
}
