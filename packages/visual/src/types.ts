/**
 * Visual view-model types. These are local to @carbon/visual and are proposed
 * for packages/core/src/contracts.ts (see README "Proposed contract changes").
 * Every field is derived from logged CarbonEvents (by id) or from core's Bond[];
 * nothing here is ever filled with sample values.
 */
import type { AgentId, Bond, BondOrder, CarbonEvent, IsotopeId, PairKey, SentinelReport, ShapeId, SplitReceipt } from '@carbon/core/contracts';

/** A real hand-off flash on a bond: `hash` is the hand-off event's id (sha256 hex). */
export interface BondFlash {
  pairKey: PairKey;
  hash: string;
  /** Event ts (ms). */
  at: number;
}

export interface AgentLiveStats {
  /**
   * Sum of bond orders this agent holds right now in `LiveStats.molecule`, from
   * core's Bond[] recomputed over that launch's FULL log (0..4). null when that
   * log is not loaded (rendered "--.--", never a guess from a partial window).
   */
  bondOrders: number | null;
  /** Hand-offs per minute involving this agent over the 60 s bond window. */
  load: number;
  /** Change vs the previous 60 s window. */
  loadDelta: number;
}

/** Live agent stats for the story HUD. Absent agent → "--.--". */
export interface LiveStats {
  /** ms timestamp the stats were evaluated at (display time). */
  asOf: number;
  /**
   * The one molecule (launch) whose bonds the BONDS readouts show: the launch
   * that most recently handed off. Bonds are per molecule, so a count never
   * exceeds valence. null → no bonds readout ("--.--").
   */
  molecule?: LiveMolecule | null;
  agents: Partial<Record<AgentId, AgentLiveStats>>;
  /** Most recent real hand-offs (newest last); ride the seams in chapter 05 and fire sound. */
  recentHandoffs: BondFlash[];
}

/** The launch named next to the home BONDS readout. */
export interface LiveMolecule {
  launchId: string;
  /** Latest forge.draft ticker in that launch's log, if any. */
  ticker: string | null;
}

/** A real recorded launch, replayed in chapter 08. Build with buildReplay(events). */
export interface LaunchReplay {
  launchId: string;
  ticker: string;
  name: string;
  ca: string;
  deployedAt: number;
  /** id of the launch.deployed event. */
  deployEventId: string;
  isotope: IsotopeId;
  shape: ShapeId;
  heavyAgent: AgentId | null;
  network: 'devnet' | 'mainnet-beta';
  /** Final Sentinel report before deploy, if logged. */
  score: SentinelReport | null;
  /** Recorded hand-offs in seq order. */
  handoffs: CarbonEvent<'handoff'>[];
  /**
   * Bonds at deploy time as recomputed by core (Handoffs.bonds(launchId, deployedAt)).
   * The replay draws bond orders ONLY from this; it never recomputes them.
   */
  bondsAtDeploy?: Bond[];
}

/** One real launch on the live graphene sheet. Build with launchSummaryFromEvents(events). */
export interface LaunchSummary {
  launchId: string;
  ca: string;
  ticker: string;
  name: string;
  isotope: IsotopeId;
  shape: ShapeId;
  heavyAgent: AgentId | null;
  deployedAt: number;
  network: 'devnet' | 'mainnet-beta';
  /** id of the launch.deployed event (proves the crystal maps to a logged event). */
  deployEventId: string;
  /** true once a decay.collapsed event exists for it. */
  collapsed: boolean;
}

/** Decay status for a launch page. Supplied by the app from the config table + chain/trade data. */
export interface DecayView {
  kind: 'quiet' | 'clock';
  /** ms when the current clock started (deploy for C-14, last trade for C-11). */
  startedAt: number;
  /** ms when collapse happens if nothing changes. */
  deadline: number;
  /** id of the decay.collapsed event once it exists. */
  collapsedEventId: string | null;
}

export interface DaughterView {
  /** id of the daughter.launched event. */
  eventId: string;
  daughterCa: string;
  ticker?: string;
}

export interface ThinkingItem {
  eventId: string;
  agent: AgentId;
  text: string;
  ts: number;
}

export type ReceiptItem = SplitReceipt;
export type { BondOrder };
