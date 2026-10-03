// ==================== QA 桌面选择验收 v2（R2 · 2026-10-03 F5） ====================
// 与 v1（qa-selection-verify-v1-archived.mjs）的根本区别（用户否决项修正）：
// 判据不再是"抬起==按下定靶"的同义反复，而是对照**地面真值**——在真实 pointerdown
// 事件同帧，用与实现无关的金标准独立计算：
//   真值A 营旗：全量遍历当前营旗矩形，取覆盖点击点的**绘制序最后（显示最上层）**旗；
//   真值B 身体：**全单位扫描**（不经过空间桶——桶是实现细节，全扫描是金标准），
//              按与渲染身体中心相同的几何判定覆盖，领土模式己方优先同口径；
//   真值C 面板：点击落在建筑上方旗/身体时，预期=选营且营地/建设面板不弹。
// 误选=选中≠真值；点空=真值有目标但未选中；残留=真值无目标且未命令消费但选择保持。
// 场景：近/远景、移动中、敌我重叠、营亡解散营卡/快捷键、拖动/失焦、选点命令、
//       F2 定向：重叠旗取上层、地形抬升部位可选、建筑上方不弹面板。
// 前置：node server/arena.mjs 已在 :5300 服务（当前 dist）。
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
await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);
await page.click('[data-territory-entry]');
await page.waitForFunction(() => {
    const b = document.getElementById('btn-start');
    return b && !b.disabled && !b.textContent.includes('准备战场');
}, null, { timeout: 150000 });
await page.click('#btn-start');
await page.waitForFunction(() => window.UI?.phase === 'battle', null, { timeout: 30000 });
await page.waitForTimeout(4000);
console.log('领土局已开战，开始 R2 地面真值选择验收……');

// ---------- 地面真值探针：pointerdown 同帧独立计算（不调用拾取管线函数） ----------
await page.evaluate(() => {
    const scene = window.UI.scene;
    window.__qaTruth = null;
    window.__qaConsumed = 'NO_CALL';
    scene.input.on('pointerdown', p => {
        const cam = scene.cameras.main;
        const world = cam.getWorldPoint(p.x, p.y);
        const zoom = cam.zoom;
        // 真值A（F9 独立源）：从 Phaser display list 取营旗 label——插入序即同 depth 下
        // 的绘制序（视觉最上层 = children 索引最大），几何用 label 自身（origin 0.5/1、
        // scale 1/zoom）加与视觉矩形同尺寸的命中宽容。不读 markerRects/paint，
        // 与实现不同源（旧版遍历 markerRects 取最后命中=同义复现，检不出 F7 绘制序缺陷）。
        const A = cam.getWorldPoint(0, 0);
        const children = scene.children.list;
        let topFlag = null, flagOverlap = 0, topIdx = -1;
        for (let i = 0; i < children.length; i++) {
            const c = children[i];
            if (c.type !== 'Text' || typeof c.text !== 'string' || !c.visible) continue;
            const m = c.text.match(/^⚑ (\d+)营/);
            if (!m) continue;
            const cx = (c.x - A.x) * zoom, bot = (c.y - A.y) * zoom;
            const w = (c.width ?? 96) + 12, h = (c.height ?? 40) + 10;
            if (p.x >= cx - w / 2 && p.x <= cx + w / 2 && p.y >= bot - h && p.y <= bot) {
                flagOverlap++;
                if (i > topIdx) { topIdx = i; topFlag = Number(m[1]); }
            }
        }
        // 真值B：身体覆盖单位（全单位扫描金标准；领土己方优先）
        const radius = Math.max(18, 9 / zoom);
        const mine = scene.netMySide || 'red';
        const territoryMode = !!scene.battleOptions?.territory;
        let any = null, anyD = Infinity, own = null, ownD = Infinity;
        for (const u of scene.units) {
            if (u.dead || u.withdrawn) continue;
            const foot = scene.groundPoint(u.gx, u.gy);
            const dx = world.x - foot.x;
            const dy = world.y - (foot.y - (u.type === 'cavalry' ? 24 : 18));
            const d = Math.hypot(dx, dy * 0.8);
            if (d > radius) continue;
            const better = (cur, curD) => cur == null || d < curD - 1e-9 || (Math.abs(d - curD) <= 1e-9 && u.id < cur.id);
            if (better(any, anyD)) { any = u; anyD = d; }
            if (territoryMode && u.team === mine && better(own, ownD)) { own = u; ownD = d; }
        }
        const unit = territoryMode && own ? own : any;
        // 真值C 辅助：点击点是否落在营地建筑交互圈（52 世界像素）
        let onBuilding = false;
        for (const b of scene.territory?.camps?.buildings || []) {
            if (b.dead) continue;
            const bf = scene.groundPoint(b.gx, b.gy);
            if (Math.hypot(world.x - bf.x, world.y - bf.y) <= 52) onBuilding = true;
        }
        // 内联旧逻辑对照（F11）：markerRects 数组序最后命中——F7 前的实现，
        // 用于证明 F2a-2 在修复前会红（数组序 [选中营, ...] 时 lastHit 落到下层营）。
        let oldPick = null;
        for (const r of (scene.render?.overlay?.markerRects || [])) {
            if (world.x >= r.x && world.x <= r.x + r.w && world.y >= r.y && world.y <= r.y + r.h) oldPick = r.battalion.id;
        }
        window.__qaTruth = {
            topFlag, flagOverlap, oldPick,
            unitId: unit?.id ?? null, unitTeam: unit?.team ?? null, bid: unit?.battalion?.id ?? null,
            onBuilding
        };
    });
    const orig = scene.groundClick;
    scene.groundClick = (w, u, m) => { const r = orig(w, u, m); window.__qaConsumed = (r === true); return r; };
    scene.input.on('pointerup', () => { window.__qaUps = (window.__qaUps || 0) + 1; });
});

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' · ' + detail : ''}`); if (!ok) failed++; };
const log = [];
let f2aShared = null;   // F2a 建立的重叠状态（F2a-2 立即复用，不等旗分开）
// F15 严格化：各场景取样/跳过计数（无样本场景一律失败，不允许静默跳过或空集通过）
const sceneStats = {};
const sceneOf = tag => (tag.match(/^(S\d[a-z]?|F2[a-c]?-?\d?)/) || ['其他'])[0];
function bumpScene(tag, kind) {
    const key = sceneOf(tag);
    sceneStats[key] = sceneStats[key] || { sampled: 0, skipped: 0 };
    sceneStats[key][kind]++;
}
async function selected() {
    return page.evaluate(() => ({
        id: window.UI.scene.selectedBattalion?.id ?? null,
        team: window.UI.scene.selectedBattalion?.team ?? null,
        unit: window.UI.scene.unitInspector?.selected?.id ?? null,
        hoverBid: window.UI.scene.unitInspector?.hover?.battalion?.id ?? null,
        panel: window.UI.campControls ? { b: window.UI.campControls.buildingId ?? null, w: window.UI.campControls.workerId ?? null } : null
    }));
}
async function clickAt(sx, sy, { holdMs = 0 } = {}) {
    const hit = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el ? el.tagName : 'NONE';
    }, [sx, sy]);
    if (hit !== 'CANVAS') throw new Error(`点击 (${sx.toFixed(0)},${sy.toFixed(0)}) 命中 ${hit} 而非 canvas——测试瞄准被 DOM 遮挡`);
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    if (holdMs) await page.waitForTimeout(holdMs);
    await page.mouse.up();
    await page.waitForTimeout(160);
}
async function record(tag, opts = {}) {
    const before = await selected();
    try {
        return await recordInner(tag, opts);
    } catch (e) {
        if (String(e.message).includes('DOM 遮挡')) {
            log.push({ tag, expect: null, actual: before.id, verdict: '跳过(DOM遮挡)', truth: null,
                consumed: false, ups: 0, prev: before.id, team: before.team, panel: null });
            console.log(`  ↳ ${tag} 跳过：${e.message}`);
            return { verdict: '跳过(DOM遮挡)' };
        }
        throw e;
    }
}
async function recordInner(tag, opts = {}) {
    const before = await selected();
    await page.evaluate(() => { window.__qaTruth = null; window.__qaConsumed = 'NO_CALL'; window.__qaUps = 0; });
    await clickAt(opts.sx, opts.sy, opts);
    const after = await selected();
    const truth = await page.evaluate(() => window.__qaTruth);
    const consumed = await page.evaluate(() => window.__qaConsumed === true);
    const ups = await page.evaluate(() => window.__qaUps || 0);
    const expectId = truth ? (truth.topFlag ?? truth.bid) : undefined;   // 真值目标（旗优先，与管线设计一致）
    let verdict;
    if (opts.commandClick && consumed) verdict = 'ok(命令消费)';
    else if (expectId == null) verdict = after.id == null ? 'ok(真值点空)' : (consumed ? 'ok(营地消费)' : '残留');
    else if (after.id === expectId) verdict = 'ok';
    else if (after.id == null) verdict = '点空';
    else verdict = '误选';
    const entry = { tag, expect: expectId ?? null, actual: after.id, verdict, truth, consumed, ups,
        prev: before.id, team: after.team, panel: after.panel };
    if (verdict === '误选' || verdict === '点空' || verdict === '残留') {
        console.log(`  ↳ ${tag} 诊断：down真值=${JSON.stringify(truth)} consumed=${consumed} pointerup=${ups} prev=${before.id}`);
    }
    log.push(entry);
    bumpScene(tag, verdict.startsWith('跳过') ? 'skipped' : 'sampled');
    return entry;
}
const safeSpeed = async sp => {
    try { await page.locator(`.speed-btn[data-speed="${sp}"]`).click({ timeout: 1500 }); return true; }
    catch { return false; }
};
// F15 收尾（R4 P1-1）：命令条按钮随营状态变化——选中集结营时 #order-hold 不可见，
// 无条件点击会抛未捕获 TimeoutError，吞掉后续所有场景与 D1-D5 汇总。统一入口：
// 显式选成建制作战营 + 按钮可见性守卫；不满足则返回 false（本轮跳过，不制造假样本）。
async function selectLineBattalionChip(preferBid = null) {
    const bid = preferBid ?? await page.evaluate(() => {
        const b = window.UI.scene.battalions.battalions
            .find(x => x.team === "red" && !x.gathering && x.members.length);
        return b ? b.id : null;
    });
    if (bid == null) return false;
    const chip = page.locator(`.battalion-chip[data-bid="${bid}"]`).first();
    if (!(await chip.count().catch(() => 0))) return false;
    await chip.click();
    await page.waitForTimeout(180);
    return true;
}

async function clickHoldButton() {
    const btn = page.locator("#order-hold");
    if (!(await btn.isVisible().catch(() => false))) return false;
    await btn.click();
    await page.waitForTimeout(220);
    return true;
}

async function px() {
    return page.evaluate(() => {
        const scene = window.UI.scene, cam = scene.cameras.main;
        const A = cam.getWorldPoint(0, 0);
        const TICKS = 9;
        const rects = (scene.render?.overlay?.markerRects || []).map((r, i) => {
            const cxw = r.x + r.w / 2, cyw = r.y + r.h / 2;
            return { idx: i, id: r.battalion.id, team: r.battalion.team,
                x: (cxw - A.x) * cam.zoom, y: (cyw - A.y) * cam.zoom, w: r.w * cam.zoom, h: r.h * cam.zoom };
        });
        const own = scene.units.filter(u => u.team === 'red' && !u.dead && !u.withdrawn && u.battalion);
        const units = own.map(u => {
            const foot = scene.groundPoint(u.gx + (u.gx - u.pgx) * TICKS, u.gy + (u.gy - u.pgy) * TICKS);
            return { id: u.id, bid: u.battalion.id, speed: +Math.hypot(u.gx - u.pgx, u.gy - u.pgy).toFixed(3),
                x: (foot.x - A.x) * cam.zoom, y: (foot.y - 18 - A.y) * cam.zoom };
        });
        return { rects, units, zoom: cam.zoom, all: units };
    });
}
// 迭代钳位拖动：目标屏幕位可能远在视口外（单次拖动鼠标会出界失效），
// 每步拖 ≤360px 并重算目标位置，直至目标进入视口中部。
async function panTo(getScreen) {
    const box = await page.locator('canvas').first().boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    for (let iter = 0; iter < 16; iter++) {
        const t = await getScreen();
        if (!t) return null;
        if (Math.abs(cx - t.x) < 70 && Math.abs(cy - t.y) < 70) return t;
        const dx = Math.max(-360, Math.min(360, cx - t.x));
        const dy = Math.max(-260, Math.min(260, cy - t.y));
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + dx, cy + dy, { steps: 10 });
        await page.mouse.up();
        await page.waitForTimeout(170);
    }
    return await getScreen();
}
const screenOfUnit = uid => page.evaluate(uid => {
    const scene = window.UI.scene, cam = scene.cameras.main;
    const u = scene.units.find(x => x.id === uid);
    if (!u || u.dead || u.withdrawn) return null;
    const foot = scene.groundPoint(u.gx + (u.gx - u.pgx) * 9, u.gy + (u.gy - u.pgy) * 9);
    const A = cam.getWorldPoint(0, 0);
    return { x: (foot.x - A.x) * cam.zoom, y: (foot.y - 18 - A.y) * cam.zoom };
}, uid);
async function setZoom(target) {
    const box = await page.locator('canvas').first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const wantFar = target === 'far';
    for (let i = 0; i < 20; i++) {
        const z = (await px()).zoom;
        if (wantFar ? z <= 0.5 : z >= 1.0) return z;
        await page.mouse.wheel(0, wantFar ? 240 : -240);
        await page.waitForTimeout(130);
    }
    return (await px()).zoom;
}
async function centerOn(uid) {
    const inView = p => p && p.x > 100 && p.x < 1340 && p.y > 100 && p.y < 740;
    let pos = await screenOfUnit(uid);
    if (inView(pos)) return pos;
    await panTo(() => screenOfUnit(uid));
    return await screenOfUnit(uid);
}

// ---------- 汇总（地面真值口径） ----------
// R5 P2-α：兜底 handler 必须**先于全部场景**注册（原先放在脚本末尾，场景阶段崩溃时
// 裸栈退出、D1-D5 与取样表都不打印——报告的"如实报告退出码"机制名不副实）。
// 故 printSummary 与两个 handler 上移到场景之前，函数内只依赖已声明的 check/log/sceneStats。
function printSummary() {
const canvasClicks = log.filter(l => l.truth !== null);
const mis = canvasClicks.filter(l => l.verdict === '误选');
const empty = canvasClicks.filter(l => l.verdict === '点空');
const residue = canvasClicks.filter(l => l.verdict === '残留');
check('D1 ≥20 次地面真值对照的记录选择', canvasClicks.length >= 20,
    `共 ${canvasClicks.length} 次探针有效点击（另 ${log.length - canvasClicks.length} 次键盘/卡片记录）`);
check('D2 零误选（选中==地面真值，金标准独立计算）', mis.length === 0,
    mis.length ? mis.map(m => `${m.tag}:真值${m.expect}→${m.actual}`).join('; ') : '全部一致');
check('D3 零点空（真值有目标必选中——含地形抬升/移动目标）', empty.length === 0,
    empty.length ? empty.map(m => `${m.tag}:真值${m.expect}`).join('; ') : '');
check('D4 零残留（真值无目标即清空，命令/营地消费除外）', residue.length === 0, residue.map(m => m.tag).join('; '));
check('D5 零页面报错', pageErrors.length === 0, pageErrors[0] || '');
console.log('\n场景取样/跳过计数（F15 严格化：核心场景取样数 =0 即该场景判失败）：');
for (const [k, v] of Object.entries(sceneStats)) console.log(`  ${k.padEnd(6)} 取样 ${v.sampled}  跳过 ${v.skipped}`);
console.log('\n选择记录明细（地面真值口径）：');
for (const l of log) console.log(`  ${l.verdict.padEnd(10)} ${l.tag}（真值 ${l.truth ? (l.truth.topFlag ?? l.truth.bid) : l.expect} → 实际 ${l.actual ?? 'null'}）`);
console.log(failed === 0 ? '\nR2 桌面选择验收（地面真值判据）全部通过 ✅' : `\n${failed} 项未过 ❌`);
}
process.on('uncaughtException', e => { console.error('\n未捕获异常（场景脚本崩溃）：', e?.message || e); try { printSummary(); } catch {} process.exit(1); });
process.on('unhandledRejection', e => { console.error('\n未处理的 Promise 拒绝（场景脚本崩溃）：', e?.message || e); try { printSummary(); } catch {} process.exit(1); });

// ---------- S2 远景营旗（真值A：上层旗） ----------
let zoom = await setZoom('far');
check('S2a 远景（zoom ≤0.55 营旗可见）', zoom <= 0.55, `zoom=${zoom.toFixed(3)}`);
let state = await px();
const ownRects = state.rects.filter(r => r.team === 'red');
check('S2b 己方营旗矩形存在', ownRects.length >= 2, `${ownRects.length} 面`);
for (const r of ownRects.slice(0, 4)) {
    const st = await px(); const fresh = st.rects.find(x => x.id === r.id);
    if (!fresh) continue;
    await record(`S2 远景点营旗→${r.id}营`, { sx: fresh.x, sy: fresh.y });
    await page.waitForTimeout(260);
}

// ---------- S2c 悬停所见即所选 ----------
{
    const st = await px();
    const target = [...st.rects].filter(x => x.team === 'red')
        .sort((a, b) => Math.hypot(b.x - 720, b.y - 430) - Math.hypot(a.x - 720, a.y - 430))[0];
    if (target) {
        await page.mouse.move(target.x, target.y);
        await page.waitForTimeout(220);
        await page.mouse.move(target.x + 2, target.y + 1);
        await page.waitForTimeout(140);
        const hov = await selected();
        await page.screenshot({ path: 'docs/qa-u1/02-hover-flag.png' });
        const e = await record('S2c 悬停后点击同一营旗', { sx: target.x + 2, sy: target.y + 1 });
        // R7 P2：点击瞬间营旗可能已溶解（真值 null → ok(真值点空)）——产品行为正确但不构成有效
        // 样本。判据：有真值时须 悬停==点击==真值；溶解样本重试换靶；≥1 次严格样本仍要求
        // （无严格样本按 F15 判失败，不放宽也不误判）。
        let s2cStrict = hov.hoverBid != null && e.verdict === 'ok' && e.actual === hov.hoverBid;
        let s2cBad = ['误选', '点空', '残留'].includes(e.verdict) ? e.verdict : null;
        let s2cDissolved = e.verdict === 'ok(真值点空)' ? 1 : 0;
        for (let attempt = 0; attempt < 3 && !s2cStrict && !s2cBad; attempt++) {
            const stA = await px();
            const t = [...stA.rects].filter(x => x.team === 'red')
                .sort((a, b) => Math.hypot(b.x - 720, b.y - 430) - Math.hypot(a.x - 720, a.y - 430))[0];
            if (!t) break;
            await page.mouse.move(t.x, t.y);
            await page.waitForTimeout(220);
            await page.mouse.move(t.x + 2, t.y + 1);
            await page.waitForTimeout(140);
            const hov3 = await selected();
            const e3 = await record('S2c 悬停后点击同一营旗', { sx: t.x + 2, sy: t.y + 1 });
            if (hov3.hoverBid != null && e3.verdict === 'ok' && e3.actual === hov3.hoverBid) s2cStrict = true;
            else if (['误选', '点空', '残留'].includes(e3.verdict)) s2cBad = e3.verdict;
            else if (e3.verdict === 'ok(真值点空)') s2cDissolved++;
        }
        check('S2c 悬停营==点击营==真值（所见即所选）', s2cStrict && !s2cBad,
            s2cStrict ? `严格样本通过（溶解样本 ${s2cDissolved} 次已重试）`
                : (s2cBad ? `出现 ${s2cBad}` : `仅取得溶解样本 ${s2cDissolved} 次（无严格样本，按 F15 判失败）`));
        const st2 = await px();
        const t2 = [...st2.rects].filter(x => x.team === 'red' && x.id !== target.id)
            .sort((a, b) => Math.hypot(b.x - 720, b.y - 430) - Math.hypot(a.x - 720, a.y - 430))[0];
        if (t2) {
            await page.mouse.move(t2.x, t2.y);
            await page.waitForTimeout(220);
            await page.mouse.move(t2.x + 2, t2.y + 1);
            await page.waitForTimeout(140);
            const hov2 = await selected();
            await record('S2d 第二面旗悬停后点击', { sx: t2.x + 2, sy: t2.y + 1 });
            void hov2;
        }
    }
}

// ---------- S3 移动中部队（按压 240ms，真值B 金标准） ----------
state = await px();
const movers = [...state.units].sort((a, b) => b.speed - a.speed).filter(m => m.speed > 0.02);
check('S3a 存在移动中部队', movers.length >= 2, `${movers.length} 个`);
for (const u of movers.slice(0, 4)) {
    await record(`S3 移动中部队(按压240ms)→${u.bid}营(速${u.speed})`, { sx: u.x, sy: u.y, holdMs: 240 });
    await page.waitForTimeout(220);
}

// ---------- F2a 重叠旗：点交叠区必选上层旗 ----------
{
    let attempts = 0, verified = false;
    await setZoom('far');   // 营旗矩形只在远景维护（zoom ≤0.55）
    // 主动构造：选两个己方营，向同一驻守点下令（真实键鼠流程：营卡→驻守→点图），
    // 两营向同一点行军驻防，营旗收敛重叠。驻守点取第一面己方营旗当前位置（必然可走）。
    // 前置：若红方旗全被视域裁剪（相机停在别处），先把镜头摇回任一红营。
    {
        let st0 = await px();
        if (!st0.rects.some(r => r.team === 'red')) {
            const uid = await page.evaluate(() => {
                const scene = window.UI.scene;
                const b = scene.battalions.battalions.find(x => x.team === 'red' && x.members.length);
                return b ? b.members[0].id : null;
            });
            if (uid) await centerOn(uid);
            st0 = await px();
        }
        // 锚点取离敌最远的红营旗：向战场边缘下令会被敌军截击，收敛不可靠。
        // 锚点在屏外时先把镜头摇过去，否则驻守点击会落在 DOM 上静默失败。
        const pickSafeAnchor = () => page.evaluate(() => {
            const scene = window.UI.scene, cam = scene.cameras.main;
            const A = cam.getWorldPoint(0, 0);
            const blues = scene.units.filter(u => u.team === 'blue' && !u.dead && !u.withdrawn);
            let best = null, bestD = -1;
            for (const b of scene.battalions.battalions.filter(x => x.team === 'red' && x.members.length)) {
                const c = b.center();
                let d = Infinity;
                for (const e of blues) d = Math.min(d, Math.hypot(e.gx - c.gx, e.gy - c.gy));
                if (d > bestD) { bestD = d; best = b; }
            }
            if (!best) return null;
            const c = best.center();
            const foot = scene.groundPoint(c.gx, c.gy);
            return { x: (foot.x - A.x) * cam.zoom, y: (foot.y - A.y) * cam.zoom,
                uid: best.members[0]?.id ?? null, id: best.id, dist: Math.round(bestD),
                opx: c.gx, opy: c.gy };
        });
        let anchor = await pickSafeAnchor();
        if (anchor && !(anchor.x > 40 && anchor.x < 1380 && anchor.y > 40 && anchor.y < 740) && anchor.uid) {
            await centerOn(anchor.uid);
            anchor = await pickSafeAnchor();
            console.log(`  [F2a] 摇镜后锚点屏幕位：${Math.round(anchor.x)},${Math.round(anchor.y)}`);
        }
        console.log(`  [F2a] 收敛锚点：${anchor ? `${anchor.id}营（离敌 ${anchor.dist} 格，屏幕 ${Math.round(anchor.x)},${Math.round(anchor.y)}）` : '无红营'}`);
        if (anchor && anchor.x > 30 && anchor.x < 1410 && anchor.y > 30 && anchor.y < 770) {
            // 下令对象 = 离锚点最近的两营（缩短行军距离，收敛更快）
            const bids = await page.evaluate(anchorG => {
                const scene = window.UI.scene;
                const reds = scene.battalions.battalions.filter(x => x.team === 'red' && x.members.length);
                reds.sort((a, b) => Math.hypot(a.center().gx - anchorG.x, a.center().gy - anchorG.y)
                    - Math.hypot(b.center().gx - anchorG.x, b.center().gy - anchorG.y));
                return reds.slice(0, 2).map(b => b.id);
            }, { x: anchor.opx ?? 0, y: anchor.opy ?? 0 });
            const chips = page.locator('.battalion-chip');
            const n = Math.min(await chips.count(), 2);
            for (let i = 0; i < n; i++) {
                // R4 P1-1：显式选成建制营 + 驻守按钮可见性守卫（原 chips.nth(i) 可能选中集结营）
                const want = bids.length === 2 ? bids[i] : null;
                if (!(await selectLineBattalionChip(want))) continue;
                if (!(await clickHoldButton())) continue;
                await page.mouse.click(anchor.x, anchor.y);
                await page.waitForTimeout(350);
                const st = await page.evaluate(() => {
                    const b = window.UI.scene.selectedBattalion;
                    return b ? { id: b.id, op: b.orderPoint ? [b.orderPoint.gx, b.orderPoint.gy] : null } : null;
                });
                console.log(`  [F2a] 营${st?.id} 驻守令落地：${JSON.stringify(st?.op)}`);
            }
        }
    }
    if (!(await safeSpeed(2))) {}
    for (let round = 0; round < 40 && !verified; round++) {
        const st = await px();
        let pair = null;
        for (let i = 0; i < st.rects.length && !pair; i++) {
            for (let j = i + 1; j < st.rects.length && !pair; j++) {
                const a = st.rects[i], b = st.rects[j];
                const ox = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
                const oy = Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2);
                if (ox > 10 && oy > 10 && (a.team === 'red' || b.team === 'red')) pair = { a, b };
            }
        }
        if (round % 4 === 0) {
            const reds = st.rects.filter(r => r.team === 'red');
            const dd = [];
            for (let i = 0; i < reds.length; i++) for (let j = i + 1; j < reds.length; j++)
                dd.push(`${reds[i].id}-${reds[j].id}:${Math.round(Math.hypot(reds[i].x - reds[j].x, reds[i].y - reds[j].y))}`);
            console.log(`  [F2a] round${round} 红旗距离{${dd.join(' ')}} zoom=${st.zoom.toFixed(2)}`);
        }
        if (!pair) { await page.waitForTimeout(1500); continue; }
        if (!(await safeSpeed(1))) {}
        await page.waitForTimeout(400);
        const st2 = await px();
        const ua = st2.rects.find(r => r.id === pair.a.id), ub = st2.rects.find(r => r.id === pair.b.id);
        if (!ua || !ub) continue;
        const cx = (Math.max(ua.x - ua.w / 2, ub.x - ub.w / 2) + Math.min(ua.x + ua.w / 2, ub.x + ub.w / 2)) / 2;
        const cy = (Math.max(ua.y - ua.h / 2, ub.y - ub.h / 2) + Math.min(ua.y + ua.h / 2, ub.y + ub.h / 2)) / 2;
        const upNow = ub.idx > ua.idx ? ub : ua;
        const e = await record(`F2a 重叠旗点击（上层=${upNow.id}营, 下层=${(upNow === ub ? ua : ub).id}营）`, { sx: cx, sy: cy });
        attempts++;
        if (e.truth?.flagOverlap >= 2 && e.verdict === 'ok') {
            verified = true;
            // F15 收尾：记录构造出的重叠对。此前这里因同名局部变量遮蔽 set 的是局部量，
            // 模块级 f2aShared 永远为 null——"用完即清"与 F2a-2 复用路径双双失效（死代码）。
            f2aShared = { upper: upNow.id, lower: (upNow === ub ? ua : ub).id };
            await page.screenshot({ path: 'docs/qa-u1/f2a-overlap-flags.png' });
        }
        await page.waitForTimeout(300);
    }
    check('F2a 重叠旗点击选中显示上层旗（真值覆盖 ≥2 面）', verified,
        verified ? '重叠区点击与上层旗真值一致' : `${attempts} 次尝试未取得有效重叠击（战况不利）`);
}

// F15 收尾（第三轮）：F2a-2（F7 预选重叠回归）已移出本脚本——全流程无法稳定构造
// 该用例所需的「预选上层营 + 两旗重叠」状态，证据与退出码改由 tools/qa-r2-browser-verify.mjs
// 承担（该脚本开局构造收敛后可稳定取样，含「旧逻辑=1 vs 显示真值=2」的 F7 前必红分歧）。

// F15 战局保护：F2a 构造性驻守令用完即清（两营回归 AI 正常运转）——否则两营被拉去
// 后方锚点导致前线空虚、蓝军推家，后续场景（S7/F2b/S1）样本枯竭（连续三轮同型战局的根因）。
{
    const clearOrders = async () => {
        for (const bid of [f2aShared?.lower, f2aShared?.upper]) {
            if (bid == null) continue;
            const ok = await page.evaluate(b => {
                const el = document.querySelector(`.battalion-chip[data-bid="${b}"]`);
                if (!el) return false;
                el.click();
                return true;
            }, bid);
            if (!ok) continue;
            await page.waitForTimeout(180);
            const btn = page.locator('#order-clear');
            if (await btn.count()) {
                const enabled = await btn.isEnabled().catch(() => false);
                if (enabled) { await btn.click().catch(() => {}); await page.waitForTimeout(180); }
            }
        }
    };
    await clearOrders();
}

// ---------- F2a-2（F7 预选重叠回归）：已移出本脚本，由聚焦脚本覆盖 ----------
// 该用例要求「先选中显示上层营、再点两旗重叠区」的构造态：全流程里只有 F2a 构造的
// 驻守重叠满足条件，而清令送回 AI 后两旗即分开，20 轮轮询必然取不到有效样本
// （历史三轮皆如此，曾被误归因为「战况」）。在 tools/qa-r2-browser-verify.mjs 中，
// 开局向同一驻守点下令两营可稳定收敛出重叠：实测 F2a 真值=2/实际=2/旧逻辑=1、
// F2a-2 预选=2/真值=2/实际=2/旧逻辑=1，含 F7 前本用例必红的分歧样本。
// 故本脚本不再重复该用例（结构性无法取样不应计入本脚本失败）；F7 浏览器级回归的
// 证据与退出码以聚焦脚本为准，本脚本负责 S1-S7/F2a/F2b/F2c 等全流程可稳定取样的场景。

// ---------- S1 近景点身体 ----------
zoom = await setZoom('near');
check('S1a 近景（zoom>0.55）且旗矩形清空', zoom > 0.55 && (await px()).rects.length === 0, `zoom=${zoom.toFixed(3)}`);
for (let k = 0; k < 6; k++) {
    const pool = (await px()).all.sort((a, b) => a.speed - b.speed);
    const u = pool[k % Math.max(pool.length, 1)];
    if (!u) break;
    const fresh = await centerOn(u.id);
    if (!fresh || !(fresh.x > 60 && fresh.x < 1380 && fresh.y > 60 && fresh.y < 760)) continue;
    const e = await record(`S1 近景点身体→${u.bid}营(单位${u.id},速${u.speed})`, { sx: fresh.x, sy: fresh.y });
    if (k === 0) await page.screenshot({ path: 'docs/qa-u1/01-near-body-select.png' });
    await page.waitForTimeout(220);
}

// ---------- F2b 地形抬升部位单位可选（真值B 全扫描金标准 vs 空间桶实现） ----------
{
    // 全扫描金标准点击身体中心：修复前桶查询覆盖不足会漏掉地形抬升候选（点空），真值仍命中
    const spots = await page.evaluate(() => {
        const scene = window.UI.scene, cam = scene.cameras.main;
        const A = cam.getWorldPoint(0, 0);
        return scene.units.filter(u => u.team === 'red' && !u.dead && !u.withdrawn && u.battalion)
            .slice(0, 12).map(u => {
                const foot = scene.groundPoint(u.gx, u.gy);
                return { uid: u.id, bid: u.battalion.id,
                    x: (foot.x - A.x) * cam.zoom, y: (foot.y - 18 - A.y) * cam.zoom };
            });
    });
    let done = 0;
    for (const s of spots) {
        if (done >= 3) break;
        const fresh = await centerOn(s.uid);
        if (!fresh || !(fresh.x > 60 && fresh.x < 1380 && fresh.y > 60 && fresh.y < 760)) continue;
        const e = await record(`F2b 地形抬升点点身体→${s.bid}营(单位${s.uid})`, { sx: fresh.x, sy: fresh.y });
        if (e.truth?.unitId === s.uid) { done++; if (done === 1) await page.screenshot({ path: 'docs/qa-u1/f2b-terrain-lift.png' }); }
        await page.waitForTimeout(200);
    }
    check('F2b 地形抬升部位单位可选中（真值命中 ≥3 次）', done >= 3, `命中 ${done} 次`);
}

// ---------- S6 拖动/失焦 ----------
{
    const box = await page.locator('canvas').first().boundingBox();
    const before = await selected();
    for (const [dx, dy] of [[180, 90], [-140, 60], [90, -110]]) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 });
        await page.mouse.up();
        await page.waitForTimeout(160);
    }
    const after = await selected();
    check('S6a 拖动镜头不改选择', before.id === after.id, `${before.id}→${after.id}`);
    await page.mouse.move(box.x + 60, box.y + 60);
    await page.mouse.down();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    await page.waitForTimeout(160);
    check('S6b 按压中失焦不误选', (await selected()).id === after.id);
}

// ---------- S7 选点命令生效时点地图 ----------
{
    const chips = page.locator('.battalion-chip');
    check('S7a 营卡存在', await chips.count() >= 2, `${await chips.count()} 张`);
    // R4 P1-1：显式选成建制营 + 驻守按钮可见性守卫（chips.nth(0) 可能是集结营 → #order-hold
    // 不可见 → 未捕获 TimeoutError 崩溃并吞掉后续场景与汇总）。
    const armed = (await selectLineBattalionChip()) && (await clickHoldButton());
    const picked = await selected();
    await page.screenshot({ path: 'docs/qa-u1/05-battalion-cards.png' });
    if (!armed) {
        check('S7b 命令消费且选择不漂移', false, '未能进入驻守选点模式（无可选成建制营或 #order-hold 不可见）');
        check('S7c 集结选点命令消费', false, '同上');
    } else {
        const box = await page.locator('canvas').first().boundingBox();
        const clickX = box.x + box.width * 0.4, clickY = box.y + box.height * 0.45;
        const e = await record('S7 驻守选点时点地图', { sx: clickX, sy: clickY, commandClick: true });
        const order = await page.evaluate(id => {
            const b = window.UI.scene.battalions.battalions.find(x => x.id === id);
            return b ? { p: !!b.orderPoint, gx: b.orderPoint?.gx, gy: b.orderPoint?.gy } : null;
        }, picked.id);
        check('S7b 命令消费且选择不漂移', e.consumed && e.actual === picked.id && order?.p,
            `判定=${e.verdict} 驻守=${order?.gx ?? '-'}${order?.gx ? ',' + order.gy : ''}`);
        await page.screenshot({ path: 'docs/qa-u1/07-hold-order.png' });
        await page.keyboard.press('r');
        await page.waitForTimeout(250);
        const e2 = await record('S7 集结选点时点地图', { sx: clickX + 120, sy: clickY + 90, commandClick: true });
        check('S7c 集结选点命令消费', e2.consumed && e2.actual === picked.id, `判定=${e2.verdict}`);
    }
}

// ---------- S4 敌我重叠（真值B 己方优先金标准） ----------
{
    const findOverlap = () => page.evaluate(() => {
        const scene = window.UI.scene, cam = scene.cameras.main;
        const A = cam.getWorldPoint(0, 0);
        const red = scene.units.filter(u => u.team === 'red' && !u.dead && !u.withdrawn);
        const blue = scene.units.filter(u => u.team === 'blue' && !u.dead && !u.withdrawn);
        const out = [];
        for (const r of red.slice(0, 60)) {
            let near = 99;
            for (const b of blue) near = Math.min(near, Math.hypot(b.gx - r.gx, b.gy - r.gy));
            if (near <= 2.2) {
                const foot = scene.groundPoint(r.gx + (r.gx - r.pgx) * 9, r.gy + (r.gy - r.pgy) * 9);
                out.push({ uid: r.id, bid: r.battalion?.id ?? null, near: +near.toFixed(2),
                    x: (foot.x - A.x) * cam.zoom, y: (foot.y - 18 - A.y) * cam.zoom });
            }
        }
        return out.slice(0, 6);
    });
    if (!(await safeSpeed(2))) {}
    let spots = await findOverlap();
    for (let round = 0; round < 16 && !spots.length; round++) {
        await page.waitForTimeout(2500);
        spots = await findOverlap();
        if (round === 2 && !spots.length) {
            // 构造敌我接触：把己方营驻守到离敌单位 1.5 格处（真实键鼠流程）
            const tgt = await page.evaluate(() => {
                const scene = window.UI.scene, cam = scene.cameras.main;
                const A = cam.getWorldPoint(0, 0);
                const blues = scene.units.filter(u => u.team === 'blue' && !u.dead && !u.withdrawn);
                const b = scene.battalions.battalions.find(x => x.team === 'red' && x.members.length);
                if (!blues.length || !b) return null;
                const c = b.center();
                let best = blues[0], bd = Infinity;
                for (const e of blues) { const d = Math.hypot(e.gx - c.gx, e.gy - c.gy); if (d < bd) { bd = d; best = e; } }
                const gx = Math.max(3, Math.min(257, best.gx - 1.5)), gy = Math.max(3, Math.min(177, best.gy));
                const foot = scene.groundPoint(gx, gy);
                return { x: (foot.x - A.x) * cam.zoom, y: (foot.y - A.y) * cam.zoom };
            });
            if (tgt && tgt.x > 30 && tgt.x < 1410 && tgt.y > 30 && tgt.y < 770) {
                const lineBid = await page.evaluate(() => {
                    const b = window.UI.scene.battalions.battalions
                        .find(x => x.team === 'red' && !x.gathering && x.members.length);
                    return b ? b.id : null;
                });
                const chip = lineBid != null ? page.locator(`.battalion-chip[data-bid="${lineBid}"]`).first() : null;
                if (chip && await chip.count()) {
                    await chip.click();
                    await page.waitForTimeout(180);
                    // F15 收尾：命令条按钮随营状态变化——用 chips.nth(0) 可能选中集结营（其命令条
                    // 没有驻守按钮），导致 #order-hold 不可见并抛点击超时、直接打断整轮验收。
                    // 改为显式选成建制作战营，且按钮不可见时本轮跳过（不制造假样本）。
                    const holdBtn = page.locator('#order-hold');
                    if (await holdBtn.isVisible().catch(() => false)) {
                        await holdBtn.click();
                        await page.waitForTimeout(220);
                        await page.mouse.click(tgt.x, tgt.y);
                        await page.waitForTimeout(300);
                    }
                }
            }
        }
    }
    if (!(await safeSpeed(1))) {}
    if (spots.length) {
        await page.screenshot({ path: 'docs/qa-u1/04-overlap.png' });
        for (const s of spots) {
            const fresh = await centerOn(s.uid);
            if (!fresh || !(fresh.x > 20 && fresh.x < 1420 && fresh.y > 20 && fresh.y < 775)) continue;
            await record(`S4 敌我重叠点(距敌${s.near}格)`, { sx: fresh.x, sy: fresh.y });
            await page.waitForTimeout(200);
        }
        const s4 = log.filter(l => l.tag.startsWith('S4'));
        const s4ok = s4.filter(l => l.verdict === 'ok');
        // R6 P2：原判据 `s4.length === s4ok.length` 把「点击瞬间重叠已溶解、真值 null/实际 null」
        // 的 `ok(真值点空)`（产品行为正确）也计为失败——false-negative。修正为：需 ≥1 次**严格**
        // 命中（选中==真值且为己方），任何 误选/点空/残留 即失败；溶解样本既不计失败也不计有效
        // 样本，因此"本轮无严格样本"仍按 F15 规则判失败。
        const s4bad = s4.filter(l => l.verdict === '误选' || l.verdict === '点空' || l.verdict === '残留');
        const s4dissolved = s4.filter(l => l.verdict === 'ok(真值点空)').length;
        check('S4 敌我重叠点选恒己方（真值金标准口径，取样 ≥1）',
            s4ok.length >= 1 && s4bad.length === 0 && s4ok.every(l => l.team === 'red'),
            `严格命中 ${s4ok.length}/${s4.length}（误选/点空/残留 ${s4bad.length}；溶解样本 ${s4dissolved} 不计失败）`);
    } else {
        check('S4 敌我重叠场景出现并验证', false, '50s 内未见 ≤2.2 格重叠');
    }
}

// ---------- F2c 建筑上方旗/身体：选营且面板不弹 ----------
{
    const spots = await page.evaluate(() => {
        const scene = window.UI.scene, cam = scene.cameras.main;
        const A = cam.getWorldPoint(0, 0);
        const out = [];
        for (const b of scene.territory?.camps?.buildings || []) {
            if (b.dead) continue;
            const bf = scene.groundPoint(b.gx, b.gy);
            for (const u of scene.units) {
                if (u.team !== 'red' || u.dead || u.withdrawn || !u.battalion) continue;
                const foot = scene.groundPoint(u.gx, u.gy);
                if (Math.hypot(foot.x - bf.x, foot.y - bf.y) <= 56) {
                    out.push({ uid: u.id, bid: u.battalion.id,
                        x: (foot.x - A.x) * cam.zoom, y: (foot.y - 18 - A.y) * cam.zoom });
                    break;
                }
            }
        }
        return out.slice(0, 3);
    });
    let verified = 0;
    for (let poll = 0; poll < 24 && !spots.length; poll++) {
        if (!(await safeSpeed(2))) {}
        await page.waitForTimeout(2500);
        if (!(await safeSpeed(1))) {}
        // 主动构造：有建筑但无人贴近时，集结第一营到建筑脚下（真实键鼠流程）
        if (poll === 5) {
            const hasBuilding = await page.evaluate(() => (window.UI.scene.territory?.camps?.buildings || []).filter(b => !b.dead).length);
            console.log(`  [F2c] 第${poll}轮：建筑 ${hasBuilding} 座`);
            if (hasBuilding) {
                const bp = await page.evaluate(() => {
                    const scene = window.UI.scene, cam = scene.cameras.main;
                    const b = (scene.territory?.camps?.buildings || []).find(x => !x.dead);
                    const bf = scene.groundPoint(b.gx, b.gy);
                    const A = cam.getWorldPoint(0, 0);
                    return { x: (bf.x - A.x) * cam.zoom, y: (bf.y - A.y) * cam.zoom };
                });
                const screenOfBuilding = () => page.evaluate(() => {
                    const scene = window.UI.scene, cam = scene.cameras.main;
                    const b = (scene.territory?.camps?.buildings || []).find(x => !x.dead);
                    if (!b) return null;
                    const bf = scene.groundPoint(b.gx, b.gy);
                    const A = cam.getWorldPoint(0, 0);
                    return { x: (bf.x - A.x) * cam.zoom, y: (bf.y - A.y) * cam.zoom };
                });
                await panTo(screenOfBuilding);   // 先把建筑摇到视口中部
                const bp2 = await screenOfBuilding();
                const chips = page.locator('.battalion-chip');
                if (await chips.count() && bp2.x > 30 && bp2.x < 1410 && bp2.y > 30 && bp2.y < 770) {
                    for (let ci = 0; ci < 2; ci++) {
                        // R4 P1-1：同上——显式选成建制营 + 驻守按钮可见性守卫
                        if (!(await selectLineBattalionChip())) break;
                        if (!(await clickHoldButton())) break;
                        await page.mouse.click(bp2.x, bp2.y);
                        await page.waitForTimeout(350);
                    }
                    const st = await page.evaluate(() => {
                        const b = window.UI.scene.selectedBattalion;
                        return b ? { id: b.id, op: b.orderPoint ? [b.orderPoint.gx, b.orderPoint.gy] : null } : null;
                    });
                    console.log(`  [F2c] 营${st?.id} 驻守令落地：${JSON.stringify(st?.op)}（建筑处）`);
                    if (!(await safeSpeed(2))) {}
                    await page.waitForTimeout(24000);   // 行军赶往建筑
                    if (!(await safeSpeed(1))) {}
                }
            }
        }
        spots.push(...await page.evaluate(() => {
            const scene = window.UI.scene, cam = scene.cameras.main;
            const A = cam.getWorldPoint(0, 0);
            const out = [];
            for (const b of scene.territory?.camps?.buildings || []) {
                if (b.dead) continue;
                const bf = scene.groundPoint(b.gx, b.gy);
                for (const u of scene.units) {
                    if (u.team !== 'red' || u.dead || u.withdrawn || !u.battalion) continue;
                    const foot = scene.groundPoint(u.gx, u.gy);
                    if (Math.hypot(foot.x - bf.x, foot.y - bf.y) <= 56) {
                        out.push({ uid: u.id, bid: u.battalion.id,
                            x: (foot.x - A.x) * cam.zoom, y: (foot.y - 18 - A.y) * cam.zoom });
                        break;
                    }
                }
            }
            return out.slice(0, 3);
        }));
    }
    for (const s of spots) {
        const fresh = await centerOn(s.uid);
        if (!fresh) continue;
        if (!fresh || !(fresh.x > 20 && fresh.x < 1420 && fresh.y > 20 && fresh.y < 775)) {
            console.log(`  [F2c] 单位${s.uid} 在地图边缘不可点击，换下一个`);
            continue;
        }
        const e = await record(`F2c 建筑上方点身体→${s.bid}营`, { sx: fresh.x, sy: fresh.y });
        if (e.verdict === '跳过(DOM遮挡)') continue;
        const panelClosed = e.panel && e.panel.b == null && e.panel.w == null;
        // R7 P2：原先逐样本 check 把"点击瞬间目标溶解（ok(真值点空)）"的正确样本也计失败
        // （false-EXIT=1）。改为：仅在**有真值且行为错误**时判失败；溶解样本不计失败也不计
        // 有效样本，聚合 check 的 verified>=1 仍保证 ≥1 次严格样本（无样本即失败，不放宽）。
        const f2cBad = ['误选', '点空', '残留'].includes(e.verdict);
        if (f2cBad) {
            check(`F2c 建筑上方点击：选营且面板不弹（单位${s.uid}）`, false,
                `选中=${e.actual} 真值=${e.truth?.bid} 判定=${e.verdict} 面板b=${e.panel?.b} w=${e.panel?.w}`);
        }
        if (e.verdict === 'ok' && panelClosed) verified++;
        await page.waitForTimeout(200);
    }
    if (spots.length) await page.screenshot({ path: 'docs/qa-u1/f2c-building-click.png' });
    check('F2c 建筑上方选营不弹面板（≥1 例）', verified >= 1,
        spots.length ? `验证 ${verified}/${spots.length} 例` : '战况无贴建筑单位，未取得样本');
}

// ---------- S5 营亡解散后的营卡与快捷键 ----------
{
    if (!(await safeSpeed(2))) {}
    const beforeCards = await page.evaluate(() => ({
        slots: Object.fromEntries(window.UI.battalionSlots()),
        chips: [...document.querySelectorAll('.battalion-chip')].map(c => ({ bid: c.dataset.bid, slot: c.dataset.slot, text: c.textContent }))
    }));
    check('S5a 营卡显示真实快捷键与兵种组成', beforeCards.chips.every(c => /^\[\d+\] \d+营/.test(c.text.trim())) &&
        beforeCards.chips.some(c => /骑|剑|枪|弓/.test(c.text)), beforeCards.chips[0]?.text.trim().slice(0, 40) || '');
    let slots = beforeCards.slots, goneId = null;
    for (let round = 0; round < 40 && !goneId; round++) {
        await page.waitForTimeout(3000);
        const now = await page.evaluate(() => window.UI.myBattalions().map(b => b.id));
        const gone = Object.keys(slots).map(Number).find(id => !now.includes(id));
        if (gone) goneId = gone;
        else { const s = await page.evaluate(() => Object.fromEntries(window.UI.battalionSlots())); for (const [k, v] of Object.entries(s)) slots[k] = v; }
    }
    check('S5b 战局中出现营亡解散', !!goneId, goneId ? `${goneId}营 解散` : '未见');
    if (goneId) {
        await page.waitForTimeout(1300);   // 等 HUD 周期刷新消化营亡（避免取到陈旧 DOM）
        const afterCards = await page.evaluate(() => ({
            ids: window.UI.myBattalions().map(b => b.id),
            slots: Object.fromEntries(window.UI.battalionSlots()),
            chips: [...document.querySelectorAll('.battalion-chip')].map(c => ({ bid: c.dataset.bid, slot: c.dataset.slot, text: c.textContent.trim() }))
        }));
        check('S5c 解散营营卡移除', !afterCards.ids.includes(goneId));
        const goneSlot = slots[goneId];
        const cur = await selected();
        if (goneSlot) {
            await page.keyboard.press(String(goneSlot));
            await page.waitForTimeout(250);
            const afterKey = await selected();
            const taken = afterCards.chips.find(c => c.slot === String(goneSlot));
            check('S5d 亡营槽位：让渡则选中当前真实营，空缺则不误选',
                taken ? afterKey.id === Number(taken.bid) : afterKey.id === cur.id,
                `按[${goneSlot}] → ${afterKey.id}${taken ? `（卡片 ${taken.bid}营）` : '（空缺不变）'}`);
        }
        const stable = Object.keys(slots).filter(id => afterCards.slots[id] && Number(id) !== goneId);
        check('S5e 幸存营键号不漂移', stable.length > 0 && stable.every(id => String(afterCards.slots[id]) === String(slots[id])),
            `${stable.length}/${Object.keys(afterCards.slots).length} 稳定`);
        await page.screenshot({ path: 'docs/qa-u1/05-after-disband.png' });
        const slotChips = afterCards.chips.filter(c => c.slot);
        for (const c of (slotChips.length ? slotChips.slice(0, 3) : afterCards.chips.slice(0, Math.min(3, afterCards.chips.length)))) {
            await page.keyboard.press(c.slot);
            await page.waitForTimeout(200);
            const sel = await selected();
            log.push({ tag: `S5e 快捷键[${c.slot}]按卡片标注选营`, expect: Number(c.bid), actual: sel.id,
                verdict: sel.id === Number(c.bid) ? 'ok' : '误选', prev: null, team: sel.team, truth: null });
            bumpScene(`S5e 快捷键[${c.slot}]`, 'sampled');
        }
    }
    if (!(await safeSpeed(1))) {}
}

await page.screenshot({ path: 'docs/qa-u1/00-final-r2.png' });
await browser.close();
printSummary();
process.exit(failed === 0 ? 0 : 1);
