/**
 * Pure geometry layouts: molecule shapes and the graphene hex spiral.
 * Plain tuples so they are testable without three.
 */
import { AGENT_IDS, SHAPES, pairKey, type AgentId, type PairKey, type ShapeId } from '@argon/core/contracts';

export type V3 = [number, number, number];

export interface MoleculeLayout {
  /** Position per agent (AGENT_IDS order). */
  atoms: Record<AgentId, V3>;
  /** Edges drawn in the illustration. */
  edges: PairKey[];
}

/**
 * CHAIN: zig-zag Scout→Forge→Sentinel→Herald with Treasurer on Sentinel and Keeper on Herald (SHAPES.chain.topology).
 * RING: benzene hexagon in SHAPES.ring.topology order.
 * DIAMOND: octahedral lattice cell; each agent holds exactly 4 bonds (valence 4).
 */
export function moleculeLayout(shape: ShapeId): MoleculeLayout {
  switch (shape) {
    case 'chain': {
      const z = 0.32;
      return {
        atoms: {
          scout: [-1.5, -z, 0],
          forge: [-0.5, z, 0],
          sentinel: [0.5, -z, 0],
          herald: [1.5, z, 0],
          treasurer: [0.5, -z - 1.0, 0],
          keeper: [1.5, z + 1.0, 0],
        },
        edges: [...SHAPES.chain.topology],
      };
    }
    case 'ring': {
      const order: AgentId[] = ['scout', 'forge', 'sentinel', 'treasurer', 'herald', 'keeper'];
      const atoms = {} as Record<AgentId, V3>;
      order.forEach((a, i) => {
        const ang = Math.PI / 2 - (i * Math.PI) / 3;
        atoms[a] = [Math.cos(ang) * 1.15, Math.sin(ang) * 1.15, 0];
      });
      return { atoms, edges: [...SHAPES.ring.topology] };
    }
    case 'diamond': {
      const r = 1.15;
      const atoms: Record<AgentId, V3> = {
        scout: [r, 0, 0],
        forge: [-r, 0, 0],
        herald: [0, r, 0],
        keeper: [0, -r, 0],
        treasurer: [0, 0, r],
        sentinel: [0, 0, -r],
      };
      const opposite: Record<AgentId, AgentId> = { scout: 'forge', forge: 'scout', herald: 'keeper', keeper: 'herald', treasurer: 'sentinel', sentinel: 'treasurer' };
      const edges: PairKey[] = [];
      AGENT_IDS.forEach((a, i) =>
        AGENT_IDS.slice(i + 1).forEach((b) => {
          if (opposite[a] !== b) edges.push(pairKey(a, b));
        }),
      );
      return { atoms, edges };
    }
  }
}

/** Number of edges touching each agent in a layout. */
export function degree(layout: MoleculeLayout): Record<AgentId, number> {
  const d = Object.fromEntries(AGENT_IDS.map((a) => [a, 0])) as Record<AgentId, number>;
  for (const e of layout.edges) {
    const [a, b] = e.split('|') as [AgentId, AgentId];
    d[a]++;
    d[b]++;
  }
  return d;
}

const DIRS: [number, number][] = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

/** Axial hex coordinate of the n-th cell of a spiral (0 = centre). */
export function hexSpiral(n: number): [number, number] {
  if (n <= 0) return [0, 0];
  let k = 1;
  let first = 1;
  while (first + 6 * k <= n) {
    first += 6 * k;
    k++;
  }
  let idx = n - first;
  let q = DIRS[4]![0] * k;
  let r = DIRS[4]![1] * k;
  for (let side = 0; side < 6; side++) {
    for (let j = 0; j < k; j++) {
      if (idx === 0) return [q, r];
      idx--;
      q += DIRS[side]![0];
      r += DIRS[side]![1];
    }
  }
  return [q, r];
}

/** Lattice scale shared with the plain shader's hex pattern (pattern space = world × 0.75). */
export const GRAPHENE_SCALE = 0.75;

/** World xz of a hex cell centre, aligned with the graphene shader's lattice. */
export function hexCellWorld(q: number, r: number): [number, number] {
  const px = 0.5 + q + r * 0.5;
  const py = 0.8660254 + r * 0.8660254;
  return [px / GRAPHENE_SCALE, py / GRAPHENE_SCALE];
}
