/**
 * View types shared by server pages, client views and the @carbon/visual seam.
 * Every field is read from logged events; null means "no data" and renders as
 * EMPTY_READOUT ("--.--"), never as a guess.
 */
import type { AgentId, IsotopeId, ShapeId } from '@carbon/core/contracts';

export type Network = 'devnet' | 'mainnet-beta';

/** One real launch, as the graphene sheet / OG card / embed see it. */
export interface LaunchSummary {
  launchId: string;
  /** null until launch.deployed. */
  ca: string | null;
  name: string | null;
  ticker: string | null;
  isotope: IsotopeId;
  shape: ShapeId;
  heavyAgent: AgentId | null;
  /** Latest Sentinel score, null before the first check. */
  score: number | null;
  threshold: number | null;
  network: Network | null;
  createdAt: number;
  deployedAt: number | null;
  /** Molecule state from foldMolecule over the launch's log. */
  state: string | null;
  logoUri: string | null;
  /** id of the launch.deployed event, null until deployed (ties the graphene crystal to a logged event). */
  deployEventId: string | null;
  /** true once a decay.collapsed event exists. */
  collapsed: boolean;
}

/** A recorded launch replayed in chapter 08 ("replaying $TICKER, <date>"). */
export interface ReplayData {
  launchId: string;
  ca: string;
  ticker: string;
  /** ISO date of launch.deployed. */
  date: string;
  /** The launch's real events, in seq order. */
  events: import('@carbon/core/contracts').CarbonEvent[];
}

export interface WalletRow {
  launchId: string;
  ca: string | null;
  ticker: string | null;
  address: string;
  mode: 'native' | 'wallet';
  network: Network | null;
  eventId: string;
}

export interface ReceiptRow {
  launchId: string;
  ca: string | null;
  ticker: string | null;
  network: Network | null;
  eventId: string;
  receipt: import('@carbon/core/contracts').SplitReceipt;
}
