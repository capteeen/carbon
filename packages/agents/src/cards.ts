import type { AgentId } from '@carbon/core';

/**
 * Pre-drafted approval card (the `draft` of approval.requested). Everything the
 * user needs to approve in one tap; every value is the real value that will be
 * used if they approve.
 */
export interface ApprovalCard {
  title: string;
  agent: AgentId;
  summary: string;
  /** Exact text that will be posted (posts/replies). */
  text?: string;
  details: Record<string, string>;
}
