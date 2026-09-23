const test = require('node:test');
const assert = require('node:assert/strict');
const { context, applyDamage, makeScene, addUnit, snapshot } = require('./battle-harness.js');
const vm = require('node:vm');
const { updatePikeBrace, isPreparedPike } = vm.runInContext('({ updatePikeBrace, isPreparedPike })', context);

function route(scene, unit) {
    const previous = unit.moraleState;
    unit.morale = 20;
    unit.moraleState = 'routing';
    scene.onMoraleStateChange(unit, previous, '侧翼受到冲锋');
}

function advance(scene, seconds) {
    for (let i = 0; i < Math.round(seconds * 60) && !scene.battleOver; i++) scene.advanceBattle(1000 / 60);
}

test('routing cancels a queued melee swing and does not count as a kill', () => {
    const scene = makeScene();
    const red = addUnit(scene, 'red', 'infantry', 30, 30);
    const blue = addUnit(scene, 'blue', 'infantry', 30.7, 30);
    scene.rebuildSpatial();
    scene.updateNormalUnit(red, 1, 1 / 60);
    assert.equal(scene.battleQueue.length, 1);
    route(scene, red);
    scene.simulationTime = 100;
    scene.flushBattleActions();
    assert.equal(blue.hp, blue.maxHp);
    assert.equal(scene.battleStats.red.alive, 1);
    assert.equal(scene.battleStats.red.lost, 0);
    assert.equal(scene.battleStats.blue.kills, 0);
});

test('routing cancels an unreleased arrow but arrows already airborne retain damage and attribution', () => {
    const scene = makeScene();
    const shooter = addUnit(scene, 'red', 'archer', 30, 30);
    const target = addUnit(scene, 'blue', 'infantry', 35, 30);
    scene.rebuildSpatial();
    scene.updateNormalUnit(shooter, 1, 1 / 60);
    assert.equal(scene.battleQueue.length, 1);
    route(scene, shooter);
    scene.simulationTime = 120;
    scene.flushBattleActions();
    assert.equal(scene.arrows.length, 0);
    // This projectile was loosed while its shooter was still willing to fight.
    shooter.moraleState = 'steady';
    scene.fireArrow(shooter, target);
    route(scene, shooter);
    scene.updateArrows(1, 1120);
    assert.ok(target.hp < target.maxHp);
    assert.equal(scene.battleStats.red.damage, target.maxHp - target.hp);
});

test('routing spears lose their brace and cannot support another spear formation', () => {
    const scene = makeScene();
    const guard = addUnit(scene, 'red', 'pikeman', 30, 30);
    const support = addUnit(scene, 'red', 'pikeman', 29, 30);
    addUnit(scene, 'red', 'pikeman', 29, 31);
    const horse = addUnit(scene, 'blue', 'cavalry', 35, 30);
    scene.rebuildSpatial();
    updatePikeBrace(guard, 0.5);
    assert.equal(guard.braceReady, true);
    route(scene, support);
    updatePikeBrace(guard, 0.5);
    assert.equal(guard.braceReady, false);
    route(scene, guard);
    assert.equal(isPreparedPike(guard, horse, -1, 0), false);
});

test('withdrawal removes a live soldier without a corpse, kill or duplicate statistics', () => {
    const scene = makeScene();
    const unit = addUnit(scene, 'red', 'infantry', 1, 30);
    const enemy = addUnit(scene, 'blue', 'archer', 40, 30);
    route(scene, unit);
    scene.withdrawUnit(unit);
    scene.withdrawUnit(unit);
    assert.equal(unit.dead, false);
    assert.equal(unit.spr.destroyed, true);
    assert.equal(scene.deadCount, 0);
    assert.equal(applyDamage(unit, 1000, enemy), 0);
    scene.rebuildSpatial();
    assert.equal(scene.nearestEnemy(enemy), null);
    const stats = scene.getBattleReport().teams.red;
    assert.equal(stats.alive, 0);
    assert.equal(stats.lost, 0);
    assert.equal(stats.withdrawn, 1);
    assert.equal(stats.routed, 1);
    assert.equal(stats.initial, stats.alive + stats.lost + stats.withdrawn);
});

test('a routed soldier reaching the map boundary withdraws through the production step', () => {
    const scene = makeScene();
    const unit = addUnit(scene, 'red', 'infantry', 0.64, 30);
    addUnit(scene, 'blue', 'infantry', 60, 30);
    route(scene, unit);
    scene.advanceBattle(1000 / 60);
    assert.equal(unit.withdrawn, true);
    assert.equal(scene.getBattleReport().teams.red.withdrawn, 1);
    assert.equal(scene.winner, 'blue');
});

test('five seconds of whole-army routing loses while living soldiers remain', () => {
    const scene = makeScene();
    const unit = addUnit(scene, 'red', 'infantry', 30, 30);
    addUnit(scene, 'blue', 'infantry', 65, 30);
    route(scene, unit);
    scene.checkWin();
    advance(scene, 4.9);
    assert.equal(scene.battleOver, false);
    advance(scene, 0.2);
    assert.equal(scene.winner, 'blue');
    const report = scene.getBattleReport();
    assert.equal(report.endReason, 'rout');
    assert.equal(report.red, 1);
    assert.equal(report.teams.red.lost, 0);
    assert.equal(report.morale.red.routing, 1);
});

test('a collapse waits for a finite last volley and stops creating new attacks', () => {
    const scene = makeScene();
    const shooter = addUnit(scene, 'red', 'archer', 30, 30);
    const target = addUnit(scene, 'blue', 'archer', 35, 30);
    scene.fireArrow(shooter, target);
    route(scene, target);
    scene.checkWin();
    scene.simulationTime = 5000;
    scene.checkWin();
    assert.equal(scene.battleOver, false);
    assert.equal(scene.resolvingOutcome, true);
    advance(scene, 1);
    assert.equal(scene.battleOver, true);
    assert.equal(scene.arrows.length, 0);
    assert.equal(scene.battleQueue.length, 0);
    assert.equal(scene.winner, 'red');
});

test('a routed soldier stops at safe reserves and rallies after the wait and recovery period', () => {
    const scene = makeScene();
    const unit = addUnit(scene, 'red', 'infantry', 25, 30);
    for (const [x, y] of [[24, 29], [24, 31], [23, 30]]) addUnit(scene, 'red', 'infantry', x, y);
    addUnit(scene, 'blue', 'infantry', 60, 30);
    // Stationary reserves isolate real morale + retreat behavior from their normal advance AI.
    scene.updateNormalUnit = () => {};
    route(scene, unit);
    advance(scene, 3);
    assert.equal(unit.morale, 20);
    assert.ok(Math.abs(unit.gx - 25) < 0.05, 'the first snapshot may allow one movement step before shelter is confirmed');
    advance(scene, 8.4);
    assert.equal(unit.moraleState, 'wavering');
    assert.ok(unit.morale >= 45);
    assert.equal(scene.battleStats.red.rallied, 1);
    assert.equal(scene.battleStats.red.routed, 1);
    assert.equal(scene.battleStats.red.alive, 4);
});

test('a fleeing soldier actively seeks exactly three safe reserves away from its default retreat line', () => {
    const scene = makeScene();
    const unit = addUnit(scene, 'red', 'infantry', 35, 30);
    for (const [x, y] of [[26, 37], [25, 37], [26, 38]]) addUnit(scene, 'red', 'infantry', x, y);
    addUnit(scene, 'blue', 'infantry', 60, 30);
    scene.updateNormalUnit = () => {};
    route(scene, unit);
    advance(scene, 17);
    assert.equal(unit.withdrawn, false);
    assert.notEqual(unit.moraleState, 'routing');
    assert.equal(scene.battleStats.red.rallied, 1);
    assert.ok(unit.gx > 20 && unit.gx < 32);
    assert.ok(unit.gy > 33, 'rally navigation must take a detour toward reserves');
});

test('restart clears morale events, withdrawal and the collapse grace clock', () => {
    const scene = makeScene();
    const old = addUnit(scene, 'red', 'infantry', 30, 30);
    addUnit(scene, 'blue', 'infantry', 65, 30);
    route(scene, old);
    scene.checkWin();
    scene.withdrawUnit(old);
    scene.deployUnits({ infantry: 2 }, { infantry: 2 }, 'custom', 'custom');
    assert.deepEqual(snapshot(scene.collapseSince), { red: null, blue: null });
    assert.equal(scene.resolvingOutcome, false);
    assert.equal(scene.getBattleReport().events.length, 0);
    assert.equal(scene.getBattleReport().teams.red.withdrawn, 0);
    assert.ok(scene.units.every(unit => unit.morale === 100 && unit.moraleState === 'steady'));
});
