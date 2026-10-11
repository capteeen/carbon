/**
 * The official pump.fun SDKs, loaded through their CommonJS builds.
 *
 * Why: @pump-fun/pump-sdk@4.0.0's ESM build imports
 * @pump-fun/agent-payments-sdk, whose ESM build does `import { BN } from
 * "@coral-xyz/anchor"` (a CommonJS module), which Node's ESM loader rejects
 * ("Named export 'BN' not found"). The CJS builds are the same code and load
 * fine. Types come from the packages as usual.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const pumpSdk = require('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');
export const pumpSwapSdk = require('@pump-fun/pump-swap-sdk') as typeof import('@pump-fun/pump-swap-sdk');
