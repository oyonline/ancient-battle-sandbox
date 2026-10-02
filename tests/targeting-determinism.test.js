import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene } from './battle-harness.js';
import { ReferenceSpatialIndex, targetingStateProjection } from './targeting-reference.js';
import { battleProjection, hashProjection } from '../js/net/lockstep.js';

const army = { infantry: 10, pikeman: 4, archer: 4, cavalry: 2 };
function sceneFor(reference, territory = false) {
    const scene = makeScene();
    if (reference) scene._spatial = new ReferenceSpatialIndex();
    scene.deployUnits(army, army, 'custom', 'custom', {}, {
        territory, terrain: territory ? 'territory' : 'flat', territoryAI: false
    });
    scene.battleStarted = true;
    if (!territory) {
        for (const unit of scene.units) unit.gx += unit.team === 'red' ? 12 : -12;
    }
    return scene;
}
function advance(scene) { scene.simulationTime += 1000 / 60; scene.stepBattle(1 / 60); }

test('新旧索敌在混兵交战中每步状态完全一致，包含接战、追击、伤亡与多次重建', () => {
    const oldScene = sceneFor(true), newScene = sceneFor(false);
    for (let step = 0; step < 900; step++) {
        advance(oldScene); advance(newScene);
        assert.equal(targetingStateProjection(newScene), targetingStateProjection(oldScene), `step ${step}`);
    }
    const report = newScene.getBattleReport();
    assert.ok(report.teams.red.damage + report.teams.blue.damage > 0, 'must cover actual attacks');
    assert.ok(report.teams.red.lost + report.teams.blue.lost > 0, 'must cover dead targets');
});

test('真实山河领土运行的官方联机投影与哈希保持一致', () => {
    const oldScene = sceneFor(true, true), newScene = sceneFor(false, true);
    for (let step = 0; step < 180; step++) {
        advance(oldScene); advance(newScene);
        assert.equal(battleProjection(newScene), battleProjection(oldScene), `territory step ${step}`);
    }
    assert.equal(hashProjection(battleProjection(newScene)), hashProjection(battleProjection(oldScene)));
});
