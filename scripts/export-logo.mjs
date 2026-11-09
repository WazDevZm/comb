// Renders the logo SVGs to PNG: node scripts/export-logo.mjs
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
for (const [file, out, w, h, bg] of [['logo', 'comb-logo', 1024, 1024, 'transparent'], ['logo-dark', 'comb-logo-on-dark', 1024, 1024, '#2A1F14'], ['lockup', 'comb-lockup', 1500, 432, 'transparent']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(`<style>html,body{margin:0;background:${bg}}svg{width:100vw;height:100vh;display:block}</style>${readFileSync(`brand/${file}.svg`, 'utf8')}`);
  await page.screenshot({ path: `brand/${out}.png`, omitBackground: bg === 'transparent' });
  await page.close();
}
await browser.close();
