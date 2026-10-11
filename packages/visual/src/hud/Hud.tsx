/**
 * HUD primitives. Mono, small, in corners. Labels UPPERCASE_SNAKE, "//" for
 * metadata, "//////" for section heads. Readouts render EMPTY_READOUT when
 * the value is absent. Pure render: no hooks besides refs, safe on the server.
 */
import type { CSSProperties, ReactNode, Ref } from 'react';
import { COPY } from '../copy.js';
import type { LeaderRegistry } from './leaders.js';
import { EMPTY_READOUT, meta, sectionHead, snake } from './format.js';

export type Corner = 'tl' | 'tr' | 'bl' | 'br' | 'ml' | 'mr' | 'bc';

export function HudCorner({ at, children, style, className, testId }: { at: Corner; children: ReactNode; style?: CSSProperties; className?: string; testId?: string }) {
  return (
    <div className={`carbon-hud__corner carbon-hud__corner--${at}${className ? ' ' + className : ''}`} style={style} data-testid={testId}>
      {children}
    </div>
  );
}

/** UPPERCASE_SNAKE label; optional leader line target. */
export function HudLabel({ children, leaderRef, testId }: { children: string; leaderRef?: Ref<HTMLDivElement>; testId?: string }) {
  return (
    <div className="carbon-hud__label" ref={leaderRef} data-testid={testId}>
      {snake(children)}
    </div>
  );
}

export function HudMeta({ children }: { children: string }) {
  return <div className="carbon-hud__meta">{children.startsWith('//') ? children : meta(children)}</div>;
}

export function HudSection({ children }: { children: string }) {
  return <div className="carbon-hud__section">{children.startsWith('//////') ? children : sectionHead(children)}</div>;
}

/** A readout line. `value` null/undefined/"--.--" renders the honest empty state. */
export function HudReadout({ label, value, testId }: { label?: string; value: string | null | undefined; testId?: string }) {
  const empty = value == null || value === '' || value.endsWith(EMPTY_READOUT);
  const v = value == null || value === '' ? EMPTY_READOUT : value;
  return (
    <div className="carbon-hud__readout" data-empty={empty} data-testid={testId}>
      {label ? `${label} ` : ''}
      {v}
    </div>
  );
}

export function HudTag({ children, testId }: { children: string; testId?: string }) {
  return (
    <span className="carbon-hud__tag" data-testid={testId}>
      {children}
    </span>
  );
}

/** HONESTY: the label every illustrated chapter carries. */
export function IllustrationTag() {
  return (
    <div data-testid="illustration-tag" data-honesty="illustration">
      <HudTag>{COPY.illustrationTag}</HudTag>
      <div className="carbon-hud__meta" style={{ marginTop: 4 }}>
        {COPY.illustrationNote}
      </div>
    </div>
  );
}

export function HudPanel({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <div className="carbon-hud__panel" data-testid={testId}>
      <div className="carbon-hud__meta">{title}</div>
      {children}
    </div>
  );
}

/** SVG layer the LeaderRegistry draws 1px frost lines into. */
export function HudLeaders({ registry }: { registry: LeaderRegistry }) {
  return <svg className="carbon-leaders" ref={registry.setSvg} aria-hidden="true" />;
}
