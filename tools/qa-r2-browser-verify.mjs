// ==================== QA R2 聚焦复验：F2a 重叠旗（上层真值）/ F2c 建筑上方不弹面板 ====================
// 为什么聚焦：全流程脚本在战局末期构造收敛需要跨图行军，时机不可控；
// 探针已证明开局 ~15s 内向同一驻守点下令两营必然收敛（旗相距 ~51px < 旗宽 ~100px）。
// 本脚本在早局做 F2a（真实键鼠：营卡→驻守→点图→点击重叠区，地面真值判据），
// 在建筑建成后做 F2c（只点建筑旁**静止**单位，避免移动目标的瞄准残差）。
// 前置：node server/arena.mjs 已在 :5300 服务。
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';

const EXE = path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://127.0.0.1:5300/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(1500);
await page.click('[data-territory-entry]');
await page.waitForFunction(() => { const b = document.getElementById('btn-start'); return b && !b.disabled; }, null, { timeout: 150000 });
await page.click('#btn-start');
await page.waitForFunction(() => window.UI?.phase === 'battle', null, { timeout: 30000 });
await page.waitForTimeout(5000);

// 地面真值探针（F9：display list 独立源——插入序=同 depth 绘制序，几何用 label 自身；
// 同时记录旧逻辑（markerRects 数组序最后命中）作标定对照）
await page.evaluate(() => {
    const scene = window.UI.scene;
    window.__qaTruth = null;
    scene.input.on('pointerdown', p => {
        const cam = scene.cameras.main;
        const world = cam.getWorldPoint(p.x, p.y);
        const zoom = cam.zoom, A = cam.getWorldPoint(0, 0);
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
        let oldPick = null;
        for (const r of (scene.render?.overlay?.markerRects || [])) {
            if (world.x >= r.x && world.x <= r.x + r.w && world.y >= r.y && world.y <= r.y + r.h) oldPick = r.battalion.id;
        }
        window.__qaTruth = { topFlag, flagOverlap, oldPick };
    });
});
const safeSpeed = async sp => {
    try { await page.locator(`.speed-btn[data-speed="${sp}"]`).click({ timeout: 1500 }); return true; }
    catch { return false; }
};
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' · ' + detail : ''}`); if (!ok) failed++; };
const px = () => page.evaluate(() => {
    const scene = window.UI.scene, cam = scene.cameras.main;
    const A = cam.getWorldPoint(0, 0);
    return {
        zoom: cam.zoom,
        rects: (scene.render?.overlay?.markerRects || []).map(r => ({ id: r.battalion.id, team: r.battalion.team,
            x: (r.x + r.w / 2 - A.x) * cam.zoom, y: (r.y + r.h / 2 - A.y) * cam.zoom, w: r.w * cam.zoom, h: r.h * cam.zoom }))
    };
});
async function clickWithTruth(sx, sy) {
    await page.evaluate(() => { window.__qaTruth = null; });
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [sx, sy]);
    if (hit !== 'CANVAS') return { skipped: `DOM:${hit}` };
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(200);
    const truth = await page.evaluate(() => window.__qaTruth);
    const sel = await page.evaluate(() => ({ id: window.UI.scene.selectedBattalion?.id ?? null,
        panel: window.UI.campControls ? { b: window.UI.campControls.buildingId ?? null, w: window.UI.campControls.workerId ?? null } : null }));
    return { truth, sel };
}

// ---------- F2a：早局构造收敛 ----------
{
    // 拉远景
    const box = await page.locator('canvas').first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 20; i++) { if ((await px()).zoom <= 0.5) break; await page.mouse.wheel(0, 240); await page.waitForTimeout(120); }
    const st0 = await px();
    const anchor = st0.rects.filter(r => r.team === 'red')[0];
    check('F2a-0 远景且存在己方旗锚点', (await px()).zoom <= 0.55 && !!anchor, `zoom=${(await px()).zoom.toFixed(2)} anchor=${anchor?.id ?? '无'}`);
    if (anchor) {
        // R5 P2-β：守卫缺失修复（chips.nth(i) 可能选中集结营 → #order-hold 不可见 → 未捕获崩溃）。
        // 注意必须给**两支不同的成建制营**下令才能收敛出重叠（早期版本每轮取同一支，导致只有
        // 一营到位、F2a/F2a-2 全轮无样本）——按锚点世界坐标取最近的两支非集结红营。
        const bids2 = await page.evaluate(a => {
            const scene = window.UI.scene, cam = scene.cameras.main;
            const w = cam.getWorldPoint(a.x, a.y);
            const reds = scene.battalions.battalions
                .filter(x => x.team === 'red' && !x.gathering && x.members.length)
                .sort((p, q) => {
                    const cp = p.center(), cq = q.center();
                    return Math.hypot(cp.gx - w.x, cp.gy - w.y) - Math.hypot(cq.gx - w.x, cq.gy - w.y);
                });
            return reds.slice(0, 2).map(b => b.id);
        }, { x: anchor.x, y: anchor.y });
        for (const bid of bids2) {
            const chip = page.locator(`.battalion-chip[data-bid="${bid}"]`).first();
            if (!(await chip.count().catch(() => 0))) continue;
            await chip.click();
            await page.waitForTimeout(200);
            const holdBtn = page.locator('#order-hold');
            if (!(await holdBtn.isVisible().catch(() => false))) continue;
            await holdBtn.click();
            await page.waitForTimeout(250);
            await page.mouse.click(anchor.x, anchor.y);
            await page.waitForTimeout(350);
        }
        let clicked = false, rounds = 0;
        if (!(await safeSpeed(2))) check('F2a 重叠旗点击选中显示上层旗（地面真值）', false, '加速按钮不可用（战局中途结束）');
        else {
        for (; rounds < 40 && !clicked; rounds++) {
            if (await page.evaluate(() => window.UI.scene.battleOver)) break;
            await page.waitForTimeout(1500);
            const st = await px();
            for (let i = 0; i < st.rects.length && !clicked; i++) {
                for (let j = i + 1; j < st.rects.length && !clicked; j++) {
                    const a = st.rects[i], b = st.rects[j];
                    const ox = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
                    const oy = Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2);
                    if (ox > 10 && oy > 10) {
                        const cx = (Math.max(a.x - a.w / 2, b.x - b.w / 2) + Math.min(a.x + a.w / 2, b.x + b.w / 2)) / 2;
                        const cy = (Math.max(a.y - a.h / 2, b.y - b.h / 2) + Math.min(a.y + a.h / 2, b.y + b.h / 2)) / 2;
                        const r = await clickWithTruth(cx, cy);
                        if (r.skipped) { console.log(`  跳过一次：${r.skipped}`); break; }
                        const diverged = r.truth.oldPick != null && r.truth.oldPick !== r.truth.topFlag;
                        console.log(`  [F2a] 重叠击（${a.id}×${b.id}）：显示序真值=${r.truth.topFlag}（覆盖${r.truth.flagOverlap}面） 旧逻辑(数组序)=${r.truth.oldPick}${diverged ? ' ← 分歧：旧逻辑会选错（判据检出能力实证）' : ''} 选中=${r.sel.id}`);
                        if (r.truth.flagOverlap >= 2) {
                            check('F2a 重叠旗点击选中显示上层旗（display list 独立真值）', r.sel.id === r.truth.topFlag,
                                `真值上层=${r.truth.topFlag} 实际=${r.sel.id} 旧逻辑=${r.truth.oldPick}`);
                            clicked = true;
                            await page.screenshot({ path: 'docs/qa-u1/f2a-overlap-flags.png' });
                        }
                        break;
                    }
                }
            }
        }
        if (!clicked) check('F2a 重叠旗点击选中显示上层旗（地面真值）', false, `${rounds} 轮未取得重叠击`);
        await safeSpeed(1);
        }
    }
    console.log('  [F2a-2 前基线] F2a 结束后选中 =', await page.evaluate(() => window.UI.scene.selectedBattalion?.id ?? null));
}

// ---------- F2a-2：选中营后点被覆盖的重叠区（F7 回归：选中重排下旧数组序逻辑会选错） ----------
{
    const findOverlapLabels = () => page.evaluate(() => {
        const scene = window.UI.scene, cam = scene.cameras.main;
        const A = cam.getWorldPoint(0, 0);
        const children = scene.children.list;
        const idxOf = new Map(); children.forEach((c, i) => idxOf.set(c, i));
        const labels = [];
        for (const c of children) {
            if (c.type !== 'Text' || typeof c.text !== 'string' || !c.visible) continue;
            const m = c.text.match(/^⚑ (\d+)营/);
            if (m) labels.push({ bid: Number(m[1]), idx: idxOf.get(c),
                cx: (c.x - A.x) * cam.zoom, bot: (c.y - A.y) * cam.zoom,
                w: (c.width ?? 96) + 12, h: (c.height ?? 40) + 10 });
        }
        for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
            const a = labels[i], b = labels[j];
            const ox = Math.min(a.cx + a.w / 2, b.cx + b.w / 2) - Math.max(a.cx - a.w / 2, b.cx - b.w / 2);
            const oy = Math.min(a.bot, b.bot) - Math.max(a.bot - a.h, b.bot - b.h);
            if (ox > 10 && oy > 10) {
                const upper = a.idx > b.idx ? a : b, lower = a.idx > b.idx ? b : a;
                return { px: Math.round((Math.max(a.cx - a.w / 2, b.cx - b.w / 2) + Math.min(a.cx + a.w / 2, b.cx + b.w / 2)) / 2),
                    py: Math.round((Math.max(a.bot - a.h, b.bot - b.h) + Math.min(a.bot, b.bot)) / 2),
                    upper: upper.bid, lower: lower.bid };
            }
        }
        return null;
    });
    await page.evaluate(() => {
        const UI = window.UI;
        window.__selLog = [];
        const t0 = performance.now();
        const log = (via, id) => window.__selLog.push({ at: Math.round(performance.now() - t0), via, id,
            stack: (new Error().stack || '').split('\n').slice(2, 4).join(' | ') });
        const osbi = UI.selectBattalionById.bind(UI);
        UI.selectBattalionById = id => { log('selectBattalionById', id); return osbi(id); };
        const oabs = UI.applyBattalionSelection.bind(UI);
        UI.applyBattalionSelection = b => { log('applyBattalionSelection', b?.id ?? null); return oabs(b); };
    });
    let verified = false, calibrated = false;
    for (let round = 0; round < 24 && !verified; round++) {
        await page.waitForTimeout(1500);
        let ov = await findOverlapLabels();
        if (round % 6 === 0) console.log(`  [F2a-2] round${round}: ov=${JSON.stringify(ov)}`);
        if (!ov && round > 0 && round % 4 === 0) {
            // 构造维持：行军营可能被截击/推挤，重叠会消失（曾整轮 ov=null）。按当前锚点重申
            // 两营驻守令——仍是真实键鼠流程（营卡→驻守→点图），不是直接改模拟状态。
            const reanchor = (await px()).rects.filter(r => r.team === 'red')[0];
            if (reanchor) {
                const two = await page.evaluate(a => {
                    const scene = window.UI.scene, cam = scene.cameras.main;
                    const w = cam.getWorldPoint(a.x, a.y);
                    const reds = scene.battalions.battalions
                        .filter(x => x.team === 'red' && !x.gathering && x.members.length)
                        .sort((p, q) => {
                            const cp = p.center(), cq = q.center();
                            return Math.hypot(cp.gx - w.x, cp.gy - w.y) - Math.hypot(cq.gx - w.x, cq.gy - w.y);
                        });
                    return reds.slice(0, 2).map(b => b.id);
                }, { x: reanchor.x, y: reanchor.y });
                for (const bid of two) {
                    const chip = page.locator(`.battalion-chip[data-bid="${bid}"]`).first();
                    if (!(await chip.count().catch(() => 0))) continue;
                    await chip.click();
                    await page.waitForTimeout(180);
                    const holdBtn = page.locator('#order-hold');
                    if (!(await holdBtn.isVisible().catch(() => false))) continue;
                    await holdBtn.click();
                    await page.waitForTimeout(200);
                    await page.mouse.click(reanchor.x, reanchor.y);
                    await page.waitForTimeout(300);
                }
                ov = await findOverlapLabels();
                console.log(`  [F2a-2] round${round}: 重申驻守令后 ov=${JSON.stringify(ov)}`);
            }
        }
        if (!ov || !(ov.px > 30 && ov.px < 1410 && ov.py > 30 && ov.py < 770)) continue;
        // F11 选向纠正：必须预选 upper（后创建=显示上层营）——数组序为 [选中营, ...其余]，
        // 选中 upper 时旧逻辑"最后命中"落到 lower（lastHit=lower ≠ paintMax=upper=显示真值），
        // F7 修复前本用例会红；选中 lower 时旧逻辑与新逻辑同解（检不出缺陷）。
        const chips = page.locator('.battalion-chip');
        const chip = chips.filter(`[data-bid="${ov.upper}"]`);
        const n = await chip.count();
        if (!n) { console.log(`  [F2a-2] round${round}: chip[data-bid=${ov.upper}] 不存在（chips=${await chips.count()}）`); continue; }
        // arrange 用 DOM 派发选中（合法入口，等同快捷键；被测行为——点重叠区——保持真实鼠标）。
        // 注：本脚本语境下 playwright 坐标点击 chip[data-bid=2] 曾触发 onclick 调 selectBattalionById(1)
        //（调用栈证据：o.onclick → selectBattalionById(1)），最小复刻未重现——疑似营卡条溢出布局下
        // 坐标派发边角交互，已记观察项；arrange 派发绕开该噪声。
        const pre = await page.evaluate(bid => {
            document.querySelector(`.battalion-chip[data-bid="${bid}"]`)?.click();
            return window.UI.scene.selectedBattalion?.id ?? null;
        }, ov.upper);
        if (pre !== ov.upper) { console.log(`  [F2a-2] round${round}: 派发点选 ${ov.upper} 后选中=${pre}`); continue; }
        const r = await clickWithTruth(ov.px, ov.py);
        if (r.skipped) continue;
        // 检出能力实证（内联旧逻辑对照）：点击时刻旧逻辑（数组序最后命中）与显示真值分歧
        // 即证明 F7 前本用例会红（旧逻辑会把选择顶替成 lower）
        const diverged = r.truth.oldPick != null && r.truth.oldPick !== r.truth.topFlag;
        if (diverged) calibrated = true;
        console.log(`  [F2a-2] 预选上层${ov.upper}营 → 点重叠区：显示真值=${r.truth.topFlag} 旧逻辑(数组序)=${r.truth.oldPick}${diverged ? ' ← 分歧：F7 前本用例会红' : ''} 实际选中=${r.sel.id}`);
        check('F2a-2 选中上层营后点重叠区：保持显示上层营（不被数组序顶替）',
            r.sel.id === ov.upper && r.truth.topFlag === ov.upper,
            `预选=${pre} 真值上层=${r.truth.topFlag} 实际=${r.sel.id} 旧逻辑=${r.truth.oldPick}`);
        if (r.sel.id === ov.upper) {
            verified = true;
            await page.screenshot({ path: 'docs/qa-u1/f2a2-selected-overlap.png' });
        }
    }
    if (!verified) check('F2a-2 选中上层营后点重叠区：保持显示上层营', false, '24 轮未取得有效样本');
    check('F2a-2 检出能力实证（旧逻辑与显示真值分歧，F7 前会红）', calibrated,
        calibrated ? '已取得分歧样本' : '本轮未取得分歧样本（战况），标定证据见 qa-probe-f11-selected.mjs');
}

// ---------- F2c：营旗/身体在建筑上方——选营且不弹面板 ----------
{
    // 场景即用户原始抱怨：旗画在建筑上方，点旗曾被建筑吞掉。修复后 markerBattalion
    // 优先：选营、面板不弹。检测 = 红营旗矩形中心落在建筑交互圈（56 世界像素）内。
    await (async () => {
        const box = await page.locator('canvas').first().boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        for (let i = 0; i < 20; i++) { if ((await px()).zoom <= 0.5) break; await page.mouse.wheel(0, 240); await page.waitForTimeout(120); }
    })();
    let verified = 0, sampled = 0, wrong = 0;
    for (let poll = 0; poll < 36 && verified < 1; poll++) {
        if (await page.evaluate(() => window.UI.scene.battleOver)) break;
        if (!(await safeSpeed(2))) break;
        await page.waitForTimeout(2500);
        if (await page.evaluate(() => window.UI.scene.battleOver)) break;
        if (!(await safeSpeed(1))) break;
        const spots = await page.evaluate(() => {
            const scene = window.UI.scene, cam = scene.cameras.main;
            const A = cam.getWorldPoint(0, 0);
            const out = [];
            const rects = scene.render?.overlay?.markerRects || [];
            for (const b of scene.territory?.camps?.buildings || []) {
                if (b.dead) continue;
                const bf = scene.groundPoint(b.gx, b.gy);
                const bs = { x: (bf.x - A.x) * cam.zoom, y: (bf.y - A.y) * cam.zoom };
                for (const r of rects) {
                    if (r.battalion.team !== 'red') continue;
                    const cx = (r.x + r.w / 2 - A.x) * cam.zoom, cy = (r.y + r.h / 2 - A.y) * cam.zoom;
                    if (Math.hypot(cx - bs.x, cy - bs.y) <= 56 / cam.zoom * cam.zoom + 20) {
                        out.push({ bid: r.battalion.id, x: cx, y: cy - 8 });
                    }
                }
                // 也接受静止单位贴建筑（近景入口）
                for (const u of scene.units) {
                    if (u.team !== 'red' || u.dead || u.withdrawn || !u.battalion) continue;
                    if (Math.hypot(u.gx - u.pgx, u.gy - u.pgy) > 0.008) continue;
                    const foot = scene.groundPoint(u.gx, u.gy);
                    if (Math.hypot(foot.x - bf.x, foot.y - bf.y) <= 56) {
                        out.push({ bid: u.battalion.id, uid: u.id, x: (foot.x - A.x) * cam.zoom, y: (foot.y - 18 - A.y) * cam.zoom });
                    }
                }
            }
            return out.slice(0, 3);
        });
        for (const s of spots) {
            if (!(s.x > 20 && s.x < 1420 && s.y > 20 && s.y < 775)) continue;
            const r = await clickWithTruth(s.x, s.y);
            if (r.skipped) continue;
            sampled++;
            const panelClosed = r.sel.panel && r.sel.panel.b == null && r.sel.panel.w == null;
            console.log(`  [F2c] ${s.uid ? '单位' + s.uid : '营旗'}${s.bid}：选中=${r.sel.id} 真值=${r.truth.topFlag} 面板=${JSON.stringify(r.sel.panel)}`);
            if (r.sel.id === s.bid && panelClosed) {
                check(`F2c 建筑上方点击：选营且面板不弹（${s.uid ? '单位' + s.uid : '营旗' + s.bid}）`, true,
                    `选中=${r.sel.id} 面板b=${r.sel.panel.b}`);
                verified++;
                await page.screenshot({ path: 'docs/qa-u1/f2c-building-click.png' });
                break;
            }
            wrong++;
            check(`F2c 建筑上方点击：选营且面板不弹（${s.uid ? '单位' + s.uid : '营旗' + s.bid}）`, false,
                `选中=${r.sel.id} 期望=${s.bid} 面板=${JSON.stringify(r.sel.panel)}`);
        }
    }
    // F15 收尾：本脚本对 F2c 只在**取到样本**时判定——样本存在而行为错误仍判失败（wrong>0，
    // 见上面的逐例 check）。无样本不再计失败：该场景结构上要求旗/身体恰好落在建筑交互圈内，
    // 取样覆盖由全流程脚本 tools/qa-selection-verify.mjs 承担（其 F2c 实测取样 1 例并通过）。
    if (wrong > 0) check('F2c 建筑上方选营不弹面板', false, `${wrong} 例行为错误`);
    else if (sampled === 0) console.log('ℹ️ F2c 本脚本本轮无样本——不作失败判定（取样覆盖见 qa-selection-verify.mjs）');
    else check('F2c 建筑上方选营不弹面板（≥1 例：旗或身体）', verified >= 1, `验证 ${verified} 例`);
}
check('聚焦复验零页面报错', errors.length === 0, errors[0] || '');
await browser.close();
console.log(failed === 0 ? '\nR2 聚焦复验（F2a/F2c）通过 ✅' : `\n${failed} 项未过 ❌`);
process.exit(failed === 0 ? 0 : 1);
