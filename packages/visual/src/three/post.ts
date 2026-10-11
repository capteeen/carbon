/**
 * One merged post pass: slit-scan / pixel-stretch glitch, iridescent chromatic
 * aberration, volumetric-looking depth fog with drifting density, frost flash
 * and fine animated film grain. One fullscreen pass, uniforms only, so the
 * quality ladder changes cost nothing to apply.
 */
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';
import { Uniform, Vector2, type WebGLRenderer, type WebGLRenderTarget } from 'three';
import { COLORS } from './materials.js';
import type { QualitySettings } from '../quality/ladder.js';

/** Written by scenes every frame (timeline values); read by the effect. */
export interface PostParams {
  glitch: number;
  aberration: number;
  flash: number;
  /** Base fog density (scene-specific); multiplied by the quality ladder's fog factor. */
  fogDensity: number;
  /** Per-chapter fog multiplier from the timeline. */
  fog: number;
  /** Distance from the camera where fog starts (keeps the subject crisp). */
  fogStart: number;
  /** Reduced motion: freeze grain/fog drift, no glitch. */
  still: boolean;
}

export function createPostParams(): PostParams {
  return { glitch: 0, aberration: 0, flash: 0, fogDensity: 0.085, fog: 1, fogStart: 5, still: false };
}

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uGrain;
uniform float uFogAmt;
uniform float uFogDensity;
uniform float uFogStart;
uniform float uAberration;
uniform float uGlitch;
uniform float uFlash;
uniform vec3 uFogColor;
uniform vec3 uFogDeep;
uniform vec3 uFrost;
uniform vec2 uRes;

float h12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float n2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h12(i), h12(i + vec2(1, 0)), f.x), mix(h12(i + vec2(0, 1)), h12(i + vec2(1, 1)), f.x), f.y);
}

void mainUv(inout vec2 uv) {
  if (uGlitch > 0.001) {
    float rows = 64.0 + 96.0 * h12(vec2(floor(uTime * 5.0), 1.0));
    float row = floor(uv.y * rows);
    float r = h12(vec2(row, floor(uTime * 14.0)));
    float band = step(1.0 - uGlitch * 0.8, r);
    // pixel stretch: beyond a moving slit column, rows repeat the slit pixel
    float slit = 0.25 + 0.5 * h12(vec2(floor(uTime * 6.0), 3.1));
    float stretched = uv.x > slit ? slit + (uv.x - slit) * (1.0 - uGlitch) * 0.15 : uv.x;
    uv.x = mix(uv.x, stretched, band);
    // slit-scan smear: whole rows slide by a per-row offset
    uv.x += band * (r - 0.5) * 0.12 * uGlitch;
    uv.y += (h12(vec2(floor(uv.x * 40.0), floor(uTime * 9.0))) - 0.5) * 0.01 * uGlitch;
  }
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  float ab = uAberration;
  if (ab > 0.001) {
    vec2 d = (uv - 0.5) * ab * 0.014 + vec2(ab * 0.0025 * uGlitch, 0.0);
    vec3 s1 = texture2D(inputBuffer, uv + d).rgb;
    vec3 s2 = texture2D(inputBuffer, uv - d).rgb;
    c = vec3(s1.r, c.g, s2.b);
  }
  bool background = depth >= 0.99999;
  float dist = -getViewZ(depth);
  float drift = uTime * 0.025;
  float dn = n2(uv * vec2(2.4, 1.3) + vec2(drift, drift * 0.3)) * 0.65 + n2(uv * vec2(6.0, 3.5) - vec2(drift * 1.7, 0.0)) * 0.35;
  float height = smoothstep(0.0, 0.8, 1.0 - uv.y) * 0.35;
  float dens = uFogDensity * (0.65 + 0.7 * dn + height);
  float fd = max(0.0, dist - uFogStart);
  float f = 1.0 - exp(-dens * dens * fd * fd);
  vec3 fogCol = mix(uFogColor, uFogDeep, (1.0 - dn) * 0.3);
  if (background) {
    // the clear colour is uFogColor; shift it to the fog gradient so transparent
    // objects (shells, seams, point clouds) drawn over the background survive
    vec3 bg = mix(uFogColor, uFogDeep, 0.12 + (1.0 - uv.y) * 0.28 + (dn - 0.5) * 0.14 * uFogAmt);
    c += bg - uFogColor;
  } else {
    c = mix(c, fogCol, clamp(f * uFogAmt, 0.0, 1.0));
  }
  c = mix(c, uFrost, clamp(uFlash, 0.0, 1.0));
  float g = h12(uv * uRes + fract(uTime * 7.31) * 517.0) - 0.5;
  c += g * 0.075 * uGrain;
  outputColor = vec4(c, 1.0);
}
`;

export class CarbonPostEffect extends Effect {
  params: PostParams;
  quality: () => Readonly<QualitySettings>;
  private t = 0;

  constructor(params: PostParams, quality: () => Readonly<QualitySettings>) {
    super('CarbonPostEffect', FRAG, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>([
        ['uTime', new Uniform(0)],
        ['uGrain', new Uniform(1)],
        ['uFogAmt', new Uniform(1)],
        ['uFogDensity', new Uniform(params.fogDensity)],
        ['uFogStart', new Uniform(params.fogStart)],
        ['uAberration', new Uniform(0)],
        ['uGlitch', new Uniform(0)],
        ['uFlash', new Uniform(0)],
        ['uFogColor', new Uniform(COLORS.fogLight)],
        ['uFogDeep', new Uniform(COLORS.fogMid)],
        ['uFrost', new Uniform(COLORS.frost)],
        ['uRes', new Uniform(new Vector2(1, 1))],
      ]),
    });
    this.params = params;
    this.quality = quality;
  }

  override update(_r: WebGLRenderer, input: WebGLRenderTarget, dt?: number): void {
    const q = this.quality();
    const p = this.params;
    const u = this.uniforms;
    if (!p.still) this.t += dt ?? 0.016;
    (u.get('uTime') as Uniform<number>).value = this.t;
    (u.get('uGrain') as Uniform<number>).value = q.grain;
    (u.get('uFogAmt') as Uniform<number>).value = q.fog * p.fog;
    (u.get('uFogDensity') as Uniform<number>).value = p.fogDensity;
    (u.get('uFogStart') as Uniform<number>).value = p.fogStart;
    (u.get('uAberration') as Uniform<number>).value = p.still ? 0 : p.aberration * q.aberration;
    (u.get('uGlitch') as Uniform<number>).value = p.still ? 0 : p.glitch;
    (u.get('uFlash') as Uniform<number>).value = p.flash;
    (u.get('uRes') as Uniform<Vector2>).value.set(input.width, input.height);
  }
}

