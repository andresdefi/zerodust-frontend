import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mockNetwork } from './fixtures';


test('static pages render with their only script, under the site CSP', async ({ page }) => {
  const csp: string[] = [];
  page.on('console', (m) => { if (/Refused|Content Security|integrity/.test(m.text())) csp.push(m.text()); });
  for (const name of ['security', 'offline']) {
    await page.goto(`/${name}.html`);
    await expect(page.locator('h1')).toBeVisible();
  }
  await page.goto('/security.html');
  // The build record fills the site hash
  await expect(page.locator('[data-build="siteSha256"]')).toHaveText(/^[0-9a-f]{64}$/);
  await page.locator('#theme-toggle').click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBeTruthy();
  expect(csp).toEqual([]);
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
