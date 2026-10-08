import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mockNetwork } from './fixtures';


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

test('privacy: sweeps have an end date, and the legal basis and transfers are stated', async ({ page }) => {
  await page.goto('/privacy.html');
  const sweeps = page.locator('tr', { hasText: 'Sweeps: wallet address' });
  await expect(sweeps).toContainText('Deleted 400 days after the sweep');
  await expect(page.getByRole('heading', { name: 'Why we use your data' })).toBeVisible();
  await expect(page.getByText('Transfers outside the EEA.')).toBeVisible();
  await expect(page.getByText(/through Alchemy and Infura/)).toBeVisible();
});

test('the offline file matches its published hash and runs from disk under its own CSP', async ({ page }) => {
  const record = JSON.parse(readFileSync('dist/.well-known/zerodust-build.json', 'utf8')) as { offlineSha256: string };
  const file = readFileSync('dist/download/zerodust-offline.html');
  expect(createHash('sha256').update(file).digest('hex')).toBe(record.offlineSha256);

  const csp: string[] = [];
  page.on('console', (m) => { if (/Refused|Content Security/.test(m.text())) csp.push(m.text()); });
  const key = generatePrivateKey();
  await mockNetwork(page, privateKeyToAccount(key).address, { direct: true });
  await page.goto(`file://${process.cwd()}/dist/download/zerodust-offline.html`);
  await expect(page.getByText('You are running the offline page from your own disk.')).toBeVisible();
  await page.locator('.keyfield input').focus();
  await page.keyboard.type(key, { delay: 1 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.row')).toHaveCount(4);
  // Logos travel inside the file
  expect(await page.locator('img.ci').first().getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
  expect(csp).toEqual([]);
});

test('How it works: MetaMask on the site, the key on the offline page', async ({ page }) => {
  await mockNetwork(page, privateKeyToAccount(generatePrivateKey()).address);
  await page.goto('/');
  await page.getByText('How it works').click();
  await expect(page.getByText('Connect MetaMask', { exact: true }).first()).toBeVisible();
  await page.getByText('What MetaMask shows').click();
  for (const step of ['Switch to smart account', 'Grant, then Confirm', 'One signature']) {
    await expect(page.getByText(step, { exact: true })).toBeVisible();
  }

  await page.goto(`file://${process.cwd()}/dist/download/zerodust-offline.html`);
  await page.getByText('How it works').click();
  await expect(page.getByText('Load the wallet', { exact: true })).toBeVisible();
  await expect(page.getByText('What MetaMask shows')).toHaveCount(0);
});
