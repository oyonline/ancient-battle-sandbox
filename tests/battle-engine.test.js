const test = require('node:test');
const assert = require('node:assert/strict');
const { IsoBattleScene, applyDamage, snapshot, makeScene, addUnit } = require('./battle-harness.js');

test('war report counts effective damage and attributes each death exactly once', () => {
    const scene = makeScene();
    const red = addUnit(scene, 'red', 'infantry');
    const blue = addUnit(scene, 'blue', 'archer');
    assert.equal(applyDamage(blue, 20, red), 20);
    assert.equal(applyDamage(blue, 1000, red), 30);
    assert.equal(applyDamage(blue, 1000, red), 0);
    const report = scene.getBattleReport();
    assert.deepEqual(snapshot(report.teams.red.byType.infantry), {
        initial: 1, alive: 1, lost: 0, kills: 1, damage: 50
    });
    assert.deepEqual(snapshot(report.teams.blue.byType.archer), {
        initial: 1, alive: 0, lost: 1, kills: 0, damage: 0
    });
    assert.equal(report.teams.red.damage, 50);
    assert.equal(report.teams.blue.lost, 1);
    assert.equal(report.events.filter(event => event.text.includes('首杀')).length, 1);
    report.teams.red.kills = 99;
    assert.equal(scene.getBattleReport().teams.red.kills, 1, 'reports must be snapshots');
});

test('an arrow retains kill credit after its shooter dies; final volleys can draw', () => {
    const scene = makeScene();
    const archer = addUnit(scene, 'red', 'archer', 30, 30);
    const target = addUnit(scene, 'blue', 'infantry', 31, 30);
    target.hp = 10;
    scene.fireArrow(archer, target);
    applyDamage(archer, 1000, target);
    scene.checkWin();
    assert.equal(scene.battleOver, false, 'wait for the arrow already in flight');
    scene.rebuildSpatial();
    scene.updateArrows(1, 1000);
    scene.checkWin();
    const report = scene.getBattleReport();
    assert.equal(scene.winner, 'draw');
    assert.equal(report.red, 0);
    assert.equal(report.blue, 0);
    assert.equal(report.teams.red.byType.archer.kills, 1);
    assert.equal(report.teams.red.byType.archer.damage, 10);
    assert.equal(report.teams.blue.byType.infantry.kills, 1);
});

test('pause freezes the battle clock and queued melee damage', () => {
    const scene = makeScene();
    const red = addUnit(scene, 'red', 'infantry', 30, 30);
    const blue = addUnit(scene, 'blue', 'infantry', 30.7, 30);
    scene.advanceBattle(1000 / 60);
    assert.equal(scene.battleQueue.length, 2, 'attacks enter the simulation queue');
    const atPause = scene.simulationTime;
    scene.togglePause();
    for (let i = 0; i < 120; i++) scene.advanceBattle(1000 / 60);
    assert.equal(scene.simulationTime, atPause);
    assert.equal(red.hp, 100);
    assert.equal(blue.hp, 100);
    scene.togglePause();
    for (let i = 0; i < 6; i++) scene.advanceBattle(1000 / 60);
    assert.equal(red.hp, 94);
    assert.equal(blue.hp, 94);
});

function runMixedBattle(speed) {
    const scene = makeScene();
    addUnit(scene, 'red', 'infantry', 30, 30);
    addUnit(scene, 'red', 'infantry', 30, 32);
    addUnit(scene, 'red', 'archer', 27, 31);
    addUnit(scene, 'red', 'pikeman', 31, 31);
    addUnit(scene, 'red', 'cavalry', 30, 35);
    addUnit(scene, 'blue', 'infantry', 34, 30);
    addUnit(scene, 'blue', 'infantry', 34, 32);
    addUnit(scene, 'blue', 'archer', 37, 31);
    addUnit(scene, 'blue', 'pikeman', 33, 31);
    addUnit(scene, 'blue', 'cavalry', 34, 35);
    scene.setSpeed(speed);
    for (let i = 0; i < 12000 && !scene.battleOver; i++) scene.advanceBattle(1000 / 60);
    assert.equal(scene.battleOver, true, 'test fixture must reach a result');
    return { winner: scene.winner, report: snapshot(scene.getBattleReport()) };
}

test('1x and 2x produce identical full battle outcomes, attribution, and simulation duration', () => {
    assert.deepEqual(runMixedBattle(1), runMixedBattle(2));
});

test('new deployment clears old damage, countdown callbacks, speed, pause, and report', () => {
    const scene = makeScene();
    const oldRed = addUnit(scene, 'red', 'infantry');
    const oldBlue = addUnit(scene, 'blue', 'infantry');
    let oldActionRan = false, oldCountdownFinished = false;
    scene.scheduleBattleAction(50, () => { oldActionRan = true; });
    const staleAction = scene.battleQueue[0];
    scene.startCountdown(() => { oldCountdownFinished = true; });
    const oldTimers = [...scene.countdownTimers];
    scene.setSpeed(2);
    scene.togglePause();
    scene.deployUnits({ infantry: 2 }, { archer: 1 }, 'custom', 'custom');
    assert.ok(oldTimers.every(timer => timer.removed));
    for (const timer of oldTimers) timer.callback();
    assert.equal(oldCountdownFinished, false);
    assert.equal(scene.battleStarted, false);
    assert.equal(scene.paused, false);
    assert.equal(scene.gameSpeed, 1);
    assert.equal(scene.anims.globalTimeScale, 1);
    assert.equal(scene.simulationTime, 0);
    assert.equal(scene.battleQueue.length, 0);
    assert.equal(scene.arrows.length, 0);
    scene.battleQueue.push(staleAction);
    scene.simulationTime = 100;
    scene.flushBattleActions();
    assert.equal(oldActionRan, false, 'stale epochs cannot execute');
    assert.equal(applyDamage(oldBlue, 100, oldRed), 0);
    assert.equal(applyDamage(scene.units.find(unit => unit.team === 'blue'), 100, oldRed), 0);
    const report = scene.getBattleReport();
    assert.equal(report.teams.red.initial, 2);
    assert.equal(report.teams.blue.initial, 1);
    assert.equal(report.teams.red.kills, 0);
    assert.equal(report.events.length, 0);
});

test('a dying unit removed by compaction cannot stamp a corpse into the next battle', () => {
    const scene = makeScene();
    const red = addUnit(scene, 'red', 'infantry');
    const blue = addUnit(scene, 'blue', 'infantry');
    let deathTween, bloodPools = 0, corpseStamps = 0;
    const stopped = new Set();
    scene.killUnit = IsoBattleScene.prototype.killUnit;
    scene.tweens.add = tween => { deathTween = tween; };
    scene.tweens.killTweensOf = target => { stopped.add(target); };
    scene.addBloodPool = () => { bloodPools++; };
    scene.stampCorpse = () => { corpseStamps++; return true; };
    applyDamage(blue, 1000, red);
    assert.equal(scene.dyingUnits.has(blue), true);
    scene.units = scene.units.filter(unit => !unit.dead); // Same removal as periodic compaction.
    scene.deployUnits({ infantry: 2 }, { archer: 1 }, 'custom', 'custom');
    assert.equal(stopped.has(blue.spr), true, 'detached death tween must be stopped');
    assert.equal(blue.spr.destroyed, true);
    deathTween.onComplete(); // Even an already queued completion is isolated by its battle epoch.
    assert.equal(bloodPools, 0);
    assert.equal(corpseStamps, 0);
    assert.equal(scene.dyingUnits.size, 0);
});
