/**
 * The worker's X client. Herald and Keeper consume the approval themselves
 * (packages/agents/README.md); the hook here only CHECKS that a consumed
 * approval exists for that launch + action + id. It never consumes again.
 */
import type { ApprovalAction, XClient, XPost } from '@carbon/core';
import { createXClient } from '@carbon/x';
import type pg from 'pg';

export class ApprovalNotConsumedError extends Error {
  constructor(action: string) {
    super(`no consumed '${action}' approval for this launch and id`);
    this.name = 'ApprovalNotConsumedError';
  }
}

/** Resolves only if `approvalId` is a consumed approval for `launchId` and `action`. */
export function consumedApprovalCheck(pool: pg.Pool) {
  return async (launchId: string, approvalId: string, action: ApprovalAction): Promise<void> => {
    const r = await pool.query<{ status: string }>('SELECT status FROM approvals WHERE id = $1 AND launch_id = $2 AND action = $3', [approvalId, launchId, action]);
    if (r.rows[0]?.status !== 'consumed') throw new ApprovalNotConsumedError(action);
  };
}

/** X is not configured on this deployment: every call refuses and says why. Never returns made-up posts. */
class UnconfiguredX implements XClient {
  constructor(private readonly reason: string) {}
  private no(): Promise<never> {
    return Promise.reject(new Error(`X is not configured: ${this.reason}`));
  }
  searchRecent(): Promise<XPost[]> {
    return this.no();
  }
  trendsAvailability() {
    return { status: 'unavailable', reason: `X is not configured: ${this.reason}`, checkedAt: null };
  }
  async trends(): Promise<{ name: string; volume?: number }[]> {
    return [];
  }
  post(): Promise<{ id: string; url: string }> {
    return this.no();
  }
  reply(): Promise<{ id: string; url: string }> {
    return this.no();
  }
  mentions(): Promise<XPost[]> {
    return this.no();
  }
  async isConnected(): Promise<boolean> {
    return false;
  }
}

export function createWorkerX(pool: pg.Pool, env: NodeJS.ProcessEnv = process.env): XClient {
  try {
    return createXClient({ db: pool, assertApproval: consumedApprovalCheck(pool), env });
  } catch (err) {
    return new UnconfiguredX(err instanceof Error ? err.message : 'configuration error');
  }
}
