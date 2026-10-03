// S1 骑兵独立组织：开局独立骑队 / 增援独立集结池 / 3骑成队门槛 / 独立行军速度 / 池生命周期
// 复现基线缺陷：开局按纵向三等分不区分兵种，3骑被拆 2+1 混进步战营；
// 增援骑兵与步兵共用同一个集结池（攒8人/超时5人起步），小骑队永远蹲家。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene } from './battle-harness.js';
import { TERRITORY } from '../js/battle/economy.js';
import { BATTALION } from '../js/battle/battalion.js';

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

function redBattalions(scene) {
    return scene.battalions.battalions.filter(b => b.team === 'red');
}

// 蓝军钉死远角：隔离变量，只观察红方编组/行军
function pinFoes(scene, gx = 250, gy = 60) {
    const foes = scene.units.filter(u => u.team === 'blue');
    return () => foes.forEach((u, i) => { u.gx = gx; u.gy = gy + i * 1.2; u.hp = u.maxHp; });
}

// 马场门禁：征骑兵需先占一座马场（模拟态，与 lockstep 口径一致）
function unlockRanch(scene, team = 'red') {
    const ranch = scene.flags.find(f => f.role === 'ranch');
    ranch.owner = team;
    ranch.progress = team === 'red' ? 1 : -1;
    return ranch;
}

// 基线步战营组织方式：非骑兵按 gy 稳定排序（id 决胜）后三等分
function expectedFootLanes(scene, team) {
    const foot = scene.units.filter(u => u.team === team && !u.dead && !u.withdrawn && u.type !== 'worker' && u.type !== 'cavalry');
    foot.sort((a, b) => a.gy - b.gy || a.id - b.id);
    const lanes = Math.min(BATTALION.OPENING_LANES, foot.length);
    const out = [];
    for (let lane = 0; lane < lanes; lane++) {
        const from = Math.floor(lane * foot.length / lanes), to = Math.floor((lane + 1) * foot.length / lanes);
        out.push(foot.slice(from, to).map(u => u.id).sort((a, b) => a - b));
    }
    return out;
}

test('开局编组：骑兵整编独立骑队，步战营保留纵向三等分且无空营', () => {
    const scene = territoryScene();
    for (const team of ['red', 'blue']) {
        const mine = scene.battalions.battalions.filter(b => b.team === team);
        const cavTroops = mine.filter(b => b.members.length && b.members.every(u => u.type === 'cavalry'));
        assert.equal(cavTroops.length, 1, `${team} 默认开局3骑整编为一个独立骑队`);
        assert.equal(cavTroops[0].members.length, 3, '骑队容纳全部3名开局骑兵');
        assert.equal(cavTroops[0].gathering, false, '开局骑队是成建制作战营');
        const cavalry = scene.units.filter(u => u.team === team && u.type === 'cavalry');
        assert.deepEqual([...cavTroops[0].members].map(u => u.id).sort((a, b) => a - b),
            cavalry.map(u => u.id).sort((a, b) => a - b), '开局骑兵全员在骑队、零散兵');
        // 步战营：三等分结构原样保留（非骑兵集合的纵向三等分），且不含骑兵
        const footTroops = mine.filter(b => b !== cavTroops[0]);
        assert.equal(footTroops.length, 3, '步战营仍为上/中/下三营');
        const expected = expectedFootLanes(scene, team);
        const actual = footTroops.map(b => [...b.members].map(u => u.id).sort((a, b) => a - b));
        assert.deepEqual(actual, expected, '步战营保留原纵向三等分组织（仅剔除骑兵）');
        for (const b of mine) assert.ok(b.members.length > 0, '无空营');
        const footTotal = footTroops.reduce((sum, b) => sum + b.members.length, 0);
        assert.equal(footTotal, 14 + 6 + 8, '步战营容纳全部非骑兵战斗兵（14剑+6枪+8弓）');
    }
});

test('编组边界：无骑兵不建空骑队，纯骑兵开局不建空步战营', () => {
    const noCav = territoryScene({ territoryAI: false }, { infantry: 9, cavalry: 0 }, { infantry: 9 });
    for (const team of ['red', 'blue']) {
        const mine = noCav.battalions.battalions.filter(b => b.team === team);
        assert.equal(mine.length, 3, `${team} 无骑兵时仍三营、无多余骑队`);
        assert.ok(mine.every(b => b.members.length > 0 && b.members.every(u => u.type !== 'cavalry')));
    }
    const onlyCav = territoryScene({ territoryAI: false }, { cavalry: 4 }, { cavalry: 4 });
    for (const team of ['red', 'blue']) {
        const mine = onlyCav.battalions.battalions.filter(b => b.team === team);
        assert.equal(mine.length, 2, `${team} 4骑编成2个骑队（3骑成队口径），不再拆成3个单骑营`);
        assert.ok(mine.every(b => b.members.length > 0 && b.members.every(u => u.type === 'cavalry')), '纯骑队无空营、无步战空营');
        assert.deepEqual(mine.map(b => b.members.length).sort((a, b) => a - b), [2, 2], '4骑均分为2+2');
    }
});

test('增援分池：骑兵走独立骑队池，不与步战新兵混编', () => {
    const scene = territoryScene({ territoryAI: false }, { infantry: 4 }, { infantry: 4 });
    scene.rebuildSpatial();
    const pin = pinFoes(scene); pin();
    unlockRanch(scene);
    scene.territory.econ.treasury.red = 2000;
    for (let i = 0; i < 2; i++) scene.territory.recruit.enqueue('red', 'cavalry');
    run(scene, 9, pin);   // t=9：两骑已出队入骑队池（池龄自 t=8 起算）
    for (let i = 0; i < 5; i++) scene.territory.recruit.enqueue('red', 'infantry');
    run(scene, 26, pin);  // t=35：骑队池龄 27s 超时激活（2骑≥1保底）；步战池龄 ~23s 未超时、5人不满8人仍在集结
    const red = redBattalions(scene);
    const cavTroop = red.find(b => b.members.length && b.members.every(u => u.type === 'cavalry'));
    assert.ok(cavTroop, '骑兵增援编成独立骑队（不混进步战营）');
    assert.equal(cavTroop.members.length, 2, '2骑在队');
    const infPool = red.find(b => b.gathering);
    assert.ok(infPool, '步兵集结营仍在集结（5人不满8人一波）');
    assert.ok(infPool.members.every(u => u.type !== 'cavalry'), '步兵池不含骑兵');
});

test('小骑队门槛：3骑成队即整队激活，无需攒8人或等超时', () => {
    const scene = territoryScene({ territoryAI: false }, { infantry: 4 }, { infantry: 4 });
    scene.rebuildSpatial();
    const pin = pinFoes(scene); pin();
    unlockRanch(scene);
    scene.territory.econ.treasury.red = 2000;
    for (let i = 0; i < 3; i++) scene.territory.recruit.enqueue('red', 'cavalry');
    // 3骑分别在 8/16/24s 出队；第3骑入池（满3）应立即激活，不等25秒超时
    run(scene, 26, pin);
    const troop = redBattalions(scene).find(b => b.members.length && b.members.every(u => u.type === 'cavalry'));
    assert.ok(troop, '存在骑队');
    assert.equal(troop.gathering, false, '满3骑整队激活（基线攒8人门槛下仍在蹲家）');
    assert.equal(scene.battalions.cavPool.red, null, '骑队池已让位');
});

test('骑队超时保底：单骑25秒超时后也能出发（不卡5人下限）', () => {
    const scene = territoryScene({ territoryAI: false }, { infantry: 4 }, { infantry: 4 });
    scene.rebuildSpatial();
    const pin = pinFoes(scene); pin();
    unlockRanch(scene);
    scene.territory.econ.treasury.red = 2000;
    scene.territory.recruit.enqueue('red', 'cavalry');
    // 骑兵 8s 出队入池；池龄 25s（t=33s）后单骑应激活出发
    run(scene, 35, pin);
    const troop = redBattalions(scene).find(b => b.members.length && b.members.every(u => u.type === 'cavalry'));
    assert.ok(troop, '存在骑队');
    assert.equal(troop.gathering, false, '超时后单骑保底出发（基线5人下限下永远蹲家）');
    assert.equal(troop.members.length, 1);
});

test('骑队行军：以自身速度开进，不被步战营心拖住', () => {
    const scene = territoryScene({ territoryAI: false }, undefined, { infantry: 2 });
    scene.rebuildSpatial();
    const pin = pinFoes(scene, 250, 60); pin();
    const cav = scene.units.filter(u => u.team === 'red' && u.type === 'cavalry');
    assert.equal(cav.length, 3);
    // 骑队令中央高地，步战营令西桥头：路径分离，骑队测速不受友军身体摩擦干扰
    const cavBn = redBattalions(scene).find(b => b.cavalry);
    for (const b of redBattalions(scene)) scene.battalions.orderBattalion(b, b === cavBn ? 2 : 0);
    const start = cav.map(u => ({ gx: u.gx, gy: u.gy }));
    run(scene, 12, pin);
    let total = 0;
    cav.forEach((u, i) => { total += Math.hypot(u.gx - start[i].gx, u.gy - start[i].gy); });
    const avg = total / cav.length;
    // 实测：独立骑队 12 秒推进 ~39.7 格（≈3.3格/秒，含起步与绕行）；混编基线被
    // 步战营心（枪兵1.6步速的护送位）拖住仅 ~28.9 格。阈值 34 居中判别。
    assert.ok(avg >= 34, `骑队12秒平均推进 ${avg.toFixed(1)} 格（≥34：以骑兵自身速度行军，不被步战营拖住）`);
});

test('骑队池生命周期：激活后另开新池，全灭清理让位', () => {
    const scene = territoryScene({ territoryAI: false }, { infantry: 4 }, { infantry: 4 });
    scene.rebuildSpatial();
    const pin = pinFoes(scene); pin();
    unlockRanch(scene);
    scene.territory.econ.treasury.red = 3000;
    for (let i = 0; i < 3; i++) scene.territory.recruit.enqueue('red', 'cavalry');
    run(scene, 26, pin);
    const troop = redBattalions(scene).find(b => !b.gathering && b.members.length && b.members.every(u => u.type === 'cavalry'));
    assert.ok(troop, '第一波3骑已激活成队');
    // 新骑兵应开新池，不混入已激活骑队
    scene.territory.recruit.enqueue('red', 'cavalry');
    run(scene, 9, pin);
    assert.ok(scene.battalions.cavPool.red, '激活后新骑兵开新骑队池');
    assert.equal(scene.battalions.cavPool.red.members.length, 1);
    assert.ok(!troop.members.includes(scene.battalions.cavPool.red.members[0]), '新骑不混入旧队');
    assert.equal(troop.gathering, false, '旧队保持激活状态');
    // 池内骑兵全灭：池让位、营解散
    scene.battalions.cavPool.red.members[0].dead = true;
    run(scene, 0.5, pin);
    assert.equal(scene.battalions.cavPool.red, null, '骑队池全灭后让位');
});

test('骑队编组确定性：同开局两次部署营结构与ID逐位一致', () => {
    const dump = () => {
        const scene = territoryScene({ territoryAI: false });
        return JSON.stringify(scene.battalions.battalions.map(
            b => [b.team, b.id, b.kind, b.cavalry ? 1 : 0, [...b.members].map(u => u.id).sort((a, b) => a - b)]));
    };
    assert.equal(dump(), dump());
});
