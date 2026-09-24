const test = require('node:test');
const assert = require('node:assert/strict');
const { Terrain, makeScene, addUnit } = require('./battle-harness.js');

function fixture(order = 'flank_archers', mirrored = false, terrain = 'flat') {
    const scene = makeScene();
    const x = value => mirrored ? 70 - value : value;
    const team = mirrored ? 'blue' : 'red', enemy = mirrored ? 'red' : 'blue';
    scene.battleOptions.terrain = terrain;
    if (order) scene.battleOptions.cavalryOrders = { [team]: order };
    const cavalry = addUnit(scene, team, 'cavalry', x(20), 30);
    const front = [27, 30, 33].map(y => addUnit(scene, enemy, 'infantry', x(35), y));
    const archer = addUnit(scene, enemy, 'archer', x(43), 30);
    scene.rebuildSpatial();
    return { scene, cavalry, front, archer };
}

function step(f, now, dt = 1 / 60) {
    f.scene.simulationTime = now;
    f.scene.rebuildSpatial();
    return f.scene.cavalryAI.update(f.cavalry, now, dt);
}

const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-9, message || `${a} != ${b}`);

test('omitted and auto cavalry commands retain exactly the legacy run-up and archer preference', () => {
    const implicit = fixture(null), explicit = fixture('auto');
    for (const f of [implicit, explicit]) {
        f.cavalry.gx = 30;
        f.archer.gx = 41;
        f.scene.rebuildSpatial();
        assert.equal(f.scene.cavalryAI.pickTarget(f.cavalry), f.archer);
    }
    for (let frame = 0; frame < 30; frame++) {
        step(implicit, frame * 1000 / 60); step(explicit, frame * 1000 / 60);
        for (const key of ['gx', 'gy', 'state', 'chargeDistance', 'chargeMomentum']) {
            assert.equal(implicit.cavalry[key], explicit.cavalry[key], key);
        }
    }
    implicit.scene.battleOptions.cavalryOrders = { red: '__proto__' };
    assert.equal(implicit.scene.cavalryAI.command(implicit.cavalry), 'auto');
});

test('direct cavalry picks the front soldier rather than a nearby rear archer', () => {
    for (const mirrored of [false, true]) {
        const f = fixture('direct', mirrored);
        f.cavalry.gx = mirrored ? 40 : 30;
        f.archer.gx = mirrored ? 31 : 39;
        f.scene.rebuildSpatial();
        assert.equal(f.scene.cavalryAI.pickTarget(f.cavalry), f.front[1]);
        step(f, 0);
        assert.equal(f.cavalry.target, f.front[1]);
        close(f.cavalry.gy, 30);
    }
});

test('auto respects a local guard target while explicit assault ignores it', () => {
    const f = fixture('auto');
    f.cavalry.gx = 30;
    f.archer.gx = 40;
    f.scene.rebuildSpatial();
    f.cavalry.groundGuardTarget = f.front[0];
    assert.equal(f.scene.cavalryAI.pickTarget(f.cavalry), f.front[0]);
    f.scene.battleOptions.cavalryOrders.red = 'direct';
    assert.equal(f.scene.cavalryAI.pickTarget(f.cavalry), f.front[1]);
});

test('flanking travels outside the front line, reaches the rear, then builds a fresh straight charge', () => {
    const f = fixture();
    let outside = false, reachedRear = false, startedCharge = false;
    for (let frame = 0; frame < 900 && f.cavalry.chargeImpactId == null; frame++) {
        step(f, frame * 1000 / 60);
        const u = f.cavalry;
        if (u.state === 'flank') {
            assert.equal(u.chargeDistance, 0);
            assert.equal(u.chargeMomentum, 0);
            if (u.gx > 30 && u.gx < 40) {
                outside = true;
                assert.ok(u.gy < 25, 'the rider must pass visibly outside the infantry footprint');
            }
        }
        reachedRear ||= u.gx > f.archer.gx + 3;
        if (u.state === 'charge' && !startedCharge) {
            startedCharge = true;
            assert.equal(u.chargeDistance, 0, 'turning into the archer must discard all route momentum');
        }
    }
    assert.ok(outside && reachedRear && startedCharge);
    assert.equal(f.cavalry.chargeImpactId, f.archer.id);
    assert.ok(f.archer.hp < f.archer.maxHp);
    for (const soldier of f.front) assert.equal(soldier.hp, soldier.maxHp);
});

test('flanking chooses the nearer side and has deterministic red/blue mirrored motion', () => {
    const left = fixture(), right = fixture('flank_archers', true);
    left.cavalry.gy = right.cavalry.gy = 34;
    for (let frame = 0; frame < 750; frame++) {
        step(left, frame * 1000 / 60); step(right, frame * 1000 / 60);
        close(left.cavalry.gx + right.cavalry.gx, 70, `x mirror at ${frame}`);
        close(left.cavalry.gy, right.cavalry.gy, `y mirror at ${frame}`);
        assert.equal(left.cavalry.state, right.cavalry.state);
        if (frame === 0) {
            assert.equal(left.cavalry.flankRoute.side, 1);
            assert.equal(right.cavalry.flankRoute.side, 1);
        }
        if (left.cavalry.state === 'melee') break;
    }
});

test('a flank interceptor or prepared pike blocks the route without gifting a charge hit', () => {
    for (const type of ['infantry', 'pikeman']) {
        const f = fixture();
        step(f, 0);
        const blocker = addUnit(f.scene, 'blue', type, f.cavalry.gx, f.cavalry.gy - (type === 'pikeman' ? 1.3 : 0.65));
        if (type === 'pikeman') Object.assign(blocker, {
            braceReady: true, braceSupport: 2, braceFacingX: 0, braceFacingY: 1
        });
        const beforeY = f.cavalry.gy;
        assert.equal(step(f, 100), false);
        assert.equal(f.cavalry.state, 'melee');
        assert.equal(f.cavalry.target, blocker);
        assert.equal(f.cavalry.chargeDistance, 0);
        assert.equal(f.cavalry.chargeImpactId, null);
        assert.equal(blocker.hp, blocker.maxHp);
        close(f.cavalry.gy, beforeY);
    }
});

test('dead, withdrawn or routing archers invalidate the route and no-archer armies use direct charge', () => {
    for (const status of ['dead', 'withdrawn', 'routing']) {
        const f = fixture();
        step(f, 0);
        if (status === 'routing') f.archer.moraleState = 'routing';
        else f.archer[status] = true;
        // A withdrawn/dead archer is absent from nearestEnemy; routing still has a body.
        if (status === 'routing') f.archer.gx = 65;
        step(f, 20);
        assert.equal(f.cavalry.flankTarget, null);
        assert.equal(f.cavalry.flankRoute, null);
        assert.equal(f.cavalry.state, 'charge');
        assert.equal(f.cavalry.target, f.front[1]);
        for (let frame = 2; frame < 85; frame++) step(f, frame * 1000 / 60);
        assert.ok(f.cavalry.chargeDistance > 6, 'low-frequency archer rechecks must not reset direct run-up');
    }
});

test('losing a target refreshes toward another live archer instead of following stale coordinates', () => {
    const f = fixture();
    const replacement = addUnit(f.scene, 'blue', 'archer', 44, 31);
    step(f, 0);
    assert.equal(f.cavalry.flankTarget, f.archer);
    f.archer.withdrawn = true;
    step(f, 20);
    assert.equal(f.cavalry.flankTarget, replacement);
    assert.equal(f.cavalry.target, replacement);
});

test('flank movement obeys the same local terrain and uncommitted movement never accumulates momentum', () => {
    const f = fixture();
    f.scene.battleOptions.terrain = 'red_hill';
    f.cavalry.gx = 35;
    f.cavalry.gy = 35;
    f.scene.planningStep = true;
    step(f, 0, 0.1);
    const route = f.cavalry.flankRoute;
    const slope = Terrain.movementMultiplier('red_hill', 35, 35, 35, route.y);
    close(Math.abs(f.cavalry.moveY), 0.4 * slope);
    close(f.cavalry.terrainMoveMultiplier, slope, 'inspector reads the multiplier actually used by this move');
    for (let frame = 1; frame < 100; frame++) step(f, frame * 17, 0.1);
    close(f.cavalry.gx, 35); close(f.cavalry.gy, 35);
    assert.equal(f.cavalry.chargeDistance, 0);
    assert.equal(f.cavalry.chargeImpactId, null);
});

test('many cavalry share one enemy-footprint scan per 750ms instead of scanning every frame', () => {
    const f = fixture();
    const riders = [f.cavalry, addUnit(f.scene, 'red', 'cavalry', 20, 32), addUnit(f.scene, 'red', 'cavalry', 20, 34)];
    let scans = 0;
    const iterator = f.scene.units[Symbol.iterator].bind(f.scene.units);
    f.scene.units[Symbol.iterator] = function () { scans++; return iterator(); };
    for (let frame = 0; frame < 30; frame++) {
        f.scene.rebuildSpatial();
        for (const cavalry of riders) f.scene.cavalryAI.update(cavalry, frame * 1000 / 60, 1 / 60);
    }
    assert.equal(scans, 1);
    for (const cavalry of riders) f.scene.cavalryAI.update(cavalry, 800, 1 / 60);
    assert.equal(scans, 2);
});

test('a complete flank battle remains mirrored with moving enemies and actual body separation', () => {
    const left = fixture('flank_archers', false, 'red_hill');
    const right = fixture('flank_archers', true, 'blue_hill');
    for (let frame = 0; frame < 12000 && (!left.scene.battleOver || !right.scene.battleOver); frame++) {
        left.scene.advanceBattle(1000 / 60);
        right.scene.advanceBattle(1000 / 60);
        for (let i = 0; i < left.scene.units.length; i++) {
            const a = left.scene.units[i], b = right.scene.units[i];
            close(a.gx + b.gx, 70, `x mirror at ${frame}, unit ${i}`);
            close(a.gy, b.gy, `y mirror at ${frame}, unit ${i}`);
            assert.equal(a.hp, b.hp);
            assert.equal(a.state, b.state);
        }
    }
    assert.equal(left.scene.battleOver && right.scene.battleOver, true);
    assert.equal(left.scene.getBattleReport().durationMs, right.scene.getBattleReport().durationMs);
});

test('flank battles finish identically at 1x and 2x simulation speed', () => {
    const reports = [1, 2].map(speed => {
        const f = fixture('flank_archers', false, 'blue_hill');
        f.scene.setSpeed(speed);
        for (let frame = 0; frame < 12000 && !f.scene.battleOver; frame++) f.scene.advanceBattle(1000 / 60);
        assert.equal(f.scene.battleOver, true);
        return JSON.parse(JSON.stringify(f.scene.getBattleReport()));
    });
    assert.deepEqual(reports[0], reports[1]);
});
