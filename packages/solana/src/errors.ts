/**
 * Error types for @argon/solana. Every message is safe to log: nothing here
 * puts a key, seed or token into an error, and upstream text passes through
 * `redactSecrets()` as a second line of defence.
 */

export class ChainError extends Error {
  override readonly name: string = 'ChainError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(redactSecrets(message), options);
  }
}

/** RPC, pump.fun or Pinata is unreachable or answered with something unusable. Never replaced by a guess. */
export class ChainUnavailableError extends ChainError {
  override readonly name: string = 'ChainUnavailableError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(`chain unavailable: ${message}`, options);
  }
}

/** A required env value is missing or malformed. Names the variable, never its value. */
export class ChainConfigError extends ChainError {
  override readonly name: string = 'ChainConfigError';
}

/** Refusal to build a client for a network the owner has not enabled. */
export class NetworkGuardError extends ChainError {
  override readonly name: string = 'NetworkGuardError';
}

/** An instruction outside the Treasurer allowlist (any trade except $ARGON buybacks and the launch's own dev buy). */
export class TradeNotAllowedError extends ChainError {
  override readonly name: string = 'TradeNotAllowedError';
}

/** buildLaunchTx without a consumed approval / passing Sentinel score, or with arguments that do not match the launch. */
export class LaunchNotAllowedError extends ChainError {
  override readonly name: string = 'LaunchNotAllowedError';
}

export class KeyVaultError extends ChainError {
  override readonly name: string = 'KeyVaultError';
}

/** A ledger row is in a state the requested operation cannot proceed from. */
export class LedgerError extends ChainError {
  override readonly name: string = 'LedgerError';
}

/** The launch transaction does not fit one packet; configure ARGON_LOOKUP_TABLE. */
export class TxTooLargeError extends ChainError {
  override readonly name: string = 'TxTooLargeError';
}

/** A transaction landed with an error, or never landed before its blockhash expired. */
export class TxFailedError extends ChainError {
  override readonly name: string = 'TxFailedError';
}

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._-]{8,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs (Pinata)
  /api-key=[^&\s"']+/gi,
  /\b[0-9a-fA-F]{64}\b/g, // 32-byte hex keys
  /\b[0-9a-fA-F]{128}\b/g, // 64-byte hex secret keys
  /\b[1-9A-HJ-NP-Za-km-z]{85,90}\b/g, // base58 64-byte secret keys
  /\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/g, // JSON byte-array keypairs
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[redacted]');
  return out;
}

export function errorMessage(e: unknown): string {
  return redactSecrets(e instanceof Error ? e.message : String(e));
}
