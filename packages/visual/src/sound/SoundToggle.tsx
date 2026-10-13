'use client';
import { COPY } from '../copy.js';
import { sound, useSoundEnabled } from './sound.js';

/** "Sound: On/Off" toggle, bottom-left, off by default. */
export function SoundToggle({ className }: { className?: string }) {
  const on = useSoundEnabled();
  return (
    <div className={className ?? 'argon-sound'}>
      <button type="button" className="argon-hud__btn argon-sound__btn" aria-pressed={on} onClick={() => sound.toggle()} data-testid="sound-toggle">
        {on ? COPY.sound.on : COPY.sound.off}
      </button>
    </div>
  );
}
