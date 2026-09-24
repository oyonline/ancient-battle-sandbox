const test = require('node:test');
const assert = require('node:assert/strict');
const { makeScene, addUnit, Terrain } = require('./battle-harness');

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function cavalryFixture(mirrored = false, order = 'flank_archers') {
    const scene = makeScene(), x = value => mirrored ? 70 - value : value;
    const team = mirrored ? 'blue' : 'red', enemy = mirrored ? 'red' : 'blue';
    scene.battleOptions.terrain = mirrored ? 'red_pass' : 'blue_pass';
    scene.battleOptions.cavalryOrders = { [team]: order };
    scene.nextId = mirrored ? 1000 : 1;
    const cavalry = addUnit(scene, team, 'cavalry', x(20), 30);
    const front = [27, 30, 33].map(y => addUnit(scene, enemy, 'infantry', x(35), y));
    const archer = addUnit(scene, enemy, 'archer', x(43), 30);
    return { scene, cavalry, front, archer, x, enemy };
}
function step(f, frame) {
    f.scene.simulationTime = frame * 1000 / 60;
    f.scene.rebuildSpatial();
    return f.scene.cavalryAI.update(f.cavalry, f.scene.simulationTime, 1 / 60);
}

test('natural-slope advance keeps a wide initial infantry/pike approach until contact, then releases permanently', () => {
    const scene = makeScene();
    scene.deployUnits({ infantry: 72, pikeman: 12 }, { pikeman: 1 }, 'custom', 'custom',
        { red: 'advance', blue: 'hold_ground' }, { terrain: 'blue_pass' });
    const troops = scene.units.filter(u => u.team === 'red');
    const initialWidth = Math.max(...troops.map(u => u.gy)) - Math.min(...troops.map(u => u.gy));
    const firstX = troops[0].gx;
    scene.battleStarted = true;
    for (let frame = 0; frame < 240; frame++) scene.advanceBattle(1000 / 60);
    assert.ok(troops[0].gx > firstX + 6, 'exercise real movement, not the ready screen');
    assert.ok(troops.every(u => !u.slopeApproach.released && !u.dead));
    for (const unit of troops) close(unit.gy, unit.slopeApproach.gy);
    const width = Math.max(...troops.map(u => u.gy)) - Math.min(...troops.map(u => u.gy));
    assert.ok(width > 14 && width >= initialWidth - 0.01, 'the army must not funnel into one distant enemy');
    const damaged = troops[0];
    damaged.hp--;
    assert.equal(scene.tactics.updateSlopeApproach(damaged, 1 / 60), false);
    assert.equal(damaged.slopeApproach.released, true);
    damaged.hp = damaged.maxHp;
    assert.equal(scene.tactics.updateSlopeApproach(damaged, 1 / 60), false);
    const near = troops[1], enemy = scene.units.find(u => u.team === 'blue');
    enemy.gx = near.gx + 5; enemy.gy = near.gy;
    scene.rebuildSpatial();
    assert.equal(scene.tactics.updateSlopeApproach(near, 1 / 60), false);
    assert.equal(near.slopeApproach.released, true);
});

test('lane approach is absent on legacy terrain and never replaces explicit orders, reserves, ranged or cavalry AI', () => {
    for (const terrain of ['flat', 'blue_hill', 'forest', 'river', 'blue_pass']) {
        for (const order of ['advance', 'assault', 'flank', 'hold', 'hold_ground']) {
            const scene = makeScene();
            scene.deployUnits({ infantry: 12, pikeman: 4, archer: 4, cavalry: 4 }, { infantry: 1 },
                'custom', 'custom', { red: order }, { terrain, reserves: { red: 3 } });
            for (const unit of scene.units.filter(u => u.team === 'red')) {
                if (terrain !== 'blue_pass' || order !== 'advance' || unit.tacticalRole ||
                    ['archer', 'cavalry'].includes(unit.type)) assert.equal(unit.slopeApproach, undefined);
            }
        }
    }
});

test('both armies advancing without reserves still receive slope lanes, while old maps retain the null-tactics fast path', () => {
    for (const terrain of ['blue_pass', 'red_pass', 'flat', 'blue_hill', 'red_hill', 'forest', 'river']) {
        const scene = makeScene(), army = { infantry: 24, pikeman: 6 };
        scene.deployUnits(army, army, 'custom', 'custom', { red: 'advance', blue: 'advance' },
            { terrain, reserves: { red: 0, blue: 0 } });
        if (!Terrain.isNaturalSlope(terrain)) {
            assert.equal(scene.tactics, null);
            assert.ok(scene.units.every(u => !u.slopeApproach));
            continue;
        }
        assert.ok(scene.tactics);
        assert.ok(scene.units.every(u => u.slopeApproach && !u.slopeApproach.released));
        const origins = scene.units.map(u => ({ gx: u.gx, gy: u.gy }));
        scene.battleStarted = true;
        for (let frame = 0; frame < 180; frame++) scene.advanceBattle(1000 / 60);
        scene.units.forEach((unit, i) => {
            close(unit.gy, origins[i].gy);
            assert.ok((unit.gx - origins[i].gx) * (unit.team === 'red' ? 1 : -1) > 3);
            assert.equal(unit.slopeApproach.released, false);
        });
    }
});

test('natural-slope flank uses a smooth outside curve, monotonic cursor, and a fresh charge only behind the live army', () => {
    const f = cavalryFixture();
    let cursor = 0, previousHeading = null, maxTurn = 0, outside = false, committed = false;
    for (let frame = 0; frame < 1400 && f.cavalry.chargeImpactId == null; frame++) {
        const { cavalry: unit } = f, before = { gx: unit.gx, gy: unit.gy };
        step(f, frame);
        if (unit.state === 'flank') {
            assert.equal(unit.chargeDistance, 0); assert.equal(unit.chargeMomentum, 0);
            assert.ok(unit.flankRoute.index >= cursor);
            cursor = unit.flankRoute.index;
            const heading = Math.atan2(unit.gy - before.gy, unit.gx - before.gx);
            if (previousHeading != null) maxTurn = Math.max(maxTurn,
                Math.abs(Math.atan2(Math.sin(heading - previousHeading), Math.cos(heading - previousHeading))));
            previousHeading = heading;
            if (unit.gx > 31 && unit.gx < 40) { outside = true; assert.ok(unit.gy < 24); }
            if (unit.gx < 46) assert.ok(unit.gx >= before.gx - 1e-9, 'no refresh may send the approach backwards');
            assert.ok(Terrain.walkable('blue_pass', unit.gx, unit.gy));
        } else if (unit.state === 'charge' && !committed) {
            committed = true;
            assert.ok(unit.gx > f.archer.gx + 2);
            assert.equal(unit.chargeDistance, 0);
        }
    }
    assert.ok(outside && committed);
    assert.ok(maxTurn < 0.22, `no right-angle waypoint turns: ${maxTurn}`);
    assert.equal(f.cavalry.chargeImpactId, f.archer.id);
    for (const unit of f.front) assert.equal(unit.hp, unit.maxHp);
});

test('slope flanking mirrors with different ids and reacts to a genuine body/pike interception', () => {
    const left = cavalryFixture(), right = cavalryFixture(true);
    for (let frame = 0; frame < 700; frame++) {
        step(left, frame); step(right, frame);
        close(left.cavalry.gx + right.cavalry.gx, 70);
        close(left.cavalry.gy, right.cavalry.gy);
        assert.equal(left.cavalry.flankRoute.index, right.cavalry.flankRoute.index);
    }
    for (const type of ['infantry', 'pikeman']) {
        const f = cavalryFixture(); step(f, 0);
        const unit = f.cavalry, point = unit.flankRoute.points[unit.flankRoute.index + 2];
        const length = Math.hypot(point.gx - unit.gx, point.gy - unit.gy);
        const dx = (point.gx - unit.gx) / length, dy = (point.gy - unit.gy) / length;
        const blocker = addUnit(f.scene, f.enemy, type, unit.gx + dx * (type === 'pikeman' ? 1.3 : 0.7),
            unit.gy + dy * (type === 'pikeman' ? 1.3 : 0.7));
        if (type === 'pikeman') Object.assign(blocker,
            { braceReady: true, braceSupport: 2, braceFacingX: -dx, braceFacingY: -dy });
        assert.equal(step(f, 1), false);
        assert.equal(unit.state, 'melee'); assert.equal(unit.target, blocker);
        assert.equal(unit.chargeDistance, 0); assert.equal(blocker.hp, blocker.maxHp);
    }
});

test('target death preserves route progress; losing all archers falls back; direct command does not detour', () => {
    const f = cavalryFixture(), replacement = addUnit(f.scene, 'blue', 'archer', 44, 31);
    for (let frame = 0; frame < 200; frame++) step(f, frame);
    const route = f.cavalry.flankRoute, cursor = route.index;
    f.archer.dead = true;
    step(f, 201);
    assert.equal(f.cavalry.flankTarget, replacement);
    assert.equal(f.cavalry.flankRoute, route);
    assert.ok(route.index >= cursor);
    replacement.withdrawn = true;
    step(f, 202);
    assert.equal(f.cavalry.flankRoute, null); assert.equal(f.cavalry.state, 'charge');
    assert.equal(f.cavalry.flankTarget, null);
    const direct = cavalryFixture(false, 'direct');
    for (let frame = 0; frame < 120; frame++) step(direct, frame);
    close(direct.cavalry.gy, 30);
    assert.equal(direct.cavalry.target, direct.front[1]);
    assert.equal(direct.cavalry.flankRoute, undefined);
});

test('moving enemy rear or exhausted route cannot cause an infinite replanning loop or premature flank charge', () => {
    const f = cavalryFixture(); step(f, 0);
    const route = f.cavalry.flankRoute;
    f.archer.gx = 67;
    for (let frame = 1; frame < 1200 && !f.cavalry.naturalFlankAbandoned; frame++) {
        step(f, frame);
        if (f.cavalry.state === 'flank') assert.equal(f.cavalry.flankRoute, route);
        assert.notEqual(f.cavalry.flankCommitted, true);
    }
    assert.equal(f.cavalry.naturalFlankAbandoned, true);
    assert.equal(f.cavalry.state, 'melee');
    const exhausted = cavalryFixture(); step(exhausted, 0);
    step(exhausted, 1801);
    assert.equal(exhausted.cavalry.naturalFlankAbandoned, true);
    assert.equal(exhausted.cavalry.chargeDistance, 0);
});

test('a new flank after physical interception gets its own route budget, but retargeting alone cannot reset it', () => {
    const f = cavalryFixture(); step(f, 0);
    const unit = f.cavalry, oldRoute = unit.flankRoute;
    const point = oldRoute.points[oldRoute.index + 2];
    const distance = Math.hypot(point.gx - unit.gx, point.gy - unit.gy);
    const blocker = addUnit(f.scene, 'blue', 'infantry', unit.gx + (point.gx - unit.gx) / distance * 0.7,
        unit.gy + (point.gy - unit.gy) / distance * 0.7);
    step(f, 1);
    assert.equal(unit.state, 'melee'); assert.equal(unit.target, blocker);
    blocker.dead = true;
    f.scene.cavalryAI.beginCharge(unit);
    step(f, 1200); // 实际近战结束后的下一次包抄，而不是刷新旧路线。
    const newRoute = unit.flankRoute;
    assert.notEqual(newRoute, oldRoute);
    close(newRoute.startedAt, 20000);
    step(f, 1801);
    assert.equal(unit.state, 'flank'); assert.equal(unit.naturalFlankAbandoned, undefined);
    assert.equal(unit.flankRoute, newRoute);
    step(f, 3001);
    assert.equal(unit.naturalFlankAbandoned, true);
});

test('complete slope guard/flank battles keep deterministic reports at 1x and 2x', () => {
    const army = { infantry: 8, pikeman: 3, archer: 4, cavalry: 3 };
    const reports = [1, 2].map(speed => {
        const scene = makeScene();
        scene.deployUnits(army, army, 'custom', 'custom', { blue: 'hold_ground' },
            { terrain: 'blue_pass', cavalryOrders: { red: 'flank_archers' } });
        scene.battleStarted = true; scene.setSpeed(speed);
        for (let frame = 0; frame < 14400 && !scene.battleOver; frame++) scene.advanceBattle(1000 / 60);
        assert.equal(scene.battleOver, true);
        assert.ok(scene.firstContactMs > 0);
        for (const unit of scene.units) assert.ok(Number.isFinite(unit.gx) && Number.isFinite(unit.gy));
        return JSON.parse(JSON.stringify(scene.getBattleReport()));
    });
    assert.deepEqual(reports[0], reports[1]);
});
