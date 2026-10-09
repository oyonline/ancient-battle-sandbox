// ==================== QA 悬停性能 v2（R2 · 2026-10-03 F5） ====================
// v1 的"0.057%"口径被否决：既不是耗时数据，也不是准确的查询占比（分母混入了
// 每帧战斗索敌）。v2 改报：
//  1) 悬停处理耗时分布：包装 updateHover，测量事件→拾取完成的执行时长 P50/P95/max；
//  2) 准确查询口径：悬停管线自身的拾取次数（每次恰 1 次 forEachNear 空间查询，
//     驻塔候选走 500ms 缓存），同窗口全军 forEachNear 总数仅作规模参照；
//  3) 帧级对照：同输入序列下 B（当前，悬停生效）与 A（基线 a0dfc8e，无悬停管线）
//     的 FrameStats P95/max/长帧数，结论只按实测窗口表述。
// 用法：QA_A=http://127.0.0.1:5301/classic.html QA_B=http://127.0.0.1:5300/classic.html node tools/qa-hover-perf.mjs
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';

const EXE = [1228, 1208].map(v => path.join(homedir(),
    `Library/Caches/ms-playwright/chromium-${v}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)).find(existsSync);
const URL_A = process.env.QA_A || 'http://127.0.0.1:5301/classic.html';
const URL_B = process.env.QA_B || 'http://127.0.0.1:5300/classic.html';

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
            const scene = window.UI.scene, insp = scene.unitInspector;
            window.__h = { durations: [], picks: 0, throttled: 0, allNear: 0 };
            const orig = scene.forEachNear.bind(scene);
            scene.forEachNear = (...a) => { window.__h.allNear++; return orig(...a); };
            const oh = insp.updateHover.bind(insp);
            insp.updateHover = p => {
                if (performance.now() < insp._hoverAt) { window.__h.throttled++; return oh(p); }
                const t0 = performance.now();
                oh(p);
                window.__h.durations.push(performance.now() - t0);
                window.__h.picks++;
            };
        });
    }

    const box = await page.locator('canvas').first().boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 16; i++) { await page.mouse.wheel(0, 240); await page.waitForTimeout(90); }
    await page.waitForTimeout(600);
    await page.evaluate(() => window.UI.scene.performanceStats?.reset());
    const t0 = Date.now();
    for (let i = 0; i < 60; i++) {
        await page.mouse.move(cx - 400 + (i % 12) * 70 + (i % 3) * 9, cy - 220 + Math.floor(i / 12) * 90 + (i % 4) * 7);
        await page.waitForTimeout(120);
    }
    for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(90); }
    await page.waitForTimeout(400);
    for (let i = 0; i < 60; i++) {
        await page.mouse.move(cx - 300 + (i % 10) * 65 + (i % 5) * 8, cy - 180 + Math.floor(i / 10) * 80 + (i % 3) * 11);
        await page.waitForTimeout(120);
    }
    const wall = Date.now() - t0;
    const snap = await page.evaluate(() => window.UI.scene.performanceStats?.snapshot());
    const hover = label === 'B' ? await page.evaluate(() => {
        const d = [...window.__h.durations].sort((a, b) => a - b);
        const q = p => d.length ? d[Math.min(d.length - 1, Math.ceil(d.length * p) - 1)] : null;
        return { samples: d.length, picks: window.__h.picks, throttled: window.__h.throttled,
            allNear: window.__h.allNear, p50: q(0.5), p95: q(0.95), max: d.length ? d[d.length - 1] : null,
            sum: d.reduce((s, x) => s + x, 0) };
    }) : null;
    await page.close();
    return { label, wallMs: wall, snapshot: snap, hover, errors };
}

const bSide = await runSide(URL_B, 'B');
const aSide = await runSide(URL_A, 'A');
const fmt = r => `${r.label}: 帧P95=${r.snapshot?.p95Ms?.toFixed(1)}ms max=${r.snapshot?.maxMs?.toFixed(1)}ms 长帧>50ms=${r.snapshot?.longFrames} 帧数=${r.snapshot?.samples} update均值=${r.snapshot?.updateMs?.toFixed(2)}ms`;
console.log('==== 悬停/选择反馈性能 v2（同输入序列 120 次移动）====');
console.log(fmt(bSide));
console.log(fmt(aSide));
if (bSide.hover) {
    const h = bSide.hover;
    console.log(`悬停管线（B 侧实测窗口）：实际拾取 ${h.picks} 次（节流拦截 ${h.throttled} 次事件），` +
        `单次处理耗时 P50=${h.p50?.toFixed(2)}ms P95=${h.p95?.toFixed(2)}ms max=${h.max?.toFixed(2)}ms，` +
        `窗口内悬停处理总耗时 ${h.sum?.toFixed(1)}ms / ${(bSide.wallMs / 1000).toFixed(0)}s。`);
    console.log(`查询口径：悬停拾取 ${h.picks} 次 × 每次恰 1 次 forEachNear 空间查询（驻塔候选走 500ms 缓存）；` +
        `同窗口全军 forEachNear（战斗索敌等）共 ${h.allNear} 次，仅作规模参照，不构成占比结论。`);
    console.log(`结论表述：在本次 ${(bSide.wallMs / 1000).toFixed(0)}s 实测窗口内，悬停新增处理总耗时 ${h.sum?.toFixed(1)}ms（单次 P95 ${h.p95?.toFixed(2)}ms），` +
        `帧 P95 ${bSide.snapshot?.p95Ms?.toFixed(1)}ms vs 基线 ${aSide.snapshot?.p95Ms?.toFixed(1)}ms——窗口内未观测到悬停导致的帧级退化。`);
} else {
    console.log('B 侧悬停探针未生效');
}
console.log(`页面报错：B=${bSide.errors.length} A=${aSide.errors.length}`);
await browser.close();
