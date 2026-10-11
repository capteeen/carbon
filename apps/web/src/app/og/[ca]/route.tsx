/**
 * GET /og/<ca>: the launch's real 1200×630 Open Graph image, drawn from its logged
 * data (ticker, isotope, shape, CA, Sentinel score). Unknown CA → 404, never a
 * generic or fake card.
 */
import { ISOTOPES, SHAPES } from '@carbon/core/contracts';
import { getLaunchByCa } from '@/server/readmodel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const C = { fogLight: '#B9C0CB', fogMid: '#9AA2AF', slate: '#5C6472', frost: '#E6EBF2', ink: '#2B313B' };

export async function GET(_req: Request, ctx: { params: Promise<{ ca: string }> }): Promise<Response> {
  const { ca } = await ctx.params;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) return new Response('not found', { status: 404 });
  const found = await getLaunchByCa(ca);
  if (!found) return new Response('not found', { status: 404 });
  const s = found.summary;
  const { ImageResponse } = await import('next/og');
  const iso = ISOTOPES[s.isotope];
  const score = s.score === null ? '--.--' : `${s.score}/${s.threshold}`;
  const label = (t: string) => <div style={{ display: 'flex', fontSize: 22, color: C.slate, letterSpacing: 2 }}>{t}</div>;
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: C.fogLight,
          color: C.ink,
          padding: 64,
          fontFamily: 'monospace',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', fontSize: 40, fontWeight: 800, letterSpacing: 4 }}>CARBON</div>
            {label('// Agents that bond.')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
            {label(`//////  ${iso.label}  ·  ${SHAPES[s.shape].label}`)}
            {label(s.heavyAgent ? `// HEAVY ${s.heavyAgent.toUpperCase()}` : `// ${iso.name}`)}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', fontSize: 132, fontWeight: 800, color: C.ink }}>{s.ticker ? `$${s.ticker}` : '--.--'}</div>
          <div style={{ display: 'flex', fontSize: 34, color: C.slate }}>{s.name ?? '--.--'}</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderTop: `1px solid ${C.frost}`, paddingTop: 24 }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {label('CA')}
            <div style={{ display: 'flex', fontSize: 26 }}>{ca}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
            {label('STABILITY')}
            <div style={{ display: 'flex', fontSize: 44, fontWeight: 800 }}>{score}</div>
          </div>
        </div>
      </div>
    ),
    { width: 1200, height: 630, headers: { 'cache-control': 'public, max-age=300' } },
  );
}
