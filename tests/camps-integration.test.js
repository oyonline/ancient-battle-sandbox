import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit } from './battle-harness.js';
import { UNIT_TYPES } from '../js/units.js';
import { Terrain } from '../js/terrain.js';

function start() {
    const s = makeScene();
    s.deployUnits({}, {}, 'custom', 'custom', {}, { territory: true, territoryAI: false, terrain: 'flat' });
    s.battleStarted = true;
    return s;
}

function run(s, seconds) {
    for (let i = 0; i < Math.round(seconds * 60) && !s.battleOver; i++) s.advanceBattle(1000 / 60);
}

test('真实帧流水线：入塔驻军持续向地面敌人射箭并结算伤害', () => {
    const s = start(), c = s.territory.camps, tower = c.getBuilding('tower:red:home');
    const a = addUnit(s, 'red', 'archer', tower.gx, tower.gy);
    const foe = addUnit(s, 'blue', 'infantry', tower.gx + 12, tower.gy);
    assert.equal(c.orderGarrison('red', [a.id], tower.id), true);
    run(s, 2);
    assert.equal(a.garrisonTowerId, tower.id);
    assert.ok(foe.hp < UNIT_TYPES.infantry.hp, '真实箭落点与applyDamage必须造成伤害');
    const nearby = []; s.forEachNear(tower.gx, tower.gy, 1, u => nearby.push(u.id));
    assert.ok(!nearby.includes(a.id), '塔上射手不占地面碰撞桶');
    assert.ok(s.redAlive >= 1, '驻军仍计在活单位中');
    c.damageBuilding(tower, tower.hp, foe);
    run(s, 0.1);
    assert.equal(a.garrisonTowerId, null);
    assert.ok(Terrain.walkable('flat', a.gx, a.gy));
});

test('真实弓箭攻寨：箭飞抵后才扣建筑血，摧毁主寨以camp终局', () => {
    const s = start(), c = s.territory.camps, target = c.getBuilding('camp:blue:home');
    target.hp = 10;
    const a = addUnit(s, 'red', 'archer', target.gx - 8, target.gy);
    c.orderAttackBuilding('red', [a.id], target.id);
    run(s, 0.1);
    assert.equal(target.hp, 10, '箭在飞行时不提前落伤害');
    assert.ok(s.arrows.some(arrow => arrow.buildingId === target.id));
    run(s, 1);
    assert.equal(target.dead, true);
    assert.equal(s.battleOver, true);
    assert.equal(s.winner, 'red');
    assert.equal(s.endReason, 'camp');
    assert.ok(s.getBattleReport().events.some(e => e.text.includes('攻破敌方大本营')));
});

test('真实普通营令替换攻寨和入塔：拒绝无效/越权指令，已驻塔者留在塔上', () => {
    const s = start(), c = s.territory.camps;
    s.orderFlash = () => {};
    const tower = c.getBuilding('tower:red:home'), home = c.getBuilding('camp:blue:home');
    const i = addUnit(s, 'red', 'infantry', 20, 90), a = addUnit(s, 'red', 'archer', 20, 91);
    const b = s.battalions.createBattalion('red', 'line');
    b.members = [i, a]; i.battalion = b; a.battalion = b;
    s.battalions.battalions.push(b);
    const campOrders = () => {
        s.applyNetCommand({ k: 'attack-building', side: 'red', units: [i.id], building: home.id });
        s.applyNetCommand({ k: 'garrison', side: 'red', units: [a.id], building: tower.id });
        assert.equal(i.orderBuildingId, home.id);
        assert.equal(a.garrisonOrderId, tower.id);
    };
    campOrders();
    s.applyNetCommand({ k: 'hold', side: 'blue', id: b.id, gx: 25, gy: 90 });
    s.applyNetCommand({ k: 'order', side: 'red', id: b.id, flag: 999 });
    assert.equal(i.orderBuildingId, home.id, '越权和非法旗令不可取消有效攻寨令');
    assert.equal(a.garrisonOrderId, tower.id);
    for (const command of [
        { k: 'order', flag: 0 }, { k: 'order', flag: 'home' },
        { k: 'hold', gx: 25, gy: 90 }, { k: 'clear' }
    ]) {
        s.applyNetCommand({ ...command, side: 'red', id: b.id });
        assert.equal(i.orderBuildingId, null);
        assert.equal(a.garrisonOrderId, null);
        campOrders();
    }
    a.gx = tower.gx; a.gy = tower.gy; run(s, 0.1);
    assert.equal(a.garrisonTowerId, tower.id);
    s.applyNetCommand({ k: 'order', side: 'red', id: b.id, flag: 'home' });
    assert.equal(a.garrisonTowerId, tower.id, '营回防不得让已驻军瞬间跳下塔');
});

test('真实集结旗命令取消集结营pending攻寨/入塔，拒绝非法坐标不清令', () => {
    const s = start(), c = s.territory.camps;
    s.spawnOrderText = () => {};
    const i = addUnit(s, 'red', 'infantry', 20, 90), a = addUnit(s, 'red', 'archer', 20, 91);
    s.battalions.assignReinforcement(i); s.battalions.assignReinforcement(a);
    s.applyNetCommand({ k: 'attack-building', side: 'red', units: [i.id], building: 'camp:blue:home' });
    s.applyNetCommand({ k: 'garrison', side: 'red', units: [a.id], building: 'tower:red:home' });
    s.applyNetCommand({ k: 'rally', side: 'red', gx: NaN, gy: 90 });
    assert.equal(i.orderBuildingId, 'camp:blue:home');
    s.applyNetCommand({ k: 'rally', side: 'red', gx: 12, gy: 91 });
    assert.equal(i.orderBuildingId, null);
    assert.equal(a.garrisonOrderId, null);
    assert.deepEqual(s.territory.rally.red, { gx: 12, gy: 91 });
});

test('真实身体分离：塔上射手与重叠地面兵完全不互相推挤', () => {
    const s = start(), c = s.territory.camps, tower = c.getBuilding('tower:red:home');
    const a = addUnit(s, 'red', 'archer', tower.gx, tower.gy);
    c.orderGarrison('red', [a.id], tower.id); run(s, 0.1);
    const foe = addUnit(s, 'blue', 'infantry', tower.gx + 0.1, tower.gy);
    s.rebuildSpatial();
    const before = { ax: a.gx, ay: a.gy, fx: foe.gx, fy: foe.gy };
    s.separate(1 / 60);
    assert.equal(a.gx, before.ax);
    assert.equal(a.gy, before.ay);
    assert.ok(Math.abs(foe.gx - before.fx) < 1e-6, '地面兵不得被塔上射手推开');
    assert.equal(foe.gy, before.fy);
    assert.equal(a.separateX, 0);
    assert.equal(foe.separateX, 0);
});
