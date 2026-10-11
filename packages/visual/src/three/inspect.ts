'use client';
/**
 * Click / tap any agent sphere (or a neutron) to open its detail panel. The
 * story passes an `inspect` handle through the Stage kit; every scene object
 * that draws agents attaches these handlers, so the same click works in every
 * chapter. Hidden objects never respond (r3f raycasts invisible meshes too).
 */
import type { ThreeEvent } from '@react-three/fiber';
import type { Object3D } from 'three';
import type { AgentId } from '@carbon/core/contracts';

export type InspectTarget = { kind: 'agent'; agent: AgentId } | { kind: 'neutron' };

export interface InspectApi {
  open(target: InspectTarget): void;
}

/** Pixels the pointer may travel between down and up and still count as a click (drags rotate the atom). */
const CLICK_SLOP_PX = 8;

/** Visible all the way up. A hit proxy (an invisible, larger copy used only for clicks) skips its own flag. */
function shown(o: Object3D | null): boolean {
  for (let n = o; n; n = n.parent) if (!n.visible && !(n === o && n.userData.hitProxy)) return false;
  return true;
}

let hoverCount = 0;
function setHover(on: boolean): void {
  if (typeof document === 'undefined') return;
  hoverCount = Math.max(0, hoverCount + (on ? 1 : -1));
  document.body.style.cursor = hoverCount > 0 ? 'pointer' : '';
}

/**
 * r3f handlers for a mesh or instanced mesh. `resolve` maps the hit
 * (instanceId for instanced meshes) to a target, or null when that part is
 * not inspectable right now. `onHover` receives the hovered instance (or null).
 */
export function inspectHandlers(
  inspect: InspectApi | null,
  resolve: (instanceId: number | undefined) => InspectTarget | null,
  onHover?: (instanceId: number | null) => void,
) {
  let over = false;
  const leave = () => {
    if (over) setHover(false);
    over = false;
    onHover?.(null);
  };
  const hover = (e: ThreeEvent<PointerEvent>) => {
    if (!inspect) return;
    const target = shown(e.object) ? resolve(e.instanceId) : null;
    if (!target) return leave();
    e.stopPropagation();
    if (!over) setHover(true);
    over = true;
    onHover?.(e.instanceId ?? 0);
  };
  return {
    onPointerOver: hover,
    onPointerMove: hover,
    onPointerOut: leave,
    onClick: (e: ThreeEvent<MouseEvent>) => {
      if (!inspect || e.delta > CLICK_SLOP_PX || !shown(e.object)) return;
      const target = resolve(e.instanceId);
      if (!target) return;
      e.stopPropagation();
      inspect.open(target);
    },
  };
}
