const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { context, makeScene, addUnit, calculateAttackDamage } = require('./battle-harness.js');
const CombatRules = vm.runInContext('CombatRules', context);
const knockback = vm.runInContext('knockback', context);

const STEP = 1000 / 60;

function place(unit, gx, gy) {
    Object.assign(unit, { gx, gy, pgx: gx, pgy: gy, velX: 0, velY: 0, moveX: 0, moveY: 0,
        pushX: 0, pushY: 0, moving: false, lastAttack: -Infinity });
}

function duel(order, distance = 0.9) {
    const scene = makeScene();
    scene.deployUnits({ infantry: 1 }, { infantry: 1 }, 'custom', 'custom', { red: order, blue: 'advance' });
    const source = scene.units.find(unit => unit.team === 'red');
    const target = scene.units.find(unit => unit.team === 'blue');
    // Deployment and command formation layouts are deliberately excluded from this comparison.
    place(source, 30, 30);
    place(target, 30 + distance, 30);
    scene.battleStarted = true;
    scene.rebuildSpatial();
    return { scene, source, target };
}

function decide({ scene, source }, now = 1) {
    scene.simulationTime = now;
    scene.rebuildSpatial();
    scene.planningStep = true;
    source.moveX = source.moveY = source.pushX = source.pushY = 0;
    source.moving = false;
    if (!scene.tactics?.updateUnit(source, now, STEP / 1000)) {
        scene.updateNormalUnit(source, now, STEP / 1000);
    }
    scene.planningStep = false;
}

function landSwing({ scene }, startedAt = 1) {
    scene.simulationTime = startedAt + 95;
    scene.rebuildSpatial();
    scene.flushBattleActions();
}

function route(scene, unit) {
    const previous = unit.moraleState;
    unit.morale = 20;
    unit.moraleState = 'routing';
    scene.onMoraleStateChange(unit, previous, 'test: routing during ordinary contact');
}

function actors(scene) {
    return Array.from(scene.units, unit => ({
        id: unit.id, x: unit.gx, y: unit.gy, hp: unit.hp, moving: unit.moving,
        lastAttack: unit.lastAttack, morale: unit.morale, moraleState: unit.moraleState
    }));
}

test('advance and assault have identical ordinary contact at the same positions and target', () => {
    const normal = duel('advance', 3);
    const ordered = duel('assault', 3);
    for (let frame = 0; frame < 180; frame++) {
        normal.scene.advanceBattle(STEP);
        ordered.scene.advanceBattle(STEP);
        assert.deepEqual(actors(normal.scene), actors(ordered.scene), `different command physics at step ${frame}`);
        for (const team of ['red', 'blue']) {
            assert.equal(normal.scene.battleStats[team].damage, ordered.scene.battleStats[team].damage);
        }
    }
    assert.ok(normal.target.hp < normal.target.maxHp, 'the comparison must include actual melee hits');
});

test('ordinary body blocking and separation depend on troop bodies rather than the active order', () => {
    for (const blockerType of ['infantry', 'cavalry']) {
        function observe(order, blocked) {
            const fixture = duel(order, 6);
            const { scene, source } = fixture;
            const blocker = blocked ? addUnit(scene, 'red', blockerType, 30.5, 30.1) : null;
            decide(fixture);
            const movement = { x: source.moveX, y: source.moveY };
            if (!blocker) return { movement };
            const before = Math.hypot(source.gx - blocker.gx, source.gy - blocker.gy);
            scene.rebuildSpatial();
            scene.separate(STEP / 1000);
            const after = Math.hypot(source.gx - blocker.gx, source.gy - blocker.gy);
            assert.ok(after > before, `${blockerType}: overlapping bodies must separate`);
            return { movement, positions: actors(scene).map(({ id, x, y }) => ({ id, x, y })) };
        }
        const open = observe('advance', false);
        const normal = observe('advance', true);
        const ordered = observe('assault', true);
        assert.ok(normal.movement.x < open.movement.x, `${blockerType}: a body ahead must slow forward motion`);
        assert.deepEqual(normal, ordered, `${blockerType}: enabling an order must not change collision rules`);
    }
});

test('spear stagger slows ordinary walking for both orders and expires on the simulation clock', () => {
    function displacement(order, until, now) {
        const fixture = duel(order, 6);
        fixture.source.spearSlowUntil = until;
        decide(fixture, now);
        return Math.hypot(fixture.source.moveX, fixture.source.moveY);
    }
    for (const order of ['advance', 'assault']) {
        const ordinary = displacement(order, 0, 100);
        const slowed = displacement(order, 500, 100);
        const expired = displacement(order, 500, 600);
        assert.ok(slowed > 0 && slowed < ordinary, `${order}: stagger must slow rather than freeze ordinary walking`);
        assert.equal(expired, ordinary, `${order}: expired stagger must restore normal movement`);
        assert.equal(slowed, displacement(order === 'advance' ? 'assault' : 'advance', 500, 100));
    }
});

test('both ordinary melee paths use the same narrow reach tolerance when a queued swing lands', () => {
    for (const order of ['advance', 'assault']) {
        for (const [extra, shouldHit] of [[0.11, true], [0.13, false]]) {
            const fixture = duel(order);
            const { scene, source, target } = fixture;
            decide(fixture);
            assert.equal(scene.battleQueue.length, 1, `${order}: fixture must start a real queued attack`);
            target.gx = source.gx + source.typeData.range + extra;
            const hp = target.hp;
            landSwing(fixture);
            assert.equal(target.hp, hp - (shouldHit ? calculateAttackDamage(source, target) : 0),
                `${order}: reach + ${extra} must ${shouldHit ? 'hit' : 'miss'}`);
        }
    }
});

test('both ordinary melee paths respect bodies in the weapon lane at windup and at impact', () => {
    for (const order of ['advance', 'assault']) {
        {
            const fixture = duel(order);
            const { scene, target } = fixture;
            const blocker = addUnit(scene, 'red', 'infantry', 30.45, 32);
            decide(fixture);
            assert.equal(scene.battleQueue.length, 1);
            blocker.gy = 30;
            landSwing(fixture);
            assert.equal(target.hp, target.maxHp, `${order}: a new intervening body must block the queued strike`);
        }
        {
            const fixture = duel(order);
            const { scene, source, target } = fixture;
            const blocker = addUnit(scene, 'red', 'infantry', 30.45, 30);
            decide(fixture);
            assert.equal(scene.battleQueue.length, 0, `${order}: the attacker must not swing through its ally`);
            blocker.gy = 32;
            decide(fixture, 2);
            assert.equal(scene.battleQueue.length, 1, `${order}: removing the obstacle must allow a new swing`);
            landSwing(fixture, 2);
            assert.equal(target.hp, target.maxHp - calculateAttackDamage(source, target));
        }
    }
});

test('routing attackers cannot strike while routing targets remain hittable before and after windup', () => {
    for (const order of ['advance', 'assault']) {
        for (const who of ['source', 'target']) {
            for (const when of ['before', 'after']) {
                const fixture = duel(order);
                const { scene, source, target } = fixture;
                if (when === 'before') route(scene, fixture[who]);
                decide(fixture);
                if (when === 'after') {
                    assert.equal(scene.battleQueue.length, 1, `${order}: attack must be queued before routing`);
                    route(scene, fixture[who]);
                }
                landSwing(fixture);
                const damage = who === 'target' ? calculateAttackDamage(source, target) : 0;
                assert.equal(target.hp, target.maxHp - damage, `${order}: ${who} routing ${when} windup`);
                assert.equal(scene.battleStats.red.damage, damage);
            }
        }
    }
});

test('ordinary and guard pikes can thrust past exactly one willing aligned pike but no other intervening body', () => {
    function facing(unit, kind, x = 1, y = 0) {
        unit.braceFacingX = kind === 'guard' ? -x : x;
        unit.braceFacingY = kind === 'guard' ? -y : y;
        if (kind === 'guard') {
            unit.tacticalRole = 'guard';
            unit.guardReady = true;
            unit.guardFacingX = x;
            unit.guardFacingY = y;
        }
    }
    for (const attackerKind of ['ordinary', 'guard']) {
        for (const supportKind of ['ordinary', 'guard']) {
            for (const condition of ['one aligned pike', 'two pikes', 'routing pike', 'side-facing pike', 'sword']) {
                const scene = makeScene();
                const source = addUnit(scene, 'red', 'pikeman', 30, 30);
                const target = addUnit(scene, 'blue', 'infantry', 31.3, 30);
                const support = addUnit(scene, 'red', condition === 'sword' ? 'infantry' : 'pikeman', 30.65, 30);
                source.lastAttack = -Infinity;
                facing(source, attackerKind);
                facing(support, supportKind, condition === 'side-facing pike' ? 0 : 1,
                    condition === 'side-facing pike' ? 1 : 0);
                if (condition === 'two pikes') {
                    support.gx = 30.43;
                    const second = addUnit(scene, 'red', 'pikeman', 30.86, 30);
                    facing(second, supportKind);
                }
                if (condition === 'routing pike') route(scene, support);
                scene.rebuildSpatial();
                const permitted = condition === 'one aligned pike';
                const label = `${attackerKind} attacker / ${supportKind} support / ${condition}`;
                assert.equal(CombatRules.clearLane(scene, source, target), permitted, label);
                CombatRules.attack(scene, source, target, 1);
                assert.equal(scene.battleQueue.length, permitted ? 1 : 0, label);
                landSwing({ scene });
                assert.equal(target.hp, target.maxHp - (permitted ? calculateAttackDamage(source, target) : 0), label);
            }
        }
    }
});

function overlappingPikes(y = 30) {
    const scene = makeScene();
    const spear = addUnit(scene, 'blue', 'pikeman', 31.4, y);
    const supports = [0.3, 1.2].map(offset => addUnit(scene, 'blue', 'pikeman', 31.4, y + offset));
    // The real charge makes the pikes hold their ground while their overlapping
    // bodies separate. It cannot reach them during the half-second preparation.
    const cavalry = addUnit(scene, 'red', 'cavalry', 25.5, y);
    return { scene, spear, supports, cavalry };
}

function prepareOverlappingPikes(fixture) {
    for (let frame = 0; frame < 30; frame++) fixture.scene.advanceBattle(STEP);
    assert.equal(fixture.spear.braceReady, true, 'supported pikes must finish their half-second preparation');
    assert.equal(fixture.spear.moving, false);
}

test('real body separation does not restart a stationary supported pike’s half-second preparation', () => {
    for (const y of [30, 0.61]) {
        const fixture = overlappingPikes(y);
        const { scene, spear, supports } = fixture;
        let displaced = false;
        for (let frame = 0; frame < 30; frame++) {
            const previousY = spear.gy;
            scene.advanceBattle(STEP);
            displaced ||= Math.abs(spear.gy - previousY) > 0.001;
            assert.equal(spear.moving, false, 'the fixture must hold rather than actively walk');
            assert.equal(spear.hp, spear.maxHp, 'charge impact must not interfere with preparation');
            if (frame < 29) assert.equal(spear.braceReady, false, 'separation must not skip the preparation delay');
        }
        assert.ok(displaced, 'the real solver must actually move the overlapping pike');
        assert.ok(Math.hypot(spear.gx - supports[0].gx, spear.gy - supports[0].gy) > 0.3);
        assert.equal(spear.braceReady, true, `separation at y=${y} must not postpone preparation`);
        if (y < 1) assert.ok(Math.abs(spear.gy - 0.6) < 1e-9,
            'the boundary case must exercise a clamped correction');
    }
});

test('real queued knockback still interrupts a braced pike even when it is not actively moving', () => {
    const fixture = overlappingPikes();
    const { scene, spear, cavalry } = fixture;
    prepareOverlappingPikes(fixture);
    const before = spear.gx;
    scene.scheduleBattleAction(0, () => knockback(spear, cavalry, 0.2));
    scene.advanceBattle(STEP);
    assert.ok(spear.gx > before + 0.1, 'the real queued push must displace the pike');
    assert.equal(spear.moving, false, 'knockback is external displacement, not a walking order');
    scene.advanceBattle(STEP);
    assert.equal(spear.braceReady, false, 'the next snapshot must recognize the external displacement');
    assert.equal(spear.braceTime, 0);
});

test('body separation cannot preserve brace after support is lost or the pike routs', () => {
    for (const condition of ['support leaves', 'support routs', 'pike routs']) {
        const fixture = overlappingPikes();
        const { scene, spear, supports } = fixture;
        prepareOverlappingPikes(fixture);
        if (condition === 'support leaves') supports[0].gx += 5;
        else route(scene, condition === 'support routs' ? supports[0] : spear);
        scene.advanceBattle(STEP);
        assert.equal(spear.braceReady, false, condition);
        assert.equal(spear.braceTime, 0, condition);
        assert.ok(spear.braceSupport < 2, condition);
    }
});
