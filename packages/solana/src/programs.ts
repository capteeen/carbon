/**
 * Offline handles on the three pump.fun programs, built from the IDLs vendored
 * in the official @pump-fun/pump-sdk. Used to decode instructions (allowlist),
 * events (receipts) and accounts. No RPC is made through these handles.
 */
import { Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { pumpSdk } from './sdk.js';

const { getPumpAmmProgram, getPumpFeeProgram, getPumpProgram, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID } = pumpSdk;

// A Connection object only stores its endpoint; nothing is fetched through it here.
const OFFLINE = new Connection('http://127.0.0.1:8899');

export const PROGRAMS = {
  pump: getPumpProgram(OFFLINE),
  amm: getPumpAmmProgram(OFFLINE),
  fees: getPumpFeeProgram(OFFLINE),
};
export { PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID };

export type ProgramKey = keyof typeof PROGRAMS;

export function programKeyOf(programId: PublicKey): ProgramKey | null {
  if (programId.equals(PUMP_PROGRAM_ID)) return 'pump';
  if (programId.equals(PUMP_AMM_PROGRAM_ID)) return 'amm';
  if (programId.equals(PUMP_FEE_PROGRAM_ID)) return 'fees';
  return null;
}

interface IdlIx {
  name: string;
  accounts: { name: string }[];
}

function ixDef(key: ProgramKey, name: string): IdlIx {
  const def = (PROGRAMS[key].idl.instructions as unknown as IdlIx[]).find((i) => i.name === name);
  if (!def) throw new Error(`instruction ${name} not in the ${key} IDL`);
  return def;
}

export interface DecodedPumpIx {
  program: ProgramKey;
  name: string;
  data: Record<string, unknown>;
  /** Account pubkey by IDL account name. */
  account(name: string): PublicKey;
}

/** Decode a pump / pump-amm / pump-fees instruction with the vendored IDL; null for other programs or unknown data. */
export function decodePumpIx(ix: TransactionInstruction): DecodedPumpIx | null {
  const program = programKeyOf(ix.programId);
  if (!program) return null;
  const coder = PROGRAMS[program].coder.instruction as unknown as { decode(data: Buffer): { name: string; data: unknown } | null };
  const decoded = coder.decode(Buffer.from(ix.data));
  if (!decoded) return null;
  const def = ixDef(program, decoded.name);
  return {
    program,
    name: decoded.name,
    data: decoded.data as Record<string, unknown>,
    account(name: string): PublicKey {
      const i = def.accounts.findIndex((a) => a.name === name);
      const meta = i >= 0 ? ix.keys[i] : undefined;
      if (!meta) throw new Error(`${program}.${decoded.name} has no account ${name}`);
      return meta.pubkey;
    },
  };
}
