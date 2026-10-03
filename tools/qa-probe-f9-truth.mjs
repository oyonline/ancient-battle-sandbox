// F9-2 可行性探针：display list 推导营旗视觉层级（与 markerRects/paint 不同源），
// 并采样"数组序旧逻辑 vs 显示序真值"的分歧（检出能力标定）。
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
// 远景
const box = await page.locator('canvas').first().boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (let i = 0; i < 20; i++) { if (await page.evaluate(() => window.UI.scene.cameras.main.zoom) <= 0.5) break; await page.mouse.wheel(0, 240); await page.waitForTimeout(120); }

const probe = await page.evaluate(() => {
    const scene = window.UI.scene, cam = scene.cameras.main;
    const A = cam.getWorldPoint(0, 0);
    const children = scene.children.list;
    const idxOf = new Map();
    children.forEach((c, i) => idxOf.set(c, i));
    // 独立源1：display list 中的营旗 label（插入序即同 depth 下的绘制序）
    const labels = [];
    for (const c of children) {
        if (c.type !== 'Text' || typeof c.text !== 'string') continue;
        const m = c.text.match(/^⚑ (\d+)营/);
        if (!m) continue;
        labels.push({ bid: Number(m[1]), idx: idxOf.get(c), x: c.x, y: c.y, w: c.width, h: c.height, sx: c.scaleX, sy: c.scaleY });
    }
    // 实现侧：markerRects（数组序 + paint）
    const rects = scene.render?.overlay?.markerRects || [];
    const paints = rects.map(r => ({ bid: r.battalion.id, paint: r.paint }));
    // 相关性：label 插入序 vs paint 序
    const labelSort = [...labels].sort((a, b) => a.idx - b.idx).map(l => l.bid);
    const paintSort = [...paints].sort((a, b) => a.paint - b.paint).map(r => r.bid);
    return { labels, labelSort, arrayOrder: rects.map(r => r.battalion.id), paintSort,
        zoom: cam.zoom, childrenCount: children.length };
});
console.log(JSON.stringify(probe, null, 1));

// 构造收敛后采样分歧
const anchorScreen = await page.evaluate(() => {
    const scene = window.UI.scene, cam = scene.cameras.main;
    const A = cam.getWorldPoint(0, 0);
    const r = (scene.render?.overlay?.markerRects || []).find(x => x.battalion.team === 'red');
    return r ? { x: (r.x + r.w / 2 - A.x) * cam.zoom, y: (r.y + r.h / 2 - A.y) * cam.zoom } : null;
});
if (anchorScreen) {
    const chips = page.locator('.battalion-chip');
    for (let i = 0; i < Math.min(await chips.count(), 2); i++) {
        await chips.nth(i).click();
        await page.waitForTimeout(200);
        await page.locator('#order-hold').click();
        await page.waitForTimeout(250);
        await page.mouse.click(anchorScreen.x, anchorScreen.y);
        await page.waitForTimeout(350);
    }
    await page.click('.speed-btn[data-speed="2"]');
    let diverge = 0, samples = 0;
    for (let round = 0; round < 30; round++) {
        await page.waitForTimeout(1500);
        const r = await page.evaluate(() => {
            const scene = window.UI.scene, cam = scene.cameras.main;
            const A = cam.getWorldPoint(0, 0);
            const children = scene.children.list;
            const idxOf = new Map(); children.forEach((c, i) => idxOf.set(c, i));
            const labels = [];
            for (const c of children) {
                if (c.type !== 'Text' || typeof c.text !== 'string') continue;
                const m = c.text.match(/^⚑ (\d+)营/);
                if (m && c.visible) labels.push({ bid: Number(m[1]), idx: idxOf.get(c),
                    cx: (c.x - A.x) * cam.zoom, bot: (c.y - A.y) * cam.zoom, w: c.width, h: c.height });
            }
            const rects = scene.render?.overlay?.markerRects || [];
            // 找重叠区：两 label 屏幕矩形相交
            for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
                const a = labels[i], b = labels[j];
                const ox = Math.min(a.cx + a.w / 2, b.cx + b.w / 2) - Math.max(a.cx - a.w / 2, b.cx - b.w / 2);
                const oy = Math.min(a.bot, b.bot) - Math.max(a.bot - a.h, b.bot - b.h);
                if (ox > 10 && oy > 10) {
                    const px = (Math.max(a.cx - a.w / 2, b.cx - b.w / 2) + Math.min(a.cx + a.w / 2, b.cx + b.w / 2)) / 2;
                    const py = (Math.max(a.bot - a.h, b.bot - b.h) + Math.min(a.bot, b.bot)) / 2;
                    // 真值：display 序大者
                    const truth = a.idx > b.idx ? a.bid : b.bid;
                    // 旧逻辑：markerRects 数组序最后命中
                    const world = cam.getWorldPoint(px, py);
                    let oldPick = null;
                    for (const r2 of rects) {
                        if (world.x >= r2.x && world.x <= r2.x + r2.w && world.y >= r2.y && world.y <= r2.y + r2.h) oldPick = r2.battalion.id;
                    }
                    // 实现现逻辑：paint 最大
                    let implPick = null, bestPaint = -Infinity;
                    for (const r2 of rects) {
                        if (world.x >= r2.x && world.x <= r2.x + r2.w && world.y >= r2.y && world.y <= r2.y + r2.h && r2.paint > bestPaint) { bestPaint = r2.paint; implPick = r2.battalion.id; }
                    }
                    return { px, py, truth, oldPick, implPick, a: a.bid, b: b.bid };
                }
            }
            return null;
        });
        if (r) {
            samples++;
            const d = r.oldPick !== r.truth;
            if (d) diverge++;
            console.log(`重叠样本#${samples}: 旗${r.a}×${r.b} 真值(显示序)=${r.truth} 旧逻辑(数组序)=${r.oldPick} 实现(paint)=${r.implPick} ${d ? '← 分歧：旧逻辑会选错' : ''}`);
            if (samples >= 5) break;
        }
    }
    console.log(`标定结果：${samples} 个重叠样本，旧逻辑与显示序真值分歧 ${diverge} 次（分歧即新判据可检出的选错场景）`);
}
await browser.close();
