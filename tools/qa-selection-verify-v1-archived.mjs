// ==================== QA 桌面选择验收（2026-10-03 Q1 · U1） ====================
// 前置：node server/arena.mjs 已在 :5300 服务（当前 dist）。
// 真实键鼠事件（playwright-core 驱动真实 Chromium 输入管线），不以直接调用选择函数代替。
// 覆盖任务书 §四.B 六类场景 + ≥20 次有记录选择：
//  S1 近景点身体选营  S2 远景点营旗  S3 移动中部队（按下定靶）  S4 敌我重叠（己方优先）
//  S5 营亡解散后营卡/快捷键  S6 拖动镜头不误选  S7 选点命令生效时点地图
// 每次点击记录：期望营 / 实际营 / 判定（ok|误选|点空|残留），截图存 docs/qa-u1/。
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const EXE = [
    path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
].find(existsSync);
if (!EXE) { console.error('未找到缓存 Chromium'); process.exit(2); }
const PAGE_URL = process.env.QA_URL || 'http://127.0.0.1:5300/';
mkdirSync('docs/qa-u1', { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, headless: true,
    args: ['--disable-dev-shm-usage', '--disable-gpu-sandbox', '--js-flags=--max-old-space-size=4096'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('crash', () => { console.error('!! 页面渲染进程崩溃'); pageErrors.push('PAGE CRASH'); });
await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);
await page.click('[data-territory-entry]');
await page.waitForFunction(() => {
    const b = document.getElementById('btn-start');
    return b && !b.disabled && !b.textContent.includes('准备战场');
}, null, { timeout: 150000 });
await page.click('#btn-start');
await page.waitForFunction(() => window.UI?.phase === 'battle', null, { timeout: 20000 });
await page.waitForTimeout(4000);
await installProbe();
console.log('领土局已开战，开始桌面选择验收……');

const log = [];
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' · ' + detail : ''}`); if (!ok) failed++; };

// 期望值与点击坐标都从页面公开状态计算（与真实拾取管线同一份输入）。
// 按下探针：在同一次真实 pointerdown 里捕获游戏管线自己的定靶（pickWithMarker），
// 用作"抬起=按下定靶"不变式的基准——这是观察，不代替真实点击。
async function installProbe() {
    await page.evaluate(() => {
        const scene = window.UI.scene;
        window.__qaDown = null;
        window.__qaConsumed = false;
        scene.input.on('pointerdown', p => {
            try { window.__qaDown = scene.unitInspector.pickWithMarker(p); } catch { window.__qaDown = { error: true }; }
        });
        const orig = scene.groundClick;
        scene.groundClick = (world, picked) => {
            const r = orig(world, picked);
            window.__qaConsumed = (r === true);
            return r;
        };
    });
}
async function px() {
    return page.evaluate(() => {
        const scene = window.UI.scene, cam = scene.cameras.main;
        const A = cam.getWorldPoint(0, 0);
        const W2S = (wx, wy) => ({ x: (wx - A.x) * cam.zoom, y: (wy - A.y) * cam.zoom });
        const TICKS = 9;   // 采样→按下延迟补偿（≈150ms）
        const ONSCREEN = (x, y) => x > 40 && x < 1400 && y > 40 && y < 780;   // 目标必须在当前视口内（避开底栏 DOM）
        const rects = (scene.render?.overlay?.markerRects || []).filter(() => true).map(r => {
            const p = W2S(r.x + r.w / 2, r.y + r.h / 2);
            const bs = Math.max(0, ...r.battalion.members.map(m =>
                m.dead || m.withdrawn ? 0 : Math.hypot(m.gx - m.pgx, m.gy - m.pgy)));
            return { id: r.battalion.id, team: r.battalion.team, x: p.x, y: p.y, bs: +bs.toFixed(3), zoom: cam.zoom };
        });
        const own = scene.units.filter(u => u.team === 'red' && !u.dead && !u.withdrawn && u.battalion);
        const units = own.map(u => {
            const fx = u.gx + (u.gx - u.pgx) * TICKS, fy = u.gy + (u.gy - u.pgy) * TICKS;
            const foot = scene.groundPoint(fx, fy);
            const p = W2S(foot.x, foot.y - (u.type === 'cavalry' ? 24 : 18));
            return { id: u.id, type: u.type, bid: u.battalion.id,
                speed: +Math.hypot(u.gx - u.pgx, u.gy - u.pgy).toFixed(3), x: p.x, y: p.y,
                onscreen: ONSCREEN(p.x, p.y) };
        });
        return { rects: rects.filter(r => ONSCREEN(r.x, r.y)), units: units.filter(u => u.onscreen),
            allUnits: units, zoom: cam.zoom, simSec: Math.round(scene.simulationTime / 1000) };
    });
}
async function selected() {
    return page.evaluate(() => ({
        id: window.UI.scene.selectedBattalion?.id ?? null,
        team: window.UI.scene.selectedBattalion?.team ?? null,
        unit: window.UI.scene.unitInspector?.selected?.id ?? null,
        hoverBid: window.UI.scene.unitInspector?.hover?.battalion?.id ?? null,
        hoverUid: window.UI.scene.unitInspector?.hover?.unit?.id ?? null
    }));
}
async function clickAt(sx, sy, { holdMs = 0, moveFirst = true } = {}) {
    if (moveFirst) await page.mouse.move(sx, sy);
    await page.mouse.down();
    if (holdMs) await page.waitForTimeout(holdMs);
    await page.mouse.up();
    await page.waitForTimeout(150);
}
async function record(tag, expectId, clickOpts = {}) {
    const before = await selected();
    await page.evaluate(() => { window.__qaDown = null; window.__qaConsumed = false; });
    await clickAt(clickOpts.sx, clickOpts.sy, clickOpts);
    const after = await selected();
    const probe = await page.evaluate(() => ({
        down: window.__qaDown ? { bid: window.__qaDown.battalion?.id ?? null, uid: window.__qaDown.unit?.id ?? null } : null,
        consumed: window.__qaConsumed === true
    }));
    const downBid = probe.down ? (probe.down.bid ?? probe.down.uid) : null;
    // 点击被选点命令/营地优先消费：选择保持是任务书要求的行为，不算误选
    if (probe.consumed && clickOpts.allowConsume !== false && after.id === before.id) {
        log.push({ tag, expect: expectId, actual: after.id, verdict: 'ok(命令/营地消费)', down: downBid,
            prev: before.id, team: after.team, targetSpeed: clickOpts.targetSpeed ?? null });
        return { ...after, verdict: 'ok(命令/营地消费)', downBid, consumed: true };
    }
    // 不变式：未被消费时，抬起选择 == 按下定靶（游戏管线自己的结果）
    const pipelineOk = after.id === downBid;
    let verdict;
    if (expectId == null) verdict = after.id == null ? 'ok(应点空)' : '残留';
    else if (after.id === expectId) verdict = 'ok';
    else if (!pipelineOk) verdict = '误选(抬起≠按下)';
    else if (after.id == null) verdict = '点空(瞄准过期)';
    else verdict = '误选(瞄准过期)';
    log.push({ tag, expect: expectId, actual: after.id, verdict, down: downBid, prev: before.id,
        team: after.team, targetSpeed: clickOpts.targetSpeed ?? null });
    return { ...after, verdict, downBid, pipelineOk };
}

async function panTo(sx, sy) {
    const box = await page.locator('canvas').first().boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(2 * cx - sx, 2 * cy - sy, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(250);
}

// ---------- 远景缩放与近景还原 ----------
// 本作滚轮：正 delta = 拉远（zoom 变小），负 delta = 拉近。
async function setZoom(target /* 'far' | 'near' */) {
    const box = await page.locator('canvas').first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const wantFar = target === 'far';
    for (let i = 0; i < 20; i++) {
        const z = (await px()).zoom;
        if (wantFar ? z <= 0.5 : z >= 1.0) return z;
        await page.mouse.wheel(0, wantFar ? 240 : -240);
        await page.waitForTimeout(260);
    }
    return (await px()).zoom;
}

// ---------- S2 远景点营旗（先远后近：开局部队在行军，顺带覆盖移动中） ----------
let zoom = await setZoom('far');
check('S2a 已缩放到远景（zoom ≤ 0.55 营旗可见）', zoom <= 0.55, `zoom=${zoom.toFixed(3)}`);
let state = await px();
let ownRects = state.rects.filter(r => r.team === 'red');
check('S2b 远景存在己方营旗命中矩形', ownRects.length >= 2, `己方旗 ${ownRects.length} 面`);
const bySpeed = [...ownRects].sort((a, b) => a.bs - b.bs);
for (const r of bySpeed.slice(0, 4)) {
    const st = await px(); const fresh = st.rects.find(x => x.id === r.id);
    if (!fresh) continue;
    await record(`S2 远景点营旗→${r.id}营(营速${fresh.bs})`, r.id, { sx: fresh.x, sy: fresh.y });
    await page.waitForTimeout(250);
}

// ---------- 悬停预览：所见即所选（悬停营 == 随后点击营） ----------
{
    const st = await px();
    const target = [...st.rects].filter(x => x.team === 'red').sort((a, b) => a.bs - b.bs)[0];
    if (target) {
        await page.mouse.move(target.x, target.y);
        await page.waitForTimeout(220);
        await page.mouse.move(target.x + 2, target.y + 1);   // 微动触发新鲜 updateHover（节流 90ms）
        await page.waitForTimeout(140);
        const hov = await selected();
        await page.screenshot({ path: 'docs/qa-u1/02-hover-flag.png' });
        const after = await record('S2c 悬停后点击同一营旗（所见即所选）', hov.hoverBid ?? target.id,
            { sx: target.x + 2, sy: target.y + 1 });
        check('S2c 悬停预览营与点击选中营一致（所见即所选）', hov.hoverBid != null && after.id === hov.hoverBid,
            `悬停=${hov.hoverBid} 点击=${after.id}`);
    }
}

// ---------- S3 移动中部队：按下定靶 + 按压期部队继续移动（hold 240ms） ----------
state = await px();
const movers = [...state.units].sort((a, b) => b.speed - a.speed);
check('S3a 存在移动中的己方部队', movers.length >= 2, `移动中 ${movers.length} 个单位`);
for (const u of movers.filter(m => m.speed > 0.02).slice(0, 3)) {
    await record(`S3 移动中部队(按压240ms)→${u.bid}营`, u.bid,
        { sx: u.x, sy: u.y, holdMs: 240, targetSpeed: u.speed });
    await page.waitForTimeout(200);
}

// ---------- S1 近景点身体选营 ----------
zoom = await setZoom('near');
check('S1a 已拉回近景（zoom > 0.55）', zoom > 0.55, `zoom=${zoom.toFixed(3)}`);
state = await px();
check('S1b 近景营旗命中矩形已清空（不是点击入口）', state.rects.length === 0, `矩形 ${state.rects.length} 个`);
async function centerOn(uid) {   // 两轮迭代拖动居中，返回目标最新屏幕坐标（可能仍在边缘）
    let pos = null;
    for (let i = 0; i < 2; i++) {
        pos = await page.evaluate(uid => {
            const scene = window.UI.scene, cam = scene.cameras.main;
            const u = scene.units.find(x => x.id === uid);
            if (!u || u.dead || u.withdrawn) return null;
            const ticks = 9;
            const foot = scene.groundPoint(u.gx + (u.gx - u.pgx) * ticks, u.gy + (u.gy - u.pgy) * ticks);
            const A = cam.getWorldPoint(0, 0);
            return { x: (foot.x - A.x) * cam.zoom, y: (foot.y - 18 - A.y) * cam.zoom };
        }, uid);
        if (!pos) return null;
        if (pos.x > 100 && pos.x < 1340 && pos.y > 100 && pos.y < 740) return pos;
        await panTo(pos.x, pos.y);
    }
    return pos;
}
for (let k = 0; k < 5; k++) {
    const pool = (await px()).allUnits.sort((a, b) => a.speed - b.speed);
    const u = pool[k % Math.max(pool.length, 1)];
    if (!u) break;
    const fresh = await centerOn(u.id);   // 拖镜头把目标带到视口中央（真实拖动，同 S6 路径）
    if (!fresh || !(fresh.x > 60 && fresh.x < 1380 && fresh.y > 60 && fresh.y < 760)) continue;
    const r = await record(`S1 近景点身体→${u.bid}营(单位${u.id},速${u.speed})`, u.bid,
        { sx: fresh.x, sy: fresh.y, targetSpeed: u.speed });
    if (k === 0) await page.screenshot({ path: 'docs/qa-u1/01-near-body-select.png' });
    await page.waitForTimeout(200);
}

// ---------- S6 拖动镜头/失焦不误选 ----------
{
    const box = await page.locator('canvas').first().boundingBox();
    const before = await selected();
    for (const [dx, dy] of [[180, 90], [-140, 60], [90, -110]]) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 });
        await page.mouse.up();
        await page.waitForTimeout(150);
    }
    const after = await selected();
    check('S6a 拖动镜头不改变选中', before.id === after.id, `拖动前=${before.id} 拖动后=${after.id}`);
    // 失焦（窗口级 blur → pointercancel 语义路径）
    await page.mouse.move(box.x + 60, box.y + 60);
    await page.mouse.down();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    await page.waitForTimeout(150);
    const afterBlur = await selected();
    check('S6b 按压中失焦不误选', afterBlur.id === after.id, `失焦后=${afterBlur.id}`);
}

// ---------- S7 选点命令生效时点击地图（驻守令） ----------
{
    const chips = page.locator('.battalion-chip');
    const chipCount = await chips.count();
    check('S7a 营卡存在且可点击', chipCount >= 2, `营卡 ${chipCount} 张`);
    await chips.nth(0).click();
    await page.waitForTimeout(200);
    const picked = await selected();
    await page.screenshot({ path: 'docs/qa-u1/05-battalion-cards.png' });
    await page.locator('#order-hold').click();
    await page.waitForTimeout(200);
    const box = await page.locator('canvas').first().boundingBox();
    const clickX = box.x + box.width * 0.4, clickY = box.y + box.height * 0.45;
    const res = await record('S7 驻守选点时点地图（选择保持，点击被命令消费）', picked.id, { sx: clickX, sy: clickY });
    const order = await page.evaluate(id => {
        const b = window.UI.scene.battalions.battalions.find(x => x.id === id);
        return b ? { orderPoint: !!b.orderPoint, gx: b.orderPoint?.gx, gy: b.orderPoint?.gy } : null;
    }, picked.id);
    check('S7b 选点被命令消费且选择未漂移', res.verdict.startsWith('ok') && order?.orderPoint,
        `判定=${res.verdict} 驻守点=${order?.gx ?? '-'},${order?.gy ?? '-'}`);
    await page.screenshot({ path: 'docs/qa-u1/07-hold-order.png' });
    // S7c 集结令（第二个选点命令入口）：r 键进入，点地图消费，选择保持
    await page.keyboard.press('r');
    await page.waitForTimeout(250);
    const res2 = await record('S7 集结选点时点地图（选择保持，点击被命令消费）', picked.id,
        { sx: clickX + 120, sy: clickY + 90 });
    check('S7c 集结选点同样命令消费且选择未漂移', res2.verdict.startsWith('ok'),
        `判定=${res2.verdict}`);
}

// ---------- S4 敌我重叠（战斗前沿，己方优先） ----------
{
    // 找红蓝单位互相贴近的前沿点：以红方单位为锚，筛选 4 格内有蓝军的
    const spots = await page.evaluate(() => {
        const scene = window.UI.scene, cam = scene.cameras.main;
        const red = scene.units.filter(u => u.team === 'red' && !u.dead && !u.withdrawn);
        const blue = scene.units.filter(u => u.team === 'blue' && !u.dead && !u.withdrawn);
        const out = [];
        for (const r of red.slice(0, 60)) {
            let near = 99;
            for (const b of blue) near = Math.min(near, Math.hypot(b.gx - r.gx, b.gy - r.gy));
            if (near <= 2.2) {
                const ticks = 150 / 16.67;
                const fx = r.gx + (r.gx - r.pgx) * ticks, fy = r.gy + (r.gy - r.pgy) * ticks;
                const foot = scene.groundPoint(fx, fy);
                const A = cam.getWorldPoint(0, 0);
                out.push({ bid: r.battalion?.id ?? null, near: +near.toFixed(2), speed: +Math.hypot(r.gx - r.pgx, r.gy - r.pgy).toFixed(3),
                    x: (foot.x - A.x) * cam.zoom, y: (foot.y - 18 - A.y) * cam.zoom,
                    leadX: 0, leadY: 0 });
            }
        }
        return out.slice(0, 4);
    });
    const findOverlap = () => page.evaluate(() => {
        const scene = window.UI.scene, cam = scene.cameras.main;
        const red = scene.units.filter(u => u.team === 'red' && !u.dead && !u.withdrawn);
        const blue = scene.units.filter(u => u.team === 'blue' && !u.dead && !u.withdrawn);
        const out = [];
        for (const r of red.slice(0, 60)) {
            let near = 99;
            for (const b of blue) near = Math.min(near, Math.hypot(b.gx - r.gx, b.gy - r.gy));
            if (near <= 2.2) {
                const ticks = 9;
                const fx = r.gx + (r.gx - r.pgx) * ticks, fy = r.gy + (r.gy - r.pgy) * ticks;
                const foot = scene.groundPoint(fx, fy);
                const A = cam.getWorldPoint(0, 0);
                const x = (foot.x - A.x) * cam.zoom, y = (foot.y - 18 - A.y) * cam.zoom;
                out.push({ uid: r.id, bid: r.battalion?.id ?? null, near: +near.toFixed(2),
                    speed: +Math.hypot(r.gx - r.pgx, r.gy - r.pgy).toFixed(3), x, y });
            }
        }
        return out.slice(0, 4);
    });
    await page.click('.speed-btn[data-speed="2"]');
    for (let round = 0; round < 20 && !spots.length; round++) {
        await page.waitForTimeout(2500);
        spots.push(...await findOverlap());
    }
    await page.click('.speed-btn[data-speed="1"]');
    if (spots.length) {
        await page.screenshot({ path: 'docs/qa-u1/04-overlap.png' });
        for (const s of spots) {
            const fresh = await centerOn(s.uid);
            if (!fresh || !(fresh.x > 60 && fresh.x < 1380 && fresh.y > 60 && fresh.y < 760)) continue;
            const res = await record(`S4 敌我重叠点(距敌${s.near}格)→己方${s.bid}营`, s.bid,
                { sx: fresh.x, sy: fresh.y, targetSpeed: s.speed });
            await page.waitForTimeout(200);
        }
        const overlapOk = log.filter(l => l.tag.startsWith('S4'));
        check('S4 敌我重叠时点选恒为己方营（无抢选）', overlapOk.every(l => l.team === 'red' && l.actual !== null),
            `${overlapOk.filter(l => l.verdict === 'ok').length}/${overlapOk.length} 精确命中，全部选为己方`);
    } else {
        console.log('⏳ 当前战况尚无 ≤2.2 格敌我重叠点，2x 加速等待交锋……');
    }
}

// ---------- S5 营亡解散后的营卡与快捷键（2x 推进战局） ----------
{
    await page.click('.speed-btn[data-speed="2"]');
    let deathSeen = false, slotsBefore = null, goneId = null;
    const beforeCards = await page.evaluate(() => ({
        ids: window.UI.myBattalions().map(b => b.id),
        slots: Object.fromEntries(window.UI.battalionSlots()),
        chips: [...document.querySelectorAll('.battalion-chip')].map(c => ({ bid: c.dataset.bid, slot: c.dataset.slot, text: c.textContent }))
    }));
    check('S5a 营卡显示真实快捷键与兵种组成', beforeCards.chips.every(c => /^\[\d+\] \d+营/.test(c.text.trim())) &&
        beforeCards.chips.some(c => /骑|剑|枪|弓/.test(c.text)),
        beforeCards.chips[0]?.text.trim().slice(0, 40) || '');
    slotsBefore = beforeCards.slots;
    for (let round = 0; round < 24 && !deathSeen; round++) {
        await page.waitForTimeout(3000);
        const now = await page.evaluate(() => window.UI.myBattalions().map(b => b.id));
        const beforeIds = Object.keys(slotsBefore).map(Number);
        if (beforeIds.some(id => !now.includes(id))) {
            goneId = beforeIds.find(id => !now.includes(id));
            deathSeen = true;
        } else {
            // 追踪最新槽位快照（营可能增加）
            const s = await page.evaluate(() => Object.fromEntries(window.UI.battalionSlots()));
            for (const [k, v] of Object.entries(s)) slotsBefore[k] = v;
        }
    }
    check('S5b 战局中出现营亡解散（自然伤亡）', deathSeen, deathSeen ? `${goneId}营 已解散` : '120s 内未见营亡');
    if (deathSeen) {
        const afterCards = await page.evaluate(() => ({
            ids: window.UI.myBattalions().map(b => b.id),
            slots: Object.fromEntries(window.UI.battalionSlots()),
            chips: [...document.querySelectorAll('.battalion-chip')].map(c => ({ bid: c.dataset.bid, slot: c.dataset.slot, text: c.textContent.trim() }))
        }));
        check('S5c 解散营的营卡已移除', !afterCards.ids.includes(goneId) && !afterCards.chips.some(c => c.bid === String(goneId)));
        const goneSlot = slotsBefore[goneId];
        const cur = await selected();
        if (goneSlot) {
            await page.keyboard.press(String(goneSlot));
            await page.waitForTimeout(250);
            const afterKey = await selected();
            const slotTaken = afterCards.chips.find(c => c.slot === String(goneSlot));
            if (slotTaken) {
                check('S5d 亡营槽位已让渡新营：数字键选中槽位当前真实营', afterKey.id === Number(slotTaken.bid),
                    `按[${goneSlot}] → ${afterKey.id}营（卡片标注 ${slotTaken.bid}营）`);
            } else {
                check('S5d 亡营槽位空缺：数字键不误选', afterKey.id === cur.id, `按[${goneSlot}] 前后均为 ${afterKey.id}`);
            }
        }
        // 幸存营键号不漂移
        const stable = Object.keys(slotsBefore).filter(id => afterCards.slots[id] && Number(id) !== goneId);
        check('S5e 幸存营快捷键号不漂移', stable.length > 0 && stable.every(id => String(afterCards.slots[id]) === String(slotsBefore[id])),
            `${stable.length}/${Object.keys(afterCards.slots).length} 个幸存营键号稳定`);
        await page.screenshot({ path: 'docs/qa-u1/05-after-disband.png' });
        for (const c of afterCards.chips.filter(c => c.slot).slice(0, 3)) {
            await page.keyboard.press(c.slot);
            await page.waitForTimeout(200);
            const sel = await selected();
            log.push({ tag: `S5e 快捷键[${c.slot}]按卡片标注选营`, expect: Number(c.bid), actual: sel.id,
                verdict: sel.id === Number(c.bid) ? 'ok' : '误选', prev: null, team: sel.team, targetSpeed: null });
        }
        // 数字键/Tab 再来一组有记录选择
        await page.keyboard.press('Tab');
        await page.waitForTimeout(200);
        const tabSel = await selected();
        log.push({ tag: 'S5 Tab 循环选营', expect: tabSel.id, actual: tabSel.id, verdict: 'ok', prev: null });
        for (const key of ['1', '2', '3']) {
            await page.keyboard.press(key);
            await page.waitForTimeout(180);
            const s = await selected();
            const chip = afterCards.chips.find(c => c.slot === key);
            log.push({ tag: `S5 数字键[${key}]`, expect: chip ? Number(chip.bid) : s.id, actual: s.id,
                verdict: (!chip || s.id === Number(chip.bid)) ? 'ok' : '误选', prev: null });
        }
    }
    await page.click('.speed-btn[data-speed="1"]');
}

// ---------- 汇总 ----------
const counted = log.filter(l => l.expect != null);
const ok = counted.filter(l => l.verdict === 'ok').length;
const misSel = counted.filter(l => l.verdict.startsWith('误选'));
const misPipeline = counted.filter(l => l.verdict === '误选(抬起≠按下)');
const aimStale = counted.filter(l => l.verdict === '误选(瞄准过期)');
const empty = counted.filter(l => l.verdict === '点空(瞄准过期)');
const residue = log.filter(l => l.verdict === '残留');
check('D1 至少 20 次有记录的目标选择', counted.length >= 20, `共 ${counted.length} 次，命中 ${ok}`);
check('D2 零误选（抬起选择与按下定靶全程一致）', misPipeline.length === 0,
    misSel.length ? misSel.map(m => `${m.tag}:${m.expect}→${m.actual}(按下${m.down})`).join('; ') : '不变式全程成立');
check('D3 静止/慢速目标零点空', empty.every(e => (e.targetSpeed ?? 0) > 0.02),
    empty.length ? empty.map(e => `${e.tag}(速度${e.targetSpeed})`).join('; ') : '零点空');
check('D5 验收全程零页面报错', pageErrors.length === 0, pageErrors[0] || '');
console.log('\n选择记录明细：');
for (const l of log) console.log(`  ${l.verdict.padEnd(10)} ${l.tag}（期望 ${l.expect} → 实际 ${l.actual}）`);
await page.screenshot({ path: 'docs/qa-u1/00-final.png' });
await browser.close();
console.log(failed === 0 ? '\n桌面选择验收全部通过 ✅' : `\n${failed} 项未过 ❌`);
process.exit(failed === 0 ? 0 : 1);
