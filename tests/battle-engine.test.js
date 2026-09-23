const test = require('node:test');
const assert = require('node:assert/strict');
const { IsoBattleScene, applyDamage, calculateAttackDamage, resolveAttack, snapshot, makeScene, addUnit } = require('./battle-harness.js');

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
    let bloodPools = 0, corpseStamps = 0;
    const stopped = new Set();
    scene.killUnit = IsoBattleScene.prototype.killUnit;
    scene.tweens.killTweensOf = target => { stopped.add(target); };
    scene.addBloodPool = () => { bloodPools++; };
    scene.stampCorpse = () => { corpseStamps++; return true; };
    applyDamage(blue, 1000, red);
    assert.equal(scene.dyingUnits.has(blue), true);
    const oldDeath = blue.deathVisual;
    assert.ok(oldDeath);
    scene.units = scene.units.filter(unit => !unit.dead); // Same removal as periodic compaction.
    scene.deployUnits({ infantry: 2 }, { archer: 1 }, 'custom', 'custom');
    assert.equal(stopped.has(blue.spr), true, 'detached death tween must be stopped');
    assert.equal(blue.spr.destroyed, true);
    assert.equal(blue.deathVisual, null);
    // Even a stale visual reappearing after cleanup cannot stamp into a new battle.
    blue.deathVisual = oldDeath;
    scene.dyingUnits.add(blue);
    scene.updateDeathVisuals(50);
    assert.equal(bloodPools, 0);
    assert.equal(corpseStamps, 0);
    assert.equal(scene.dyingUnits.size, 0);
});

test('counter and brace multipliers precede one armor deduction; final damage is never modified again', () => {
    const scene = makeScene();
    const pike = addUnit(scene, 'red', 'pikeman');
    const cavalry = addUnit(scene, 'blue', 'cavalry');
    assert.equal(calculateAttackDamage(pike, cavalry), 30); // 18 * 2.5 - 15
    assert.equal(calculateAttackDamage(pike, cavalry, { multiplier: 1.5 }), 52);
    assert.equal(resolveAttack(cavalry, pike), 30);
    assert.equal(cavalry.hp, 130);
    assert.equal(applyDamage(cavalry, 6, pike), 6, 'applyDamage accepts already-final damage');
    assert.equal(cavalry.hp, 124);
    assert.equal(scene.getBattleReport().teams.red.damage, 36);
});

test('cavalry needs three actual traveled cells before its double-damage charge', () => {
    const close = makeScene();
    const closeCavalry = addUnit(close, 'red', 'cavalry', 30, 30);
    const closeTarget = addUnit(close, 'blue', 'archer', 31, 30);
    closeTarget.typeData = { ...closeTarget.typeData, speed: 0 };
    for (let i = 0; i < 60 && closeTarget.hp === closeTarget.maxHp; i++) close.advanceBattle(1000 / 60);
    assert.equal(closeTarget.hp, 23, 'point-blank cavalry deals a normal 30 - 3 attack');
    assert.equal(closeCavalry.state, 'melee');

    const run = makeScene();
    const cavalry = addUnit(run, 'red', 'cavalry', 20, 30);
    const target = addUnit(run, 'blue', 'infantry', 26, 30);
    target.typeData = { ...target.typeData, speed: 0 };
    for (let i = 0; i < 180 && target.hp === target.maxHp; i++) run.advanceBattle(1000 / 60);
    assert.equal(target.hp, 50, 'a real run-up enables 30 * 2 - 10 damage');
    assert.equal(cavalry.state, 'pierce');
});

test('uncommitted or blocked movement cannot accumulate charge distance', () => {
    const scene = makeScene();
    const cavalry = addUnit(scene, 'red', 'cavalry', 20, 30);
    addUnit(scene, 'blue', 'archer', 30, 30);
    scene.rebuildSpatial();
    scene.planningStep = true;
    for (let i = 0; i < 100; i++) scene.cavalryAI.update(cavalry, i * 17, 1 / 60);
    assert.equal(cavalry.gx, 20, 'movement intents have not been committed');
    assert.equal(cavalry.chargeDistance, 0);
});

test('contact with a front soldier interrupts unready cavalry instead of pushing through to build a charge', () => {
    for (const mirrored of [false, true]) for (const coolingDown of [false, true]) {
        const scene = makeScene();
        const x = value => mirrored ? 70 - value : value;
        const cavalryTeam = mirrored ? 'blue' : 'red', enemyTeam = mirrored ? 'red' : 'blue';
        const cavalry = addUnit(scene, cavalryTeam, 'cavalry', x(30), 30);
        const infantry = addUnit(scene, enemyTeam, 'infantry', x(30.6), 30);
        addUnit(scene, enemyTeam, 'archer', x(35), 30);
        if (coolingDown) { cavalry.chargeDistance = 3.5; cavalry.lastAttack = 0; }
        for (let step = 0; step < 57; step++) {
            scene.advanceBattle(1000 / 60);
            assert.equal(cavalry.state, 'melee');
            assert.equal(cavalry.chargeDistance, 0, 'body contact must end the run-up');
            assert.equal(cavalry.chargeImpactId, null, 'pushing the front line must never enable a double hit');
        }
        assert.ok(infantry.hp >= 80, 'only a normal melee hit may land in this first second');
    }
});

test('a point-blank target behind the cavalry cannot inherit its previous run-up', () => {
    const scene = makeScene();
    const cavalry = addUnit(scene, 'red', 'cavalry', 30, 30);
    const archer = addUnit(scene, 'blue', 'archer', 29, 30);
    cavalry.chargeDistance = 3.5;
    cavalry.chargeDX = 1; cavalry.chargeDY = 0;
    cavalry.target = null;
    scene.rebuildSpatial();
    assert.equal(scene.cavalryAI.charge(cavalry, 1000, 1 / 60), false);
    assert.equal(cavalry.state, 'melee');
    assert.equal(cavalry.chargeDistance, 0);
    assert.equal(archer.hp, 50);
});

function supportPike(scene, spear, prepared = true) {
    const supports = [0.8, 1.6].map(depth => addUnit(scene, spear.team, 'pikeman',
        spear.gx - spear.braceFacingX * depth, spear.gy - spear.braceFacingY * depth));
    if (prepared) for (const unit of [spear, ...supports]) unit.braceTime = 0.5;
    return supports;
}

test('a prepared frontal pike formation resists the charge while both impact and brace land', () => {
    const scene = makeScene();
    const cavalry = addUnit(scene, 'red', 'cavalry', 30, 30);
    const spear = addUnit(scene, 'blue', 'pikeman', 31.4, 30);
    supportPike(scene, spear);
    const archer = addUnit(scene, 'blue', 'archer', 34, 30);
    cavalry.chargeDistance = 3;
    cavalry.target = archer;
    scene.advanceBattle(1000 / 60);
    assert.equal(cavalry.state, 'melee');
    assert.equal(cavalry.chargeDistance, 0);
    assert.equal(cavalry.hp, 108);
    assert.equal(spear.hp, 28, 'resistance must not swallow the cavalry first-impact damage');
    assert.equal(archer.hp, 50);
    assert.ok(cavalry.gx < spear.gx);
    assert.ok(scene.getBattleReport().events.some(event => event.text.includes('正面枪阵迎击')));
});

test('a lone spear is knocked aside without unconditionally stopping a running cavalry', () => {
    const scene = makeScene();
    const cavalry = addUnit(scene, 'red', 'cavalry', 30, 30);
    const spear = addUnit(scene, 'blue', 'pikeman', 31.2, 30);
    addUnit(scene, 'blue', 'archer', 35, 30);
    cavalry.chargeDistance = 3.5;
    for (let i = 0; i < 120 && cavalry.chargeImpactId == null; i++) scene.advanceBattle(1000 / 60);
    assert.equal(cavalry.chargeImpactId, spear.id);
    assert.equal(spear.hp, 28);
    assert.equal(spear.braceReady, false);
    assert.equal(cavalry.state, 'pierce');
    assert.ok(cavalry.chargeMomentum > 0.5);
    assert.ok(spear.gx > 31.8, 'a loose spear yields to the first-impact knockback');
    assert.equal(scene.getBattleReport().events.some(event => event.text.includes('枪阵迎击')), false);
});

test('a supported spear must stand for half a simulation second, and pause or movement cannot skip preparation', () => {
    const scene = makeScene();
    const spear = addUnit(scene, 'blue', 'pikeman', 31.4, 30);
    // All three spears can see the approaching cavalry before it reaches the line.
    addUnit(scene, 'blue', 'pikeman', 31.4, 28.8);
    addUnit(scene, 'blue', 'pikeman', 31.4, 31.2);
    addUnit(scene, 'red', 'cavalry', 25.5, 30);
    for (let i = 0; i < 15; i++) scene.advanceBattle(1000 / 60);
    assert.equal(spear.braceReady, false);
    const preparedFor = spear.braceTime;
    scene.togglePause();
    for (let i = 0; i < 60; i++) scene.advanceBattle(1000 / 60);
    assert.equal(spear.braceTime, preparedFor);
    scene.togglePause();
    for (let i = 0; i < 16; i++) scene.advanceBattle(1000 / 60);
    assert.equal(spear.braceReady, true);
    spear.moving = true;
    spear.pgx = spear.gx + 0.1;
    scene.advanceBattle(1000 / 60);
    assert.equal(spear.braceReady, false);
    assert.equal(spear.braceTime, 0);
});

test('a stopped melee cavalry cannot hold supporting spears outside their attack range', () => {
    for (const laterCharge of [false, true]) {
        const scene = makeScene();
        const spear = addUnit(scene, 'blue', 'pikeman', 31.4, 30);
        supportPike(scene, spear);
        const cavalry = addUnit(scene, 'red', 'cavalry', 28.7, 30);
        cavalry.state = 'melee';
        if (laterCharge) addUnit(scene, 'red', 'cavalry', 26, 30);
        const before = spear.gx;
        scene.advanceBattle(1000 / 60);
        assert.equal(spear.moving, true);
        assert.ok(spear.gx < before, 'the rear line must close on its stopped opponent even with another charge farther away');
    }
});

test('side and rear approaches cannot instantly turn a prepared pike formation into a frontal barrier', () => {
    for (const approach of ['side', 'rear']) {
        const scene = makeScene();
        const spear = addUnit(scene, 'blue', 'pikeman', 31.4, 30);
        supportPike(scene, spear);
        const cavalry = addUnit(scene, 'red', 'cavalry', approach === 'side' ? 31.4 : 33.8, approach === 'side' ? 28.6 : 30);
        const archer = addUnit(scene, 'blue', 'archer', approach === 'side' ? 31.4 : 27, approach === 'side' ? 35 : 30);
        cavalry.chargeDistance = 3.5;
        cavalry.chargeDX = approach === 'side' ? 0 : -1;
        cavalry.chargeDY = approach === 'side' ? 1 : 0;
        cavalry.target = archer;
        for (let i = 0; i < 120 && cavalry.chargeImpactId == null; i++) scene.advanceBattle(1000 / 60);
        assert.ok(cavalry.chargeImpactId != null, `${approach} approach must make contact`);
        assert.equal(cavalry.state, 'pierce', `${approach} contact must retain forward momentum`);
        assert.ok(cavalry.chargeMomentum > 0);
        assert.equal(scene.getBattleReport().events.some(event => event.text.includes('枪阵迎击')), false);
    }
});

test('a moving spear with nearby support cannot immediately brace against the first impact', () => {
    const scene = makeScene();
    const cavalry = addUnit(scene, 'red', 'cavalry', 30, 30);
    const spear = addUnit(scene, 'blue', 'pikeman', 31.4, 30);
    supportPike(scene, spear);
    const archer = addUnit(scene, 'blue', 'archer', 35, 30);
    spear.moving = true;
    spear.pgx = spear.gx + 0.03; spear.pgy = spear.gy;
    cavalry.chargeDistance = 3.5;
    cavalry.target = archer;
    for (let i = 0; i < 120 && cavalry.chargeImpactId == null; i++) scene.advanceBattle(1000 / 60);
    assert.equal(cavalry.chargeImpactId, spear.id);
    assert.equal(cavalry.state, 'pierce');
    assert.equal(spear.braceReady, false);
    assert.equal(scene.getBattleReport().events.some(event => event.text.includes('枪阵迎击')), false);
});

test('a shared brace cooldown chooses the closest arriving cavalry regardless of update order', () => {
    function interceptPair(reverse) {
        const scene = makeScene();
        const a = addUnit(scene, 'red', 'cavalry', 30, 30);
        const b = addUnit(scene, 'red', 'cavalry', 30, 30.2);
        const spear = addUnit(scene, 'blue', 'pikeman', 31.4, 30);
        supportPike(scene, spear);
        const archer = addUnit(scene, 'blue', 'archer', 35, 30);
        a.hp = 50;
        for (const cavalry of [a, b]) {
            cavalry.chargeDistance = 3.5;
            cavalry.chargeDX = 1; cavalry.chargeDY = 0;
            cavalry.target = archer; cavalry.lastRetarget = 0;
        }
        if (reverse) scene.units.reverse();
        scene.advanceBattle(1000 / 60);
        return { a: a.hp, b: b.hp, alive: scene.redAlive, lastBrace: spear.lastBrace };
    }
    const normal = interceptPair(false);
    assert.deepEqual(interceptPair(true), normal);
    assert.equal(normal.a, 0);
    assert.equal(normal.b, 160);
    assert.equal(normal.alive, 1);
});

test('a spear lethally hit in a step still delivers a valid brace from that same step', () => {
    const scene = makeScene();
    const cavalry = addUnit(scene, 'red', 'cavalry', 30, 30);
    const spear = addUnit(scene, 'blue', 'pikeman', 31.4, 30);
    supportPike(scene, spear);
    const archer = addUnit(scene, 'blue', 'archer', 35, 30);
    cavalry.chargeDistance = 3.5;
    cavalry.target = archer;
    scene.scheduleBattleAction(0, () => resolveAttack(spear, cavalry, { rawAttack: 1000 }));
    scene.advanceBattle(1000 / 60);
    assert.equal(spear.dead, true);
    assert.equal(cavalry.hp, 108);
    assert.equal(scene.getBattleReport().teams.blue.byType.pikeman.damage, 52);
});

test('intercepted cavalry must disengage before it can build a new charge', () => {
    const scene = makeScene();
    const cavalry = addUnit(scene, 'red', 'cavalry', 30, 30);
    const spear = addUnit(scene, 'blue', 'pikeman', 31, 30);
    scene.cavalryAI.enterMelee(cavalry);
    scene.rebuildSpatial();
    for (let i = 0; i < 240; i++) scene.cavalryAI.update(cavalry, i * 17, 1 / 60);
    assert.equal(cavalry.state, 'melee', 'nearby spears deny immediate charge resets');
    spear.gx = 40;
    scene.rebuildSpatial();
    scene.cavalryAI.update(cavalry, 5000, 1 / 60);
    assert.equal(cavalry.state, 'charge');
    assert.equal(cavalry.chargeDistance, 0, 'disengagement only allows a new run-up');
});

test('piercing hits at most three additional soldiers once per pass', () => {
    const scene = makeScene();
    const cavalry = addUnit(scene, 'red', 'cavalry', 30, 30);
    const firstTarget = addUnit(scene, 'blue', 'archer', 36, 30);
    for (let i = 0; i < 5; i++) addUnit(scene, 'blue', 'archer', 30.2, 29.8 + i * 0.1);
    cavalry.state = 'pierce'; cavalry.pierceX = 34; cavalry.pierceY = 30;
    cavalry.chargeMomentum = 0.9;
    cavalry.pierceHits = new Set([firstTarget.id]);
    scene.rebuildSpatial();
    for (let i = 0; i < 20 && cavalry.state === 'pierce'; i++) scene.cavalryAI.pierce(cavalry, i * 100, 0);
    assert.equal(cavalry.pierceHits.size, 4);
    assert.equal(scene.getBattleReport().teams.red.damage, 36);
});

test('cavalry archer preference uses a circular 12-cell radius and refreshes distant targets', () => {
    const scene = makeScene();
    const cavalry = addUnit(scene, 'red', 'cavalry', 30, 30);
    const infantry = addUnit(scene, 'blue', 'infantry', 35, 30);
    const archer = addUnit(scene, 'blue', 'archer', 42.1, 30);
    scene.rebuildSpatial();
    assert.equal(scene.cavalryAI.pickTarget(cavalry), infantry);
    archer.gx = 41.9;
    scene.rebuildSpatial();
    cavalry.target = infantry; cavalry.lastRetarget = 0;
    scene.cavalryAI.update(cavalry, 600, 1 / 60);
    assert.equal(cavalry.target, archer);
});

test('attacks landing in the same simulation step can kill both armies regardless of iteration order', () => {
    for (const reverse of [false, true]) {
        const scene = makeScene();
        const red = addUnit(scene, 'red', 'infantry', 30, 30);
        const blue = addUnit(scene, 'blue', 'infantry', 30.7, 30);
        red.hp = blue.hp = 6;
        if (reverse) scene.units.reverse();
        for (let i = 0; i < 20 && !scene.battleOver; i++) scene.advanceBattle(1000 / 60);
        assert.equal(scene.winner, 'draw');
        const report = scene.getBattleReport();
        assert.equal(report.teams.red.kills, 1);
        assert.equal(report.teams.blue.kills, 1);
        assert.equal(report.teams.red.damage, 6);
        assert.equal(report.teams.blue.damage, 6);
    }
});

test('movement and ranged combat remain mirrored when armies exchange sides', () => {
    const left = makeScene(), right = makeScene();
    const aArcher = addUnit(left, 'red', 'archer', 28, 30);
    const aSword = addUnit(left, 'blue', 'infantry', 32, 30);
    const bSword = addUnit(right, 'red', 'infantry', 38, 30);
    const bArcher = addUnit(right, 'blue', 'archer', 42, 30);
    for (let i = 0; i < 600; i++) {
        left.advanceBattle(1000 / 60);
        right.advanceBattle(1000 / 60);
    }
    for (const [a, b] of [[aArcher, bArcher], [aSword, bSword]]) {
        assert.ok(Math.abs(70 - a.gx - b.gx) < 1e-6, 'x positions mirror around the battlefield center');
        assert.ok(Math.abs(a.gy - b.gy) < 1e-6);
        assert.equal(a.hp, b.hp);
    }
});

test('360-gold sword/archer armies preserve every mirrored position through half-grid rounding and finish equally', () => {
    const forward = makeScene(), reversed = makeScene();
    forward.deployUnits({ infantry: 72 }, { archer: 45 }, 'custom', 'custom');
    reversed.deployUnits({ archer: 45 }, { infantry: 72 }, 'custom', 'custom');
    forward.battleStarted = reversed.battleStarted = true;
    const pairs = [];
    for (const team of ['red', 'blue']) {
        const opposite = team === 'red' ? 'blue' : 'red';
        const a = forward.units.filter(unit => unit.team === team);
        const b = reversed.units.filter(unit => unit.team === opposite);
        for (let i = 0; i < a.length; i++) pairs.push([a[i], b[i]]);
    }
    for (let step = 0; step < 18000 && (!forward.battleOver || !reversed.battleOver); step++) {
        forward.advanceBattle(1000 / 60);
        reversed.advanceBattle(1000 / 60);
        // Absolute Math.round previously diverged at step 577, then changed the winner.
        if (step < 650) {
            for (const [a, b] of pairs) {
                assert.ok(Math.abs(a.gx + b.gx - 70) < 1e-9, `mirrored x diverged at step ${step}`);
                assert.ok(Math.abs(a.gy - b.gy) < 1e-9, `mirrored y diverged at step ${step}`);
                assert.equal(a.hp, b.hp);
            }
        }
    }
    assert.equal(forward.battleOver && reversed.battleOver, true);
    assert.equal(forward.redAlive, reversed.blueAlive);
    assert.equal(forward.blueAlive, reversed.redAlive);
    assert.equal(forward.getBattleReport().durationMs, reversed.getBattleReport().durationMs);
});
