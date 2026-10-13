'use client';

import { useEffect, useState } from 'react';

interface Check {
  name: string;
  state: string;
  fix: string;
}

/**
 * Shown when the event log cannot be read. Never substitutes data. Lists which
 * deployment settings are missing or unreachable (names and states only, from
 * /api/health) so the cause is visible instead of a bare failure.
 */
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div>
      <h1 className="section-title">Log unreachable</h1>
      <p className="meta">// Argon could not read its event log just now, so nothing is shown rather than something made up.</p>
      <HealthList />
      <button type="button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}

function HealthList() {
  const [checks, setChecks] = useState<Check[] | null>(null);
  useEffect(() => {
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => r.json() as Promise<{ checks: Check[] }>)
      .then((h) => setChecks(h.checks))
      .catch(() => setChecks(null));
  }, []);
  const failing = checks?.filter((c) => c.state !== 'ok') ?? [];
  return (
    <>
      {failing.length > 0 && (
        <ul className="meta" data-testid="health-failing">
          {failing.map((c) => (
            <li key={c.name}>
              {c.name.toUpperCase()} {c.state.toUpperCase()} // {c.fix}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
