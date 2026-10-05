// What works right now (GET /status): shown on the key screen, before a key is
// entered. While ZeroDust's sponsor key cannot sign, every sweep pauses (all
// chains alike, owner 2026-10-06): the API refuses quotes and direct plans
// (SIGNING_UNAVAILABLE) and the key field is disabled.
import { useEffect, useState } from 'react';
import { API_URL } from './constants';

export interface ServiceStatus {
  sponsoredSweeps: 'available' | 'paused';
  directChains?: 'available' | 'paused';
  message: string | null;
}

export const isPaused = (s: ServiceStatus | null) => s?.sponsoredSweeps === 'paused' || s?.directChains === 'paused';

/** The status, or null while unknown (no answer is not shown as an outage) */
export function useServiceStatus(): ServiceStatus | null {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/status`, { signal: AbortSignal.timeout(8000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: ServiceStatus | null) => {
        if (!cancelled && body && (body.sponsoredSweeps === 'available' || body.sponsoredSweeps === 'paused')) setStatus(body);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return status;
}
