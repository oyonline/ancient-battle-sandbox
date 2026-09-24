const test = require('node:test');
const assert = require('node:assert/strict');
const {
    Terrain, UNIT_TYPES, moveToward, calculateAttackDamage, resolveAttack, makeScene, addUnit
} = require('./battle-harness.js');

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-10,
    message || `${actual} should equal ${expected}`);

test('terrain keys normalize safely and mirror twice back to the original map', () => {
    for (const key of [undefined, null, '', 'missing', 'toString', '__proto__']) {
        assert.equal(Terrain.normalize(key), 'flat');
        assert.equal(Terrain.height(key, 19, 35), 0);
    }
    for (const key of Object.keys(Terrain.maps)) assert.equal(Terrain.mirror(Terrain.mirror(key)), key);
});

test('hill has a flat crown, smooth slopes, and an unchanged zero-height map boundary', () => {
    assert.equal(Terrain.height('red_hill', 19, 35), 3);
    assert.equal(Terrain.height('red_hill', 23, 35), 3);
    assert.equal(Terrain.height('red_hill', 60, 35), 0);
    assert.ok(Terrain.height('red_hill', 34, 35) > Terrain.height('red_hill', 35, 35));
    for (const key of ['red_hill', 'blue_hill']) {
        for (let n = 0; n <= 70; n++) {
            for (const [x, y] of [[0, n], [70, n], [n, 0], [n, 70]]) {
                assert.equal(Terrain.height(key, x, y), 0);
            }
        }
        for (let x = 0; x <= 70; x += 0.5) {
            const h = Terrain.height(key, x, 35);
            assert.ok(h >= 0 && h <= 3);
            assert.ok(Math.abs(h - Terrain.height(key, x + 0.001, 35)) < 0.001);
        }
    }
});

test('height and directional rules are exact red/blue mirror equivalents', () => {
    for (let x = 1; x < 70; x += 2) for (let y = 1; y < 70; y += 3) {
        close(Terrain.height('red_hill', x, y), Terrain.height('blue_hill', 70 - x, y));
        close(Terrain.movementMultiplier('red_hill', x, y, x - 4, y + 2),
            Terrain.movementMultiplier('blue_hill', 70 - x, y, 74 - x, y + 2));
        const from = { gx: x, gy: y, typeData: UNIT_TYPES.archer }, to = { gx: x + 5, gy: y };
        const mirrorFrom = { ...from, gx: 70 - x }, mirrorTo = { ...to, gx: 65 - x };
        close(Terrain.attackMultiplier('red_hill', from, to), Terrain.attackMultiplier('blue_hill', mirrorFrom, mirrorTo));
        close(Terrain.rangedRange('red_hill', from, to), Terrain.rangedRange('blue_hill', mirrorFrom, mirrorTo));
    }
});

test('movement samples the local slope, returns to normal on the crown, and stays bounded', () => {
    assert.equal(Terrain.movementMultiplier('flat', 35, 35, 19, 35), 1);
    assert.equal(Terrain.movementMultiplier('red_hill', 60, 35, 19, 35), 1,
        'distant uphill destination must not slow flat ground');
    assert.equal(Terrain.movementMultiplier('red_hill', 19, 35, 50, 35), 1,
        'the level crown uses normal speed even with a downhill destination');
    assert.equal(Terrain.movementMultiplier('red_hill', 35, 35, 35, 35), 1);
    assert.ok(Terrain.movementMultiplier('red_hill', 35, 35, 19, 35) < 1);
    assert.ok(Terrain.movementMultiplier('red_hill', 35, 35, 50, 35) > 1);
    for (let x = 0.5; x < 70; x += 0.5) for (const direction of [-1, 1]) {
        const multiplier = Terrain.movementMultiplier('red_hill', x, 35, x + direction * 10, 35);
        assert.ok(multiplier >= 0.7 && multiplier <= 1.1);
    }
});

test('actual movement obeys local terrain, including planned steps and a short final step', () => {
    for (const planned of [false, true]) for (const tx of [20, 50]) {
        const scene = makeScene();
        scene.battleOptions.terrain = 'red_hill';
        scene.planningStep = planned;
        const unit = addUnit(scene, 'red', 'cavalry', 35, 35);
        const multiplier = Terrain.movementMultiplier('red_hill', 35, 35, tx, 35);
        moveToward(unit, tx, 35, 6, 0.1, 'charge');
        close(planned ? Math.abs(unit.moveX) : Math.abs(unit.gx - 35), 0.6 * multiplier);
        close(unit.gy, 35);
    }
    const scene = makeScene();
    scene.battleOptions.terrain = 'red_hill';
    const unit = addUnit(scene, 'red', 'cavalry', 35, 35);
    moveToward(unit, 35.01, 35, 6, 1, 'charge');
    close(unit.gx, 35.01, 'downhill boost must never overshoot the destination');
});

test('cavalry path contact predicts the same terrain and wavering-limited step as movement', () => {
    for (const wavering of [false, true]) for (const direction of [-1, 1]) {
        const scene = makeScene();
        scene.battleOptions.terrain = 'red_hill';
        const unit = addUnit(scene, 'red', 'cavalry', 35, 35);
        unit.moraleState = wavering ? 'wavering' : 'steady';
        unit.moraleFacingX = direction; unit.moraleFacingY = 0;
        const tx = 35 + direction * 10;
        const step = 0.6 * Terrain.movementMultiplier('red_hill', 35, 35, tx, 35) * (wavering ? 0.85 : 1);
        const target = addUnit(scene, 'blue', 'infantry', 35 + direction * (step + 0.66), 35);
        scene.rebuildSpatial();
        assert.equal(scene.cavalryAI.pathContact(unit, tx, 35, 6, 0.1), null);
        target.gx -= direction * 0.02;
        scene.rebuildSpatial();
        assert.equal(scene.cavalryAI.pathContact(unit, tx, 35, 6, 0.1).enemy, target);
    }
});

test('attack and ranged modifiers depend on relative height rather than owning a hill', () => {
    const high = { gx: 19, gy: 35, typeData: UNIT_TYPES.archer };
    const low = { gx: 45, gy: 35, typeData: UNIT_TYPES.archer };
    const peer = { gx: 22, gy: 35, typeData: UNIT_TYPES.archer };
    close(Terrain.attackMultiplier('red_hill', high, low), 1.18);
    close(Terrain.attackMultiplier('red_hill', low, high), 0.82);
    assert.equal(Terrain.attackMultiplier('red_hill', high, peer), 1);
    assert.equal(Terrain.rangedRange('red_hill', high, peer), UNIT_TYPES.archer.range);
    close(Terrain.rangedRange('red_hill', high, low), UNIT_TYPES.archer.range * Terrain.MAX_RANGE_MULTIPLIER);
    close(Terrain.rangedRange('red_hill', low, high), UNIT_TYPES.archer.range * 0.8);
    assert.equal(Terrain.attackMultiplier('flat', high, low, 3), 1);
});

test('terrain damage multiplies raw attack once before armor and honors arrow launch-height snapshots', () => {
    const scene = makeScene();
    scene.battleOptions.terrain = 'red_hill';
    const from = addUnit(scene, 'red', 'archer', 45, 35);
    const target = addUnit(scene, 'blue', 'infantry', 46, 35);
    const expected = calculateAttackDamage(from, target, { multiplier: 1.5 * 1.18 });
    assert.equal(resolveAttack(target, from, { multiplier: 1.5, sourceHeight: 3 }), expected,
        'a shooter leaving the crown must not erase its in-flight arrow advantage');
    assert.equal(target.hp, target.maxHp - expected);
    const sameLevel = addUnit(scene, 'blue', 'infantry', 44, 35);
    assert.equal(resolveAttack(sameLevel, from), calculateAttackDamage(from, sameLevel));
});

test('a complete charge preserves slope-adjusted momentum and collision force instead of resetting to one', () => {
    const outcomes = {};
    for (const [name, terrain, direction] of [['flat', 'flat', 1], ['up', 'red_hill', -1], ['down', 'red_hill', 1]]) {
        const scene = makeScene();
        scene.battleOptions.terrain = terrain;
        const unit = addUnit(scene, 'red', 'cavalry', 35, 35);
        const target = addUnit(scene, 'blue', 'infantry', 35 + direction * 1.2, 35);
        const slope = Terrain.movementMultiplier(terrain, unit.gx, unit.gy, target.gx, target.gy);
        const damage = calculateAttackDamage(unit, target, {
            multiplier: 2 * slope * Terrain.attackMultiplier(terrain, unit, target)
        });
        const impactX = target.gx;
        unit.chargeDistance = 3.5;
        unit.chargeDX = direction; unit.chargeDY = 0;
        unit.target = target;
        scene.rebuildSpatial();
        scene.cavalryAI.charge(unit, 5000, 1 / 60);
        assert.equal(unit.chargeImpactId, target.id);
        assert.equal(target.hp, target.maxHp - damage);
        close(unit.chargeMomentum, slope - 0.26);
        close(Math.abs(unit.pierceX - impactX), 4 * slope);
        outcomes[name] = { damage, momentum: unit.chargeMomentum };
    }
    assert.equal(outcomes.flat.damage, 50);
    assert.ok(outcomes.up.damage < outcomes.flat.damage);
    assert.ok(outcomes.down.damage > outcomes.flat.damage);
    assert.ok(outcomes.up.momentum < outcomes.flat.momentum);
    assert.ok(outcomes.down.momentum > outcomes.flat.momentum);
});

test('hill charge still requires three actual traveled cells and cannot charge from uncommitted intents', () => {
    for (const terrain of ['red_hill', 'blue_hill']) {
        const scene = makeScene();
        scene.battleOptions.terrain = terrain;
        const unit = addUnit(scene, 'red', 'cavalry', 35, 35);
        const target = addUnit(scene, 'blue', 'infantry', 36.2, 35);
        unit.chargeDistance = 2.99;
        unit.chargeDX = 1; unit.chargeDY = 0;
        unit.target = target;
        scene.rebuildSpatial();
        scene.cavalryAI.charge(unit, 5000, 1 / 60);
        assert.equal(unit.state, 'melee');
        assert.equal(target.hp, target.maxHp);
        target.gx = 50;
        scene.cavalryAI.beginCharge(unit);
        scene.planningStep = true;
        scene.rebuildSpatial();
        for (let i = 0; i < 100; i++) scene.cavalryAI.charge(unit, 5000 + i * 17, 1 / 60);
        assert.equal(unit.gx, 35);
        assert.equal(unit.chargeDistance, 0);
        assert.equal(unit.chargeImpactId, null);
    }
});

function hillBattle(mirrored = false, speed = 1) {
    const scene = makeScene();
    scene.battleOptions.terrain = mirrored ? 'blue_hill' : 'red_hill';
    const roster = [
        ['red', 'infantry', 30, 32], ['red', 'pikeman', 31, 35],
        ['red', 'archer', 27, 33], ['red', 'cavalry', 28, 38],
        ['blue', 'infantry', 36, 32], ['blue', 'pikeman', 35, 35],
        ['blue', 'archer', 40, 33], ['blue', 'cavalry', 39, 38]
    ];
    for (const [team, type, x, y] of roster) {
        addUnit(scene, mirrored ? (team === 'red' ? 'blue' : 'red') : team, type, mirrored ? 70 - x : x, y);
    }
    scene.setSpeed(speed);
    return scene;
}

test('a complete mixed battle mirrors every unit when both armies and the hill exchange sides', () => {
    const left = hillBattle(), right = hillBattle(true);
    const pairs = left.units.map((unit, i) => [unit, right.units[i]]);
    for (let step = 0; step < 12000 && (!left.battleOver || !right.battleOver); step++) {
        left.advanceBattle(1000 / 60);
        right.advanceBattle(1000 / 60);
        for (const [a, b] of pairs) {
            assert.ok(Math.abs(a.gx + b.gx - 70) < 1e-9, `x mirror diverged at step ${step}, unit ${a.id}`);
            assert.ok(Math.abs(a.gy - b.gy) < 1e-9, `y mirror diverged at step ${step}, unit ${a.id}`);
            assert.equal(a.hp, b.hp, `damage mirror diverged at step ${step}, unit ${a.id}`);
        }
    }
    assert.equal(left.battleOver && right.battleOver, true, 'both mirrored fixtures must finish');
    assert.equal(left.redAlive, right.blueAlive);
    assert.equal(left.blueAlive, right.redAlive);
    assert.equal(left.getBattleReport().durationMs, right.getBattleReport().durationMs);
});

test('hill battles have identical full reports at 1x and 2x simulation speeds', () => {
    const outcomes = [1, 2].map(speed => {
        const scene = hillBattle(false, speed);
        for (let step = 0; step < 12000 && !scene.battleOver; step++) scene.advanceBattle(1000 / 60);
        assert.equal(scene.battleOver, true);
        return JSON.parse(JSON.stringify(scene.getBattleReport()));
    });
    assert.deepEqual(outcomes[0], outcomes[1]);
});
