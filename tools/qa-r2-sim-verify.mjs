// ==================== QA R2 复验（Node 侧）：F1 振荡 / F3 投影缺口 / F4 回撤脱战 ====================
// 独立于 tests/ 的 QA 复验：自带计数器与阳性对照（阳性对照 = 运行时屏蔽修复行为，
// 复现旧缺陷动态，证明计数器具备检出能力——不改产品代码，仅测试侧运行时覆盖）。
// 用法：node tools/qa-r2-sim-verify.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit } from '../tests/battle-harness.js';
import { TERRITORY } from '../js/battle/economy.js';
import { battleProjection, hashProjection } from '../js/net/lockstep.js';

const STEP = 1000 / 60;

function territoryScene(options = {}, red = { ...TERRITORY.OPENING }, blue = { ...TERRITORY.OPENING }) {
    const scene = makeScene();
    scene.deployUnits(red, blue, 'custom', 'custom', {}, { territory: true, ...options });
    scene.battleStarted = true;
    return scene;
}
function run(scene, seconds, pin) {
    for (let i = 0; i < 60 * seconds && !scene.battleOver; i++) {
        if (pin) pin();
        scene.advanceBattle(STEP);
    }
}
// 独立骑队（与 tests 同法：钉走杂兵，红方 3 骑成队）
function cavalryTroop(scene, spots) {
    const makers = scene.units.filter(u => u.team === 'red' && u.type !== 'cavalry' && u.type !== 'worker');
    makers.forEach((u, i) => { u.gx = 200; u.gy = 10 + i * 1.5; u.hp = u.maxHp; });
    const horses = [];
    for (const [gx, gy] of spots) horses.push(addUnit(scene, 'red', 'cavalry', gx, gy));
    scene.battalions.splitOpening(scene.units.filter(u => !u.dead && !u.withdrawn));
    const troop = scene.battalions.battalions.find(b => b.team === 'red' && b.cavalry);
    assert.ok(troop, '红方独立骑队存在');
    return { troop, horses };
}
// 换向计数（独立实现）：营心 x 位移符号翻转次数，|dx|>0.002 才计入
function countReversals(scene, troop, pinOthers, seconds, windowSeconds) {
    const deltas = [];
    for (let i = 0; i < 60 * seconds && !scene.battleOver; i++) {
        pinOthers();
        const before = troop.center().gx;
        scene.advanceBattle(STEP);
        deltas.push(troop.center().gx - before);
    }
    let reversals = 0, last = null;
    for (let i = Math.max(0, deltas.length - 60 * windowSeconds); i < deltas.length; i++) {
        const dx = deltas[i];
        if (Math.abs(dx) > 0.002) {
            if (last != null && Math.sign(dx) !== Math.sign(last)) reversals++;
            last = dx;
        }
    }
    return reversals;
}

// ---------- F1 驻守振荡：滞回修复复验（含阳性对照） ----------
function f1Scenario(neuterHysteresis) {
    const scene = territoryScene({ territoryAI: false }, { infantry: 4 }, { infantry: 4 });
    scene.rebuildSpatial();
    const others = scene.units.filter(u => u.type !== 'cavalry' || u.team !== 'red');
    const pinOthers = () => others.forEach((u, i) => { u.gx = 240; u.gy = 20 + i * 1.5; u.hp = u.maxHp; });
    pinOthers();
    const { troop } = cavalryTroop(scene, [[67.2, 89], [67.2, 91], [67.7, 90]]);   // 稳健缰绳 7 外一点点
    scene.battalions.orderHold(troop, 60, 90);
    const archer = addUnit(scene, 'blue', 'archer', 72, 90);   // 缰绳外 5 格吊射
    scene.rebuildSpatial();
    const pin = () => { pinOthers(); if (neuterHysteresis) for (const c of troop.aliveMembers()) c.leashReturning = false; };
    const reversals = countReversals(scene, troop, pin, 6, 3);
    return { reversals, archerHp: archer.hp, archerMax: archer.maxHp };
}
test('F1 复验①阳性对照：屏蔽滞回承诺后，边界振荡可被本计数器检出（复现旧缺陷动态）', () => {
    const { reversals } = f1Scenario(true);
    assert.ok(reversals >= 30, `阳性对照必须检出高频换向（实测 3 秒 ${reversals} 次；tests 记录基线 ~144 次）`);
});
test('F1 复验②修复态：驻守边界 3 秒换向 ≤5 次，敌弓不被误伤', () => {
    const { reversals, archerHp, archerMax } = f1Scenario(false);
    assert.ok(reversals <= 5, `修复态 3 秒换向 ${reversals} 次（≤5）`);
    assert.equal(archerHp, archerMax, '折返窗口内敌弓零战损（出击未达）');
});
test('F1 复验③合法接敌不被滞回吞掉：6 格交还圈内敌弓被打出真实伤害', () => {
    const scene = territoryScene({ territoryAI: false }, { infantry: 4 }, { infantry: 4 });
    scene.rebuildSpatial();
    const others = scene.units.filter(u => u.type !== 'cavalry' || u.team !== 'red');
    const pinOthers = () => others.forEach((u, i) => { u.gx = 240; u.gy = 20 + i * 1.5; u.hp = u.maxHp; });
    pinOthers();
    const { troop } = cavalryTroop(scene, [[60, 89], [60, 91], [60.5, 90]]);
    scene.battalions.orderHold(troop, 60, 90);
    const archer = addUnit(scene, 'blue', 'archer', 65.5, 90);
    scene.rebuildSpatial();
    run(scene, 5, pinOthers);
    assert.ok(archer.hp < archer.maxHp || archer.dead, `敌弓受到真实打击（${Math.round(archer.hp)}/${archer.maxHp}）`);
});

// ---------- F3 锁步投影缺口：营状态分叉必须直接进哈希 ----------
test('F3 复验①营令分叉（坐标全同）在投影中立即可见——单骑出发 vs 继续集结', () => {
    const make = order => {
        const scene = territoryScene({ territoryAI: false }, { infantry: 4 }, { infantry: 4 });
        scene.rebuildSpatial();
        const others = scene.units.filter(u => u.type !== 'cavalry' || u.team !== 'red');
        others.forEach((u, i) => { u.gx = 240; u.gy = 20 + i * 1.5; u.hp = u.maxHp; });
        const horses = [addUnit(scene, 'red', 'cavalry', 60, 90)];
        scene.battalions.splitOpening(scene.units.filter(u => !u.dead && !u.withdrawn));
        const troop = scene.battalions.battalions.find(b => b.team === 'red' && b.cavalry);
        if (order) scene.battalions.orderBattalion(troop, 2);
        else troop.gathering = true;   // 对照：仍在集结
        scene.rebuildSpatial();
        return { scene, hash: hashProjection(battleProjection(scene)) };
    };
    const a = make(true), b = make(false);
    // 前提：两场景单位坐标/hp 完全一致（差异只在营状态）
    assert.equal(a.scene.units.length, b.scene.units.length);
    for (let i = 0; i < a.scene.units.length; i++) {
        assert.equal(Math.round(a.scene.units[i].gx * 1e4), Math.round(b.scene.units[i].gx * 1e4));
        assert.equal(a.scene.units[i].hp, b.scene.units[i].hp);
    }
    assert.notEqual(a.hash, b.hash, '营令/集结分叉必须改变投影哈希（rework-r2 前此缺口存在：坐标不变则哈希不变）');
});
test('F3 复验②骑兵接管标记分叉（corpsManaged/助跑距离）进投影', () => {
    const scene = territoryScene({ territoryAI: false }, { cavalry: 3 }, { infantry: 4 });
    scene.rebuildSpatial();
    const h1 = hashProjection(battleProjection(scene));
    const rider = scene.units.find(u => u.type === 'cavalry');
    rider.corpsManaged = true; rider.chargeDistance = 3.05;
    const h2 = hashProjection(battleProjection(scene));
    assert.notEqual(h1, h2, 'corpsManaged/量化助跑距离分叉必须改变哈希');
});

// ---------- F4 回撤中断攻建筑：脱战复验 ----------
test('F4 复验：攻塔骑兵收到回撤令立即脱战、塔血止跌、助跑清零', () => {
    const scene = territoryScene({ territoryAI: false }, { infantry: 4 }, { infantry: 4 });
    scene.rebuildSpatial();
    const others = scene.units.slice();
    const pinOthers = () => others.forEach((u, i) => { u.gx = 240; u.gy = 20 + i * 1.5; u.hp = u.maxHp; });
    pinOthers();
    const tower = scene.territory.camps.createBuilding('blue', 'tower', 3, true);
    const { troop } = cavalryTroop(scene, [
        [tower.gx + 2.0, tower.gy], [tower.gx + 2.2, tower.gy + 1.1], [tower.gx + 2.2, tower.gy - 1.1]]);
    scene.rebuildSpatial();
    run(scene, 2, pinOthers);
    const hpAfterSiege = tower.hp;
    assert.ok(hpAfterSiege < tower.maxHp, `攻塔前提成立（${tower.maxHp}→${Math.round(hpAfterSiege)}）`);
    assert.equal(scene.battalions.orderBattalion(troop, 'home'), true);
    const startX = troop.center().gx;
    run(scene, 1.5, pinOthers);
    const moved = startX - troop.center().gx;
    const hpAt15 = tower.hp;
    run(scene, 1.5, pinOthers);
    assert.ok(moved > 3, `回撤令 1.5 秒内脱战西移 ${moved.toFixed(1)} 格`);
    assert.equal(tower.hp, hpAt15, `回撤后塔血止跌（${Math.round(hpAt15)} 冻结 3 秒）`);
    assert.ok(troop.aliveMembers().every(c => c.chargeDistance === 0), '接管转换清理助跑');
});

// ---------- F13 回撤路径陈旧承诺：复位提前到回撤 return 之前 ----------
// 用户场景复刻：驻守出界触发返程承诺 → 回撤 30 帧（清驻点）→ 新驻守令贴敌 → 3 秒判定。
// 修复断言①：回撤阶段承诺已被复位（复位先于回撤 return——F13 修复点）；
// 修复断言②：新驻守 3 秒内敌人掉血。
// 敏感性对照（病理模型）：用存取器把 leashReturning 钉为永真（模拟复位失效、承诺跨令存活），
// 断言病理态敌人血量显著高于修复态——证明本场景对陈旧承诺可判别。
test('F13 复验：回撤后新驻守令不被陈旧返程承诺压制（3 秒内敌人掉血）', () => {
    const build = stale => {
        const scene = territoryScene({ territoryAI: false }, { infantry: 4 }, { infantry: 4 });
        scene.rebuildSpatial();
        const others = scene.units.filter(u => u.type !== 'cavalry' || u.team !== 'red');
        const pinOthers = () => others.forEach((u, i) => { u.gx = 240; u.gy = 20 + i * 1.5; u.hp = u.maxHp; });
        pinOthers();
        const { troop } = cavalryTroop(scene, [[67.2, 89], [67.2, 91], [67.7, 90]]);   // 稳健缰绳 7 外
        scene.battalions.orderHold(troop, 60, 90);
        const archer = addUnit(scene, 'blue', 'archer', 72, 90);
        archer.hp = archer.maxHp = 3000;
        scene.rebuildSpatial();
        if (stale) {
            // 病理模型：承诺永真（复位被绕过/失效的陈旧承诺）
            for (const c of troop.aliveMembers()) {
                Object.defineProperty(c, 'leashReturning', { configurable: true, get: () => true, set: () => {} });
            }
        }
        // 阶段一：驻守出界，跑出返程承诺
        for (let i = 0; i < 60 * 2 && !troop.aliveMembers().some(c => c.leashReturning); i++) {
            pinOthers(); scene.advanceBattle(STEP);
        }
        // 阶段二：回撤 30 帧 → 检查承诺复位 → 新驻守（贴敌方向）→ 3 秒判定
        scene.battalions.orderBattalion(troop, 'home');
        for (let i = 0; i < 30; i++) { pinOthers(); scene.advanceBattle(STEP); }
        const clearedAfterRetreat = !troop.aliveMembers().some(c => c.leashReturning);
        scene.battalions.orderHold(troop, 68.5, 90);   // 新驻守点在敌弓以西 3.5 格（6 格交还圈内）
        for (let i = 0; i < 60 * 3; i++) { pinOthers(); scene.advanceBattle(STEP); }
        return { archerHp: archer.hp, clearedAfterRetreat };
    };
    const fixed = build(false);
    assert.ok(fixed.clearedAfterRetreat, '回撤 30 帧后返程承诺已复位（复位先于回撤 return，F13 修复点）');
    assert.ok(fixed.archerHp < 3000, `修复态：新驻守 3 秒内敌人掉血（${fixed.archerHp}/3000）`);
    const stale = build(true);
    assert.ok(stale.archerHp > fixed.archerHp, `病理对照（承诺永真）：敌血 ${stale.archerHp} 显著高于修复态 ${fixed.archerHp}——场景可判别`);
});
