/**
 * TEST HELPERS ONLY: encode pump program events / accounts with the vendored
 * IDLs, filling every field the test does not set with a zero value.
 */
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';
import { PROGRAMS, type ProgramKey } from '../../src/programs.js';
import { EVENT_IX_TAG } from '../../src/events.js';

type IdlType = string | { vec?: unknown; array?: [unknown, number]; option?: unknown; defined?: { name: string } };
interface IdlField {
  name: string;
  type: IdlType;
}

function zero(program: ProgramKey, t: IdlType): unknown {
  if (typeof t === 'string') {
    if (t === 'pubkey') return PublicKey.default;
    if (t === 'bool') return false;
    if (t === 'string') return '';
    if (/^[ui](8|16|32)$/.test(t)) return 0;
    return new BN(0);
  }
  if (t.vec) return [];
  if (t.array) return Array.from({ length: t.array[1] }, () => zero(program, t.array![0] as IdlType));
  if (t.option) return null;
  if (t.defined) return defaults(program, t.defined.name);
  throw new Error(`no zero for ${JSON.stringify(t)}`);
}

export function defaults(program: ProgramKey, typeName: string): Record<string, unknown> {
  const types = PROGRAMS[program].idl.types as unknown as { name: string; type: { fields: IdlField[] } }[];
  const def = types.find((x) => x.name === typeName);
  if (!def) throw new Error(`type ${typeName} not in ${program} IDL`);
  return Object.fromEntries(def.type.fields.map((f) => [f.name, zero(program, f.type)]));
}

export function eventBytes(program: ProgramKey, name: string, data: Record<string, unknown>): Buffer {
  const events = PROGRAMS[program].idl.events as unknown as { name: string; discriminator: number[] }[];
  const ev = events.find((e) => e.name === name);
  if (!ev) throw new Error(`event ${name} not in ${program} IDL`);
  const body = encodeType(program, name, data);
  return Buffer.concat([Buffer.from(ev.discriminator), body]);
}

/** "Program data: <base64>" log lines wrapped in the program's invoke/success. */
export function eventLogs(programId: PublicKey, program: ProgramKey, name: string, data: Record<string, unknown>): string[] {
  return [`Program ${programId.toBase58()} invoke [1]`, `Program data: ${eventBytes(program, name, data).toString('base64')}`, `Program ${programId.toBase58()} success`];
}

/** emit_cpi! style inner instruction data (base58). */
export function eventCpiData(program: ProgramKey, name: string, data: Record<string, unknown>): string {
  return bs58.encode(Buffer.concat([EVENT_IX_TAG, eventBytes(program, name, data)]));
}

function encodeType(program: ProgramKey, name: string, data: Record<string, unknown>): Buffer {
  // Anchor's coders encode into a fixed 1000-byte buffer; Global is larger, so use the layout directly.
  const layouts = (PROGRAMS[program].coder.types as unknown as { typeLayouts: Map<string, { encode(v: unknown, b: Buffer): number }> }).typeLayouts;
  const layout = layouts.get(name);
  if (!layout) throw new Error(`no layout for ${name}`);
  const buf = Buffer.alloc(16_384);
  const len = layout.encode({ ...defaults(program, name), ...data }, buf);
  return buf.subarray(0, len);
}

export async function encodeAccount(program: ProgramKey, name: string, data: Record<string, unknown>): Promise<Buffer> {
  const accounts = PROGRAMS[program].idl.accounts as unknown as { name: string; discriminator: number[] }[];
  const acc = accounts.find((a) => a.name === name);
  if (!acc) throw new Error(`account ${name} not in ${program} IDL`);
  return Buffer.concat([Buffer.from(acc.discriminator), encodeType(program, name, data)]);
}
