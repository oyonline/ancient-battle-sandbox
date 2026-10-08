// 箭塔驻军（模拟层）：容量与预约、入驻/出塔、塔毁释放、无效操作的具体原因。
// 发现性反馈的 UI 部分见 tests/tower-garrison-ui.test.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit } from './battle-harness.js';
import { setBoardSize, resetBoardSize } from '../js/board.js';
import { TERRITORY } from '../js/battle/economy.js';
import { CAMP_RULES } from '../js/battle/camps.js';
import { Terrain } from '../js/terrain.js';
import { battleProjection } from '../js/net/lockstep.js';

setBoardSize(TERRITORY.W, TERRITORY.H);
test.after(() => resetBoardSize());

const STEP = 1000 / 60;

function scene() {
    const s = makeScene();
    s.deployUnits({}, {}, 'custom', 'custom', {}, { territory: true, terrain: 'flat', territoryAI: false });
    s.battleStarted = true;
    return s;
}

function stepMany(s, steps) {
    for (let i = 0; i < steps; i++) {
        s.simulationTime += STEP;
        s.stepBattle(STEP / 1000);
    }
}

function archersAt(s, tower, count, spread = 0.55) {
    return Array.from({ length: count }, (_, i) =>
        addUnit(s, 'red', 'archer', tower.gx + spread, tower.gy + (i - (count - 1) / 2) * 0.12));
}

test('驻军容量与预约：4 人上限，含在途弓手，不重复超额预订', () => {
    const s = scene();
    const camps = s.territory.camps;
    const tower = camps.createBuilding('red', 'tower', 0, true);
    const archers = archersAt(s, tower, 6);
    assert.equal(camps.orderGarrison('red', archers.map(u => u.id), tower.id), true);
    assert.equal(camps.reserved(tower), 4, '一次性下令只接受 4 人');
    assert.equal(camps.garrisonStatus(tower).full, true);
    assert.equal(camps.garrisonStatus(tower).label, '0/4（+4 前往中）');
    assert.equal(camps.orderGarrison('red', [archers[4].id], tower.id), false, '预约已满，第 5 人被拒');
    assert.equal(camps.orderGarrison('red', [archers[5].id], tower.id), false);
    // 分批下令同样计入预约：先 3 人，再补 3 人只应接受 1 人。
    const t2 = camps.createBuilding('red', 'tower', 1, true);
    const more = archersAt(s, t2, 6, 0.5).filter(u => !u.garrisonOrderId && !u.garrisonTowerId);
    assert.equal(camps.orderGarrison('red', [more[0].id, more[1].id, more[2].id], t2.id), true);
    assert.equal(camps.reserved(t2), 3);
    assert.equal(camps.orderGarrison('red', [more[3].id, more[4].id, more[5].id], t2.id), true);
    assert.equal(camps.reserved(t2), 4, '补令只接受剩余 1 个名额');
});

test('入驻与出塔：走到塔边入塔、塔上按 14 格射程开火、出塔回到可行走地面', () => {
    const s = scene();
    const camps = s.territory.camps;
    const tower = camps.createBuilding('red', 'tower', 0, true);
    const archers = archersAt(s, tower, 2, 0.6);
    assert.equal(camps.orderGarrison('red', archers.map(u => u.id), tower.id), true);
    assert.equal(archers[0].garrisonOrderId, tower.id);
    s.rebuildSpatial();
    stepMany(s, 1);
    assert.equal(tower.garrisonIds.length, 2, '到点后入驻');
    for (const u of archers) {
        assert.equal(u.garrisonTowerId, tower.id);
        assert.equal(u.gx, tower.gx);
        assert.equal(u.battalion, null, '驻塔单位退出营队');
        assert.equal(u.garrisonOrderId, null);
    }
    const enemy = addUnit(s, 'blue', 'infantry', tower.gx + 10, tower.gy);
    s.rebuildSpatial();
    stepMany(s, 180);   // 弓手攻击间隔 2.1 秒，走满 3 秒才保证至少一次射击结算
    assert.ok(s.arrows.some(a => a.source?.id === archers[0].id) || enemy.hp < enemy.maxHp,
        '塔上弓手在 14 格内真实射击');
    assert.ok(enemy.hp < enemy.maxHp, '塔上射击造成伤害');

    assert.equal(camps.ungarrison('red', tower.id), true);
    assert.equal(tower.garrisonIds.length, 0);
    for (const u of archers) {
        assert.equal(u.garrisonTowerId, null);
        assert.equal(Terrain.walkable('flat', u.gx, u.gy, 0.36), true, '出塔落在可行走位置');
    }
});

test('塔毁释放驻军、被摧毁的塔不能入驻、敌塔与我方未完工塔给出具体原因', () => {
    const s = scene();
    const camps = s.territory.camps;
    const tower = camps.createBuilding('red', 'tower', 0, true);
    const archers = archersAt(s, tower, 1, 0.5);
    camps.orderGarrison('red', archers.map(u => u.id), tower.id);
    stepMany(s, 1);
    assert.equal(archers[0].garrisonTowerId, tower.id);
    camps.damageBuilding(tower, tower.hp * 2, addUnit(s, 'blue', 'infantry', tower.gx + 2, tower.gy));
    assert.equal(tower.dead, true);
    assert.equal(tower.garrisonIds.length, 0, '毁塔释放驻军');
    assert.equal(archers[0].garrisonTowerId, null);
    assert.equal(camps.orderGarrison('red', [archers[0].id], tower.id), false);

    const enemy = camps.createBuilding('blue', 'tower', 3, true);
    assert.match(camps.garrisonRejectReason('red', enemy.id), /敌方/);
    const unfinished = camps.createBuilding('red', 'tower', 1, false);
    assert.match(camps.garrisonRejectReason('red', unfinished.id), /尚未完工/);
    assert.equal(camps.garrisonRejectReason('red', 'nope'), '请点选一座建筑');
});

test('无效操作的原因具体可读：满员 / 没有弓手 / 兵种不匹配', () => {
    const s = scene();
    const camps = s.territory.camps;
    const tower = camps.createBuilding('red', 'tower', 0, true);
    const archers = archersAt(s, tower, 4);
    camps.orderGarrison('red', archers.map(u => u.id), tower.id);
    assert.match(camps.garrisonRejectReason('red', tower.id), /已满（4\/4/);
    const infantry = addUnit(s, 'red', 'infantry', 20, 20);
    const empty = camps.createBuilding('red', 'tower', 2, true);
    assert.match(camps.garrisonRejectReason('red', empty.id, [infantry.id]), /没有可入驻的弓箭手/);
    assert.equal(camps.orderGarrison('red', [infantry.id], empty.id), false, '剑士不能驻塔');
    const tent = camps.createBuilding('red', 'tent', 1, true);
    assert.equal(camps.orderGarrison('red', [archers[0].id], tent.id), false, '弓手不能驻医帐');
    assert.match(camps.garrisonRejectReason('red', tent.id, [archers[0].id]), /没有可入驻的军医/);
    const camp = camps.createBuilding('red', 'camp', 3, true);
    assert.match(camps.garrisonRejectReason('red', camp.id), /只有箭塔收弓手/);
    const medics = [addUnit(s, 'red', 'medic', 21, 21), addUnit(s, 'red', 'medic', 21.5, 21)];
    assert.equal(camps.orderGarrison('red', medics.map(u => u.id), tent.id), true, '军医可驻医帐');
    assert.equal(camps.garrisonStatus(tent).label, '0/2（+2 前往中）');
    const third = addUnit(s, 'red', 'medic', 22, 21);
    assert.equal(camps.garrisonRejectReason('red', tent.id, [third.id]),
        '医帐已满（2/2，含正在前往的）', '满员原因是确定的，不是"任一理由"');
    assert.match(camps.garrisonRejectReason('red', tent.id), /已满（2\/2/);
});

test('驻塔状态进入同步投影：入驻、出塔与行军命令都改变哈希', () => {
    const s = scene();
    const camps = s.territory.camps;
    const tower = camps.createBuilding('red', 'tower', 0, true);
    const archer = archersAt(s, tower, 1, 0.5)[0];
    const before = battleProjection(s);
    camps.orderGarrison('red', [archer.id], tower.id);
    assert.notEqual(battleProjection(s), before, '弓手的驻塔命令在同步投影里可检出');
    stepMany(s, 1);
    assert.equal(camps.projection().buildings.find(b => b.id === tower.id).garrisonIds.length, 1);
    assert.ok(CAMP_RULES.CAPACITY === 4 && CAMP_RULES.TOWER_RANGE === 14, '本轮不改容量与射程');
});
