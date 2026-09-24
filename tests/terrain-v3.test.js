const test = require('node:test');
const assert = require('node:assert/strict');
const { Terrain, makeScene, addUnit } = require('./battle-harness.js');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('new map geometry, height and surface are mirrored without changing legacy keys', () => {
    assert.equal(Object.keys(Terrain.maps).length, 7);
    for (const key of Object.keys(Terrain.maps)) for (let x = 1; x < 70; x += 1.25) for (let y = 1; y < 70; y += 2.25) {
        const other = Terrain.mirror(key);
        near(Terrain.height(key, x, y), Terrain.height(other, 70 - x, y));
        assert.equal(Terrain.surface(key, x, y), Terrain.surface(other, 70 - x, y));
        assert.equal(Terrain.walkable(key, x, y), Terrain.walkable(other, 70 - x, y));
    }
    assert.equal(Terrain.height('blue_pass', 51, 35), 3);
    assert.equal(Terrain.defenseLayout('blue_pass', 'red'), null);
    assert.equal(Terrain.defenseLayout('blue_pass', 'blue').team, 'blue');
});

test('bridges and actual slope entrances are open while river banks and rock walls block the entire segment', () => {
    for (const y of [15.5, 35, 54.5]) assert.ok(Terrain.segmentClear('river', 20, y, 50, y, 0.36));
    for (const y of [0.6, 12, 25, 45, 60, 69.4]) assert.equal(Terrain.segmentClear('river', 20, y, 50, y, 0.36), false);
    for (const y of [22, 35, 48]) assert.ok(Terrain.segmentClear('blue_pass', 36, y, 49, y, 0.36));
    for (const y of [28, 42]) assert.equal(Terrain.segmentClear('blue_pass', 36, y, 49, y, 0.36), false);
});

test('swept motion cannot tunnel through water or rock even with long pushes', () => {
    for (const [key, x, y, dx, dy] of [
        ['river', 30, 25, 20, 0], ['river', 40, 45, -20, 0],
        ['blue_pass', 39, 28, 18, 0], ['red_pass', 31, 28, -18, 0],
        ['river', 30, 25, 8, 7], ['river', 35, 35, 0, -20],
        ['river', 31, 69.4, 4, 8], ['river', 30, 69.4, 10, 10], ['river', 30, 0.6, 10, -10]
    ]) {
        const motion = Terrain.clipMotion(key, x, y, dx, dy);
        assert.ok(motion.blocked);
        assert.ok(Terrain.walkable(key, x + motion.x, y + motion.y));
        assert.ok(Terrain.segmentClear(key, x, y, x + motion.x, y + motion.y, 0.36));
        const mirrored = Terrain.clipMotion(Terrain.mirror(key), 70 - x, y, -dx, dy);
        near(motion.x, -mirrored.x); near(motion.y, mirrored.y);
    }
    assert.equal(Terrain.clipMotion('river', 30, 35, 12, 0).blocked, false);
});

test('deterministic long-motion sweep samples always stay on legal reachable ground', () => {
    let seed = 191;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (const key of ['river', 'blue_pass', 'red_pass']) for (let i = 0; i < 2000; i++) {
        const x = 0.6 + random() * 68.8, y = 0.6 + random() * 68.8;
        if (!Terrain.walkable(key, x, y)) continue;
        const motion = Terrain.clipMotion(key, x, y, random() * 100 - 50, random() * 100 - 50);
        assert.ok(Terrain.walkable(key, x + motion.x, y + motion.y), `${key} illegal ${x},${y}`);
        assert.ok(Terrain.segmentClear(key, x, y, x + motion.x, y + motion.y, 0.36), `${key} tunnel ${x},${y}`);
    }
});

test('forest is walkable, reduces cavalry more, and invalidates charging on entry and through a patch', () => {
    assert.ok(Terrain.walkable('forest', 35, 25));
    assert.equal(Terrain.surfaceSpeed('forest', 'cavalry', 35, 25), 0.55);
    assert.equal(Terrain.surfaceSpeed('forest', 'infantry', 35, 25), 0.85);
    assert.equal(Terrain.surfaceSpeed('forest', 'cavalry', 35, 35), 1);
    assert.equal(Terrain.chargeAllowed('forest', 24, 25, 26, 25), false);
    assert.equal(Terrain.chargeAllowed('forest', 24, 25, 46, 25), false);
    assert.equal(Terrain.chargeAllowed('forest', 24, 35, 46, 35), true);
});

test('legal river-bank boundary points may move outward and along the edge, but not into water', () => {
    for (const [x, direction] of [[31.64, -1], [38.36, 1]]) {
        assert.ok(Terrain.walkable('river', x, 20));
        near(Terrain.clipMotion('river', x, 20, direction * 0.1, 0).x, direction * 0.1);
        near(Terrain.clipMotion('river', x, 20, 0, 0.1).y, 0.1);
        near(Terrain.clipMotion('river', x, 20, -direction * 0.1, 0).x, 0);
    }
});

test('invalid navigation destinations project to legal terrain, not an off-map river shortcut', () => {
    for (const key of ['river', 'blue_pass', 'red_pass']) for (let y = 0; y <= 70; y += 2) {
        const x = key === 'river' ? 35 : key === 'blue_pass' ? 42 : 28;
        const p = Terrain.projectPoint(key, x, y, 0.36, -1);
        assert.ok(Terrain.walkable(key, p.gx, p.gy));
    }
});

function walk(key, x, y, gx, gy, team = 'red', id = 65) {
    const scene = makeScene(); scene.setTerrain(key);
    const unit = addUnit(scene, team, 'infantry', x, y); unit.id = id;
    const navigation = scene.ensureNavigation(), trail = [];
    for (let frame = 0; frame < 3000 && Math.hypot(unit.gx - gx, unit.gy - gy) > 0.08; frame++) {
        scene.simulationTime = frame * 1000 / 60;
        const point = navigation.nextWaypoint(unit, gx, gy);
        assert.ok(point.reachable);
        const dx = point.gx - unit.gx, dy = point.gy - unit.gy, length = Math.hypot(dx, dy);
        const step = Math.min(0.08, length);
        const motion = Terrain.clipMotion(key, unit.gx, unit.gy, dx / length * step, dy / length * step);
        unit.gx += motion.x; unit.gy += motion.y;
        assert.ok(Terrain.walkable(key, unit.gx, unit.gy));
        trail.push([unit.gx, unit.gy]);
    }
    assert.ok(Math.hypot(unit.gx - gx, unit.gy - gy) < 0.08, `failed to arrive ${key}: ${unit.gx},${unit.gy}`);
    assert.ok(navigation.stats.plans < 8, 'static goal must reuse routes');
    assert.ok(navigation.stats.graphBuilds <= 1);
    return trail;
}

test('river and rock routes reach the opposite side and retain exact mirrored paths with different global ids', () => {
    for (const key of ['river', 'blue_pass']) for (const y of [8, 28, 42, 62]) {
        const a = walk(key, 20, y, 55, y);
        const b = walk(Terrain.mirror(key), 50, y, 15, y, 'blue', 141);
        assert.equal(a.length, b.length);
        a.forEach((p, i) => { near(p[0] + b[i][0], 70); near(p[1], b[i][1]); });
    }
});

test('scene terrain reset clears navigation route and congestion state across battles', () => {
    const scene = makeScene(); scene.setTerrain('river');
    const unit = addUnit(scene, 'red', 'infantry', 20, 28);
    const nav = scene.ensureNavigation(); nav.nextWaypoint(unit, 55, 28);
    assert.equal(nav.routes.size, 1);
    scene.clearUnits('blue_pass');
    assert.equal(nav.key, 'blue_pass'); assert.equal(nav.routes.size, 0);
    assert.equal(nav.battleId, scene.battleId);
    scene.clearUnits(); assert.equal(nav.key, 'flat');
});

test('a bridge-to-bridge graph route has mirrored bank choices, independent of global ids', () => {
    const points = ['red', 'blue'].map((team, i) => {
        const scene = makeScene(); scene.setTerrain('river');
        const unit = addUnit(scene, team, 'cavalry', 35, 15); unit.id = i ? 141 : 65;
        return scene.ensureNavigation().nextWaypoint(unit, 35, 55);
    });
    near(points[0].gx + points[1].gx, 70); near(points[0].gy, points[1].gy);
});

test('switching terrain destroys forest decoration and hides bank props that would sit in water', () => {
    const scene = makeScene(); scene.terNoise = () => 0.6;
    const sprite = { visible: true, setVisible(value) { this.visible = value; } };
    scene.edgeProps = [{ sprite, gx: 35, gy: 2 }];
    scene.setTerrain('forest'); scene.drawTerrainDecorations();
    const trees = scene.terrainProps.slice();
    assert.ok(trees.length > 20); assert.ok(sprite.visible);
    scene.setTerrain('river'); scene.drawTerrainDecorations();
    assert.ok(trees.every(tree => tree.destroyed));
    assert.equal(scene.terrainProps.length, 0); assert.equal(sprite.visible, false);
    scene.setTerrain('flat'); scene.drawTerrainDecorations(); assert.equal(sprite.visible, true);
});
