// Draws the link preview image: node scripts/og/make-og.mjs -> public/og.png (1200x630).
// Run by hand after changing card.html; the PNG is committed, so builds stay reproducible.
import { chromium } from '@playwright/test';

const here = new URL('./', import.meta.url);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(new URL('card.html', here).href);
await page.evaluate('document.fonts.ready');
await page.screenshot({ path: new URL('../../public/og.png', here).pathname });
await browser.close();
console.log('public/og.png written');
