'use client';
/** Pieces shared by /launch and /l/[ca]. Every value shown is read from a logged event. */
import { EMPTY_READOUT, type ArgonEvent, type SentinelReport } from '@argon/core/contracts';
import { useState } from 'react';
import { postJson } from '@/lib/api';
import { shortId, type PendingApproval } from '@/lib/launch-view';
import { messages } from '@/lib/signing';
import { useSigner } from './WalletConnect';

const INPUT_LABELS: Record<SentinelReport['inputs'][number]['key'], string> = {
  collision: 'NAME/TICKER COLLISION',
  logo: 'LOGO MATCH',
  wallet: 'WALLET HISTORY',
  sniper: 'BUNDLE/SNIPER RISK',
  freshness: 'NARRATIVE FRESHNESS',
  content: 'CONTENT RULES',
};

export function SentinelReportView({ score }: { score: ArgonEvent<'sentinel.score'> | null }) {
  if (!score) return <p className="meta">STABILITY {EMPTY_READOUT}</p>;
  const r = score.payload;
  return (
    <div data-testid="sentinel-report">
      <p>
        <strong>
          STABILITY {r.score}/{r.threshold}
        </strong>{' '}
        · {r.hardFail ? 'BLOCKED: hard fail' : r.passed ? 'PASSED' : 'BLOCKED: below threshold'} · run {r.run} · <a href={`#ev-${score.id}`}>{shortId(score.id)}</a>
      </p>
      {r.inputs.map((i) => (
        <div key={i.key} className="score-input">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="hud-label">{INPUT_LABELS[i.key]}</span>
            <span>
              {i.points}/{i.max}
              {i.hardFail ? ' · HARD FAIL' : ''}
            </span>
          </div>
          <p className="meta">{i.reason}</p>
        </div>
      ))}
    </div>
  );
}

export function ThinkingFeed({ reasoning }: { reasoning: ArgonEvent<'reasoning'>[] }) {
  return (
    <div data-testid="thinking-feed">
      <p className="hud-label">THINKING FEED // agent reasoning</p>
      {reasoning.length === 0 ? (
        <p className="meta">{EMPTY_READOUT}</p>
      ) : (
        <ul className="plain">
          {[...reasoning].reverse().map((r) => (
            <li key={r.id}>
              <span className="hud-label">
                {r.payload.agent.toUpperCase()} · agent reasoning · for <a href={`#ev-${r.payload.forEventId}`}>{shortId(r.payload.forEventId)}</a>
              </span>
              {r.payload.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function EventLog({ events }: { events: ArgonEvent[] }) {
  return (
    <details>
      <summary className="hud-label">EVENT LOG ({events.length})</summary>
      <ul className="plain">
        {events.map((e) => (
          <li key={e.id} id={`ev-${e.id}`}>
            <code>{shortId(e.id)}</code> · #{e.seq} · {e.kind} · {e.actor} · {new Date(e.ts).toISOString().slice(11, 19)} UTC
          </li>
        ))}
      </ul>
    </details>
  );
}

interface Card {
  title?: string;
  summary?: string;
  text?: string;
  details?: Record<string, string>;
}

function asCard(draft: unknown): Card {
  return draft && typeof draft === 'object' ? (draft as Card) : {};
}

/** One-tap approval cards, signed by the launcher wallet over the approval id. */
export function ApprovalCards({ pending, launcherWallet }: { pending: PendingApproval[]; launcherWallet: string | null }) {
  const { connected, address, signText } = useSigner();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (pending.length === 0) return null;
  const isLauncher = connected && address !== null && address === launcherWallet;

  async function decide(approvalId: string, decision: 'grant' | 'reject') {
    setErr(null);
    setBusy(approvalId);
    try {
      const signature = await signText(messages.approval({ approvalId, decision }));
      await postJson(`/api/approvals/${approvalId}`, { decision, signature });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div data-testid="approval-cards">
      {pending.map((p) => {
        const c = asCard(p.draft);
        return (
          <div key={p.approvalId} className="card" id={`ev-${p.eventId}`}>
            <span className="hud-label">
              APPROVAL · {p.action.toUpperCase()} · {String(p.actor).toUpperCase()} · {shortId(p.eventId)}
            </span>
            <p>
              <strong>{c.title ?? p.action}</strong>
            </p>
            {c.summary ? <p className="meta">{c.summary}</p> : null}
            {c.text ? <blockquote>{c.text}</blockquote> : null}
            {c.details ? (
              <dl className="readouts">
                {Object.entries(c.details).map(([k, v]) => (
                  <div key={k}>
                    <dt>{k.toUpperCase()}</dt>
                    <dd className="ca">{v}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {isLauncher ? (
              <div className="row">
                <button type="button" className="primary" disabled={busy !== null} onClick={() => void decide(p.approvalId, 'grant')}>
                  Approve
                </button>
                <button type="button" disabled={busy !== null} onClick={() => void decide(p.approvalId, 'reject')}>
                  Reject
                </button>
              </div>
            ) : (
              <p className="meta">// Only the launcher wallet can decide. Connect it to approve or reject.</p>
            )}
          </div>
        );
      })}
      {err ? <p className="error-text">{err}</p> : null}
    </div>
  );
}
