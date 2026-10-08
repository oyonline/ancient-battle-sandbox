// 合作模式（红蓝联军 vs 黑方 AI）：三方参战、同盟敌我判定、基地攻城胜负。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene } from './battle-harness.js';
import { RELATIONS_COOP, isHostile, sameSide, activeTeams, ownsFlag, sideLabel } from '../js/factions.js';
import { CombatRules } from '../js/combat.js';

const army = { infantry: 6, pikeman: 2, archer: 2, worker: 2 };

function coopScene() {
    const scene = makeScene();
    scene.deployUnits(army, army, 'custom', 'custom', {}, {
        territory: true, terrain: 'territory', coop: true,
        black: { infantry: 6, archer: 2, worker: 2 }, territoryAI: false
    });
    scene.battleStarted = true;
    return scene;
}

test('合作模式：参战三方、红蓝结盟、黑方为敌', () => {
    const scene = coopScene();
    assert.deepEqual(scene.activeTeams, ['red', 'blue', 'black']);
    assert.equal(scene.relationGroups, RELATIONS_COOP);
    assert.equal(activeTeams(scene).length, 3);
    assert.ok(scene.units.some(u => u.team === 'black'), '黑方开局有兵力');
    assert.ok(scene.territory.camps.buildings.some(b => b.team === 'black'), '黑方建有大本营');
    // 关系表：红蓝互为友军，红蓝皆敌视黑方
    assert.equal(isHostile(scene, 'red', 'blue'), false);
    assert.equal(isHostile(scene, 'red', 'black'), true);
    assert.equal(isHostile(scene, 'blue', 'black'), true);
    assert.equal(sameSide(scene, 'red', 'blue'), true);
    // 索敌：红方最近敌人必为黑方（蓝方是盟友，不进候选）
    const red = scene.units.find(u => u.team === 'red');
    const foe = scene.nearestEnemy(red);
    assert.ok(foe, '红方应有可索敌的敌人');
    assert.equal(foe.team, 'black', '红方最近敌人是黑方而非盟友蓝方');
    // 普攻判定：红方不能攻击盟友蓝方
    const blue = scene.units.find(u => u.team === 'blue');
    assert.equal(CombatRules.canStrike(scene, red, blue, 99), false, '红方不能攻击盟友蓝方');
});

test('合作模式：电脑主基地未毁不判胜；摧毁主基地即联军胜', () => {
    const scene = coopScene();
    for (const u of scene.units) if (u.team === 'black') u.dead = true;
    scene.territory.recruit.queues.black = [];
    scene.territory.econ.treasury.black = 0;
    scene.rebuildSpatial();
    scene.checkWin();
    assert.equal(scene.battleOver, false, '电脑主基地仍在，不判胜负');
    for (const b of scene.territory.camps.buildings) if (b.team === 'black') b.dead = true;
    scene.checkWin();
    assert.equal(scene.battleOver, true, '电脑主基地已毁：联军获胜');
    assert.equal(scene.winner, 'red');
});

test('合作模式：红蓝都被打光才判负，仅一方全灭不算败', () => {
    const scene = coopScene();
    for (const u of scene.units) if (u.team === 'red') u.dead = true;
    scene.territory.recruit.queues.red = [];
    scene.territory.econ.treasury.red = 0;
    scene.rebuildSpatial();
    scene.checkWin();
    assert.equal(scene.battleOver, false, '仅红方全灭：蓝方仍在，联军未败');
});

test('合作模式：联军占下马场后蓝方也能征骑兵（归属同盟共享）', () => {
    const scene = coopScene();
    const ranch = scene.flags.find(f => f.role === 'ranch');
    assert.ok(ranch, '领土图有马场');
    assert.equal(scene.territory.recruit.ownsRanch('red'), false);
    assert.equal(scene.territory.recruit.ownsRanch('blue'), false);
    ranch.owner = 'red';                       // 联军（以红方为名义归属）拿下马场
    assert.equal(ownsFlag(scene, 'blue', ranch), true, '盟友归属视为共享');
    assert.equal(scene.territory.recruit.ownsRanch('blue'), true, '蓝方作为盟友同样获得骑兵征募权');
    assert.equal(sideLabel(scene, 'red'), '红蓝联军', '联军旗播报不显示成单一红方');
});

test('二元模式：非盟友不共享据点归属（既有行为不变）', () => {
    const scene = makeScene();
    scene.deployUnits(army, army, 'custom', 'custom', {}, {
        territory: true, terrain: 'territory', territoryAI: false
    });
    const ranch = scene.flags.find(f => f.role === 'ranch');
    ranch.owner = 'red';
    assert.equal(ownsFlag(scene, 'blue', ranch), false, '红蓝各自为战时不共享');
    assert.equal(scene.territory.recruit.ownsRanch('blue'), false);
    assert.equal(sideLabel(scene, 'red'), '红方');
});
