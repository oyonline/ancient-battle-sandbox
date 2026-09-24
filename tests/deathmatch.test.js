const test = require('node:test');
const assert = require('node:assert/strict');
const { makeScene, applyDamage, snapshot } = require('./battle-harness.js');

const STEP = 1000 / 60;
function fixture(redType = 'infantry', blueType = 'infantry') {
    const scene = makeScene();
    scene.deployUnits({ [redType]: 1 }, { [blueType]: 1 }, 'custom', 'custom', {}, { deathmatch: true });
    const red = scene.units.find(unit => unit.team === 'red');
    const blue = scene.units.find(unit => unit.team === 'blue');
    for (const [unit, x] of [[red, 20], [blue, 60]]) {
        Object.assign(unit, { gx: x, gy: 30, pgx: x, pgy: 30 });
    }
    scene.battleStarted = true;
    return { scene, red, blue };
}
function route(scene, unit) {
    const previous = unit.moraleState;
    unit.morale = 20;
    unit.moraleState = 'routing';
    scene.onMoraleStateChange(unit, previous, 'test retreat');
}
function advance(scene, seconds) {
    for (let frame = 0; frame < seconds * 60 && !scene.battleOver; frame++) scene.advanceBattle(STEP);
}

test('deathmatch keeps a routed army in battle past five seconds and prevents boundary withdrawal', () => {
    const { scene, red } = fixture();
    scene.updateNormalUnit = () => {};
    Object.assign(red, { gx: 0.6, pgx: 0.6 });
    route(scene, red);
    advance(scene, 6);
    assert.equal(scene.battleOver, false);
    assert.equal(red.moraleState, 'routing');
    assert.equal(red.withdrawn, false);
    scene.withdrawUnit(red);
    assert.equal(red.withdrawn, false, 'manual withdrawal must obey the same deathmatch rule');
    assert.equal(scene.getBattleReport().teams.red.withdrawn, 0);
    assert.equal(scene.getBattleReport().deathmatch, true);
});

test('isolated deathmatch survivors can regroup safely on the simulation clock without healing', () => {
    const { scene, red } = fixture();
    scene.updateNormalUnit = () => {};
    red.hp = 37;
    route(scene, red);
    advance(scene, 3);
    assert.equal(red.morale, 20, 'safety must be established before recovery begins');
    scene.togglePause();
    advance(scene, 20);
    assert.equal(red.morale, 20, 'pause must not accelerate regrouping');
    scene.togglePause();
    advance(scene, 11);
    assert.equal(red.moraleState, 'routing', 'deathmatch survivors must recover to 60 before returning');
    advance(scene, 3);
    assert.equal(red.moraleState, 'steady');
    assert.ok(red.morale >= 60);
    assert.equal(red.hp, 37, 'regrouping must not restore lost health');
    assert.equal(scene.battleStats.red.rallied, 1);
    assert.equal(scene.battleStats.red.lost, 0);
});

test('deathmatch cannot regenerate morale under nearby enemy pressure', () => {
    const { scene, red, blue } = fixture();
    Object.assign(blue, { gx: 24, pgx: 24 });
    // Hold both positions to isolate danger from walking and damage.
    scene.updateNormalUnit = scene.updateRoutedUnit = () => {};
    route(scene, red);
    advance(scene, 20);
    assert.equal(red.moraleState, 'routing');
    assert.equal(red.morale, 20);
    assert.equal(scene.battleOver, false);
    assert.equal(scene.battleStats.red.rallied, 0);
});

test('deathmatch still waits for the last airborne arrow and can end in mutual elimination', () => {
    const { scene, red, blue } = fixture('archer', 'archer');
    Object.assign(blue, { gx: 24, pgx: 24, hp: 1 });
    red.hp = 1;
    scene.fireArrow(red, blue);
    applyDamage(red, 1, blue);
    scene.checkWin();
    assert.equal(scene.battleOver, false);
    assert.equal(scene.resolvingOutcome, true);
    advance(scene, 1);
    assert.equal(scene.winner, 'draw');
    assert.equal(scene.redAlive, 0);
    assert.equal(scene.blueAlive, 0);
    assert.equal(scene.arrows.length, 0);
});

test('deployment copies and clamps reserve options and an ordinary restart clears deathmatch', () => {
    const scene = makeScene();
    const options = { deathmatch: true, reserves: { red: 50, blue: NaN } };
    scene.deployUnits({ infantry: 4 }, { pikeman: 4 }, 'custom', 'custom', {}, options);
    assert.deepEqual(snapshot(scene.battleOptions), { deathmatch: true, reserves: { red: 3, blue: 0 }, terrain: 'flat', cavalryOrders: { red: 'auto', blue: 'auto' } });
    options.reserves.red = 0;
    assert.equal(scene.battleOptions.reserves.red, 3, 'caller state must not mutate an ongoing battle');
    scene.deployUnits({ infantry: 4 }, { pikeman: 4 }, 'custom', 'custom');
    assert.deepEqual(snapshot(scene.battleOptions), { deathmatch: false, reserves: { red: 0, blue: 0 }, terrain: 'flat', cavalryOrders: { red: 'auto', blue: 'auto' } });
    assert.equal(scene.tactics, null);
    assert.equal(scene.getBattleReport().deathmatch, false);
});
