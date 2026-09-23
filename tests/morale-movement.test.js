const test = require('node:test');
const assert = require('node:assert/strict');
const { makeScene, addUnit } = require('./battle-harness');

function change(scene, unit, state, at) {
    const previous = unit.moraleState;
    scene.simulationTime = at;
    unit.moraleState = state;
    unit.morale = state === 'routing' ? 20 : 60;
    scene.onMoraleStateChange(unit, previous, 'test');
}

test('wavering retreat actually moves away while defending, then routing takes over and cancels attacks', () => {
    const scene = makeScene();
    const unit = addUnit(scene, 'red', 'infantry', 30, 30);
    const enemy = addUnit(scene, 'blue', 'infantry', 30.8, 30);
    enemy.typeData = { ...enemy.typeData, speed: 0, atkSpeed: Infinity };
    unit.morale = 35; unit.moraleState = 'wavering'; unit.moraleFallBackUntil = 900;
    for (let i = 0; i < 18; i++) scene.advanceBattle(1000 / 60);
    assert.ok(unit.gx < 29.9, 'wavering has a visible physical retreat');
    assert.ok(enemy.hp < enemy.maxHp, 'controlled withdrawal still permits a real defensive strike');
    assert.ok(unit.retreatFacingX > 0.9, 'retreat keeps the enemy in view');
    change(scene, unit, 'routing', scene.simulationTime);
    const health = enemy.hp;
    assert.equal(unit.moraleFallBackUntil, 0);
    assert.equal(scene.updateFallingBackUnit(unit, scene.simulationTime, 1 / 60), false);
    for (let i = 0; i < 20; i++) scene.advanceBattle(1000 / 60);
    assert.equal(enemy.hp, health, 'routed troops cannot keep attacking through the fallback behavior');
});

test('routed troops briefly disengage at close quarters but do not delay departure at a safe map edge', () => {
    const run = distance => {
        const scene = makeScene();
        const unit = addUnit(scene, 'red', 'infantry', 20, 30);
        addUnit(scene, 'blue', 'infantry', 20 + distance, 30);
        change(scene, unit, 'routing', 0);
        scene.rebuildSpatial();
        scene.updateRoutedUnit(unit, 0.1);
        return 20 - unit.gx;
    };
    assert.ok(Math.abs(run(1) - 0.154) < 1e-7);
    assert.ok(Math.abs(run(20) - 0.22) < 1e-7);
});

test('supported guards stay under formation control, while isolated guards can retreat and still truly rout', () => {
    const scene = makeScene();
    const guard = addUnit(scene, 'blue', 'pikeman', 30, 30);
    addUnit(scene, 'red', 'infantry', 31, 30);
    Object.assign(guard, { tacticalRole: 'guard', guardSupport: 2, guardReady: true, guardStableTime: 0.65,
        morale: 35, moraleState: 'wavering', moraleFallBackUntil: 900,
        formationSlot: { gx: 30, gy: 30, unit: guard } });
    scene.tactics = { formations: { blue: { members: [guard] } } };
    scene.rebuildSpatial();
    assert.equal(scene.updateFallingBackUnit(guard, 0, 0.1), false);
    assert.equal(guard.moraleFallBackUntil, 0);
    assert.equal(guard.guardReady, true, 'a held position does not lose its prepared spear to an unperformed retreat');
    assert.equal(guard.gx, 30);
    guard.guardSupport = 1; guard.moraleFallBackUntil = 900;
    assert.equal(scene.updateFallingBackUnit(guard, 0, 0.1), true);
    assert.ok(guard.gx < 30, 'an unsupported guard still takes a real backward step');
    assert.equal(guard.guardReady, false);
    change(scene, guard, 'routing', 100);
    assert.equal(guard.moraleState, 'routing', 'formation discipline never blocks actual collapse');
    assert.equal(scene.updateFallingBackUnit(guard, 100, 0.1), false);
});

test('rallied pike brace damage counts as real return-to-combat without changing its attack cooldown', () => {
    for (const queued of [false, true]) {
        const scene = makeScene();
        const guard = addUnit(scene, 'blue', 'pikeman', 30, 30);
        const horse = addUnit(scene, 'red', 'cavalry', 31, 30);
        change(scene, guard, 'routing', 0);
        change(scene, guard, 'steady', 1000);
        const previousAttack = guard.lastAttack;
        scene.collectingImpacts = queued;
        scene.resolveBrace(guard, horse);
        if (queued) scene.flushBattleImpacts();
        assert.equal(guard.lastAttack, previousAttack);
        assert.equal(scene.battleStats.blue.postRallyDamage, 52);
        assert.equal(scene.battleStats.blue.reengaged, 1);
        assert.equal(guard.moralePhase, null);
    }
});

test('an airborne arrow fired before routing is not misreported as a post-rally contribution', () => {
    const scene = makeScene();
    const archer = addUnit(scene, 'red', 'archer', 30, 30);
    const enemy = addUnit(scene, 'blue', 'infantry', 35, 30);
    scene.fireArrow(archer, enemy);
    change(scene, archer, 'routing', 100);
    change(scene, archer, 'steady', 1000);
    archer.lastAttack = 1000; // A later action cannot rewrite the old arrow's provenance.
    scene.rebuildSpatial();
    scene.updateArrows(1, 1000);
    assert.ok(scene.battleStats.red.damage > 0);
    assert.equal(scene.battleStats.red.postRallyDamage, 0);
    assert.equal(scene.battleStats.red.reengaged, 0);
    scene.fireArrow(archer, enemy);
    scene.updateArrows(1, 2000);
    assert.equal(scene.battleStats.red.postRallyDamage, 16);
    assert.equal(scene.battleStats.red.reengaged, 1);
});

test('summary distinguishes escape, recovery, forming and returning while keeping head counts consistent', () => {
    const scene = makeScene();
    const units = Array.from({ length: 4 }, (_, i) => addUnit(scene, 'red', 'infantry', 20 + i, 30));
    Object.assign(units[0], { moraleState: 'routing', moralePhase: 'escaping' });
    Object.assign(units[1], { moraleState: 'routing', moralePhase: 'recovering' });
    Object.assign(units[2], { rallyWaiting: true, moralePhase: 'forming' });
    units[3].moralePhase = 'returning';
    const stats = scene.getMoraleSummary().red;
    assert.equal(stats.escaping, 1); assert.equal(stats.recovering, 1);
    assert.equal(stats.forming, 1); assert.equal(stats.returning, 1);
    assert.equal(stats.steady + stats.wavering + stats.routing, 4);
    Object.assign(units[3], { moraleState: 'wavering', morale: 35, moraleFallBackUntil: 900 });
    const retreating = scene.getMoraleSummary().red;
    assert.equal(retreating.fallingBack, 1, 'renewed pressure takes visual priority over returning');
    assert.equal(retreating.returning, 0);
    assert.equal(retreating.steady + retreating.wavering + retreating.routing, 4);
});
