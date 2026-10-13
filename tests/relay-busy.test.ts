// The API answers "Relay: busy" when Relay is over its rate limit: the page then leaves the route
// unknown instead of asking other destinations, which would ask Relay again (2026-10-13)
import { describe, expect, it } from 'vitest';
import { relayBusy } from '../src/direct/plan';

describe('relayBusy', () => {
  it('reads the API\'s busy answer, alone or among other bridges\' reasons', () => {
    expect(relayBusy({ available: null, reason: 'Relay: busy right now; try again in a minute' })).toBe(true);
    expect(relayBusy({ available: null, reason: 'Gas.zip: Chain Disabled; Relay: busy right now; try again in a minute' })).toBe(true);
  });

  it('anything else is not busy', () => {
    expect(relayBusy({ available: null, reason: 'Gas.zip: Internal error' })).toBe(false);
    expect(relayBusy({ available: null })).toBe(false);
    expect(relayBusy({ available: false, reason: 'Relay: no routes found' })).toBe(false);
  });
});
