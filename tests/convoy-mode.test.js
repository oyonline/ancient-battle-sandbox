// 护送模式：车队创建 / 有保护才前进 / 敌情闸门 / 到站与劫走计数 / 胜负判定 / 护送军集结 / 劫持拔河 / 劫掠军占车
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit, UNIT_TYPES } from './battle-harness.js';

const STEP = 1000 / 60;

function convoyScene(armies) {
    const scene = makeScene();
    scene.deployUnits(armies?.red ?? { infantry: 8 }, armies?.blue ?? { infantry: 8 },
        'custom', 'custom', {}, { convoy: true });
    scene.battleStarted = true;
    return scene;
}

test('护送：部署创建 4 辆辎重车（护送方红），不可购买', () => {
    const scene = convoyScene();
    assert.equal(scene.convoy.wagons.length, 4);
    assert.ok(scene.convoy.wagons.every(w => w.type === 'wagon' && w.team === 'red'));
    assert.ok(scene.convoy.wagons.every(w => w.tacticalRole === 'convoy_wagon'));
    assert.equal(UNIT_TYPES.wagon.hidden, true, '辎重车不进入配兵界面');
    assert.equal(scene.convoy.need, 3);
});

test('护送：车队只在护卫 3.5 格内才前进，无保护停下等待', () => {
    // 红方不部署军队（只有车队），避免赶来的步兵持续提供保护干扰"停"的断言
    const scene = convoyScene({ red: {}, blue: { infantry: 2 } });
    // 护卫摆在队尾车侧翼（行进路径之外），不挡车队的前进方向
    const tail = scene.convoy.wagons.reduce((a, b) => (b.gx < a.gx ? b : a));
    const guard = addUnit(scene, 'red', 'infantry', tail.gx, tail.gy + 1);
    scene.rebuildSpatial();
    const x0 = tail.gx;
    for (let i = 0; i < 60 * 4; i++) scene.advanceBattle(STEP);
    assert.ok(tail.gx > x0 + 1, '有护卫随行时车队应前进');
    // 护卫离场：车队停下
    guard.dead = true;
    scene.rebuildSpatial();
    const x1 = tail.gx;
    for (let i = 0; i < 60 * 4; i++) scene.advanceBattle(STEP);
    assert.ok(Math.abs(tail.gx - x1) < 0.05, '无护卫时车队原地等待');
});

test('护送：敌情未清时车队停车列队，清完威胁恢复前进', () => {
    const scene = convoyScene({ red: {}, blue: { infantry: 1 } });
    const tail = scene.convoy.wagons.reduce((a, b) => (b.gx < a.gx ? b : a));
    const guard = addUnit(scene, 'red', 'infantry', tail.gx, tail.gy + 1);   // 护卫随行
    const raider = scene.units.find(u => u.team === 'blue');                 // 劫掠兵压到贴脸
    raider.gx = tail.gx + 3.0; raider.gy = tail.gy;
    scene.rebuildSpatial();
    const x0 = tail.gx;
    for (let i = 0; i < 60 * 3; i++) scene.advanceBattle(STEP);
    assert.ok(Math.abs(tail.gx - x0) < 0.05, '敌情在 3.2 格内：车队应停车列队');
    raider.dead = true; guard.gx = tail.gx; guard.gy = tail.gy + 1;          // 威胁清除
    scene.rebuildSpatial();
    for (let i = 0; i < 60 * 3; i++) scene.advanceBattle(STEP);
    assert.ok(tail.gx > x0 + 0.5, '敌情解除后车队恢复前进');
});

test('护送：送抵 3 辆判红胜（endReason=convoy）', () => {
    const scene = convoyScene();
    for (const w of scene.convoy.wagons.slice(0, 3)) w.gx = scene.convoy.goalX + 0.5;
    scene.rebuildSpatial();
    scene.updateConvoy(STEP / 1000);
    assert.equal(scene.convoy.delivered, 3);
    scene.checkWin();
    assert.ok(scene.battleOver);
    assert.equal(scene.winner, 'red');
    assert.equal(scene.endReason, 'convoy');
});

test('劫持：车不可被攻击，蓝方占住车身拉进度，拉满即遭劫走', () => {
    const scene = convoyScene({ red: {}, blue: { infantry: 1 } });
    const wagon = scene.convoy.wagons[0];
    const raider = scene.units.find(u => u.team === 'blue');
    raider.gx = wagon.gx + 1; raider.gy = wagon.gy;
    scene.rebuildSpatial();
    // 车不在索敌结果里——最近的蓝兵也选不出车
    assert.notEqual(scene.nearestEnemy(raider)?.type, 'wagon');
    assert.equal(scene.nearestEnemy(wagon)?.type, 'infantry', '车的索敌正常找到劫掠兵');
    // 蓝独占车身：6 秒拉满劫走
    for (let i = 0; i < 60 * 6.5; i++) scene.advanceBattle(STEP);
    assert.ok(wagon.hijacked && wagon.withdrawn, '蓝方占住 6 秒应劫走辎重车');
    assert.equal(scene.convoy.hijacked, 1);
    scene.checkWin();
    assert.equal(scene.battleOver, false, '劫走 1 辆尚未达胜利线');
});

test('劫持：护卫在场进度冻结，独占时较快夺回', () => {
    const scene = convoyScene({ red: {}, blue: { infantry: 1 } });
    const wagon = scene.convoy.wagons[0];
    const raider = scene.units.find(u => u.team === 'blue');
    raider.gx = wagon.gx + 1.2; raider.gy = wagon.gy;
    scene.rebuildSpatial();
    for (let i = 0; i < 60 * 3; i++) scene.advanceBattle(STEP);          // 蓝 3 秒：进度约 0.5
    const half = wagon.hijack;
    assert.ok(half > 0.4 && half < 0.6, `3 秒进度应过半（实际 ${half.toFixed(2)}）`);
    const guard = addUnit(scene, 'red', 'infantry', wagon.gx - 1.2, wagon.gy);   // 护卫赶回
    scene.rebuildSpatial();
    for (let i = 0; i < 60 * 1; i++) scene.advanceBattle(STEP);          // 冻结+护卫在场
    assert.ok(Math.abs(wagon.hijack - half) < 0.05 || wagon.hijack <= half, '护卫在场进度不得上涨');
    raider.dead = true;                                                  // 劫掠兵被清：快速夺回
    scene.rebuildSpatial();
    for (let i = 0; i < 60 * 3; i++) scene.advanceBattle(STEP);
    assert.ok(wagon.hijack <= 0.01, '护卫独占应较快清空劫持进度');
    assert.ok(!wagon.hijacked, '车未被劫走');
});

test('劫持：劫走 3 辆判蓝胜（endReason=convoy）', () => {
    const scene = convoyScene();
    scene.convoy.hijacked = 3;                       // 直接置计数：本用例只验证胜负判定
    scene.checkWin();
    assert.ok(scene.battleOver);
    assert.equal(scene.winner, 'blue');
    assert.equal(scene.endReason, 'convoy');
});

test('护送：2:2 全结算时不提前判定，交回常规胜负路径', () => {
    const scene = convoyScene();
    scene.convoy.delivered = 2;                      // 直接置计数：本用例只验证胜负判定
    scene.convoy.hijacked = 2;
    assert.equal(scene.convoyOutcome(), null, '2:2 平分不应单方面判胜');
    scene.checkWin();
    assert.equal(scene.battleOver, false, '常规判定继续（双方步兵仍在）');
});

test('护送 AI：护送军敌远时向最落后的车集结', () => {
    const scene = convoyScene({ red: { infantry: 10 }, blue: { archer: 2 } });
    const tail = scene.convoy.wagons.reduce((a, b) => (b.gx < a.gx ? b : a));
    const soldier = scene.units.find(u => u.team === 'red' && u.type === 'infantry' && !u.dead);
    soldier.gx = tail.gx - 9; soldier.gy = tail.gy;      // 摆在队尾车后方 9 格
    scene.units.filter(u => u.team === 'blue').forEach(u => { u.gx = 2; u.gy = 2; });   // 蓝弓挪远角
    scene.rebuildSpatial();
    const d0 = Math.hypot(soldier.gx - tail.gx, soldier.gy - tail.gy);
    for (let i = 0; i < 60 * 3; i++) scene.advanceBattle(STEP);
    const d1 = Math.hypot(soldier.gx - tail.gx, soldier.gy - tail.gy);
    assert.ok(d1 < d0 - 1, `护送兵应向队尾车集结（${d0.toFixed(1)} → ${d1.toFixed(1)}）`);
});

test('劫掠 AI：敌远时蓝兵主动扑向守备最薄的车', () => {
    const scene = convoyScene({ red: { infantry: 1 }, blue: { infantry: 4 } });
    const target = scene.convoy.wagons[0];
    // 红兵挪远角：既在场（蓝兵索敌有目标、不触发占车分支的敌远前提也满足），又远离车队不添守备
    const redUnit = scene.units.find(u => u.team === 'red');
    redUnit.gx = 2; redUnit.gy = 2;
    const raiders = scene.units.filter(u => u.team === 'blue');
    raiders.forEach((u, i) => { u.gx = target.gx + 14; u.gy = target.gy + i * 0.5; });
    scene.rebuildSpatial();
    const d0 = Math.hypot(raiders[0].gx - target.gx, raiders[0].gy - target.gy);
    for (let i = 0; i < 60 * 3; i++) scene.advanceBattle(STEP);
    const d1 = Math.hypot(raiders[0].gx - target.gx, raiders[0].gy - target.gy);
    assert.ok(d1 < d0 - 1, `蓝兵应向无守备的车移动占圈（${d0.toFixed(1)} → ${d1.toFixed(1)}）`);
    const closer = raiders.filter(u => Math.hypot(u.gx - target.gx, u.gy - target.gy) <
        Math.hypot(target.gx + 14 - target.gx, 0)).length;
    assert.ok(closer >= 3, `蓝兵应集体扑车（${closer}/4 靠近）`);
});

test('劫持圈 3.0：站桩护卫(2.6)在场即冻结，独占才拉条', () => {
    const scene = convoyScene({ red: {}, blue: { infantry: 1 } });
    const wagon = scene.convoy.wagons[0];
    const raider = scene.units.find(u => u.team === 'blue');
    raider.gx = wagon.gx + 1; raider.gy = wagon.gy;
    // 护卫摆在集结偏移 2.6——恰在旧圈(2.5)外沿、新圈(3.0)内：必须算"在场冻结"
    const guard = addUnit(scene, 'red', 'infantry', wagon.gx, wagon.gy + 2.6);
    scene.rebuildSpatial();
    scene.updateConvoy(3);                                 // 直接驱动计数：混合在场不拉条
    assert.ok((wagon.hijack || 0) < 0.01, '圈内红方在场：进度冻结为 0');
    guard.dead = true;
    scene.rebuildSpatial();
    scene.updateConvoy(3);
    assert.ok(wagon.hijack > 0.4, `红方清场后蓝独占应拉条（实际 ${wagon.hijack.toFixed(2)}）`);
});

test('敌情闸门：溃逃中的蓝兵不算威胁，车队照常前进', () => {
    const scene = convoyScene({ red: {}, blue: { infantry: 1 } });
    const tail = scene.convoy.wagons.reduce((a, b) => (b.gx < a.gx ? b : a));
    addUnit(scene, 'red', 'infantry', tail.gx, tail.gy + 1);   // 护卫随行
    const raider = scene.units.find(u => u.team === 'blue');
    raider.gx = tail.gx + 2.5; raider.gy = tail.gy; raider.moraleState = 'routing';
    scene.rebuildSpatial();
    const x0 = tail.gx;
    scene.updateNormalUnit(tail, 0, STEP / 1000);          // 直接驱动车的行进门
    assert.ok(tail.gx > x0 + 0.01, '溃逃蓝兵贴脸(3.2内)不应拦停车队');
    raider.moraleState = null;                             // 恢复战斗状态：威胁成立
    scene.rebuildSpatial();
    const x1 = tail.gx;
    scene.updateNormalUnit(tail, 0, STEP / 1000);
    assert.ok(Math.abs(tail.gx - x1) < 1e-9, '有战斗力的蓝兵贴脸应拦停车队');
});

test('劫持速度按占车人数缩放（sqrt，封顶 ×2）', () => {
    const scene = convoyScene({ red: {}, blue: { infantry: 5 } });
    const w0 = scene.convoy.wagons[0], w2 = scene.convoy.wagons[2];
    const blues = scene.units.filter(u => u.team === 'blue');
    blues[0].gx = w0.gx - 1; blues[0].gy = w0.gy;          // 1 人独占 w0
    for (let i = 1; i <= 4; i++) {                         // 4 人独占 w2（互相间距 >0，均圈内）
        blues[i].gx = w2.gx + (i % 2 ? 1 : -1);
        blues[i].gy = w2.gy + (i <= 2 ? 1 : -1);
    }
    scene.rebuildSpatial();
    scene.updateConvoy(1.5);
    assert.ok(Math.abs(w0.hijack - 0.25) < 0.01, `1 人 1.5 秒应拉 0.25（实际 ${w0.hijack.toFixed(2)}）`);
    assert.ok(Math.abs(w2.hijack - 0.5) < 0.01, `4 人(sqrt=2) 1.5 秒应拉 0.5（实际 ${w2.hijack.toFixed(2)}）`);
});
