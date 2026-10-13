'use client';
/** /l/[ca]: one launch, fully live from its own events. */
import { AUTOPILOT_CLASSES, EMPTY_READOUT, ISOTOPES, SHAPES, type AutopilotClass, type ArgonEvent } from '@argon/core/contracts';
import { computeBonds } from '@argon/core/bonds';
import { useMemo, useState } from 'react';
import { postJson } from '@/lib/api';
import { deriveLaunchView, explorerUrl, lamportsToSol, shortId } from '@/lib/launch-view';
import { messages } from '@/lib/signing';
import { useEventStream, useNow } from '@/lib/use-events';
import { toVisualDaughter, toVisualDecay } from '@/lib/visual-data';
import { LaunchScene } from '@/visual';
import { ApprovalCards, EventLog, SentinelReportView, ThinkingFeed } from './LaunchParts';
import { WalletConnect, useSigner } from './WalletConnect';

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${d}d ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/**
 * renderedAt: the server's render time, the display time of the first render.
 * Display bonds are core's computeBonds over this launch's full log at display
 * time, re-evaluated every second, so bonds age out of the 60 s window even with
 * no new events.
 */
export function LaunchLive({ launchId, initial, lastSeq, renderedAt }: { launchId: string; initial: ArgonEvent[]; lastSeq: number; renderedAt: number }) {
  const { events, status } = useEventStream(launchId, initial, lastSeq);
  const v = useMemo(() => deriveLaunchView(launchId, events), [launchId, events]);
  const now = useNow(1000, true, renderedAt) ?? renderedAt;
  const bonds = useMemo(() => computeBonds(events, Math.max(now, events[events.length - 1]?.ts ?? 0)), [events, now]);
  const { connected, address, signText } = useSigner();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const created = v.created?.payload ?? null;
  const draft = v.latestDraft?.payload ?? null;
  const dep = v.deployed?.payload ?? null;
  const network = dep?.network ?? null;
  const isLauncher = connected && !!created && address === created.launcherWallet;
  const gated = v.config?.gateEveryAction ?? false;

  async function signed(fn: () => Promise<void>) {
    setErr(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  const toggle = (cls: AutopilotClass, enabled: boolean) =>
    signed(async () => {
      const issuedAt = Date.now();
      const signature = await signText(messages.autopilot({ launchId, actionClass: cls, enabled, issuedAt }));
      await postJson('/api/autopilot', { launchId, actionClass: cls, enabled, issuedAt, signature });
    });

  const kill = () =>
    signed(async () => {
      if (!window.confirm('Engage the kill switch? Autopilot turns off for this launch for good.')) return;
      const issuedAt = Date.now();
      const signature = await signText(messages.killSwitch({ launchId, issuedAt }));
      await postJson('/api/killswitch', { launchId, issuedAt, signature });
    });

  const decay = v.decay;
  let decayLine: string;
  if (decay.rule === 'none') decayLine = 'STABLE · no decay';
  else if (decay.collapsed) decayLine = `COLLAPSED · ${new Date(decay.collapsed.payload.at).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
  else if (decay.rule === 'clock')
    decayLine = decay.collapseAt === null ? `CLOCK ${EMPTY_READOUT}` : `CLOCK ${clock(decay.collapseAt - now)} to collapse`;
  else decayLine = `QUIET RULE · collapses after ${(decay.quietSec ?? 0) / 60} min with no trades · last trade ${EMPTY_READOUT}`;

  return (
    <div>
      <p className="hud-label">
        //////{' '}
        {created ? `${ISOTOPES[created.isotope].label} · ${SHAPES[created.shape].label}${created.heavyAgent ? ` · HEAVY_${created.heavyAgent.toUpperCase()}` : ''}` : EMPTY_READOUT}
      </p>
      <h1 className="wordmark">{draft ? `$${draft.ticker}` : EMPTY_READOUT}</h1>
      <p>{draft?.name ?? EMPTY_READOUT}</p>
      <p className="ca">
        CA {dep ? <a href={explorerUrl('address', dep.ca, network) ?? '#'}>{dep.ca}</a> : EMPTY_READOUT}
      </p>
      <p className="meta">
        STATE {v.molecule.state ?? EMPTY_READOUT} · {network ?? EMPTY_READOUT} · stream {status}
      </p>

      <LaunchScene
        events={events}
        bonds={bonds}
        sentinel={v.latestScore?.payload ?? null}
        decay={toVisualDecay(events, v.decay)}
        daughter={toVisualDaughter(v.decay)}
        soundToggle={false}
      />

      <h2>Decay</h2>
      <p data-testid="decay-status">{decayLine}</p>
      {decay.daughter ? (
        <p className="ca">
          DAUGHTER <a href={explorerUrl('address', decay.daughter.payload.daughterCa, network) ?? '#'}>{decay.daughter.payload.daughterCa}</a> · {decay.airdrops.length} airdrops
        </p>
      ) : null}

      <h2>Approvals</h2>
      {v.pending.length === 0 ? <p className="meta">// No pending approvals.</p> : null}
      <ApprovalCards pending={v.pending} launcherWallet={created?.launcherWallet ?? null} />

      <h2>Autopilot</h2>
      <p className="meta">// Off by default. Never for launches. {gated ? 'DIAMOND gates every action: autopilot is unavailable.' : ''}</p>
      {AUTOPILOT_CLASSES.map((cls) => (
        <div key={cls} className="toggle">
          <span className="hud-label">{cls}</span>
          <span>{v.autopilot[cls] ? 'ON' : 'OFF'}</span>
          <button type="button" disabled={!isLauncher || gated || !!v.killed || busy} onClick={() => void toggle(cls, !v.autopilot[cls])}>
            {v.autopilot[cls] ? 'Turn off' : 'Turn on'}
          </button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" disabled={!isLauncher || !!v.killed || busy} onClick={() => void kill()}>
          {v.killed ? 'Kill switch engaged' : 'Kill switch'}
        </button>
      </div>
      {!isLauncher ? (
        <div style={{ marginTop: 8 }}>
          <p className="meta">// The launcher wallet controls approvals, autopilot and the kill switch.</p>
          <WalletConnect />
        </div>
      ) : null}
      {err ? <p className="error-text">{err}</p> : null}

      <h2>Sentinel</h2>
      <SentinelReportView score={v.latestScore} />

      <h2>Thinking</h2>
      <ThinkingFeed reasoning={v.reasoning} />

      <h2>Posts</h2>
      {v.posts.length === 0 ? (
        <p className="meta">{EMPTY_READOUT}</p>
      ) : (
        <ul className="plain">
          {[...v.posts].reverse().map((p) => (
            <li key={p.id} id={`ev-${p.id}`}>
              <span className="hud-label">{p.payload.kind.toUpperCase()} · approval {shortId(p.payload.approvalId)}</span>
              {p.payload.text}{' '}
              <a href={p.payload.url} target="_blank" rel="noreferrer">
                view on X
              </a>
            </li>
          ))}
        </ul>
      )}

      <h2>Holders</h2>
      <p>{v.holders ? `${v.holders.payload.holderCount} holders · slot ${v.holders.payload.slot}` : `HOLDERS ${EMPTY_READOUT}`}</p>

      <h2>Receipts</h2>
      {v.receipts.length === 0 ? (
        <p className="meta">{EMPTY_READOUT}</p>
      ) : (
        <ul className="plain">
          {[...v.receipts].reverse().map((r) => (
            <li key={r.id}>
              SPLIT {shortId(r.payload.splitId)} · {lamportsToSol(r.payload.totalLamports)} SOL ·{' '}
              {r.payload.legs.map((l, i) => {
                const href = l.txSig ? explorerUrl('tx', l.txSig, network) : null;
                return (
                  <span key={i}>
                    {l.to} {lamportsToSol(l.lamports)} {l.status}
                    {href ? (
                      <>
                        {' '}
                        <a href={href} target="_blank" rel="noreferrer">
                          tx
                        </a>
                      </>
                    ) : null}
                    {i < r.payload.legs.length - 1 ? ' · ' : ''}
                  </span>
                );
              })}
            </li>
          ))}
        </ul>
      )}

      {v.errors.length ? (
        <>
          <h2>Errors</h2>
          <ul className="plain">
            {v.errors.map((e) => (
              <li key={e.id} id={`ev-${e.id}`}>
                {e.payload.agent ? `${e.payload.agent.toUpperCase()}: ` : ''}
                {e.payload.message}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h2>Log</h2>
      <EventLog events={events} />
    </div>
  );
}
