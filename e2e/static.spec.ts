import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mockNetwork, watchForKey } from './fixtures';


test('static pages render with their only script, under the site CSP', async ({ page }) => {
  const csp: string[] = [];
  page.on('console', (m) => { if (/Refused|Content Security|integrity/.test(m.text())) csp.push(m.text()); });
  for (const path of ['security', 'offline', 'terms', 'privacy', 'docs/index', 'docs/getting-started', 'docs/api', 'docs/direct-chains', 'docs/mcp']) {
    await page.goto(`/${path}.html`);
    await expect(page.locator('h1')).toBeVisible();
  }
  // Docs sidebar marks the current page
  await page.goto('/docs/api.html');
  await expect(page.locator('.docs-nav a[aria-current="page"]')).toHaveText('REST API');
  await page.goto('/security.html');
  // The build record fills the site hash
  await expect(page.locator('[data-build="siteSha256"]')).toHaveText(/^[0-9a-f]{64}$/);
  await page.locator('#theme-toggle').click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBeTruthy();
  expect(csp).toEqual([]);
});

test('home: the numbers come from the API, and the footer links the legal pages', async ({ page }) => {
  await mockNetwork(page, privateKeyToAccount(generatePrivateKey()).address);
  await page.goto('/');
  // The mock API: Base and Optimism sweepable with MetaMask, three direct chains
  await expect(page.locator('.hm-tags').getByText('MetaMask on 2')).toBeVisible();
  await expect(page.getByText('No key needed on 2 chains.')).toBeVisible();
  await expect(page.locator('.hm-way', { hasText: 'Worked out to the wei' }).locator('.hm-count')).toHaveText('3chains');
  // The example: Base, where everything lands, holds the total after the sweep; the others read 0
  const after = page.locator('.hm-panel', { hasText: 'After the sweep' });
  await expect(after.locator('.hm-prow', { hasText: 'Base' })).toContainText('0.0115 ETH');
  await expect(after.locator('.hm-prow', { hasText: 'Arbitrum' }).locator('.hm-zero')).toHaveText('0');
  const foot = page.locator('footer.foot');
  await expect(foot.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
  await expect(foot.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
  // On an address page too
  await page.goto('/address/0x820653ccE8a755edbb52eC1bc5829D2a60CD5cc5');
  await expect(page.locator('footer.foot').getByRole('link', { name: 'Privacy' })).toBeVisible();
});

test('privacy: sweeps have an end date, and the legal basis and transfers are stated', async ({ page }) => {
  await page.goto('/privacy.html');
  const sweeps = page.locator('tr', { hasText: 'Sweeps: wallet address' });
  await expect(sweeps).toContainText('Deleted 400 days after the sweep');
  await expect(page.getByRole('heading', { name: 'Why we use your data' })).toBeVisible();
  await expect(page.getByText('Transfers outside the EEA.')).toBeVisible();
  await expect(page.getByText(/through Alchemy and Infura/)).toBeVisible();
});

test('the offline file matches its published hash and runs the address page from disk, key only, under its own CSP', async ({ page }) => {
  const record = JSON.parse(readFileSync('dist/.well-known/zerodust-build.json', 'utf8')) as { offlineSha256: string };
  const file = readFileSync('dist/download/zerodust-offline.html');
  expect(createHash('sha256').update(file).digest('hex')).toBe(record.offlineSha256);

  const csp: string[] = [];
  page.on('console', (m) => { if (/Refused|Content Security/.test(m.text())) csp.push(m.text()); });
  const key = generatePrivateKey();
  const user = privateKeyToAccount(key).address;
  await mockNetwork(page, user);
  const watch = await watchForKey(page, key);
  await page.goto(`file://${process.cwd()}/dist/download/zerodust-offline.html`);
  await expect(page.getByText('You are running the offline page from your own disk.')).toBeVisible();
  // MetaMask does not run on a file: no way to connect it
  await expect(page.getByRole('button', { name: /Connect/ })).toHaveCount(0);
  await expect(page.getByText('connect MetaMask')).toHaveCount(0);
  // Its footer links to the live site
  await expect(page.locator('footer.foot').getByRole('link', { name: 'Terms' })).toHaveAttribute('href', 'https://www.zerodust.xyz/terms');

  // The same flow as the site: the address, then its page (hash routing), then the key
  await page.getByRole('searchbox', { name: 'Address or ENS name' }).fill(user);
  await page.getByRole('button', { name: 'Find my dust' }).click();
  await expect(page).toHaveURL(new RegExp(`#/address/${user}$`));
  await expect(page.getByText('Offline page', { exact: true }).first()).toBeVisible();
  const group = page.locator('section.ap-grp', { has: page.getByRole('heading', { name: 'Arrives as gas on Base' }) });
  await expect(group).toContainText('Optimism');
  await expect(group).toContainText('which stays in this file');
  // Every chain is swept with the key here: no row is singled out as "Key only"
  await expect(group.getByText('Key only')).toHaveCount(0);
  // Logos travel inside the file
  expect(await page.locator('img.ci').first().getAttribute('src')).toMatch(/^data:image\/svg\+xml/);

  await group.getByRole('button', { name: 'Sweep 1 chain' }).click();
  const withDialog = page.getByRole('dialog', { name: /Sweep 1 chain with/ });
  // Straight to the key: no MetaMask option, no way back to one
  await expect(withDialog.locator('.keyfield input')).toBeVisible();
  await expect(withDialog.getByRole('button', { name: /MetaMask/ })).toHaveCount(0);
  await expect(withDialog.getByRole('button', { name: 'Back' })).toHaveCount(0);
  await withDialog.locator('.keyfield input').focus();
  await page.keyboard.type(key, { delay: 1 });
  await page.keyboard.press('Enter');

  const confirm = page.getByRole('dialog', { name: /Sweep 1 chain to Base/ });
  await expect(confirm).toBeVisible({ timeout: 20_000 });
  await confirm.getByRole('button', { name: 'Sweep 1 chain' }).click();
  await expect(group.locator('.ap-row', { hasText: 'Optimism' })).toContainText('Done · 0 left', { timeout: 30_000 });
  await watch.checkPage();
  expect(watch.leaks).toEqual([]);
  expect(csp).toEqual([]);
});
