// 诊断：chip data-bid 与点击选中错位
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
const EXE = path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:5300/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);
await page.click('[data-territory-entry]');
await page.waitForFunction(() => { const b = document.getElementById('btn-start'); return b && !b.disabled; }, null, { timeout: 150000 });
await page.click('#btn-start');
await page.waitForFunction(() => window.UI?.phase === 'battle', null, { timeout: 30000 });
await page.waitForTimeout(8000);
for (let step = 0; step < 3; step++) {
    const chips = await page.evaluate(() => ({
        dom: [...document.querySelectorAll('.battalion-chip')].map(c => ({ bid: c.dataset.bid, text: c.textContent.trim().slice(0, 22) })),
        real: window.UI.myBattalions().map(b => b.id),
        sel: window.UI.scene.selectedBattalion?.id ?? null
    }));
    console.log(`step${step}:`, JSON.stringify(chips));
    if (chips.dom.length >= 2) {
        const target = chips.dom[1].bid;   // 点第 2 张卡
        await page.locator(`.battalion-chip[data-bid="${target}"]`).first().click();
        await page.waitForTimeout(300);
        const after = await page.evaluate(() => ({
            sel: window.UI.scene.selectedBattalion?.id ?? null,
            dom: [...document.querySelectorAll('.battalion-chip')].map(c => ({ bid: c.dataset.bid }))
        }));
        console.log(`  点 card bid=${target} → 选中=${after.sel}；chips=${JSON.stringify(after.dom)}`);
    }
    await page.waitForTimeout(1500);
}
await browser.close();
