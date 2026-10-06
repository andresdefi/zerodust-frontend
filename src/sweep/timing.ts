import { API_URL } from './constants';

/**
 * How long each bridge usually takes to deliver, from the API's GET /bridges/timing (the last 14
 * days of measured deliveries). Only to set expectations: nothing depends on it, and a bridge
 * with too few deliveries simply shows no time.
 */
export interface RouteTiming {
  typicalSeconds: number;
  p90Seconds: number;
  samples: number;
  /** The last day ran well above the usual time */
  slowLately: boolean;
}

export interface BridgeTimings {
  routes: Record<string, RouteTiming>;
  /** Per bridge and source chain, "relay:42161" */
  pairs: Record<string, { typicalSeconds: number; samples: number }>;
}

export const NO_TIMINGS: BridgeTimings = { routes: {}, pairs: {} };

/** The names the page shows, back to the API's route ids */
const ROUTE_IDS: Record<string, string> = { 'Gas.zip': 'gaszip', Relay: 'relay', Across: 'across', 'LI.FI': 'lifi' };

export interface ExpectedTime {
  seconds: number;
  slowLately: boolean;
}

/** The usual delivery time for this bridge from this chain: the pair's own when measured, else the bridge's */
export function expectedTime(timings: BridgeTimings, bridgeName: string | undefined, fromChainId: number): ExpectedTime | null {
  const id = bridgeName ? ROUTE_IDS[bridgeName] : undefined;
  const route = id ? timings.routes[id] : undefined;
  if (!id || !route) return null;
  const pair = timings.pairs[`${id}:${fromChainId}`];
  return { seconds: pair?.typicalSeconds ?? route.typicalSeconds, slowLately: route.slowLately };
}

/** "20s", "2 min" */
export function durationText(seconds: number): string {
  return seconds < 60 ? `${Math.max(1, Math.round(seconds))}s` : `${Math.round(seconds / 60)} min`;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Keeps only well-formed entries: the answer comes from the network */
export function parseTimings(body: unknown): BridgeTimings {
  const out: BridgeTimings = { routes: {}, pairs: {} };
  const b = body as { routes?: Record<string, unknown>; pairs?: Record<string, unknown> } | null;
  for (const [id, v] of Object.entries(b?.routes ?? {})) {
    const r = v as Partial<RouteTiming> | null;
    if (r && isNum(r.typicalSeconds) && isNum(r.p90Seconds) && isNum(r.samples)) {
      out.routes[id] = { typicalSeconds: r.typicalSeconds, p90Seconds: r.p90Seconds, samples: r.samples, slowLately: r.slowLately === true };
    }
  }
  for (const [key, v] of Object.entries(b?.pairs ?? {})) {
    const p = v as { typicalSeconds?: unknown; samples?: unknown } | null;
    if (p && isNum(p.typicalSeconds) && isNum(p.samples)) out.pairs[key] = { typicalSeconds: p.typicalSeconds, samples: p.samples };
  }
  return out;
}

export async function fetchTimings(): Promise<BridgeTimings> {
  const res = await fetch(`${API_URL}/bridges/timing`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return NO_TIMINGS;
  return parseTimings(await res.json());
}
