import { expect, test } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mockNetwork } from './fixtures';

// The address page (redesign phase 2): read-only, any address, chains grouped by how
// they are swept and what arrives, one group selected at a time.

test('groups every chain by how it is swept, quotes the gas groups, and selects one group at a time', async ({ page }) => {
  const user = privateKeyToAccount(generatePrivateKey()).address;
  await mockNetwork(page, user, { direct: true, mitosis: true });
  await page.goto(`/address/${user}`);

  const group = (title: string) => page.locator('section.ap-grp', { has: page.getByRole('heading', { name: title }) });
  const dest = page.getByRole('region', { name: 'Where swept gas goes' });
  // Default destination: the chain holding most of the wallet's bridgeable gas, said plainly and changeable
  await expect(dest).toContainText('Base');
  await expect(dest).toContainText('Picked because most of this wallet\'s gas is already on Base');
  // Sent to this same wallet, Base's own balance already is where everything goes: not a sweep
  await expect(dest).toContainText('Already on Base');
  await expect(group('MetaMask or key').locator('.ap-row')).toHaveCount(1);
  await expect(group('MetaMask or key')).toContainText('Optimism');
  await expect(group('Key only')).toContainText('Avalanche');
  await expect(group('Arrives as a token')).toContainText('MITO on BNB Chain');
  await expect(group('Stays on its own chain')).toContainText('Scroll');
  await expect(page.locator('.ap-kpis')).toContainText('5');

  // Quoted against the default chain
  await expect(group('MetaMask or key').locator('.ap-recv').first()).toContainText('ETH');
  await expect(page.locator('.ap-sticky')).toContainText('MetaMask or key · 1 chain');
  await expect(page.locator('.ap-sticky')).toContainText('you receive at least');

  // Another chain: Base becomes a source, Optimism the one already in place
  await dest.getByRole('button', { name: 'Change chain' }).click();
  await page.getByLabel('Search chains').fill('Optimism');
  await page.locator('.pick', { hasText: 'Optimism' }).first().click();
  await expect(dest).toContainText('Already on Optimism');
  await expect(dest).not.toContainText('Picked because');
  await expect(group('MetaMask or key')).toContainText('Base');

  // To another address, the destination chain's own balance is a real same-chain transfer
  await dest.getByRole('button', { name: 'Send to another address' }).click();
  await dest.getByLabel('Send to address').fill('0x000000000000000000000000000000000000bEEF');
  await dest.getByRole('button', { name: 'Use this address' }).click();
  await expect(dest).toContainText('(another address)');
  await expect(dest).not.toContainText('Already on');
  await expect(group('MetaMask or key').locator('.ap-row')).toHaveCount(2);

  // Ticking a chain in another group starts a selection there; the first group lets go
  await group('Stays on its own chain').getByRole('checkbox', { name: 'Select Scroll' }).check();
  await expect(page.locator('.ap-sticky')).toContainText('Stays on its own chain · 1 chain');
  await expect(group('MetaMask or key').getByRole('checkbox', { name: 'Select Base' })).not.toBeChecked();
  await expect(group('Stays on its own chain')).toHaveClass(/active/);
});

test('home: the search opens the address page; a bad entry says why', async ({ page }) => {
  const user = privateKeyToAccount(generatePrivateKey()).address;
  await mockNetwork(page, user);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Leave nothing behind.' })).toBeVisible();
  await page.getByLabel('Address or ENS name').fill(user);
  await page.getByRole('button', { name: 'Find my dust' }).click();
  await expect(page).toHaveURL(new RegExp(`/address/${user}$`));
  await expect(page.locator('section.ap-grp').first()).toBeVisible();

  await page.getByLabel('Search any address or ENS name').fill('not-an-address');
  await page.getByLabel('Search any address or ENS name').press('Enter');
  await expect(page.getByRole('alert')).toContainText('not an address or an ENS name');
});
