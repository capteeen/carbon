/**
 * Checks a wallet-signed launch transaction before it is relayed to the worker:
 * the message must be byte-identical to the one the chain client built (so the
 * browser cannot swap the transaction), and the launcher wallet's signature on
 * it must verify.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';

export type SignedTxCheck = { ok: true } | { ok: false; reason: string };

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export function checkSignedLaunchTx(unsignedB64: string, signedB64: string, launcherWallet: string): SignedTxCheck {
  let unsigned: VersionedTransaction;
  let signed: VersionedTransaction;
  try {
    unsigned = VersionedTransaction.deserialize(Buffer.from(unsignedB64, 'base64'));
    signed = VersionedTransaction.deserialize(Buffer.from(signedB64, 'base64'));
  } catch {
    return { ok: false, reason: 'not a Solana transaction' };
  }
  const msg = signed.message.serialize();
  if (!bytesEqual(msg, unsigned.message.serialize())) return { ok: false, reason: 'transaction differs from the one Carbon built' };
  const signers = signed.message.staticAccountKeys.slice(0, signed.message.header.numRequiredSignatures);
  const idx = signers.findIndex((k) => k.equals(new PublicKey(launcherWallet)));
  if (idx < 0) return { ok: false, reason: 'launcher wallet is not a signer of this transaction' };
  const sig = signed.signatures[idx];
  if (!sig || sig.every((b) => b === 0)) return { ok: false, reason: 'launcher wallet has not signed' };
  if (!ed25519.verify(sig, msg, new PublicKey(launcherWallet).toBytes())) return { ok: false, reason: 'launcher signature does not verify' };
  return { ok: true };
}
