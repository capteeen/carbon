/**
 * The worker's X client. Herald and Keeper consume the approval themselves
 * (packages/agents/README.md). The hook here admits exactly ONE network post per
 * consumed approval, and only with the approved text: it checks the approval is
 * consumed for that launch + action, that the text hash equals the hash of the
 * approved card's text, and records the use atomically (carbon_x_approval_uses,
 * PRIMARY KEY approval_id). A second post under the same approval is refused.
 *
 * X tokens are used only when bound to the launch's launcher wallet (createXClient
 * reads launch.created from the event log): see AG-004.
 */
import type { ApprovalAction, XClient, XPost } from '@argon/core';
import { createXClient, textHash } from '@argon/x';
import type pg from 'pg';

export class ApprovalNotConsumedError extends Error {
  constructor(action: string) {
    super(`no consumed '${action}' approval for this launch and id`);
    this.name = 'ApprovalNotConsumedError';
  }
}

export class ApprovalAlreadyUsedError extends Error {
  constructor() {
    super('this approval already authorised a post; one approval, one post');
    this.name = 'ApprovalAlreadyUsedError';
  }
}

export class ApprovedTextMismatchError extends Error {
  constructor() {
    super('the text differs from the text that was approved');
    this.name = 'ApprovedTextMismatchError';
  }
}

/** The text on an approval card (`draft.text`), or null when the card carries none. */
function approvedText(draft: unknown): string | null {
  if (draft && typeof draft === 'object' && typeof (draft as { text?: unknown }).text === 'string') return (draft as { text: string }).text;
  return null;
}

/**
 * Resolves only if `approvalId` is a consumed approval for `launchId` and `action`,
 * `textSha256` is the hash of the approved card's text, and the approval has not
 * authorised a post before. Records the use in the same statement that checks it.
 */
export function consumedApprovalCheck(pool: pg.Pool, now: () => number = Date.now) {
  return async (launchId: string, approvalId: string, action: Extract<ApprovalAction, 'post' | 'reply'>, textSha256: string): Promise<void> => {
    const r = await pool.query<{ status: string; draft: unknown }>('SELECT status, draft FROM approvals WHERE id = $1 AND launch_id = $2 AND action = $3', [approvalId, launchId, action]);
    const row = r.rows[0];
    if (row?.status !== 'consumed') throw new ApprovalNotConsumedError(action);
    const text = approvedText(row.draft);
    if (text === null || !/^[0-9a-f]{64}$/.test(textSha256) || textHash(text) !== textSha256) throw new ApprovedTextMismatchError();
    const ins = await pool.query(
      `INSERT INTO carbon_x_approval_uses (approval_id, launch_id, action, text_sha256, used_at)
       SELECT a.id, a.launch_id, a.action, $4, $5 FROM approvals a
        WHERE a.id = $1 AND a.launch_id = $2 AND a.action = $3 AND a.status = 'consumed'
       ON CONFLICT (approval_id) DO NOTHING`,
      [approvalId, launchId, action, textSha256, now()],
    );
    if (ins.rowCount !== 1) throw new ApprovalAlreadyUsedError();
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
