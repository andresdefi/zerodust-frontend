import { afterEach, describe, expect, it, vi } from 'vitest';
import { counts, sourceOf, track, trackVisit } from '../src/lib/events';

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

  it('names the kind of site a visit came from, never the URL', () => {
    expect(sourceOf('')).toBe('from-direct');
    expect(sourceOf('https://t.co/')).toBe('from-x');
    expect(sourceOf('https://x.com/someone/status/1')).toBe('from-x');
    expect(sourceOf('https://mobile.twitter.com/')).toBe('from-x');
    expect(sourceOf('https://hiddenfunds.xyz/archived')).toBe('from-hiddenfunds');
    expect(sourceOf('https://www.google.com/')).toBe('from-search');
    expect(sourceOf('https://www.google.co.uk/')).toBe('from-search');
    expect(sourceOf('https://duckduckgo.com/')).toBe('from-search');
    expect(sourceOf('https://search.brave.com/')).toBe('from-search');
    expect(sourceOf('https://www.reddit.com/r/ethereum')).toBe('from-other');
    expect(sourceOf('https://notx.com/')).toBe('from-other');
    expect(sourceOf('not a url')).toBe('from-other');
    // Moving between this site's own pages is not a new visit
    expect(sourceOf('https://www.zerodust.xyz/docs')).toBeNull();
    expect(sourceOf('https://zerodust.xyz/')).toBeNull();
  });

  it('a visit counts its source once, and the first error from its own scripts once', () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const listeners: Record<string, (e: unknown) => void> = {};
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('document', { referrer: 'https://t.co/' });
    vi.stubGlobal('window', {
      location: { hostname: 'www.zerodust.xyz', origin: 'https://www.zerodust.xyz' },
      addEventListener: (type: string, f: (e: unknown) => void) => { listeners[type] = f; },
    });
    trackVisit();
    listeners.error!({ filename: 'chrome-extension://abc/inpage.js' });
    listeners.error!({ filename: 'https://www.zerodust.xyz/assets/index.js' });
    listeners.error!({ filename: 'https://www.zerodust.xyz/assets/index.js' });
    listeners.unhandledrejection!({});
    const sent = fetch.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)).event);
    expect(sent).toEqual(['from-x', 'page-error']);
  });
});
