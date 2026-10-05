// What works right now (GET /status): shown on the key screen, before a key is
// entered. Sponsored sweeps pause while ZeroDust's sponsor key cannot sign; the
// API also refuses their quotes then (SIGNING_UNAVAILABLE).
import { useEffect, useState } from 'react';
import { API_URL } from './constants';

export interface ServiceStatus {
  sponsoredSweeps: 'available' | 'paused';
  message: string | null;
}

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
