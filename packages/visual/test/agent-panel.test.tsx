import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AGENT_DETAILS, AGENT_IDS, AGENT_ROLES, launchConfig } from '@carbon/core/contracts';
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
    for (const h of ['WHAT_IT_DOES', 'INPUTS', 'OUTPUTS', 'APPROVAL', 'BONDS_WITH', 'BY_ISOTOPE', 'C-11', 'C-14']) expect(html).toContain(h);
  });

  it('limits come from launchConfig (C-13 heavy Herald doubles posts)', () => {
    const html = renderToStaticMarkup(<AgentPanel target={{ kind: 'agent', agent: 'herald' }} onClose={noop} />);
    expect(html).toContain(`${launchConfig('C-13', 'ring', 'herald').postsPerHour}* posts/h`);
    expect(html).toContain(`${launchConfig('C-11', 'chain').postsPerHour} posts/h`);
  });

  it('a neutron explains isotopes', () => {
    const html = renderToStaticMarkup(<AgentPanel target={{ kind: 'neutron' }} onClose={noop} />);
    expect(html).toContain('8 neutrons');
    expect(html).toContain('data-agent="neutron"');
  });
});
