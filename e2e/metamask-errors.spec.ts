import { expect, test, type Page } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';
import { API, mockNetwork } from './fixtures';
import { DELEGATION_MANAGER, PERMISSION_DOMAIN_VERSION, PERMISSION_ROUTER } from '../src/sweep/constants';

// What the page says, and reports, when MetaMask refuses or fails a request. MetaMask rejects
// with plain { code, message } objects; a real permission refusal on 2026-10-17 reached us only
// as "MetaMask refused the permission", with no way to tell a decline from a MetaMask error.

/** A MetaMask stand-in announced over EIP-6963: Base and Optimism grant permissions; `refuse` names the request it rejects */
async function fakeMetaMask(page: Page, user: Address, refuse: { method: string; code: number; message: string }) {
  await page.addInitScript(({ user, refuse }) => {
    const provider = {
      isMetaMask: true,
      request: async ({ method }: { method: string }) => {
        if (method === refuse.method) throw { code: refuse.code, message: refuse.message };
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [user];
        if (method === 'eth_chainId') return '0x2105';
        if (method === 'wallet_getSupportedExecutionPermissions') return { 'native-token-allowance': { chainIds: ['0x2105', '0xa'] } };
        return null;
      },
      on: () => {},
      removeListener: () => {},
    };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: Object.freeze({ info: { uuid: 'test', name: 'MetaMask', icon: 'data:,', rdns: 'io.metamask' }, provider }),
    }));
    window.addEventListener('eip6963:requestProvider', announce);
  }, { user, refuse });
}

const group = (page: Page, title: string) => page.locator('section.ap-grp', { has: page.getByRole('heading', { name: title }) });
const row = (page: Page, name: string) => page.locator('.ap-row', { hasText: name });

async function confirmOne(page: Page) {
  const confirm = page.locator('dialog.zd-confirm').getByRole('button', { name: 'Sweep 1 chain' });
  await expect(confirm).toBeVisible({ timeout: 30_000 });
  await confirm.click();
}

async function openWithMetaMask(page: Page, refuse: { method: string; code: number; message: string }) {
  const user = privateKeyToAccount(generatePrivateKey()).address;
  const net = await mockNetwork(page, user);
  // The check before the sweep: a permission quote naming the pinned contracts (nothing is signed from it)
  await page.route((url) => url.origin === API && url.pathname === '/quote' && url.searchParams.get('signer') === 'permission', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      quoteId: 'q-permission', signer: 'permission', estimatedReceive: '529832000000000000', bridge: { name: 'relay', displayName: 'Relay' },
      permission: { router: PERMISSION_ROUTER, delegationManager: DELEGATION_MANAGER, domainVersion: PERMISSION_DOMAIN_VERSION },
    }),
  }));
  await fakeMetaMask(page, user, refuse);
  await page.goto(`/address/${user}`);
  await expect(page.locator('section.ap-grp').first()).toBeVisible();
  await group(page, 'Arrives as gas on Base').getByRole('button', { name: 'Sweep Optimism' }).click();
  await page.getByRole('dialog', { name: /chains? with/ }).getByRole('button', { name: /MetaMask/ }).click();
  return net;
}

test('a declined permission says so on the row, as "Try again", and the report keeps it apart from a MetaMask error', async ({ page }) => {
  const { reports } = await openWithMetaMask(page, { method: 'wallet_requestExecutionPermissions', code: 4001, message: 'User rejected the request.' });
  await confirmOne(page);
  await expect(row(page, 'Optimism')).toContainText('You declined the permission in MetaMask. Nothing was sent.', { timeout: 30_000 });
  await expect(row(page, 'Optimism')).toContainText('Try again');
  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0]).toMatchObject({ kind: 'sponsored', outcome: 'failed', failureKind: 'try-again', detail: 'You declined the permission in MetaMask.', mode: 'permission' });
});

test("a permission MetaMask fails keeps MetaMask's words and code", async ({ page }) => {
  const { reports } = await openWithMetaMask(page, { method: 'wallet_requestExecutionPermissions', code: -32603, message: 'Internal JSON-RPC error.' });
  await confirmOne(page);
  await expect(row(page, 'Optimism')).toContainText('MetaMask could not complete the permission: Internal JSON-RPC error (code -32603). Nothing was sent.', { timeout: 30_000 });
  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0]).toMatchObject({ detail: 'MetaMask could not complete the permission: Internal JSON-RPC error (code -32603).' });
});

test('a declined connection says so in the dialog', async ({ page }) => {
  await openWithMetaMask(page, { method: 'eth_requestAccounts', code: 4001, message: 'User rejected the request.' });
  await expect(page.getByRole('dialog', { name: /chains? with/ })).toContainText('You declined the connection in MetaMask.');
});
