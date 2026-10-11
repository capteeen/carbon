import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PgApprovals, ApprovalError } from '../src/approvals.js';
import { WALLET, createLaunch, testEnv, waitFor, type TestEnv } from './helpers.js';

let env: TestEnv;
let approvals: PgApprovals;
beforeEach(async () => {
  env = await testEnv();
  approvals = new PgApprovals({ bus: env.bus, pool: env.bus.pool, now: env.clock.now, pollMs: 20 });
});
afterEach(async () => {
  await env.cleanup();
});

describe('Approvals', () => {
  it('request resolves on the user decision; grant and reject are events', async () => {
    const l = await createLaunch(env.bus, 'ring');
    const pending = approvals.request(l, 'post', { text: 'gm' }, 'herald');
    await waitFor(async () => (await env.bus.list(l, { kinds: ['approval.requested'] })).length === 1);
    const [req] = await env.bus.list(l, { kinds: ['approval.requested'] });
    const id = (req!.payload as { approvalId: string }).approvalId;
    await approvals.decide(id, true, WALLET);
    await expect(pending).resolves.toEqual({ approvalId: id, granted: true, by: WALLET, viaAutopilot: false });
    const granted = await env.bus.list(l, { kinds: ['approval.granted'] });
    expect(granted.map((e) => e.payload)).toEqual([{ approvalId: id, by: WALLET, viaAutopilot: false }]);

    const p2 = approvals.open(l, 'reply', { text: 'hi' }, 'keeper');
    const { approvalId: id2 } = await p2;
    await approvals.decide(id2, false, WALLET, 'tone');
    expect((await env.bus.list(l, { kinds: ['approval.rejected'] })).map((e) => e.payload)).toEqual([
      { approvalId: id2, by: WALLET, reason: 'tone' },
    ]);
    await expect(approvals.decide(id2, true, WALLET)).rejects.toThrow(/already decided/);
  });

  it('only the launcher wallet can decide', async () => {
    const l = await createLaunch(env.bus, 'ring');
    const { approvalId } = await approvals.open(l, 'post', {}, 'herald');
    await expect(approvals.decide(approvalId, true, 'SomeoneElse')).rejects.toThrow(/launcher wallet/);
  });

  it('consume is single-use and checks launch + action', async () => {
    const l = await createLaunch(env.bus, 'ring');
    const other = await createLaunch(env.bus, 'ring');
    const { approvalId } = await approvals.open(l, 'post', { text: 'gm' }, 'herald');
    await expect(approvals.consume(l, approvalId, 'post')).rejects.toThrow(/pending/);
    await approvals.decide(approvalId, true, WALLET);
    await expect(approvals.consume(l, approvalId, 'launch')).rejects.toThrow(/is for 'post', not 'launch'/);
    await expect(approvals.consume(other, approvalId, 'post')).rejects.toThrow(/different launch/);
    await expect(approvals.consume(l, approvalId, 'post')).resolves.toBeUndefined();
    await expect(approvals.consume(l, approvalId, 'post')).rejects.toThrow(/already used/);
    // Racing consumers: exactly one wins.
    const { approvalId: a2 } = await approvals.open(l, 'post', {}, 'herald');
    await approvals.decide(a2, true, WALLET);
    const r = await Promise.allSettled(Array.from({ length: 8 }, () => approvals.consume(l, a2, 'post')));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    // A rejected approval cannot be consumed.
    const { approvalId: a3 } = await approvals.open(l, 'post', {}, 'herald');
    await approvals.decide(a3, false, WALLET);
    await expect(approvals.consume(l, a3, 'post')).rejects.toThrow(/rejected/);
  });

  it('autopilot grants only its enabled class, and never a launch', async () => {
    const l = await createLaunch(env.bus, 'ring');
    await approvals.setAutopilot(l, 'posts', true, WALLET);
    const post = await approvals.open(l, 'post', { text: 'loop post' }, 'herald');
    expect(post.autoGranted).toBe(true);
    await expect(approvals.wait(post.approvalId)).resolves.toMatchObject({ granted: true, viaAutopilot: true, by: 'autopilot' });
    await approvals.consume(l, post.approvalId, 'post');
    const reply = await approvals.open(l, 'reply', {}, 'keeper');
    expect(reply.autoGranted).toBe(false);
    // Launches: no autopilot class exists and the request stays pending for the user.
    await expect(approvals.setAutopilot(l, 'launch' as never, true, WALLET)).rejects.toThrow(/cannot be autopiloted/);
    const launch = await approvals.open(l, 'launch', { ticker: 'X' }, 'forge');
    expect(launch.autoGranted).toBe(false);
    for (const cls of ['posts', 'replies', 'buybacks'] as const) await approvals.setAutopilot(l, cls, true, WALLET);
    const launch2 = await approvals.open(l, 'launch', {}, 'forge');
    expect(launch2.autoGranted).toBe(false);
    // Even a direct DB write cannot mark a launch approval as autopilot-granted.
    await expect(
      env.bus.pool.query("UPDATE approvals SET status='granted', via_autopilot=TRUE WHERE id=$1", [launch2.approvalId]),
    ).rejects.toThrow(/approvals_launch_never_autopilot/);
    expect((await env.bus.list(l, { kinds: ['autopilot.changed'] })).length).toBe(4);
  });

  it('diamond (gateEveryAction) disables autopilot entirely', async () => {
    const l = await createLaunch(env.bus, 'diamond');
    await expect(approvals.setAutopilot(l, 'posts', true, WALLET)).rejects.toThrow(/gates every action/);
    // Even if a row were present, request() never auto-grants on a gated shape.
    await env.bus.pool.query("INSERT INTO autopilot VALUES ($1, 'posts', TRUE, 'x', 0)", [l]);
    expect((await approvals.open(l, 'post', {}, 'herald')).autoGranted).toBe(false);
  });

  it('kill switch: disables all autopilot and blocks pending autopilot grants', async () => {
    const l = await createLaunch(env.bus, 'ring');
    await approvals.setAutopilot(l, 'posts', true, WALLET);
    await approvals.setAutopilot(l, 'buybacks', true, WALLET);
    const granted = await approvals.open(l, 'post', {}, 'herald');
    expect(granted.autoGranted).toBe(true);
    // A user-granted approval survives the kill switch; the autopilot one does not.
    const manual = await approvals.open(l, 'reply', {}, 'keeper');
    await approvals.decide(manual.approvalId, true, WALLET);

    await approvals.killSwitch(l, WALLET, 'too spicy');
    await expect(approvals.consume(l, granted.approvalId, 'post')).rejects.toThrow(/kill switch/);
    await expect(approvals.consume(l, manual.approvalId, 'reply')).resolves.toBeUndefined();
    expect((await approvals.open(l, 'post', {}, 'herald')).autoGranted).toBe(false);
    expect((await approvals.open(l, 'buyback', {}, 'treasurer')).autoGranted).toBe(false);
    await expect(approvals.setAutopilot(l, 'posts', true, WALLET)).rejects.toThrow(/kill switch/);
    expect(await approvals.autopilotState(l)).toEqual({ posts: false, replies: false, buybacks: false, killed: true });
    const kinds = (await env.bus.list(l)).map((e) => e.kind);
    expect(kinds).toContain('killswitch.engaged');
    expect((await env.bus.list(l, { kinds: ['autopilot.changed'] })).slice(-2).map((e) => e.payload)).toEqual([
      expect.objectContaining({ enabled: false }),
      expect.objectContaining({ enabled: false }),
    ]);
  });

  it('errors are ApprovalError', async () => {
    await expect(approvals.consume('nope', 'nope', 'post')).rejects.toBeInstanceOf(ApprovalError);
  });
});
