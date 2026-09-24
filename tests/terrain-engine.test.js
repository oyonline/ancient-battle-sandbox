const test = require('node:test');
const assert = require('node:assert/strict');
const { Terrain, makeScene, addUnit, resolveAttack, snapshot } = require('./battle-harness.js');

test('deployment sets terrain before spawning and default deployment restores flat', () => {
    const scene = makeScene();
    const originalSpawn = scene.spawnUnit;
    const seen = [];
    scene.spawnUnit = function (...args) {
        seen.push(this.battleOptions.terrain);
        return originalSpawn.apply(this, args);
    };
    scene.deployUnits({ cavalry: 1 }, { infantry: 1 }, 'custom', 'custom', {}, { terrain: 'red_hill' });
    assert.deepEqual(seen, ['red_hill', 'red_hill']);
    const red = scene.units[0];
    const raised = scene.groundPoint(red.gx, red.gy);
    assert.equal(red.shadow.y, raised.y);
    assert.equal(red.spr.y, raised.y + red.footDy);
    assert.equal(red.lastSY - raised.y, scene.terrainHeight(red.gx, red.gy) * Terrain.HEIGHT_SCALE);
    scene.deployUnits({ cavalry: 1 }, { infantry: 1 }, 'custom', 'custom');
    assert.equal(scene.battleOptions.terrain, 'flat');
    assert.equal(scene.terrainHeight(19, 35), 0);
    scene.setTerrain('blue_hill');
    scene.clearUnits();
    assert.equal(scene.battleOptions.terrain, 'flat');
    assert.equal(scene.getBattleReport().firstContactMs, null);
});

test('neighboring hill tile corners share the same projected points without cracks', () => {
    const scene = makeScene();
    scene.setTerrain('red_hill');
    for (const [gx, gy] of [[30, 35], [20, 45], [4, 35]]) {
        const a = scene.groundTile(gx, gy), b = scene.groundTile(gx + 1, gy);
        assert.deepEqual(snapshot(a[1]), snapshot(b[0]));
        assert.deepEqual(snapshot(a[2]), snapshot(b[3]));
    }
});

test('water, coastline and edge decorations stay on unchanged flat ground', () => {
    for (const map of ['red_hill', 'blue_hill']) {
        for (const edge of [0, 0.5, 1, 2.2, 3.2, 3.5, 66.5, 66.8, 67.8, 69, 70]) {
            assert.equal(Terrain.height(map, edge, 35), 0);
            assert.equal(Terrain.height(map, 35, edge), 0);
        }
    }
});

test('arrows use launch height after shooter moves, and actual victim height at impact', () => {
    const scene = makeScene();
    scene.setTerrain('red_hill');
    const shooter = addUnit(scene, 'red', 'archer', 30, 35);
    const target = addUnit(scene, 'blue', 'infantry', 39, 35);
    scene.fireArrow(shooter, target);
    const arrow = scene.arrows[0];
    const launchHeight = scene.terrainHeight(shooter.gx, shooter.gy);
    assert.equal(arrow.sourceHeight, launchHeight);
    shooter.gx = 60;
    target.gx = 38.5; // 实际命中者可能已移到落点附近的另一高度。
    const expected = Math.floor(shooter.typeData.atk * Terrain.attackMultiplier('red_hill', shooter, target, launchHeight) - target.typeData.def);
    scene.rebuildSpatial();
    scene.updateArrows(1, 1000);
    assert.equal(target.hp, target.maxHp - expected);
    assert.equal(scene.arrows.length, 0);
});

test('archers acquire extended downhill targets but cannot shoot equal-distance uphill targets', () => {
    function fireFrom(x, targetX) {
        const scene = makeScene();
        scene.setTerrain('red_hill');
        const archer = addUnit(scene, 'red', 'archer', x, 35);
        addUnit(scene, 'blue', 'infantry', targetX, 35);
        scene.rebuildSpatial();
        const queued = [];
        scene.scheduleBattleAction = (delay, callback) => queued.push(callback);
        scene.updateNormalUnit(archer, 1, 1 / 60);
        queued.forEach(callback => callback());
        return scene.arrows.length;
    }
    assert.equal(fireFrom(30, 40), 1, 'downhill range exceeds base 9.5');
    assert.equal(fireFrom(40, 30), 0, 'uphill cannot use downhill scan radius as actual range');
});

test('first-contact report is a stable first-effective-damage timestamp and resets', () => {
    const scene = makeScene();
    scene.setTerrain('blue_hill');
    const red = addUnit(scene, 'red', 'infantry', 30, 35);
    const blue = addUnit(scene, 'blue', 'infantry', 31, 35);
    scene.simulationTime = 1200;
    resolveAttack(blue, red);
    scene.simulationTime = 2400;
    resolveAttack(blue, red);
    assert.equal(scene.getBattleReport().firstContactMs, 1200);
    assert.equal(scene.getBattleReport().terrain, 'blue_hill');
    scene.clearUnits();
    assert.equal(scene.getBattleReport().firstContactMs, null);
});
