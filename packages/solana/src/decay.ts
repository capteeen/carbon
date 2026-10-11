/**
 * Decay watcher for C-11 and C-14.
 *
 * Carbon's collapse is DETERMINISTIC, from the one config table:
 *   C-11 { kind: 'quiet', quietSec: 1200 }    collapseAt = lastTradeAt + 20 min
 *   C-14 { kind: 'clock', clockSec: 604800 }  collapseAt = bornAt + 7 days (trades do not reset it)
 * @qsd/protocol's decay is a quantum-measurement model (collapse resolved by a
 * QRNG draw with probability = decayProgress), so its state machine
 * (applyBuy / measurementInputs / applyMeasurement / nextAutoMeasureAt) is NOT
 * used. From @qsd/protocol this module uses exactly:
 *   - daughterName(name, generation)   the daughter's name, "NAME·2"
 *   - computeAllocation(input)         the airdrop table + merkle root over the
 *                                      HolderSnapshot rows (measurements: [],
 *                                      so the weight is duration + quiet-period)
 *   - allocationProof / verifyAllocationProof  per-wallet proofs of the table
 *   - HolderSnapshot / AllocationTable types
 *   - decayProgressFor(quietSec, halfLifeSec)  ONLY for the illustrative
 *     half-life curve on the C-11 readout (T = 1224 s, real C-11's 20.4 min);
 *     assertHalfLife accepts any positive integer, so it validates. It never
 *     decides the collapse. C-14 has no half-life readout (5,730 years is the
 *     story, not the coin).
 *
 * Steps are persisted in `sol_decay`; each tick resumes where the last one
 * stopped. The watcher returns event data; the calling agent appends it and
 * acknowledges the snapshot event so decay.collapsed can reference its id.
 */
import type { DecayRule, EventPayloads } from '@carbon/core';
import { allocationProof, computeAllocation, daughterName, decayProgressFor, verifyAllocationProof, type AllocationTable, type HolderSnapshot } from '@qsd/protocol';
import type { CarbonChainClient, EventData } from './client.js';
import type { Db } from './db.js';
import { withLock } from './db.js';
import { errorMessage, LedgerError } from './errors.js';

/** Real carbon-11 half-life (≈ 20.4 min), for the illustrative curve only. */
export const C11_HALF_LIFE_SEC = 1224;

/** Unix ms at which the coin collapses, or null for stable isotopes. */
export function collapseAtMs(rule: DecayRule, bornAtMs: number, lastTradeAtMs: number | null): number | null {
  if (rule.kind === 'none') return null;
  if (rule.kind === 'clock') return bornAtMs + rule.clockSec * 1000;
  return Math.max(bornAtMs, lastTradeAtMs ?? bornAtMs) + rule.quietSec * 1000;
}

export interface DecayReadout {
  collapseAt: number | null;
  remainingMs: number | null;
  /** Fraction of the deterministic window elapsed, 0..1 (1 = collapsed). */
  progress: number | null;
  /** C-11 only: 1 − 2^(−quiet/1224 s) from @qsd/protocol decayProgressFor. Illustration, not the rule. */
  halfLifeCurve: number | null;
}

export function decayReadout(rule: DecayRule, bornAtMs: number, lastTradeAtMs: number | null, nowMs: number): DecayReadout {
  const at = collapseAtMs(rule, bornAtMs, lastTradeAtMs);
  if (at === null || rule.kind === 'none') return { collapseAt: null, remainingMs: null, progress: null, halfLifeCurve: null };
  const windowMs = (rule.kind === 'quiet' ? rule.quietSec : rule.clockSec) * 1000;
  const remainingMs = Math.max(0, at - nowMs);
  const progress = Math.min(1, Math.max(0, 1 - remainingMs / windowMs));
  const halfLifeCurve = rule.kind === 'quiet' ? decayProgressFor(Math.max(0, Math.floor((nowMs - (at - windowMs)) / 1000)), C11_HALF_LIFE_SEC) : null;
  return { collapseAt: at, remainingMs, progress, halfLifeCurve };
}

/** Readout once the coin has collapsed at `at` (unix ms). */
export function collapsedReadout(at: number): DecayReadout {
  return { collapseAt: at, remainingMs: 0, progress: 1, halfLifeCurve: null };
}

export interface DecayTarget {
  launchId: string;
  ca: string;
  rule: DecayRule;
  bornAtMs: number;
  name: string;
  symbol: string;
  description: string;
  imageUri: string;
  launcherWallet: string;
  /** Mother generation (1 for a first launch). */
  generation: number;
  /** The mother's config-table devBuySol; the daughter's own dev buy is capped by it. */
  devBuySol: number;
}

type DecayState = 'watching' | 'snapshotted' | 'daughter_sent' | 'daughter_confirmed' | 'allocated' | 'done';

interface DecayRow {
  state: DecayState;
  collapse_at: string | null;
  quiet_period_start: string | null;
  snapshot: SerializedHolder[] | null;
  snapshot_slot: string | null;
  daughter_launch_id: string | null;
  daughter_mint: string | null;
  daughter_tx_sig: string | null;
  allocation: SerializedAllocation | null;
  merkle_root: string | null;
  emitted: Record<string, string>;
}

interface SerializedHolder {
  wallet: string;
  balance: string;
  firstAcquiredAt: number;
  heldThroughMeasurementIds: string[];
  heldThroughQuietPeriod: boolean;
}
interface SerializedAllocation {
  merkleRoot: string;
  totalUnits: string;
  dustUnits: string;
  entries: { wallet: string; units: string; leaf: string }[];
}

const toHolder = (h: SerializedHolder): HolderSnapshot => ({ ...h, balance: BigInt(h.balance) });
const fromHolder = (h: HolderSnapshot): SerializedHolder => ({ ...h, balance: h.balance.toString() });

export interface DecayTickResult {
  state: DecayState | 'stable';
  readout: DecayReadout;
  /** Event data for the caller to append, in order. */
  events: EventData<keyof EventPayloads>[];
  /** Set while the watcher waits for the caller to append holders.snapshot and call ackSnapshot. */
  awaitingSnapshotAck?: boolean;
  /** Set when this tick's chain work failed; the state is unchanged and the next tick resumes. */
  error?: string;
}

export interface DecayDeps {
  client: CarbonChainClient;
  db: Db;
  now?: () => number;
}

export class DecayWatcher {
  private readonly now: () => number;
  constructor(private readonly deps: DecayDeps) {
    this.now = deps.now ?? Date.now;
  }

  private async row(launchId: string): Promise<DecayRow | null> {
    const r = await this.deps.db.query<DecayRow>(
      'SELECT state, collapse_at::text, quiet_period_start::text, snapshot, snapshot_slot::text, daughter_launch_id, daughter_mint, daughter_tx_sig, allocation, merkle_root, emitted FROM sol_decay WHERE launch_id=$1',
      [launchId],
    );
    return r.rows[0] ?? null;
  }

  /** The caller appended holders.snapshot as event `eventId`. */
  async ackSnapshot(launchId: string, eventId: string): Promise<void> {
    await this.deps.db.query(`UPDATE sol_decay SET emitted = emitted || jsonb_build_object('snapshot', $2::text), updated_at=now() WHERE launch_id=$1`, [launchId, eventId]);
  }

  /** The caller appended the event for `key` (e.g. 'collapsed', 'daughter', 'airdrop:<wallet>'). */
  async ack(launchId: string, key: string, eventId: string): Promise<void> {
    await this.deps.db.query(`UPDATE sol_decay SET emitted = emitted || jsonb_build_object($2::text, $3::text), updated_at=now() WHERE launch_id=$1`, [launchId, key, eventId]);
  }

  /** One step of the watcher for one coin. Safe to call repeatedly and after a crash. */
  async tick(t: DecayTarget): Promise<DecayTickResult> {
    if (t.rule.kind === 'none') return { state: 'stable', readout: decayReadout(t.rule, t.bornAtMs, null, this.now()), events: [] };
    return withLock(this.deps.db, `sol:decay:${t.launchId}`, async () => {
      try {
        return await this.step(t);
      } catch (e) {
        // Chain work failed part-way (RPC down, tx expired...). Nothing is lost: the row
        // keeps its state and the next tick resumes. Events already justified are still offered.
        const row = await this.row(t.launchId);
        if (!row) throw e;
        // Without a fresh last-trade read the watching readout is unknown: show nothing rather than a guess.
        const readout: DecayReadout = row.collapse_at
          ? collapsedReadout(Number(row.collapse_at))
          : { collapseAt: null, remainingMs: null, progress: null, halfLifeCurve: null };
        return { state: row.state, readout, events: await this.unacked(t, row), error: errorMessage(e) };
      }
    });
  }

  private async step(t: DecayTarget): Promise<DecayTickResult> {
    // The clock starts at the create transaction's block time when Carbon has it on record
    // (AG-025); the caller's value (the launch.deployed event time) is only the fallback.
    const bornAtMs = (await this.deps.client.launchBornAtMs(t.launchId)) ?? t.bornAtMs;
    const { client, db } = this.deps;
    await db.query(`INSERT INTO sol_decay (launch_id, state, rule) VALUES ($1,'watching',$2) ON CONFLICT (launch_id) DO NOTHING`, [t.launchId, JSON.stringify(t.rule)]);
    let row = (await this.row(t.launchId))!;
    const events: EventData<keyof EventPayloads>[] = [];
    // A step that throws part-way still leaves earlier events unacked; they are re-offered by unacked().

    if (row.state === 'watching') {
      const lastTrade = t.rule.kind === 'quiet' ? await client.lastTradeAt(t.ca) : null;
      const now = this.now();
      const readout = decayReadout(t.rule, bornAtMs, lastTrade, now);
      if (readout.collapseAt === null || now < readout.collapseAt) return { state: 'watching', readout, events };
      const collapseSec = Math.floor(readout.collapseAt / 1000);
      // Quiet period start: the last trade (C-11), or for C-14 the last trade before the clock ran out.
      const lastTradeForQuiet = t.rule.kind === 'quiet' ? lastTrade : await client.lastTradeAt(t.ca);
      const quietStart = Math.min(collapseSec, Math.floor(Math.max(bornAtMs, lastTradeForQuiet ?? bornAtMs) / 1000));
      const snap = await client.holderSnapshot({ mint: t.ca, collapseAt: collapseSec, quietPeriodStart: quietStart, excludeOwners: [client.crankAddress()] });
      await db.query(
        `UPDATE sol_decay SET state='snapshotted', collapse_at=$2, quiet_period_start=$3, snapshot=$4::jsonb, snapshot_slot=$5, updated_at=now() WHERE launch_id=$1 AND state='watching'`,
        [t.launchId, readout.collapseAt, quietStart, JSON.stringify(snap.holders.map(fromHolder)), snap.slot],
      );
      row = (await this.row(t.launchId))!;
    }

    const collapseAt = Number(row.collapse_at);
    const readout = collapsedReadout(collapseAt);
    const holders = (row.snapshot ?? []).map(toHolder);

    if (row.state === 'snapshotted') {
      if (!row.emitted['snapshot']) {
        events.push({ kind: 'holders.snapshot', payload: { slot: Number(row.snapshot_slot), holderCount: holders.length } });
        return { state: 'snapshotted', readout, events, awaitingSnapshotAck: true };
      }
      if (holders.length === 0) {
        // Nobody to airdrop to: no daughter is launched (there is nothing to allocate).
        await db.query(`UPDATE sol_decay SET state='done', updated_at=now() WHERE launch_id=$1`, [t.launchId]);
        return { state: 'done', readout, events: await this.unacked(t, (await this.row(t.launchId))!) };
      }
      const daughterLaunchId = `${t.launchId}:daughter`;
      await db.query(`UPDATE sol_decay SET state='daughter_sent', daughter_launch_id=$2, updated_at=now() WHERE launch_id=$1 AND state='snapshotted'`, [t.launchId, daughterLaunchId]);
      row = (await this.row(t.launchId))!;
    }

    let allocation: AllocationTable | null = null;
    if (row.state === 'daughter_sent' || row.state === 'daughter_confirmed') {
      const d = await client.launchDaughter({
        daughterLaunchId: row.daughter_launch_id!,
        name: daughterName(t.name, t.generation + 1),
        symbol: t.symbol,
        description: t.description,
        imageUri: t.imageUri,
        launcherWallet: t.launcherWallet,
        devBuySol: t.devBuySol,
      });
      allocation = computeAllocation({
        snapshot: holders,
        measurements: [],
        bornAt: Math.floor(bornAtMs / 1000),
        collapseAt: Math.floor(collapseAt / 1000),
        quietPeriodStart: Number(row.quiet_period_start),
        totalDaughterUnits: d.unitsReceived,
      });
      const ser: SerializedAllocation = {
        merkleRoot: allocation.merkleRoot,
        totalUnits: allocation.totalUnits.toString(),
        dustUnits: allocation.dustUnits.toString(),
        entries: allocation.entries.map((e) => ({ wallet: e.wallet, units: e.units.toString(), leaf: e.leaf })),
      };
      await db.query(
        `UPDATE sol_decay SET state='allocated', daughter_mint=$2, daughter_tx_sig=$3, total_units=$4, allocation=$5::jsonb, merkle_root=$6, updated_at=now() WHERE launch_id=$1 AND state IN ('daughter_sent','daughter_confirmed')`,
        [t.launchId, d.mint, d.txSig, d.unitsReceived.toString(), JSON.stringify(ser), allocation.merkleRoot],
      );
      row = (await this.row(t.launchId))!;
    }

    if (row.state === 'allocated') {
      for (const e of row.allocation!.entries) {
        const units = BigInt(e.units);
        if (units === 0n) continue;
        await client.airdropUnits(t.launchId, row.daughter_mint!, e.wallet, units);
      }
      await db.query(`UPDATE sol_decay SET state='done', updated_at=now() WHERE launch_id=$1 AND state='allocated'`, [t.launchId]);
      row = (await this.row(t.launchId))!;
    }
    if (row.state === 'done') return { state: 'done', readout, events: await this.unacked(t, row) };
    throw new LedgerError(`decay row for ${t.launchId} in unexpected state ${row.state}`);
  }

  /**
   * Every event the chain work so far justifies that the caller has not acked:
   * decay.collapsed, daughter.launched, and one airdrop.sent per confirmed row.
   */
  private async unacked(t: DecayTarget, row: DecayRow): Promise<EventData<keyof EventPayloads>[]> {
    const out: EventData<keyof EventPayloads>[] = [];
    const snapshotId = row.emitted['snapshot'];
    if (!snapshotId) return out;
    if (!row.emitted['collapsed']) {
      out.push({ kind: 'decay.collapsed', payload: { at: Number(row.collapse_at), reason: t.rule.kind === 'quiet' ? 'quiet' : 'clock', snapshotEventId: snapshotId } });
    }
    if (row.daughter_mint && row.daughter_tx_sig && row.merkle_root && !row.emitted['daughter']) {
      out.push({ kind: 'daughter.launched', payload: { motherCa: t.ca, daughterCa: row.daughter_mint, txSig: row.daughter_tx_sig, allocationRoot: row.merkle_root } });
    }
    if (row.daughter_mint) {
      const r = await this.deps.db.query<{ wallet: string; units: string; tx_sig: string }>(
        `SELECT wallet, units::text, tx_sig FROM sol_airdrops WHERE daughter_mint=$1 AND state='confirmed' ORDER BY wallet`,
        [row.daughter_mint],
      );
      for (const a of r.rows) {
        if (!row.emitted[`airdrop:${a.wallet}`]) out.push({ kind: 'airdrop.sent', payload: { daughterCa: row.daughter_mint, wallet: a.wallet, units: a.units, txSig: a.tx_sig } });
      }
    }
    return out;
  }

  /** Allocation proof for one wallet, checked against the stored root before it is returned. */
  async proofFor(launchId: string, wallet: string): Promise<{ units: string; proof: { index: number; path: string[] }; root: string } | null> {
    const row = await this.row(launchId);
    if (!row?.allocation) return null;
    const table: AllocationTable = {
      version: 'qsd-allocation/v1',
      entries: row.allocation.entries.map((e) => ({ wallet: e.wallet, units: BigInt(e.units), leaf: e.leaf, bagUnits: 0n, bagFractionPpb: 0, weightBps: 0, sharePpb: 0 })),
      totalUnits: BigInt(row.allocation.totalUnits),
      allocatedUnits: row.allocation.entries.reduce((s, e) => s + BigInt(e.units), 0n),
      dustUnits: BigInt(row.allocation.dustUnits),
      merkleRoot: row.allocation.merkleRoot,
      leafCount: 0,
    };
    const entry = table.entries.find((e) => e.wallet === wallet);
    if (!entry) return null;
    const proof = allocationProof(table, wallet);
    if (!verifyAllocationProof(table.merkleRoot, { wallet, units: entry.units }, proof)) throw new LedgerError('stored allocation does not verify against its root');
    return { units: entry.units.toString(), proof, root: table.merkleRoot };
  }
}
