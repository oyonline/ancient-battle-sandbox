const test = require('node:test');
const assert = require('node:assert/strict');
const { makeScene } = require('./battle-harness.js');

function fixture(mirrored = false) {
    const scene = makeScene(), team = mirrored ? 'blue' : 'red', enemy = mirrored ? 'red' : 'blue';
    scene.deployUnits(mirrored ? { pikeman: 16 } : { infantry: 24 }, mirrored ? { infantry: 24 } : { pikeman: 16 },
        'square', 'square', { [team]: 'flank', [enemy]: 'hold' }, { deathmatch: true, reserves: { [team]: 10 } });
    scene.battleStarted = true;
    const group = scene.tactics.groups[team];
    scene.rebuildSpatial();
    return { scene, group, team };
}

function collect(scene, units) {
    units.forEach((unit, index) => {
        Object.assign(unit, { gx: unit.team === 'red' ? 15 : 55, gy: 25 + index * 0.8, hp: 43,
            moraleState: 'steady', morale: 60 });
        assert.equal(scene.tactics.onRallied(unit), true);
    });
    scene.rebuildSpatial();
}

test('three real recovered soldiers release as a group without healing, teleporting or replaying their flank route', () => {
    const { scene, group } = fixture();
    const units = group.flank.slice(0, 3);
    collect(scene, units);
    const before = units.map(unit => [unit.gx, unit.gy]);
    scene.tactics.updateRallyWaves(group, 0);
    assert.equal(group.lastRallyWave.count, 3);
    units.forEach((unit, i) => {
        assert.equal(unit.rallyWaiting, false); assert.equal(unit.moralePhase, 'returning');
        assert.deepEqual([unit.gx, unit.gy], before[i]); assert.equal(unit.hp, 43);
        assert.equal(unit.routeIndex, unit.route.length);
    });
});

test('a lone recovered soldier waits at most 1500ms and can defend immediately when threatened', () => {
    for (const threatened of [false, true]) {
        const { scene, group, team } = fixture(), unit = group.main[0];
        collect(scene, [unit]);
        scene.tactics.updateRallyWaves(group, 1499);
        assert.equal(unit.rallyWaiting, true);
        if (threatened) {
            const enemy = scene.units.find(other => other.team !== team);
            Object.assign(enemy, { gx: unit.gx + 5, gy: unit.gy }); scene.rebuildSpatial();
        }
        scene.tactics.updateRallyWaves(group, threatened ? 1499 : 1500);
        assert.equal(unit.rallyWaiting, false);
        assert.equal(unit.moralePhase, 'returning');
    }
});

test('a second rout clears stale returning state and permits a new collection cycle', () => {
    const { scene, group } = fixture(), unit = group.flank[0];
    collect(scene, [unit]); scene.tactics.updateRallyWaves(group, 1500);
    unit.moraleState = 'routing'; scene.tactics.updateRallyWaves(group, 1700);
    assert.equal(unit.rallyWaiting, false); assert.equal(unit.tacticalRejoined, false);
    assert.equal(unit.moralePhase, 'retreating');
    scene.simulationTime = 1800; unit.moraleState = 'steady'; scene.tactics.onRallied(unit);
    assert.equal(unit.rallyReadyAt, 1800); assert.equal(unit.rallyWaiting, true);
    scene.tactics.updateRallyWaves(group, 3300);
    assert.equal(unit.moralePhase, 'returning'); assert.equal(group.rallyWave, 2);
});

test('a reception patrol contains at most five existing reserves and only forms real safe anchors', () => {
    const { scene, group } = fixture(), routed = group.flank[0];
    Object.assign(routed, { gx: group.cx, gy: group.cy - group.half - 2, moraleState: 'routing' });
    scene.tactics.updateReception(group, [routed]);
    const helpers = group.reserve.filter(unit => unit.receptionSlot);
    assert.equal(helpers.length, 5); assert.equal(group.reserve.length, 10);
    assert.ok(helpers.every(unit => scene.tactics.safeAt(unit.team, unit.receptionSlot.gx, unit.receptionSlot.gy)));
    helpers.forEach(unit => { Object.assign(unit, unit.receptionSlot); });
    scene.rebuildSpatial(); scene.tactics.updateReserves(group, 0);
    Object.assign(routed, { gx: helpers[2].gx, gy: helpers[2].gy - 2 });
    scene.rebuildSpatial();
    const nearby = scene.tactics.rallyPoint(routed);
    assert.ok(Math.hypot(nearby.gx - routed.gx, nearby.gy - routed.gy) < 4,
        'a flanker beside the real side reception group does not detour back around the front');
    group.reserve.forEach(unit => { unit.reserveCommitted = true; });
    assert.equal(scene.tactics.rallyPoint(routed), null, 'committed reserves cannot remain ghost anchors');
});

test('a retreat route exits the nearest side and follows mirror-equivalent outside paths', () => {
    const a = fixture(), b = fixture(true);
    const route = value => {
        const { group, scene } = value, unit = group.flank[0], f = unit.team === 'red' ? 1 : -1;
        Object.assign(unit, { gx: group.cx + f * group.half, gy: group.cy - group.half - 1 });
        const destination = { gx: group.cx - f * (group.half + 10), gy: group.cy + 2 };
        return { point: scene.tactics.outsideRoute(unit, destination, group, 2.6), unit, group };
    };
    const p = route(a), q = route(b);
    assert.ok(p.point.gy < p.group.cy - p.group.half - 2.5);
    assert.ok(Math.abs(p.point.gx + q.point.gx - 70) < 1e-8);
    assert.ok(Math.abs(p.point.gy - q.point.gy) < 1e-8);
});

test('returning soldiers reject a clearer enemy beyond six even when its spatial bucket is nearby', () => {
    for (const mirrored of [false, true]) {
        const { scene, group, team } = fixture(mirrored);
        const unit = group.main[0], blocker = group.main[1];
        const enemies = scene.units.filter(other => other.team !== team), near = enemies[0], far = enemies[1];
        const x = value => mirrored ? 70 - value : value;
        Object.assign(unit, { gx: x(54), gy: 39, moralePhase: 'returning', rallyWaiting: false });
        Object.assign(blocker, { gx: x(55), gy: 39 });
        Object.assign(near, { gx: x(59.5), gy: 39 });
        Object.assign(far, { gx: x(60.2), gy: 42 });
        scene.units = [unit, blocker, near, far];
        scene.rebuildSpatial();
        assert.equal(scene.nearestEnemy(unit), near);
        assert.equal(scene.tactics.clearLane(unit, near), false);
        assert.equal(scene.tactics.clearLane(unit, far), true);
        assert.ok(Math.hypot(unit.gx - far.gx, unit.gy - far.gy) > 6);
        if (!mirrored) {
            const bucketCandidates = [];
            scene.forEachNear(unit.gx, unit.gy, 6, other => bucketCandidates.push(other));
            assert.ok(bucketCandidates.includes(far), 'the spatial broad phase includes this out-of-range enemy');
        }
        let chosen;
        scene.tactics.fight = (actor, target) => { chosen = target; };
        scene.tactics.updateUnit(unit, 1000, 1 / 60);
        assert.equal(chosen, near, 'a clear but distant target cannot enter the local reinforcement choices');
    }
});
