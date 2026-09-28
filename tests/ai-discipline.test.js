// AI 纪律批次1：目标粘滞（A） / 弓手火力纪律（B） / 矛兵遇骑结阵（E）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeScene, addUnit } = require('./battle-harness.js');

const STEP = 1000 / 60;

test('目标粘滞：换目标需显著更优（近20%+）', () => {
    const scene = makeScene();
    const unit = addUnit(scene, 'red', 'infantry', 30, 30);
    const current = addUnit(scene, 'blue', 'infantry', 34, 30);
    const other = addUnit(scene, 'blue', 'infantry', 30, 33.5);
    scene.rebuildSpatial();
    unit.meleeTarget = current;
    assert.equal(scene.stickyTarget(unit), current, '仅12.5%更近，保持当前目标');
    other.gy = 32.8;
    scene.rebuildSpatial();
    assert.equal(scene.stickyTarget(unit), other, '30%更近，切换目标');
    current.moraleState = 'routing';
    assert.equal(scene.stickyTarget(unit), other, '近得多才切换，溃逃中的旧目标不特殊处理');
    current.dead = true;
    scene.rebuildSpatial();
    assert.equal(scene.stickyTarget(unit), other, '当前目标倒下后跟随最近');
});

test('目标粘滞：无目标时取最近敌', () => {
    const scene = makeScene();
    const unit = addUnit(scene, 'red', 'infantry', 30, 30);
    const far = addUnit(scene, 'blue', 'infantry', 33, 30);
    const near = addUnit(scene, 'blue', 'infantry', 30, 31);
    scene.rebuildSpatial();
    assert.equal(scene.stickyTarget(unit), near);
    assert.equal(unit.meleeTarget, near);
});

test('火力纪律：弓手优先射冲向己方的敌骑而非残血步兵', () => {
    const scene = makeScene();
    const archer = addUnit(scene, 'red', 'archer', 30, 30);
    archer.lastAttack = -9999;
    const rider = addUnit(scene, 'blue', 'cavalry', 34, 30);
    rider.state = 'charge'; rider.chargeDX = -1; rider.chargeDY = 0;
    const wounded = addUnit(scene, 'blue', 'infantry', 30, 34);
    wounded.hp = 5;
    scene.rebuildSpatial();
    for (let i = 0; i < 12 && !scene.arrows.length; i++) scene.advanceBattle(STEP);
    assert.ok(scene.arrows.length, '应已放箭');
    const arrow = scene.arrows[0];
    assert.ok(Math.hypot(arrow.tx - rider.gx, arrow.ty - rider.gy) < 2.2, `箭落点应逼近敌骑，实际 (${arrow.tx.toFixed(1)},${arrow.ty.toFixed(1)})`);
    assert.ok(Math.hypot(arrow.tx - wounded.gx, arrow.ty - wounded.gy) > 3, '不应射残血步兵');
});

test('火力纪律：无冲锋威胁时照旧集火残血', () => {
    const scene = makeScene();
    const archer = addUnit(scene, 'red', 'archer', 30, 30);
    archer.lastAttack = -9999;
    const rider = addUnit(scene, 'blue', 'cavalry', 34, 30);
    rider.state = 'melee';
    const wounded = addUnit(scene, 'blue', 'infantry', 30, 34);
    wounded.hp = 5;
    scene.rebuildSpatial();
    for (let i = 0; i < 12 && !scene.arrows.length; i++) scene.advanceBattle(STEP);
    assert.ok(scene.arrows.length, '应已放箭');
    const arrow = scene.arrows[0];
    assert.ok(Math.hypot(arrow.tx - wounded.gx, arrow.ty - wounded.gy) < 1.5, '应集火残血步兵');
});

test('遇骑结阵：行军矛兵停步架枪迎击正面冲锋', () => {
    const scene = makeScene();
    const pikes = [-0.6, 0, 0.6].map(off => addUnit(scene, 'red', 'pikeman', 30, 30 + off));
    const rider = addUnit(scene, 'blue', 'cavalry', 36, 30);
    rider.state = 'charge'; rider.chargeDX = -1; rider.chargeDY = 0; rider.chargeDistance = 3;
    scene.rebuildSpatial();
    scene.advanceBattle(STEP);
    assert.equal(pikes[1].moving, false, '矛兵应停步结阵而不是继续行军');
    assert.equal(pikes[0].moving, false);
    for (let i = 0; i < 35; i++) scene.advanceBattle(STEP);
    assert.equal(pikes[1].braceReady, true, '停稳半秒后应完成架枪（撞击前）');
    for (let i = 0; i < 40; i++) scene.advanceBattle(STEP);
    assert.ok(scene.getBattleReport().events.some(e => e.text.includes('枪阵迎击')),
        '正面冲锋应被架好的枪阵迎击');
});

test('遇骑结阵：非冲锋威胁不触发停步', () => {
    const scene = makeScene();
    const pikes = [-0.6, 0, 0.6].map(off => addUnit(scene, 'red', 'pikeman', 30, 30 + off));
    const rider = addUnit(scene, 'blue', 'cavalry', 36, 30);
    rider.state = 'melee';
    scene.rebuildSpatial();
    scene.advanceBattle(STEP);
    assert.equal(pikes[1].moving, true, '站立敌骑不触发停步，照常逼近接战');
});
