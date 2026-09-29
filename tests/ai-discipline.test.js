// AI 纪律：目标粘滞（A） / 弓手火力纪律（B） / 骑兵绕枪墙（C） / 守骑侧翼反冲（D） / 矛兵遇骑结阵（E）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit, TacticsSystem } from './battle-harness.js';

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

// ---------- D 守骑侧翼反冲：敌线咬合后一翼守骑冲击敌线侧后，得手/失败均返锚 ----------
// 手工构造守区组：上翼3骑+下翼1骑（选翼应取上翼）、前排矛与敌步兵贴身（咬合）、敌弓在敌后。
function raidScene({ bite = true, foeArchers = true } = {}) {
    const scene = makeScene();
    scene.tactics = new TacticsSystem(scene, { red: 'advance', blue: 'advance' });   // 空壳：不触发任何布阵
    const riders = [[20, 27], [20, 28.5], [20, 30], [20, 39]].map(([x, y]) => {
        const u = addUnit(scene, 'red', 'cavalry', x, y);
        Object.assign(u, { tacticalRole: 'ground_guard', guardAnchor: { gx: x, gy: y },
            guardRadius: 20, protectArchers: true, guardLocalRadius: 6,
            groundGuardTarget: null, groundGuardReturning: false });
        return u;
    });
    const front = [32, 33, 34].map(y => addUnit(scene, 'red', 'pikeman', 24, y));
    [32, 34].forEach(y => addUnit(scene, 'red', 'archer', 16, y));
    const foes = [32, 33, 34].map(y => addUnit(scene, 'blue', 'infantry', bite ? 25.3 : 50, y));
    if (foeArchers) [29, 31].forEach(y => addUnit(scene, 'blue', 'archer', 45, y));
    scene.tactics.groundGuards.red = { team: 'red', cx: 20, cy: 33,
        members: [...riders, ...front], nextRaidCheck: 0 };
    scene.rebuildSpatial();
    return { scene, riders };
}

test('侧翼反冲：战线咬稳后守骑自多的一翼出击敌线侧后', () => {
    const { scene, riders } = raidScene();
    for (let i = 0; i < 60 * 6; i++) scene.advanceBattle(STEP);
    const raiding = riders.filter(u => u.counterRaid);
    assert.equal(raiding.length, 3, '无敌骑威胁时弓纵深突击成波出击（3骑）');
    assert.ok(raiding.every(u => u.guardAnchor.gy < 33), '出击的应全是上翼守骑');
    assert.ok(raiding.every(u => u.counterRaid.gx > 30), '冲击点应在敌半场侧后（敌弓纵深）');
});

test('侧翼反冲：得手/失败均按计时收手返锚', () => {
    const { scene, riders } = raidScene();
    for (let i = 0; i < 60 * 14; i++) scene.advanceBattle(STEP);
    assert.ok(riders.every(u => !u.counterRaid), '8秒突击窗结束（或失血过半/无目标）后收手');
    assert.ok(riders.some(u => !u.dead && Math.hypot(u.gx - u.guardAnchor.gx, u.gy - u.guardAnchor.gy) < 20.5),
        '存活的出击骑应回到锚区（守骑本职是护弓）');
});

test('侧翼反冲：战线未咬合不出击', () => {
    const { scene, riders } = raidScene({ bite: false });
    for (let i = 0; i < 60 * 8; i++) scene.advanceBattle(STEP);
    assert.ok(riders.every(u => !u.counterRaid), '敌线未贴上守区前排，守骑不冒险出击');
});

test('侧翼反冲：无敌弓且战线未被压不出击', () => {
    const { scene, riders } = raidScene({ bite: false, foeArchers: false });
    for (let i = 0; i < 60 * 8; i++) scene.advanceBattle(STEP);
    assert.ok(riders.every(u => !u.counterRaid), '没有软目标也没有敌压门，守骑安稳守位');
});

test('侧翼反冲：敌弓清光但敌步仍压前排时转为冲击敌线侧腰', () => {
    const { scene, riders } = raidScene({ foeArchers: false });
    for (let i = 0; i < 60 * 6; i++) scene.advanceBattle(STEP);
    const raiding = riders.filter(u => u.counterRaid);
    assert.ok(raiding.length >= 2, '敌步压门时守骑应作为预备队出击侧腰，不能全程旁观');
    const foeLineX = 25.3;                                   // 敌步贴我前排的横线
    assert.ok(raiding.every(u => Math.abs(u.counterRaid.gx - foeLineX) <= 3.5),
        '侧腰冲击点应落在压境敌线附近（不加纵深后向偏移）');
});

// ---------- F 战线连贯（轻量）：未接战剑士与脱节邻兵互相收拢，肩并肩推进 ----------
test('战线连贯：脱节剑士推进中向邻兵收拢', () => {
    const scene = makeScene();
    const a = addUnit(scene, 'red', 'infantry', 30, 28);
    const b = addUnit(scene, 'red', 'infantry', 34, 32);
    const foe = addUnit(scene, 'blue', 'infantry', 48, 30);
    scene.rebuildSpatial();
    const gap0 = Math.hypot(a.gx - b.gx, a.gy - b.gy);
    for (let i = 0; i < 120 && !foe.dead; i++) scene.advanceBattle(STEP);
    const gap = Math.hypot(a.gx - b.gx, a.gy - b.gy);
    assert.ok(gap < gap0 - 0.6, `横向脱节的邻兵应在推进中收拢（${gap0.toFixed(2)} → ${gap.toFixed(2)}）`);
    assert.ok(!a.dead && !b.dead, '凝聚不应带来伤亡');
});

test('战线连贯：邻兵未脱节时不干预正常追敌', () => {
    const scene = makeScene();
    const a = addUnit(scene, 'red', 'infantry', 30, 30);
    const b = addUnit(scene, 'red', 'infantry', 31.2, 30);
    const foe = addUnit(scene, 'blue', 'infantry', 38, 31.5);
    scene.rebuildSpatial();
    for (let i = 0; i < 240 && !foe.dead; i++) scene.advanceBattle(STEP);
    const gap = Math.hypot(a.gx - b.gx, a.gy - b.gy);
    assert.ok(gap <= 2.2, `并肩的邻兵不应被拉开成散兵线（间距 ${gap.toFixed(2)}）`);
    assert.ok(foe.dead || foe.hp < foe.maxHp, '两人应正常接敌输出');
});
