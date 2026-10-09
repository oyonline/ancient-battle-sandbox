// ==================== 接敌表现探针（本轮渲染优化的前后对照取证） ====================
// 用法：先 `npm run arena` 起服（托管 dist/），另开终端
//   node tools/engage-visual-probe.mjs <输出目录> [标签]
// 固定场景/镜头/速度跑一局 sandbox 会战，采样：
//   1) 接敌人群（站定+敌在打击圈+冷却中）的画面帧分布：举械帧 vs 站姿帧（打一下发呆的量化值）
//   2) 出手反馈事件流：playAttackAnim / meleeImpact（按兵种与 kind）/ Snd 命中音
//   3) 假攻击守门：每次攻击动画是否都伴随真实 lastAttack 推进（表现不得自造攻击）
//   4) 性能：FPS、场景显示对象数（特效累积检测）、窗口末对象数
//   5) 同镜头截图：接敌近景 + 全局侧写
// 输出 <目录>/<标签>.json 与 <标签>-*.png，供独立 review 复核。
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const cand = [
    path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    path.join(homedir(), 'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
];
const EXE = cand.find(existsSync);
if (!EXE) { console.error('未找到缓存 Chromium'); process.exit(1); }
const URL = process.env.VERIFY_URL || 'http://127.0.0.1:5300/classic.html';
const OUT = process.argv[2] || '.omc/evidence/engage-probe';
const TAG = process.argv[3] || 'run';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(1200);

// ---- 固定场景：双方同构混编军团，平地、长蛇阵、自动指令、1x 速度 ----
await page.evaluate(() => {
    const army = { infantry: 60, pikeman: 30, archer: 15, cavalry: 15 };
    UI.mode = 'sandbox';
    UI.challenge = null;
    UI.configs.red = { ...army };
    UI.configs.blue = { ...army };
    UI.formations.red = 'line';
    UI.formations.blue = 'line';
    UI.orders = { red: 'advance', blue: 'advance' };
    UI.battleOptions.deathmatch = false;
    UI.battleOptions.control = false;
    UI.battleOptions.convoy = false;
    UI.battleOptions.territory = false;
    UI.battleOptions.net = false;
    UI.battleOptions.terrain = 'flat';
    UI.battleOptions.reserves = { red: 0, blue: 0 };
    UI.battleOptions.cavalryOrders = { red: 'auto', blue: 'auto' };
    UI.deployArmies();
    UI.startBattle();
});

// 探针注入：事件计数 + 假攻击守门 + FPS 环形统计
await page.evaluate(() => {
    const scene = UI.scene;
    window.__probe = { anims: [], impacts: [], snds: [], fakeAttacks: 0, fps: [], frames: 0, t0: performance.now() };
    const pAnim = scene.playAttackAnim.bind(scene);
    scene.playAttackAnim = (unit, target) => {
        // 真实出手前一步必先写 lastAttack（CombatRules.attack/impact 弓手分支）；
        // 表现层若自造攻击，这里会看到 lastAttack 陈旧 → 记为假攻击。
        if (scene.simulationTime - unit.lastAttack > 2) window.__probe.fakeAttacks++;
        window.__probe.anims.push({ at: Math.round(scene.simulationTime), type: unit.type, team: unit.team });
        return pAnim(unit, target);
    };
    const pImp = scene.meleeImpact.bind(scene);
    scene.meleeImpact = (attacker, target, kind) => {
        window.__probe.impacts.push({
            at: Math.round(scene.simulationTime), type: attacker.type, team: attacker.team,
            kind: kind || (attacker.type === 'pikeman' ? 'thrust' : attacker.type === 'cavalry' ? 'cavalry-default' : 'slash')
        });
        return pImp(attacker, target, kind);
    };
    const pSnd = Snd.play.bind(Snd);
    Snd.play = (name) => { window.__probe.snds.push({ at: Math.round(performance.now()), name }); return pSnd(name); };
    Snd.muted = true;   // 静音：只计数不出声
    scene.setSpeed(1);
    const loop = () => {
        window.__probe.frames++;
        requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
});

// 等倒计时结束 + 行军接敌（16→54 格，步速 2.2，约 12~14 秒首接）
await page.waitForTimeout(14000);

// 固定镜头：接敌缝近景（等距中心 35,35 → 屏幕点）+ 全局侧写
await page.evaluate(() => {
    const scene = UI.scene;
    const cam = scene.cameras.main;
    const p = scene.groundPoint(35, 35);
    cam.setZoom(1.15);
    cam.centerOn(p.x, p.y - 40);
    scene.userZoom = 1.15;
});
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(OUT, `${TAG}-melee-closeup.png`) });

// ---- 20 秒采样窗：每 500ms 统计接敌人群帧分布 ----
const samples = await page.evaluate(() => new Promise(resolve => {
    const scene = UI.scene;
    const out = [];
    const t0 = performance.now();
    const timer = setInterval(() => {
        const now = scene.simulationTime;
        let engaged = 0, stanceAttackFrame = 0, stanceWalkFrame = 0, moving = 0, other = 0;
        let infantryAtk = 0, pikemanAtk = 0, cavalryAtk = 0;
        for (const u of scene.units) {
            if (u.dead || u.withdrawn || u.moraleState === 'routing') continue;
            if (u.moving) { moving++; continue; }
            const t = u.meleeTarget;
            if (!t || t.dead || t.withdrawn) continue;
            const d = Math.hypot(t.gx - u.gx, t.gy - u.gy);
            if (d > u.typeData.range + 0.6) continue;
            if (now - u.lastAttack < u.typeData.atkSpeed + 400) {   // 冷却期或刚出手
                engaged++;
                const key = u.spr?.texture?.key || '';
                const frame = u.spr?.frame?.name ?? u.spr?.frame?.index ?? 0;
                if (u.animState === 'attack') {
                    other++;   // 攻击动画播放中的真实出手帧：不计入姿态统计（口径修正）
                } else if (key.includes('_attack')) {
                    stanceAttackFrame++;   // 非播放中的 attack 贴图持有＝接敌姿态（戒备/蓄势）帧
                    if (u.type === 'infantry') infantryAtk++;
                    else if (u.type === 'pikeman') pikemanAtk++;
                    else cavalryAtk++;
                } else stanceWalkFrame++;
            }
        }
        out.push({
            at: Math.round(now), engaged, stanceAttackFrame, stanceWalkFrame, moving, other,
            infantryAtk, pikemanAtk, cavalryAtk,
            children: scene.children.length,
            stanceField: scene.units.filter(u => u.stancePose?.active).length   // after 版本才有；before 恒 0
        });
        if (performance.now() - t0 >= 20000) {
            clearInterval(timer);
            resolve(out);
        }
    }, 500);
}), );

await page.evaluate(() => {
    const scene = UI.scene;
    const cam = scene.cameras.main;
    cam.setZoom(0.5);
    cam.centerOn(scene.groundPoint(35, 35).x, scene.groundPoint(35, 35).y);
});
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(OUT, `${TAG}-battle-wide.png`) });

const summary = await page.evaluate(() => {
    const p = window.__probe;
    const elapsed = (performance.now() - p.t0) / 1000;
    const byType = {}, byKind = {};
    for (const a of p.anims) byType[a.type] = (byType[a.type] || 0) + 1;
    for (const i of p.impacts) byKind[i.kind] = (byKind[i.kind] || 0) + 1;
    const sndNames = {};
    for (const s of p.snds) sndNames[s.name] = (sndNames[s.name] || 0) + 1;
    return {
        fps: Math.round(p.frames / elapsed),
        fakeAttacks: p.fakeAttacks,
        attackAnims: p.anims.length, byType,
        meleeImpacts: p.impacts.length, byKind,
        snds: sndNames,
        alive: UI.scene.redAlive + UI.scene.blueAlive,
        battleOver: UI.scene.battleOver,
        pageErrors: []
    };
});
summary.pageErrors = errors;
summary.samples = samples;
summary.sampleNotes = 'engaged=站定+敌在打击圈+冷却中(含出手后400ms)；stanceAttackFrame=其中非攻击动画播放中却持有attack贴图帧数（＝接敌姿态帧，口径已排除真实出手帧）；other=攻击动画播放中';

import { writeFileSync } from 'node:fs';
writeFileSync(path.join(OUT, `${TAG}.json`), JSON.stringify(summary, null, 2));
console.log(`fps=${summary.fps} fakeAttacks=${summary.fakeAttacks} anims=${summary.attackAnims} impacts=${summary.meleeImpacts}`);
console.log('byKind', JSON.stringify(summary.byKind), 'snds', JSON.stringify(summary.snds));
console.log('engaged 均值', Math.round(samples.reduce((a, s) => a + s.engaged, 0) / samples.length),
    'attackFrame 均值', Math.round(samples.reduce((a, s) => a + s.stanceAttackFrame, 0) / samples.length),
    'walkFrame 均值', Math.round(samples.reduce((a, s) => a + s.stanceWalkFrame, 0) / samples.length));
console.log('children 首末', samples[0]?.children, samples[samples.length - 1]?.children,
    'stanceField 末', samples[samples.length - 1]?.stanceField);
console.log('pageErrors', JSON.stringify(errors));
await browser.close();
