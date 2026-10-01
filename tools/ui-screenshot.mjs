import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
const cand = [
    path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
];
const EXE = cand.find(existsSync);
const URL = process.env.SHOT_URL || 'http://127.0.0.1:4399/';
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(1200);
await page.click('[data-territory-entry]');
await page.click('#btn-start');
await page.waitForTimeout(9000);   // 倒计时+开局
await page.screenshot({ path: '/tmp/ui-shot-1-default.png' });
// 打开建设面板
await page.click('#btn-camp-open');
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/ui-shot-2-camp-open.png' });
// 选中一个己方士兵 → 营队条出现下令按钮
const picked = await page.evaluate(() => {
    const scene = window.UI?.scene;
    const u = scene?.units?.find(x => x.team === (window.UI.mySide || 'red') && !x.dead && x.type === 'infantry');
    if (!u) return null;
    scene.selectBattalionByUnit(u);
    window.UI.updateBattalionBar();
    return u.id;
});
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/ui-shot-3-battalion.png' });
// DOM 状态断言
const state = await page.evaluate(() => ({
    stripHidden: document.getElementById('territory-strip')?.hidden,
    dockHidden: document.getElementById('recruit-dock')?.hidden,
    controlbarDisplay: getComputedStyle(document.getElementById('controlbar')).display,
    campHidden: document.getElementById('camp-control-bar')?.hidden,
    ctlHost: document.getElementById('battle-ctl')?.parentElement?.id,
    recruitBtns: document.querySelectorAll('#recruit-bar .recruit-btn').length,
    battalionHidden: document.getElementById('battalion-bar')?.hidden
}));
console.log('picked unit:', picked);
console.log(JSON.stringify(state, null, 1));
console.log('pageerrors:', errors.length);
await browser.close();
