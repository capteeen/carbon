'use client';

/** Shown when the event log cannot be read. Never substitutes data. */
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div>
      <h1 className="section-title">Log unreachable</h1>
      <p className="meta">// Carbon could not read its event log just now, so nothing is shown rather than something made up.</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
