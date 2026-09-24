const test = require('node:test');
const assert = require('node:assert/strict');
const { makeScene, addUnit, Terrain, CombatRules, moveToward, knockback, resolveAttack } = require('./battle-harness');

function sceneOn(terrain) {
    const scene = makeScene();
    scene.setTerrain(terrain);
    return scene;
}

test('walkers and cavalry travel through a bridge instead of clipping across the river', () => {
    for (const type of ['infantry', 'cavalry']) {
        const scene = sceneOn('river'), unit = addUnit(scene, 'red', type, 29, 25);
        let reachedBridge = false;
        for (let frame = 0; frame < 1200 && unit.gx < 42; frame++) {
            scene.simulationTime += 1000 / 60;
            scene.rebuildSpatial();
            moveToward(unit, 45, 25, unit.typeData.speed, 1 / 60);
            assert.ok(Terrain.walkable('river', unit.gx, unit.gy));
            if (unit.gx >= 32 && unit.gx <= 38) {
                assert.equal(Terrain.surface('river', unit.gx, unit.gy), 'bridge');
                reachedBridge = true;
            }
        }
        assert.equal(reachedBridge, true);
        assert.ok(unit.gx > 42, `${type} crossed and continued toward the original destination`);
    }
});

test('cavalry contact probe, charge facing and movement use the same navigated direction', () => {
    const scene = sceneOn('river'), unit = addUnit(scene, 'red', 'cavalry', 30, 25);
    const target = addUnit(scene, 'blue', 'archer', 45, 25);
    const waypoint = scene.ensureNavigation().nextWaypoint(unit, target.gx, target.gy, 'charge');
    const length = Math.hypot(waypoint.gx - unit.gx, waypoint.gy - unit.gy);
    const nx = (waypoint.gx - unit.gx) / length, ny = (waypoint.gy - unit.gy) / length;
    assert.ok(Math.abs(ny) > 0.2, 'route first heads toward a bridge, not straight at the enemy');
    const interceptor = addUnit(scene, 'blue', 'infantry', unit.gx + nx * 0.65, unit.gy + ny * 0.65);
    scene.rebuildSpatial();
    const contact = scene.cavalryAI.pathContact(unit, target.gx, target.gy, 6, 1 / 60);
    assert.equal(contact.enemy, interceptor);
    interceptor.dead = true;
    unit.target = target; unit.lastRetarget = 1000;
    scene.planningStep = true;
    scene.cavalryAI.charge(unit, 1000, 1 / 60);
    scene.planningStep = false;
    const step = Math.hypot(unit.moveX, unit.moveY);
    assert.ok(step > 0);
    assert.ok(Math.abs(unit.chargeDX - unit.moveX / step) < 1e-9);
    assert.ok(Math.abs(unit.chargeDY - unit.moveY / step) < 1e-9);
    assert.ok(Math.abs(unit.chargeDY) > 0.2);
});

test('forest multiplies surface speed separately and cancels stored momentum before the first impact', () => {
    for (const [type, scale] of [['cavalry', 0.55], ['infantry', 0.85]]) {
        const scene = sceneOn('forest'), unit = addUnit(scene, 'red', type, 30, 24);
        scene.rebuildSpatial();
        moveToward(unit, 40, 24, 4, 0.1);
        assert.ok(Math.abs(unit.gx - (30 + 0.4 * scale)) < 1e-9);
        assert.equal(unit.terrainMoveMultiplier, 1, 'inspection retains the pure slope multiplier');
    }
    const scene = sceneOn('forest'), cavalry = addUnit(scene, 'red', 'cavalry', 24.98, 24);
    const enemy = addUnit(scene, 'blue', 'infantry', 25.7, 24);
    Object.assign(cavalry, { chargeDistance: 3.5, chargeMomentum: 1, chargeDX: 1, chargeDY: 0,
        target: enemy, lastRetarget: 1000, lastAttack: -10000 });
    scene.rebuildSpatial();
    scene.cavalryAI.charge(cavalry, 1000, 1 / 60);
    assert.equal(cavalry.chargeDistance, 0);
    assert.equal(cavalry.chargeMomentum, 0);
    assert.equal(cavalry.state, 'melee');
    assert.equal(enemy.hp, enemy.maxHp, 'cannot carry an outside-forest double strike across its boundary');
});

test('forest stops piercing, never builds a charge inside, and requires fresh run-up after exit', () => {
    const scene = sceneOn('forest'), cavalry = addUnit(scene, 'red', 'cavalry', 30, 24);
    const enemy = addUnit(scene, 'blue', 'infantry', 50, 24);
    Object.assign(cavalry, { state: 'pierce', pierceX: 50, pierceY: 24,
        chargeMomentum: 1, chargeDistance: 4, chargeLastX: 29.9, chargeLastY: 24, pierceHits: new Set() });
    scene.rebuildSpatial();
    assert.equal(scene.cavalryAI.pierce(cavalry, 1000, 1 / 60), false);
    assert.equal(cavalry.state, 'melee');
    assert.equal(cavalry.chargeMomentum, 0);
    scene.cavalryAI.beginCharge(cavalry);
    cavalry.target = enemy; cavalry.lastRetarget = 1000;
    for (let i = 0; i < 10; i++) {
        scene.cavalryAI.charge(cavalry, 1000 + i * 16, 1 / 60);
        assert.equal(cavalry.chargeDistance, 0);
        assert.equal(cavalry.chargeLastX, null);
    }
    cavalry.gx = 45.01;
    scene.cavalryAI.charge(cavalry, 1200, 1 / 60);
    assert.equal(cavalry.chargeDistance, 0);
    scene.cavalryAI.charge(cavalry, 1220, 1 / 60);
    assert.ok(cavalry.chargeDistance > 0 && cavalry.chargeDistance < 0.2);
});

test('river banks block contact, pike brace, direct damage and non-planning knockback', () => {
    for (const [terrain, x1, x2, y] of [['river', 31.5, 38.5, 25], ['river', 31.5, 38.5, 45]]) {
        const scene = sceneOn(terrain), attacker = addUnit(scene, 'red', 'cavalry', x1, y);
        const enemy = addUnit(scene, 'blue', 'pikeman', x2, y);
        scene.rebuildSpatial();
        assert.equal(CombatRules.clearLane(scene, attacker, enemy), false);
        assert.equal(CombatRules.canStrike(scene, attacker, enemy, 20), false);
        assert.equal(resolveAttack(enemy, attacker), 0);
        Object.assign(attacker, { chargeMomentum: 1, chargeDX: 1, chargeDY: 0 });
        scene.cavalryAI.impact(attacker, enemy, false, 2000, true);
        assert.equal(enemy.hp, enemy.maxHp);
        scene.resolveBrace(enemy, attacker);
        assert.equal(attacker.hp, attacker.maxHp, 'pikes cannot brace-strike across terrain barriers');
        knockback(attacker, { gx: x1 - 1, gy: y }, 20);
        assert.ok(Terrain.walkable(terrain, attacker.gx, attacker.gy));
        assert.ok(attacker.gx < x2, 'large knockback cannot jump through the barrier');
        const archer = addUnit(scene, 'red', 'archer', x1, y + 1);
        assert.ok(resolveAttack(enemy, archer) > 0, 'ranged damage is intentionally allowed across the obstacle');
    }
});

test('infantry flank route points are legal and route indexes advance through river and pass terrain', () => {
    for (const terrain of ['river', 'blue_pass']) {
        const scene = makeScene();
        scene.deployUnits({ infantry: 12 }, { pikeman: 1 }, 'custom', 'custom', { red: 'flank', blue: 'hold' }, { terrain });
        const unit = scene.units.find(u => u.team === 'red' && u.tacticalRole === 'flank');
        const enemy = scene.units.find(u => u.team === 'blue');
        enemy.gx = 64; enemy.gy = 60;
        for (const other of scene.units) if (other !== unit && other !== enemy) other.dead = true;
        assert.ok(unit.route.every(point => Terrain.walkable(terrain, point.gx, point.gy)));
        for (let frame = 0; frame < 6000 && unit.routeIndex < unit.route.length; frame++) {
            scene.simulationTime = frame * 1000 / 60;
            scene.rebuildSpatial();
            scene.tactics.updateUnit(unit, scene.simulationTime, 1 / 60);
            assert.ok(Terrain.walkable(terrain, unit.gx, unit.gy));
        }
        assert.equal(unit.routeIndex, unit.route.length, `${terrain} cannot wait forever at the original illegal curve point`);
    }
});

test('cavalry flanking commits after reaching a projected rear waypoint instead of waiting inside water', () => {
    const scene = sceneOn('river');
    scene.battleOptions.cavalryOrders = { red: 'auto', blue: 'flank_archers' };
    const cavalry = addUnit(scene, 'blue', 'cavalry', 50, 25), archer = addUnit(scene, 'red', 'archer', 40, 25);
    let committed = false;
    for (let frame = 0; frame < 3600 && !committed; frame++) {
        scene.simulationTime = frame * 1000 / 60;
        scene.rebuildSpatial();
        scene.cavalryAI.update(cavalry, scene.simulationTime, 1 / 60);
        assert.ok(Terrain.walkable('river', cavalry.gx, cavalry.gy));
        committed = cavalry.flankCommitted || archer.hp < archer.maxHp;
    }
    assert.equal(committed, true, 'rearX can lie in water, but the stage finishes at its legal projected waypoint');
});

test('tactical melee tries a route when close enough to strike but blocked by a river-bank corner', () => {
    const scene = sceneOn('river');
    scene.deployUnits({ infantry: 1, pikeman: 1 }, { infantry: 1 }, 'custom', 'custom', { red: 'assault' }, { terrain: 'river' });
    const attacker = scene.units.find(u => u.team === 'red' && u.type === 'pikeman'), target = scene.units.find(u => u.team === 'blue');
    Object.assign(attacker, { gx: 31.63, gy: 18.5 });
    Object.assign(target, { gx: 32.5, gy: 17.63 });
    scene.rebuildSpatial(); scene.planningStep = true;
    scene.tactics.fight(attacker, target, 2000, 1 / 60, attacker.typeData.range);
    scene.planningStep = false;
    assert.equal(Terrain.segmentClear('river', attacker.gx, attacker.gy, target.gx, target.gy), false);
    assert.ok(Math.hypot(attacker.moveX, attacker.moveY) > 0);
    assert.equal(scene.battleQueue.length, 0, 'the obstructed attack is not queued');
});
