import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { verifySponsoredAcross, type SponsoredAcrossExpect } from '../src/sweep/across-route';

// Live Across swap API answers, 2026-10-06. ZeroDust uses Across only for ETH to ETH as a plain
// deposit (owner, 2026-10-06); every swap-shaped answer here must be refused.
const SAMPLES = JSON.parse(readFileSync(new URL('./fixtures/across-sponsored-2026-10-06.json', import.meta.url), 'utf8')) as Record<string, { to: string; data: Hex; minOutputAmount: string }>;
const USER = '0x820653ccE8a755edbb52eC1bc5829D2a60CD5cc5';
const EVIL = '0x000000000000000000000000000000000000dEaD';
const PLAIN = '10-8453';

const ABI = parseAbi([
  'function depositNative(address spokePool, address depositor, bytes32 recipient, address inputToken, uint256 inputAmount, bytes32 outputToken, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)',
]);
const VALUES: Record<string, bigint> = { '8453-137-split': 518_000_000_000_000_000n, '42161-56-lifi': 50_000_000_000_000_000n, '137-8453-nofallback': 200_000_000_000_000_000_000n };

const expect_ = (k: string, over: Partial<SponsoredAcrossExpect> = {}): SponsoredAcrossExpect => {
  const [from, to] = k.split('-').map(Number) as [number, number];
  return { fromChainId: from, toChainId: to, user: USER, recipient: USER, value: VALUES[k] ?? 2_000_000_000_000_000n, minNative: BigInt(SAMPLES[k]!.minOutputAmount), ...over };
};

/** Rewrites one argument of the plain sample's depositNative */
const plain = (edit: (args: unknown[]) => void) => {
  const args = [...decodeFunctionData({ abi: ABI, data: SAMPLES[PLAIN]!.data }).args!] as unknown[];
  edit(args);
  return { to: SAMPLES[PLAIN]!.to, data: encodeFunctionData({ abi: ABI, functionName: 'depositNative', args: args as never }) };
};

describe('verifySponsoredAcross: plain ETH deposits only', () => {
  it('a plain deposit (OP -> Base, WETH in, WETH out paid as ETH) passes', () => {
    expect(() => verifySponsoredAcross(SAMPLES[PLAIN]!, expect_(PLAIN))).not.toThrow();
  });

  it.each(Object.keys(SAMPLES).filter((k) => k !== PLAIN))('%s (a swap route) is refused', (k) => {
    expect(() => verifySponsoredAcross(SAMPLES[k]!, expect_(k))).toThrow(/^Across route refused: /);
  });

  it('refuses a destination message, another recipient, another token, a smaller amount', () => {
    expect(() => verifySponsoredAcross(plain((a) => { a[12] = '0x1234'; }), expect_(PLAIN))).toThrow(/destination message/);
    expect(() => verifySponsoredAcross(SAMPLES[PLAIN]!, expect_(PLAIN, { recipient: EVIL }))).toThrow(/pays someone other than the address you set/);
    expect(() => verifySponsoredAcross(plain((a) => { a[5] = `0x${EVIL.slice(2).toLowerCase().padStart(64, '0')}`; }), expect_(PLAIN))).toThrow(/another token than ETH/);
    expect(() => verifySponsoredAcross(plain((a) => { a[6] = 1n; }), expect_(PLAIN))).toThrow(/less than the amount shown/);
  });

  it('refuses refunds to another wallet, another amount, a non-WETH input, another SpokePool or periphery, another chain', () => {
    expect(() => verifySponsoredAcross(SAMPLES[PLAIN]!, expect_(PLAIN, { user: EVIL }))).toThrow(/refunds go to/);
    expect(() => verifySponsoredAcross(SAMPLES[PLAIN]!, expect_(PLAIN, { value: 1n }))).toThrow(/not the amount sent/);
    expect(() => verifySponsoredAcross(plain((a) => { a[3] = EVIL; }), expect_(PLAIN))).toThrow(/not WETH on the source/);
    expect(() => verifySponsoredAcross(plain((a) => { a[0] = EVIL; }), expect_(PLAIN))).toThrow(/not Across's SpokePool/);
    expect(() => verifySponsoredAcross({ ...SAMPLES[PLAIN]!, to: EVIL }, expect_(PLAIN))).toThrow(/not the Across periphery/);
    expect(() => verifySponsoredAcross(plain((a) => { a[7] = 42161n; }), expect_(PLAIN))).toThrow(/goes to chain 42161/);
  });

  it('refuses a destination where Across does not deliver ETH (BNB Chain)', () => {
    expect(() => verifySponsoredAcross(SAMPLES[PLAIN]!, expect_(PLAIN, { toChainId: 56 }))).toThrow(/^Across route refused: /);
  });
});
