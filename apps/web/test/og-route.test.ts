import { describe, expect, it, vi } from 'vitest';

const getLaunchByCa = vi.fn(async () => null);
vi.mock('@/server/readmodel', () => ({ getLaunchByCa }));

const { GET } = await import('@/app/og/[ca]/route');

describe('OG image route', () => {
  it('unknown CA → 404, never a generic card', async () => {
    const ca = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const res = await GET(new Request(`http://t/og/${ca}`), { params: Promise.resolve({ ca }) });
    expect(res.status).toBe(404);
    expect(getLaunchByCa).toHaveBeenCalledWith(ca);
  });

  it('a non-address → 404 without touching the log', async () => {
    getLaunchByCa.mockClear();
    const res = await GET(new Request('http://t/og/nope'), { params: Promise.resolve({ ca: 'nope' }) });
    expect(res.status).toBe(404);
    expect(getLaunchByCa).not.toHaveBeenCalled();
  });
});
