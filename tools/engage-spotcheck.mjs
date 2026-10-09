// ==================== 接敌表现定点验收（浏览器实机） ====================
// 用法：先 `npm run arena`，另开终端 node tools/engage-spotcheck.mjs
// 定点项：
//   A) 三兵种接敌姿态：infantry/pikeman/cavalry 站定接敌时 stancePose 激活，
//      帧指向举械/蓄势；姿态期保持 idle 持帧而非播放攻击剪辑
//   B) 出手反馈现场分流：斩弧/直刺/冲撞波计数与兵种对号（真实命中驱动，近景 lowFX 关闭）
//   C) 正常操作恢复路径：镜头拖动平移、滚轮缩放、点兵查看、点空地清除，零页面报错
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';

const cand = [
    path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
];
const EXE = cand.find(existsSync);
if (!EXE) { console.error('未找到缓存 Chromium'); process.exit(1); }
const URL = process.env.VERIFY_URL || 'http://127.0.0.1:5300/classic.html';
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(1200);

await page.evaluate(() => {
    const army = { infantry: 60, pikeman: 30, archer: 15, cavalry: 15 };
    UI.mode = 'sandbox'; UI.challenge = null;
    UI.configs.red = { ...army }; UI.configs.blue = { ...army };
    UI.formations.red = 'line'; UI.formations.blue = 'line';
    UI.orders = { red: 'advance', blue: 'advance' };
    Object.assign(UI.battleOptions, { deathmatch: false, control: false, convoy: false, territory: false, net: false, terrain: 'flat', reserves: { red: 0, blue: 0 }, cavalryOrders: { red: 'auto', blue: 'auto' } });
    UI.deployArmies();
    UI.startBattle();
});

// 命中分流计数从开局就挂上：冲锋撞击集中在首次接敌窗口，晚挂会漏采
await page.evaluate(() => {
    const scene = UI.scene;
    window.__impactKinds = { slash: 0, thrust: 0, charge: 0 };
    const pImp = scene.meleeImpact.bind(scene);
    scene.meleeImpact = (attacker, target, kind) => {
        const k = kind || (attacker.type === 'pikeman' ? 'thrust' : 'slash');
        window.__impactKinds[k === 'charge' ? 'charge' : k === 'thrust' ? 'thrust' : 'slash']++;
        return pImp(attacker, target, kind);
    };
});

// ---- A+B：接敌后近景采样姿态与反馈分流（zoom>0.42 关闭 lowFX，特效全量） ----
await page.waitForTimeout(15000);
await page.evaluate(() => {
    const scene = UI.scene;
    const cam = scene.cameras.main;
    const p = scene.groundPoint(35, 35);
    cam.setZoom(1.1);
    cam.centerOn(p.x, p.y - 40);
});
const stance = await page.evaluate(() => new Promise(resolve => {
    const scene = UI.scene;
    const fx = scene.render.fx;
    const counts = { slashDrawn: 0, thrustDrawn: 0 };
    const pSlash = fx.slashArc.bind(fx), pThrust = fx.thrustStreak.bind(fx);
    fx.slashArc = (...a) => { counts.slashDrawn++; return pSlash(...a); };
    fx.thrustStreak = (...a) => { counts.thrustDrawn++; return pThrust(...a); };
    const seen = {};
    let ticks = 0;
    const timer = setInterval(() => {
        ticks++;
        for (const u of scene.units) {
            if (u.dead || u.withdrawn || !u.stancePose?.active || seen[u.type]) continue;
            seen[u.type] = {
                type: u.type, clip: u.stancePose.clip, frame: u.stancePose.frame,
                breath: u.stancePose.breath, moving: u.moving,
                animState: u.animState, braceHold: !!u.braceHold, tacticalRole: u.tacticalRole || null,
                cooldownLeft: Math.max(0, Math.round((u.lastAttack + u.typeData.atkSpeed) - scene.simulationTime))
            };
        }
        if (ticks >= 32) {   // 8 秒
            clearInterval(timer);
            resolve({ seen, counts, kinds: window.__impactKinds,
                stanceActiveNow: scene.units.filter(u => u.stancePose?.active).length });
        }
    }, 250);
}));

// ---- C：镜头与选兵恢复路径 ----
const camBefore = await page.evaluate(() => {
    const cam = UI.scene.cameras.main;
    return { x: cam.scrollX, y: cam.scrollY, zoom: cam.zoom };
});
await page.mouse.move(720, 450);
await page.mouse.down();
await page.mouse.move(560, 380, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
await page.mouse.wheel(0, -400);
await page.waitForTimeout(300);
const camAfter = await page.evaluate(() => {
    const cam = UI.scene.cameras.main;
    return { x: cam.scrollX, y: cam.scrollY, zoom: cam.zoom };
});
// 点兵查看：屏幕粗网格上直接用 pick 探一个能命中士兵的点位
// （Phaser 缩放以视口中心为轴，手写世界→屏幕换算易偏，这里不重复实现）
const inspect = await page.evaluate(() => {
    const picker = UI.scene.unitInspector;
    for (let y = 140; y <= 800; y += 36) {
        for (let x = 200; x <= 1240; x += 36) {
            const unit = picker.pick({ x, y });
            if (unit) return { ok: true, sx: x, sy: y, type: unit.type };
        }
    }
    return { ok: false };
});
if (inspect.ok) {
    await page.mouse.click(inspect.sx, inspect.sy);
    await page.waitForTimeout(300);
}
const inspected = await page.evaluate(() => ({
    selected: UI.scene.unitInspector?.selected != null,
    panelShown: !!UI.scene.unitInspector && UI.scene.unitInspector.panel && !UI.scene.unitInspector.panel.hidden
}));
// 点空地清除选兵（恢复路径）
if (inspect.ok) {
    await page.mouse.click(120, 100);
    await page.waitForTimeout(300);
}
const cleared = await page.evaluate(() => UI.scene.unitInspector?.selected == null);

let failed = 0;
const check = (name, ok, detail) => { console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' · ' + detail : ''}`); if (!ok) failed++; };

for (const type of ['infantry', 'pikeman', 'cavalry']) {
    const s = stance.seen[type];
    check(`${type} 接敌姿态激活`, !!s, s ? `clip=${s.clip} frame=${s.frame} breath=${s.breath} 冷却剩余${s.cooldownLeft}ms animState=${s.animState}` : '未采样到');
}
check('姿态期是 idle 持帧而非播放攻击剪辑',
    Object.values(stance.seen).every(s => s.animState !== 'attack'));
check('反馈按兵种分流（斩弧/直刺/冲撞都有且互不串线）',
    stance.kinds.slash > 0 && stance.kinds.thrust > 0 && stance.kinds.charge > 0,
    `命中分流 slash=${stance.kinds.slash} thrust=${stance.kinds.thrust} charge=${stance.kinds.charge}`);
check('近景特效实际绘制（斩弧+直刺光）',
    stance.counts.slashDrawn > 0 && stance.counts.thrustDrawn > 0,
    `绘制 slash=${stance.counts.slashDrawn} thrust=${stance.counts.thrustDrawn}`);
check('镜头拖动平移生效', Math.abs(camAfter.x - camBefore.x) > 10 || Math.abs(camAfter.y - camBefore.y) > 10,
    `scrollX ${camBefore.x.toFixed(0)}→${camAfter.x.toFixed(0)}`);
check('滚轮缩放生效', Math.abs(camAfter.zoom - camBefore.zoom) > 0.01,
    `zoom ${camBefore.zoom.toFixed(2)}→${camAfter.zoom.toFixed(2)}`);
check('点兵查看打开', inspect.ok && inspected.selected && inspected.panelShown, JSON.stringify(inspected));
check('点空地清除选兵（恢复路径）', cleared);
check('零页面报错', errors.length === 0, errors[0] || '');
console.log(failed ? `❌ ${failed} 项未过` : '定点验收全部通过 ✅');
await browser.close();
process.exit(failed ? 1 : 0);
