import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DIRECT_RPC_URLS, ETHEREUM_FALLBACK_RPC, RPC_URLS } from '../src/chains/rpcs';
import { mockNetwork } from './fixtures';

// "Waiting to be claimed" (own bridge, phase 2): each withdrawal's stage read from the chain and
// Ethereum, and the claim sent from the page. The chain reads replay real answers
// (tests/fixtures/claims-2026-10-12.json); nothing leaves the machine and nothing is sent.

const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/claims-2026-10-12.json', import.meta.url), 'utf8')) as {
  now: number;
  cases: Array<{ name: string; chainId: number; txHash: string; recipient: string; amount: string }>;
  responses: Record<string, { result?: unknown; error?: unknown }>;
};
const ETH = new URL(RPC_URLS[1]!).origin;
const L2 = [1135, 42170, 81457, 2741, 1625].map((id) => new URL((RPC_URLS[id] ?? DIRECT_RPC_URLS[id])!).origin);
const ORIGINS = new Set([ETH, new URL(ETHEREUM_FALLBACK_RPC).origin, ...L2]);
const GWEI = 1_000_000_000n;

/** The recorded chain answers, plus what pricing a transaction on Ethereum asks (not recorded) */
async function replayChains(page: Page, balanceWei: bigint) {
  await page.route((url) => ORIGINS.has(url.origin), async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' } });
    const origin = new URL(route.request().url()).origin;
    const body = route.request().postDataJSON() as { id: number; method: string; params?: unknown[] };
    const l1 = !L2.includes(origin);
    const generic: Record<string, unknown> = {
      eth_estimateGas: '0x1b9a3', // 113,059
      eth_getBalance: `0x${balanceWei.toString(16)}`,
      eth_maxPriorityFeePerGas: `0x${GWEI.toString(16)}`,
      eth_gasPrice: `0x${(2n * GWEI).toString(16)}`,
    };
    let result: unknown;
    if (l1 && body.method in generic) result = generic[body.method];
    else if (l1 && body.method === 'eth_getBlockByNumber' && body.params?.[0] === 'latest') {
      result = { number: '0x1', hash: `0x${'11'.repeat(32)}`, baseFeePerGas: `0x${GWEI.toString(16)}`, timestamp: '0x1', transactions: [], gasLimit: '0x1c9c380', gasUsed: '0x0' };
    } else {
      const key = `${l1 ? ETH : origin} ${body.method} ${JSON.stringify(body.params ?? [])}`;
      const hit = fixture.responses[key];
      // A chain that never saw the transaction answers null
      if (!hit && body.method === 'eth_getTransactionReceipt') return route.fulfill({ headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null }) });
      if (!hit) return route.fulfill({ status: 500, body: `not recorded: ${key}` });
      return route.fulfill({ headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, ...hit }) });
    }
    return route.fulfill({ headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) });
  });
}

async function openWithClaim(page: Page, balanceWei: bigint) {
  const user = privateKeyToAccount(generatePrivateKey()).address;
  await mockNetwork(page, user);
  await replayChains(page, balanceWei);
  const nova = fixture.cases.find((c) => c.name === 'nova ready to claim')!;
  const claim = {
    chainId: 42170, chainName: 'Arbitrum Nova', explorerUrl: 'https://nova.arbiscan.io', symbol: 'ETH', decimals: 18,
    from: user, recipient: nova.recipient, amount: nova.amount, txHash: nova.txHash, sentAt: fixture.now - 8 * 86_400_000,
  };
  await page.addInitScript((c) => { localStorage.setItem('zd.pending-claims.v1', JSON.stringify([c])); }, claim);
  await page.goto(`/address/${user}`);
  return page.getByRole('region', { name: 'Waiting to be claimed' });
}

test('a withdrawal ready to claim: its stage from the chain, the cost, and a payer without enough ETH stopped before signing', async ({ page }) => {
  const card = await openWithClaim(page, 0n);
  await expect(card.getByText('Ready to claim')).toBeVisible({ timeout: 20_000 });
  await card.getByRole('button', { name: 'Claim' }).click();
  const dialog = page.getByRole('dialog', { name: 'Claim on Ethereum' });
  await expect(dialog).toContainText('Any wallet can pay the gas');
  await dialog.getByRole('button', { name: /Private key/ }).click();
  await dialog.locator('.keyfield input').focus();
  await page.keyboard.type(generatePrivateKey(), { delay: 1 });
  await page.keyboard.press('Enter');
  await expect(dialog).toContainText('Gas on Ethereum');
  await expect(dialog).toContainText('holds less than the most it can cost');
  await expect(dialog.getByRole('button', { name: 'Claim now' })).toBeDisabled();
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT.replace('.png', '-dialog.png') });
  await dialog.getByRole('button', { name: 'Close' }).click();
  if (process.env.SHOT) await card.screenshot({ path: process.env.SHOT });
});

test('with enough ETH the claim can be sent', async ({ page }) => {
  const card = await openWithClaim(page, 10n ** 17n);
  await card.getByRole('button', { name: 'Claim' }).click({ timeout: 20_000 });
  const dialog = page.getByRole('dialog', { name: 'Claim on Ethereum' });
  await dialog.getByRole('button', { name: /Private key/ }).click();
  await dialog.locator('.keyfield input').focus();
  await page.keyboard.type(generatePrivateKey(), { delay: 1 });
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Claim now' })).toBeEnabled();
});

test('a withdrawal sent from another browser: added by its transaction hash, then read from the chain', async ({ page }) => {
  const user = privateKeyToAccount(generatePrivateKey()).address;
  await mockNetwork(page, user);
  await replayChains(page, 0n);
  await page.goto(`/address/${user}`);
  const link = page.getByRole('button', { name: /from another browser\? Add the withdrawal/ });
  await expect(link).toBeVisible();
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT.replace('.png', '-empty.png'), fullPage: true });
  await link.click();
  const input = page.getByLabel(/The withdrawal's transaction/);
  await input.fill(`0x${'ab'.repeat(32)}`);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('No withdrawal through a chain\'s own bridge');
  await input.fill(fixture.cases.find((c) => c.name === 'nova ready to claim')!.txHash);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const card = page.getByRole('region', { name: 'Waiting to be claimed' });
  await expect(card.locator('.ap-claim', { hasText: 'Arbitrum Nova' })).toContainText('Ready to claim', { timeout: 20_000 });
  if (process.env.SHOT) await card.screenshot({ path: process.env.SHOT.replace('.png', '-added.png') });
});
