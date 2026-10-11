/** Test-only helpers. Never imported from src/. */
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import type { CarbonEvent, EventKind, EventPayloads } from '@carbon/core/contracts';

export function testWallet() {
  const sk = ed25519.utils.randomSecretKey();
  const pk = ed25519.getPublicKey(sk);
  return {
    address: bs58.encode(pk),
    sign: (text: string) => bs58.encode(ed25519.sign(new TextEncoder().encode(text), sk)),
  };
}

let seq = 0;
export function ev<K extends EventKind>(launchId: string, kind: K, payload: EventPayloads[K], actor: CarbonEvent['actor'] = 'system'): CarbonEvent<K> {
  seq += 1;
  return { id: seq.toString(16).padStart(64, '0'), seq, launchId, ts: 1_800_000_000_000 + seq, kind, actor, payload, signer: 'test', sig: 'test' };
}
