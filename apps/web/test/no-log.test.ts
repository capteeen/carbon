import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { logConfigured, getCore } from '../src/server/core';
import { listLiveLaunches, recentGlobalEvents, latestReplay, listReceipts, listLaunchWallets } from '../src/server/readmodel';

describe('deployment with no event log', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.ARGON_AGENT_KEY_SEED;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('reads return honest empty states, never invented data', async () => {
    expect(logConfigured()).toBe(false);
    expect(await listLiveLaunches()).toEqual([]);
    expect(await recentGlobalEvents()).toEqual({ events: [], lastSeq: 0 });
    expect(await latestReplay()).toBeNull();
    expect(await listReceipts()).toEqual([]);
    expect(await listLaunchWallets()).toEqual([]);
  });

  it('writes are refused with a 503-class error', async () => {
    await expect(getCore()).rejects.toMatchObject({ name: 'LogNotConfiguredError', status: 503 });
  });
});
