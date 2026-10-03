// 调试 B 组：两个 1x 页的记录回合键
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
const EXE = path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const browser = await chromium.launch({ executablePath: EXE, headless: true });
async function soloPage() {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await p.goto('http://127.0.0.1:5300/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForTimeout(1500);
    await p.click('[data-territory-entry]');
    await p.waitForFunction(() => { const b = document.getElementById('btn-start'); return b && !b.disabled; }, null, { timeout: 45000 });
    await p.click('#btn-start');
    await p.waitForFunction(() => window.UI?.phase === 'battle', null, { timeout: 20000 });
    return p;
}
const INSTALL = `(() => {
  const scene = window.UI.scene;
  window.__qaFps = new Map();
  const cur = scene.simulationTime;
  scene.__qaSim = cur;
  window.__qaWrites = 0;
  window.__qaSamples = [];
  Object.defineProperty(scene, 'simulationTime', {
    configurable: true,
    get() { return this.__qaSim; },
    set(v) {
      this.__qaSim = v;
      window.__qaWrites++;
      const turn = Math.round(v / (1000 / 60));
      if (window.__qaSamples.length < 8) window.__qaSamples.push(turn);
      if (turn > 0 && turn % 60 === 0 && !window.__qaFps.has(turn)) window.__qaFps.set(turn, 'x');
    }
  });
})()`;
const a = await soloPage();
await a.waitForTimeout(2500);
const b = await soloPage();
await Promise.all([a.evaluate(INSTALL), b.evaluate(INSTALL)]);
await a.waitForTimeout(12000);
await b.waitForTimeout(12000);
for (const [name, p] of [['a', a], ['b', b]]) {
    const r = await p.evaluate(() => ({ keys: [...window.__qaFps.keys()], writes: window.__qaWrites, firstWrites: window.__qaSamples, sim: Math.round(window.UI.scene.simulationTime) }));
    console.log(name, 'sim(ms)=', r.sim, 'writes=', r.writes, 'firstTurnWrites=', r.firstWrites.join(','), 'keys=', r.keys.join(','));
}
await browser.close();
