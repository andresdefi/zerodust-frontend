import { expect, test, type Page } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mockNetwork, TELOS, watchForKey } from './fixtures';

// The sweep engine's checks, through the address page: what the old /sweep page's tests
// covered, kept when that page was removed (2026-10-08).

type NetOpts = Parameters<typeof mockNetwork>[2];

async function openAddress(page: Page, opts: NetOpts = {}) {
  const key = generatePrivateKey();
  const user = privateKeyToAccount(key).address;
  const net = await mockNetwork(page, user, opts);
  await page.goto(`/address/${user}`);
  await expect(page.locator('section.ap-grp').first()).toBeVisible();
  return { key, user, ...net };
}

const group = (page: Page, title: string | RegExp) => page.locator('section.ap-grp', { has: page.getByRole('heading', { name: title }) });

/** Selects exactly these chains in a group and starts its sweep */
async function sweepOnly(page: Page, title: string | RegExp, names: string[]) {
  const g = group(page, title);
  const all = g.getByRole('checkbox', { name: /^Select all in/ });
  // Make the group active with nothing selected, then pick the chains
  await all.click();
  if (await all.isChecked()) await all.click();
  for (const name of names) await g.getByRole('checkbox', { name: `Select ${name}` }).check();
  await g.getByRole('button', { name: `Sweep ${names.length} ${names.length === 1 ? 'chain' : 'chains'}` }).click();
}

/** The "Sweep with" dialog: the key, typed (never pasted) */
async function useKey(page: Page, key: string) {
  const dialog = page.getByRole('dialog', { name: /chains? with/ });
  await dialog.getByRole('button', { name: /Private key/ }).click();
  await dialog.locator('.keyfield input').focus();
  await page.keyboard.type(key, { delay: 1 });
  await page.keyboard.press('Enter');
}

const confirmDialog = (page: Page) => page.locator('dialog.zd-confirm');

async function confirmSweep(page: Page, n: number) {
  const dialog = confirmDialog(page);
  await expect(dialog.getByRole('button', { name: `Sweep ${n} ${n === 1 ? 'chain' : 'chains'}` })).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: `Sweep ${n} ${n === 1 ? 'chain' : 'chains'}` }).click();
}

const row = (page: Page, name: string) => page.locator('.ap-row', { hasText: name });

test('the key never reaches the DOM, an input value, storage, a request or the console, and the page keeps its CSP', async ({ page }) => {
  const { key } = await openAddress(page);
  const watch = await watchForKey(page, key);
  await group(page, 'Arrives as gas on Base').getByRole('button', { name: 'Sweep 1 chain' }).click();
  const dialog = page.getByRole('dialog', { name: /chain with/ });
  await dialog.getByRole('button', { name: /Private key/ }).click();
  const input = dialog.locator('.keyfield input');
  await input.focus();
  await page.keyboard.type(key, { delay: 2 });
  await expect(dialog.locator('#key-count')).toHaveText('66 characters');
  expect(await input.inputValue()).toBe('');
  await watch.checkPage();
  await page.keyboard.press('Enter');
  await confirmSweep(page, 1);
  await expect(row(page, 'Optimism')).toContainText('Done · 0 left', { timeout: 30_000 });
  await watch.checkPage();
  expect(watch.leaks).toEqual([]);
  expect(watch.cspViolations).toEqual([]);
});

test('pasting a key wipes the clipboard', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { key } = await openAddress(page);
  await group(page, 'Arrives as gas on Base').getByRole('button', { name: 'Sweep 1 chain' }).click();
  const dialog = page.getByRole('dialog', { name: /chain with/ });
  await dialog.getByRole('button', { name: /Private key/ }).click();
  await page.evaluate((k) => navigator.clipboard.writeText(k), key);
  await dialog.locator('.keyfield input').focus();
  await page.keyboard.press('ControlOrMeta+V');
  // A whole key pasted is used at once: the confirmation follows
  await expect(confirmDialog(page).getByRole('button', { name: 'Sweep 1 chain' })).toBeVisible({ timeout: 30_000 });
  // The site's Permissions-Policy blocks clipboard reads, so read it from a
  // helper page served without that policy
  const reader = await context.newPage();
  await reader.route('http://localhost:4175/__clipboard', (r) => r.fulfill({ contentType: 'text/html', body: '<p>clipboard</p>' }));
  await reader.goto('http://localhost:4175/__clipboard');
  expect(await reader.evaluate(() => navigator.clipboard.readText())).toBe('');
});

test('rejects something that is not a key, without echoing it', async ({ page }) => {
  await openAddress(page);
  await group(page, 'Arrives as gas on Base').getByRole('button', { name: 'Sweep 1 chain' }).click();
  const dialog = page.getByRole('dialog', { name: /chain with/ });
  await dialog.getByRole('button', { name: /Private key/ }).click();
  await dialog.locator('.keyfield input').focus();
  await page.keyboard.type('abc123');
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('alert')).toHaveText(/not a private key/);
  await expect(dialog).not.toContainText('abc123');
  await expect(dialog.locator('#key-count')).toHaveText('Paste or type');
});

test('while ZeroDust is paused: the sweep dialog says so and takes no key; nothing when it works', async ({ page }) => {
  const { user } = await openAddress(page, { paused: true });
  await group(page, 'Arrives as gas on Base').getByRole('button', { name: 'Sweep 1 chain' }).click();
  const dialog = page.getByRole('dialog', { name: /chain with/ });
  await expect(dialog.getByRole('status')).toContainText('ZeroDust is paused');
  await expect(dialog.getByRole('button', { name: /Private key/ })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: /MetaMask/ })).toBeDisabled();

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await mockNetwork(page, user);
  await page.reload();
  await group(page, 'Arrives as gas on Base').getByRole('button', { name: 'Sweep 1 chain' }).click();
  await expect(page.getByRole('dialog', { name: /chain with/ }).getByRole('button', { name: /Private key/ })).toBeEnabled();
  await expect(page.getByText('ZeroDust is paused')).toHaveCount(0);
});

test('sweeps a direct chain: plan checked and replayed in the page, signed here, sent to the chain, reported once', async ({ page }) => {
  const { key, swept, sent, reports } = await openAddress(page, { direct: true });
  const watch = await watchForKey(page, key);
  await sweepOnly(page, 'Arrives as gas on Base', ['Avalanche']);
  await useKey(page, key);
  await confirmSweep(page, 1);
  await expect(row(page, 'Avalanche')).toContainText('Done · 0 left', { timeout: 60_000 });
  // Two signed legacy transactions went to the chain's RPC: the fee, then the deposit
  expect(sent).toHaveLength(2);
  expect(sent.every((raw) => raw.startsWith('0xf8') || raw.startsWith('0xf9'))).toBe(true);
  expect(swept.has(43114)).toBe(true);
  // A direct sweep is reported once, done, with both transactions (the API never sees it otherwise)
  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0]).toMatchObject({ kind: 'direct', outcome: 'done', chainId: 43114, route: 'gaszip', mode: 'route' });
  expect(reports[0]!.txHashes).toHaveLength(2);
  expect(reports[0]).not.toHaveProperty('failureKind');
  await watch.checkPage();
  expect(watch.leaks).toEqual([]);
  expect(watch.cspViolations).toEqual([]);
});

test('refuses a direct plan that pays someone else, and sends nothing', async ({ page }) => {
  const { key, sent } = await openAddress(page, { direct: true, tamper: true });
  await sweepOnly(page, 'Arrives as gas on Base', ['Avalanche']);
  await useKey(page, key);
  const dialog = confirmDialog(page);
  await expect(dialog.getByRole('heading', { name: 'Nothing can be swept right now' })).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator('.zd-cl', { hasText: 'Avalanche' })).toContainText(/Gas\.zip deposit does not name the address you set|safety check/);
  await expect(dialog.getByRole('button', { name: /^Sweep/ })).toHaveCount(0);
  expect(sent).toEqual([]);
});

test('a chain whose bridges cannot reach the destination goes to another chain the user picks', async ({ page }) => {
  const { key, swept, sent } = await openAddress(page, { direct: true, onlyTo: 10 });
  // After the route is asked again (twice, 3 s apart), Avalanche is known not to reach Base
  const elsewhere = group(page, "Can't reach Base");
  await expect(elsewhere).toContainText('Avalanche', { timeout: 20_000 });
  await elsewhere.getByRole('button', { name: 'Choose a chain' }).click();
  await page.getByRole('dialog', { name: 'Receive on' }).getByRole('button', { name: /^Optimism/ }).click();
  await expect(elsewhere.getByRole('button', { name: /To Optimism/ })).toBeVisible();
  await sweepOnly(page, "Can't reach Base", ['Avalanche']);
  await useKey(page, key);
  await expect(confirmDialog(page).getByRole('heading', { name: 'Sweep 1 chain to Optimism?' })).toBeVisible({ timeout: 30_000 });
  await confirmSweep(page, 1);
  await expect(row(page, 'Avalanche')).toContainText('Done · 0 left', { timeout: 60_000 });
  expect(sent).toHaveLength(2);
  expect(swept.has(43114)).toBe(true);
});

test('a passing "unknown" route does not send a chain elsewhere', async ({ page }) => {
  await openAddress(page, { direct: true, hiccups: 1 });
  await expect(group(page, 'Arrives as gas on Base')).toContainText('Avalanche');
  await page.waitForTimeout(4_000);
  await expect(group(page, 'Arrives as gas on Base')).toContainText('Avalanche');
  await expect(page.getByRole('heading', { name: /Can't reach/ })).toHaveCount(0);
});

test('token delivery: Mitosis is swept to exactly 0 and arrives as MITO (a token) on BNB Chain, said plainly', async ({ page }) => {
  const { key, swept } = await openAddress(page, { mitosis: true });
  const tokens = group(page, 'Arrives as a token');
  await expect(tokens.locator('.ap-row', { hasText: 'Mitosis' })).toContainText('MITO on BNB Chain');
  await sweepOnly(page, 'Arrives as a token', ['Mitosis']);
  await useKey(page, key);
  const dialog = confirmDialog(page);
  await expect(dialog.getByRole('heading', { name: 'Sweep 1 chain as tokens?' })).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText('arrives as MITO on BNB Chain');
  await expect(dialog).toContainText(/MITO/);
  await confirmSweep(page, 1);
  await expect(row(page, 'Mitosis')).toContainText('Done · 0 left', { timeout: 60_000 });
  expect(swept.has(124816)).toBe(true);
});

test('token delivery, own wallet only: Endurance goes as ACE to this wallet on BNB Chain', async ({ page }) => {
  const { key, swept } = await openAddress(page, { endurance: true });
  await expect(group(page, 'Arrives as a token').locator('.ap-row', { hasText: 'Endurance' })).toContainText('ACE on BNB Chain');
  await sweepOnly(page, 'Arrives as a token', ['Endurance']);
  await useKey(page, key);
  await expect(confirmDialog(page)).toContainText('arrives as ACE on BNB Chain', { timeout: 30_000 });
  await confirmSweep(page, 1);
  await expect(row(page, 'Endurance')).toContainText('Done · 0 left', { timeout: 60_000 });
  expect(swept.has(648)).toBe(true);
});

test('token delivery to another recipient: Endurance is left out, the bridge pays only the sending wallet', async ({ page }) => {
  const { key, swept } = await openAddress(page, { endurance: true });
  await page.getByRole('button', { name: 'Send to another address' }).click();
  await page.getByRole('textbox', { name: 'Send to address' }).fill('0x2222222222222222222222222222222222222222');
  await page.getByRole('region', { name: 'Where swept gas goes' }).getByRole('button', { name: 'Use this address' }).click();
  await expect(page.getByRole('region', { name: 'Where swept gas goes' })).toContainText('(another address)');
  // Said on the row before anything is signed, and not selected
  const endurance = row(page, 'Endurance');
  await expect(endurance.getByText('Your wallet only')).toHaveAttribute('title', /can only be swept to your own wallet/);
  await expect(group(page, 'Arrives as a token').getByRole('button', { name: 'Sweep 0 chains' })).toBeVisible();
  // Ticked anyway: the page refuses it before signing
  await sweepOnly(page, 'Arrives as a token', ['Endurance']);
  await useKey(page, key);
  const dialog = confirmDialog(page);
  await expect(dialog.getByRole('heading', { name: 'Nothing can be swept right now' })).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator('.zd-cl', { hasText: 'Endurance' })).toContainText('Stopped before signing');
  expect(swept.has(648)).toBe(false);
});

test('token exit: Telos leaves through its own bridge as TLOS (a token) on Base; fee, bridge send and the leftover, reported', async ({ page }) => {
  const { key, swept, sent, reports } = await openAddress(page, { telos: true });
  await expect(group(page, 'Arrives as a token').locator('.ap-row', { hasText: 'Telos' })).toContainText('TLOS on Base');
  await sweepOnly(page, 'Arrives as a token', ['Telos']);
  await useKey(page, key);
  const dialog = confirmDialog(page);
  await expect(dialog).toContainText('arrives as TLOS on Base', { timeout: 30_000 });
  await expect(dialog).not.toContainText('donated');
  await confirmSweep(page, 1);
  await expect(row(page, 'Telos')).toContainText('Done · 0 left', { timeout: 60_000 });
  // Fee, bridge send, then the leftover
  expect(sent).toHaveLength(3);
  expect(swept.has(TELOS)).toBe(true);
  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0]).toMatchObject({ kind: 'direct', outcome: 'done', chainId: TELOS, route: 'oft', mode: 'exit' });
});

test('a direct chain below every bridge minimum says so before anything is signed', async ({ page }) => {
  await openAddress(page, { monad: true, tooSmall: 'direct' });
  const monad = row(page, 'Monad');
  const tag = monad.getByText('Below the minimum');
  await expect(tag).toBeVisible({ timeout: 30_000 });
  await expect(tag).toHaveAttribute('title', /needs at least 64\.2 MON/);
});

test('a sponsored chain too small at the check is left out with the minimum, not a failure', async ({ page }) => {
  const { key } = await openAddress(page, { mitosis: true, tooSmall: 'check' });
  await sweepOnly(page, 'Arrives as a token', ['Mitosis']);
  await useKey(page, key);
  await expect(confirmDialog(page).locator('.zd-cl', { hasText: 'Mitosis' })).toContainText('Too small to bridge: needs at least 17.94 MITO, add 17.41 more', { timeout: 30_000 });
});

test('a sponsored chain too small at the sweep names the minimum and is reported with a reference, never the key', async ({ page }) => {
  const { key, reports } = await openAddress(page, { mitosis: true, tooSmall: 'sweep' });
  await sweepOnly(page, 'Arrives as a token', ['Mitosis']);
  await useKey(page, key);
  await confirmSweep(page, 1);
  const mitosis = row(page, 'Mitosis');
  await expect(mitosis).toContainText('Too small to bridge: needs at least 17.94 MITO, add 17.41 more', { timeout: 60_000 });
  await expect(mitosis.getByText('Too small', { exact: true })).toBeVisible();
  await expect(mitosis).not.toContainText('Check needed');
  // Reported with a reference to quote, and the details to copy hold it, never the key
  await expect(mitosis).toContainText('Ref ZD-1A2B3C01');
  await expect(mitosis.getByRole('button', { name: 'Copy details' })).toBeVisible();
  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0]).toMatchObject({ kind: 'sponsored', outcome: 'failed', failureKind: 'too-small', chainId: 124816, toChainId: 56 });
  expect(JSON.stringify(reports)).not.toContain(key.slice(2));
});

// The API does not offer Across (owner, 2026-10-02); the page still verifies one if it ever arrives
test('sweeps Monad through Across: gas-limit rules, deposit decoded and its Settler checked in the page', async ({ page }) => {
  const { key, swept, sent } = await openAddress(page, { monad: true });
  const watch = await watchForKey(page, key);
  await sweepOnly(page, 'Arrives as gas on Base', ['Monad']);
  await useKey(page, key);
  await confirmSweep(page, 1);
  await expect(row(page, 'Monad')).toContainText('Done · 0 left', { timeout: 60_000 });
  expect(sent).toHaveLength(2);
  expect(swept.has(143)).toBe(true);
  await watch.checkPage();
  expect(watch.leaks).toEqual([]);
  expect(watch.cspViolations).toEqual([]);
});

test('refuses an Across plan whose deposit pays someone else, and sends nothing', async ({ page }) => {
  const { key, sent } = await openAddress(page, { monad: true, tamper: true });
  await sweepOnly(page, 'Arrives as gas on Base', ['Monad']);
  await useKey(page, key);
  const dialog = confirmDialog(page);
  await expect(dialog.getByRole('heading', { name: 'Nothing can be swept right now' })).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator('.zd-cl', { hasText: 'Monad' })).toContainText(/fallback recipient is not the address you set|safety check/);
  expect(sent).toEqual([]);
});

test('the header says plainly when MetaMask is not installed', async ({ page }) => {
  await mockNetwork(page, privateKeyToAccount(generatePrivateKey()).address);
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect MetaMask', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(/MetaMask was not found in this browser/);
});

test("a row's own Sweep button sweeps just that chain", async ({ page }) => {
  const { key, swept } = await openAddress(page, { direct: true });
  await group(page, 'Arrives as gas on Base').getByRole('button', { name: 'Sweep Avalanche' }).click();
  await useKey(page, key);
  await expect(confirmDialog(page).getByRole('heading', { name: 'Sweep 1 chain to Base?' })).toBeVisible({ timeout: 30_000 });
  await confirmSweep(page, 1);
  await expect(row(page, 'Avalanche')).toContainText('Done · 0 left', { timeout: 60_000 });
  expect([...swept]).toEqual([43114]);
  // The other chains keep their own button
  await expect(row(page, 'Optimism').getByRole('button', { name: 'Sweep Optimism' })).toBeEnabled();
});

test('each row says how long its bridge usually takes, and warns when it has been slow lately', async ({ page }) => {
  const timings = (slowLately: boolean) => ({
    routes: { relay: { typicalSeconds: 18, p90Seconds: 40, samples: 12, slowLately } },
    pairs: { 'relay:10': { typicalSeconds: 9, samples: 4 } },
  });
  // Optimism has its own measured time
  await openAddress(page, { timings: timings(false) });
  await expect(row(page, 'Optimism').getByText('Relay · usually 9s')).toBeVisible({ timeout: 20_000 });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await openAddress(page, { timings: timings(true) });
  const slow = row(page, 'Optimism').getByText('Relay · slower lately');
  await expect(slow).toBeVisible({ timeout: 20_000 });
  await expect(slow).toHaveAttribute('title', 'Usually 9s, but slower than usual lately');
});

test('one gas group: the key sweeps a MetaMask chain and a key-only chain together; the dialog says what MetaMask would leave', async ({ page }) => {
  const { key, swept, sent } = await openAddress(page, { direct: true });
  const gas = group(page, 'Arrives as gas on Base');
  await gas.getByRole('button', { name: 'Sweep 2 chains' }).click();
  const dialog = page.getByRole('dialog', { name: /Sweep 2 chains with/ });
  await expect(dialog.getByRole('button', { name: /MetaMask/ })).toContainText('Covers 1 of 2');
  await expect(dialog).toContainText('With MetaMask, Avalanche is left for later: it needs the key');
  await expect(dialog.getByRole('button', { name: /Private key/ })).toContainText('Covers all 2');
  await useKey(page, key);
  await confirmSweep(page, 2);
  await expect(row(page, 'Optimism')).toContainText('Done · 0 left', { timeout: 60_000 });
  await expect(row(page, 'Avalanche')).toContainText('Done · 0 left', { timeout: 60_000 });
  expect([...swept].sort()).toEqual([10, 43114].sort());
  expect(sent).toHaveLength(2);
});
