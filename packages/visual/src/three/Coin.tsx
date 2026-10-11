'use client';
/** Frosted coin (ch08 / launch views). Ticker engraved on the face only when it comes from a real launch. */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Group, LatheGeometry, PlaneGeometry, Vector2, type Mesh } from 'three';
import { COLORS, createFrostMaterial, createLabelMaterial } from './materials.js';
import type { MutableNumber } from './Molecule.js';
import { useKit } from './Stage.js';
import { textTexture } from './textures.js';
import type { LeaderAnchor } from '../hud/leaders.js';

function coinProfile(): Vector2[] {
  const r = 1.0;
  const t = 0.12;
  const pts: Vector2[] = [new Vector2(0, -t)];
  pts.push(new Vector2(r * 0.86, -t));
  pts.push(new Vector2(r * 0.94, -t * 1.05));
  pts.push(new Vector2(r, -t * 0.7));
  pts.push(new Vector2(r * 1.02, 0));
  pts.push(new Vector2(r, t * 0.7));
  pts.push(new Vector2(r * 0.94, t * 1.05));
  pts.push(new Vector2(r * 0.86, t));
  pts.push(new Vector2(r * 0.8, t * 0.8));
  pts.push(new Vector2(0, t * 0.8));
  return pts;
}

export function Coin({ visibility, ticker, anchor, anchorFade }: { visibility?: MutableNumber; ticker?: string | null; anchor?: LeaderAnchor; anchorFade?: MutableNumber }) {
  const kit = useKit();
  const group = useRef<Group>(null);
  const face = useRef<Mesh>(null);
  const res = useMemo(() => {
    const geo = new LatheGeometry(coinProfile(), 96);
    geo.rotateX(Math.PI / 2);
    const mat = createFrostMaterial(kit.shared, { base: COLORS.frost, shade: COLORS.slate, rough: 0.5 });
    const faceGeo = new PlaneGeometry(1, 1);
    const faceMat = createLabelMaterial(COLORS.slate);
    faceMat.depthTest = true;
    return { geo, mat, faceGeo, faceMat };
  }, [kit.shared]);
  useEffect(
    () => () => {
      res.geo.dispose();
      res.mat.dispose();
      res.faceGeo.dispose();
      res.faceMat.dispose();
    },
    [res],
  );
  const text = useMemo(() => (ticker ? textTexture('$' + ticker.replace(/^\$/, '').toUpperCase(), { bold: true }) : null), [ticker]);
  useEffect(() => {
    res.faceMat.uniforms.uMap.value = text?.tex ?? null;
  }, [text, res]);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const v = visibility ? visibility.value : 1;
    g.visible = v > 0.005;
    if (!g.visible) {
      if (anchor) anchor.opacity = 0;
      return;
    }
    const t = kit.shared.uTime.value;
    g.scale.setScalar(Math.max(0.001, v));
    g.rotation.set(0.18 + 0.05 * Math.sin(t * 0.6), 0.6 * Math.sin(t * 0.35) + (1 - v) * 3, 0);
    res.mat.uniforms.uIrid.value = (1 - v) * 0.8;
    const f = face.current;
    if (f) {
      f.visible = !!text;
      if (text) f.scale.set(0.42 * text.aspect * 0.5, 0.42 * 0.5 * 1.0, 1);
      res.faceMat.uniforms.uOpacity.value = 0.75 * v;
    }
    if (anchor) {
      g.updateMatrixWorld();
      anchor.world.set(0.9, 0.7, 0).applyMatrix4(g.matrixWorld);
      anchor.opacity = v * (anchorFade ? anchorFade.value : 1);
    }
  });
  return (
    <group ref={group}>
      <mesh geometry={res.geo} material={res.mat} />
      <mesh ref={face} geometry={res.faceGeo} material={res.faceMat} position={[0, 0, 0.1]} />
    </group>
  );
}
