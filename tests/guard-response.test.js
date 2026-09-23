const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { context, makeScene, addUnit, snapshot } = require('./battle-harness.js');
const knockback = vm.runInContext('knockback', context);
const STEP = 1000 / 60;

function advance(scene, seconds, inspect) {
    for (let i = 0; i < seconds * 60 && !scene.battleOver; i++) {
        scene.advanceBattle(STEP);
        if (inspect) inspect();
    }
}

function isolated(rank = 0, mirrored = false, stationary = false) {
    const scene = makeScene(), defending = mirrored ? 'red' : 'blue';
    scene.deployUnits(mirrored ? { pikeman: 25 } : { infantry: 1 },
        mirrored ? { infantry: 1 } : { pikeman: 25 }, 'square', 'square', { [defending]: 'hold' });
    const guard = scene.units.find(unit => unit.team === defending && unit.formationSlot.rank === rank &&
        unit.formationSlot.faceX === (mirrored ? 1 : -1) && Math.abs(unit.gy - 35) < 0.01);
    const enemy = scene.units.find(unit => unit.team !== defending);
    scene.units = [guard, enemy];
    scene.tactics.formations[defending].members = [guard];
    scene.tactics.formations[defending].slots = [guard.formationSlot];
    if (stationary) enemy.typeData = { ...enemy.typeData, speed: 0, atkSpeed: Infinity };
    scene.battleStarted = true;
    return { scene, guard, enemy };
}

function place(unit, gx, gy) { Object.assign(unit, { gx, gy, pgx: gx, pgy: gy }); }

test('a sword at ninety degrees receives a real counterattack after finite guard turning', () => {
    const { scene, guard, enemy } = isolated();
    place(enemy, guard.gx, guard.gy + 0.95);
    const original = { x: guard.guardFacingX, y: guard.guardFacingY };
    scene.advanceBattle(STEP);
    const angle = Math.acos(Math.max(-1, Math.min(1, original.x * guard.guardFacingX + original.y * guard.guardFacingY)));
    assert.ok(angle > 0 && angle <= 2.6 / 60 + 1e-8, 'turning has a finite angular speed');
    assert.equal(guard.guardReady, false);
    assert.equal(guard.braceReady, false);
    advance(scene, 4);
    assert.ok(enemy.hp < enemy.typeData.hp, 'the guard must answer side attacks instead of standing through every hit');
    assert.ok(guard.hp < guard.typeData.hp, 'reaction is not an invulnerability bonus');
    assert.ok(guard.guardFacingY > 0.9);
});

test('an inner-rank pike can hit at its ordinary 1.35 range through an unobstructed lane', () => {
    const { scene, guard, enemy } = isolated(2, false, true);
    place(enemy, guard.gx - 1.2, guard.gy);
    advance(scene, 0.3);
    assert.equal(enemy.hp, 92, 'an inner rank uses its real basic weapon range, not an extra 1.05 restriction');
    assert.equal(guard.formationSlot.rank, 2);
    assert.equal(guard.typeData.range, 1.35);
});

test('guards take physical steps within their post, drop prepared bonuses, and return when the threat leaves', () => {
    const { scene, guard, enemy } = isolated(0, false, true);
    const slot = guard.formationSlot;
    place(enemy, guard.gx, guard.gy + 1.75);
    let moved = false;
    advance(scene, 1.5, () => {
        const offset = Math.hypot(guard.gx - slot.gx, guard.gy - slot.gy);
        assert.ok(offset <= 0.81, 'the guard must not pursue beyond its local post');
        if (guard.moving) {
            moved = true;
            assert.equal(guard.guardReady, false);
            assert.equal(guard.braceReady, false);
            assert.equal(guard.guardStableTime, 0);
        }
    });
    assert.equal(moved, true, 'local defense includes real movement');
    assert.ok(scene.getTacticsSummary()[guard.team].engaging > 0);
    place(enemy, 20, 15);
    advance(scene, 2);
    assert.ok(Math.hypot(guard.gx - slot.gx, guard.gy - slot.gy) < 0.21);
    assert.equal(guard.formationSlot, slot);
    assert.equal(slot.unit, guard);
    assert.equal(scene.getTacticsSummary()[guard.team].engaging, 0);
});

test('nearby active support allows a stationary guard to rearm at a real local post without returning to its exact original dot', () => {
    const { scene, guard, enemy } = isolated(0, false, true);
    const formation = scene.tactics.formations[guard.team], slot = guard.formationSlot;
    place(guard, slot.gx - 0.55, slot.gy);
    place(enemy, guard.gx - 2, guard.gy);
    for (const lane of [-0.85, 0.85]) {
        const other = addUnit(scene, guard.team, 'pikeman', guard.gx, guard.gy + lane);
        const otherSlot = { ...slot, gx: other.gx, gy: other.gy, unit: other };
        Object.assign(other, { tacticalRole: 'guard', formationSlot: otherSlot,
            guardFacingX: -1, guardFacingY: 0, guardStableTime: 0, guardReady: false });
        formation.members.push(other); formation.slots.push(otherSlot);
    }
    advance(scene, 0.8);
    assert.ok(Math.hypot(guard.gx - slot.gx, guard.gy - slot.gy) > 0.4, 'the local post is genuinely offset');
    assert.equal(guard.guardReady, true);
    assert.equal(guard.braceReady, true);
});

test('mixed-facing active neighbors support the formation without allowing a spear through a sideways body', () => {
    const { scene, guard, enemy } = isolated(0, false, true);
    const formation = scene.tactics.formations[guard.team];
    place(enemy, guard.gx - 2, guard.gy);
    const neighbors = [];
    for (const lane of [-0.85, 0.85]) {
        const other = addUnit(scene, guard.team, 'pikeman', guard.gx, guard.gy + lane);
        const slot = { ...guard.formationSlot, gx: other.gx, gy: other.gy, faceX: 0,
            faceY: Math.sign(lane), unit: other };
        Object.assign(other, { tacticalRole: 'guard', formationSlot: slot, guardFacingX: 0,
            guardFacingY: Math.sign(lane), guardStableTime: 0, guardReady: false });
        formation.members.push(other); formation.slots.push(slot); neighbors.push(other);
    }
    advance(scene, 0.8);
    assert.equal(guard.guardReady, true, 'formation support does not require all neighbors to aim in the same direction');
    assert.ok(guard.guardSupport >= 2);
    place(neighbors[0], guard.gx - 0.85, guard.gy);
    Object.assign(neighbors[0], { guardFacingX: 0, guardFacingY: -1 });
    scene.rebuildSpatial();
    assert.equal(scene.tactics.clearLane(guard, enemy, true), false,
        'physical formation support is distinct from permission to attack through a friendly body');
});

test('real knockback immediately drops the guard posture even when it stays inside the local post', () => {
    const scene = makeScene();
    scene.deployUnits({ infantry: 1 }, { pikeman: 25 }, 'square', 'square', { blue: 'hold' });
    scene.battleStarted = true;
    advance(scene, 0.8);
    const guard = scene.units.find(unit => unit.team === 'blue' && unit.formationSlot.faceX === -1 &&
        unit.formationSlot.rank === 0 && Math.abs(unit.gy - 35) < 0.01);
    assert.equal(guard.guardReady, true);
    knockback(guard, { gx: guard.gx - 2, gy: guard.gy }, 0.42);
    assert.equal(guard.guardReady, false, 'the impact immediately removes the defensive bonus');
    assert.equal(guard.braceReady, false);
    scene.rebuildSpatial();
    scene.tactics.beginStep(1 / 60);
    assert.equal(guard.guardReady, false, 'the next frame cannot preserve the old prepared timer');
    assert.ok(guard.guardStableTime < 0.65);
});

test('body-only position correction does not repeatedly restart a supported guard posture', () => {
    const scene = makeScene();
    scene.deployUnits({ infantry: 1 }, { pikeman: 25 }, 'square', 'square', { blue: 'hold' });
    scene.battleStarted = true;
    advance(scene, 0.8);
    const guard = scene.units.find(unit => unit.team === 'blue' && unit.formationSlot.faceX === -1 &&
        unit.formationSlot.rank === 0 && Math.abs(unit.gy - 35) < 0.01);
    assert.equal(guard.guardReady, true);
    Object.assign(guard, { velX: 0.2, velY: 0, separateX: 0.2 / 60, separateY: 0, moving: false });
    scene.rebuildSpatial();
    scene.tactics.beginStep(1 / 60);
    assert.equal(guard.guardReady, true, 'subtract body correction before deciding the guard was truly displaced');
    Object.assign(guard, { separateX: 0 });
    scene.tactics.beginStep(1 / 60);
    assert.equal(guard.guardReady, false, 'the same velocity without body correction is real motion');
});

test('a guard cannot stab through two friendly pikes even while trying to find a local lane', () => {
    const { scene, guard, enemy } = isolated(2, false, true);
    place(enemy, guard.gx - 1.25, guard.gy);
    for (const distance of [0.4, 0.8]) {
        const friend = addUnit(scene, guard.team, 'pikeman', guard.gx - distance, guard.gy);
        friend.braceFacingX = -1; friend.braceFacingY = 0;
    }
    scene.rebuildSpatial();
    scene.tactics.beginStep(1 / 60);
    scene.tactics.updateGuard(guard, 1000, 1 / 60);
    assert.equal(scene.battleQueue.length, 0, 'blocked support cannot queue an attack through both bodies');
});

test('half-turn and local side response mirror exactly when teams exchange sides', () => {
    for (const placement of ['side', 'rear']) {
        const a = isolated(0, false, true), b = isolated(0, true, true);
        for (const fixture of [a, b]) {
            const sign = fixture.guard.team === 'red' ? -1 : 1;
            place(fixture.enemy, fixture.guard.gx + (placement === 'rear' ? sign * 1.7 : 0),
                fixture.guard.gy + (placement === 'side' ? 1.7 : 0));
        }
        for (let i = 0; i < 240; i++) {
            a.scene.advanceBattle(STEP); b.scene.advanceBattle(STEP);
            assert.ok(Math.abs(a.guard.gx + b.guard.gx - 70) < 1e-7);
            assert.ok(Math.abs(a.guard.gy - b.guard.gy) < 1e-7);
            assert.ok(Math.abs(a.guard.guardFacingX + b.guard.guardFacingX) < 1e-7);
            assert.ok(Math.abs(a.guard.guardFacingY - b.guard.guardFacingY) < 1e-7);
            assert.equal(a.enemy.hp, b.enemy.hp);
        }
    }
});

test('local guard response is identical at 1x and 2x simulation speed', () => {
    const run = speed => {
        const { scene, guard, enemy } = isolated(0, false, true);
        place(enemy, guard.gx, guard.gy + 1.7);
        scene.setSpeed(speed);
        advance(scene, 4 / speed);
        return snapshot({ gx: guard.gx, gy: guard.gy, fx: guard.guardFacingX, fy: guard.guardFacingY,
            hp: enemy.hp, time: scene.simulationTime });
    };
    assert.deepEqual(run(1), run(2));
});

test('distant opponents do not drag a double-hold formation from its posts or prevent its normal ten-second draw', () => {
    const scene = makeScene();
    scene.deployUnits({ pikeman: 9 }, { pikeman: 9 }, 'square', 'square', { red: 'hold', blue: 'hold' });
    scene.battleStarted = true;
    advance(scene, 10.3);
    assert.equal(scene.winner, 'draw');
    assert.equal(scene.endReason, 'stalemate');
    assert.ok(scene.units.every(unit => Math.hypot(unit.gx - unit.formationSlot.gx, unit.gy - unit.formationSlot.gy) < 0.01));
    assert.equal(scene.getTacticsSummary().red.engaging, 0);
});
