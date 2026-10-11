import { beforeEach, describe, expect, it, vi } from 'vitest';
import { messages, verifyWalletSignature } from '@/lib/signing';
import { ev, testWallet } from './helpers';

const LAUNCH = '11111111-2222-4333-8444-555555555555';
const APPROVAL = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const launcher = testWallet();
const stranger = testWallet();

const decide = vi.fn(async () => undefined);
const setAutopilot = vi.fn(async () => undefined);
const killSwitch = vi.fn(async () => undefined);

vi.mock('@/server/core', () => ({ getCore: async () => ({ approvals: { decide, setAutopilot, killSwitch } }) }));
vi.mock('@/server/readmodel', () => ({
  approvalLaunchId: async (id: string) => (id === APPROVAL ? LAUNCH : null),
  launchCreated: async (id: string) =>
    id === LAUNCH
      ? ev(LAUNCH, 'launch.created', { line: 'x', isotope: 'C-12', shape: 'chain', heavyAgent: null, launcherWallet: launcher.address, xConnected: false }, 'user')
      : null,
}));

const { POST: approve } = await import('@/app/api/approvals/[approvalId]/route');
const { POST: autopilot } = await import('@/app/api/autopilot/route');

function call(body: unknown, approvalId = APPROVAL) {
  return approve(new Request('http://t/api/approvals/' + approvalId, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ approvalId }) });
}

beforeEach(() => {
  decide.mockClear();
  setAutopilot.mockClear();
});

describe('approval decisions are signed by the launcher wallet', () => {
  it('a valid launcher signature over the approval id decides it', async () => {
    const signature = launcher.sign(messages.approval({ approvalId: APPROVAL, decision: 'grant' }));
    const res = await call({ decision: 'grant', signature });
    expect(res.status).toBe(200);
    expect(decide).toHaveBeenCalledWith(APPROVAL, true, launcher.address, undefined);
  });

  it('another wallet’s valid signature is refused before decide()', async () => {
    const signature = stranger.sign(messages.approval({ approvalId: APPROVAL, decision: 'grant' }));
    const res = await call({ decision: 'grant', signature });
    expect(res.status).toBe(401);
    expect(decide).not.toHaveBeenCalled();
  });

  it('a grant signature cannot be replayed as a reject (and vice versa)', async () => {
    const signature = launcher.sign(messages.approval({ approvalId: APPROVAL, decision: 'grant' }));
    const res = await call({ decision: 'reject', signature });
    expect(res.status).toBe(401);
    expect(decide).not.toHaveBeenCalled();
  });

  it('a signature for another approval id is refused', async () => {
    const other = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff';
    const signature = launcher.sign(messages.approval({ approvalId: other, decision: 'grant' }));
    const res = await call({ decision: 'grant', signature });
    expect(res.status).toBe(401);
    expect(decide).not.toHaveBeenCalled();
  });

  it('garbage signatures and unknown approvals are refused', async () => {
    expect((await call({ decision: 'grant', signature: 'notbase58!!' })).status).toBe(401);
    const unknown = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000000';
    expect((await call({ decision: 'grant', signature: launcher.sign(messages.approval({ approvalId: unknown, decision: 'grant' })) }, unknown)).status).toBe(404);
    expect((await call({ decision: 'maybe', signature: 'x' })).status).toBe(400);
    expect(decide).not.toHaveBeenCalled();
  });

  it('verifyWalletSignature rejects tampered text', () => {
    const t = messages.approval({ approvalId: APPROVAL, decision: 'grant' });
    const s = launcher.sign(t);
    expect(verifyWalletSignature(launcher.address, t, s)).toBe(true);
    expect(verifyWalletSignature(launcher.address, t + ' ', s)).toBe(false);
  });
});

describe('autopilot', () => {
  it('refuses the launch class and stale signatures', async () => {
    const issuedAt = Date.now();
    const bad = await autopilot(
      new Request('http://t/api/autopilot', {
        method: 'POST',
        body: JSON.stringify({ launchId: LAUNCH, actionClass: 'launch', enabled: true, issuedAt, signature: launcher.sign('x') }),
      }),
    );
    expect(bad.status).toBe(400);
    const old = Date.now() - 60 * 60_000;
    const stale = await autopilot(
      new Request('http://t/api/autopilot', {
        method: 'POST',
        body: JSON.stringify({ launchId: LAUNCH, actionClass: 'posts', enabled: true, issuedAt: old, signature: launcher.sign(messages.autopilot({ launchId: LAUNCH, actionClass: 'posts', enabled: true, issuedAt: old })) }),
      }),
    );
    expect(stale.status).toBe(401);
    expect(setAutopilot).not.toHaveBeenCalled();
  });

  it('a fresh launcher signature switches it', async () => {
    const issuedAt = Date.now();
    const signature = launcher.sign(messages.autopilot({ launchId: LAUNCH, actionClass: 'posts', enabled: true, issuedAt }));
    const res = await autopilot(new Request('http://t/api/autopilot', { method: 'POST', body: JSON.stringify({ launchId: LAUNCH, actionClass: 'posts', enabled: true, issuedAt, signature }) }));
    expect(res.status).toBe(200);
    expect(setAutopilot).toHaveBeenCalledWith(LAUNCH, 'posts', true, launcher.address);
  });
});
