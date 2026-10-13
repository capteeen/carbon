'use client';
/**
 * Detail panel for a clicked agent sphere (or a neutron). Everything shown
 * comes from core's contracts (AGENT_ROLES, AGENT_DETAILS, ISOTOPES, SHAPES,
 * launchConfig), so it always matches the code that runs launches. It is not
 * modal: the page keeps scrolling; Esc, the close button or a click outside closes it.
 */
import { useEffect, useRef } from 'react';
import {
  AGENT_DETAILS,
  AGENT_ROLES,
  ISOTOPES,
  ISOTOPE_IDS,
  SHAPES,
  SHAPE_IDS,
  launchConfig,
  protonLabel,
  type AgentId,
  type IsotopeId,
  type ShapeId,
} from '@argon/core/contracts';
import type { InspectTarget } from '../three/inspect.js';

const cap = (s: string) => s.toUpperCase();

/** The one limit per launch type that matters most for this agent. */
function agentLimit(agent: AgentId, iso: IsotopeId, shape: ShapeId): string {
  const heavy = ISOTOPES[iso].heavyAgent ? agent : null;
  const c = launchConfig(iso, shape, heavy);
  const mark = heavy ? '*' : '';
  switch (agent) {
    case 'herald':
      return `${c.postsPerHour}${mark} posts/h`;
    case 'keeper':
      return `${c.repliesPerHour}${mark} replies/h`;
    case 'treasurer':
      return `${c.devBuySol} SOL dev buy · ${c.buybackSolPerTick} SOL/buyback`;
    case 'sentinel':
      return `passes at ${c.sentinelThreshold} · ${c.capacity[agent].llmCallsPerHour}${mark} calls/h`;
    default:
      return `${c.capacity[agent].llmCallsPerHour}${mark} calls/h`;
  }
}

function isotopeEffect(agent: AgentId, iso: IsotopeId): string {
  const s = ISOTOPES[iso];
  if (s.heavyAgent) return `If you choose ${cap(agent)} as the heavy agent, its capacity doubles${agent === 'herald' ? ', and so do posts per hour' : agent === 'keeper' ? ', and so do replies per hour' : ''}.`;
  if (s.budgetMultiplier !== 1) return `Budgets are ×${s.budgetMultiplier}. ${s.behaviour}`;
  return s.behaviour;
}

function bondsWith(agent: AgentId, shape: ShapeId): string {
  const partners = SHAPES[shape].topology
    .map((k) => k.split('|') as [AgentId, AgentId])
    .filter(([a, b]) => a === agent || b === agent)
    .map(([a, b]) => cap(a === agent ? b : a));
  return partners.join(', ') || 'none';
}

function AgentBody({ agent, onOpenLog }: { agent: AgentId; onOpenLog?: (a: AgentId) => void }) {
  const d = AGENT_DETAILS[agent];
  return (
    <>
      <div className="argon-hud__meta">{protonLabel(agent)}</div>
      <h2 className="argon-title" id="argon-agent-title">
        {cap(agent)}
      </h2>
      <p className="argon-hud__note">{AGENT_ROLES[agent]}</p>

      <div className="argon-agent__head">WHAT_IT_DOES</div>
      <ol className="argon-agent__list">
        {d.does.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ol>
      <div className="argon-agent__head">INPUTS</div>
      <ul className="argon-agent__list">
        {d.inputs.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <div className="argon-agent__head">OUTPUTS</div>
      <ul className="argon-agent__list">
        {d.outputs.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <div className="argon-agent__head">APPROVAL</div>
      <p className="argon-agent__p">{d.approval}</p>
      <div className="argon-agent__head">NEVER</div>
      <ul className="argon-agent__list">
        {d.never.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>

      <div className="argon-agent__head">BONDS_WITH</div>
      <ul className="argon-agent__list">
        {SHAPE_IDS.map((sh) => (
          <li key={sh}>
            {SHAPES[sh].label}: {bondsWith(agent, sh)}
          </li>
        ))}
      </ul>

      <div className="argon-agent__head">BY_ISOTOPE</div>
      <ul className="argon-agent__list">
        {ISOTOPE_IDS.map((iso) => (
          <li key={iso}>
            <span className="argon-agent__key">{iso}</span> {isotopeEffect(agent, iso)}
          </li>
        ))}
      </ul>
      <div className="argon-agent__scroll">
        <table className="argon-agent__table">
          <thead>
            <tr>
              <th scope="col">LIMITS</th>
              {SHAPE_IDS.map((sh) => (
                <th key={sh} scope="col">
                  {cap(sh)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ISOTOPE_IDS.map((iso) => (
              <tr key={iso}>
                <th scope="row">{iso}</th>
                {SHAPE_IDS.map((sh) => (
                  <td key={sh}>{agentLimit(agent, iso, sh)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="argon-hud__meta">{'// * when this agent is the Ar-40 heavy agent'}</p>
      {onOpenLog ? (
        <button type="button" className="argon-hud__btn" onClick={() => onOpenLog(agent)} data-testid="agent-panel-log">
          [ LIVE LOG ]
        </button>
      ) : null}
    </>
  );
}

function NeutronBody() {
  return (
    <>
      <div className="argon-hud__meta">NEUTRON</div>
      <h2 className="argon-title" id="argon-agent-title">
        NEUTRONS
      </h2>
      <p className="argon-hud__note">
        The six protons are the agents. Neutrons are not agents: their count is the launch&apos;s isotope, which sets how the coin behaves.
      </p>
      <ul className="argon-agent__list">
        {ISOTOPE_IDS.map((iso) => (
          <li key={iso}>
            <span className="argon-agent__key">
              {iso} · {ISOTOPES[iso].neutrons} neutrons · {ISOTOPES[iso].name}
            </span>{' '}
            {ISOTOPES[iso].behaviour}
          </li>
        ))}
      </ul>
    </>
  );
}

export function AgentPanel({ target, onClose, onOpenLog }: { target: InspectTarget | null; onClose: () => void; onOpenLog?: (a: AgentId) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!target) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // a press outside closes it (a press on another agent then reopens it with that agent)
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', down, true);
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('pointerdown', down, true);
    };
  }, [target, onClose]);
  if (!target) return null;
  return (
    <div
      ref={ref}
      className="argon-agent"
      role="dialog"
      aria-modal="false"
      aria-labelledby="argon-agent-title"
      data-testid="agent-panel"
      data-agent={target.kind === 'agent' ? target.agent : 'neutron'}
      data-lenis-prevent
    >
      <button ref={closeRef} type="button" className="argon-hud__btn argon-agent__close" onClick={onClose} aria-label="Close" data-testid="agent-panel-close">
        [ CLOSE ]
      </button>
      {target.kind === 'agent' ? <AgentBody agent={target.agent} onOpenLog={onOpenLog} /> : <NeutronBody />}
    </div>
  );
}
