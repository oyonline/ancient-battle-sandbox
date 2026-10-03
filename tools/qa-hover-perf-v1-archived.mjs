// ==================== QA 悬停/选择反馈性能 A/B（2026-10-03 Q1） ====================
// 同一 scripted 鼠标移动序列（60 次移动，覆盖远景营旗与近景部队）分别跑在：
//   B = 当前构建（悬停管线 + 营旗矩形 + 悬停环生效）
//   A = 基线 a0dfc8e 构建（无悬停管线）
// 读取游戏自带 FrameStats：P95/最大帧耗时、>50ms 长帧数、update/sim 均值；
// B 侧另计数 forEachNear 索引查询次数（观察钩子，验证“60 次移动 ≤2 次索引查询”
// 的浏览器侧实证）。
// 用法：QA_A=http://127.0.0.1:5301/ QA_B=http://127.0.0.1:5300/ node tools/qa-hover-perf.mjs
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';

const EXE = [1228, 1208].map(v => path.join(homedir(),
    `Library/Caches/ms-playwright/chromium-${v}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)).find(existsSync);
const URL_A = process.env.QA_A || 'http://127.0.0.1:5301/';
const URL_B = process.env.QA_B || 'http://127.0.0.1:5300/';

const browser = await chromium.launch({ executablePath: EXE, headless: true,
    args: ['--disable-dev-shm-usage', '--disable-gpu-sandbox'] });

async function runSide(url, label) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.click('[data-territory-entry]');
    await page.waitForFunction(() => {
        const b = document.getElementById('btn-start');
        return b && !b.disabled && !b.textContent.includes('准备战场');
    }, null, { timeout: 150000 });
    await page.click('#btn-start');
    await page.waitForFunction(() => window.UI?.phase === 'battle', null, { timeout: 30000 });
    await page.waitForTimeout(6000);

    if (label === 'B') {
        await page.evaluate(() => {
            const scene = window.UI.scene;
            window.__qaIdxQueries = 0;
            window.__qaHoverPicks = 0;
            const orig = scene.forEachNear.bind(scene);
            scene.forEachNear = (...a) => { window.__qaIdxQueries++; return orig(...a); };
            const insp = scene.unitInspector;
            const origHover = insp.updateHover.bind(insp);
            insp.updateHover = p => {
                window.__qaHoverPicks++;
                return origHover(p);
            };
        });
    }

    // 固定移动脚本：远景（营旗悬停）60 次移动 → 近景（部队悬停）60 次移动
    const box = await page.locator('canvas').first().boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 16; i++) { await page.mouse.wheel(0, 240); await page.waitForTimeout(90); }   // 拉到远景看旗
    await page.waitForTimeout(600);
    await page.evaluate(() => window.UI.scene.performanceStats?.reset());
    const t0 = Date.now();
    for (let i = 0; i < 60; i++) {
        const x = cx - 400 + (i % 12) * 70 + (i % 3) * 9;
        const y = cy - 220 + Math.floor(i / 12) * 90 + (i % 4) * 7;
        await page.mouse.move(x, y);
        await page.waitForTimeout(120);
    }
    for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(90); }   // 拉回近景
    await page.waitForTimeout(400);
    for (let i = 0; i < 60; i++) {
        const x = cx - 300 + (i % 10) * 65 + (i % 5) * 8;
        const y = cy - 180 + Math.floor(i / 10) * 80 + (i % 3) * 11;
        await page.mouse.move(x, y);
        await page.waitForTimeout(120);
    }
    const wall = Date.now() - t0;
    const snap = await page.evaluate(() => window.UI.scene.performanceStats?.snapshot());
    const idx = label === 'B' ? await page.evaluate(() => ({
        total: window.__qaIdxQueries ?? -1, hoverCalls: window.__qaHoverPicks ?? -1 })) : null;
    await page.close();
    return { label, wallMs: wall, snapshot: snap, idxQueriesDuringMoves: idx, errors };
}

const bSide = await runSide(URL_B, 'B');
console.log(JSON.stringify(bSide, null, 1));
const aSide = await runSide(URL_A, 'A');
console.log(JSON.stringify(aSide, null, 1));

const fmt = r => `${r.label}: P95=${r.snapshot?.p95Ms?.toFixed(1)}ms max=${r.snapshot?.maxMs?.toFixed(1)}ms 长帧>50ms=${r.snapshot?.longFrames} 帧数=${r.snapshot?.samples} update=${r.snapshot?.updateMs?.toFixed(2)}ms sim=${r.snapshot?.simulationMs?.toFixed(2)}ms`;
console.log('\n==== 悬停/选择反馈性能对照（同输入序列）====');
console.log(fmt(bSide));
console.log(fmt(aSide));
if (bSide.idxQueriesDuringMoves != null) {
    const q = bSide.idxQueriesDuringMoves;
    console.log(`B 侧 120 次移动期间：悬停管线拾取 ${q.hoverCalls} 次（节流后 ≤1 次/90ms 窗口），索引查询总计 ${q.total} 次（含每帧战斗索敌）——悬停占比 ${(q.hoverCalls / q.total * 100).toFixed(3)}%`);
}
console.log(`页面报错：B=${bSide.errors.length} A=${aSide.errors.length}`);
await browser.close();
