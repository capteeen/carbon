/**
 * Approvals over the event bus + Postgres `approvals` / `autopilot` / `killswitches`.
 *
 * - Every request, grant and reject is an event (approval.requested/granted/rejected).
 * - Launches can never be autopiloted (code + a DB CHECK constraint).
 * - gateEveryAction shapes (diamond) disable autopilot entirely.
 * - The kill switch turns autopilot off for the launch for good, and autopilot grants
 *   that are not yet consumed can no longer be consumed.
 * - consume() is atomic and single-use, and checks launch + action; each use is an
 *   approval.consumed event.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { AUTOPILOT_CLASSES, type AgentId, type ApprovalAction, type AutopilotClass } from './contracts.js';
import type { ApprovalDecision, Approvals, EventBus } from './ports.js';
import { configFromCreated, getLaunchCreated } from './launch.js';

export class ApprovalError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ApprovalError';
  }
}

/** Which autopilot class may auto-grant an action, if any. 'launch' and 'action' never. */
export function autopilotClassFor(action: ApprovalAction): AutopilotClass | null {
  switch (action) {
    case 'post':
      return 'posts';
    case 'reply':
      return 'replies';
    case 'buyback':
      return 'buybacks';
    default:
      return null;
  }
}

export const AUTOPILOT_ACTOR = 'autopilot';

export interface ApprovalsOptions {
  bus: EventBus;
  pool: pg.Pool;
  now?: () => number;
  /** While waiting for a decision, re-check the table this often (ms). Default 2000. */
  pollMs?: number;
}

interface ApprovalRow {
  id: string;
  launch_id: string;
  action: ApprovalAction;
  status: 'pending' | 'granted' | 'rejected' | 'consumed';
  via_autopilot: boolean;
  decided_by: string | null;
}

export class PgApprovals implements Approvals {
  private readonly bus: EventBus;
  private readonly pool: pg.Pool;
  private readonly now: () => number;
  private readonly pollMs: number;

  constructor(opts: ApprovalsOptions) {
    this.bus = opts.bus;
    this.pool = opts.pool;
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? 2000;
  }

  /** Opens an approval card (and auto-grants it if autopilot allows). Does not wait. */
  async open(
    launchId: string,
    action: ApprovalAction,
    draft: unknown,
    actor: AgentId,
  ): Promise<{ approvalId: string; autoGranted: boolean }> {
    const created = await getLaunchCreated(this.bus, launchId);
    const cfg = configFromCreated(created.payload);
    const approvalId = randomUUID();
    await this.pool.query(
      `INSERT INTO approvals (id, launch_id, action, actor, draft, requested_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [approvalId, launchId, action, actor, JSON.stringify(draft ?? null), this.now()],
    );
    const req = await this.bus.append({
      launchId,
      kind: 'approval.requested',
      actor,
      payload: { approvalId, action, draft: draft ?? null, expiresAt: null },
    });
    await this.pool.query('UPDATE approvals SET request_event_id = $2 WHERE id = $1', [approvalId, req.id]);

    const cls = autopilotClassFor(action);
    if (cls === null || cfg.gateEveryAction) return { approvalId, autoGranted: false };
    // Atomic: grant only if autopilot is on for this class and the kill switch is not engaged.
    const res = await this.pool.query(
      `UPDATE approvals SET status = 'granted', via_autopilot = TRUE, decided_by = $3, decided_at = $4
        WHERE id = $1 AND status = 'pending' AND action <> 'launch'
          AND EXISTS (SELECT 1 FROM autopilot a WHERE a.launch_id = $2 AND a.class = $5 AND a.enabled)
          AND NOT EXISTS (SELECT 1 FROM killswitches k WHERE k.launch_id = $2)`,
      [approvalId, launchId, AUTOPILOT_ACTOR, this.now(), cls],
    );
    if (res.rowCount !== 1) return { approvalId, autoGranted: false };
    const ev = await this.bus.append({
      launchId,
      kind: 'approval.granted',
      actor: 'system',
      payload: { approvalId, by: AUTOPILOT_ACTOR, viaAutopilot: true },
    });
    await this.pool.query('UPDATE approvals SET decision_event_id = $2 WHERE id = $1', [approvalId, ev.id]);
    return { approvalId, autoGranted: true };
  }

  async request(launchId: string, action: ApprovalAction, draft: unknown, actor: AgentId): Promise<ApprovalDecision> {
    const { approvalId } = await this.open(launchId, action, draft, actor);
    return this.wait(approvalId);
  }

  /** Resolves when the approval is decided (granted, rejected or already consumed). */
  async wait(approvalId: string, opts: { timeoutMs?: number } = {}): Promise<ApprovalDecision> {
    const row0 = await this.row(approvalId);
    if (!row0) throw new ApprovalError(`unknown approval ${approvalId}`);
    const deadline = opts.timeoutMs !== undefined ? Date.now() + opts.timeoutMs : Infinity;
    let wake: (() => void) | null = null;
    const unsubscribe = this.bus.subscribe(row0.launch_id, (e) => {
      if ((e.kind === 'approval.granted' || e.kind === 'approval.rejected') && (e.payload as { approvalId: string }).approvalId === approvalId) {
        wake?.();
      }
    });
    try {
      for (;;) {
        const r = await this.row(approvalId);
        if (r && r.status !== 'pending') {
          return {
            approvalId,
            granted: r.status === 'granted' || r.status === 'consumed',
            by: r.decided_by ?? '',
            viaAutopilot: r.via_autopilot,
          };
        }
        if (Date.now() > deadline) throw new ApprovalError(`approval ${approvalId} not decided in time`);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.pollMs);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        wake = null;
      }
    } finally {
      unsubscribe();
    }
  }

  async decide(approvalId: string, granted: boolean, by: string, reason?: string): Promise<void> {
    const r = await this.row(approvalId);
    if (!r) throw new ApprovalError(`unknown approval ${approvalId}`);
    const created = await getLaunchCreated(this.bus, r.launch_id);
    if (by !== created.payload.launcherWallet) throw new ApprovalError('only the launcher wallet can decide this approval');
    const res = await this.pool.query(
      `UPDATE approvals SET status = $2, decided_by = $3, decided_at = $4, reason = $5
        WHERE id = $1 AND status = 'pending'`,
      [approvalId, granted ? 'granted' : 'rejected', by, this.now(), reason ?? null],
    );
    if (res.rowCount !== 1) throw new ApprovalError(`approval ${approvalId} was already decided`);
    const ev = granted
      ? await this.bus.append({ launchId: r.launch_id, kind: 'approval.granted', actor: 'user', payload: { approvalId, by, viaAutopilot: false } })
      : await this.bus.append({
          launchId: r.launch_id,
          kind: 'approval.rejected',
          actor: 'user',
          payload: { approvalId, by, ...(reason !== undefined ? { reason } : {}) },
        });
    await this.pool.query('UPDATE approvals SET decision_event_id = $2 WHERE id = $1', [approvalId, ev.id]);
  }

  async consume(launchId: string, approvalId: string, action: ApprovalAction): Promise<void> {
    const res = await this.pool.query(
      `UPDATE approvals SET status = 'consumed', consumed_at = $4
        WHERE id = $1 AND launch_id = $2 AND action = $3 AND status = 'granted'
          AND NOT (action = 'launch' AND via_autopilot)
          AND (NOT via_autopilot OR NOT EXISTS (SELECT 1 FROM killswitches k WHERE k.launch_id = $2))`,
      [approvalId, launchId, action, this.now()],
    );
    if (res.rowCount === 1) {
      // Consumption is public: the log shows when an approval was used (AG-023).
      await this.bus.append({ launchId, kind: 'approval.consumed', actor: 'system', payload: { approvalId, action } });
      return;
    }
    const r = await this.row(approvalId);
    if (!r) throw new ApprovalError(`unknown approval ${approvalId}`);
    if (r.launch_id !== launchId) throw new ApprovalError('approval belongs to a different launch');
    if (r.action !== action) throw new ApprovalError(`approval is for '${r.action}', not '${action}'`);
    if (r.status === 'consumed') throw new ApprovalError('approval was already used');
    if (r.status === 'pending') throw new ApprovalError('approval is still pending');
    if (r.status === 'rejected') throw new ApprovalError('approval was rejected');
    throw new ApprovalError('autopilot grant revoked by kill switch');
  }

  async setAutopilot(launchId: string, cls: AutopilotClass, enabled: boolean, by: string): Promise<void> {
    if (!(AUTOPILOT_CLASSES as readonly string[]).includes(cls)) {
      throw new ApprovalError(`'${String(cls)}' cannot be autopiloted`);
    }
    const created = await getLaunchCreated(this.bus, launchId);
    if (by !== created.payload.launcherWallet) throw new ApprovalError('only the launcher wallet can change autopilot');
    if (enabled) {
      if (configFromCreated(created.payload).gateEveryAction) {
        throw new ApprovalError('this shape gates every action: autopilot is unavailable');
      }
      const k = await this.pool.query('SELECT 1 FROM killswitches WHERE launch_id = $1', [launchId]);
      if (k.rowCount) throw new ApprovalError('kill switch engaged: autopilot is off for this launch');
    }
    await this.pool.query(
      `INSERT INTO autopilot (launch_id, class, enabled, changed_by, changed_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (launch_id, class) DO UPDATE SET enabled = EXCLUDED.enabled, changed_by = EXCLUDED.changed_by, changed_at = EXCLUDED.changed_at`,
      [launchId, cls, enabled, by, this.now()],
    );
    await this.bus.append({ launchId, kind: 'autopilot.changed', actor: 'user', payload: { actionClass: cls, enabled, by } });
  }

  async killSwitch(launchId: string, by: string, reason?: string): Promise<void> {
    const created = await getLaunchCreated(this.bus, launchId);
    if (by !== created.payload.launcherWallet && by !== 'system') {
      throw new ApprovalError('only the launcher wallet or the system can engage the kill switch');
    }
    const client = await this.pool.connect();
    const disabled: AutopilotClass[] = [];
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO killswitches (launch_id, engaged_by, engaged_at, reason) VALUES ($1, $2, $3, $4) ON CONFLICT (launch_id) DO NOTHING`,
        [launchId, by, this.now(), reason ?? null],
      );
      const off = await client.query<{ class: AutopilotClass }>(
        `UPDATE autopilot SET enabled = FALSE, changed_by = $2, changed_at = $3 WHERE launch_id = $1 AND enabled RETURNING class`,
        [launchId, by, this.now()],
      );
      disabled.push(...off.rows.map((r) => r.class));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    await this.bus.append({
      launchId,
      kind: 'killswitch.engaged',
      actor: by === 'system' ? 'system' : 'user',
      payload: { by, ...(reason !== undefined ? { reason } : {}) },
    });
    for (const cls of disabled) {
      await this.bus.append({ launchId, kind: 'autopilot.changed', actor: 'system', payload: { actionClass: cls, enabled: false, by } });
    }
  }

  /** Current autopilot switches for the launch (all false when killed or gated). */
  async autopilotState(launchId: string): Promise<Record<AutopilotClass, boolean> & { killed: boolean }> {
    const rows = await this.pool.query<{ class: AutopilotClass; enabled: boolean }>(
      'SELECT class, enabled FROM autopilot WHERE launch_id = $1',
      [launchId],
    );
    const k = await this.pool.query('SELECT 1 FROM killswitches WHERE launch_id = $1', [launchId]);
    const out = { posts: false, replies: false, buybacks: false, killed: (k.rowCount ?? 0) > 0 };
    if (!out.killed) for (const r of rows.rows) out[r.class] = r.enabled;
    return out;
  }

  private async row(approvalId: string): Promise<ApprovalRow | null> {
    const res = await this.pool.query<ApprovalRow>(
      'SELECT id, launch_id, action, status, via_autopilot, decided_by FROM approvals WHERE id = $1',
      [approvalId],
    );
    return res.rows[0] ?? null;
  }
}
