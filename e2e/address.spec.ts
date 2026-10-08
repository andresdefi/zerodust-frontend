import { expect, test } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mockNetwork, watchForKey } from './fixtures';

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
  const picker = page.getByRole('dialog', { name: 'Receive on' }).filter({ visible: true });
  await picker.getByLabel('Search chains').fill('Optimism');
  await picker.locator('.pick', { hasText: 'Optimism' }).first().click();
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

test('sweeps a group with the key of this address: the key stays out of the page, the confirm lists every chain, rows end at 0 with their links', async ({ page }) => {
  const key = generatePrivateKey();
  const user = privateKeyToAccount(key).address;
  await mockNetwork(page, user);
  const watch = await watchForKey(page, key);
  await page.goto(`/address/${user}`);

  const group = (title: string) => page.locator('section.ap-grp', { has: page.getByRole('heading', { name: title }) });
  // Default destination Base (to this wallet): Optimism is what moves in the MetaMask-or-key group
  await expect(group('MetaMask or key').locator('.ap-row')).toHaveCount(1);
  await group('MetaMask or key').getByRole('button', { name: 'Sweep 1 chain' }).click();

  const withDialog = page.getByRole('dialog', { name: /Sweep 1 chain with/ });
  await expect(withDialog).toContainText('MetaMask');
  await withDialog.getByRole('button', { name: /Private key/ }).click();

  // Another wallet's key is refused before anything happens
  const input = withDialog.locator('.keyfield input');
  await input.focus();
  await page.keyboard.type(generatePrivateKey(), { delay: 1 });
  await page.keyboard.press('Enter');
  await expect(withDialog.getByRole('alert')).toContainText('not');

  await input.focus();
  await page.keyboard.type(key, { delay: 1 });
  await watch.checkPage();
  await page.keyboard.press('Enter');

  const confirm = page.getByRole('dialog', { name: /Sweep 1 chain to Base/ });
  await expect(confirm).toBeVisible({ timeout: 20_000 });
  await expect(confirm).toContainText('Optimism');
  await expect(confirm).toContainText('You receive at least');
  await watch.checkPage();
  await confirm.getByRole('button', { name: 'Sweep 1 chain' }).click();

  const row = group('MetaMask or key').locator('.ap-row', { hasText: 'Optimism' });
  await expect(row).toContainText('Done · 0 left', { timeout: 30_000 });
  await expect(row.getByRole('link', { name: 'Sent ↗' })).toHaveAttribute('href', /optimistic\.etherscan\.io\/tx\/0x/);
  await expect(page.getByRole('button', { name: 'Refresh balances' })).toBeVisible();
  // A chain swept to 0 is not offered again until the balances are read again
  await expect(group('MetaMask or key').getByRole('button', { name: 'Sweep 0 chains' })).toBeDisabled();
  await expect(page.locator('.ap-sticky').getByRole('button')).toBeDisabled();
  await watch.checkPage();
  expect(watch.leaks).toEqual([]);
});

test('"Stays on its own chain": the gas goes to an address on the same chain, after one is given', async ({ page }) => {
  const key = generatePrivateKey();
  const user = privateKeyToAccount(key).address;
  await mockNetwork(page, user);
  await page.goto(`/address/${user}`);
  const group = page.locator('section.ap-grp', { has: page.getByRole('heading', { name: 'Stays on its own chain' }) });
  await expect(group).toContainText('Scroll');
  await expect(group.getByRole('button', { name: 'Sweep 1 chain' })).toBeDisabled();
  await group.getByLabel('Address on each chain').fill('0x000000000000000000000000000000000000bEEF');
  await group.getByRole('button', { name: 'Use this address' }).click();
  await expect(group).toContainText('0x000000000000000000000000000000000000bEEF');
  await group.getByRole('button', { name: 'Sweep 1 chain' }).click();
  await page.getByRole('dialog', { name: /with/ }).getByRole('button', { name: /Private key/ }).click();
  await page.locator('.zd-with .keyfield input').focus();
  await page.keyboard.type(key, { delay: 1 });
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('dialog', { name: /to an address on its chain/ });
  await expect(confirm).toBeVisible({ timeout: 20_000 });
  await expect(confirm).toContainText('0x0000…bEEF');
  await confirm.getByRole('button', { name: 'Sweep 1 chain' }).click();
  await expect(group.locator('.ap-row', { hasText: 'Scroll' })).toContainText('Done · 0 left', { timeout: 30_000 });
});

async function loadKeyAndBackOut(page: import('@playwright/test').Page, key: string) {
  const group = page.locator('section.ap-grp', { has: page.getByRole('heading', { name: 'MetaMask or key' }) });
  await group.getByRole('button', { name: 'Sweep 1 chain' }).click();
  await page.getByRole('dialog', { name: /with/ }).getByRole('button', { name: /Private key/ }).click();
  await page.locator('.zd-with .keyfield input').focus();
  await page.keyboard.type(key, { delay: 1 });
  await page.keyboard.press('Enter');
  // Back out at the confirm: no sweep session runs, the key is still held
  const confirm = page.getByRole('dialog', { name: /Sweep 1 chain to Base/ });
  await expect(confirm).toBeVisible({ timeout: 20_000 });
  await confirm.getByRole('button', { name: 'Back' }).click();
  await expect(page.locator('.ap-acct')).toContainText('Key loaded');
}

test('a loaded key is forgotten after 15 idle minutes, also between groups (no sweep session open)', async ({ page }) => {
  const key = generatePrivateKey();
  const user = privateKeyToAccount(key).address;
  await mockNetwork(page, user);
  await page.goto(`/address/${user}`);
  await loadKeyAndBackOut(page, key);
  const acct = page.locator('.ap-acct');
  // From here time is simulated: any activity restarts the idle timer on the fake clock
  await page.clock.install();
  await page.locator('.ap-acct h1').click();
  await page.clock.runFor(15 * 60 * 1000 - 5000);
  await expect(acct).toContainText('Key loaded');
  await page.clock.runFor(10_000);
  await expect(acct).toContainText('Not connected', { timeout: 10_000 });
});

test('"Forget it" drops a loaded key at once', async ({ page }) => {
  const key = generatePrivateKey();
  const user = privateKeyToAccount(key).address;
  await mockNetwork(page, user);
  await page.goto(`/address/${user}`);
  await loadKeyAndBackOut(page, key);
  await page.locator('.ap-acct').getByRole('button', { name: 'Forget it' }).click();
  await expect(page.locator('.ap-acct')).toContainText('Not connected', { timeout: 10_000 });
});
