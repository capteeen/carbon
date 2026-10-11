import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { checkSignedLaunchTx } from '@/server/tx';
import { deriveLaunchView } from '@/lib/launch-view';
import { ev } from './helpers';

function build(payer: Keypair, mint: Keypair, lamports = 1) {
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: mint.publicKey, lamports }), SystemProgram.transfer({ fromPubkey: mint.publicKey, toPubkey: payer.publicKey, lamports: 1 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([mint]); // partially signed by the mint key, as the chain client returns it
  return tx;
}
const b64 = (t: VersionedTransaction) => Buffer.from(t.serialize()).toString('base64');

describe('signed launch tx relay check', () => {
  const payer = Keypair.generate();
  const mint = Keypair.generate();
  const unsigned = build(payer, mint);

  it('accepts the same message signed by the launcher', () => {
    const signed = VersionedTransaction.deserialize(unsigned.serialize());
    signed.sign([payer]);
    expect(checkSignedLaunchTx(b64(unsigned), b64(signed), payer.publicKey.toBase58())).toEqual({ ok: true });
  });

  it('refuses an unsigned tx, a swapped tx, and the wrong wallet', () => {
    expect(checkSignedLaunchTx(b64(unsigned), b64(unsigned), payer.publicKey.toBase58()).ok).toBe(false);
    const swapped = build(payer, mint, 999);
    swapped.sign([payer]);
    expect(checkSignedLaunchTx(b64(unsigned), b64(swapped), payer.publicKey.toBase58())).toEqual({ ok: false, reason: 'transaction differs from the one Carbon built' });
    const signed = VersionedTransaction.deserialize(unsigned.serialize());
    signed.sign([payer]);
    expect(checkSignedLaunchTx(b64(unsigned), b64(signed), Keypair.generate().publicKey.toBase58()).ok).toBe(false);
    expect(checkSignedLaunchTx(b64(unsigned), 'not a tx', payer.publicKey.toBase58()).ok).toBe(false);
  });
});

describe('deriveLaunchView', () => {
  it('pending approvals drop once decided; DIAMOND forces autopilot off', () => {
    const L = 'L';
    const evs = [
      ev(L, 'launch.created', { line: 'l', isotope: 'C-12', shape: 'diamond', heavyAgent: null, launcherWallet: 'w', xConnected: false }, 'user'),
      ev(L, 'approval.requested', { approvalId: 'a1', action: 'post', draft: null, expiresAt: null }, 'herald'),
      ev(L, 'approval.requested', { approvalId: 'a2', action: 'action', draft: null, expiresAt: null }, 'forge'),
      ev(L, 'approval.granted', { approvalId: 'a1', by: 'w', viaAutopilot: false }, 'user'),
      ev(L, 'autopilot.changed', { actionClass: 'posts', enabled: true, by: 'w' }, 'user'),
    ];
    const v = deriveLaunchView(L, evs);
    expect(v.pending.map((p) => p.approvalId)).toEqual(['a2']);
    expect(v.autopilot.posts).toBe(false);
    expect(v.decay.rule).toBe('none');
  });
});
