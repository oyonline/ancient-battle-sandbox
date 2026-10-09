// ==================== 无头浏览器自测（playwright-core + 本机 Chromium） ====================
// 用法：npm run arena 起服后另开终端跑 npx node tools/headless-verify.mjs
// 覆盖：单机领土局全链路 / 骑兵方向贴图乒乓量化（闪烁检测）/ 双浏览器联机 E2E（锁步一致性+停等分布）
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';

const cand = [
    path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
];
const EXE = cand.find(existsSync);
if (!EXE) { console.error('未找到缓存 Chromium，请先安装 playwright 浏览器或修改 tools/headless-verify.mjs 的路径'); process.exit(1); }
const URL = process.env.VERIFY_URL || 'http://127.0.0.1:5300/classic.html';
const browser = await chromium.launch({ executablePath: EXE, headless: true });
let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' · ' + detail : ''}`); if (!ok) failed++; };

// ---------- 1) 单机领土局 ----------
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(1200);
check('首页加载', await page.evaluate(() => window.UI?.phase) === 'home');
await page.click('[data-territory-entry]');
await page.click('#btn-start');
await page.waitForTimeout(6000);
const solo = await page.evaluate(() => new Promise(resolve => {
    const scene = window.UI?.scene;
    if (!scene) return resolve({ error: true });
    const x1 = scene.units[0]?.gx ?? 0;
    setTimeout(() => resolve({
        phase: window.UI.phase, moved: scene.units[0] ? Math.abs(scene.units[0].gx - x1) > 0.5 : false,
        alive: scene.redAlive + scene.blueAlive, treasury: Math.round(scene.territory.econ.treasury.red)
    }), 2000);
}));
check('单机开战且士兵移动', solo.phase === 'battle' && solo.moved, `在场${solo.alive} 军费${solo.treasury}`);
check('零页面报错', errors.length === 0, errors[0] || '');

// ---------- 2) 骑兵方向贴图乒乓（闪烁量化，忽略走路动画帧） ----------
const flicker = await page.evaluate(() => new Promise(resolve => {
    const scene = window.UI.scene;
    const cav = scene.units.filter(u => u.type === 'cavalry' && !u.dead).slice(0, 8);
    const last = cav.map(() => null), flips = cav.map(() => 0);
    let tick = 0;
    const timer = setInterval(() => {
        cav.forEach((u, i) => {
            const key = ((u.spr?.texture?.key || '').match(/_(east|southeast|south|northeast|north)/) || ['?'])[0] + (u.spr?.flipX ? '|F' : '');
            if (last[i] && key !== last[i]) flips[i]++;
            last[i] = key;
        });
        if (++tick >= 100) { clearInterval(timer); resolve({ n: cav.length, worst: Math.max(...flips, 0) }); }
    }, 100);
}));
check('骑兵方向贴图低频（无闪烁）', flicker.worst <= 20, `10秒最高 ${flicker.worst} 次方向切换`);
await page.close();

// ---------- 3) 联机双浏览器 E2E ----------
const host = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const guest = await browser.newPage({ viewport: { width: 1280, height: 800 } });
for (const p of [host, guest]) {
    await p.goto(URL, { waitUntil: 'load' });
    await p.waitForTimeout(1000);
    await p.click('[data-net-entry]');
    await p.waitForTimeout(500);
}
await host.click('#btn-net-create');
await host.waitForSelector('#net-lobby:not([hidden])', { timeout: 5000 });
await guest.fill('#net-code-input', await host.textContent('#net-room-code'));
await guest.click('#btn-net-join');
await host.waitForFunction(() => document.getElementById('net-peer-state')?.textContent.includes('已加入'), null, { timeout: 5000 });
await host.click('#btn-net-ready');
await guest.click('#btn-net-ready');
await host.waitForFunction(() => window.UI?.phase === 'battle', null, { timeout: 10000 });
await guest.waitForFunction(() => window.UI?.phase === 'battle', null, { timeout: 10000 });
await host.waitForTimeout(15000);
const desync = [await host.evaluate(() => window.UI.scene.net?.desynced), await guest.evaluate(() => window.UI.scene.net?.desynced)];
check('联机开战双端零分叉（哈希校验）', desync.every(d => d === false));
const steady = await host.evaluate(() => new Promise(resolve => {
    const before = window.UI.scene.net?.stalls || 0;
    setTimeout(() => resolve((window.UI.scene.net?.stalls || 0) - before), 8000);
}));
check('联机稳态零停等', steady === 0, `8 秒新增 ${steady} 次`);
await browser.close();
console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项未过 ❌`);
process.exit(failed === 0 ? 0 : 1);
