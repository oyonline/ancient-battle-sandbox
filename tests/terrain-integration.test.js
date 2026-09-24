const test = require('node:test');
const assert = require('node:assert/strict');
const { makeScene, addUnit, moveToward, Terrain, CombatRules, knockback } = require('./battle-harness.js');

const legal = scene => {
    for (const unit of scene.units) if (!unit.dead && !unit.withdrawn)
        assert.ok(Terrain.walkable(scene.battleOptions.terrain, unit.gx, unit.gy), `${unit.type} ${unit.id} at ${unit.gx},${unit.gy}`);
};

test('a 96-soldier friendly column crosses a river using real walk constraints and separation without permanent blocking', () => {
    const scene = makeScene(); scene.setTerrain('river');
    for (let row = 0; row < 12; row++) for (let col = 0; col < 8; col++)
        addUnit(scene, 'red', 'infantry', 28 - row * 0.9, 21 + col * 0.9);
    for (let frame = 0; frame < 3600 && scene.units.some(u => u.gx < 40); frame++) {
        scene.simulationTime = frame * 1000 / 60;
        scene.rebuildSpatial(); scene.bodyContactDistance = CombatRules.maxContactDistance(scene.units);
        scene.ensureNavigation().beginStep(scene.simulationTime, scene.units);
        scene.planningStep = true;
        for (const u of scene.units) {
            u.moveX = u.moveY = 0;
            moveToward(u, 56 + (u.id % 12) * 0.9, 15 + Math.floor((u.id - 1) / 12) * 1.2, u.typeData.speed, 1 / 60);
        }
        scene.planningStep = false;
        for (const u of scene.units) { u.gx += u.moveX; u.gy += u.moveY; }
        scene.rebuildSpatial(); scene.separate(1 / 60); legal(scene);
    }
    assert.ok(scene.units.every(u => u.gx >= 40), `${scene.units.filter(u => u.gx < 40).length} soldiers stuck`);
    assert.ok(scene.navigation.stats.plans < 1000, 'paths must be reused during the march');
});

test('routed soldiers on the enemy bank find a bridge to their own bank', () => {
    const scene = makeScene(); scene.setTerrain('river');
    const unit = addUnit(scene, 'red', 'infantry', 45, 25);
    unit.moraleState = 'routing'; unit.routStartedAt = 0;
    for (let frame = 0; frame < 1800 && unit.gx > 30; frame++) {
        scene.simulationTime = 2000 + frame * 1000 / 60;
        scene.rebuildSpatial(); scene.updateRoutedUnit(unit, 1 / 60); legal(scene);
    }
    assert.ok(unit.gx < 30, `${unit.gx},${unit.gy}`);
});

test('planned pushes and body separation cannot force units into the river', () => {
    const scene = makeScene(); scene.setTerrain('river');
    const a = addUnit(scene, 'red', 'infantry', 31.6, 25);
    const b = addUnit(scene, 'blue', 'infantry', 31.1, 25);
    knockback(a, b, 20); legal(scene);
    a.gx = 31.6;
    scene.rebuildSpatial(); scene.separate(1 / 60); legal(scene);
    scene.updateNormalUnit = unit => { unit.pushX = 10; unit.pushY = 0; };
    scene.advanceBattle(1000 / 60); legal(scene);
    assert.ok(a.gx < 32 && b.gx < 32);
});

test('all new terrain battles finish with no illegal positions', () => {
    const army = { infantry: 8, pikeman: 3, archer: 4, cavalry: 3 };
    for (const terrain of ['forest', 'river', 'blue_pass', 'red_pass']) {
        const scene = makeScene();
        const defender = Terrain.maps[terrain].defender;
        scene.deployUnits(army, army, 'custom', 'custom', defender ? { [defender]: 'hold_ground' } : {}, { terrain });
        scene.battleStarted = true;
        for (let frame = 0; frame < 14400 && !scene.battleOver; frame++) {
            scene.advanceBattle(1000 / 60);
            if (frame % 30 === 0) legal(scene);
        }
        legal(scene);
        assert.ok(scene.battleOver, `battle did not finish on ${terrain}`);
        assert.ok(scene.firstContactMs > 0, `${terrain} never reached contact`);
    }
});

test('river simulation reports remain deterministic at 1x and 2x', () => {
    const reports = [1, 2].map(speed => {
        const scene = makeScene(), army = { infantry: 6, archer: 3, cavalry: 2 };
        scene.deployUnits(army, army, 'custom', 'custom', {}, { terrain: 'river' });
        scene.battleStarted = true; scene.setSpeed(speed);
        for (let frame = 0; frame < 12000 && !scene.battleOver; frame++) scene.advanceBattle(1000 / 60);
        assert.ok(scene.battleOver);
        return JSON.parse(JSON.stringify(scene.getBattleReport()));
    });
    assert.deepEqual(reports[0], reports[1]);
});

test('1000-unit river pressure check has finite legal positions and bounded route construction', () => {
    const scene = makeScene(), army = { infantry: 150, pikeman: 150, archer: 100, cavalry: 100 };
    scene.deployUnits(army, army, 'custom', 'custom', {}, { terrain: 'river' });
    assert.equal(scene.units.length, 1000);
    scene.battleStarted = true;
    for (let frame = 0; frame < 120; frame++) { scene.advanceBattle(1000 / 60); legal(scene); }
    assert.ok(scene.navigation.stats.graphBuilds <= 1);
    assert.ok(scene.navigation.stats.plans < 4000);
});
