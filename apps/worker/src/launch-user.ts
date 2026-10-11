/**
 * LaunchUser (@carbon/agents) answered by the launcher through the web API.
 * The web app verifies the launcher wallet's signature and writes the answer to
 * carbon_user_inputs; this side waits for it. The launch transaction is relayed
 * through carbon_tx_requests: the worker posts the unsigned tx, the browser's
 * wallet signs it, the web app checks it and hands it back.
 */
import { randomUUID } from 'node:crypto';
import type { LaunchUser, Revision } from '@carbon/agents';
import type { CarbonEvent, EventBus, SentinelReport } from '@carbon/core';
import type pg from 'pg';

export class LauncherTimeoutError extends Error {
  constructor(what: string) {
    super(`timed out waiting for the launcher: ${what}`);
    this.name = 'LauncherTimeoutError';
  }
}

export interface WebLaunchUserOptions {
  pool: pg.Pool;
  bus: EventBus;
  launchId: string;
  launcherWallet: string;
  pollMs?: number;
  /** How long to wait for a narrative choice or a revision. Default 24 h. */
  choiceTimeoutMs?: number;
  /** How long to wait for the wallet to sign the launch tx (blockhashes expire). Default 10 min. */
  txTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class WebLaunchUser implements LaunchUser {
  private readonly o: Required<Omit<WebLaunchUserOptions, 'pool' | 'bus' | 'launchId' | 'launcherWallet'>> & WebLaunchUserOptions;

  constructor(opts: WebLaunchUserOptions) {
    this.o = {
      pollMs: 1000,
      choiceTimeoutMs: 24 * 60 * 60_000,
      txTimeoutMs: 10 * 60_000,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...opts,
    };
  }

  /** Polls carbon_user_inputs for the answer to (kind, ref). */
  private async waitFor(kind: 'narrative' | 'revision' | 'signed_tx', ref: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const deadline = this.o.now() + timeoutMs;
    for (;;) {
      const r = await this.o.pool.query<{ payload: Record<string, unknown>; wallet: string }>(
        'SELECT payload, wallet FROM carbon_user_inputs WHERE launch_id = $1 AND kind = $2 AND ref = $3',
        [this.o.launchId, kind, ref],
      );
      const row = r.rows[0];
      // The web app verified the signature; the wallet must still be this launch's launcher.
      if (row && row.wallet === this.o.launcherWallet) return row.payload;
      if (this.o.now() > deadline) throw new LauncherTimeoutError(kind);
      await this.o.sleep(this.o.pollMs);
    }
  }

  async chooseNarrative(proposals: CarbonEvent<'scout.proposals'>): Promise<{ narrative: number; name: number }> {
    const p = await this.waitFor('narrative', proposals.id, this.o.choiceTimeoutMs);
    const narrative = Number(p.narrative);
    const name = Number(p.name);
    if (!Number.isSafeInteger(narrative) || !Number.isSafeInteger(name)) throw new Error('malformed narrative choice');
    return { narrative, name };
  }

  signLaunchTx = async (args: { txBase64: string; mint: string }): Promise<string> => {
    const requestId = randomUUID();
    await this.o.pool.query(
      `INSERT INTO carbon_tx_requests (request_id, launch_id, tx_base64, mint, payer, status, created_at) VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
      [requestId, this.o.launchId, args.txBase64, args.mint, this.o.launcherWallet, this.o.now()],
    );
    try {
      const p = await this.waitFor('signed_tx', requestId, this.o.txTimeoutMs);
      const signed = p.signedTx;
      if (typeof signed !== 'string' || !signed) throw new Error('malformed signed transaction');
      return signed;
    } catch (err) {
      await this.o.pool.query("UPDATE carbon_tx_requests SET status = 'expired' WHERE request_id = $1 AND status = 'pending'", [requestId]);
      throw err;
    }
  };

  async revise(report: SentinelReport, _draft: CarbonEvent<'forge.draft'>): Promise<Revision | null> {
    // The report being answered is the latest sentinel.score in the log (the runner asks right after scoring).
    const scores = (await this.o.bus.list(this.o.launchId, { kinds: ['sentinel.score'] })) as CarbonEvent<'sentinel.score'>[];
    const ev = [...scores].reverse().find((e) => e.payload.run === report.run && e.payload.score === report.score);
    if (!ev) throw new Error('sentinel.score for this report is not in the log');
    const p = await this.waitFor('revision', ev.id, this.o.choiceTimeoutMs);
    if (p.stop === true) return null;
    const rev: Revision = {};
    if (typeof p.name === 'string' && p.name) rev.name = p.name;
    if (typeof p.ticker === 'string' && p.ticker) rev.ticker = p.ticker;
    if (typeof p.note === 'string' && p.note) rev.note = p.note;
    if (p.newArt === true) rev.newArt = true;
    return rev;
  }
}
