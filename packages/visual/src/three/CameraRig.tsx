'use client';
import { useFrame, useThree } from '@react-three/fiber';
import { useMemo } from 'react';
import { Vector3, type PerspectiveCamera } from 'three';
import { fitFor } from '../story/timeline.js';

/**
 * Static framing for standalone views: camera at `position`, looking at
 * `target`, pushed back on portrait screens by `fit` (0 = no push, 1 = full).
 * Optional slow drift (disabled when the kit is still).
 */
export function CameraRig({
  position,
  target = [0, 0, 0],
  fit = 1,
  fov = 38,
  focus,
}: {
  position: [number, number, number];
  target?: [number, number, number];
  fit?: number;
  fov?: number;
  /** Optional mutable focus override (fly-in): t 0..1 toward `point`. */
  focus?: { t: number; point: Vector3 };
}) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);
  const s = useMemo(() => ({ look: new Vector3(), pos: new Vector3(), tmp: new Vector3() }), []);
  useFrame(() => {
    const f = 1 + (fitFor(size.width / Math.max(1, size.height)) - 1) * fit;
    s.look.set(target[0], target[1], target[2]);
    s.pos.set(position[0], position[1], position[2]).sub(s.look).multiplyScalar(f).add(s.look);
    if (focus && focus.t > 0) {
      const e = focus.t * focus.t * (3 - 2 * focus.t);
      s.tmp.set(focus.point.x, focus.point.y + 1.6, focus.point.z + 1.8);
      s.pos.lerp(s.tmp, e);
      s.look.lerp(focus.point, e);
    }
    camera.position.copy(s.pos);
    camera.lookAt(s.look);
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }, -2);
  return null;
}
