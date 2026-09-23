const test = require('node:test');
const assert = require('node:assert/strict');
const { makeScene, snapshot, addUnit, resolveAttack, calculateAttackDamage } = require('./battle-harness.js');

const STEP = 1000 / 60;

function deploy(order = 'assault', count = 24, mirrored = false) {
    const scene = makeScene();
    const attackTeam = mirrored ? 'blue' : 'red';
    const defendTeam = mirrored ? 'red' : 'blue';
    scene.deployUnits(
        mirrored ? { pikeman: count } : { infantry: count },
        mirrored ? { infantry: count } : { pikeman: count },
        'square', 'square',
        { [attackTeam]: order, [defendTeam]: 'hold' }
    );
    scene.battleStarted = true;
    return { scene, attackTeam, defendTeam };
}

function advance(scene, seconds, observe) {
    const frames = Math.round(seconds * 60 / scene.gameSpeed);
    for (let frame = 0; frame < frames && !scene.battleOver; frame++) {
        scene.advanceBattle(STEP);
        if (observe) observe(scene);
    }
}

function finish(scene, seconds = 180) {
    advance(scene, seconds);
    assert.equal(scene.battleOver, true, 'the formation battle must finish instead of deadlocking');
    return snapshot(scene.getBattleReport());
}

function living(scene, team) {
    return scene.units.filter(unit => unit.team === team && !unit.dead && !unit.withdrawn);
}

function state(scene) {
    return snapshot({
        time: scene.simulationTime,
        winner: scene.winner,
        tactics: scene.getTacticsSummary(),
        report: scene.getBattleReport(),
        units: scene.units.map(unit => ({
            id: unit.id, team: unit.team, type: unit.type,
            x: unit.gx, y: unit.gy, hp: unit.hp,
            morale: unit.morale, moraleState: unit.moraleState,
            dead: unit.dead, withdrawn: unit.withdrawn,
            ready: unit.braceReady, guardReady: unit.guardReady,
            role: unit.tacticalRole, routeIndex: unit.routeIndex,
            guardFacingX: unit.guardFacingX, guardFacingY: unit.guardFacingY
        }))
    });
}

test('a complete 100-pike defensive square holds against 100 swords attacking its front', () => {
    const { scene, defendTeam } = deploy('assault', 100);
    const report = finish(scene);
    assert.equal(scene.winner, defendTeam,
        'standing together should give the complete square a real advantage against a frontal assault');
    assert.ok(report.teams[defendTeam].alive > 0);
    assert.ok(report.teams[defendTeam].damage > 0, 'holding must involve actual combat, not an unreachable stalemate');
});

test('half the swords take a real route outside the pikes before engaging, while the main force waits', () => {
    const { scene, attackTeam, defendTeam } = deploy('flank', 100);
    const main = scene.units.filter(unit => unit.team === attackTeam && unit.tacticalRole === 'main');
    const flank = scene.units.filter(unit => unit.team === attackTeam && unit.tacticalRole === 'flank');
    assert.equal(main.length, 50);
    assert.equal(flank.length, 50);
    const summary = scene.getTacticsSummary()[attackTeam];
    assert.equal(summary.main, 50);
    assert.equal(summary.flank, 50);

    const guards = living(scene, defendTeam);
    const front = Math.min(...guards.map(unit => unit.gx));
    const top = Math.min(...guards.map(unit => unit.gy));
    const bottom = Math.max(...guards.map(unit => unit.gy));
    const outside = unit => unit.gy < top - 0.5 || unit.gy > bottom + 0.5;
    const tookOutsideRoute = new Set();
    let wingReachedSide = false;
    let flankMadeContact = false;
    const recordDamage = scene.recordDamage.bind(scene);
    scene.recordDamage = (target, damage, from) => {
        if (damage > 0 && from?.team === attackTeam && from.tacticalRole === 'flank') {
            assert.ok(tookOutsideRoute.has(from), 'a flanker must travel around the square before its first strike');
            flankMadeContact = true;
        }
        recordDamage(target, damage, from);
    };

    advance(scene, 100, () => {
        for (const unit of flank) {
            if (outside(unit)) tookOutsideRoute.add(unit);
            if (unit.gx >= front - 1.5) {
                assert.ok(tookOutsideRoute.has(unit),
                    'flankers cannot cross the frontal spear approach before moving outside the formation');
                if (outside(unit)) wingReachedSide = true;
            }
        }
        if (!wingReachedSide) {
            assert.ok(main.every(unit => !unit.dead && !unit.withdrawn),
                'the fixing force must not be sacrificed while its wing is still marching into position');
        }
    });
    assert.equal(tookOutsideRoute.size, flank.length, 'the assigned half must actually execute the detour');
    assert.equal(wingReachedSide, true);
    assert.equal(flankMadeContact, true, 'a detour must lead back into battle rather than strand the wing');
});

test('a defensive square prepares outward-facing guards on all four sides without tracking one distant enemy', () => {
    const { scene, defendTeam } = deploy('assault', 36);
    const guards = living(scene, defendTeam);
    assert.ok(guards.every(unit => unit.tacticalRole === 'guard' && unit.formationSlot));
    advance(scene, 2);
    const ready = guards.filter(unit => unit.guardReady);
    assert.ok(ready.length > 0, 'stationary guards must finish preparation');
    for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        assert.ok(ready.some(unit => unit.guardFacingX * x + unit.guardFacingY * y > 0.9),
            `the ${x},${y} side needs a prepared outward-facing guard`);
    }
    for (const unit of ready) {
        const slot = unit.formationSlot;
        assert.ok(unit.guardFacingX * slot.faceX + unit.guardFacingY * slot.faceY > 0.9,
            'guard posture must keep its assigned side instead of turning the whole square toward one army');
    }
});

test('pause freezes tactical movement and preparation; redeployment clears the old orders', () => {
    const { scene } = deploy('flank');
    advance(scene, 2);
    assert.ok(scene.tactics, 'the flank/hold deployment must activate tactics');
    scene.togglePause();
    const paused = state(scene);
    advance(scene, 3);
    assert.deepEqual(state(scene), paused);

    scene.setSpeed(2);
    scene.deployUnits({ infantry: 4 }, { infantry: 4 }, 'custom', 'custom');
    assert.equal(scene.tactics, null, 'ordinary redeployment must not keep an old tactical system');
    assert.equal(scene.getTacticsSummary(), null);
    assert.equal(scene.simulationTime, 0);
    assert.equal(scene.paused, false);
    assert.equal(scene.gameSpeed, 1);
    assert.equal(scene.battleQueue.length, 0);

    scene.battleStarted = true;
    const fresh = makeScene();
    fresh.deployUnits({ infantry: 4 }, { infantry: 4 }, 'custom', 'custom');
    fresh.battleStarted = true;
    advance(scene, 8);
    advance(fresh, 8);
    const normalize = value => {
        // Deployment epochs and monotonically allocated ids are not gameplay state.
        const result = state(value);
        result.units.forEach(unit => delete unit.id);
        return result;
    };
    assert.deepEqual(normalize(scene), normalize(fresh), 'no waypoint or guard state may leak into the next battle');
});

test('small flank battles use identical simulation outcomes at 1x and 2x', () => {
    function run(speed) {
        const { scene } = deploy('flank', 16);
        scene.setSpeed(speed);
        finish(scene);
        return state(scene);
    }
    assert.deepEqual(run(1), run(2));
});

test('flank and hold preserve corresponding movement, health and outcomes when teams exchange sides', () => {
    const forward = deploy('flank', 16);
    const reversed = deploy('flank', 16, true);
    const available = new Set(reversed.scene.units);
    const pairs = forward.scene.units.map(unit => {
        const partner = [...available].find(other => other.team !== unit.team && other.type === unit.type &&
            Math.abs(other.gx + unit.gx - 70) < 1e-6 && Math.abs(other.gy - unit.gy) < 1e-6);
        assert.ok(partner, 'initial tactical placement must mirror around the battlefield center');
        available.delete(partner);
        return [unit, partner];
    });
    for (let frame = 0; frame < 180 * 60 && (!forward.scene.battleOver || !reversed.scene.battleOver); frame++) {
        forward.scene.advanceBattle(STEP);
        reversed.scene.advanceBattle(STEP);
        if (frame % 60 === 0) {
            for (const [a, b] of pairs) {
                assert.ok(Math.abs(a.gx + b.gx - 70) < 1e-5, `mirrored x differs at step ${frame}`);
                assert.ok(Math.abs(a.gy - b.gy) < 1e-5, `mirrored y differs at step ${frame}`);
                assert.equal(a.hp, b.hp);
                assert.equal(a.moraleState, b.moraleState);
            }
        }
    }
    assert.equal(forward.scene.battleOver, true);
    assert.equal(reversed.scene.battleOver, true);
    const outcome = scene => scene.winner === 'draw' ? 'draw' : scene.winner === 'red' ? 'blue' : 'red';
    assert.equal(outcome(forward.scene), reversed.scene.winner);
    const a = snapshot(forward.scene.getBattleReport());
    const b = snapshot(reversed.scene.getBattleReport());
    assert.equal(a.durationMs, b.durationMs);
    assert.deepEqual(a.teams.red, b.teams.blue);
    assert.deepEqual(a.teams.blue, b.teams.red);
});

test('omitted orders and explicit advance preserve the same ordinary battle', () => {
    function run(orders) {
        const scene = makeScene();
        scene.deployUnits({ infantry: 6, pikeman: 3, archer: 2 },
            { infantry: 6, pikeman: 3, archer: 2 }, 'custom', 'custom', orders);
        scene.battleStarted = true;
        assert.equal(scene.tactics, null);
        assert.equal(scene.getTacticsSummary(), null);
        assert.ok(scene.units.every(unit => unit.tacticalRole == null && unit.formationSlot == null));
        finish(scene);
        return state(scene);
    }
    assert.deepEqual(run(), run({ red: 'advance', blue: 'advance' }));
});

function preparedGuard() {
    const scene = makeScene();
    scene.deployUnits({ infantry: 1 }, { pikeman: 25 }, 'custom', 'square', { blue: 'hold' });
    scene.battleStarted = true;
    advance(scene, 1);
    const guard = scene.units.find(unit => unit.team === 'blue' && unit.formationSlot.rank === 0 &&
        unit.formationSlot.faceX === -1 && Math.abs(unit.gy - 35) < 0.01);
    const sword = scene.units.find(unit => unit.team === 'red');
    assert.ok(guard?.guardReady && guard.braceReady, 'the fixture needs a prepared front guard');
    return { scene, guard, sword };
}

function placeRelative(unit, guard, forward, sideways = 0) {
    const { faceX, faceY } = guard.formationSlot;
    unit.gx = guard.gx + faceX * forward - faceY * sideways;
    unit.gy = guard.gy + faceY * forward + faceX * sideways;
    unit.pgx = unit.gx;
    unit.pgy = unit.gy;
}

function routedAndReplacedGuard() {
    const { scene, guard, sword } = preparedGuard();
    const oldSlot = guard.formationSlot;
    guard.morale = 20;
    guard.moraleState = 'routing';
    scene.onMoraleStateChange(guard, 'steady', 'test: local front guard routed');
    // The defeated guard has physically left its post, leaving room for a reserve.
    guard.gx += 4;
    guard.pgx = guard.gx;
    for (let frame = 0; frame < 24 && oldSlot.unit === guard; frame++) scene.advanceBattle(STEP);
    const replacement = oldSlot.unit;
    assert.ok(replacement && replacement !== guard, 'a nearby reserve must claim the vacant front post');
    return { scene, guard, sword, replacement, oldSlot };
}

test('two hold orders end as a stalemate draw after ten seconds without movement or combat', () => {
    const scene = makeScene();
    scene.deployUnits({ pikeman: 9 }, { pikeman: 9 }, 'square', 'square', { red: 'hold', blue: 'hold' });
    scene.battleStarted = true;
    advance(scene, 9.9);
    assert.equal(scene.battleOver, false, 'the stalemate grace period must not end early');
    advance(scene, 0.2);
    assert.equal(scene.battleOver, true);
    assert.equal(scene.winner, 'draw');
    assert.equal(scene.endReason, 'stalemate');
    const report = scene.getBattleReport();
    assert.equal(report.teams.red.alive, 9);
    assert.equal(report.teams.blue.alive, 9);
    assert.equal(report.teams.red.damage + report.teams.blue.damage, 0);
});

test('a replaced routed guard rallies to a reserve slot without sharing the new front guard post', () => {
    const { scene, guard, replacement, oldSlot } = routedAndReplacedGuard();
    const reserve = guard.formationSlot;
    assert.notEqual(reserve, oldSlot);
    assert.ok(reserve.rank > 0, 'the routed guard is reassigned to the vacated reserve position');
    assert.equal(reserve.unit, guard);
    assert.equal(replacement.formationSlot, oldSlot);
    assert.equal(oldSlot.unit, replacement);
    assert.equal(guard.guardReady, false);
    assert.equal(guard.braceReady, false);
    assert.equal(replacement.guardReady, false, 'a moving replacement must prepare its new post');
    assert.equal(replacement.braceReady, false, 'cavalry brace must invalidate with guard posture');

    guard.morale = 60;
    guard.moraleState = 'wavering';
    scene.onMoraleStateChange(guard, 'routing', 'test: rallied behind the line');
    guard.gx = reserve.gx + 0.35;
    guard.gy = reserve.gy;
    guard.pgx = guard.gx;
    guard.pgy = guard.gy;
    const before = Math.hypot(guard.gx - reserve.gx, guard.gy - reserve.gy);
    advance(scene, 0.5);
    assert.ok(Math.hypot(guard.gx - reserve.gx, guard.gy - reserve.gy) < before,
        'the rallied soldier must move toward its reserve slot, not its former front post');
    assert.equal(guard.formationSlot, reserve);
    assert.equal(oldSlot.unit, replacement);
    const guards = living(scene, 'blue');
    assert.equal(new Set(guards.map(unit => unit.formationSlot)).size, guards.length);
    assert.ok(guards.every(unit => unit.formationSlot.unit === unit), 'every live slot has one matching owner');
});

test('turning toward an enemy behind and moving back into position clear guard and cavalry brace together', () => {
    for (const reason of ['enemy behind', 'moving back into position']) {
        const { scene, guard, sword } = preparedGuard();
        if (reason === 'enemy behind') placeRelative(sword, guard, -0.9);
        else {
            guard.gx += 0.3;
            guard.pgx = guard.gx;
        }
        scene.advanceBattle(STEP);
        if (reason === 'moving back into position') assert.equal(guard.moving, true);
        assert.equal(guard.guardReady, false, reason);
        assert.equal(guard.braceReady, false, reason);
    }
});

test('orders without their matching troop types fall back to advance without activating tactics', () => {
    for (const [red, blue, orders] of [
        [{ infantry: 3 }, { infantry: 3 }, { red: 'hold', blue: 'hold' }],
        [{ pikeman: 3 }, { archer: 3 }, { red: 'assault', blue: 'flank' }],
        [{ cavalry: 2 }, { cavalry: 2 }, { red: 'flank', blue: 'hold' }]
    ]) {
        const scene = makeScene();
        scene.deployUnits(red, blue, 'custom', 'custom', orders);
        assert.equal(scene.tactics, null);
        assert.equal(scene.getTacticsSummary(), null);
        assert.ok(scene.units.every(unit => unit.tacticalRole == null));
    }
});

test('a supported prepared front guard deflects swords before armor is deducted exactly once', () => {
    const { scene, guard, sword } = preparedGuard();
    placeRelative(sword, guard, 0.95);
    const deflection = scene.tactics.incomingMultiplier(sword, guard);
    assert.ok(deflection > 0 && deflection < 1, 'the formation reduces a frontal strike without making the guard invulnerable');
    const hp = guard.hp;
    const ordinary = calculateAttackDamage(sword, guard, { multiplier: deflection });
    assert.equal(resolveAttack(guard, sword), ordinary);
    assert.equal(guard.hp, hp - ordinary);
    const boosted = calculateAttackDamage(sword, guard, { rawAttack: 20, multiplier: 2 * deflection });
    assert.equal(resolveAttack(guard, sword, { rawAttack: 20, multiplier: 2 }), boosted,
        'combine attack and formation multipliers before the one armor deduction');
    assert.equal(guard.hp, hp - ordinary - boosted);
});

test('side rear close routing moving and replacement attacks receive no frontal deflection', () => {
    for (const condition of ['side', 'rear', 'close', 'routing', 'moving', 'replacement']) {
        const fixture = condition === 'replacement' ? routedAndReplacedGuard() : preparedGuard();
        const { scene, sword } = fixture;
        const guard = condition === 'replacement' ? fixture.replacement : fixture.guard;
        if (condition === 'routing') {
            guard.morale = 20;
            guard.moraleState = 'routing';
            scene.onMoraleStateChange(guard, 'steady', 'test: routing posture');
        }
        if (condition === 'moving') {
            guard.gx += 0.3;
            guard.pgx = guard.gx;
            scene.advanceBattle(STEP);
            assert.equal(guard.moving, true);
        }
        placeRelative(sword, guard, condition === 'rear' ? -0.95 : condition === 'close' ? 0.6 :
            condition === 'side' ? 0 : 0.95, condition === 'side' ? 0.95 : 0);
        const deflections = scene.tactics.metrics.deflections;
        assert.equal(scene.tactics.incomingMultiplier(sword, guard), 1, condition);
        assert.equal(resolveAttack(guard, sword), 8, `${condition}: 16 attack - 8 armor`);
        assert.equal(scene.tactics.metrics.deflections, deflections, `${condition} must not count as a deflection`);
    }
});

test('arrows and cavalry keep their ordinary damage against a prepared frontal guard', () => {
    for (const [type, multiplier, damage] of [['archer', 1, 18], ['cavalry', 1, 22], ['cavalry', 2, 52]]) {
        const { scene, guard } = preparedGuard();
        const attacker = addUnit(scene, 'red', type);
        placeRelative(attacker, guard, 0.95);
        const deflections = scene.tactics.metrics.deflections;
        assert.equal(scene.tactics.incomingMultiplier(attacker, guard), 1, type);
        assert.equal(resolveAttack(guard, attacker, { multiplier }), damage, `${type} × ${multiplier}`);
        assert.equal(scene.tactics.metrics.deflections, deflections);
    }
});
