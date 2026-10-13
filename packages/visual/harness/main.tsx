/**
 * Harness for @argon/visual (dev + Playwright perf/sync). Not shipped.
 *   ?view=story|chamber|shapes|launch|graphene|embed
 *   &fixture=1  load TEST FIXTURE data from test/fixtures (banner shown)
 *   &reduced=1  force reduced motion
 *   &smooth=0   disable Lenis (perf script scrolls programmatically)
 */
import '@fontsource/nunito/900.css';
import '@fontsource/space-mono/400.css';
import '@fontsource/space-mono/700.css';
import '../src/styles.css';
import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentId, IsotopeId, ShapeId } from '@argon/core/contracts';
import {
  ArgonStory,
  EmbedPlayer,
  GrapheneSheet,
  IsotopeChamber,
  LaunchScene,
  ShapePicker,
  buildReplay,
  createQualityStore,
  launchSummaryFromEvents,
  progressStore,
  thinkingFromEvents,
} from '../src/index.js';
import { fixtureLaunch, fixtureLaunches, fixtureLive } from '../test/fixtures/events.js';

const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'story';
const fixture = q.get('fixture') === '1';
const reduced = q.get('reduced') === '1' ? true : undefined;
const smooth = q.get('smooth') !== '0';
const lockQuality = q.get('quality');
const maxDpr = q.get('dpr') ? Number(q.get('dpr')) : undefined;

declare global {
  interface Window {
    __argonBoot: number;
    __argon: {
      store: typeof progressStore;
      quality: ReturnType<typeof createQualityStore>;
      frames: number[];
      firstFrameAt: number | null;
      recording: boolean;
    };
  }
}

const quality = createQualityStore(lockQuality !== null ? { start: Number(lockQuality), floor: Number(lockQuality) } : {});
window.__argon = { store: progressStore, quality, frames: [], firstFrameAt: null, recording: false };
const onFirstFrame = () => {
  if (window.__argon.firstFrameAt === null) window.__argon.firstFrameAt = performance.now();
};
const onFrame = (dt: number) => {
  if (window.__argon.recording) window.__argon.frames.push(dt);
};

function Banner() {
  if (!fixture) return null;
  return (
    <div style={{ position: 'fixed', top: 0, left: '50%', transform: 'translateX(-50%)', zIndex: 10, font: '10px monospace', background: '#2B313B', color: '#E6EBF2', padding: '2px 6px' }}>
      HARNESS · TEST FIXTURE DATA
    </div>
  );
}

function App() {
  const fx = useMemo(() => (fixture ? fixtureLaunch() : null), []);
  const replay = useMemo(() => (fx ? buildReplay(fx.events, fx.bonds) : null), [fx]);
  const launches = useMemo(() => (fixture ? [launchSummaryFromEvents(fx!.events)!, ...fixtureLaunches(40)] : []), [fx]);
  const [iso, setIso] = useState<IsotopeId>('Ar-40');
  const [heavy, setHeavy] = useState<AgentId | null>(null);
  const [shape, setShape] = useState<ShapeId | null>(null);

  switch (view) {
    case 'chamber':
      return <IsotopeChamber value={iso} onChange={setIso} heavyAgent={heavy} onHeavyAgentChange={setHeavy} reducedMotion={reduced} quality={quality} />;
    case 'shapes':
      return <ShapePicker value={shape} onChange={setShape} reducedMotion={reduced} quality={quality} />;
    case 'launch':
      return (
        <LaunchScene
          events={fx?.events ?? []}
          bonds={fx?.bonds ?? []}
          decay={fx ? { kind: 'clock', startedAt: Date.now() - 3_600_000, deadline: Date.now() + 6 * 86_400_000, collapsedEventId: null } : null}
          reducedMotion={reduced}
          quality={quality}
        />
      );
    case 'graphene':
      return <GrapheneSheet launches={launches} onOpenLaunch={(ca) => console.log('open', ca)} reducedMotion={reduced} quality={quality} />;
    case 'embed':
      return (
        <div style={{ width: '100vw', aspectRatio: '16 / 9' }}>
          <EmbedPlayer launch={launches[0] ?? null} events={fx?.events} bonds={fx?.bonds} reducedMotion={reduced} />
        </div>
      );
    default:
      return (
        <>
          <ArgonStory
            live={fixture ? fixtureLive() : null}
            replay={replay}
            launches={launches}
            feed={fx ? thinkingFromEvents(fx.events) : []}
            receipts={[]}
            onOpenAgent={(a) => console.log('open agent', a)}
            onOpenLaunch={(ca) => console.log('open launch', ca)}
            onLaunch={() => console.log('launch')}
            reducedMotion={reduced}
            smoothScroll={smooth}
            quality={quality}
            onFirstFrame={onFirstFrame}
            onFrame={onFrame}
            maxDpr={maxDpr}
          />
          <footer style={{ padding: 16, font: '11px monospace', background: '#2B313B', color: '#E6EBF2' }}>harness footer</footer>
        </>
      );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Banner />
    <App />
  </StrictMode>,
);
