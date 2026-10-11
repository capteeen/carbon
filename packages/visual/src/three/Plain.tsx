'use client';
/** The frozen, faintly crystalline graphite plain; blends into the graphene hex sheet (ch09). */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { PlaneGeometry, type Mesh } from 'three';
import { createPlainMaterial } from './materials.js';
import { useKit } from './Stage.js';
import type { MutableNumber } from './Molecule.js';

export const PLAIN_Y = -2.2;

export function Plain({ visibility, graphene, y = PLAIN_Y }: { visibility?: MutableNumber; graphene?: MutableNumber; y?: number }) {
  const kit = useKit();
  const mesh = useRef<Mesh>(null);
  const res = useMemo(() => {
    const geo = new PlaneGeometry(60, 60, 1, 1);
    geo.rotateX(-Math.PI / 2);
    return { geo, mat: createPlainMaterial(kit.shared) };
  }, [kit.shared]);
  useEffect(
    () => () => {
      res.geo.dispose();
      res.mat.dispose();
    },
    [res],
  );
  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    const v = visibility ? visibility.value : 1;
    m.visible = v > 0.005;
    res.mat.uniforms.uOpacity.value = v;
    res.mat.uniforms.uGraphene.value = graphene ? graphene.value : 0;
  });
  return <mesh ref={mesh} geometry={res.geo} material={res.mat} position={[0, y, 0]} renderOrder={-1} />;
}
