/**
 * Story copy. Lines quoted in SPEC §5 are verbatim; everything else is short,
 * factual and true of the product as specified. No numbers, hashes or launches
 * live here: those only ever come from props carrying real event ids.
 */
import { EMPTY_GRAPHENE } from '@argon/core/contracts';

export const COPY = {
  liveTag: 'LIVE',
  replayTag: 'REPLAY',

  hero: {
    wordmark: 'ARGON',
    meta: ['// Element 18', '// Agents that bond.'],
    manifestoHead: '////// Manifesto',
    manifesto: [
      'Six AI agents form one nucleus.',
      'Every bond is a signed hand-off.',
      'You approve every launch.',
      'Posts need your approval unless you turn on posts autopilot (off by default).',
    ],
    dragHint: '// Drag to rotate',
    scrollHint: '// Scroll',
  },
  dismantle: {
    head: '////// 01 Dismantle',
    lines: ['// Real argon: 18 protons', '// Shown: the six agent protons, with their neutrons'],
  },
  glitch: {
    head: '////// 02 Isolate',
    lines: ['// Separating the protons'],
  },
  protons: {
    head: '////// 03 Six agents',
    note: '18 protons make it argon. Six agents at the core make it an Argon launch.',
    explore: 'CLICK TO EXPLORE',
    liveReadouts: '// Readouts: live agent stats',
  },
  shells: {
    head: '////// 04 Shells',
    note: 'Real argon is a noble gas and almost never bonds. These agents do: each has exactly 4 bond arms.',
    lines: ['// Real argon: shells of 2 · 8 · 8 electrons, all full', '// Each agent: 4 bond arms (at most 4 bond orders)'],
  },
  bonding: {
    head: '////// 05 Bonding',
    kinds: [
      { label: 'BOND_SINGLE', copy: 'light hand-off', rule: '// 1 hand-off in 60 s' },
      { label: 'BOND_DOUBLE', copy: 'partnership', rule: '// 3+ exchanges in 60 s' },
      { label: 'BOND_TRIPLE', copy: 'locked team', rule: '// 8+ exchanges, or both blocked on each other' },
    ],
    hashNote: '// The message hash rides the seam',
    realHashNote: '// Hashes shown: latest real hand-offs',
    noHashNote: '// No hand-offs recorded yet',
  },
  chamber: {
    head: '////// 06 Isotope chamber',
    readouts: ['NEUTRONS', 'STABILITY', 'DECAY_RULE', 'BEHAVIOUR'] as const,
    heavyHint: '// Drag the heavy neutron onto a proton',
    heavyPick: '// Or pick the heavy agent',
  },
  shapes: {
    head: '////// 07 Shapes',
    threshold: 'SENTINEL ≥',
  },
  launch: {
    head: '////// 08 The launch',
    emptyTitle: 'NO_LAUNCH_RECORDED',
    empty: 'No launch has been recorded yet. The first real launch will replay here.',
    ca: 'CA',
    score: 'STABILITY',
    handoffs: 'HAND-OFFS',
  },
  live: {
    head: '////// 09 Live',
    empty: EMPTY_GRAPHENE,
    launch: 'Launch',
    feedHead: '// agent reasoning',
    feedEmpty: '// No reasoning logged yet',
    receiptsHead: '// receipts',
    receiptsEmpty: '// No fee splits yet',
    fly: '// Click a crystal to fly in',
  },
  sound: { on: 'Sound: On', off: 'Sound: Off' },
} as const;
