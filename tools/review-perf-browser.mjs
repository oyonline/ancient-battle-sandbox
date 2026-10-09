// Review 定点修复的性能 A/B 基准（桌面浏览器、真实渲染帧）：
// 同一脚本对 A（修复前 dist）与 B（修复后 dist）各跑一轮，
// 场景 = 领土战 + 双方自动征兵/建设/驻塔 + 中央持续交战。
// 读取游戏自带的 FrameStats（右上性能读数同源数据）：帧耗时 P95、
// 超过 50ms 的长帧次数、主循环与模拟耗时（不含 GPU 绘制）。
// 用法：VERIFY_URL=... LABEL=B OUT=path.json node tools/review-perf-browser.mjs [--seconds=25]
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const seconds = Number(args.find(a => a.startsWith('--seconds='))?.split('=')[1] ?? 25);
const url = process.env.VERIFY_URL || 'http://127.0.0.1:5301/classic.html';
const label = process.env.LABEL || 'B';
const out = process.env.OUT || path.resolve(`.omc/evidence/review-perf/browser-${label}.json`);
mkdirSync(path.dirname(out), { recursive: true });

const executablePath = [1228, 1208].map(v => path.join(homedir(),
    `Library/Caches/ms-playwright/chromium-${v}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)).find(existsSync);
const browser = await chromium.launch({ executablePath, headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));

await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.UI?.scene && UI.phase === 'home', null, { timeout: 30000 });
await page.click('[data-territory-entry]');
await page.waitForFunction(() => UI.phase === 'ready' && UI.scene.units.length > 0, null, { timeout: 30000 });
await page.click('#btn-start');
await page.waitForFunction(() => UI.phase === 'battle' && !UI.countdown && UI.scene.battleStarted, null, { timeout: 20000 });

// 场景夹具（A/B 同构）：双方 AI 全开（征兵+建设+驻塔），中央放两军自由单位
// 形成持续交战，并给双方军费保证征兵不停。
await page.evaluate(() => {
    const scene = UI.scene;
    scene.territory.autoBuy = { red: true, blue: true };
    scene.territory.econ.treasury.red = scene.territory.econ.treasury.blue = 4000;
    const hill = scene.flags.find(f => f.role === 'hill');
    for (let i = 0; i < 60; i++) {
        const column = i % 10, row = Math.floor(i / 10);
        scene.spawnUnit('red', ['infantry', 'pikeman', 'archer', 'cavalry'][i % 4],
            hill.gx - 4 - column * 0.8, hill.gy - 3 + row * 1.1);
        scene.spawnUnit('blue', ['infantry', 'pikeman', 'archer', 'cavalry'][i % 4],
            hill.gx + 4 + column * 0.8, hill.gy - 3 + row * 1.1);
    }
    scene.rebuildSpatial();
});

// 预热 8 秒（JIT/贴图/首波行军），随后正式测量窗口：
// 把诊断环形缓冲扩到能覆盖整个窗口（capacity 是纯视图统计参数），
// P95/长帧次数因此覆盖全窗口，而不是默认 240 帧滚动段。
await page.waitForTimeout(8000);
await page.evaluate(seconds => {
    const stats = UI.scene.performanceStats;
    stats.capacity = Math.max(240, Math.ceil(seconds * 120));
    // A 树（修复前）没有 reset()：等价的手动重置（samples + next 一起清才安全）。
    if (stats.reset) stats.reset();
    else { stats.samples = []; stats.next = 0; }
}, seconds);
const started = Date.now();
const series = [];
while (Date.now() - started < seconds * 1000) {
    await page.waitForTimeout(5000);
    series.push(await page.evaluate(() => UI.scene.performanceStats?.snapshot()));
}
const result = await page.evaluate(() => {
    const scene = UI.scene;
    const camps = scene.territory.camps.buildings.filter(b => !b.dead);
    return {
        snapshot: scene.performanceStats?.snapshot(),
        simTimeS: Math.round(scene.simulationTime / 1000),
        units: scene.units.filter(u => !u.dead && !u.withdrawn).length,
        wounded: scene.units.filter(u => !u.dead && !u.withdrawn && u.hp < u.maxHp - 1e-9).length,
        damage: Math.round(scene.battleStats.red.damage + scene.battleStats.blue.damage),
        buildings: camps.length, underConstruction: camps.filter(b => !b.complete).length,
        garrisoned: camps.reduce((n, b) => n + b.garrisonIds.length, 0),
        dead: scene.units.filter(u => u.dead).length
    };
});
const measuredWallS = (Date.now() - started) / 1000;
writeFileSync(out, JSON.stringify({
    kind: 'review A/B desktop-browser benchmark: rendering frames + real game loop',
    label, url, seconds, measuredWallS, series,
    browser: 'Chromium (Playwright chrome-mac-arm64, headed window)',
    viewport: { width: 1440, height: 1000 },
    pageErrors: errors, result
}, null, 2));
console.log(JSON.stringify({ label, ...result, pageErrors: errors.length }, null, 2));
await browser.close();
