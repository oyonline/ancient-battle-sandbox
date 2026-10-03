// 诊断：S1/S4 点击为何 down=null 但选择保持——直接包 inspector.onDown/onUp
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
const EXE = path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const browser = await chromium.launch({ executablePath: EXE, headless: true,
    args: ['--disable-dev-shm-usage', '--disable-gpu-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:5300/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);
await page.click('[data-territory-entry]');
await page.waitForFunction(() => { const b = document.getElementById('btn-start'); return b && !b.disabled; }, null, { timeout: 45000 });
await page.click('#btn-start');
await page.waitForFunction(() => window.UI?.phase === 'battle', null, { timeout: 20000 });
await page.waitForTimeout(4000);
await page.evaluate(() => {
    const scene = window.UI.scene, insp = scene.unitInspector;
    window.__qa = { downs: 0, ups: 0, lastDownPick: 'NO_EVENT', lastConsumed: 'NO_CALL', log: [] };
    scene.input.on('pointerdown', p => {
        window.__qa.downs++;
        try { window.__qa.lastDownPick = JSON.stringify(scene.unitInspector.pickWithMarker(p)); } catch (e) { window.__qa.lastDownPick = 'ERR ' + e.message; }
    });
    const od = insp.onDown.bind(insp), ou = insp.onUp.bind(insp);
    insp.onDown = p => { window.__qa.log.push(['onDown', p.x, p.y]); return od(p); };
    insp.onUp = p => { window.__qa.log.push(['onUp', p.x, p.y]); return ou(p); };
    const og = scene.groundClick;
    scene.groundClick = (w, u) => { const r = og(w, u); window.__qa.lastConsumed = String(r); return r; };
});
// 近景点击一个慢速单位身体
const box = await page.locator('canvas').first().boundingBox();
for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -240), await page.waitForTimeout(120);
const target = await page.evaluate(() => {
    const scene = window.UI.scene, cam = scene.cameras.main;
    const A = cam.getWorldPoint(0, 0);
    const own = scene.units.filter(u => u.team === 'red' && !u.dead && !u.withdrawn && u.battalion)
        .map(u => ({ id: u.id, bid: u.battalion.id, s: Math.hypot(u.gx - u.pgx, u.gy - u.pgy), gx: u.gx, gy: u.gy }));
    own.sort((a, b) => a.s - b.s);
    const u = own[0];
    const foot = scene.groundPoint(u.gx, u.gy);
    return { id: u.id, bid: u.bid, s: u.s, sx: (foot.x - A.x) * cam.zoom, sy: (foot.y - 18 - A.y) * cam.zoom, zoom: cam.zoom };
});
console.log('target:', JSON.stringify(target));
await page.mouse.move(target.sx, target.sy);
await page.mouse.down();
await page.waitForTimeout(80);
await page.mouse.up();
await page.waitForTimeout(300);
const after = await page.evaluate(() => ({
    qa: window.__qa, sel: window.UI.scene.selectedBattalion?.id ?? null,
    inspSel: window.UI.scene.unitInspector.selected?.id ?? null,
    hover: window.UI.scene.unitInspector.hover
}));
console.log(JSON.stringify(after, null, 1));
await page.screenshot({ path: 'docs/qa-u1/debug-near-click.png' });
await browser.close();
