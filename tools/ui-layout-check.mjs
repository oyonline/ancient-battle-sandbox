// UI 布局数值过闸：各面板 getBoundingClientRect 两两不重叠、
// 底部中央战场走廊让出 ≥300px、面板总遮挡面积占比 ≤22%。用法：
//   npx vite preview --port 4399 --host 127.0.0.1 & node tools/ui-layout-check.mjs
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
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(1200);
await page.click('[data-territory-entry]');
await page.click('#btn-start');
await page.waitForTimeout(9000);
const report = await page.evaluate(() => {
    const rect = id => {
        const el = document.getElementById(id);
        if (!el || el.hidden) return null;
        const r = el.getBoundingClientRect();
        return { id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const panels = ['territory-strip', 'recruit-dock', 'camp-control-bar', 'battalion-bar', 'unit-inspector']
        .map(rect).filter(Boolean);
    const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const clashes = [];
    for (let i = 0; i < panels.length; i++) for (let j = i + 1; j < panels.length; j++)
        if (overlap(panels[i], panels[j])) clashes.push(panels[i].id + '×' + panels[j].id);
    const dock = panels.find(p => p.id === 'recruit-dock');
    const bat = panels.find(p => p.id === 'battalion-bar');
    const corridor = dock && bat ? bat.x - (dock.x + dock.w) : -1;
    const area = panels.reduce((sum, p) => sum + p.w * p.h, 0);
    return { panels, clashes, corridor, coveragePct: Math.round(area / (1440 * 900) * 1000) / 10,
        controlbar: rect('controlbar') };
});
console.log(JSON.stringify(report, null, 1));
const ok = report.clashes.length === 0 && report.corridor >= 300 && report.coveragePct <= 22;
console.log(ok ? 'LAYOUT GATE ✅' : 'LAYOUT GATE ❌');
await browser.close();
process.exit(ok ? 0 : 1);
