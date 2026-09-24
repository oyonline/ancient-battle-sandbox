const test = require('node:test');
const assert = require('node:assert/strict');
const { makeScene, Terrain, snapshot, resolveAttack, calculateAttackDamage } = require('./battle-harness.js');

const STEP = 1000 / 60;
const distance = (a, b) => Math.hypot(a.gx - b.gx, a.gy - b.gy);
const army = { infantry: 8, pikeman: 4, archer: 4, cavalry: 4 };

function deploy(red = army, blue = army, orders = { blue: 'hold_ground' }, options = { terrain: 'blue_hill' }) {
    const scene = makeScene();
    scene.deployUnits(red, blue, 'custom', 'custom', orders, options);
    scene.battleStarted = true;
    return scene;
}

function run(scene, seconds) {
    for (let frame = 0; frame < Math.round(seconds * 60) && !scene.battleOver; frame++) scene.advanceBattle(STEP);
}

function guardStep(scene, unit, now = 2000) {
    scene.rebuildSpatial();
    unit.moveX = unit.moveY = 0;
    unit.moving = false;
    scene.planningStep = true;
    const handled = scene.tactics.updateGroundGuard(unit, now, 1 / 60);
    scene.planningStep = false;
    unit.gx += unit.moveX;
    unit.gy += unit.moveY;
    return handled;
}

test('hold_ground accepts every troop type and deploys archers on own summit behind infantry', () => {
    const scene = deploy();
    const defenders = scene.units.filter(unit => unit.team === 'blue');
    assert.ok(defenders.every(unit => unit.tacticalRole === 'ground_guard' && unit.guardAnchor));
    const archers = defenders.filter(unit => unit.type === 'archer');
    assert.ok(archers.every(unit => Terrain.height('blue_hill', unit.gx, unit.gy) > 2.9));
    const infantry = defenders.filter(unit => unit.type === 'infantry' || unit.type === 'pikeman');
    assert.ok(Math.max(...infantry.map(unit => unit.gx)) < Math.min(...archers.map(unit => unit.gx)));
    assert.equal(scene.getTacticsSummary().blue.label, '高地守位');
    assert.match(scene.getTacticsSummary().blue.stage, /山顶/);
    for (const type of ['infantry', 'pikeman', 'archer', 'cavalry']) {
        const single = deploy({ [type]: 1 }, { infantry: 1 }, { red: 'hold_ground' }, {});
        assert.equal(single.tactics.orders.red, 'hold_ground');
    }
});

test('guard deployment mirrors red and blue without occupying the enemy hill', () => {
    const red = deploy(army, army, { red: 'hold_ground' }, { terrain: 'red_hill' });
    const blue = deploy();
    const left = red.units.filter(unit => unit.team === 'red');
    const right = blue.units.filter(unit => unit.team === 'blue');
    left.forEach((unit, index) => {
        assert.ok(Math.abs(unit.gx + right[index].gx - 70) < 1e-9);
        assert.equal(unit.gy, right[index].gy);
    });
    const away = deploy(army, army, { red: 'hold_ground' }, { terrain: 'blue_hill' });
    assert.equal(away.tactics.groundGuards.red.cx, 20);
    assert.equal(away.tactics.groundGuards.red.onHill, false);
    assert.ok(away.units.filter(unit => unit.team === 'red').every(unit => unit.gx < 30));
});

test('guarding an empty army does not create a tactical order', () => {
    const scene = deploy({}, { infantry: 1 }, { red: 'hold_ground' }, {});
    assert.equal(scene.tactics, null);
});

test('maximum cavalry guard formations keep unique in-bounds mirrored anchors', () => {
    const scenes = ['red', 'blue'].map(team => deploy({ cavalry: 150 }, { cavalry: 150 },
        { [team]: 'hold_ground' }, { terrain: `${team}_hill` }));
    const sides = scenes.map((scene, index) => scene.units.filter(unit => unit.team === (index ? 'blue' : 'red')));
    for (const units of sides) {
        assert.equal(new Set(units.map(unit => `${unit.guardAnchor.gx},${unit.guardAnchor.gy}`)).size, 150);
        assert.ok(units.every(unit => unit.gx >= 2 && unit.gx <= 68 && unit.gy >= 2 && unit.gy <= 68));
    }
    sides[0].forEach((unit, index) => {
        assert.ok(Math.abs(unit.gx + sides[1][index].gx - 70) < 1e-9);
        assert.equal(unit.gy, sides[1][index].gy);
    });
});

test('thousand-unit mixed guards deploy without overlapping bodies and settle into stalemate', () => {
    const largeArmy = { infantry: 300, pikeman: 60, archer: 80, cavalry: 60 };
    const scene = deploy(largeArmy, largeArmy, { red: 'hold_ground', blue: 'hold_ground' }, {});
    const red = scene.units.filter(unit => unit.team === 'red');
    const blue = scene.units.filter(unit => unit.team === 'blue');
    for (let i = 0; i < red.length; i++) {
        assert.ok(Math.abs(red[i].gx + blue[i].gx - 70) < 1e-9);
        assert.equal(red[i].gy, blue[i].gy);
        for (let j = i + 1; j < red.length; j++) {
            assert.ok(distance(red[i], red[j]) >= 0.72, `${red[i].type}/${red[j].type} start with overlapping anchors`);
        }
    }
    run(scene, 12);
    assert.equal(scene.battleOver, true);
    assert.equal(scene.endReason, 'stalemate');
    assert.equal(scene.battleStats.red.damage + scene.battleStats.blue.damage, 0);
});

test('guard archers do not chase out-of-range enemies and shoot real arrows at incoming enemies', () => {
    const scene = deploy({ infantry: 1 }, { archer: 1 });
    const archer = scene.units.find(unit => unit.team === 'blue');
    const enemy = scene.units.find(unit => unit.team === 'red');
    const anchor = { ...archer.guardAnchor };
    for (let index = 0; index < 120; index++) guardStep(scene, archer);
    assert.equal(distance(archer, anchor), 0);
    Object.assign(enemy, { gx: archer.gx - 7, gy: archer.gy });
    scene.simulationTime = 2500;
    guardStep(scene, archer, 2500);
    assert.ok(scene.battleQueue.length > 0, 'the real delayed bow-release action must be queued');
    scene.simulationTime += 120;
    scene.flushBattleActions();
    assert.equal(scene.arrows.length, 1);
    assert.equal(distance(archer, anchor), 0);
});

test('guard archers retreat only within their anchor radius, then return after threat leaves', () => {
    const scene = deploy({ infantry: 1 }, { archer: 1 });
    const archer = scene.units.find(unit => unit.team === 'blue');
    const enemy = scene.units.find(unit => unit.team === 'red');
    for (let index = 0; index < 180; index++) {
        Object.assign(enemy, { gx: archer.gx - 2, gy: archer.gy });
        guardStep(scene, archer);
        assert.ok(distance(archer, archer.guardAnchor) <= 1.5 + 1e-9);
    }
    assert.ok(distance(archer, archer.guardAnchor) > 1);
    enemy.gx = 10;
    for (let index = 0; index < 90; index++) guardStep(scene, archer);
    assert.ok(distance(archer, archer.guardAnchor) <= 0.2);
});

test('infantry pursues only inside its guard radius and walks home when the enemy leaves', () => {
    const scene = deploy({ infantry: 1 }, { infantry: 1 });
    const guard = scene.units.find(unit => unit.team === 'blue');
    const enemy = scene.units.find(unit => unit.team === 'red');
    Object.assign(enemy, { gx: guard.gx - 3.5, gy: guard.gy });
    for (let index = 0; index < 60; index++) guardStep(scene, guard);
    assert.ok(distance(guard, guard.guardAnchor) > 1);
    assert.ok(distance(guard, guard.guardAnchor) < guard.guardRadius);
    enemy.gx = 10;
    for (let index = 0; index < 120; index++) guardStep(scene, guard);
    assert.ok(distance(guard, guard.guardAnchor) <= 0.2);
});

test('guarding does not add armor or prevent physical displacement beyond the anchor', () => {
    const scene = deploy({ infantry: 1 }, { infantry: 1 }, { blue: 'hold_ground' }, {});
    const guard = scene.units.find(unit => unit.team === 'blue');
    const enemy = scene.units.find(unit => unit.team === 'red');
    Object.assign(enemy, { gx: guard.gx - 0.8, gy: guard.gy });
    const before = guard.hp;
    resolveAttack(guard, enemy);
    assert.equal(before - guard.hp, calculateAttackDamage(enemy, guard));
    guard.gx = guard.guardAnchor.gx + 7;
    enemy.gx = 10;
    const displaced = guard.gx;
    guardStep(scene, guard);
    assert.ok(guard.gx < displaced && guard.gx > displaced - 0.1, 'return is walking, not snapping into the circle');
});

test('auto cavalry stays local and starts counterattack only when enemies enter its guard area', () => {
    const scene = deploy({ infantry: 1 }, { cavalry: 1 });
    const cavalry = scene.units.find(unit => unit.team === 'blue');
    const enemy = scene.units.find(unit => unit.team === 'red');
    for (let index = 0; index < 60; index++) guardStep(scene, cavalry);
    assert.equal(distance(cavalry, cavalry.guardAnchor), 0);
    assert.equal(cavalry.groundGuardTarget, null);
    Object.assign(enemy, { gx: cavalry.gx - 5, gy: cavalry.gy });
    guardStep(scene, cavalry, 4000);
    assert.equal(cavalry.state, 'charge', 'idle guard cavalry must begin a real countercharge, not spend its runway walking in melee');
    for (let index = 0; index < 120; index++) guardStep(scene, cavalry, 4000 + index * STEP);
    assert.equal(cavalry.groundGuardTarget, enemy);
    assert.ok(distance(cavalry, cavalry.guardAnchor) > 1);
    assert.ok(distance(cavalry, cavalry.guardAnchor) <= 6 + 1e-9);
    enemy.gx = 10;
    for (let index = 0; index < 240; index++) guardStep(scene, cavalry);
    assert.ok(distance(cavalry, cavalry.guardAnchor) <= 0.2);
});

test('explicit cavalry orders bypass ground guard without releasing the infantry', () => {
    for (const order of ['direct', 'flank_archers']) {
        const scene = deploy({ infantry: 1 }, { cavalry: 1, infantry: 1 }, { blue: 'hold_ground' },
            { terrain: 'blue_hill', cavalryOrders: { blue: order } });
        const cavalry = scene.units.find(unit => unit.type === 'cavalry');
        const infantry = scene.units.find(unit => unit.team === 'blue' && unit.type === 'infantry');
        assert.equal(guardStep(scene, cavalry), false);
        assert.equal(guardStep(scene, infantry), true);
        assert.equal(scene.getBattleReport().cavalryOrders.blue, order);
    }
});

test('cavalry pierce movement stops at the guard radius without teleporting', () => {
    const scene = deploy({ infantry: 1 }, { cavalry: 1 });
    const cavalry = scene.units.find(unit => unit.team === 'blue');
    const enemy = scene.units.find(unit => unit.team === 'red');
    Object.assign(cavalry, { gx: cavalry.guardAnchor.gx + 5.99, state: 'pierce', stateTime: 0,
        pierceX: cavalry.guardAnchor.gx + 12, pierceY: cavalry.gy, pierceHits: new Set(), chargeMomentum: 1 });
    Object.assign(enemy, { gx: cavalry.guardAnchor.gx + 5.5, gy: cavalry.gy + 0.5 });
    guardStep(scene, cavalry, 4000);
    assert.ok(distance(cavalry, cavalry.guardAnchor) <= 6 + 1e-9);
    assert.ok(distance(cavalry, cavalry.guardAnchor) >= 5.99);
    assert.equal(cavalry.state, 'melee');
});

test('routing and morale fallback retain precedence over the guard command', () => {
    const scene = deploy({ infantry: 1 }, { infantry: 1, cavalry: 1 });
    const guards = scene.units.filter(unit => unit.team === 'blue');
    guards[0].moraleState = 'routing';
    const seen = [];
    scene.updateRoutedUnit = unit => seen.push(`route-${unit.id}`);
    scene.updateFallingBackUnit = unit => {
        if (unit === guards[1]) { seen.push(`fallback-${unit.id}`); return true; }
        return false;
    };
    const update = scene.tactics.updateGroundGuard.bind(scene.tactics);
    scene.tactics.updateGroundGuard = (unit, now, dt) => { seen.push(`guard-${unit.id}`); return update(unit, now, dt); };
    scene.advanceBattle(STEP);
    assert.ok(seen.includes(`route-${guards[0].id}`));
    assert.ok(seen.includes(`fallback-${guards[1].id}`));
    assert.ok(!seen.includes(`guard-${guards[0].id}`));
    assert.ok(!seen.includes(`guard-${guards[1].id}`));
});

test('cavalry options are copied, normalized and reset on redeployment along with guard anchors', () => {
    const options = { cavalryOrders: { red: 'direct', blue: 'invalid' } };
    const scene = deploy(army, army, { blue: 'hold_ground' }, options);
    options.cavalryOrders.red = 'flank_archers';
    assert.deepEqual(snapshot(scene.battleOptions.cavalryOrders), { red: 'direct', blue: 'auto' });
    let resets = 0;
    scene.unitInspector = { reset() { resets++; } };
    scene.deployUnits(army, army, 'custom', 'custom');
    assert.equal(resets, 1);
    assert.equal(scene.tactics, null);
    assert.ok(scene.units.every(unit => !unit.guardAnchor));
    assert.deepEqual(snapshot(scene.battleOptions.cavalryOrders), { red: 'auto', blue: 'auto' });
});

test('reports copy the effective army orders and reflect deathmatch guard release', () => {
    const scene = deploy(army, army, { red: 'invalid', blue: 'hold_ground' });
    const report = scene.getBattleReport();
    assert.deepEqual(snapshot(report.orders), { red: 'advance', blue: 'hold_ground' });
    scene.tactics.breakStalemate();
    assert.deepEqual(snapshot(report.orders), { red: 'advance', blue: 'hold_ground' }, 'previous reports are immutable snapshots');
    assert.deepEqual(snapshot(scene.getBattleReport().orders), { red: 'advance', blue: 'advance' });
});

test('two mixed armies holding their ground resolve as stalemate instead of waiting forever', () => {
    const scene = deploy(army, army, { red: 'hold_ground', blue: 'hold_ground' }, {});
    run(scene, 20);
    assert.equal(scene.battleOver, true);
    assert.equal(scene.winner, 'draw');
    assert.equal(scene.endReason, 'stalemate');
});

test('deathmatch releases both ground guards after stalemate and proceeds to combat', () => {
    const scene = deploy({ infantry: 1 }, { infantry: 1 }, { red: 'hold_ground', blue: 'hold_ground' }, { deathmatch: true });
    run(scene, 11);
    assert.equal(scene.battleOver, false);
    assert.deepEqual(snapshot(scene.tactics.orders), { red: 'advance', blue: 'advance' });
    assert.ok(scene.units.every(unit => !unit.guardAnchor));
    run(scene, 90);
    assert.equal(scene.battleOver, true);
    assert.ok(scene.battleStats.red.damage + scene.battleStats.blue.damage > 0);
});
