/** Typed errors for @carbon/x. Messages never contain token material. */

export class XError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A required env var / dependency is missing. */
export class XConfigError extends XError {}

/** The launch has no connected X account (or its tokens were revoked). */
export class XNotConnectedError extends XError {
  constructor(public readonly launchId: string) {
    super(`No X account connected for launch ${launchId}`);
  }
}

/** OAuth callback rejected: state mismatch, expired flow, provider error. */
export class XAuthError extends XError {}

/** The OAuth token endpoint rejected a grant (status 400/401). `code` is X's OAuth error code. */
export class XTokenRejectedError extends XAuthError {
  constructor(public readonly status: number, public readonly code: string) {
    super(`X token endpoint rejected the request (${code})`);
  }
}

/** Post/reply refused because no approval hook is wired or it rejected. */
export class ApprovalRequiredError extends XError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
  }
}

/** Text fails X's weighted length rule (280, URLs = 23). */
export class PostTooLongError extends XError {
  constructor(public readonly weightedLength: number, public readonly max: number) {
    super(`Post is ${weightedLength} weighted characters; the limit is ${max}`);
  }
}

export class EmptyPostError extends XError {
  constructor() {
    super('Post text is empty');
  }
}

/** Identical text was already posted for this launch within the dedupe window. */
export class DuplicatePostError extends XError {
  constructor(public readonly existingPostId: string | null, public readonly postedAt: Date) {
    super(`Identical text was already posted for this launch at ${postedAt.toISOString()}`);
  }
}

/** Local bucket or X said no more requests until resetAt. */
export class RateLimitedError extends XError {
  constructor(
    public readonly endpoint: string,
    public readonly resetAt: Date,
    public readonly source: 'local' | 'headers' | '429',
  ) {
    super(`Rate limited on ${endpoint} until ${resetAt.toISOString()} (${source})`);
  }
}

/** Non-2xx from api.x.com. `detail` is X's problem detail, never request auth. */
export class XApiError extends XError {
  constructor(
    public readonly endpoint: string,
    public readonly status: number,
    public readonly title: string | undefined,
    public readonly detail: string | undefined,
    public readonly problemType: string | undefined,
  ) {
    super(`X API ${endpoint} failed with ${status}${title ? `: ${title}` : ''}${detail ? ` (${detail})` : ''}`);
  }
}
