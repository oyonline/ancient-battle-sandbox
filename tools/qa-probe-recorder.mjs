// 调试：recorder setter 是否在真实页面触发
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
const EXE = path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const p = await browser.newPage();
p.on('pageerror', e => console.log('[pageerror]', e.message));
await p.goto('http://127.0.0.1:5300/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1200);
await p.click('[data-territory-entry]');
await p.waitForFunction(() => { const b = document.getElementById('btn-start'); return b && !b.disabled; }, null, { timeout: 45000 });
await p.click('#btn-start');
await p.waitForFunction(() => window.UI?.phase === 'battle', null, { timeout: 20000 });
const probe = await p.evaluate(() => {
  const scene = window.UI.scene;
  const desc = Object.getOwnPropertyDescriptor(scene, 'simulationTime');
  const proto = Object.getPrototypeOf(scene);
  const protoDesc = Object.getOwnPropertyDescriptor(proto, 'simulationTime');
  let fired = 0;
  const cur = scene.simulationTime;
  Object.defineProperty(scene, 'simulationTime', {
    configurable: true,
    get() { return this.__qaSim; },
    set(v) { this.__qaSim = v; fired++; }
  });
  scene.__qaSim = cur;
  return {
    ownDesc: desc ? { hasGet: !!desc.get, hasValue: 'value' in desc, writable: desc.writable } : null,
    protoDesc: protoDesc ? { hasGet: !!protoDesc.get, hasValue: 'value' in protoDesc } : null,
    startTime: cur,
    readBack: scene.simulationTime
  };
});
console.log('descriptor probe:', JSON.stringify(probe));
await p.waitForTimeout(4000);
const after = await p.evaluate(() => ({ sim: window.UI.scene.simulationTime, qaSim: window.UI.scene.__qaSim }));
console.log('after 4s:', JSON.stringify(after));
await browser.close();
