'use client';
/**
 * /launch: connect wallet (+ optional X) → one line → isotope chamber → shape →
 * Scout proposals → Forge output → Sentinel score (revise / re-run) → one-tap
 * approval → wallet signs the launch transaction → deploy.
 *
 * Every step after "create" is driven by the launch's real events over SSE; the
 * page never shows a step the log has not reached.
 */
import { EMPTY_READOUT, ISOTOPES, type AgentId, type IsotopeId, type ShapeId } from '@carbon/core/contracts';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { postJson } from '@/lib/api';
import { deriveLaunchView, shortId } from '@/lib/launch-view';
import { messages } from '@/lib/signing';
import { useEventStream } from '@/lib/use-events';
import { IsotopeChamber, ShapePicker } from '@/visual';
import { ApprovalCards, SentinelReportView, ThinkingFeed } from './LaunchParts';
import { WalletConnect, useSigner } from './WalletConnect';

const DRAFT_KEY = 'carbon:launch-draft';

interface Draft {
  launchId: string;
  line: string;
  isotope: IsotopeId;
  heavyAgent: AgentId | null;
  shape: ShapeId;
  created: boolean;
}

function newDraft(): Draft {
  return { launchId: crypto.randomUUID(), line: '', isotope: 'C-12', heavyAgent: null, shape: 'chain', created: false };
}

function loadDraft(): Draft {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw) return JSON.parse(raw) as Draft;
  } catch {
    /* storage unavailable */
  }
  return newDraft();
}

export function LaunchFlow() {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [xNote, setXNote] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { connected, address, signText, signTx } = useSigner();

  // Restore the draft (it survives the X OAuth round trip) and read the X callback result.
  useEffect(() => {
    let d = loadDraft();
    const q = new URLSearchParams(window.location.search);
    const x = q.get('x');
    const back = q.get('launch');
    // The X account was connected for this launch id: keep using it.
    if (x === 'connected' && back && back !== d.launchId && !d.created) d = { ...d, launchId: back };
    if (x === 'connected') setXNote(`X connected: @${q.get('handle') ?? EMPTY_READOUT}`);
    else if (x === 'failed' && q.get('reason') === 'WalletMismatch') setXNote('That X connection was started by a different wallet than the launch, so it was discarded.');
    else if (x === 'failed') setXNote('X connection failed. You can launch without X or try again.');
    else if (x === 'unavailable') setXNote('X is not configured on this deployment.');
    else if (x === 'too-late') setXNote('X can only be connected before the launch is created.');
    setDraft(d);
  }, []);
  useEffect(() => {
    if (!draft) return;
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* storage unavailable */
    }
  }, [draft]);

  const { events } = useEventStream(draft?.created ? draft.launchId : null, [], 0);
  const v = useMemo(() => (draft ? deriveLaunchView(draft.launchId, events) : null), [draft, events]);

  const refreshAnswered = useCallback(async () => {
    if (!draft?.created) return;
    const r = await fetch(`/api/launch/${draft.launchId}`, { cache: 'no-store' });
    if (r.ok) {
      const j = (await r.json()) as { answered: { kind: string; ref: string }[] };
      setAnswered(new Set(j.answered.map((a) => `${a.kind}:${a.ref}`)));
    }
  }, [draft?.created, draft?.launchId]);
  useEffect(() => {
    void refreshAnswered();
  }, [refreshAnswered, events.length]);

  // Deployed: go to the live launch page.
  useEffect(() => {
    if (v?.deployed) {
      try {
        sessionStorage.removeItem(DRAFT_KEY);
      } catch {
        /* ignore */
      }
      router.push(`/l/${v.deployed.payload.ca}`);
    }
  }, [v?.deployed, router]);

  // While deploying, fetch the launch transaction the worker built for this wallet.
  const [tx, setTx] = useState<{ requestId: string; txBase64: string; mint: string } | null>(null);
  const deploying = v?.molecule.state === 'deploying' && !v.deployed;
  useEffect(() => {
    if (!deploying || !draft) return;
    let stop = false;
    const poll = async () => {
      const r = await fetch(`/api/launch/${draft.launchId}/tx`, { cache: 'no-store' }).catch(() => null);
      if (stop) return;
      if (r && r.status === 200) setTx((await r.json()) as { requestId: string; txBase64: string; mint: string });
      else setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [deploying, draft]);

  if (!draft) return <p className="meta">// loading…</p>;
  const set = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  const launcher = v?.created?.payload.launcherWallet ?? null;
  const isLauncher = connected && (!launcher || address === launcher);
  const heavyMissing = ISOTOPES[draft.isotope].heavyAgent && !draft.heavyAgent;
  const canCreate = connected && !!address && draft.line.trim().length > 0 && !heavyMissing && !busy;

  const create = () =>
    run(async () => {
      const issuedAt = Date.now();
      const line = draft.line.trim();
      const signature = await signText(
        messages.createLaunch({ launchId: draft.launchId, line, isotope: draft.isotope, shape: draft.shape, heavyAgent: draft.heavyAgent, issuedAt }),
      );
      await postJson('/api/launch', { launchId: draft.launchId, line, isotope: draft.isotope, shape: draft.shape, heavyAgent: draft.heavyAgent, wallet: address, issuedAt, signature });
      set({ created: true });
    });

  // X OAuth is bound to the signing wallet (POST, signed, single-use); then the browser goes to x.com.
  const connectX = () =>
    run(async () => {
      if (!address) throw new Error('Connect your wallet first');
      const issuedAt = Date.now();
      const signature = await signText(messages.xConnect({ launchId: draft.launchId, wallet: address, issuedAt }));
      const { authorizeUrl } = await postJson<{ authorizeUrl: string }>('/api/x/connect', { launchId: draft.launchId, wallet: address, issuedAt, signature });
      window.location.assign(authorizeUrl);
    });

  // ── before creation: the form ──
  if (!draft.created) {
    return (
      <div>
        <h1 className="section-title">Launch</h1>
        <p className="hud-label">////// 01 WALLET</p>
        <WalletConnect />
        <p className="hud-label" style={{ marginTop: 24 }}>
          ////// 02 X (OPTIONAL)
        </p>
        <p className="meta">// Connect your project&apos;s own X account so Herald can post after you approve. Carbon never creates accounts.</p>
        <p className="meta">// Your wallet signs the connect request; the X account only counts for a launch started by the same wallet.</p>
        <button type="button" className="hud-label" disabled={!connected || !address || busy} onClick={() => void connectX()}>
          [ CONNECT X ]
        </button>
        {xNote ? <p className="meta">// {xNote}</p> : null}

        <p className="hud-label" style={{ marginTop: 24 }}>
          ////// 03 ONE LINE
        </p>
        <label className="meta" htmlFor="line">
          // What is the coin about?
        </label>
        <input id="line" type="text" maxLength={280} value={draft.line} onChange={(e) => set({ line: e.target.value })} />

        <p className="hud-label" style={{ marginTop: 24 }}>
          ////// 04 ISOTOPE
        </p>
        <IsotopeChamber value={draft.isotope} onChange={(isotope) => set({ isotope })} heavyAgent={draft.heavyAgent} onHeavyAgentChange={(heavyAgent) => set({ heavyAgent })} />

        <p className="hud-label" style={{ marginTop: 24 }}>
          ////// 05 SHAPE
        </p>
        <ShapePicker value={draft.shape} onChange={(shape) => set({ shape })} />

        <div className="row" style={{ marginTop: 24 }}>
          <button type="button" className="primary" disabled={!canCreate} onClick={() => void create()}>
            Sign and start
          </button>
        </div>
        <p className="meta">// Your wallet signs a message (not a transaction) to start. Nothing is spent until you approve the launch.</p>
        {err ? <p className="error-text">{err}</p> : null}
      </div>
    );
  }

  // ── after creation: driven by the launch's events ──
  const proposals = v?.proposals ?? null;
  const proposalsAnswered = proposals ? answered.has(`narrative:${proposals.id}`) || (v?.drafts.length ?? 0) > 0 : false;
  const score = v?.latestScore ?? null;
  const scoreAnswered = score ? answered.has(`revision:${score.id}`) || (v?.drafts.some((d) => d.seq > score.seq) ?? false) : false;

  return (
    <div>
      <h1 className="section-title">Launch</h1>
      <p className="meta">
        // launch {shortId(draft.launchId)} · state {v?.molecule.state ?? EMPTY_READOUT} · {draft.isotope} · {draft.shape.toUpperCase()}
      </p>
      {!isLauncher ? (
        <div className="card">
          <p className="meta">// Connect the launcher wallet to continue.</p>
          <WalletConnect />
        </div>
      ) : null}

      <h2>Scout</h2>
      {!proposals ? (
        <p className="meta">// Waiting for Scout&apos;s proposals. {EMPTY_READOUT}</p>
      ) : (
        <Proposals
          ev={proposals}
          disabled={!isLauncher || proposalsAnswered || busy}
          onChoose={(narrative, name) =>
            run(async () => {
              const signature = await signText(messages.chooseNarrative({ launchId: draft.launchId, proposalsEventId: proposals.id, narrative, name }));
              await postJson(`/api/launch/${draft.launchId}/choice`, { proposalsEventId: proposals.id, narrative, name, signature });
              await refreshAnswered();
            })
          }
          answered={proposalsAnswered}
        />
      )}

      <h2>Forge</h2>
      {v?.latestDraft ? (
        <div className="card" data-testid="forge-output">
          <p className="wordmark" style={{ fontSize: 28 }}>
            ${v.latestDraft.payload.ticker}
          </p>
          <p>{v.latestDraft.payload.name}</p>
          <p className="meta">{v.latestDraft.payload.lore}</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={v.latestDraft.payload.logoUri} alt={`${v.latestDraft.payload.name} logo`} width={128} height={128} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={v.latestDraft.payload.bannerUri} alt={`${v.latestDraft.payload.name} banner`} style={{ width: '100%', height: 'auto' }} />
          <a href={v.latestDraft.payload.siteUri} target="_blank" rel="noreferrer">
            site
          </a>
        </div>
      ) : (
        <p className="meta">{EMPTY_READOUT}</p>
      )}

      <h2>Sentinel</h2>
      <SentinelReportView score={score} />
      {score && !score.payload.passed && !scoreAnswered ? (
        <Revise
          disabled={!isLauncher || busy}
          onSubmit={(r) =>
            run(async () => {
              const signature = await signText(messages.revise({ launchId: draft.launchId, scoreEventId: score.id, ...r }));
              await postJson(`/api/launch/${draft.launchId}/revise`, { scoreEventId: score.id, ...r, signature });
              await refreshAnswered();
            })
          }
        />
      ) : null}

      <h2>Approve</h2>
      {v && v.pending.length ? <ApprovalCards pending={v.pending} launcherWallet={launcher} /> : <p className="meta">// No pending approvals.</p>}

      <h2>Deploy</h2>
      {deploying ? (
        tx ? (
          <div className="card">
            <p className="meta">// Mint {tx.mint}. Your wallet signs and pays the launch; Carbon never holds your keys.</p>
            <button
              type="button"
              className="primary"
              disabled={!isLauncher || busy}
              onClick={() =>
                void run(async () => {
                  const signedTx = await signTx(tx.txBase64);
                  await postJson(`/api/launch/${draft.launchId}/tx`, { requestId: tx.requestId, signedTx });
                  setTx(null);
                })
              }
            >
              Sign launch transaction
            </button>
          </div>
        ) : (
          <p className="meta">// Treasurer is building the launch transaction…</p>
        )
      ) : (
        <p className="meta">{v?.deployed ? `Deployed: ${v.deployed.payload.ca}` : EMPTY_READOUT}</p>
      )}

      {err ? <p className="error-text">{err}</p> : null}
      {v?.errors.length ? (
        <ul className="plain">
          {v.errors.map((e) => (
            <li key={e.id} className="error-text">
              {e.payload.agent ? `${e.payload.agent.toUpperCase()}: ` : ''}
              {e.payload.message}
            </li>
          ))}
        </ul>
      ) : null}

      <h2>Thinking</h2>
      <ThinkingFeed reasoning={v?.reasoning ?? []} />

      <div className="row" style={{ marginTop: 24 }}>
        <button
          type="button"
          onClick={() => {
            try {
              sessionStorage.removeItem(DRAFT_KEY);
            } catch {
              /* ignore */
            }
            setDraft(newDraft());
            setAnswered(new Set());
          }}
        >
          Start a new launch
        </button>
      </div>
    </div>
  );
}

function Proposals({
  ev,
  disabled,
  answered,
  onChoose,
}: {
  ev: NonNullable<ReturnType<typeof deriveLaunchView>['proposals']>;
  disabled: boolean;
  answered: boolean;
  onChoose: (narrative: number, name: number) => void;
}) {
  const [pick, setPick] = useState<[number, number] | null>(null);
  return (
    <div data-testid="scout-proposals">
      {ev.payload.narratives.map((n, i) => (
        <div key={i} className="card">
          <p>
            <strong>{n.title}</strong>
          </p>
          <p className="meta">{n.why}</p>
          {n.sources.length ? (
            <p className="meta">
              sources:{' '}
              {n.sources.map((s, k) => (
                <a key={k} href={s} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>
                  [{k + 1}]
                </a>
              ))}
            </p>
          ) : (
            <p className="meta">sources: {EMPTY_READOUT}</p>
          )}
          <div className="chips">
            {n.names.map((nm, j) => (
              <button key={j} type="button" disabled={disabled} aria-pressed={pick?.[0] === i && pick?.[1] === j} className={pick?.[0] === i && pick?.[1] === j ? 'chip on' : 'chip'} onClick={() => setPick([i, j])}>
                {nm.name} ${nm.ticker}
              </button>
            ))}
          </div>
        </div>
      ))}
      {answered ? (
        <p className="meta">// Choice sent. Forge is working.</p>
      ) : (
        <button type="button" className="primary" disabled={disabled || !pick} onClick={() => pick && onChoose(pick[0], pick[1])}>
          Sign and choose
        </button>
      )}
    </div>
  );
}

function Revise({ disabled, onSubmit }: { disabled: boolean; onSubmit: (r: { stop: boolean; name: string; ticker: string; note: string; newArt: boolean }) => void }) {
  const [name, setName] = useState('');
  const [ticker, setTicker] = useState('');
  const [note, setNote] = useState('');
  const [newArt, setNewArt] = useState(false);
  return (
    <div className="card" data-testid="revise">
      <p className="hud-label">REVISE AND RE-RUN</p>
      <label className="meta" htmlFor="rev-name">// new name (optional)</label>
      <input id="rev-name" type="text" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} />
      <label className="meta" htmlFor="rev-ticker">// new ticker (optional)</label>
      <input id="rev-ticker" type="text" maxLength={13} value={ticker} onChange={(e) => setTicker(e.target.value)} />
      <label className="meta" htmlFor="rev-note">// note for Forge (optional)</label>
      <input id="rev-note" type="text" maxLength={280} value={note} onChange={(e) => setNote(e.target.value)} />
      <label className="row meta">
        <input type="checkbox" checked={newArt} onChange={(e) => setNewArt(e.target.checked)} /> new logo and banner
      </label>
      <div className="row">
        <button type="button" className="primary" disabled={disabled} onClick={() => onSubmit({ stop: false, name: name.trim(), ticker: ticker.trim(), note: note.trim(), newArt })}>
          Sign and re-run
        </button>
        <button type="button" disabled={disabled} onClick={() => onSubmit({ stop: true, name: '', ticker: '', note: '', newArt: false })}>
          Stop
        </button>
      </div>
    </div>
  );
}
