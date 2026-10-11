import { afterEach, describe, expect, it, vi } from 'vitest';
import { counts, track } from '../src/lib/events';

describe('page events', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('only the live site counts: never the offline file, local runs or previews', () => {
    expect(counts('zerodust.xyz', false)).toBe(true);
    expect(counts('www.zerodust.xyz', false)).toBe(true);
    expect(counts('www.zerodust.xyz', true)).toBe(false);
    expect(counts('localhost', false)).toBe(false);
    expect(counts('zerodust-frontend-git-x.vercel.app', false)).toBe(false);
  });

  it('sends only the event name', () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('window', { location: { hostname: 'www.zerodust.xyz' } });
    track('sweep-dialog');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.zerodust.xyz/events');
    expect(JSON.parse(String(init.body))).toEqual({ event: 'sweep-dialog' });
  });

  it('sends nothing off the live site', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    track('home');
    expect(fetch).not.toHaveBeenCalled();
  });
});
