// Closing chains on the address page (src/address/closing.ts)
import { describe, expect, it } from 'vitest';

import { announcementHref, closesLong, closesShort, stillSwept, type Closing } from '../src/address/closing';

const c = (o: Partial<Closing> = {}): Closing => ({ stage: 'closing', closesAt: '2026-10-31T00:00:00Z', cutoffAt: '2026-10-28T00:00:00Z', source: 'https://lisk.com/x', note: 'n', ...o });

describe('closing chains', () => {
  it('dates read in UTC', () => {
    expect(closesShort(c())).toBe('31 Oct');
    expect(closesLong(c())).toBe('31 October');
  });

  it('a sponsored chain stops at its cut-off, a direct chain only when closed', () => {
    expect(stillSwept({ direct: false })).toBe(true);
    expect(stillSwept({ direct: false, closing: c() })).toBe(true);
    expect(stillSwept({ direct: false, closing: c({ stage: 'cutoff' }) })).toBe(false);
    expect(stillSwept({ direct: true, closing: c({ stage: 'cutoff' }) })).toBe(true);
    expect(stillSwept({ direct: true, closing: c({ stage: 'closed' }) })).toBe(false);
  });

  it('links only plain https announcements', () => {
    expect(announcementHref(c())).toBe('https://lisk.com/x');
    expect(announcementHref(c({ source: 'javascript:alert(1)' }))).toBeUndefined();
    expect(announcementHref(c({ source: 'http://lisk.com' }))).toBeUndefined();
    expect(announcementHref(c({ source: 'https://u:p@evil.example' }))).toBeUndefined();
    expect(announcementHref(c({ source: 'not a url' }))).toBeUndefined();
  });
});
