import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit, UNIT_TYPES, calculateAttackDamage, resolveAttack, CombatRules } from './battle-harness.js';
import { CAMP_RULES } from '../js/battle/camps.js';
import { TERRITORY, BATTALION_POWER } from '../js/battle/economy.js';
import { setBoardSize, resetBoardSize, board } from '../js/board.js';
import { battleProjection, SIM_VERSION } from '../js/net/lockstep.js';
import { applyCampCommand } from '../js/battle/camp-commands.js';
import { territoryLayout } from '../js/territory-map.js';

setBoardSize(TERRITORY.W, TERRITORY.H);
test.after(() => resetBoardSize());
const STEP = 1000 / 60;
function scene(options = {}) {
    const s = makeScene();
    s.deployUnits({}, {}, 'custom', 'custom', {}, { territory: true, terrain: 'flat', territoryAI: false, ...options });
    s.battleStarted = true;
    for (const team of s.activeTeams) s.territory.econ.treasury[team] = 3000;
    return s;
}
function advance(s, seconds) {
    for (let i = 0; i < Math.round(seconds * 1000 / STEP); i++) {
        s.simulationTime += STEP; s.stepBattle(STEP / 1000);
    }
}
function fieldTower(s, team = 'blue', gx = 65, gy = 55) {
    return s.territory.camps.createBuilding(team, 'tower', null, true, { gx, gy });
}

test('民夫速度、斧兵部署/征募/营队及塔1200血规则', () => {
    const s = scene(), c = s.territory.camps;
    assert.equal(c.getBuilding('tower:red:home').maxHp, 1200);
    assert.equal(CAMP_RULES.tower.def, 6);
    assert.equal(UNIT_TYPES.worker.speed, 1.8);
    const worker = addUnit(s, 'red', 'worker', 30, 25);
    c.orderWorkerMove('red', worker.id, 50, 25);
    advance(s, 1);
    assert.ok(Math.abs(worker.gx - 31.8) < 0.02, '真实平地走1秒约1.8格');
    assert.equal(s.territory.recruit.enqueue('red', 'axe'), true);
    assert.equal(s.territory.recruit.queues.red[0].readyAt, s.simulationTime + 4500);
    advance(s, 4.6);
    const axe = s.units.find(u => u.type === 'axe');
    assert.ok(axe?.battalion, '增援斧兵加入步战集结营');
    assert.equal(BATTALION_POWER.axe, 7);
    const deployed = scene();
    deployed.deployUnits({ axe: 3 }, { infantry: 1 }, 'custom', 'custom', {}, { territory: true, terrain: 'flat', territoryAI: false });
    assert.equal(deployed.units.filter(u => u.type === 'axe').length, 3);
});

test('自由塔不依赖旗/营寨，扣费一次，到场施工、取消暂停和免费续建', () => {
    const s = scene(), c = s.territory.camps, w = addUnit(s, 'red', 'worker', 35, 25);
    const before = s.territory.econ.treasury.red;
    const command = { k: 'build', side: 'red', kind: 'tower', worker: w.id, gx: 50.011, gy: 25.011 };
    assert.equal(applyCampCommand(s, command), true);
    const tower = c.buildings.at(-1);
    assert.equal(tower.siteId, null);
    assert.equal(tower.maxHp, 1200);
    assert.equal(tower.gx, 50);
    assert.equal(s.territory.econ.treasury.red, before - 120);
    advance(s, 1);
    assert.equal(tower.progress, 0, '民夫还在赶路，不能远程建设');
    assert.equal(c.orderWorkerMove('red', w.id, 40, 25), true);
    advance(s, 1);
    assert.equal(tower.progress, 0);
    assert.equal(tower.workerId, null);
    assert.equal(applyCampCommand(s, { ...command, building: tower.id }), true);
    assert.equal(s.territory.econ.spent.red, 120, '取消后续建不二次扣费');
    advance(s, 23);
    assert.equal(tower.complete, true);
    const paid = s.territory.econ.spent.red;
    assert.equal(applyCampCommand(s, command), false, '重叠建造不能扣费');
    assert.equal(s.territory.econ.spent.red, paid);
    assert.equal(applyCampCommand(s, { ...command, side: 'blue', gx: 55 }), false, '不能驱使别人的民夫');
});

test('禁建水/桥/浅滩/边缘/重叠/HQ保护圈，并限制8座含施工塔', () => {
    const s = scene({ terrain: 'territory' }), c = s.territory.camps;
    const w = addUnit(s, 'red', 'worker', 35, 25);
    const { bridge, fordY } = territoryLayout(board.W, board.H);
    for (const [gx, gy] of [[board.W / 2, 10], [board.W / 2, bridge.y1 + 1], [board.W / 2, fordY], [0.2, 20], [7, board.H / 2], [board.W - 15, board.H / 2], [NaN, 30]]) {
        assert.equal(c.towerPlacement('red', gx, gy).ok, false, `${gx}/${gy}必须拒绝`);
        assert.equal(c.requestBuildAt('red', w.id, 'tower', gx, gy), false);
    }
    assert.equal(s.territory.econ.spent.red, 0);
    for (let i = 0; i < 8; i++) assert.equal(c.requestBuildAt('red', w.id, 'tower', 35 + i * 4, 25), true);
    assert.equal(c.towerPlacement('red', 75, 25).ok, false);
    assert.equal(c.requestBuildAt('red', w.id, 'tower', 75, 25), false);
    assert.equal(c.buildings.filter(b => b.team === 'red' && b.type === 'tower' && b.siteId !== 'home').length, 8);
    assert.equal(s.territory.econ.spent.red, 960);
    const newest = c.buildings.at(-1);
    c.orderWorkerMove('red', w.id, 35, 25);
    assert.equal(c.requestBuildAt('red', w.id, 'tower', null, null, newest.id), true, '满额仍允许续建');
});

test('斧兵只对塔倍率2，HQ无倍率；显式拆塔不被近敌改令而营队撤退会打断', () => {
    const s = scene(), c = s.territory.camps, tower = fieldTower(s);
    const axe = addUnit(s, 'red', 'axe', tower.gx - 1.65, tower.gy);
    const home = c.getBuilding('camp:blue:home');
    assert.equal(calculateAttackDamage(axe, tower), 50);
    assert.equal(calculateAttackDamage(axe, home), 18);
    assert.equal(resolveAttack(tower, axe), 50);
    assert.equal(tower.hp, 1150);
    assert.equal(resolveAttack(home, axe), 18);
    addUnit(s, 'blue', 'infantry', axe.gx, axe.gy + 2);
    s.rebuildSpatial();
    assert.equal(c.orderAttackBuilding('red', [axe.id], tower.id), true);
    assert.equal(c.updateUnit(axe, 1700, STEP / 1000), true);
    assert.equal(axe.target, tower, '显式拆塔仍锁定建筑');
    axe.battalion = { retreat: true, gathering: false };
    assert.equal(c.updateUnit(axe, 1800, STEP / 1000), false);
    assert.equal(axe.orderBuildingId, null);
});

test('驻塔弓手增伤在发射时存入箭矢，出塔后伤害不丢失也不重复乘算', () => {
    const s = scene(), c = s.territory.camps, tower = fieldTower(s, 'red', 50, 50);
    const archer = addUnit(s, 'red', 'archer', 50.5, 50), foe = addUnit(s, 'blue', 'infantry', 60, 50);
    c.orderGarrison('red', [archer.id], tower.id); advance(s, 0.04);
    s.arrows.length = 0; archer.lastAttack = 0; foe.velX = 0; foe.velY = 0; s.rebuildSpatial();
    c.updateUnit(archer, 2200, STEP / 1000);
    assert.equal(s.arrows[0].dmg, 31.2);
    c.ungarrison('red', tower.id);
    s.render.fx.updateArrows(1, 3200);
    assert.equal(foe.hp, 79, 'floor(26×1.2-10)=21');
    s.fireArrow(archer, foe);
    assert.equal(s.arrows[0].dmg, 26, '出塔后的普通新箭无驻塔增伤');
});

test('1200血塔：同预算4斧兵显著快于5剑士+民夫；混合护卫场景可重放', () => {
    function siege(type, count, worker = false) {
        const s = scene(), c = s.territory.camps, tower = fieldTower(s);
        const units = Array.from({ length: count }, (_, i) => {
            const a = i * Math.PI * 2 / count;
            return addUnit(s, 'red', type, tower.gx + Math.cos(a) * 1.65, tower.gy + Math.sin(a) * 1.65);
        });
        if (worker) addUnit(s, 'red', 'worker', 30, 25);
        // Equal shields outside the contact ring do not block attackers.
        addUnit(s, 'red', 'infantry', tower.gx - 6, tower.gy - 4);
        c.orderAttackBuilding('red', units.map(u => u.id), tower.id);
        let seconds = 0;
        while (!tower.dead && seconds < 40) { advance(s, 0.1); seconds += 0.1; }
        assert.ok(tower.dead);
        return { seconds, projection: battleProjection(s) };
    }
    assert.equal(4 * UNIT_TYPES.axe.cost, 5 * UNIT_TYPES.infantry.cost + UNIT_TYPES.worker.cost);
    const axes = siege('axe', 4), swords = siege('infantry', 5, true);
    assert.ok(axes.seconds < swords.seconds * 0.6, `${axes.seconds.toFixed(1)}s斧兵 vs ${swords.seconds.toFixed(1)}s剑士`);
    assert.equal(siege('axe', 4).projection, axes.projection);
});

test('合作黑方自由塔与斧兵：权限、敌HQ圈、同盟免伤及盟友驻军沿用', () => {
    const s = scene({ coop: true, black: {} }), c = s.territory.camps;
    const black = addUnit(s, 'black', 'worker', 150, 130), blue = addUnit(s, 'blue', 'worker', 190, 130);
    assert.equal(applyCampCommand(s, { k: 'build', side: 'black', worker: black.id, kind: 'tower', gx: 150, gy: 130 }), true);
    assert.equal(applyCampCommand(s, { k: 'build', side: 'blue', worker: blue.id, kind: 'tower', gx: 190, gy: 130 }), true);
    assert.equal(c.buildings.at(-2).team, 'black'); assert.equal(c.buildings.at(-1).team, 'blue');
    assert.equal(c.towerPlacement('red', 130, board.H - 8).ok, false, '黑方HQ也有敌方保护圈');
    const redAxe = addUnit(s, 'red', 'axe', 50, 50), ally = addUnit(s, 'blue', 'axe', 50.8, 50);
    assert.equal(CombatRules.canStrike(s, redAxe, ally, 0.95), false);
    const allyTower = c.getBuilding('tower:blue:home');
    assert.equal(c.damageBuilding(allyTower, 100, redAxe), 0);
    assert.equal(c.orderAttackBuilding('red', [redAxe.id], allyTower.id), false);
    const redArcher = addUnit(s, 'red', 'archer', allyTower.gx - 0.5, allyTower.gy);
    assert.equal(c.orderGarrison('red', [redArcher.id], allyTower.id), true);
    assert.equal(s.territory.recruit.enqueue('black', 'axe'), true);
});

test('坐标建塔锁步命令重放一致，未来建筑seq纳入投影，版本已变更', () => {
    const a = scene(), b = scene();
    const wa = addUnit(a, 'red', 'worker', 35, 25), wb = addUnit(b, 'red', 'worker', 35, 25);
    assert.equal(wa.id, wb.id);
    const cmd = { k: 'build', side: 'red', worker: wa.id, kind: 'tower', gx: 40.024, gy: 25 };
    for (const s of [a, b]) { assert.equal(s.applyNetCommand(cmd), true); advance(s, 18); }
    assert.equal(battleProjection(a), battleProjection(b));
    b.territory.camps.nextBuildingSeq++;
    assert.notEqual(battleProjection(a), battleProjection(b));
    assert.match(SIM_VERSION, /free-towers-axe/);
});

test('回归：斧兵动摇后走真实后退入口，而非只设置后退时钟', () => {
    const s = scene(), axe = addUnit(s, 'red', 'axe', 40, 30);
    addUnit(s, 'blue', 'infantry', 41.5, 30); s.rebuildSpatial();
    axe.moraleState = 'wavering'; axe.moraleFallBackUntil = 2000; s.planningStep = true;
    assert.equal(s.updateFallingBackUnit(axe, 1000, 0.1), true);
    assert.ok(axe.moveX < 0, '规划真实向远离敌人的方向后退');
    assert.ok(Math.abs(axe.moveX + UNIT_TYPES.axe.speed * 0.45 * 0.1) < 1e-8);
});

test('回归：custom斧兵遵守平地和隘口hold_ground守位部署', () => {
    for (const terrain of ['flat', 'blue_pass']) {
        const s = makeScene();
        s.deployUnits({ infantry: 2 }, { axe: 3 }, 'custom', 'custom', { blue: 'hold_ground' }, { terrain });
        const axes = s.units.filter(u => u.type === 'axe');
        assert.equal(axes.length, 3);
        for (const axe of axes) {
            assert.equal(axe.tacticalRole, 'ground_guard', terrain);
            assert.deepEqual(axe.guardAnchor, { gx: axe.gx, gy: axe.gy });
            assert.ok(axe.guardRadius > 0);
        }
    }
});

test('回归：野外塔满8座时旧site塔仍能续建，实际新建保持拒绝', () => {
    const s = scene(), c = s.territory.camps, site = 0;
    const p = c.placement('red', 'tower', site), w = addUnit(s, 'red', 'worker', p.gx, p.gy);
    assert.equal(c.requestBuild('red', w.id, 'tower', site), true);
    const unfinished = c.getBuilding(`tower:red:${site}`);
    c.orderWorkerMove('red', w.id, 35, 25);
    for (let i = 0; i < 7; i++) assert.equal(c.requestBuildAt('red', w.id, 'tower', 35 + i * 4, 25), true);
    const paid = s.territory.econ.spent.red;
    assert.equal(c.requestBuild('red', w.id, 'tower', site), true, 'AI使用site入口也可续建');
    assert.equal(unfinished.workerId, w.id);
    assert.equal(s.territory.econ.spent.red, paid);
    assert.equal(c.requestBuild('red', w.id, 'tower', 1), false, '另一site的新塔仍受8座上限约束');
});
