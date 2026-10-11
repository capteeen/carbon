/**
 * TEST FIXTURES ONLY. Handwritten pump `Global` / `FeeConfig` values for
 * offline instruction-building tests. The reserve numbers are pump.fun's
 * published bonding-curve constants; the fee recipients are random keys. These
 * never leave test/.
 */
import { PublicKey, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import type { FeeConfig, Global } from '@pump-fun/pump-sdk';
import { PROGRAMS } from '../../src/programs.js';

const k = () => Keypair.generate().publicKey;
const Z = PublicKey.default;

export function fixtureGlobal(): Global {
  return {
    initialized: true,
    authority: k(),
    feeRecipient: k(),
    initialVirtualTokenReserves: new BN('1073000000000000'),
    initialVirtualSolReserves: new BN('30000000000'),
    initialRealTokenReserves: new BN('793100000000000'),
    tokenTotalSupply: new BN('1000000000000000'),
    feeBasisPoints: new BN(95),
    withdrawAuthority: k(),
    enableMigrate: true,
    poolMigrationFee: new BN(15_000_001),
    creatorFeeBasisPoints: new BN(30),
    feeRecipients: [k(), k(), k(), k(), k(), k(), k()],
    setCreatorAuthority: k(),
    adminSetCreatorAuthority: k(),
    createV2Enabled: true,
    whitelistPda: Z,
    reservedFeeRecipient: k(),
    mayhemModeEnabled: false,
    reservedFeeRecipients: [Z, Z, Z, Z, Z, Z, Z],
    isCashbackEnabled: false,
    buybackFeeRecipients: [k(), k(), Z, Z, Z, Z, Z, Z],
    buybackBasisPoints: new BN(0),
    initialVirtualQuoteReserves: new BN('30000000000'),
    whitelistedQuoteMints: [Z],
    creatorFeeConfigurable: false,
    maxConfigurableCreatorFeeBps: new BN(0),
    holderRewardClaimAuthority: Z,
    isHolderRewardEnabled: false,
    maxCurveDepth: 0,
  };
}

export function fixtureFeeConfig(): FeeConfig {
  const fees = (lp: number, protocol: number, creator: number) => ({ lpFeeBps: new BN(lp), protocolFeeBps: new BN(protocol), creatorFeeBps: new BN(creator) });
  return {
    admin: k(),
    flatFees: fees(0, 95, 30),
    feeTiers: [{ marketCapLamportsThreshold: new BN(0), fees: fees(0, 95, 30) }],
    stableFeeTiers: [],
    exoticFlatFees: fees(0, 0, 0),
  } as unknown as FeeConfig;
}

/** Encode a Global account as the chain would serve it (Anchor discriminator + borsh). */
export async function encodeGlobalAccount(g: Global): Promise<Buffer> {
  return PROGRAMS.pump.coder.accounts.encode('global', g);
}
