/**
 * Launcher-wallet signatures. Every user decision (create a launch, choose a
 * narrative, revise, approve/reject, autopilot, kill switch, X connect) is a
 * Solana wallet `signMessage` over one of these exact texts. The server rebuilds
 * the text from the request fields and verifies the ed25519 signature against
 * the launch's launcherWallet (from its launch.created event).
 *
 * Browser-safe (no node: imports).
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

/** Signed requests with a timestamp must arrive within this window. */
export const SIGNATURE_MAX_AGE_MS = 5 * 60_000;

function message(action: string, fields: [string, string][]): string {
  return ['CARBON // ' + action, ...fields.map(([k, v]) => `${k}: ${v}`)].join('\n');
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ');

export const messages = {
  createLaunch(p: { launchId: string; line: string; isotope: string; shape: string; heavyAgent: string | null; issuedAt: number }): string {
    return message('CREATE_LAUNCH', [
      ['launch', p.launchId],
      ['line', oneLine(p.line)],
      ['isotope', p.isotope],
      ['shape', p.shape],
      ['heavy', p.heavyAgent ?? 'none'],
      ['issued', String(p.issuedAt)],
    ]);
  },
  /** The approval id is in the message, so a signature authorises exactly one decision on one card. */
  approval(p: { approvalId: string; decision: 'grant' | 'reject' }): string {
    return message('APPROVAL', [
      ['approval', p.approvalId],
      ['decision', p.decision],
    ]);
  },
  chooseNarrative(p: { launchId: string; proposalsEventId: string; narrative: number; name: number }): string {
    return message('CHOOSE_NARRATIVE', [
      ['launch', p.launchId],
      ['proposals', p.proposalsEventId],
      ['narrative', String(p.narrative)],
      ['name', String(p.name)],
    ]);
  },
  revise(p: { launchId: string; scoreEventId: string; stop: boolean; name: string; ticker: string; note: string; newArt: boolean }): string {
    return message('REVISE', [
      ['launch', p.launchId],
      ['score', p.scoreEventId],
      ['stop', p.stop ? 'yes' : 'no'],
      ['name', oneLine(p.name)],
      ['ticker', oneLine(p.ticker)],
      ['note', oneLine(p.note)],
      ['new-art', p.newArt ? 'yes' : 'no'],
    ]);
  },
  autopilot(p: { launchId: string; actionClass: string; enabled: boolean; issuedAt: number }): string {
    return message('AUTOPILOT', [
      ['launch', p.launchId],
      ['class', p.actionClass],
      ['enabled', p.enabled ? 'yes' : 'no'],
      ['issued', String(p.issuedAt)],
    ]);
  },
  killSwitch(p: { launchId: string; issuedAt: number }): string {
    return message('KILL_SWITCH', [
      ['launch', p.launchId],
      ['issued', String(p.issuedAt)],
    ]);
  },
};

export function encodeSignature(sig: Uint8Array): string {
  return bs58.encode(sig);
}

/** Verifies an ed25519 signMessage signature (base58) by `wallet` (base58 public key) over `text`. */
export function verifyWalletSignature(wallet: string, text: string, signatureB58: string): boolean {
  try {
    const pk = bs58.decode(wallet);
    const sig = bs58.decode(signatureB58);
    if (pk.length !== 32 || sig.length !== 64) return false;
    return ed25519.verify(sig, new TextEncoder().encode(text), pk);
  } catch {
    return false;
  }
}

export function isFresh(issuedAt: number, now: number = Date.now()): boolean {
  return Number.isSafeInteger(issuedAt) && Math.abs(now - issuedAt) <= SIGNATURE_MAX_AGE_MS;
}

/** Base58 Solana address shape (32-byte key). */
export function isWalletAddress(s: unknown): s is string {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}
