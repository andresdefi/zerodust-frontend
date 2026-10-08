import { expect, test, type Page } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mockNetwork, TELOS } from './fixtures';

/** Every place a key could leak to: DOM, input values, storage, requests, console */
async function watchForKey(page: Page, key: string) {
  const bare = key.slice(2).toLowerCase();
  const leaks: string[] = [];
  page.on('request', (r) => {
    const text = `${r.url()} ${r.postData() ?? ''}`.toLowerCase();
    if (text.includes(bare)) leaks.push(`request to ${r.url()}`);
  });
  page.on('console', (m) => {
    if (m.text().toLowerCase().includes(bare)) leaks.push('console');
  });
  const cspViolations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/.test(m.text())) cspViolations.push(m.text());
  });
  return {
    leaks,
    cspViolations,
    async checkPage() {
      const found = await page.evaluate((k) => {
        const html = document.documentElement.outerHTML.toLowerCase();
        const inputs = [...document.querySelectorAll('input')].map((i) => i.value.toLowerCase()).join(' ');
        const storage = JSON.stringify({ ...localStorage, ...sessionStorage }).toLowerCase();
        return [html.includes(k) && 'DOM', inputs.includes(k) && 'input value', storage.includes(k) && 'storage'].filter(Boolean);
      }, bare);
      leaks.push(...(found as string[]));
    },
  };
}

/** MetaMask is the main way in; the key is one click away (owner, 2026-10-06) */
async function useKey(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Use a private key' }).click();
}

test('the key never reaches the DOM, storage, a request or the console', async ({ page }) => {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  await mockNetwork(page, address);
  const watch = await watchForKey(page, key);

  await page.goto('/sweep');
  await useKey(page);
  const input = page.locator('.keyfield input');
  await input.focus();
  await page.keyboard.type(key, { delay: 2 });
  await expect(page.locator('#key-count')).toHaveText('66 characters');
  expect(await input.inputValue()).toBe('');
  await watch.checkPage();

  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Sweep' })).toBeVisible();
  await expect(page.locator('.wallet-line')).toContainText(address);
  await expect(page.locator('.row')).toHaveCount(3);
  await watch.checkPage();

  expect(watch.leaks).toEqual([]);
  expect(watch.cspViolations).toEqual([]);
});

test('pasting a key wipes the clipboard', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const key = generatePrivateKey();
  await mockNetwork(page, privateKeyToAccount(key).address);
  await page.goto('/sweep');
  await useKey(page);
  await page.evaluate((k) => navigator.clipboard.writeText(k), key);
  await page.locator('.keyfield input').focus();
  await page.keyboard.press('ControlOrMeta+V');
  await expect(page.locator('.wallet-line')).toContainText('Clipboard wiped.');
  // The site's Permissions-Policy blocks clipboard reads, so read it from a
  // helper page served without that policy
  const reader = await context.newPage();
  await reader.route('http://localhost:4175/__clipboard', (r) => r.fulfill({ contentType: 'text/html', body: '<p>clipboard</p>' }));
  await reader.goto('http://localhost:4175/__clipboard');
  expect(await reader.evaluate(() => navigator.clipboard.readText())).toBe('');
});

test('a loaded key is forgotten after 15 minutes without activity', async ({ page }) => {
  await page.clock.install();
  const key = generatePrivateKey();
  await mockNetwork(page, privateKeyToAccount(key).address);
  await page.goto('/sweep');
  await useKey(page);
  await expect(page.locator('.safety')).toContainText('Browser extensions can read what you type');
  await page.locator('.keyfield input').focus();
  await page.keyboard.type(key, { delay: 1 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.row')).toHaveCount(3);
  await page.clock.runFor(14 * 60 * 1000);
  await expect(page.locator('.row')).toHaveCount(3);
  await page.mouse.click(5, 5); // activity resets the timer
  await page.clock.runFor(14 * 60 * 1000);
  await expect(page.locator('.row')).toHaveCount(3);
  await page.clock.runFor(2 * 60 * 1000);
  await expect(page.locator('.keyfield input')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.safety')).toContainText('forgotten after 15 minutes without activity');
});

test('while ZeroDust is paused: says so before a key is entered and takes no key; nothing when it works', async ({ page }) => {
  const key = generatePrivateKey();
  await mockNetwork(page, privateKeyToAccount(key).address, { paused: true });
  await page.goto('/sweep');
  await expect(page.getByRole('status').filter({ hasText: 'ZeroDust is paused' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect MetaMask' })).toBeDisabled();
  await useKey(page);
  await expect(page.locator('.keyfield input')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Load wallet' })).toBeDisabled();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await mockNetwork(page, privateKeyToAccount(key).address);
  await page.reload();
  await useKey(page);
  await expect(page.locator('.keyfield input')).toBeEnabled();
  await expect(page.getByText('ZeroDust is paused')).toHaveCount(0);
});

test('rejects something that is not a key, without echoing it', async ({ page }) => {
  await mockNetwork(page, privateKeyToAccount(generatePrivateKey()).address);
  await page.goto('/sweep');
  await useKey(page);
  await page.locator('.keyfield input').focus();
  await page.keyboard.type('abc123');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveText(/not a private key/);
  await expect(page.locator('#key-count')).toHaveText('Paste or type');
});

test('sweeps sponsored chains to one destination, burning a chain with no route', async ({ page }) => {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const { swept } = await mockNetwork(page, address);
  const watch = await watchForKey(page, key);

  await page.goto('/sweep');
  await useKey(page);
  await page.locator('.keyfield input').focus();
  await page.keyboard.type(key, { delay: 1 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.row')).toHaveCount(3);

  // No default destination: the button asks for one
  await page.getByRole('button', { name: 'Choose where it goes' }).click();
  await page.getByRole('dialog', { name: 'Receive on' }).getByRole('button', { name: /Arbitrum/ }).click();

  // Scroll has no route out: choose burn
  await page.getByRole('button', { name: /No route: choose/ }).click();
  await page.getByRole('button', { name: /^Burn all/ }).click();
  await expect(page.getByText('Burn all, not received')).toBeVisible();

  await page.getByRole('button', { name: 'Check sweep' }).click();
  await expect(page.getByRole('button', { name: 'Sweep 3 chains' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.summary')).toContainText('You receive');
  // The bridge doing the bridging is named, per chain and in the summary
  await expect(page.locator('.summary')).toContainText('Bridged byRelay');
  await expect(page.locator('.row', { hasText: 'Optimism' })).toContainText('Bridged by Relay');
  await expect(page.locator('.footnote')).toContainText('The bridges named above carry the funds across chains');
  expect(swept.size).toBe(0);

  await page.getByRole('button', { name: 'Sweep 3 chains' }).click();
  const confirm = page.getByRole('dialog', { name: /Sweep 3 chains to Arbitrum/ });
  await expect(confirm).toContainText('Scroll:');
  await expect(confirm).toContainText('is burned. You will not receive it.');
  await confirm.getByRole('button', { name: 'Sweep 3 chains' }).click();

  await expect(page.getByText('3 of 3 at zero')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.done-zero')).toHaveCount(3);
  expect([...swept].sort()).toEqual([10, 534352, 8453].sort());
  await watch.checkPage();
  expect(watch.leaks).toEqual([]);
  expect(watch.cspViolations).toEqual([]);
});

test('sweeps a direct chain: plan checked and replayed in the page, signed here, sent to the chain', async ({ page }) => {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const { swept, sent, reports } = await mockNetwork(page, address, { direct: true });
  const watch = await watchForKey(page, key);

  await page.goto('/sweep');
  await useKey(page);
  await page.locator('.keyfield input').focus();
  await page.keyboard.type(key, { delay: 1 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.row')).toHaveCount(4);
  const avax = page.locator('.row', { hasText: 'Avalanche' });
  // Same row as every other chain: no method tag or per-row note
  await expect(avax.locator('.tag')).toHaveCount(0);
  // Selected by default, like the sponsored chains; keep only Avalanche for this test
  for (const name of ['Base', 'Optimism', 'Scroll']) await page.getByRole('checkbox', { name: `Sweep ${name}` }).uncheck();

  await page.getByRole('button', { name: 'Choose where it goes' }).click();
  await page.getByRole('dialog', { name: 'Receive on' }).getByRole('button', { name: /^Base/ }).click();
  await page.getByRole('button', { name: 'Check sweep' }).click();
  await expect(page.getByRole('button', { name: 'Sweep 1 chain' })).toBeVisible({ timeout: 30_000 });
  await expect(avax).not.toContainText('ZeroDust fee');
  await expect(avax).toContainText('Bridged by Gas.zip');
  await expect(page.locator('.summary')).toContainText('ZeroDust fee');
  expect(sent).toEqual([]);

  await page.getByRole('button', { name: 'Sweep 1 chain' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sweep 1 chain' }).click();
  await expect(page.getByText('1 of 1 at zero')).toBeVisible({ timeout: 60_000 });
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

test('a chain that cannot reach the destination can go to another chain instead', async ({ page }) => {
  const key = generatePrivateKey();
  const { swept, sent } = await mockNetwork(page, privateKeyToAccount(key).address, { direct: true, onlyTo: 10 });
  await page.goto('/sweep');
  await useKey(page);
  await page.locator('.keyfield input').focus();
  await page.keyboard.type(key, { delay: 1 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.row')).toHaveCount(4);
  await page.getByRole('checkbox', { name: 'Sweep Scroll' }).uncheck();
  await page.getByRole('button', { name: 'Choose where it goes' }).click();
  await page.getByRole('dialog', { name: 'Receive on' }).getByRole('button', { name: /^Base/ }).click();

  const avax = page.locator('.row', { hasText: 'Avalanche' });
  // After the route is asked again (twice, 3 s apart) and Optimism is confirmed
  await expect(avax).toContainText('No bridge takes AVAX to Base right now', { timeout: 20_000 });
  await avax.getByRole('button', { name: /No route: choose/ }).click();
  await page.getByRole('button', { name: /^Send to Optimism instead/ }).click();
  await expect(avax).toContainText('Goes to Optimism instead');

  await page.getByRole('button', { name: 'Check sweep' }).click();
  await expect(page.getByRole('button', { name: 'Sweep 2 chains' })).toBeVisible({ timeout: 30_000 });
  // One total per chain the funds arrive on
  await expect(page.locator('.summary')).toContainText(/ETH on Base, 0\.0007 ETH on Optimism/);

  await page.getByRole('button', { name: 'Sweep 2 chains' }).click();
  const confirm = page.getByRole('dialog', { name: 'Sweep 2 chains to Base and Optimism?' });
  await expect(confirm.locator('li', { hasText: 'Avalanche' })).toContainText('to Optimism');
  await confirm.getByRole('button', { name: 'Sweep 2 chains' }).click();
  await expect(page.getByText('2 of 2 at zero')).toBeVisible({ timeout: 60_000 });
  await expect(avax).toContainText('0.0007 ETH to Optimism');
  expect(sent).toHaveLength(2);
  expect(swept.has(43114)).toBe(true);
});

test('any chain can go to another address on that chain, set only from its menu', async ({ page }) => {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const { swept, quoted } = await mockNetwork(page, address);
  const exchange = '0x820653ccE8a755edbb52eC1bc5829D2a60CD5cc5';
  await page.goto('/sweep');
  await useKey(page);
  await page.locator('.keyfield input').focus();
  await page.keyboard.type(key, { delay: 1 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.row')).toHaveCount(3);
  await page.getByRole('checkbox', { name: 'Sweep Scroll' }).uncheck();
  // No menu before a destination is chosen; after it, the bridge route stays the default
  await expect(page.getByRole('button', { name: /Send elsewhere/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Choose where it goes' }).click();
  await page.getByRole('dialog', { name: 'Receive on' }).getByRole('button', { name: /Arbitrum/ }).click();

  const op = page.locator('.row', { hasText: 'Optimism' });
  await op.getByRole('button', { name: /Send elsewhere/ }).click();
  await op.getByRole('button', { name: /Send to an address on Optimism/ }).click();
  const field = page.locator('#addr-10');
  const use = op.getByRole('button', { name: 'Use this address' });
  await field.fill('0x1234');
  await expect(op.getByRole('alert')).toContainText('Not a valid address');
  await expect(use).toBeDisabled();
  // The loaded wallet itself would move nothing
  await field.fill(address);
  await expect(op.getByRole('alert')).toContainText('That is the loaded wallet');
  await expect(use).toBeDisabled();
  await field.fill(exchange.toLowerCase());
  await expect(op.locator('.address-warnings')).toContainText('internal transfer');
  await use.click();
  await expect(op).toContainText('To 0x8206');
  await expect(op).toContainText('on Optimism');

  await page.getByRole('button', { name: 'Check sweep' }).click();
  await expect(page.getByRole('button', { name: 'Sweep 2 chains' })).toBeVisible({ timeout: 20_000 });
  // Quoted as a same-chain sweep to that address; Base still goes to Arbitrum, to the wallet
  expect(quoted.filter((q) => q.from === 10).every((q) => q.to === 10 && q.destination === exchange)).toBe(true);
  expect(quoted.filter((q) => q.from === 8453).every((q) => q.to === 42161 && q.destination.toLowerCase() === address.toLowerCase())).toBe(true);
  // It is not counted as received
  await expect(page.locator('.summary')).not.toContainText('on Optimism, ');
  await expect(page.locator('.summary')).toContainText(/To other addresses.*on Optimism/);

  await page.getByRole('button', { name: 'Sweep 2 chains' }).click();
  // The title names every place the funds go
  const confirm = page.getByRole('dialog', { name: 'Sweep 2 chains to Arbitrum and an address on Optimism?' });
  await expect(confirm.locator('li', { hasText: 'Optimism' })).toContainText('to an address on Optimism');
  await expect(confirm).toContainText('goes to this address on Optimism, not to Arbitrum');
  await expect(confirm.locator('.addr-check')).toBeVisible();
  await confirm.getByRole('button', { name: 'Sweep 2 chains' }).click();
  await expect(page.getByText('2 of 2 at zero')).toBeVisible({ timeout: 30_000 });
  expect([...swept].sort()).toEqual([10, 8453].sort());
});

test('names how long the bridge usually takes, and warns when it has been slow lately', async ({ page }) => {
  const key = generatePrivateKey();
  await mockNetwork(page, privateKeyToAccount(key).address, {
    timings: {
      routes: { relay: { typicalSeconds: 18, p90Seconds: 40, samples: 12, slowLately: true } },
      pairs: { 'relay:10': { typicalSeconds: 9, samples: 4 } },
    },
  });
  await page.goto('/sweep');
  await useKey(page);
  await page.locator('.keyfield input').focus();
  await page.keyboard.type(key, { delay: 1 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.row')).toHaveCount(3);
  await page.getByRole('checkbox', { name: 'Sweep Scroll' }).uncheck();
  await page.getByRole('button', { name: 'Choose where it goes' }).click();
  await page.getByRole('dialog', { name: 'Receive on' }).getByRole('button', { name: /Arbitrum/ }).click();
  await page.getByRole('button', { name: 'Check sweep' }).click();
  await expect(page.getByRole('button', { name: 'Sweep 2 chains' })).toBeVisible({ timeout: 20_000 });
  // Optimism has its own measured time; Base falls back to Relay's
  await expect(page.locator('.row', { hasText: 'Optimism' })).toContainText('Bridged by Relay, usually 9s. Slower than usual lately');
  await expect(page.locator('.row', { hasText: 'Base' })).toContainText('Bridged by Relay, usually 18s');
});

test('a passing "unknown" route does not send a chain elsewhere', async ({ page }) => {
  const key = generatePrivateKey();
  await mockNetwork(page, privateKeyToAccount(key).address, { direct: true, hiccups: 1 });
  await page.goto('/sweep');
  await useKey(page);
  await page.locator('.keyfield input').focus();
  await page.keyboard.type(key, { delay: 1 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.row')).toHaveCount(4);
  await page.getByRole('checkbox', { name: 'Sweep Scroll' }).uncheck();
  await page.getByRole('button', { name: 'Choose where it goes' }).click();
  await page.getByRole('dialog', { name: 'Receive on' }).getByRole('button', { name: /^Base/ }).click();
  await page.getByRole('button', { name: 'Check sweep' }).click();
  await expect(page.getByRole('button', { name: 'Sweep 2 chains' })).toBeVisible({ timeout: 30_000 });
  const avax = page.locator('.row', { hasText: 'Avalanche' });
  await expect(avax).not.toContainText('No bridge');
  await expect(page.locator('.summary')).not.toContainText('Optimism');
});

test('token delivery: Mitosis is swept to exactly 0 and arrives as MITO (a token) on BNB Chain, said plainly', async ({ page }) => {
  const key = generatePrivateKey();
  const { swept } = await mockNetwork(page, privateKeyToAccount(key).address, { mitosis: true });
  await page.goto('/sweep');
  await useKey(page);
  await page.locator('.keyfield input').focus();
  await page.keyboard.type(key, { delay: 1 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.row')).toHaveCount(4);
  for (const name of ['Base', 'Optimism', 'Scroll']) await page.getByRole('checkbox', { name: `Sweep ${name}` }).uncheck();
  await page.getByRole('button', { name: 'Choose where it goes' }).click();
  await page.getByRole('dialog', { name: 'Receive on' }).getByRole('button', { name: /^BNB Chain/ }).click();

  const mitosis = page.locator('.row', { hasText: 'Mitosis' });
  await expect(mitosis).toContainText('Arrives as MITO (a token) on BNB Chain, not as gas');
  await page.getByRole('button', { name: 'Check sweep' }).click();
  await expect(page.getByRole('button', { name: 'Sweep 1 chain' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.summary')).toContainText(/MITO \(token\) on BNB Chain/);
  await expect(page.locator('.summary')).not.toContainText('BNB on BNB Chain');
  await expect(mitosis).toContainText('Bridged by Hyperlane');

  await page.getByRole('button', { name: 'Sweep 1 chain' }).click();
  const confirm = page.getByRole('dialog', { name: /Sweep 1 chain/ });
  await expect(confirm).toContainText('Mitosis: arrives as MITO, a token on BNB Chain, not BNB gas.');
  await confirm.getByRole('button', { name: 'Sweep 1 chain' }).click();
  await expect(page.getByText('1 of 1 at zero')).toBeVisible({ timeout: 60_000 });
  await expect(mitosis).toContainText('MITO (token) to BNB Chain');
  expect(swept.has(124816)).toBe(true);
});

test('a balance below every bridge minimum says how much to add, at load, at the check and at the sweep', async ({ page }) => {
  const key = generatePrivateKey();
  // Direct chain: known when the wallet loads
  await mockNetwork(page, privateKeyToAccount(key).address, { monad: true, tooSmall: 'direct' });
  await page.goto('/sweep');
  await useKey(page);
  await page.locator('.keyfield input').focus();
  await page.keyboard.type(key, { delay: 1 });
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Choose where it goes' }).click();
  await page.getByRole('dialog', { name: 'Receive on' }).getByRole('button', { name: /^Base/ }).click();
  const monad = page.locator('.row', { hasText: 'Monad' });
  await expect(monad).toContainText(/Too small to bridge: needs at least 64\.2 MON, add [\d.]+ more/, { timeout: 30_000 });
  await monad.getByRole('button', { name: 'Too small: choose' }).click();
  await expect(monad).toContainText('Add MON on Monad to bridge it, or instead:');
});

for (const when of ['check', 'sweep'] as const) {
  test(`a sponsored chain too small at the ${when} names the minimum, not a failure`, async ({ page }) => {
    const key = generatePrivateKey();
    const { reports } = await mockNetwork(page, privateKeyToAccount(key).address, { mitosis: true, tooSmall: when });
    await page.goto('/sweep');
    await useKey(page);
    await page.locator('.keyfield input').focus();
    await page.keyboard.type(key, { delay: 1 });
    await page.keyboard.press('Enter');
    await expect(page.locator('.row')).toHaveCount(4);
    for (const name of ['Base', 'Optimism', 'Scroll']) await page.getByRole('checkbox', { name: `Sweep ${name}` }).uncheck();
    await page.getByRole('button', { name: 'Choose where it goes' }).click();
    await page.getByRole('dialog', { name: 'Receive on' }).getByRole('button', { name: /^BNB Chain/ }).click();
    await page.getByRole('button', { name: 'Check sweep' }).click();
    const mitosis = page.locator('.row', { hasText: 'Mitosis' });
    const text = 'Too small to bridge: needs at least 17.94 MITO, add 17.41 more';
    if (when === 'check') {
      await expect(mitosis).toContainText(text, { timeout: 30_000 });
      return;
    }
    await page.getByRole('button', { name: 'Sweep 1 chain' }).click();
    await page.getByRole('dialog', { name: /Sweep 1 chain/ }).getByRole('button', { name: 'Sweep 1 chain' }).click();
    await expect(mitosis).toContainText(text, { timeout: 60_000 });
    await expect(mitosis.locator('.warn-text', { hasText: 'Too small' })).toBeVisible();
    await expect(mitosis).not.toContainText('Check needed');
    // Reported with a reference to quote, and the copy holds it, never the key
    await expect(mitosis).toContainText('Ref ZD-1A2B3C01');
    await expect(page.getByText('Copy the details and send them to')).toBeVisible();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: 'sponsored', outcome: 'failed', failureKind: 'too-small', chainId: 124816, toChainId: 56 });
    expect(JSON.stringify(reports)).not.toContain(key.slice(2));
  });
}

test('token delivery, own wallet only: Endurance goes as ACE to this wallet on BNB Chain, and is blocked for another recipient', async ({ page }) => {
  const key = generatePrivateKey();
  const { swept } = await mockNetwork(page, privateKeyToAccount(key).address, { endurance: true });
  await page.goto('/sweep');
  await useKey(page);
  await page.locator('.keyfield input').focus();
  await page.keyboard.type(key, { delay: 1 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.row')).toHaveCount(4);
  for (const name of ['Base', 'Optimism', 'Scroll']) await page.getByRole('checkbox', { name: `Sweep ${name}` }).uncheck();
  await page.getByRole('button', { name: 'Choose where it goes' }).click();
  await page.getByRole('dialog', { name: 'Receive on' }).getByRole('button', { name: /^BNB Chain/ }).click();
  const endurance = page.locator('.row', { hasText: 'Endurance' });
  await expect(endurance).toContainText('Arrives as ACE (a token) on BNB Chain, not as gas, to this wallet only');

  // Another recipient: the bridge cannot pay it, so the row is blocked
  await page.getByRole('button', { name: /Receive at: your wallet/ }).click();
  await page.locator('#recipient').fill('0x2222222222222222222222222222222222222222');
  await expect(endurance).toContainText('Endurance can only be swept to your own wallet');
  await page.getByRole('button', { name: 'Use my wallet' }).click();

  await page.getByRole('button', { name: 'Check sweep' }).click();
  await expect(page.getByRole('button', { name: 'Sweep 1 chain' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.summary')).toContainText(/ACE \(token\) on BNB Chain/);
  await page.getByRole('button', { name: 'Sweep 1 chain' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sweep 1 chain' }).click();
  await expect(page.getByText('1 of 1 at zero')).toBeVisible({ timeout: 60_000 });
  await expect(endurance).toContainText('ACE (token) to BNB Chain via Endurance Bridge');
  expect(swept.has(648)).toBe(true);
});

test('refuses a direct plan that pays someone else, and sends nothing', async ({ page }) => {
  const key = generatePrivateKey();
  const { sent } = await mockNetwork(page, privateKeyToAccount(key).address, { direct: true, tamper: true });
  await page.goto('/sweep');
  await useKey(page);
  await page.locator('.keyfield input').focus();
  await page.keyboard.type(key, { delay: 1 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.row')).toHaveCount(4);
  for (const name of ['Base', 'Optimism', 'Scroll']) await page.getByRole('checkbox', { name: `Sweep ${name}` }).uncheck();
  await page.getByRole('button', { name: 'Choose where it goes' }).click();
  await page.getByRole('dialog', { name: 'Receive on' }).getByRole('button', { name: /^Base/ }).click();
  await page.getByRole('button', { name: 'Check sweep' }).click();
  const refused = page.locator('.row', { hasText: 'Avalanche' }).locator('.warn-text');
  await expect(refused).toHaveText('Stopped before signing: the plan failed a safety check', { timeout: 30_000 });
  // The exact reason stays available on hover
  await expect(refused).toHaveAttribute('title', /Plan refused: the Gas.zip deposit does not name the address you set/);
  await expect(page.getByRole('button', { name: /^Sweep \d/ })).toHaveCount(0);
  expect(sent).toEqual([]);
});

// The API does not offer Across (owner, 2026-10-02); the page still verifies one if it ever arrives
test('sweeps Monad through Across: gas-limit rules, deposit decoded and its Settler checked in the page', async ({ page }) => {
  const key = generatePrivateKey();
  const { swept, sent } = await mockNetwork(page, privateKeyToAccount(key).address, { monad: true });
  const watch = await watchForKey(page, key);
  await page.goto('/sweep');
  await useKey(page);
  await page.locator('.keyfield input').focus();
  await page.keyboard.type(key, { delay: 1 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.row')).toHaveCount(4);
  const monad = page.locator('.row', { hasText: 'Monad' });
  await expect(monad.locator('.tag')).toHaveCount(0);
  for (const name of ['Base', 'Optimism', 'Scroll']) await page.getByRole('checkbox', { name: `Sweep ${name}` }).uncheck();
  await page.getByRole('button', { name: 'Choose where it goes' }).click();
  await page.getByRole('dialog', { name: 'Receive on' }).getByRole('button', { name: /^Base/ }).click();
  await page.getByRole('button', { name: 'Check sweep' }).click();
  await expect(page.getByRole('button', { name: 'Sweep 1 chain' })).toBeVisible({ timeout: 30_000 });
  expect(sent).toEqual([]);

  await page.getByRole('button', { name: 'Sweep 1 chain' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sweep 1 chain' }).click();
  await expect(page.getByText('1 of 1 at zero')).toBeVisible({ timeout: 60_000 });
  expect(sent).toHaveLength(2);
  expect(swept.has(143)).toBe(true);
  await watch.checkPage();
  expect(watch.leaks).toEqual([]);
  expect(watch.cspViolations).toEqual([]);
});

test('refuses an Across plan whose deposit pays someone else, and sends nothing', async ({ page }) => {
  const key = generatePrivateKey();
  const { sent } = await mockNetwork(page, privateKeyToAccount(key).address, { monad: true, tamper: true });
  await page.goto('/sweep');
  await useKey(page);
  await page.locator('.keyfield input').focus();
  await page.keyboard.type(key, { delay: 1 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.row')).toHaveCount(4);
  for (const name of ['Base', 'Optimism', 'Scroll']) await page.getByRole('checkbox', { name: `Sweep ${name}` }).uncheck();
  await page.getByRole('button', { name: 'Choose where it goes' }).click();
  await page.getByRole('dialog', { name: 'Receive on' }).getByRole('button', { name: /^Base/ }).click();
  await page.getByRole('button', { name: 'Check sweep' }).click();
  const refused = page.locator('.row', { hasText: 'Monad' }).locator('.warn-text');
  await expect(refused).toHaveText('Stopped before signing: the plan failed a safety check', { timeout: 30_000 });
  await expect(refused).toHaveAttribute('title', /Across deposit refused: the fallback recipient is not the address you set/);
  await expect(page.getByRole('button', { name: /^Sweep \d/ })).toHaveCount(0);
  expect(sent).toEqual([]);
});

test('lands on MetaMask: Connect MetaMask first, the key one click away, and a clear error without MetaMask', async ({ page }) => {
  await mockNetwork(page, privateKeyToAccount(generatePrivateKey()).address);
  await page.goto('/sweep');
  await expect(page.getByRole('heading', { name: 'Connect wallet' })).toBeVisible();
  await expect(page.locator('.keyfield input')).toHaveCount(0);
  await page.getByRole('button', { name: 'Connect MetaMask' }).click();
  await expect(page.getByRole('alert')).toHaveText(/MetaMask was not found in this browser/);
  await useKey(page);
  await expect(page.getByRole('heading', { name: 'Load wallet' })).toBeVisible();
  await page.getByRole('button', { name: 'Use MetaMask' }).click();
  await expect(page.getByRole('heading', { name: 'Connect wallet' })).toBeVisible();
});

test('token exit: Telos leaves through its own bridge as TLOS (a token) on Base, said plainly; the leftover cents are donated', async ({ page }) => {
  const key = generatePrivateKey();
  const { swept, sent, reports } = await mockNetwork(page, privateKeyToAccount(key).address, { telos: true });
  await page.goto('/sweep');
  await useKey(page);
  await page.locator('.keyfield input').focus();
  await page.keyboard.type(key, { delay: 1 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.row')).toHaveCount(4);
  for (const name of ['Base', 'Optimism', 'Scroll']) await page.getByRole('checkbox', { name: `Sweep ${name}` }).uncheck();
  await page.getByRole('button', { name: 'Choose where it goes' }).click();
  await page.getByRole('dialog', { name: 'Receive on' }).getByRole('button', { name: /^Base/ }).click();

  const telos = page.locator('.row', { hasText: 'Telos' });
  await expect(telos).toContainText("No gas bridge takes TLOS to Base; Telos's own bridge sends it as the TLOS token");
  await telos.getByRole('button', { name: /choose/i }).click();
  const option = page.getByRole('button', { name: /^Bridge out as TLOS \(token\)/ }).first();
  await expect(option).toContainText("Telos's own bridge sends it to Base as the TLOS token, not ETH gas. The few cents of gas it does not use count toward ZeroDust's fee.");
  // One option for a token exit: no burn variant, nothing framed as a donation
  await expect(page.getByRole('button', { name: /burn the cents left/ })).toHaveCount(0);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/telos-exit-menu.png` });
  await option.click();
  await expect(telos).toContainText('Bridged out as TLOS (token)');

  await page.getByRole('button', { name: 'Check sweep' }).click();
  await expect(page.getByRole('button', { name: 'Sweep 1 chain' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.summary')).toContainText(/TLOS \(token\) on Base/);
  await page.getByRole('button', { name: 'Sweep 1 chain' }).click();
  const confirm = page.getByRole('dialog', { name: /Sweep 1 chain/ });
  await expect(confirm).toContainText('Telos: arrives as TLOS, a token on Base, not ETH gas');
  await expect(confirm).toContainText("Telos: bridged out through Telos's own bridge; the few cents of gas it does not use count toward ZeroDust's fee.");
  await expect(confirm).not.toContainText('donated');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/telos-exit-confirm.png` });
  await confirm.getByRole('button', { name: 'Sweep 1 chain' }).click();
  await expect(page.getByText('1 of 1 at zero')).toBeVisible({ timeout: 60_000 });
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/telos-exit-done.png` });
  // Fee, bridge send, then the leftover donated
  expect(sent).toHaveLength(3);
  expect(swept.has(TELOS)).toBe(true);
  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0]).toMatchObject({ kind: 'direct', outcome: 'done', chainId: TELOS, route: 'oft', mode: 'exit' });
});
