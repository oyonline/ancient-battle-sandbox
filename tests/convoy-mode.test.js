// 护送模式：车队创建 / 有保护才前进 / 到站与摧毁计数 / 胜负判定 / 护送军集结
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeScene, addUnit, UNIT_TYPES } = require('./battle-harness.js');

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
    const raider = scene.units.find(u => u.team === 'blue');                 // 劫掠兵压到 6 格外
    raider.gx = tail.gx + 6.2; raider.gy = tail.gy;
    scene.rebuildSpatial();
    const x0 = tail.gx;
    for (let i = 0; i < 60 * 3; i++) scene.advanceBattle(STEP);
    assert.ok(Math.abs(tail.gx - x0) < 0.05, '敌情在 7 格内：车队应停车列队');
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

test('护送：被毁 3 辆判蓝胜（endReason=convoy）', () => {
    const scene = convoyScene();
    for (const w of scene.convoy.wagons.slice(0, 3)) w.dead = true;
    scene.updateConvoy(STEP / 1000);
    assert.equal(scene.convoy.destroyed, 3);
    scene.checkWin();
    assert.ok(scene.battleOver);
    assert.equal(scene.winner, 'blue');
    assert.equal(scene.endReason, 'convoy');
});

test('护送：2:2 全结算时不提前判定，交回常规胜负路径', () => {
    const scene = convoyScene();
    scene.convoy.wagons[0].gx = scene.convoy.goalX + 0.5;
    scene.convoy.wagons[1].gx = scene.convoy.goalX + 0.5;
    scene.convoy.wagons[2].dead = true;
    scene.convoy.wagons[3].dead = true;
    scene.updateConvoy(STEP / 1000);
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
