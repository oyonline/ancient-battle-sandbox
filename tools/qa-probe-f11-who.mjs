// 终极定位：包装营选择入口，记录谁在 chip 点击后把选择改成 1
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
const EXE = path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', m => { const t = m.text(); if (t.startsWith('[sel]')) console.log(t); });
await page.goto('http://127.0.0.1:5300/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);
await page.click('[data-territory-entry]');
await page.waitForFunction(() => { const b = document.getElementById('btn-start'); return b && !b.disabled; }, null, { timeout: 150000 });
await page.click('#btn-start');
await page.waitForFunction(() => window.UI?.phase === 'battle', null, { timeout: 30000 });
await page.waitForTimeout(5000);
// 包装：selectBattalionById / applyBattalionSelection / selectBattalionByUnit 入口
await page.evaluate(() => {
    const UI = window.UI;
    window.__selLog = [];
    const t0 = performance.now();
    const log = (via, id) => window.__selLog.push({ at: Math.round(performance.now() - t0), via, id,
        stack: (new Error().stack || '').split('\\n').slice(2, 4).join(' | ') });
    const osbi = UI.selectBattalionById.bind(UI);
    UI.selectBattalionById = id => { log('selectBattalionById', id); return osbi(id); };
    const oabs = UI.applyBattalionSelection.bind(UI);
    UI.applyBattalionSelection = b => { log('applyBattalionSelection', b?.id ?? null); return oabs(b); };
    const scene = window.UI.scene;
    const osbu = scene.selectBattalionByUnit.bind(scene);
    scene.selectBattalionByUnit = u => { log('selectBattalionByUnit', u?.battalion?.id ?? null); return osbu(u); };
});
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
let center = null;
for (let r = 0; r < 20 && !center; r++) {
    await page.waitForTimeout(1500);
    const st = await px();
    for (let i = 0; i < st.length && !center; i++) for (let j = i + 1; j < st.length && !center; j++) {
        const a = st[i], b = st[j];
        const ox = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
        const oy = Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2);
        if (ox > 10 && oy > 10) center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
}
await page.evaluate(() => { window.__selLog.length = 0; });   // 清构造期日志
await page.mouse.click(center.x, center.y);
await page.waitForTimeout(300);
console.log('重叠区点击后选中:', await page.evaluate(() => window.UI.scene.selectedBattalion?.id ?? null));
await page.click('.speed-btn[data-speed="1"]');
await page.waitForTimeout(1500);
const mark = await page.evaluate(() => window.__selLog.length);
await page.locator('.battalion-chip[data-bid="2"]').first().click();
await page.waitForTimeout(600);
const logs = await page.evaluate(m => window.__selLog.slice(m), mark);
console.log('chip[2] 点击窗口的选择调用:');
for (const l of logs) console.log(`  ${l.at}ms ${l.via}(${l.id}) ← ${l.stack}`);
console.log('最终选中:', await page.evaluate(() => window.UI.scene.selectedBattalion?.id ?? null));
await browser.close();
