// 营队系统：开局分编 / 集结波次 / 步速同步 / AI 不送死与家防回援 / 玩家指令 / 骑兵随营 / 推旗优先
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit } from './battle-harness.js';
import { TERRITORY } from '../js/battle/economy.js';
import { Battalion, BattalionSystem, BATTALION } from '../js/battle/battalion.js';

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

test('开局分编：双方各三营，全员入营，无漏网单位', () => {
    const scene = territoryScene();
    assert.equal(scene.battalions.battalions.length, 6, '红蓝各三营');
    const opening = Object.values(TERRITORY.OPENING).reduce((a, b) => a + b, 0);
    for (const team of ['red', 'blue']) {
        const mine = scene.battalions.battalions.filter(b => b.team === team);
        const total = mine.reduce((sum, b) => sum + b.members.length, 0);
        assert.equal(total, opening, `${team} 全员入营`);
    }
    for (const unit of scene.units) assert.ok(unit.battalion, '每个单位都有营归属');
});

test('集结波次：不满员驻留集结点，攒满一波整营激活', () => {
    const scene = territoryScene({ territoryAI: false }, {}, { infantry: 4 });
    scene.rebuildSpatial();
    const foes = scene.units.filter(u => u.team === 'blue');
    const pin = () => foes.forEach((u, i) => { u.gx = 98; u.gy = 4 + i; u.hp = u.maxHp; });
    pin();
    scene.territory.econ.treasury.red = 400;
    // 先买 5 个（不满一波）：应驻留在老家集结点附近，不自行开进
    for (let i = 0; i < 5; i++) scene.territory.recruit.enqueue('red', 'infantry');
    run(scene, 8, pin);
    let pool = redBattalions(scene).find(b => b.gathering);
    assert.ok(pool, '存在集结营');
    assert.equal(pool.aliveMembers().length, 5);
    const gather = pool.gatherPoint;
    for (const u of pool.aliveMembers()) {
        assert.ok(Math.hypot(u.gx - gather.gx, u.gy - gather.gy) <= 8, '集结成员蹲在集结点附近');
        assert.ok(u.gx < 20, '未越过红方半场深处');
    }
    // 补足 8 人：整营激活
    for (let i = 0; i < 3; i++) scene.territory.recruit.enqueue('red', 'infantry');
    run(scene, 6, pin);
    assert.equal(pool.gathering, false, '满一波整营激活');
    assert.equal(scene.battalions.pool.red, null, '集结池已让位');
});

test('步速同步：混编营开进不脱队（步兵不甩开枪兵）', () => {
    const scene = territoryScene({ territoryAI: false }, {}, { infantry: 4 });
    scene.rebuildSpatial();
    const foes = scene.units.filter(u => u.team === 'blue');
    const pin = () => foes.forEach((u, i) => { u.gx = 98; u.gy = 60 + i; u.hp = u.maxHp; });
    pin();
    const battalion = new Battalion('red', 'line');
    for (let i = 0; i < 6; i++) battalion.members.push(addUnit(scene, 'red', 'infantry', 12, 33 + i));
    for (let i = 0; i < 4; i++) battalion.members.push(addUnit(scene, 'red', 'pikeman', 12, 39 + i));
    for (const u of battalion.members) u.battalion = battalion;
    battalion.refreshPace();
    assert.ok(Math.abs(battalion.pace - 1.6) < 1e-9, '营步速取最慢兵种（枪兵 1.6）');
    scene.battalions.battalions.push(battalion);
    battalion.orderFlag = 2;                     // 中央高地
    run(scene, 15, pin);
    const alive = battalion.aliveMembers();
    let spread = 0;
    for (const a of alive) for (const b of alive) spread = Math.max(spread, Math.hypot(a.gx - b.gx, a.gy - b.gy));
    assert.ok(spread <= 12, `开进 15 秒后营散布 ${spread.toFixed(1)} 格，不脱队`);
    const center = battalion.center();
    assert.ok(center.gx > 20, '营整体向目标推进');
});

test('营级 AI：打不过的旗不派营（不送死）', () => {
    const scene = territoryScene({ territoryAI: false }, {}, {});
    scene.rebuildSpatial();
    // 中央高地压 30 蓝剑士（占领力 300），红方一营战力 ~70：打不过
    for (let i = 0; i < 30; i++) {
        const u = addUnit(scene, 'blue', 'infantry', scene.flags[2].gx + (i % 5) - 2, scene.flags[2].gy + Math.floor(i / 5) - 2);
        u.hp = u.maxHp = 10000; u.moraleState = 'steady';
    }
    const battalion = new Battalion('red', 'line');
    for (let i = 0; i < 8; i++) battalion.members.push(addUnit(scene, 'red', 'infantry', 14, 33 + i));
    for (const u of battalion.members) u.battalion = battalion;
    battalion.refreshPace();
    scene.battalions.battalions.push(battalion);
    scene.rebuildSpatial();
    scene.battalions.aiAssign();
    assert.notEqual(battalion.orderFlag, 2, '不应把营派往敌军重兵死守的中央旗');
});

test('营级 AI：己方旗被进犯，最近营回援', () => {
    const scene = territoryScene({ territoryAI: false });
    scene.rebuildSpatial();
    // 蓝军一个集群压在红方上翼前哨旗
    for (let i = 0; i < 15; i++) {
        addUnit(scene, 'blue', 'infantry', scene.flags[0].gx + (i % 5) - 2, scene.flags[0].gy + Math.floor(i / 5) - 2);
    }
    scene.rebuildSpatial();
    scene.battalions.aiAssign();
    const defenders = redBattalions(scene).filter(b => b.orderFlag === 0);
    assert.ok(defenders.length >= 1, '应有营回援被进犯的红方前哨·上');
});

test('玩家指令：点旗下令优先于 AI，夺旗后自动交还；敌营不可指挥', () => {
    const scene = territoryScene({ territoryAI: false });
    const battalion = redBattalions(scene)[0];
    const blueBattalion = scene.battalions.battalions.find(b => b.team === 'blue');
    scene.selectedBattalion = blueBattalion;
    assert.equal(scene.orderSelectedBattalion(2), false, '敌营不可指挥');
    scene.selectedBattalion = battalion;
    assert.equal(scene.orderSelectedBattalion(4), true);
    assert.equal(battalion.orderFlag, 4);
    assert.equal(battalion.playerOrdered, true);
    scene.rebuildSpatial();
    scene.battalions.aiAssign();
    assert.equal(battalion.orderFlag, 4, 'AI 评估不覆盖玩家令');
    scene.flags[4].owner = 'red';                       // 目标旗被红方占领
    scene.battalions.nextThink = Infinity;              // 冻结 AI 重派，单测交还本身
    scene.battalions.update(scene.simulationTime + 3000);
    assert.equal(battalion.orderFlag, null, '夺旗后指令完成交还');
    assert.equal(battalion.playerOrdered, false);
    // 回防令
    scene.selectedBattalion = battalion;
    assert.equal(scene.orderSelectedBattalion('home'), true);
    assert.equal(battalion.retreat, true);
});

test('骑兵随营：集结蹲集结点、有令随旗推进、贴脸有敌才交还冲锋、守旗贴旗待命', () => {
    const scene = territoryScene({ territoryAI: false });
    scene.rebuildSpatial();
    // 1) 集结营骑兵：不单骑出击，目标=集结点
    const pool = new Battalion('red', 'gathering');
    pool.gatherPoint = { gx: 8, gy: 36 };
    const cav1 = addUnit(scene, 'red', 'cavalry', 30, 36);
    cav1.battalion = pool; pool.members.push(cav1);
    scene.rebuildSpatial();
    const hold = scene.battalionDirectCavalry(cav1);
    assert.ok(hold && hold.gx === 8, '集结骑兵应回集结点');
    // 2) 有令营骑兵：目标=旗（或等大队）
    const line = new Battalion('red', 'line');
    for (let i = 0; i < 6; i++) line.members.push(addUnit(scene, 'red', 'infantry', 20, 34 + i));
    const cav2 = addUnit(scene, 'red', 'cavalry', 22, 36);
    cav2.battalion = line; line.members.push(cav2);
    line.orderFlag = 2;
    scene.rebuildSpatial();
    const march = scene.battalionDirectCavalry(cav2);
    assert.ok(march, '有令骑兵应有行军目标');
    const flag = scene.flags[2], center = line.center();
    // 护送点：营心→旗连线上、营心前方约 8 格（同向推进，不折返）
    const cross = (march.gx - center.gx) * (flag.gy - center.gy) - (march.gy - center.gy) * (flag.gx - center.gx);
    assert.ok(Math.abs(cross) < 1e-6, '目标在营心→旗连线上');
    assert.ok(Math.hypot(march.gx - center.gx, march.gy - center.gy) <= 8.5, '目标不超过营心前 8 格（护送位）');
    // 3) 贴脸有敌：交还冲锋状态机
    const foe = addUnit(scene, 'blue', 'infantry', cav2.gx + 3, cav2.gy);
    scene.rebuildSpatial();
    assert.equal(scene.battalionDirectCavalry(cav2), null, '6 格内有敌应交还作战');
    foe.dead = true;
    scene.rebuildSpatial();
    // 4) 已占旗：贴旗待命点
    line.orderFlag = 0;
    scene.flags[0].owner = 'red';
    cav2.gx = scene.flags[0].gx + 1; cav2.gy = scene.flags[0].gy;
    scene.rebuildSpatial();
    const orbit = scene.battalionDirectCavalry(cav2);
    assert.ok(orbit && Math.hypot(orbit.gx - scene.flags[0].gx, orbit.gy - scene.flags[0].gy) < 3, '守旗骑兵贴旗游弋');
});

test('镜像确定性：营队系统参与下同构两局逐位一致', () => {
    const play = () => {
        const scene = territoryScene({ territoryAI: true });
        run(scene, 40);
        return JSON.stringify({
            red: scene.redAlive, blue: scene.blueAlive,
            tickets: [Math.round(scene.territory.tickets.tickets.red), Math.round(scene.territory.tickets.tickets.blue)],
            battalions: scene.battalions.battalions.map(b => [b.team, b.members.length, b.orderFlag, b.gathering ? 1 : 0]),
            spawned: scene.territory.recruit.spawned,
            endReason: scene.endReason, over: scene.battleOver
        });
    };
    assert.equal(play(), play());
});

test('推旗优先：有令近战在 6~12 格遇敌不停步，继续向目标旗推进', () => {
    const scene = territoryScene({ territoryAI: false }, {}, { infantry: 2 });
    scene.rebuildSpatial();
    const foes = scene.units.filter(u => u.team === 'blue');
    const pin = () => foes.forEach((u, i) => { u.gx = 40; u.gy = 4 + i; u.hp = u.maxHp; });
    pin();
    const battalion = new Battalion('red', 'line');
    const troop = addUnit(scene, 'red', 'infantry', 24, 36);
    troop.battalion = battalion; battalion.members.push(troop);
    battalion.orderFlag = 2;                      // 中央高地
    scene.rebuildSpatial();
    const foe = foes[0];
    foe.gx = troop.gx + 9; foe.gy = troop.gy;     // 9 格外正东有敌（在旧 12 格接敌圈内）
    pin.push = null;
    const pinnedFoe = () => { foe.gx = 33; foe.gy = 36; foe.hp = foe.maxHp; };
    const startFlagDist = Math.hypot(scene.flags[2].gx - troop.gx, scene.flags[2].gy - troop.gy);
    for (let i = 0; i < 60 * 4 && !troop.dead; i++) {
        pinnedFoe();
        scene.advanceBattle(STEP);
    }
    const endFlagDist = Math.hypot(scene.flags[2].gx - troop.gx, scene.flags[2].gy - troop.gy);
    assert.ok(endFlagDist < startFlagDist - 8, '有令部队应穿过 9 格外的敌人继续推旗');
});

test('骑兵护送不折返：边界处不再旗↔营心来回掉头（贴图闪烁根因）', () => {
    const scene = territoryScene({ territoryAI: false }, {}, { infantry: 2 });
    scene.rebuildSpatial();
    const foes = scene.units.filter(u => u.team === 'blue');
    const pin = () => foes.forEach((u, i) => { u.gx = 98; u.gy = 60 + i; u.hp = u.maxHp; });
    pin();
    const battalion = new Battalion('red', 'line');
    for (let i = 0; i < 6; i++) {
        const u = addUnit(scene, 'red', 'infantry', 30, 34 + i * 0.9);
        u.battalion = battalion; battalion.members.push(u);
    }
    const cav = addUnit(scene, 'red', 'cavalry', 40, 36);   // 恰在"超前"边界附近
    cav.battalion = battalion; battalion.members.push(cav);
    battalion.orderFlag = 2;                                  // 中央高地（约 22 格外）
    battalion.refreshPace();
    scene.battalions.battalions.push(battalion);
    const headings = [];
    let reversals = 0, lastDx = null;
    for (let i = 0; i < 60 * 8 && !cav.dead; i++) {
        pin();
        const beforeX = cav.gx;
        scene.advanceBattle(STEP);
        const dx = cav.gx - beforeX;
        headings.push(dx);
        if (Math.abs(dx) > 0.002) {
            if (lastDx != null && Math.sign(dx) !== Math.sign(lastDx) && Math.abs(lastDx) > 0.002) reversals++;
            lastDx = dx;
        }
    }
    assert.ok(reversals <= 1, `行进方向折返 ${reversals} 次（护送点应同向推进，最多起步转向一次）`);
});
