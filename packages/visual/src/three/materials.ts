/**
 * Frosted, matte-icy, physically lit materials as one cheap custom shader
 * family (GGX specular + wrapped Lambert + hemisphere ambient + back-scatter),
 * so phones never pay for a transmission pass. Colours are the palette only;
 * the one exception is the iridescent thin-film term, gated by `uIrid` /
 * flash uniforms, which the timeline only raises during transitions and real
 * bond/hash flashes.
 *
 * All materials share one uniform block (`SHARED`), updated once per frame.
 */
import {
  AdditiveBlending,
  DoubleSide,
  NormalBlending,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Texture,
} from 'three';
import { BLOCK_SIGNAL, PALETTE, hexToRgb01 } from '../tokens.js';

const v3 = (hex: string) => new Vector3(...hexToRgb01(hex));

export const COLORS = {
  fogLight: v3(PALETTE.fogLight),
  fogMid: v3(PALETTE.fogMid),
  slate: v3(PALETTE.slate),
  frost: v3(PALETTE.frost),
  ink: v3(PALETTE.ink),
  block: v3(BLOCK_SIGNAL),
} as const;

export interface SharedUniforms {
  uTime: { value: number };
  /** Point-cloud fraction from the quality ladder. */
  uPoints: { value: number };
  uPixelRatio: { value: number };
  /** Freeze factor for reduced motion (0 = frozen). */
  uMotion: { value: number };
  /** Eased cursor/touch position in canvas NDC, its velocity (NDC-height units/s) and presence 0..1. */
  uPointer: { value: Vector2 };
  uPointerVel: { value: Vector2 };
  uPointerForce: { value: number };
  /** Canvas width / height. */
  uAspect: { value: number };
}

export function createSharedUniforms(): SharedUniforms {
  return {
    uTime: { value: 0 },
    uPoints: { value: 1 },
    uPixelRatio: { value: 1 },
    uMotion: { value: 1 },
    uPointer: { value: new Vector2(9, 9) },
    uPointerVel: { value: new Vector2() },
    uPointerForce: { value: 0 },
    uAspect: { value: 1 },
  };
}

/** The pointer uniforms every point cloud links to (same objects, so one write per frame drives all). */
function pointerUniforms(shared: SharedUniforms) {
  return { uPointer: shared.uPointer, uPointerVel: shared.uPointerVel, uPointerForce: shared.uPointerForce, uAspect: shared.uAspect };
}

/**
 * Cursor/touch push for point clouds, in screen space so it works at any depth
 * and in every scene: points near the pointer are pushed away from it and
 * dragged a little along its motion, then ease back as the pointer leaves.
 * Takes and returns a view-space position.
 */
const POINTER_PUSH = /* glsl */ `
uniform vec2 uPointer;
uniform vec2 uPointerVel;
uniform float uPointerForce;
uniform float uAspect;
vec4 pointerPush(vec4 mv) {
  if (uPointerForce < 0.001) return mv;
  vec4 clip = projectionMatrix * mv;
  if (clip.w <= 0.0) return mv;
  vec2 d = (clip.xy / clip.w - uPointer) * vec2(uAspect, 1.0);
  float r2 = dot(d, d);
  float fall = exp(-r2 * 11.0);
  vec2 push = (d * inversesqrt(r2 + 1e-4) * 0.15 + uPointerVel * 0.04) * fall * uPointerForce;
  // NDC-height units -> view space at this depth (same scale on both axes)
  mv.xy += push * clip.w / projectionMatrix[1][1];
  return mv;
}
`;

const COMMON = /* glsl */ `
vec3 toLin(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
vec3 thinFilm(float x) {
  return 0.5 + 0.5 * cos(6.28318 * (x + vec3(0.0, 0.33, 0.67)));
}
`;

const FROST_VERT = /* glsl */ `
#ifdef FROST_INSTANCED_ATTRS
attribute float aEmblem;
attribute float aGlow;
attribute float aFade;
#endif
uniform float uEmblem;
varying vec3 vN;
varying vec3 vObjN;
varying vec3 vObjPos;
varying vec3 vWorld;
varying float vEmblem;
varying float vGlow;
varying float vFade;
void main() {
  mat4 m = modelMatrix;
#ifdef USE_INSTANCING
  m = modelMatrix * instanceMatrix;
#endif
  vec4 world = m * vec4(position, 1.0);
  vWorld = world.xyz;
  vN = normalize(mat3(m) * normal);
  vObjN = normal;
  vObjPos = position;
#ifdef FROST_INSTANCED_ATTRS
  vEmblem = aEmblem;
  vGlow = aGlow;
  vFade = aFade;
#else
  vEmblem = uEmblem;
  vGlow = 0.0;
  vFade = 1.0;
#endif
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FROST_FRAG = /* glsl */ `
uniform vec3 uBase;
uniform vec3 uShade;
uniform vec3 uFrost;
uniform float uTime;
uniform float uIrid;
uniform float uOpacity;
uniform float uGlow;
uniform float uDim;
uniform float uRough;
uniform float uFresnelAlpha;
uniform float uEmblemStrength;
uniform sampler2D uAtlas;
varying vec3 vN;
varying vec3 vObjN;
varying vec3 vObjPos;
varying vec3 vWorld;
varying float vEmblem;
varying float vGlow;
varying float vFade;
${COMMON}
void main() {
  if (vFade < 0.004) discard;
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 p = vObjPos * 9.0;
  float fr = vnoise(p * 2.0) * 0.6 + vnoise(p * 5.3) * 0.4;
  vec3 jitter = vec3(vnoise(p * 3.1), vnoise(p * 3.1 + 7.7), vnoise(p * 3.1 + 13.3)) - 0.5;
  vec3 N = normalize(normalize(vN) + jitter * 0.22);
  if (!gl_FrontFacing) N = -N;

  vec3 albedo = mix(toLin(uBase), toLin(uFrost), 0.25 + 0.35 * fr);

  // faint engraved agent emblem (protons only), projected on the object's +Z hemisphere
  float engrave = 0.0;
  float bevel = 0.0;
  if (vEmblem > -0.5) {
    vec3 on = normalize(vObjN);
    if (on.z > 0.15) {
      vec2 uv = clamp(on.xy * 0.66 + 0.5, 0.0, 1.0);
      float col = mod(vEmblem, 3.0);
      float row = floor(vEmblem / 3.0 + 0.01);
      vec2 cell = vec2(1.0 / 3.0, 0.5);
      vec2 auv = (vec2(col, row) + uv) * cell;
      float a = texture2D(uAtlas, auv).a;
      float b = texture2D(uAtlas, auv + vec2(0.0035, -0.005)).a;
      float k = smoothstep(0.15, 0.5, on.z);
      engrave = a * k;
      bevel = (b - a) * k;
    }
  }
  albedo = mix(albedo, toLin(uShade), engrave * uEmblemStrength);

  vec3 L1 = normalize(vec3(0.45, 0.85, 0.42));
  vec3 L2 = normalize(vec3(-0.65, 0.18, -0.5));
  float NoV = max(dot(N, V), 0.0);
  float w = 0.4;
  float d1 = max((dot(N, L1) + w) / (1.0 + w), 0.0);
  float d2 = max((dot(N, L2) + w) / (1.0 + w), 0.0) * 0.3;
  vec3 H = normalize(L1 + V);
  float NoH = max(dot(N, H), 0.0);
  float a = uRough * uRough;
  float a2 = a * a;
  float dd = NoH * NoH * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159 * dd * dd);
  float F = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
  float spec = D * F * 0.22 * max(dot(N, L1), 0.0);
  vec3 amb = mix(toLin(uShade) * 0.55, toLin(uFrost), N.y * 0.5 + 0.5) * 0.5;
  float fres = pow(1.0 - NoV, 2.0);
  float scatter = pow(max(dot(V, -L1), 0.0), 3.0) * 0.2 + fres * 0.38;

  vec3 col = albedo * (amb + d1 * 0.82 + d2) + spec + toLin(uFrost) * scatter;
  col += toLin(uFrost) * bevel * 0.35 * uEmblemStrength;
  col = mix(col, toLin(thinFilm(fres * 1.3 + uTime * 0.12 + vWorld.y * 0.15)) * 1.15, clamp(uIrid, 0.0, 1.0) * fres * 0.85);
  col += toLin(uFrost) * (uGlow + vGlow) * 0.9;
  col *= uDim;

  float alpha = uOpacity * vFade;
  alpha *= mix(1.0, 0.12 + 0.88 * fres, uFresnelAlpha);
  gl_FragColor = vec4(toSrgb(col), alpha);
}
`;

export interface FrostOptions {
  base?: Vector3;
  shade?: Vector3;
  rough?: number;
  opacity?: number;
  /** 0 = solid; 1 = alpha from fresnel (translucent shells). */
  fresnelAlpha?: number;
  instancedAttrs?: boolean;
  atlas?: Texture | null;
  emblem?: number;
  emblemStrength?: number;
  transparent?: boolean;
  doubleSide?: boolean;
}

export type FrostMaterial = ShaderMaterial & {
  uniforms: {
    uIrid: { value: number };
    uOpacity: { value: number };
    uGlow: { value: number };
    uDim: { value: number };
    uEmblem: { value: number };
    uAtlas: { value: Texture | null };
  };
};

export function createFrostMaterial(shared: SharedUniforms, o: FrostOptions = {}): FrostMaterial {
  const transparent = o.transparent ?? (o.fresnelAlpha ?? 0) > 0;
  const m = new ShaderMaterial({
    vertexShader: FROST_VERT,
    fragmentShader: FROST_FRAG,
    defines: o.instancedAttrs ? { FROST_INSTANCED_ATTRS: '' } : {},
    uniforms: {
      uTime: shared.uTime,
      uBase: { value: o.base ?? COLORS.fogLight },
      uShade: { value: o.shade ?? COLORS.slate },
      uFrost: { value: COLORS.frost },
      uIrid: { value: 0 },
      uOpacity: { value: o.opacity ?? 1 },
      uGlow: { value: 0 },
      uDim: { value: 1 },
      uRough: { value: o.rough ?? 0.62 },
      uFresnelAlpha: { value: o.fresnelAlpha ?? 0 },
      uEmblem: { value: o.emblem ?? -1 },
      uEmblemStrength: { value: o.emblemStrength ?? 0.55 },
      uAtlas: { value: o.atlas ?? null },
    },
    transparent,
    depthWrite: !transparent,
    side: o.doubleSide ? DoubleSide : undefined,
  });
  return m as FrostMaterial;
}

// ───────────────────────────── seams ─────────────────────────────

const SEAM_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  mat4 m = modelMatrix;
#ifdef USE_INSTANCING
  m = modelMatrix * instanceMatrix;
#endif
  vec4 w = m * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const SEAM_FRAG = /* glsl */ `
uniform vec3 uFrost;
uniform vec3 uBlock;
uniform float uTime;
uniform float uFlash;   // 0..1, decays after a real hand-off
uniform float uOpacity;
uniform float uBroken;  // 1 = Sentinel block: red, gap in the middle
uniform float uBase;    // resting glow
varying vec2 vUv;
varying vec3 vWorld;
${COMMON}
void main() {
  float along = vUv.y;
  if (uBroken > 0.5) {
    float gap = abs(along - 0.5);
    float jag = 0.06 + 0.03 * sin(vUv.x * 40.0 + along * 30.0);
    if (gap < jag) discard;
  }
  float pulse = 0.65 + 0.35 * sin(along * 18.0 - uTime * 3.0);
  vec3 col = uFrost * (uBase * pulse + 0.15);
  vec3 irid = thinFilm(along * 1.7 - uTime * 0.9 + vUv.x);
  float flick = uFlash * (0.7 + 0.3 * sin(uTime * 41.0 + along * 23.0));
  col = mix(col, mix(uFrost, irid, 0.75) * 1.3, clamp(flick, 0.0, 1.0));
  if (uBroken > 0.5) col = mix(uBlock, uFrost, 0.15 * (0.5 + 0.5 * sin(uTime * 9.0)));
  gl_FragColor = vec4(col, uOpacity * clamp(0.55 + uBase * 0.4 + flick, 0.0, 1.0));
}
`;

export type SeamMaterial = ShaderMaterial & {
  uniforms: { uFlash: { value: number }; uOpacity: { value: number }; uBroken: { value: number }; uBase: { value: number } };
};

export function createSeamMaterial(shared: SharedUniforms): SeamMaterial {
  return new ShaderMaterial({
    vertexShader: SEAM_VERT,
    fragmentShader: SEAM_FRAG,
    uniforms: {
      uTime: shared.uTime,
      uFrost: { value: COLORS.frost },
      uBlock: { value: COLORS.block },
      uFlash: { value: 0 },
      uOpacity: { value: 1 },
      uBroken: { value: 0 },
      uBase: { value: 0.8 },
    },
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
  }) as SeamMaterial;
}

// ───────────────────────────── point clouds ─────────────────────────────

/** Clustered point cloud (pedestal nucleus, decay particles): one draw call. */
const CLUSTER_VERT = /* glsl */ `
#define MAX_CLUSTERS 16
attribute vec3 aOffset;
attribute float aCluster;
attribute float aSeed;
uniform vec3 uCenters[MAX_CLUSTERS];
uniform float uScales[MAX_CLUSTERS];
uniform float uAlphas[MAX_CLUSTERS];
uniform float uShimmer[MAX_CLUSTERS];
uniform float uTone[MAX_CLUSTERS];
uniform float uTime;
uniform float uPixelRatio;
uniform float uSize;
uniform float uPoints;
uniform float uMotion;
varying float vAlpha;
varying float vSeed;
varying float vTone;
${POINTER_PUSH}
void main() {
  int c = int(aCluster + 0.5);
  vTone = uTone[c];
  vec3 center = uCenters[c];
  float s = uScales[c];
  float sh = uShimmer[c];
  float t = uTime * uMotion;
  vec3 o = aOffset;
  float ang = t * (0.25 + aSeed * 0.5);
  float cs = cos(ang), sn = sin(ang);
  o.xz = mat2(cs, -sn, sn, cs) * o.xz;
  o += sh * 0.05 * vec3(sin(t * 7.0 + aSeed * 50.0), cos(t * 6.0 + aSeed * 40.0), sin(t * 5.0 + aSeed * 30.0));
  vec4 mv = pointerPush(modelViewMatrix * vec4(center + o * s, 1.0));
  gl_Position = projectionMatrix * mv;
  // quality ladder: drop a fraction of points by seed (stable subset)
  float keep = step(aSeed, uPoints);
  float flicker = 1.0 - sh * 0.5 * (0.5 + 0.5 * sin(t * 13.0 + aSeed * 90.0));
  vAlpha = uAlphas[c] * keep * flicker;
  vSeed = aSeed;
  gl_PointSize = keep * uSize * uPixelRatio * (0.6 + aSeed * 0.8) / max(0.1, -mv.z) * 6.0;
}
`;

const POINT_FRAG = /* glsl */ `
uniform vec3 uFrost;
uniform vec3 uShade;
uniform float uOpacity;
varying float vAlpha;
varying float vSeed;
void main() {
  if (vAlpha < 0.01) discard;
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d);
  if (r > 0.25) discard;
  float a = smoothstep(0.25, 0.0, r);
  vec3 col = mix(uShade, uFrost, 0.55 + 0.45 * vSeed);
  gl_FragColor = vec4(col, a * vAlpha * uOpacity);
}
`;

/** Cluster points: like POINT_FRAG, with a per-cluster tone (0 = frost proton, 1 = slate neutron) for contrast on fog. */
const CLUSTER_FRAG = /* glsl */ `
uniform vec3 uFrost;
uniform vec3 uShade;
uniform float uOpacity;
varying float vAlpha;
varying float vSeed;
varying float vTone;
void main() {
  if (vAlpha < 0.01) discard;
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d);
  if (r > 0.25) discard;
  float a = smoothstep(0.25, 0.0, r);
  vec3 col = mix(uShade, uFrost, mix(0.62 + 0.38 * vSeed, 0.1 + 0.25 * vSeed, vTone));
  gl_FragColor = vec4(col, a * vAlpha * uOpacity);
}
`;

export const MAX_CLUSTERS = 16;

export type ClusterMaterial = ShaderMaterial & {
  uniforms: {
    uCenters: { value: Vector3[] };
    uScales: { value: number[] };
    uAlphas: { value: number[] };
    uShimmer: { value: number[] };
    uTone: { value: number[] };
    uSize: { value: number };
    uOpacity: { value: number };
  };
};

export function createClusterMaterial(shared: SharedUniforms, size = 2.2): ClusterMaterial {
  return new ShaderMaterial({
    vertexShader: CLUSTER_VERT,
    fragmentShader: CLUSTER_FRAG,
    uniforms: {
      uTime: shared.uTime,
      uPixelRatio: shared.uPixelRatio,
      uPoints: shared.uPoints,
      uMotion: shared.uMotion,
      ...pointerUniforms(shared),
      uCenters: { value: Array.from({ length: MAX_CLUSTERS }, () => new Vector3()) },
      uScales: { value: new Array<number>(MAX_CLUSTERS).fill(1) },
      uAlphas: { value: new Array<number>(MAX_CLUSTERS).fill(0) },
      uShimmer: { value: new Array<number>(MAX_CLUSTERS).fill(0) },
      uTone: { value: new Array<number>(MAX_CLUSTERS).fill(0) },
      uSize: { value: size },
      uFrost: { value: COLORS.frost },
      uShade: { value: COLORS.slate },
      uOpacity: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
  }) as ClusterMaterial;
}

/** Electron cloud: drifting points disturbed by the cursor. */
const CLOUD_VERT = /* glsl */ `
attribute float aSeed;
uniform float uTime;
uniform float uPixelRatio;
uniform float uPoints;
uniform float uMotion;
uniform float uSize;
uniform float uSpread;
varying float vAlpha;
varying float vSeed;
${POINTER_PUSH}
void main() {
  float t = uTime * uMotion;
  vec3 p = position * uSpread;
  float ang = t * (0.08 + aSeed * 0.22) * (aSeed > 0.5 ? 1.0 : -1.0);
  float cs = cos(ang), sn = sin(ang);
  p.xz = mat2(cs, -sn, sn, cs) * p.xz;
  p.y += sin(t * 0.7 + aSeed * 30.0) * 0.04;
  vec4 mv = pointerPush(modelViewMatrix * vec4(p, 1.0));
  gl_Position = projectionMatrix * mv;
  float keep = step(aSeed, uPoints);
  vAlpha = keep * (0.25 + 0.75 * fract(aSeed * 13.7));
  vSeed = aSeed;
  gl_PointSize = keep * uSize * uPixelRatio / max(0.1, -mv.z) * 6.0;
}
`;

export type CloudMaterial = ShaderMaterial & {
  uniforms: { uOpacity: { value: number }; uSpread: { value: number } };
};

export function createCloudMaterial(shared: SharedUniforms): CloudMaterial {
  return new ShaderMaterial({
    vertexShader: CLOUD_VERT,
    fragmentShader: POINT_FRAG,
    uniforms: {
      uTime: shared.uTime,
      uPixelRatio: shared.uPixelRatio,
      uPoints: shared.uPoints,
      uMotion: shared.uMotion,
      ...pointerUniforms(shared),
      uSize: { value: 2.6 },
      uSpread: { value: 1 },
      uFrost: { value: COLORS.frost },
      uShade: { value: COLORS.fogMid },
      uOpacity: { value: 0.8 },
    },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  }) as CloudMaterial;
}

// ───────────────────────────── ground plain (graphite → graphene) ─────────────────────────────

const PLAIN_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const PLAIN_FRAG = /* glsl */ `
uniform vec3 uInk;
uniform vec3 uSlate;
uniform vec3 uFrost;
uniform vec3 uFog;
uniform float uTime;
uniform float uOpacity;
uniform float uGraphene;
varying vec3 vWorld;
${COMMON}
vec2 hash22(vec2 p) {
  vec3 a = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  a += dot(a, a.yzx + 33.33);
  return fract((a.xx + a.yz) * a.zy);
}
// voronoi: x = distance to nearest edge, y = cell id
vec2 voronoi(vec2 x) {
  vec2 n = floor(x), f = fract(x);
  vec2 mg, mr; float md = 8.0; vec2 cid = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = hash22(n + g);
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; cid = n + g; }
  }
  md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = mg + vec2(float(i), float(j));
    vec2 o = hash22(n + g);
    vec2 r = g + o - f;
    if (dot(mr - r, mr - r) > 0.00001) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  return vec2(md, hash13(vec3(cid, 1.7)));
}
float hexEdge(vec2 p) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 hc = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(p - hc.xy * s, p - (hc.zw + 0.5) * s);
  vec2 q = dot(h.xy, h.xy) < dot(h.zw, h.zw) ? h.xy : h.zw;
  q = abs(q);
  return 0.5 - max(dot(q, s * 0.5), q.x);
}
void main() {
  vec2 p = vWorld.xz;
  vec2 v = voronoi(p * 2.1);
  float facet = v.y;
  float edge = smoothstep(0.0, 0.04, v.x);
  vec3 col = mix(uSlate, uFog, 0.25 + 0.35 * facet);
  col = mix(uInk, col, 0.8);
  // crystalline glints: each facet catches the key light at its own angle
  float glint = pow(max(0.0, sin(facet * 40.0 + 1.3)), 24.0) * 0.45;
  col = mix(col, uFrost, glint + (1.0 - edge) * 0.18);
  // frost dusting
  col = mix(col, uFrost, smoothstep(0.55, 0.9, vnoise(vec3(p * 1.7, 0.0))) * 0.35);
  // graphene: hex lattice of frozen carbon lines
  float hx = hexEdge(p * 0.75);
  float line = 1.0 - smoothstep(0.0, 0.022, hx);
  col = mix(col, mix(uSlate, uFog, 0.55), uGraphene * 0.7);
  col = mix(col, uFrost, uGraphene * line * 0.75);
  float dist = length(p);
  float fade = 1.0 - smoothstep(6.0, 22.0, dist);
  gl_FragColor = vec4(mix(uFog, col, fade), uOpacity * fade);
}
`;

export type PlainMaterial = ShaderMaterial & { uniforms: { uOpacity: { value: number }; uGraphene: { value: number } } };

export function createPlainMaterial(shared: SharedUniforms): PlainMaterial {
  return new ShaderMaterial({
    vertexShader: PLAIN_VERT,
    fragmentShader: PLAIN_FRAG,
    uniforms: {
      uTime: shared.uTime,
      uInk: { value: COLORS.ink },
      uSlate: { value: COLORS.slate },
      uFrost: { value: COLORS.frost },
      uFog: { value: COLORS.fogLight },
      uOpacity: { value: 1 },
      uGraphene: { value: 0 },
    },
    transparent: true,
    depthWrite: true,
  }) as PlainMaterial;
}

/** Text/label quads (hash text, CA, emblem labels): textured, unlit, fog-friendly. */
const LABEL_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  float a = texture2D(uMap, vUv).a;
  if (a < 0.02) discard;
  gl_FragColor = vec4(uColor, a * uOpacity);
}
`;
const LABEL_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export type LabelMaterial = ShaderMaterial & { uniforms: { uMap: { value: Texture | null }; uOpacity: { value: number }; uColor: { value: Vector3 } } };

export function createLabelMaterial(color: Vector3 = COLORS.frost): LabelMaterial {
  return new ShaderMaterial({
    vertexShader: LABEL_VERT,
    fragmentShader: LABEL_FRAG,
    uniforms: { uMap: { value: null }, uColor: { value: color }, uOpacity: { value: 1 } },
    transparent: true,
    depthWrite: false,
    depthTest: false,
  }) as LabelMaterial;
}

// ───────────────────────────── sentinel ring gauge ─────────────────────────────

const GAUGE_FRAG = /* glsl */ `
#define MAX_SEG 8
uniform vec3 uFrost;
uniform vec3 uSlate;
uniform vec3 uBlock;
uniform float uSegStart[MAX_SEG];
uniform float uSegEnd[MAX_SEG];
uniform float uSegFill[MAX_SEG];
uniform float uSegHard[MAX_SEG];
uniform float uCount;
uniform float uOpacity;
uniform float uLock;
varying vec2 vUv;
void main() {
  vec2 p = vUv - 0.5;
  float r = length(p) * 2.0;
  if (r < 0.82 || r > 1.0) discard;
  // angle from 12 o'clock, clockwise, 0..1
  float a = fract(atan(p.x, p.y) / 6.28318 + 1.0);
  vec3 col = uSlate;
  float alpha = 0.35;
  for (int i = 0; i < MAX_SEG; i++) {
    if (float(i) >= uCount) break;
    float s = uSegStart[i];
    float e = uSegEnd[i];
    if (a >= s && a < e) {
      float gap = 0.004;
      if (a < s + gap || a > e - gap) discard;
      float filled = step(a, s + (e - s) * uSegFill[i]);
      col = mix(uSlate, uFrost, filled);
      if (uSegHard[i] > 0.5 && uSegFill[i] > 0.0) col = mix(col, uBlock, 0.85);
      alpha = mix(0.35, 0.95, filled);
    }
  }
  col = mix(col, uFrost, uLock * 0.6);
  gl_FragColor = vec4(col, alpha * uOpacity);
}
`;

export type GaugeMaterial = ShaderMaterial & {
  uniforms: {
    uSegStart: { value: number[] };
    uSegEnd: { value: number[] };
    uSegFill: { value: number[] };
    uSegHard: { value: number[] };
    uCount: { value: number };
    uOpacity: { value: number };
    uLock: { value: number };
  };
};

export function createGaugeMaterial(): GaugeMaterial {
  return new ShaderMaterial({
    vertexShader: LABEL_VERT,
    fragmentShader: GAUGE_FRAG,
    uniforms: {
      uFrost: { value: COLORS.frost },
      uSlate: { value: COLORS.slate },
      uBlock: { value: COLORS.block },
      uSegStart: { value: new Array<number>(8).fill(0) },
      uSegEnd: { value: new Array<number>(8).fill(0) },
      uSegFill: { value: new Array<number>(8).fill(0) },
      uSegHard: { value: new Array<number>(8).fill(0) },
      uCount: { value: 0 },
      uOpacity: { value: 1 },
      uLock: { value: 0 },
    },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  }) as GaugeMaterial;
}

// ───────────────────────────── decay shedding particles ─────────────────────────────

const SHED_VERT = /* glsl */ `
attribute float aSeed;
uniform float uTime;
uniform float uPixelRatio;
uniform float uPoints;
uniform float uAmount;
uniform float uSize;
varying float vAlpha;
varying float vSeed;
${POINTER_PUSH}
void main() {
  vec3 dir = normalize(position);
  float life = fract(uTime * (0.08 + aSeed * 0.12) + aSeed * 7.0);
  vec3 p = dir * (0.4 + life * 3.2) + vec3(0.0, -life * 0.6, 0.0);
  vec4 mv = pointerPush(modelViewMatrix * vec4(p, 1.0));
  gl_Position = projectionMatrix * mv;
  float keep = step(aSeed, uPoints) * step(aSeed, uAmount);
  vAlpha = keep * (1.0 - life) * 0.9;
  vSeed = aSeed;
  gl_PointSize = keep * uSize * uPixelRatio / max(0.1, -mv.z) * 6.0;
}
`;

export type ShedMaterial = ShaderMaterial & { uniforms: { uAmount: { value: number }; uOpacity: { value: number } } };

export function createShedMaterial(shared: SharedUniforms): ShedMaterial {
  return new ShaderMaterial({
    vertexShader: SHED_VERT,
    fragmentShader: POINT_FRAG,
    uniforms: {
      uTime: shared.uTime,
      uPixelRatio: shared.uPixelRatio,
      uPoints: shared.uPoints,
      ...pointerUniforms(shared),
      uAmount: { value: 0 },
      uSize: { value: 2.0 },
      uFrost: { value: COLORS.frost },
      uShade: { value: COLORS.slate },
      uOpacity: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
  }) as ShedMaterial;
}
