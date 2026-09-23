const test = require('node:test');
const assert = require('node:assert/strict');
const { makeScene, snapshot } = require('./battle-harness.js');

function deploy(mirrored = false, count = 150, reserve = 50) {
    const scene = makeScene();
    const team = mirrored ? 'blue' : 'red', enemy = mirrored ? 'red' : 'blue';
    scene.deployUnits(mirrored ? { pikeman: 100 } : { infantry: count },
        mirrored ? { infantry: count } : { pikeman: 100 }, 'square', 'square',
        { [team]: 'flank', [enemy]: 'hold' }, { deathmatch: true, reserves: { [team]: reserve } });
    scene.battleStarted = true;
    return { scene, team, group: scene.tactics.groups[team] };
}

function advance(scene, seconds) {
    for (let i = 0; i < seconds * 60 && !scene.battleOver; i++) scene.advanceBattle(1000 / 60);
}

test('150 swords contain 50 fixing, 50 flanking and 50 real reserve soldiers without extra health', () => {
    const { scene, team, group } = deploy();
    assert.equal(group.main.length, 50);
    assert.equal(group.flank.length, 50);
    assert.equal(group.reserve.length, 50);
    assert.equal(scene.units.filter(unit => unit.team === team).length, 150);
    assert.ok(group.reserve.every(unit => unit.tacticalRole === 'reserve' && unit.hp === unit.typeData.hp));
    const summary = snapshot(scene.getTacticsSummary()[team]);
    assert.equal(summary.reserve, 50);
    assert.equal(summary.committed, 0);
    assert.equal(summary.regrouping, 0);
    assert.equal(summary.rallied, 0);
});

test('flank routes form short sampled curves into the side, without right angle marching or a mandatory rear circuit', () => {
    const { group } = deploy();
    for (const unit of group.flank) {
        const points = [{ gx: unit.gx, gy: unit.gy }, ...unit.route];
        assert.ok(points.length > 12);
        assert.ok(unit.route.at(-1).gx < group.cx + group.half, 'the destination is the side, before the rear face');
        assert.ok(Math.min(...points.map(point => point.gy)) < group.cy - group.half - 2.5);
        let length = 0;
        for (let i = 1; i < points.length; i++) {
            const a = points[i - 1], b = points[i];
            const dx = b.gx - a.gx, dy = b.gy - a.gy;
            length += Math.hypot(dx, dy);
            if (i > 1) {
                const prior = points[i - 2];
                const px = a.gx - prior.gx, py = a.gy - prior.gy;
                assert.ok((px * dx + py * dy) / (Math.hypot(px, py) * Math.hypot(dx, dy)) > 0.8,
                    'adjacent route segments turn gently instead of forming corners');
            }
        }
        assert.ok(length < 55, 'the flank travels toward a nearby side instead of visiting a distant rectangle');
    }
});

test('reserve support requires three actual steady reserves nearby and no enemy within six', () => {
    const { scene, group } = deploy();
    const routed = group.main[0];
    Object.assign(routed, { gx: 20, gy: 36, moraleState: 'routing' });
    for (let i = 0; i < group.reserve.length; i++) Object.assign(group.reserve[i], {
        gx: i < 3 ? 19 + i * 0.8 : 6, gy: i < 3 ? 36 : 10, reserveCommitted: false
    });
    scene.rebuildSpatial();
    scene.tactics.updateReserves(group, 1000);
    assert.equal(scene.tactics.reserveSupport(routed), true);
    group.reserve[2].moraleState = 'routing';
    assert.equal(scene.tactics.reserveSupport(routed), false);
    group.reserve[2].moraleState = 'steady';
    const enemy = scene.units.find(unit => unit.team !== routed.team);
    Object.assign(enemy, { gx: 25.5, gy: 36 });
    scene.rebuildSpatial();
    assert.equal(scene.tactics.reserveSupport(routed), false, 'a threatened rally site provides no reserve recovery bonus');
});

test('one or two remaining reserves do not advertise an unusable rally point', () => {
    const { scene, group } = deploy();
    scene.rebuildSpatial();
    scene.tactics.updateReserves(group, 1000);
    for (const unit of group.reserve.slice(2)) unit.reserveCommitted = true;
    assert.equal(scene.tactics.rallyPoint(group.main[0]), null);
    group.reserve[2].reserveCommitted = false;
    assert.ok(scene.tactics.rallyPoint(group.main[0]), 'three real safe reserves can form the rally point');
    group.reserve[2].moraleState = 'routing';
    assert.equal(scene.tactics.rallyPoint(group.main[0]), null);
    group.reserve[2].moraleState = 'steady';
    for (const [i, unit] of group.reserve.slice(0, 3).entries()) Object.assign(unit, { gx: 5 + i * 9, gy: 10 });
    scene.rebuildSpatial();
    assert.equal(scene.tactics.rallyPoint(group.main[0]), null, 'three widely separated soldiers cannot advertise their empty centroid');
});

test('a nearby unprepared side guard allows an early flank entry while distant enemies do not cancel the curve', () => {
    const { scene, group } = deploy();
    const unit = group.flank[0];
    scene.rebuildSpatial();
    scene.tactics.updateUnit(unit, 1000, 1 / 60);
    assert.ok(!unit.tacticalContact, 'a distant nearest enemy does not steal the marching order');
    Object.assign(unit, { gx: group.cx, gy: group.cy - group.half - 3, routeIndex: 5 });
    scene.rebuildSpatial();
    scene.tactics.updateUnit(unit, 2000, 1 / 60);
    assert.equal(unit.tacticalContact, true, 'the wing can turn into a nearby side opening before finishing all waypoints');
    assert.ok(unit.routeIndex < unit.route.length);
});

test('reserve reinforcements commit in 20, 20 and 10, retaining a real rally cadre while needed', () => {
    const { scene, group } = deploy();
    scene.rebuildSpatial();
    group.engagedAt = 0;
    scene.tactics.updateReserves(group, 18000);
    assert.equal(group.committed, 20);
    assert.equal(group.reserve.filter(unit => !unit.reserveCommitted).length, 30);
    scene.tactics.updateReserves(group, 48000);
    assert.equal(group.committed, 40);
    assert.equal(group.reserve.filter(unit => !unit.reserveCommitted).length, 10);
    group.main[0].moraleState = 'routing';
    scene.tactics.updateReserves(group, 90000);
    assert.equal(group.committed, 40, 'keep the last cadre while there are troops to regroup');
    group.main[0].moraleState = 'steady';
    scene.tactics.updateReserves(group, 90200);
    assert.equal(group.committed, 50);
    assert.equal(scene.tactics.rallyPoint(group.main[0]), null, 'fully committed reserves cannot remain a phantom rally site');
});

test('flankers retreat outside the enemy square, then rallied soldiers reinforce directly without replaying their route', () => {
    const { scene, group } = deploy();
    scene.rebuildSpatial();
    scene.tactics.updateReserves(group, 1000);
    const unit = group.flank[0];
    Object.assign(unit, { gx: group.cx + group.half, gy: group.cy - group.half - 1, moraleState: 'routing' });
    const escape = scene.tactics.rallyPoint(unit);
    assert.equal(escape.gx, unit.gx);
    assert.ok(escape.gy < group.cy - group.half - 6);
    Object.assign(unit, { gx: group.rallyCenter.gx, gy: group.rallyCenter.gy, moraleState: 'wavering', everRallied: true });
    const health = unit.hp;
    scene.rebuildSpatial();
    scene.tactics.updateUnit(unit, 2000, 1 / 60);
    assert.equal(unit.routeIndex, unit.route.length);
    assert.equal(unit.tacticalContact, true);
    assert.equal(unit.hp, health, 'rallying does not heal or resurrect troops');
    assert.equal(scene.getTacticsSummary()[unit.team].rallied, 1);
});

test('reserve movement and early flank paths preserve side-exchange symmetry and finite movement', () => {
    const forward = deploy(false), reverse = deploy(true);
    const remaining = new Set(reverse.scene.units);
    const pairs = forward.scene.units.map(unit => {
        const other = [...remaining].find(candidate => candidate.team !== unit.team && candidate.type === unit.type &&
            Math.abs(candidate.gx + unit.gx - 70) < 1e-6 && Math.abs(candidate.gy - unit.gy) < 1e-6);
        assert.ok(other);
        remaining.delete(other);
        return [unit, other];
    });
    const reserve = forward.group.reserve[0], start = { x: reserve.gx, y: reserve.gy };
    advance(forward.scene, 1);
    advance(reverse.scene, 1);
    assert.ok(Math.hypot(reserve.gx - start.x, reserve.gy - start.y) <= reserve.typeData.speed * 1.05,
        'reserves march to their rally site instead of teleporting');
    for (const [a, b] of pairs) {
        assert.ok(Math.abs(a.gx + b.gx - 70) < 1e-5);
        assert.ok(Math.abs(a.gy - b.gy) < 1e-5);
        assert.equal(a.hp, b.hp);
    }
});

test('rally reserve contracts also work with ordinary advance orders', () => {
    const scene = makeScene();
    scene.deployUnits({ infantry: 15 }, { infantry: 10 }, 'square', 'square',
        { red: 'advance', blue: 'advance' }, { deathmatch: true, reserves: { red: 5 } });
    const group = scene.tactics.groups.red;
    assert.equal(group.main.length, 10);
    assert.equal(group.flank.length, 0);
    assert.equal(group.reserve.length, 5);
    assert.equal(group.launched, true);
});

test('deathmatch breaks a double-hold stalemate into actual movement and combat without retaining guard bonuses', () => {
    const scene = makeScene();
    scene.deployUnits({ pikeman: 4 }, { pikeman: 4 }, 'square', 'square',
        { red: 'hold', blue: 'hold' }, { deathmatch: true });
    scene.battleStarted = true;
    advance(scene, 9.9);
    assert.equal(scene.battleOver, false);
    assert.ok(scene.units.every(unit => unit.tacticalRole === 'guard'));
    const before = scene.units.map(unit => ({ x: unit.gx, y: unit.gy }));
    advance(scene, 0.2);
    assert.ok(scene.units.every(unit => unit.tacticalRole == null && unit.formationSlot == null && !unit.guardReady));
    assert.equal(Object.keys(scene.tactics.formations).length, 0);
    assert.equal(scene.getTacticsSummary().red.order, 'advance');
    assert.equal(scene.getTacticsSummary().red.slots, 0);
    advance(scene, 22);
    assert.ok(scene.units.some((unit, i) => Math.hypot(unit.gx - before[i].x, unit.gy - before[i].y) > 2));
    assert.ok(scene.battleStats.red.damage + scene.battleStats.blue.damage > 0,
        'breaking the stalemate must cause real fighting rather than another indefinite wait');
});
