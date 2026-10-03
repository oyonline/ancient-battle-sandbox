// ==================== F11 标定探针：F2a-2 选向与检出能力实证 ====================
// 复现 R3 内联探针的双向实验，并加真实点击：
//   选中 upper（后创建=显示上层）时：旧逻辑（markerRects 数组序最后命中）因选中重排
//   [selected, ...其余] 而落到 lower —— lastHit=lower ≠ paintMax/display=upper →
//   F7 修复前 F2a-2 用例会红（选中被顶替成下层营）；
//   选中 lower 时：lastHit=upper=paintMax=display 同解 → 用例修复前也过（检不出缺陷，
//   即 R3 指出的 F9 选向错误）。
// 前置：node server/arena.mjs 已在 :5300 服务。
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
// 远景 + 构造两营收敛到同一点（F2a 已验证配方）
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
const anchor = st0.filter(r => r.id === Math.min(...st0.map(x => x.id)))[0] ?? st0[0];
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

// 读重叠对的三个口径：display 真值 / paintMax / 数组序 lastHit（按世界点）
const readOverlap = () => page.evaluate(() => {
    const scene = window.UI.scene, cam = scene.cameras.main;
    const A = cam.getWorldPoint(0, 0);
    const children = scene.children.list;
    const idxOf = new Map(); children.forEach((c, i) => idxOf.set(c, i));
    const labels = [];
    for (const c of children) {
        if (c.type !== 'Text' || typeof c.text !== 'string' || !c.visible) continue;
        const m = c.text.match(/^⚑ (\d+)营/);
        if (m) labels.push({ bid: Number(m[1]), idx: idxOf.get(c),
            cx: (c.x - A.x) * cam.zoom, bot: (c.y - A.y) * cam.zoom,
            w: (c.width ?? 96) + 12, h: (c.height ?? 40) + 10 });
    }
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i], b = labels[j];
        const ox = Math.min(a.cx + a.w / 2, b.cx + b.w / 2) - Math.max(a.cx - a.w / 2, b.cx - b.w / 2);
        const oy = Math.min(a.bot, b.bot) - Math.max(a.bot - a.h, b.bot - b.h);
        if (ox > 10 && oy > 10) {
            const px = (Math.max(a.cx - a.w / 2, b.cx - b.w / 2) + Math.min(a.cx + a.w / 2, b.cx + b.w / 2)) / 2;
            const py = (Math.max(a.bot - a.h, b.bot - b.h) + Math.min(a.bot, b.bot)) / 2;
            const world = cam.getWorldPoint(px, py);
            const rects = scene.render?.overlay?.markerRects || [];
            let lastHit = null, paintMax = null, bestPaint = -Infinity;
            for (const r of rects) {
                if (world.x >= r.x && world.x <= r.x + r.w && world.y >= r.y && world.y <= r.y + r.h) {
                    lastHit = r.battalion.id;                              // 旧逻辑：数组序最后命中
                    if (r.paint > bestPaint) { bestPaint = r.paint; paintMax = r.battalion.id; }   // 现实现
                }
            }
            const upper = a.idx > b.idx ? a.bid : b.bid, lower = a.idx > b.idx ? b.bid : a.bid;
            return { px: Math.round(px), py: Math.round(py), upper, lower, display: upper, paintMax, lastHit };
        }
    }
    return null;
});

async function selectBattalion(id) {
    const chip = page.locator(`.battalion-chip[data-bid="${id}"]`);
    if (!(await chip.count())) return false;
    await chip.first().click();
    await page.waitForTimeout(250);
    return await page.evaluate(() => window.UI.scene.selectedBattalion?.id ?? null) === id;
}

let upperCase = null, lowerCase = null;
for (let round = 0; round < 30 && !(upperCase && lowerCase); round++) {
    await page.waitForTimeout(1500);
    const ov = await readOverlap();
    if (!ov || !(ov.px > 30 && ov.px < 1410 && ov.py > 30 && ov.py < 770)) continue;
    // 方向一：选中 upper → 采样旧逻辑 vs 真值 → 真实点击看实际选中
    if (!upperCase && await selectBattalion(ov.upper)) {
        const after = await readOverlap();
        if (after && (await selectBattalion(after.upper))) {
            await page.mouse.click(after.px, after.py);
            await page.waitForTimeout(250);
            const actual = await page.evaluate(() => window.UI.scene.selectedBattalion?.id ?? null);
            upperCase = { ...after, actual };
        }
    }
    // 方向二：选中 lower → 同采样（对照组：预期同解）
    if (!lowerCase && await selectBattalion(ov.lower)) {
        const after = await readOverlap();
        if (after && (await selectBattalion(after.lower))) {
            await page.mouse.click(after.px, after.py);
            await page.waitForTimeout(250);
            const actual = await page.evaluate(() => window.UI.scene.selectedBattalion?.id ?? null);
            lowerCase = { ...after, actual };
        }
    }
}
await page.click('.speed-btn[data-speed="1"]').catch(() => {});
console.log('==== F11 选向标定（真实点击 + 三口径读数）====');
if (upperCase) {
    const diverged = upperCase.lastHit !== upperCase.display;
    console.log(`方向一（选 upper=${upperCase.upper}）：显示真值=${upperCase.display} paintMax=${upperCase.paintMax} 旧逻辑lastHit=${upperCase.lastHit} 实际选中=${upperCase.actual}` +
        (diverged ? ` ← 分歧实证：F7 前 F2a-2 会红（选中被顶替成 ${upperCase.lastHit}）` : '（本轮 lastHit 与真值同解，未取得分歧样本）'));
}
if (lowerCase) {
    console.log(`方向二（选 lower=${lowerCase.lower}）：显示真值=${lowerCase.display} paintMax=${lowerCase.paintMax} 旧逻辑lastHit=${lowerCase.lastHit} 实际选中=${lowerCase.actual}` +
        (lowerCase.lastHit === lowerCase.display ? '（同解：选 lower 检不出缺陷——F9 选向错误的复现）' : ''));
}
await page.screenshot({ path: 'docs/qa-u1/f11-direction-calibration.png' });
await browser.close();
