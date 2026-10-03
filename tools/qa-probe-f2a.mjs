// 诊断：F2a 集结核构造后营旗位置变化
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
const EXE = path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:5300/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);
await page.click('[data-territory-entry]');
await page.waitForFunction(() => { const b = document.getElementById('btn-start'); return b && !b.disabled; }, null, { timeout: 150000 });
await page.click('#btn-start');
await page.waitForFunction(() => window.UI?.phase === 'battle', null, { timeout: 30000 });
await page.waitForTimeout(6000);
// 远景
const box = await page.locator('canvas').first().boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (let i = 0; i < 20; i++) { const z = await page.evaluate(() => window.UI.scene.cameras.main.zoom); if (z <= 0.5) break; await page.mouse.wheel(0, 240); await page.waitForTimeout(120); }
const px = () => page.evaluate(() => {
    const scene = window.UI.scene, cam = scene.cameras.main;
    const A = cam.getWorldPoint(0, 0);
    return {
        zoom: cam.zoom,
        rects: (scene.render?.overlay?.markerRects || []).map((r, i) => {
            const cxw = r.x + r.w / 2, cyw = r.y + r.h / 2;
            return { idx: i, id: r.battalion.id, team: r.battalion.team,
                x: (cxw - A.x) * cam.zoom, y: (cyw - A.y) * cam.zoom, w: r.w * cam.zoom, h: r.h * cam.zoom };
        }),
        orders: scene.battalions.battalions.filter(b => b.team === 'red').map(b => ({
            id: b.id, op: b.orderPoint, members: b.members.length }))
    };
});
let st = await px();
console.log('初始旗位置:', JSON.stringify(st.rects.map(r => `${r.id}(${Math.round(r.x)},${Math.round(r.y)})`)));
const anchor = st.rects.filter(r => r.team === 'red')[0];
console.log('anchor =', anchor.id, Math.round(anchor.x), Math.round(anchor.y));
// 两个营向 anchor 集结
const chips = page.locator('.battalion-chip');
console.log('chips =', await chips.count());
for (let i = 0; i < Math.min(await chips.count(), 2); i++) {
    await chips.nth(i).click();
    await page.waitForTimeout(200);
    await page.locator('#order-hold').click();
    await page.waitForTimeout(250);
    await page.mouse.click(anchor.x, anchor.y);
    await page.waitForTimeout(400);
    const o = await page.evaluate(() => {
        const b = window.UI.scene.selectedBattalion;
        return b ? { id: b.id, op: b.orderPoint } : null;
    });
    console.log(`第${i}次驻守下令后选中营状态:`, JSON.stringify(o));
}
await page.click('.speed-btn[data-speed="2"]');
for (let round = 0; round < 12; round++) {
    await page.waitForTimeout(2500);
    st = await px();
    const reds = st.rects.filter(r => r.team === 'red');
    const dists = [];
    for (let i = 0; i < reds.length; i++) for (let j = i + 1; j < reds.length; j++)
        dists.push(`${reds[i].id}-${reds[j].j ?? reds[j].id}:${Math.round(Math.hypot(reds[i].x - reds[j].x, reds[i].y - reds[j].y))}`);
    console.log(`round${round}: zoom=${st.zoom.toFixed(2)} 旗[${reds.map(r => `${r.id}(${Math.round(r.x)},${Math.round(r.y)},w${Math.round(r.w)})`).join(' ')}] 距离{${dists.join(' ')}}`,
        `营op[${st.orders.map(o => `${o.id}:${o.op ? '@' + Math.round(o.op.gx) + ',' + Math.round(o.op.gy) : '-'}`).join(' ')}]`);
}
await browser.close();
