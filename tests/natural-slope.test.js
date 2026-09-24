const test = require('node:test');
const assert = require('node:assert/strict');
const { Terrain, makeScene, addUnit, moveToward, resolveAttack } = require('./battle-harness');

test('natural slope is continuous, bounded, mirrored and never folds the isometric ground projection', () => {
    for (const key of ['blue_pass', 'red_pass']) {
        assert.equal(Terrain.isNaturalSlope(key), true);
        for (let x = 1; x < 69; x += 0.4) for (let y = 1; y < 69; y += 0.4) {
            const h = Terrain.height(key, x, y), e = 0.001;
            const dx = (Terrain.height(key, x + e, y) - Terrain.height(key, x - e, y)) / (2 * e);
            const dy = (Terrain.height(key, x, y + e) - Terrain.height(key, x, y - e)) / (2 * e);
            assert.ok(Number.isFinite(h) && h >= 0 && h <= 5);
            assert.ok(Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6, 'no vertical walls in a grass slope');
            assert.ok(dx + dy < 1.1, 'positive Jacobian, with margin below the 4/3 fold threshold');
            assert.ok(Terrain.walkable(key, x, y));
            assert.ok(Math.abs(h - Terrain.height(Terrain.mirror(key), 70 - x, y)) < 1e-10);
        }
    }
    for (const key of ['flat', 'red_hill', 'blue_hill', 'forest', 'river']) assert.equal(Terrain.isNaturalSlope(key), false);
    for (const [x, y] of [[26, 35], [69, 35], [51, 10], [51, 60]]) assert.equal(Terrain.height('blue_pass', x, y), 0);
    assert.ok(Terrain.height('blue_pass', 51, 35) > Terrain.height('blue_pass', 42, 35));
    assert.ok(Terrain.height('blue_pass', 42, 35) > Terrain.height('blue_pass', 32, 35));
});

test('slope motion and combat cross the former walls, while uphill/downhill effects still use actual height', () => {
    const scene = makeScene(); scene.setTerrain('blue_pass');
    const unit = addUnit(scene, 'red', 'infantry', 39, 28);
    for (let i = 0; i < 240; i++) moveToward(unit, 47, 28, 4, 1 / 60);
    assert.ok(unit.gx > 46.9); assert.ok(Math.abs(unit.gy - 28) < 1e-8);
    assert.equal(scene.navigation, undefined, 'open slope does not use artificial corner navigation');
    assert.ok(Terrain.movementMultiplier('blue_pass', 36, 35, 40, 35) < 1);
    assert.ok(Terrain.movementMultiplier('blue_pass', 40, 35, 36, 35) > 1);
    const enemy = addUnit(scene, 'blue', 'infantry', 47.5, 28);
    assert.ok(resolveAttack(enemy, unit) > 0);
    const high = { gx: 51, gy: 35, typeData: { range: 10 } }, low = { gx: 30, gy: 35 };
    assert.equal(Terrain.attackMultiplier('blue_pass', high, low), 1.18);
    assert.ok(Math.abs(Terrain.attackMultiplier('blue_pass', low, high) - 0.82) < 1e-12);
    assert.equal(Terrain.rangedRange('blue_pass', high, low), 12);
});

test('natural slope ground and unit foot positions use the same height; rectangular overlays are absent', () => {
    const scene = makeScene(); scene.setTerrain('blue_pass');
    for (const [gx, gy] of [[32, 30], [44, 35], [51, 35], [58, 40]]) {
        const p = scene.groundPoint(gx, gy);
        assert.equal(p.y, (gx + gy) * 16 + 120 - Terrain.height('blue_pass', gx, gy) * 24);
    }
    let rectangles = 0;
    const graphics = { fillStyle() {}, fillPoints() { rectangles++; }, lineStyle() {}, strokePoints() { rectangles++; } };
    scene.drawTerrainFeatures(graphics);
    assert.equal(rectangles, 0, 'no wall, painted road, or archer rectangle');
    scene.drawTerrainDecorations(); assert.equal(scene.terrainProps.length, 0, 'no rows of wall props');
});

test('grass texture is deterministic, follows the slope and leaves terrain physics unchanged', () => {
    const scene = makeScene(); scene.setTerrain('blue_pass');
    scene.terNoise = (x, y) => (Math.sin(x * 3 + y) + 1) / 2;
    const hash = (x, y) => ((Math.imul(x, 374761393) ^ Math.imul(y, 668265263)) >>> 0) / 4294967296;
    const heightBefore = Terrain.height('blue_pass', 44, 35);
    const point = scene.groundPoint.bind(scene), samples = [];
    scene.groundPoint = (x, y) => { samples.push([x, y]); return point(x, y); };
    const render = () => {
        const calls = [];
        const graphics = Object.fromEntries(['fillStyle', 'fillRect', 'fillPoints', 'lineStyle', 'lineBetween']
            .map(method => [method, (...args) => calls.push([method, ...args])]));
        scene.drawNaturalGroundTexture(graphics, hash);
        return JSON.parse(JSON.stringify(calls));
    };
    const first = render(), second = render();
    assert.deepEqual(first, second, 'no flicker or random texture changes between bakes');
    assert.ok(first.filter(call => call[0] === 'lineBetween').length > 1000, 'visible grass tufts');
    assert.ok(first.filter(call => call[0] === 'fillPoints').length > 50, 'occasional irregular soil patches');
    assert.ok(samples.some(([x, y]) => Terrain.height('blue_pass', x, y) > 4), 'texture also covers the ridge');
    assert.ok(samples.every(([x, y]) => x > 0 && x < 69 && y > 0 && y < 69), 'no texture on water');
    assert.equal(Terrain.height('blue_pass', 44, 35), heightBefore);
    assert.equal(scene.units.length, 0);
});
