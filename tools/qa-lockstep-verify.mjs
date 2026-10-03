// ==================== QA 锁步与确定性实测（2026-10-03 Q1） ====================
// 前置：dist 已构建；node server/arena.mjs 已在 :5300 服务。
// 覆盖：
//  A) 双浏览器联机（当前版×2）：真实键鼠下令（选营→驻守令→地图选点），
//     自带哈希 desynced=false + 独立指纹按回合精确对齐比对 + 稳态停等 0。
//  B) 单机领土局 1x / 2x / 1x 三开：固定步长轨迹按回合指纹一致（速度不改结果），
//     两次 1x 独立局可复现。
//  C) 旧版本拒绝混入：C1 基线 a0dfc8e 页面经路由兜底能加载进入联机入口
//     （Chromium PNA 策略禁 route 页面发起 localhost WS，仅验证加载）；
//     C2 原生 WebSocket 旧版客户端（复刻旧页面握手报文 v='2026-10-02-review-fixes-r2'）
//     与真实当前版浏览器页同房就绪 → 服务器拒绝开局、双端提示版本不一致。
// 观察钩子：simulationTime 每模拟回合恰好写一次——用访问器属性在恰好 60 倍数
// 回合记录指纹（先初始化后备字段，避免 NaN 破坏模拟；纯观察不改输入）。
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

const EXE = [
    path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
].find(existsSync);
if (!EXE) { console.error('未找到缓存 Chromium'); process.exit(2); }
const PAGE_URL = process.env.QA_URL || 'http://127.0.0.1:5300/';
const BASELINE_DIST = '/tmp/dsh-qa-baseline/dist';
const OLD_SIM_VERSION = '2026-10-03-cavalry-def10';   // R2：用上一轮版本做更锐利的拒绝测试
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const browser = await chromium.launch({ executablePath: EXE, headless: true });
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' · ' + detail : ''}`); if (!ok) failed++; };

// 页内指纹：比游戏投影更严——纳入营归属、corpsManaged、冲锋状态与助跑距离。
const INSTALL_RECORDER = `(() => {
  const scene = window.UI.scene;
  window.__qaFps = new Map();
  const cur = scene.simulationTime;      // 先接管后备字段，避免首读 undefined→NaN
  scene.__qaSim = cur;
  window.__qaRecord = (turn) => {
    const s = window.UI.scene;
    const parts = ['t' + Math.round(s.simulationTime)];
    for (const u of s.units) {
      if (u.dead || u.withdrawn) continue;
      parts.push(u.id, u.team, u.type, u.gx.toFixed(4), u.gy.toFixed(4), u.hp.toFixed(3),
        u.moraleState ?? '', u.state ?? '', Math.round((u.chargeDistance || 0) * 100),
        u.corpsManaged ? 1 : 0, u.battalion ? u.battalion.id : 0);
    }
    parts.push('f');
    for (const f of s.flags || []) parts.push(f.owner ? f.owner[0] : 'n', (f.progress || 0).toFixed(4));
    if (s.territory) parts.push('e',
      Math.round(s.territory.econ.treasury.red * 10) / 10, Math.round(s.territory.econ.treasury.blue * 10) / 10,
      s.territory.tickets.tickets.red, s.territory.tickets.tickets.blue,
      s.territory.recruit.spawned.red, s.territory.recruit.spawned.blue);
    window.__qaFps.set(turn, parts.join('|'));
  };
  Object.defineProperty(scene, 'simulationTime', {
    configurable: true,
    get() { return this.__qaSim; },
    set(v) {
      this.__qaSim = v;
      const turn = Math.round(v / (1000 / 60));
      if (turn > 0 && turn % 60 === 0 && !window.__qaFps.has(turn)) window.__qaRecord(turn);
    }
  });
})()`;

async function collect(page, ms) {
    await page.evaluate(INSTALL_RECORDER);
    const health = await page.evaluate(() => Number.isFinite(window.UI.scene.simulationTime));
    if (!health) throw new Error('recorder 装载后 simulationTime 非有限值——观察钩子破坏了模拟');
    await page.waitForTimeout(ms);
    return await page.evaluate(() => Object.fromEntries(window.__qaFps || new Map()));
}
const objToMap = o => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));
function compareBuckets(a, b) {
    let common = 0; const mismatched = [];
    for (const [k, v] of a) if (b.has(k)) { common++; if (b.get(k) !== v) mismatched.push(k); }
    return { common, mismatched };
}
async function zoomOut(page) {
    const canvas = await page.locator('canvas').first().boundingBox();
    const cx = canvas.x + canvas.width / 2, cy = canvas.y + canvas.height / 2;
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 14; i++) await page.mouse.wheel(0, -420);
    await page.waitForTimeout(400);
    return { cx, cy };
}

// ---------- A) 双端联机 ----------
async function netPairTest() {
    const host = await browser.newPage({ viewport: { width: 1360, height: 850 } });
    const guest = await browser.newPage({ viewport: { width: 1360, height: 850 } });
    const errs = [];
    for (const p of [host, guest]) {
        p.on('pageerror', e => errs.push(e.message));
        await p.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await p.waitForTimeout(1200);
        await p.click('[data-net-entry]');
        await p.waitForTimeout(500);
    }
    await host.click('#btn-net-create');
    await host.waitForSelector('#net-lobby:not([hidden])', { timeout: 5000 });
    await guest.fill('#net-code-input', await host.textContent('#net-room-code'));
    await guest.click('#btn-net-join');
    await host.waitForFunction(() => document.getElementById('net-peer-state')?.textContent.includes('已加入'), null, { timeout: 5000 });
    await host.click('#btn-net-ready'); await guest.click('#btn-net-ready');
    await host.waitForFunction(() => window.UI?.phase === 'battle', null, { timeout: 15000 });
    await guest.waitForFunction(() => window.UI?.phase === 'battle', null, { timeout: 15000 });
    console.log('联机双端进入战斗，开始真实下令……');

    async function issueOrders(p, n) {
        const { cx, cy } = await zoomOut(p);
        for (let i = 0; i < n; i++) {
            const chips = p.locator('.battalion-chip');
            const count = await chips.count();
            if (!count) continue;
            await chips.nth(i % Math.min(count, 3)).click();
            await p.waitForTimeout(250);
            if (await p.locator('#order-hold').count()) {
                await p.locator('#order-hold').click();
                await p.waitForTimeout(200);
                await p.mouse.click(cx + (i % 2 ? 210 : -210), cy + (i % 2 ? -120 : 130));
                await p.waitForTimeout(400);
            }
        }
    }
    await issueOrders(host, 3);
    await issueOrders(guest, 3);
    // F14 读数：锁步命令需等到后续回合才被消费——轮询等待双方营令落地（≤8s）
    let orders = [];
    for (let w = 0; w < 16; w++) {
        await host.waitForTimeout(500);
        orders = await host.evaluate(() => {
            const bs = window.UI.scene.battalions.battalions;
            return bs.filter(b => b.orderPoint || b.orderFlag != null || b.retreat)
                .map(b => ({ id: b.id, team: b.team, hold: !!b.orderPoint, flag: b.orderFlag ?? null, retreat: !!b.retreat }));
        });
        if (orders.some(o => o.team === 'red') && orders.some(o => o.team === 'blue')) break;
    }
    check('A0 双端命令生效（红蓝双方令均在模拟态落地，F14）',
        orders.some(o => o.team === 'red') && orders.some(o => o.team === 'blue'),
        JSON.stringify(orders));

    const [hostO, guestO] = await Promise.all([collect(host, 42000), collect(guest, 42000)]);
    const hostB = objToMap(hostO), guestB = objToMap(guestO);
    const desync = [await host.evaluate(() => window.UI.scene.net?.desynced), await guest.evaluate(() => window.UI.scene.net?.desynced)];
    check('A1 联机双端零分叉（自带哈希校验 desynced=false）', desync.every(d => d === false), JSON.stringify(desync));
    const { common, mismatched } = compareBuckets(hostB, guestB);
    check('A2 独立指纹回合对齐比对一致（含营归属与 corpsManaged）', common >= 8 && mismatched.length === 0,
        `共同回合 ${common} 个，不一致 ${mismatched.length} 个${mismatched.length ? '：' + mismatched.slice(0, 5) : ''}`);
    if (mismatched.length) {
        const t = mismatched[0];
        const hp = hostB.get(t).split('|'), gp = guestB.get(t).split('|');
        const diffs = [];
        for (let i = 0; i < Math.max(hp.length, gp.length); i++) if (hp[i] !== gp[i]) diffs.push(`[${i}] ${hp[i]} vs ${gp[i]}`);
        console.log('  首个不一致回合字段差异：\n  ' + diffs.slice(0, 12).join('\n  '));
    }
    const steady = await host.evaluate(() => new Promise(resolve => {
        const before = window.UI.scene.net?.stalls || 0;
        const t0 = window.UI.scene.simulationTime;
        setTimeout(() => resolve({ delta: (window.UI.scene.net?.stalls || 0) - before,
            simAdvance: window.UI.scene.simulationTime - t0,
            longest: window.UI.scene.net?.longestWaitMs || 0 }), 15000);
    }));
    const totalStalls = await host.evaluate(() => window.UI.scene.net?.stalls || 0);
    // 无头渲染吞吐在外部高负载下可低于实时（~0.5x），阈值按"模拟持续推进且零新增停等"
    // 收窄表述：≥5s 推进证明无死锁/漂移，确定性门在 A1/A2。
    check('A3 停等只作瞬态、无漂移且追赶有效（零新增停等+持续推进）', steady.delta === 0 && steady.simAdvance >= 5000,
        `窗口新增停等 ${steady.delta} 次，模拟推进 ${(steady.simAdvance / 1000).toFixed(1)}s（无头渲染吞吐受负载影响），最长单次等待 ${steady.longest.toFixed(0)}ms，全程共 ${totalStalls} 次`);
    check('A4 联机期间零页面报错', errs.length === 0, errs[0] || '');
    await host.screenshot({ path: 'docs/qa-net-lockstep-host.png' });
    await host.close(); await guest.close();
}

// ---------- B) 1x / 2x / 1x 三开一致 ----------
async function speedConsistencyTest() {
    async function soloPage(speed) {
        const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await p.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await p.waitForTimeout(1500);
        await p.click('[data-territory-entry]');
        await p.waitForFunction(() => {
            const b = document.getElementById('btn-start');
            return b && !b.disabled && !b.textContent.includes('准备战场');
        }, null, { timeout: 45000 });
        await p.click('#btn-start');
        await p.waitForFunction(() => window.UI?.phase === 'battle', null, { timeout: 20000 });
        await p.waitForTimeout(1500);
        if (speed === 2) {
            await p.click('.speed-btn[data-speed="2"]');
            await p.waitForTimeout(300);
        }
        return p;
    }
    const a1 = await soloPage(1);
    const Ao = await collect(a1, 30000);
    await a1.close();
    const b2 = await soloPage(2);
    const Bo = await collect(b2, 30000);
    await b2.close();
    const c1 = await soloPage(1);
    const Co = await collect(c1, 30000);
    const A = objToMap(Ao), B = objToMap(Bo), C = objToMap(Co);
    const range = m => m.size ? `${Math.min(...m.keys())}..${Math.max(...m.keys())}` : '空';
    console.log(`B 组样本：1x=${A.size}[${range(A)}] 2x=${B.size}[${range(B)}] 1x'=${C.size}[${range(C)}]`);
    const r1 = compareBuckets(A, B), r2 = compareBuckets(A, C);
    check('B1 1x 与 2x 固定步长轨迹按回合一致', r1.common >= 15 && r1.mismatched.length === 0,
        `共同回合 ${r1.common}，不一致 ${r1.mismatched.length}${r1.mismatched.length ? '：' + r1.mismatched.slice(0, 5) : ''}`);
    check('B2 两次 1x 独立局轨迹可复现', r2.common >= 15 && r2.mismatched.length === 0,
        `共同回合 ${r2.common}，不一致 ${r2.mismatched.length}`);
    await c1.screenshot({ path: 'docs/qa-speed-1x.png' });
    await c1.close();
}

// ---------- C) 旧 SIM_VERSION 拒绝混入 ----------
async function versionGateTest() {
    // C1：基线页面能加载并进入联机入口（路由兜底；WS 被 Chromium PNA 拦截属预期）
    const oldCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const old = await oldCtx.newPage();
    await old.route('**/*', async route => {
        const req = route.request();
        if (!req.url().startsWith('http')) return route.continue();
        let p = new URL(req.url()).pathname;
        if (p === '/' || !path.extname(p)) p = '/index.html';
        const file = path.join(BASELINE_DIST, p);
        try {
            await route.fulfill({ body: readFileSync(file), contentType: MIME[path.extname(file)] || 'application/octet-stream' });
        } catch { await route.fulfill({ status: 404, body: 'missing' }); }
    });
    await old.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await old.waitForTimeout(1500);
    const oldLoaded = await old.evaluate(() => {
        document.querySelector('[data-net-entry]')?.click();
        return new Promise(resolve => setTimeout(() => resolve(!!document.querySelector('#net-lobby') ||
            !document.getElementById('net-sheet')?.hidden), 1200));
    });
    check('C1 旧版（a0dfc8e）页面加载并可进入联机入口', oldLoaded, '基线 dist 路由兜底');
    await old.screenshot({ path: 'docs/qa-version-gate-old-client.png' });
    await oldCtx.close();

    // C2：真实当前版浏览器房主 + 原生 WS 旧版客户端（复刻旧页面握手与就绪报文）
    const host = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await host.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await host.waitForTimeout(1200);
    await host.click('[data-net-entry]');
    await host.waitForTimeout(500);
    await host.click('#btn-net-create');
    await host.waitForSelector('#net-lobby:not([hidden])', { timeout: 5000 });
    const code = await host.textContent('#net-room-code');

    const oldWs = new WebSocket(`ws://127.0.0.1:5300/`);
    const oldMsgs = [];
    oldWs.on('message', d => oldMsgs.push(JSON.parse(d.toString())));
    await new Promise((resolve, reject) => {
        oldWs.on('open', resolve);
        oldWs.on('error', reject);
    });
    oldWs.send(JSON.stringify({ t: 'join', code, v: OLD_SIM_VERSION }));
    await host.waitForFunction(() => document.getElementById('net-peer-state')?.textContent.includes('已加入'), null, { timeout: 5000 });
    await host.click('#btn-net-ready');
    oldWs.send(JSON.stringify({ t: 'ready' }));
    await host.waitForTimeout(2500);
    const hostStatus = await host.evaluate(() => document.getElementById('net-status')?.textContent || '');
    const gateMsg = oldMsgs.find(m => m.t === 'error' && (m.text || '').includes('版本不一致'));
    check('C2 混版本就绪被服务器拒绝（旧版客户端收到版本不一致错误）', !!gateMsg,
        gateMsg ? gateMsg.text : '未收到拒绝报文');
    check('C3 房主页同样收到拒绝提示，战斗未启动',
        hostStatus.includes('版本不一致') && await host.evaluate(() => window.UI?.phase !== 'battle'));
    check('C4 服务器未下发 start（双端均停留在就绪前）', !oldMsgs.some(m => m.t === 'start'));
    oldWs.close();
    await host.close();
}

try {
    await netPairTest();
    await speedConsistencyTest();
    await versionGateTest();
} finally {
    await browser.close();
}
console.log(failed === 0 ? '\n锁步/确定性实测全部通过 ✅' : `\n${failed} 项未过 ❌`);
process.exit(failed === 0 ? 0 : 1);
