/**
 * progress → scene state. Pure, deterministic and allocation-free: the same
 * progress always yields the same camera, object and effect values, so the
 * 3D rewinds exactly when scrolling back. Tested in test/timeline.test.ts.
 */
import { CHAPTER_COUNT, bondStageAt, clamp01, locate, protonAt, smoothstep, type Located } from './chapters.js';

export interface StoryState {
  p: number;
  chapter: number;
  local: number;
  /** Camera position / target / vertical fov (deg). */
  camX: number;
  camY: number;
  camZ: number;
  tgtX: number;
  tgtY: number;
  tgtZ: number;
  fov: number;
  /** Portrait fit multiplier applied to wide compositions (≥1). */
  fit: number;

  /** Atom visibility 0..1 (scale). */
  atom: number;
  /** Nucleons lifted apart 0..1. */
  explode: number;
  /** Non-focused nucleons hidden 0..1 (isolation). */
  isolate: number;
  /** Proton in focus (ch03), -1 none. */
  focus: number;
  /** Slide of the focused proton: -1 (left, leaving) .. 0 (centre) .. 1 (right, arriving). */
  focusSlide: number;
  /** Electron shells opacity 0..1. */
  shells: number;
  /** Depth spread of the shells for the fly-through (ch04) 0..1. */
  shellSpread: number;
  /** Nucleus core glow 0..1 (ch04 "bright core"). */
  coreGlow: number;
  /** Outer electrons extended into the 4 bond arms 0..1. */
  arms: number;
  /** Iridescence on nucleon edges (transitions only) 0..1. */
  irid: number;

  /** Post: glitch slit-scan 0..1, chromatic aberration 0..1, fog multiplier, frost flash 0..1. */
  glitch: number;
  aberration: number;
  fog: number;
  flash: number;

  /** Ground plain visibility and its graphene (hex) blend. */
  plain: number;
  graphene: number;

  /** ch05 bonds visibility, continuous stage 0..3. */
  bonds: number;
  bondStage: number;
  /** ch06 chamber visibility. */
  chamber: number;
  /** ch07 molecules visibility; ch08 condenses them (1 → 0 as the coin forms). */
  shapes: number;
  /** ch08 coin formation 0..1. */
  coin: number;
  /** Hero drag-rotation enabled. */
  drag: boolean;
}

export function createStoryState(): StoryState {
  return {
    p: 0,
    chapter: 0,
    local: 0,
    camX: 0,
    camY: 0,
    camZ: 6,
    tgtX: 0,
    tgtY: 0,
    tgtZ: 0,
    fov: 38,
    fit: 1,
    atom: 1,
    explode: 0,
    isolate: 0,
    focus: -1,
    focusSlide: 0,
    shells: 1,
    shellSpread: 0,
    coreGlow: 0,
    arms: 0,
    irid: 0,
    glitch: 0,
    aberration: 0,
    fog: 1,
    flash: 0,
    plain: 1,
    graphene: 0,
    bonds: 0,
    bondStage: 0,
    chamber: 0,
    shapes: 0,
    coin: 0,
    drag: true,
  };
}

/** Portrait fit: how much further the camera sits for wide compositions. */
export function fitFor(aspect: number): number {
  if (!(aspect > 0)) return 1;
  return Math.min(2.4, Math.max(1, 0.95 / aspect));
}

interface Pose {
  x: number;
  y: number;
  z: number;
  tx: number;
  ty: number;
  tz: number;
  fov: number;
}
const poseA: Pose = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, fov: 38 };
const poseB: Pose = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, fov: 38 };
const loc: Located = { index: 0, local: 0 };

function set(o: Pose, x: number, y: number, z: number, tx: number, ty: number, tz: number, fov: number): void {
  o.x = x;
  o.y = y;
  o.z = z;
  o.tx = tx;
  o.ty = ty;
  o.tz = tz;
  o.fov = fov;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => smoothstep(0, 1, t);

/** Camera pose of chapter `i` at local `l`. `soft` is a gentler fit for centred objects. */
function cameraPose(i: number, l: number, fit: number, o: Pose): void {
  const soft = 1 + (fit - 1) * 0.55;
  switch (i) {
    case 0: // hero: atom floats over the plain
      set(o, 0, 0.45, (6.4 - 0.35 * l) * soft, 0, -0.05, 0, 38);
      return;
    case 1: // dismantle: pull back as the nucleons lift apart
      set(o, 0.4 * ease(l), lerp(0.45, 1.1, ease(l)), lerp(6.05, 7.6, ease(l)) * soft, 0, 0.1, 0, 38);
      return;
    case 2: // glitch → isolation
      set(o, lerp(0.4, 0, ease(l)), lerp(1.1, 0.1, ease(l)), lerp(7.6, 4.4, ease(l)) * soft, 0, 0, 0, 38);
      return;
    case 3: // six protons, one at a time
      set(o, 0, 0.1, 4.4 * soft, 0, 0, 0, 38);
      return;
    case 4: {
      // shells: fly through the outer ring, then the inner, into the core; back out to see the 4 arms
      const z = l < 0.6 ? lerp(9.5, 1.9, ease(l / 0.6)) : lerp(1.9, 6.2 * soft, ease((l - 0.6) / 0.4));
      set(o, 0, l < 0.6 ? 0 : 0.6 * ease((l - 0.6) / 0.4), z, 0, 0, 0, l < 0.6 ? lerp(38, 58, ease(l / 0.6)) : lerp(58, 38, ease((l - 0.6) / 0.4)));
      return;
    }
    case 5: // bonding: three bonds stacked
      set(o, 0, 0, 8.6 * fit, 0, 0, 0, 38);
      return;
    case 6: // isotope chamber: slightly above the pedestal
      set(o, 0, 2.3, 6.6 * soft, 0, 0.25, 0, 38);
      return;
    case 7: // shapes
      set(o, 0, 0.6, 9.5 * fit, 0, 0, 0, 38);
      return;
    case 8: // the launch: coin
      set(o, 0, 0.4, lerp(7.5 * fit, 5.0 * soft, ease(smoothstep(0, 0.4, l))), 0, 0.15, 0, 38);
      return;
    default: {
      // 09 reassemble → pull up over the graphene sheet
      const up = ease(smoothstep(0.3, 0.75, l));
      set(o, 0, lerp(0.45, 10.5 * soft, up), lerp(6.2 * soft, 3.2 * soft, up), 0, lerp(0, -2.2, up), lerp(0, -0.6, up), 38);
      return;
    }
  }
}

/** Writes the full scene state for progress `p` into `out`. */
export function evalStory(p: number, aspect: number, out: StoryState): StoryState {
  const q = clamp01(p);
  locate(q, loc);
  const i = loc.index;
  const l = loc.local;
  const fit = fitFor(aspect);
  out.p = q;
  out.chapter = i;
  out.local = l;
  out.fit = fit;

  // camera: each chapter blends in from the previous chapter's end pose
  cameraPose(i, l, fit, poseA);
  if (i > 0 && l < 0.22) {
    cameraPose(i - 1, 1, fit, poseB);
    const t = ease(l / 0.22);
    poseA.x = lerp(poseB.x, poseA.x, t);
    poseA.y = lerp(poseB.y, poseA.y, t);
    poseA.z = lerp(poseB.z, poseA.z, t);
    poseA.tx = lerp(poseB.tx, poseA.tx, t);
    poseA.ty = lerp(poseB.ty, poseA.ty, t);
    poseA.tz = lerp(poseB.tz, poseA.tz, t);
    poseA.fov = lerp(poseB.fov, poseA.fov, t);
  }
  out.camX = poseA.x;
  out.camY = poseA.y;
  out.camZ = poseA.z;
  out.tgtX = poseA.tx;
  out.tgtY = poseA.ty;
  out.tgtZ = poseA.tz;
  out.fov = poseA.fov;

  // defaults
  out.atom = 0;
  out.explode = 0;
  out.isolate = 0;
  out.focus = -1;
  out.focusSlide = 0;
  out.shells = 0;
  out.shellSpread = 0;
  out.coreGlow = 0;
  out.arms = 0;
  out.irid = 0;
  out.glitch = 0;
  out.aberration = 0;
  out.fog = 1;
  out.flash = 0;
  out.plain = 0;
  out.graphene = 0;
  out.bonds = 0;
  out.bondStage = 0;
  out.chamber = 0;
  out.shapes = 0;
  out.coin = 0;
  out.drag = false;

  switch (i) {
    case 0:
      out.atom = 1;
      out.shells = 1;
      out.plain = 1;
      out.drag = true;
      out.explode = 0.12 * smoothstep(0.6, 1, l); // first hint of the lift at the very end
      break;
    case 1: {
      out.atom = 1;
      out.plain = 1 - smoothstep(0.6, 1, l);
      out.shells = 1 - smoothstep(0, 0.45, l);
      out.explode = lerp(0.12, 1, ease(l));
      out.irid = Math.sin(Math.PI * l);
      out.aberration = 0.35 * Math.sin(Math.PI * l);
      break;
    }
    case 2: {
      const g = Math.sin(Math.PI * l);
      out.atom = 1;
      out.explode = 1;
      out.isolate = smoothstep(0.42, 0.58, l);
      out.focus = l >= 0.5 ? 0 : -1;
      out.focusSlide = l >= 0.5 ? 1 - ease((l - 0.5) / 0.5) : 0;
      out.glitch = Math.pow(g, 0.8);
      out.aberration = Math.max(0.25, g);
      out.irid = g;
      out.fog = lerp(1, 1.25, g);
      break;
    }
    case 3: {
      const k = protonAt(l);
      const sub = l * 6 - k;
      out.atom = 1;
      out.explode = 1;
      out.isolate = 1;
      out.focus = k;
      // slide in from the right, rest, slide out to the left (first arrives from ch02, last leaves into ch04)
      if (sub < 0.18 && k > 0) out.focusSlide = 1 - ease(sub / 0.18);
      else if (sub > 0.82 && k < 5) out.focusSlide = -ease((sub - 0.82) / 0.18);
      else if (sub > 0.82 && k === 5) out.focusSlide = -0.0;
      out.irid = sub < 0.18 && k > 0 ? 0.6 * (1 - sub / 0.18) : 0;
      out.aberration = sub < 0.12 && k > 0 ? 0.3 * (1 - sub / 0.12) : 0;
      // hand the last proton over to the shells chapter
      if (k === 5) out.isolate = 1 - smoothstep(0.9, 1, sub);
      if (k === 5) out.explode = 1 - smoothstep(0.9, 1, sub);
      break;
    }
    case 4: {
      out.atom = 1;
      out.explode = 0;
      out.shells = smoothstep(0, 0.15, l);
      out.shellSpread = 1 - smoothstep(0.62, 0.9, l);
      out.coreGlow = smoothstep(0.35, 0.6, l) * (1 - smoothstep(0.62, 0.85, l));
      out.flash = 0.55 * out.coreGlow;
      out.arms = smoothstep(0.66, 0.92, l);
      out.aberration = 0.25 * out.coreGlow;
      out.fog = 0.9;
      // atom thins out into the bonding chapter
      out.atom = 1 - smoothstep(0.94, 1, l) * 0.6;
      break;
    }
    case 5:
      out.atom = 0.4 * (1 - smoothstep(0, 0.1, l));
      out.shells = out.atom;
      out.arms = 1;
      out.bonds = smoothstep(0, 0.12, l) * (1 - smoothstep(0.9, 1, l));
      out.bondStage = clamp01((l - 0.1) / 0.9) * 3;
      if (bondStageAt(l) === 0) out.bondStage = 0;
      out.aberration = 0;
      break;
    case 6:
      out.chamber = smoothstep(0, 0.2, l) * (1 - smoothstep(0.88, 1, l));
      out.plain = 0.35 * out.chamber;
      break;
    case 7:
      out.shapes = smoothstep(0, 0.2, l);
      break;
    case 8: {
      out.shapes = 1 - smoothstep(0.05, 0.35, l);
      out.coin = smoothstep(0.15, 0.42, l);
      out.irid = 0.7 * Math.sin(Math.PI * smoothstep(0.1, 0.45, l));
      out.aberration = 0.3 * Math.sin(Math.PI * smoothstep(0.1, 0.45, l));
      break;
    }
    default: {
      // 09: nucleons fly back into the atom, camera pulls up to the live graphene
      out.coin = 1 - smoothstep(0, 0.12, l);
      out.atom = smoothstep(0.02, 0.15, l);
      out.explode = 1 - ease(smoothstep(0.05, 0.32, l));
      out.shells = smoothstep(0.2, 0.35, l);
      out.irid = 0.6 * Math.sin(Math.PI * smoothstep(0.05, 0.32, l));
      out.aberration = 0.3 * Math.sin(Math.PI * smoothstep(0.05, 0.32, l));
      out.plain = smoothstep(0.25, 0.45, l);
      out.graphene = smoothstep(0.35, 0.8, l);
      break;
    }
  }
  if (i >= CHAPTER_COUNT) out.chapter = CHAPTER_COUNT - 1;
  return out;
}
