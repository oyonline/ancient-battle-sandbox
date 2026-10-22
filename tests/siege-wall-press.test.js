import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit, Terrain, CombatRules, TacticsSystem } from './battle-harness.js';
import { DynamicBlockers } from '../js/terrain.js';

// 西墙的偏心门洞迫使可达对照绕行，不能靠直线退回穿门碰巧通过。
const WALLS = [
    ['north', { x1: 30, y1: 25, x2: 50, y2: 25.4, kind: 'wall' }],
    ['south', { x1: 30, y1: 44.6, x2: 50, y2: 45, kind: 'wall' }],
    ['west-north', { x1: 30, y1: 25, x2: 30.4, y2: 31, kind: 'wall' }],
    ['door', { x1: 30, y1: 31, x2: 30.4, y2: 33, kind: 'wall' }],
    ['west-south', { x1: 30, y1: 33, x2: 30.4, y2: 45, kind: 'wall' }],
    ['east', { x1: 49.6, y1: 25, x2: 50, y2: 45, kind: 'wall' }]
];
const FRAMES = 300;

function step(scene) {
    scene.simulationTime += 1000 / 60;
    scene.stepBattle(1 / 60);
}

function soldiers(count = 1, terrain = 'flat') {
    const scene = makeScene();
    scene.setTerrain(terrain);
    const reds = Array.from({ length: count }, (_, i) =>
        addUnit(scene, 'red', 'infantry', 24, 35 + (i - (count - 1) / 2) * 1.2));
    const blue = addUnit(scene, 'blue', 'infantry', 45, 35);
    // 真实守位流程：蓝兵留在寨内，红兵仍走正常选敌、导航、接触和分离。
    scene.tactics = new TacticsSystem(scene, {});
    Object.assign(blue, { tacticalRole: 'ground_guard', guardAnchor: { gx: 45, gy: 35 }, guardRadius: 1 });
    return { scene, reds, blue };
}

function boxedScene(count = 1, open = false) {
    const result = soldiers(count);
    const walls = WALLS.filter(([id]) => !open || id !== 'door');
    // 先放兵、再挂层；障碍只能由 stepBattle 的固定提交点生效。
    result.scene.dynamicBlockers = new DynamicBlockers();
    for (const [id, rect] of walls) result.scene.dynamicBlockers.requestAdd(id, rect);
    return { ...result, walls };
}

function distanceToRect(unit, rect) {
    return Math.hypot(unit.gx - Math.max(rect.x1, Math.min(unit.gx, rect.x2)),
        unit.gy - Math.max(rect.y1, Math.min(unit.gy, rect.y2)));
}
const wallDistance = (unit, walls = WALLS) => Math.min(...walls.map(([, rect]) => distanceToRect(unit, rect)));
const inside = unit => unit.gx > 30.4 && unit.gx < 49.6 && unit.gy > 25.4 && unit.gy < 44.6;

function assertClear(unit, walls, frame) {
    for (const [id, rect] of walls) {
        assert.ok(distanceToRect(unit, rect) >= CombatRules.bodyRadius(unit) - 1e-6,
            `frame ${frame}: unit ${unit.id} overlaps ${id} at (${unit.gx}, ${unit.gy})`);
    }
}

function press(count) {
    const result = boxedScene(count);
    const { scene, reds, blue, walls } = result;
    const initialDistances = reds.map(unit => wallDistance(unit));
    const frames = [];
    let movingFrames = 0;
    for (let frame = 0; frame < FRAMES; frame++) {
        step(scene);
        if (frame === 0) {
            assert.ok(Terrain.dynOf(scene));
            assert.equal(scene.ensureNavigation().nextWaypoint(reds[0], blue.gx, blue.gy).reachable, false);
        }
        for (const unit of scene.units) assertClear(unit, walls, frame);
        for (const unit of reds) {
            assert.equal(inside(unit), false, `frame ${frame}: red ${unit.id} entered sealed camp`);
            if (unit.moving) movingFrames++;
        }
        frames.push(scene.units.map(({ gx, gy, hp }) => [gx, gy, hp]));
    }
    const touching = reds.filter(unit => wallDistance(unit) <= 0.8);
    const span = touching.length ? Math.max(...touching.map(u => u.gy)) - Math.min(...touching.map(u => u.gy)) : 0;
    return { ...result, initialDistances, frames, movingFrames, touching, span };
}

test('siege #1: sealed dynamic camp draws an infantryman to the wall without overlap', t => {
    const run = press(1), distance = wallDistance(run.reds[0]);
    t.diagnostic(`initial=${run.initialDistances[0]} final=${distance.toFixed(6)} movingFrames=${run.movingFrames}`);
    assert.equal(run.initialDistances[0], 6);
    assert.ok(distance <= 0.6, `final distance ${distance}`);
    assert.ok(run.movingFrames > 0);
});

test('siege #2: twelve infantry press and spread along the sealed wall', t => {
    const run = press(12);
    t.diagnostic(`touching=${run.touching.length}/12 ySpan=${run.span.toFixed(6)} distances=${run.reds.map(u => wallDistance(u).toFixed(6)).join(',')}`);
    assert.ok(run.initialDistances.every(d => d === 6));
    assert.ok(run.touching.length >= 10, `only ${run.touching.length} infantry reached the wall`);
    assert.ok(run.span >= 3, `wall frontage ${run.span}`);
});

test('siege #3: an offset open doorway retains normal routing into the camp', t => {
    const { scene, reds: [red], blue, walls } = boxedScene(1, true);
    let enteredAt = null, crossedAt = null;
    for (let frame = 0; frame < 900; frame++) {
        const previousX = red.gx;
        step(scene);
        if (frame === 0) {
            const waypoint = scene.ensureNavigation().nextWaypoint(red, blue.gx, blue.gy);
            assert.equal(waypoint.reachable, true);
            assert.equal(waypoint.direct, false);
        }
        for (const unit of scene.units) assertClear(unit, walls, frame);
        if (previousX <= 30.2 && red.gx > 30.2) {
            crossedAt = frame + 1;
            assert.ok(red.gy >= 31 + CombatRules.bodyRadius(red) && red.gy <= 33 - CombatRules.bodyRadius(red));
        }
        if (inside(red)) { enteredAt = frame + 1; break; }
    }
    t.diagnostic(`doorCrossingFrame=${crossedAt} enteredFrame=${enteredAt} position=${red.gx.toFixed(6)},${red.gy.toFixed(6)}`);
    assert.notEqual(crossedAt, null);
    assert.notEqual(enteredAt, null);
});

test('siege #4: unreachable static terrain still holds position with absent or empty dynamic layers', t => {
    // 默认 river 的三座桥互通；在此测试的静态几何中加封闭边界，形成真实不可达区。
    // 不替换 nextWaypoint/plan/AI；finally 恢复共享几何，避免污染其它测试。
    const geometry = Terrain.geometry('river'), original = geometry.blockers;
    try {
        geometry.blockers = [...original, ...WALLS.map(([, rect]) => rect)];
        for (const empty of [false, true]) {
            const { scene, reds: [red], blue } = soldiers(1, 'river');
            if (empty) scene.dynamicBlockers = new DynamicBlockers();
            const start = [red.gx, red.gy];
            let movingFrames = 0;
            assert.equal(scene.ensureNavigation().nextWaypoint(red, blue.gx, blue.gy).reachable, false);
            for (let frame = 0; frame < FRAMES; frame++) {
                step(scene);
                assert.equal(Terrain.dynOf(scene), null);
                assert.deepEqual([red.gx, red.gy], start);
                if (red.moving) movingFrames++;
            }
            t.diagnostic(`layer=${empty ? 'empty' : 'absent'} displacement=${Math.hypot(red.gx - start[0], red.gy - start[1])} movingFrames=${movingFrames}`);
            assert.equal(movingFrames, 0);
        }
    } finally {
        geometry.blockers = original;
    }
});

test('siege #5: twelve-infantry siege repeats every gx/gy/hp exactly', t => {
    const first = press(12), second = press(12);
    assert.deepEqual(second.frames, first.frames);
    t.diagnostic(`identicalFrames=${first.frames.length} unitsPerFrame=${first.frames[0].length} scalarComparisons=${first.frames.length * first.frames[0].length * 3}`);
});
