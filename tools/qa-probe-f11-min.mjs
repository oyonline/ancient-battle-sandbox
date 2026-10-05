// 最小复现：F2a 流程后 chip 点击选中错位
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
await page.waitForTimeout(5000);
const box = await page.locator('canvas').first().boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (let i = 0; i < 20; i++) { if (await page.evaluate(() => window.UI.scene.cameras.main.zoom) <= 0.5) break; await page.mouse.wheel(0, 240); await page.waitForTimeout(120); }
const px = () => page.evaluate(() => {
    const scene = window.UI.scene, cam = scene.cameras.main;
    const A = cam.getWorldPoint(0, 0);
    return (scene.render?.overlay?.markerRects || []).map(r => ({ id: r.battalion.id,
        x: (r.x + r.w / 2 - A.x) * cam.zoom, y: (r.y + r.h / 2 - A.y) * cam.zoom, w: r.w * cam.zoom, h: r.h * cam.zoom }));
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
await page.click('.speed-btn[data-speed="2"]');
// 等重叠
let ov = null;
for (let r = 0; r < 20 && !ov; r++) {
    await page.waitForTimeout(1500);
    const st = await px();
    for (let i = 0; i < st.length && !ov; i++) for (let j = i + 1; j < st.length && !ov; j++) {
        const a = st[i], b = st[j];
        const ox = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
        const oy = Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2);
        if (ox > 10 && oy > 10) ov = { px: (Math.max(a.x - a.w / 2, b.x + b.w / 2 - (b.x + b.w / 2 - Math.min(a.x + a.w / 2, b.x + b.w / 2))) + Math.min(a.x + a.w / 2, b.x + b.w / 2)) / 2 };
    }
}
// 简化：直接用两个 rect 中心的中点
const st1 = await px();
let center = null;
for (let i = 0; i < st1.length && !center; i++) for (let j = i + 1; j < st1.length && !center; j++) {
    const a = st1[i], b = st1[j];
    const ox = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
    const oy = Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2);
    if (ox > 10 && oy > 10) center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, a: a.id, b: b.id };
}
console.log('重叠对:', JSON.stringify(center));
const sel = () => page.evaluate(() => window.UI.scene.selectedBattalion?.id ?? null);
console.log('点重叠区前选中:', await sel());
await page.mouse.click(center.x, center.y);
await page.waitForTimeout(300);
console.log('点重叠区后选中:', await sel(), '（期望=显示上层营）');
// 现在点 chip[2]
await page.locator('.battalion-chip[data-bid="2"]').first().click();
await page.waitForTimeout(100);
console.log('chip[2] 点击后 +100ms 选中:', await sel());
await page.waitForTimeout(400);
console.log('chip[2] 点击后 +500ms 选中:', await sel());
await page.locator('.battalion-chip[data-bid="2"]').first().click();
await page.waitForTimeout(300);
console.log('chip[2] 再次点击后选中:', await sel());
// 打印营卡 onclick 状态与 targeting
const ui = await page.evaluate(() => ({
    hold: window.UI.holdTargeting ?? null, rally: window.UI.rallyTargeting ?? null,
    chips: [...document.querySelectorAll('.battalion-chip')].map(c => ({ bid: c.dataset.bid, slot: c.dataset.slot }))
}));
console.log('UI 状态:', JSON.stringify(ui));
await browser.close();
