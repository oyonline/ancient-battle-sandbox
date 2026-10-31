#!/usr/bin/env node
// 使用已运行的 arena；本工具不启动/停止服务器，finally 关闭自己的浏览器。
import { chromium } from 'playwright-core';
import { readdir, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const flags = new Map();
for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--mixed' || key === '--help') flags.set(key, true);
    else if (['--url', '--models', '--seconds', '--delay-ms', '--preset-a', '--preset-b'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) flags.set(key, args[++i]);
    else throw new Error(`未知参数或缺少参数值：${key}`);
}
if (flags.has('--help')) {
    console.log('node tools/lan3d-smoke.mjs --url http://localhost:5300 --models box|real --seconds 120 [--mixed] [--delay-ms 200] [--preset-a small|standard|large] [--preset-b small|standard|large]');
    process.exit(0);
}
const base = new URL(flags.get('--url') || 'http://localhost:5300');
const models = flags.get('--models') || 'box', seconds = Number(flags.get('--seconds') || 120);
const delayMs = Number(flags.get('--delay-ms') || 0);
const presets = [flags.get('--preset-a') || 'standard', flags.get('--preset-b') || 'standard'];
if (!['box', 'real'].includes(models) || !Number.isFinite(seconds) || seconds <= 0 ||
    !Number.isFinite(delayMs) || delayMs < 0 || presets.some(p => !['small', 'standard', 'large'].includes(p))) throw new Error('参数值非法，请使用 --help');

async function chromePath() {
    const root = join(homedir(), 'Library/Caches/ms-playwright');
    const builds = (await readdir(root)).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const build of builds) {
        const path = join(root, build, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
        try { await access(path); return path; } catch { /* 尝试下一个已安装版本。 */ }
    }
    throw new Error('未找到 Chrome for Testing（~/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/...）');
}
const urlFor = real => {
    const url = new URL('battle3d-spike.html', base.href.endsWith('/') ? base : base.href + '/');
    url.searchParams.set('lan', '1');
    if (real) { url.searchParams.set('models', '1'); url.searchParams.set('gpu', '1'); }
    return url.href;
};
let browser;
const pendingDelays = new Set(), errors = [[], []], pages = [];
let failure = null, report;
const read = page => page.evaluate(() => ({ ...window.__spike.lan.diagnostics(),
    hashComparisons: window.__lanSmoke.hashComparisons, hashMismatches: window.__lanSmoke.hashMismatches,
    actualModels: !!window.__spike.models, simulationTime: window.__spike.getScene()?.simulationTime || 0,
    gameSpeed: window.__spike.getScene()?.gameSpeed, paused: window.__spike.getScene()?.paused }));
try {
    browser = await chromium.launch({ executablePath: await chromePath(), headless: true,
        args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    for (let i = 0; i < 2; i++) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const page = await context.newPage(); pages.push(page);
        page.on('pageerror', error => errors[i].push(error.message));
        if (i === 1 && delayMs > 0) {
            // Playwright WebSocketRoute：接管服务器→B 的帧；固定延迟保持帧序。
            await page.routeWebSocket(/.*/, route => {
                const server = route.connectToServer();
                server.onMessage(message => {
                    const timer = setTimeout(() => { pendingDelays.delete(timer); route.send(message); }, delayMs);
                    pendingDelays.add(timer);
                });
            });
        }
        const real = flags.has('--mixed') ? i === 0 : models === 'real';
        await page.goto(urlFor(real), { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__spike?.lan?.arena, null, { timeout: 15000 + delayMs * 2 });
        await page.evaluate(() => {
            const session = window.__spike.lan, original = session.makeNet;
            window.__lanSmoke = { hashComparisons: 0, hashMismatches: [] };
            session.makeNet = (...parameters) => {
                const net = original(...parameters), check = net.checkHashes.bind(net);
                net.checkHashes = () => {
                    for (const [turn, mine] of net.myHashes) {
                        const theirs = net.peerHashes.get(turn);
                        if (theirs == null) continue;
                        window.__lanSmoke.hashComparisons++;
                        if (mine !== theirs) window.__lanSmoke.hashMismatches.push({ turn, mine, theirs });
                    }
                    check();
                };
                return net;
            };
        });
    }
    await pages[0].locator('#lan-create').click();
    await pages[0].waitForFunction(() => !!window.__spike.lan.room);
    const code = await pages[0].locator('#lan-room-code').textContent();
    await pages[1].locator('#lan-code').fill(code);
    await pages[1].locator('#lan-join').click();
    await pages[1].waitForFunction(() => !!window.__spike.lan.room);
    await Promise.all(pages.map(async (page, i) => {
        await page.locator('#lan-preset').selectOption(presets[i]);
        await page.locator('#lan-confirm').click();
    }));
    await Promise.all(pages.map(page => page.waitForFunction(() =>
        ['running', 'finished', 'stopped'].includes(window.__spike.lan.state), null, { timeout: 180000 + delayMs * 2 })));
    const start = Date.now();
    let snapshots;
    while (true) {
        snapshots = await Promise.all(pages.map(read));
        if (snapshots.some(s => s.desync || s.state === 'stopped') ||
            snapshots.every(s => s.state === 'finished' && s.myResult && s.peerResult) || Date.now() - start >= seconds * 1000) break;
        await delay(500);
    }
    const completed = snapshots.every(s => s.myResult && s.peerResult);
    const sameResult = completed ? snapshots.every(s =>
        ['turn', 'winner', 'hash'].every(key => s.myResult[key] === s.peerResult[key] && s.myResult[key] === snapshots[0].myResult[key])) : null;
    report = { url: base.href, requestedModels: models, mixed: flags.has('--mixed'), delayMs, presets,
        elapsedSeconds: (Date.now() - start) / 1000, completed, winnerResultConsistent: sameResult,
        scope: completed ? '完整终局' : '限时采样，未证明完整终局一致性', sides: snapshots, pageErrors: errors };
    if (snapshots.some(s => s.desync || s.state === 'stopped' || !s.execTurn || s.hashMismatches.length || s.gameSpeed !== 1 || s.paused !== false) ||
        sameResult === false || errors.some(list => list.length)) failure = '联机烟测发现失败，见 sides/pageErrors';
    if (snapshots.every(s => s.execTurn >= 240) && snapshots.some(s => s.hashComparisons < 1)) {
        failure = [failure, '两端 execTurn ≥ 240，但未完成哈希比较'].filter(Boolean).join('；');
    }
    if (snapshots.some((s, i) => (flags.has('--mixed') ? i === 0 : models === 'real') && s.actualModels === false)) {
        failure = [failure, '真模型未生效（已降级方块）'].filter(Boolean).join('；');
    }
} catch (error) {
    failure = error.stack || String(error);
    report = { url: base.href, failure, pageErrors: errors,
        sides: await Promise.all(pages.map(page => read(page).catch(() => null))) };
} finally {
    for (const timer of pendingDelays) clearTimeout(timer);
    if (browser) await browser.close();
}
console.log(JSON.stringify({ ...report, failure }, null, 2));
if (failure) process.exitCode = 1;
