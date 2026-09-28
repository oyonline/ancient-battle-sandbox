// AI 纪律：目标粘滞（A） / 弓手火力纪律（B） / 骑兵绕枪墙（C） / 矛兵遇骑结阵（E）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeScene, addUnit } = require('./battle-harness.js');

const STEP = 1000 / 60;

function wallPike(scene, x, y, facingX = -1) {
    const p = addUnit(scene, 'blue', 'pikeman', x, y);
    p.moving = false; p.braceSupport = 2;
    p.braceFacingX = facingX; p.braceFacingY = 0;
    return p;
}

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

test('绕枪墙：正面停步矛簇迫使冲锋落点垂直偏移', () => {
    const scene = makeScene();
    const rider = addUnit(scene, 'red', 'cavalry', 20, 30);
    const archer = addUnit(scene, 'blue', 'archer', 30, 30);
    [29.3, 30, 30.7].forEach(gy => wallPike(scene, 26, gy));
    scene.rebuildSpatial();
    const aim = scene.cavalryAI.detourPikes(rider, archer);
    assert.ok(Math.abs(aim.gx - archer.gx) < 0.01, `偏移应垂直于冲锋线，实际 x=${aim.gx.toFixed(2)}`);
    const offset = Math.abs(aim.gy - archer.gy);
    assert.ok(offset >= 2.4 && offset <= 6, `偏移量应在2.4~6格，实际 ${offset.toFixed(2)}`);
});

test('绕枪墙：躲开墙簇重心所在的一侧', () => {
    const scene = makeScene();
    const rider = addUnit(scene, 'red', 'cavalry', 20, 30);
    const archer = addUnit(scene, 'blue', 'archer', 30, 30);
    [30, 30.7, 31.4].forEach(gy => wallPike(scene, 26, gy));   // 墙整体在冲锋线上侧
    scene.rebuildSpatial();
    const aim = scene.cavalryAI.detourPikes(rider, archer);
    assert.ok(aim.gy < archer.gy - 2, `墙在上侧应从下侧绕行，实际落点 y=${aim.gy.toFixed(2)}`);
});

test('绕枪墙：行军中的矛簇不是墙', () => {
    const scene = makeScene();
    const rider = addUnit(scene, 'red', 'cavalry', 20, 30);
    const archer = addUnit(scene, 'blue', 'archer', 30, 30);
    const pikes = [29.3, 30, 30.7].map(gy => wallPike(scene, 26, gy));
    pikes.forEach(p => { p.moving = true; });
    scene.rebuildSpatial();
    const aim = scene.cavalryAI.detourPikes(rider, archer);
    assert.equal(aim, archer, '矛簇在行军应直冲，骑踏散兵');
});

test('绕枪墙：不成排的散矛不算墙', () => {
    const scene = makeScene();
    const rider = addUnit(scene, 'red', 'cavalry', 20, 30);
    const archer = addUnit(scene, 'blue', 'archer', 30, 30);
    const lone = wallPike(scene, 26, 30);
    lone.braceSupport = 0;   // 孤矛无邻兵支持
    scene.rebuildSpatial();
    const aim = scene.cavalryAI.detourPikes(rider, archer);
    assert.equal(aim, archer, '单支长枪无成阵支持，不触发绕行');
});

test('绕枪墙：枪口背对来路不构成正面威胁', () => {
    const scene = makeScene();
    const rider = addUnit(scene, 'red', 'cavalry', 20, 30);
    const archer = addUnit(scene, 'blue', 'archer', 30, 30);
    [29.3, 30, 30.7].forEach(gy => wallPike(scene, 26, gy, 1));   // 枪口朝 +x（背对骑兵）
    scene.rebuildSpatial();
    const aim = scene.cavalryAI.detourPikes(rider, archer);
    assert.equal(aim, archer, '枪口背对来路的矛兵迎面骑踏即可');
});

test('绕枪墙：侧翼远墙枪尖够不到冲锋线不绕', () => {
    const scene = makeScene();
    const rider = addUnit(scene, 'red', 'cavalry', 20, 30);
    const archer = addUnit(scene, 'blue', 'archer', 30, 30);
    [26.5, 27, 27.5].forEach(gy => wallPike(scene, 26, gy));   // 离冲锋线约3格
    scene.rebuildSpatial();
    const aim = scene.cavalryAI.detourPikes(rider, archer);
    assert.equal(aim, archer, '3格外侧翼矛簇够不到冲锋线，无需绕行');
});

test('绕枪墙：距离太近来不及绕', () => {
    const scene = makeScene();
    const rider = addUnit(scene, 'red', 'cavalry', 26.9, 30);
    const archer = addUnit(scene, 'blue', 'archer', 30, 30);
    [29.3, 30, 30.7].forEach(gy => wallPike(scene, 28.3, gy));
    scene.rebuildSpatial();
    const aim = scene.cavalryAI.detourPikes(rider, archer);
    assert.equal(aim, archer, '目标3.1格内硬着头皮直冲');
});

test('绕枪墙（行为级）：冲锋骑兵绕开架枪矛墙命中墙后弓手', () => {
    const scene = makeScene();
    const rider = addUnit(scene, 'red', 'cavalry', 19, 30);
    const archer = addUnit(scene, 'blue', 'archer', 30, 30);
    [29.3, 30, 30.7].forEach(gy => addUnit(scene, 'blue', 'pikeman', 24, gy));
    scene.rebuildSpatial();
    let swung = false;
    for (let i = 0; i < 240; i++) {
        scene.advanceBattle(STEP);
        swung ||= Math.abs(rider.gy - 30) >= 1;
        if (rider.dead || archer.dead) break;
    }
    assert.ok(!rider.dead, '骑兵应活着绕过枪墙');
    assert.ok(swung, '骑兵应侧向绕行而非正面撞墙');
    assert.ok(archer.dead || archer.hp < archer.maxHp, '骑兵应冲到墙后弓手');
    assert.ok(!scene.getBattleReport().events.some(e => e.text.includes('枪阵迎击')),
        '不应触发枪阵迎击（正面撞架好的枪墙）');
});
