import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AGENT_DETAILS, AGENT_IDS, AGENT_ROLES, launchConfig } from '@argon/core/contracts';
import { AgentPanel } from '../src/hud/AgentPanel.js';

const noop = () => undefined;

describe('agent detail panel', () => {
  it('renders nothing when closed', () => {
    expect(renderToStaticMarkup(<AgentPanel target={null} onClose={noop} />)).toBe('');
  });

  it.each(AGENT_IDS)('shows %s from the contracts', (agent) => {
    const html = renderToStaticMarkup(<AgentPanel target={{ kind: 'agent', agent }} onClose={noop} />);
    expect(html).toContain(AGENT_ROLES[agent].replace(/'/g, '&#x27;'));
    for (const line of AGENT_DETAILS[agent].does) expect(html).toContain(line.replace(/'/g, '&#x27;'));
    for (const h of ['WHAT_IT_DOES', 'INPUTS', 'OUTPUTS', 'APPROVAL', 'BONDS_WITH', 'BY_ISOTOPE', 'Ar-41', 'Ar-39']) expect(html).toContain(h);
  });

  it('limits come from launchConfig (Ar-40 heavy Herald doubles posts)', () => {
    const html = renderToStaticMarkup(<AgentPanel target={{ kind: 'agent', agent: 'herald' }} onClose={noop} />);
    expect(html).toContain(`${launchConfig('Ar-40', 'ring', 'herald').postsPerHour}* posts/h`);
    expect(html).toContain(`${launchConfig('Ar-41', 'chain').postsPerHour} posts/h`);
  });

  it('a neutron explains isotopes', () => {
    const html = renderToStaticMarkup(<AgentPanel target={{ kind: 'neutron' }} onClose={noop} />);
    expect(html).toContain('8 neutrons');
    expect(html).toContain('data-agent="neutron"');
  });
});
