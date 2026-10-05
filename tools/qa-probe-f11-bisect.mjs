// 二分：playwright 坐标点击 vs evaluate el.click() 派发，定位 onclick 错位来源
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
// 复刻聚焦脚本 F2a 构造：两营驻守同点
const box = await page.locator('canvas').first().boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (let i = 0; i < 20; i++) { if (await page.evaluate(() => window.UI.scene.cameras.main.zoom) <= 0.5) break; await page.mouse.wheel(0, 240); await page.waitForTimeout(120); }
const px = () => page.evaluate(() => {
    const scene = window.UI.scene, cam = scene.cameras.main;
    const A = cam.getWorldPoint(0, 0);
    return (scene.render?.overlay?.markerRects || []).map(r => ({ id: r.battalion.id,
        x: (r.x + r.w / 2 - A.x) * cam.zoom, y: (r.y + r.h / 2 - A.y) * cam.zoom }));
});
const st0 = await px();
const anchor = st0[0];
const chips = page.locator('.battalion-chip');
for (let i = 0; i < Math.min(await chips.count(), 2); i++) {
    await chips.nth(i).click();
    await page.waitForTimeout(200);
    await page.locator('#order-hold').click();
    await page.waitForTimeout(250);
    await page.mouse.click(anchor.x, anchor.y);
    await page.waitForTimeout(350);
}
// 包装 selectBattalionById
await page.evaluate(() => {
    const UI = window.UI;
    window.__selLog = [];
    const osbi = UI.selectBattalionById.bind(UI);
    UI.selectBattalionById = id => { window.__selLog.push(id); return osbi(id); };
});
// 实验 A：playwright 坐标点击 chip[data-bid=2]
await page.evaluate(() => { window.__selLog.length = 0; });
await page.locator('.battalion-chip[data-bid="2"]').first().click();
await page.waitForTimeout(300);
console.log('A. playwright 坐标点击 chip[2] → 调用:', JSON.stringify(await page.evaluate(() => window.__selLog)),
    '选中:', await page.evaluate(() => window.UI.scene.selectedBattalion?.id ?? null));
// 实验 B：evaluate 派发同一元素 click()
await page.evaluate(() => { window.__selLog.length = 0; });
await page.evaluate(() => { document.querySelector('.battalion-chip[data-bid="2"]').click(); });
await page.waitForTimeout(300);
console.log('B. evaluate el.click() chip[2] → 调用:', JSON.stringify(await page.evaluate(() => window.__selLog)),
    '选中:', await page.evaluate(() => window.UI.scene.selectedBattalion?.id ?? null));
// 实验 C：DOM 实况（bid 顺序 + 各 chip 屏幕矩形）
const dom = await page.evaluate(() => {
    const out = [];
    for (const c of document.querySelectorAll('.battalion-chip')) {
        const r = c.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        out.push({ bid: c.dataset.bid, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
            centerHitIsSelf: hit === c, centerHitTag: hit?.tagName, centerHitBid: hit?.dataset?.bid ?? null });
    }
    return out;
});
console.log('C. DOM 实况:', JSON.stringify(dom, null, 1));
await browser.close();
