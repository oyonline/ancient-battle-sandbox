const test = require('node:test');
const assert = require('node:assert/strict');
const { makeScene, Terrain } = require('./battle-harness.js');

const STEP = 1000 / 60;
const army = { infantry: 36, pikeman: 12, archer: 16, cavalry: 12 };
const dist = (a, b) => Math.hypot(a.gx - b.gx, a.gy - b.gy);

function deploy(team = 'blue') {
    const scene = makeScene();
    scene.deployUnits(army, army, 'custom', 'custom', { [team]: 'hold_ground' }, {
        terrain: `${team}_pass`, cavalryOrders: { [team]: 'auto' }
    });
    return scene;
}

function guardStep(scene, units, now) {
    scene.simulationTime = now;
    scene.rebuildSpatial();
    for (const unit of scene.units) { unit.moveX = 0; unit.moveY = 0; unit.moving = false; }
    scene.planningStep = true;
    for (const unit of units) if (!unit.dead) scene.tactics.updateGroundGuard(unit, now, 1 / 60);
    scene.planningStep = false;
    for (const unit of scene.units) { unit.gx += unit.moveX; unit.gy += unit.moveY; }
}

test('charging raid cavalry is intercepted head-on at a predicted meeting point', () => {
    const scene = deploy();
    const guards = scene.units.filter(u => u.team === 'blue' && u.type === 'cavalry');
    const raiders = scene.units.filter(u => u.team === 'red' && u.type === 'cavalry');
    raiders.forEach((u, i) => Object.assign(u, {
        gx: 38 - Math.floor(i / 6) * 0.9, gy: 34 + (i % 6) * 0.9, state: 'charge', chargeDX: 1, chargeDY: 0,
        chargeDistance: 3, chargeMomentum: 1, lastRetarget: scene.simulationTime
    }));
    scene.rebuildSpatial();
    const threats = scene.tactics.passArcherThreats('blue');
    assert.equal(threats.filter(e => e.enemy.type === 'cavalry').length, raiders.length,
        'a charge aimed at the archer platform must enter the threat table beyond the old 4.2-grid radius');
    for (let step = 0; step < 30; step++) {
        for (const u of scene.units) { u.velX = 6; u.velY = 0; }
        guardStep(scene, guards, step * STEP);
    }
    assert.ok(guards.every(u => u.guardIntercept), 'every guard rides for the predicted meeting point');
    assert.ok(guards.every(u => u.state === 'charge'), 'guards counter-charge instead of waiting at their posts');
    assert.ok(guards.every(u => u.gx < u.guardAnchor.gx - 0.5), 'guards leave their posts toward the incoming charge');
});

test('distant approaching cavalry is a proactive threat and direction filters it out when receding', () => {
    const scene = deploy();
    const raiders = scene.units.filter(u => u.team === 'red' && u.type === 'cavalry');
    raiders.forEach((u, i) => Object.assign(u, { gx: 43, gy: 33 + i * 0.8, state: 'melee' }));
    scene.rebuildSpatial();
    for (const u of scene.units) { u.velX = 4; u.velY = 0; }
    let threats = scene.tactics.passArcherThreats('blue');
    assert.equal(threats.filter(e => e.enemy.type === 'cavalry').length, raiders.length,
        'cavalry ~8 grids out and closing must be marked without waiting for contact');
    for (const u of scene.units) { u.velX = -4; u.velY = 0; }
    scene.simulationTime += 700; // 越过 600ms 威胁粘滞窗口
    threats = scene.tactics.passArcherThreats('blue');
    assert.equal(threats.filter(e => e.enemy.type === 'cavalry').length, 0,
        'receding cavalry must drop out of the proactive threat table');
});

test('wing threats are answered by their own wing and crossing needs an emptied wing', () => {
    const scene = deploy();
    const guards = scene.units.filter(u => u.team === 'blue' && u.type === 'cavalry');
    const raiders = scene.units.filter(u => u.team === 'red' && u.type === 'cavalry');
    raiders.slice(0, 4).forEach((u, i) => Object.assign(u, { gx: 46, gy: 26 + i * 0.8, velX: 4, velY: 0 }));
    raiders.slice(4).forEach((u, i) => Object.assign(u, { gx: 46, gy: 44 + i * 0.8, velX: 4, velY: 0 }));
    scene.rebuildSpatial();
    const group = scene.tactics.groundGuards.blue;
    const upper = guards.filter(u => u.guardAnchor.gy < group.cy);
    const lower = guards.filter(u => u.guardAnchor.gy > group.cy);
    for (const guard of upper) {
        const target = scene.tactics.groundThreat(guard);
        assert.ok(target && target.gy < group.cy - 4, 'upper-wing guards must take the upper-wing threat');
    }
    for (const guard of lower) {
        const target = scene.tactics.groundThreat(guard);
        assert.ok(target && target.gy > group.cy + 4, 'lower-wing guards must take the lower-wing threat');
    }
    assert.equal(scene.tactics.wingAllows(lower[0], group, raiders[0]), false,
        'crossing to the far wing is forbidden while that wing still has cavalry');
    for (const guard of upper) guard.dead = true;
    scene.simulationTime += 200;
    scene.tactics.passArcherThreats('blue');
    assert.equal(scene.tactics.wingAllows(lower[0], group, raiders[0]), true,
        'an emptied wing may be covered from across the line');
});

test('a guard keeps charging through the 350ms pursuit grace and then returns to post', () => {
    const scene = deploy();
    const cav = scene.units.find(u => u.team === 'blue' && u.type === 'cavalry');
    const enemy = scene.units.find(u => u.team === 'red' && u.type === 'cavalry');
    const step = now => guardStep(scene, [cav], now);
    Object.assign(enemy, { gx: 46, gy: 35, velX: 4, velY: 0 });
    scene.rebuildSpatial();
    for (let i = 0; i < 20; i++) step(2000 + i * STEP);
    assert.equal(cav.guardPursueTarget, enemy);
    assert.equal(cav.state, 'charge');
    Object.assign(enemy, { gx: 20, gy: 12, velX: -4, velY: 0 });
    scene.rebuildSpatial();
    step(2033 + STEP);
    assert.equal(cav.groundGuardTarget, enemy, 'the grace window keeps pursuing the just-left threat');
    assert.ok(cav.guardPursueFor > 0.3, 'the grace budget is barely spent on its first frame');
    let chasing = 0;
    for (let i = 0; i < 40; i++) {
        step(2033 + (i + 2) * STEP);
        if (cav.groundGuardTarget) chasing++;
    }
    assert.ok(chasing > 15 && chasing <= 22, `grace should span ~21 frames, got ${chasing}`);
    assert.equal(cav.groundGuardTarget, null);
    assert.equal(cav.groundGuardReturning, true);
});

test('pass cavalry defense mirrors exactly when sides are exchanged', () => {
    const blue = deploy('blue'), red = deploy('red');
    const raiderA = blue.units.find(u => u.team === 'red' && u.type === 'cavalry');
    const raiderB = red.units.find(u => u.team === 'blue' && u.type === 'cavalry');
    Object.assign(raiderA, { gx: 38, gy: 34, state: 'charge', chargeDX: 1, chargeDY: 0, chargeDistance: 3, chargeMomentum: 1 });
    Object.assign(raiderB, { gx: 32, gy: 34, state: 'charge', chargeDX: -1, chargeDY: 0, chargeDistance: 3, chargeMomentum: 1 });
    const pairs = [
        [blue.units.filter(u => u.team === 'red'), red.units.filter(u => u.team === 'blue')],
        [blue.units.filter(u => u.team === 'blue'), red.units.filter(u => u.team === 'red')]
    ];
    for (let frame = 0; frame < 480 && !(blue.battleOver || red.battleOver); frame++) {
        blue.advanceBattle(STEP); red.advanceBattle(STEP);
        for (const [a, b] of pairs) for (let i = 0; i < a.length; i++) {
            assert.ok(Math.abs(a[i].gx + b[i].gx - 70) < 1e-6, `frame ${frame}: attacker pair ${i} diverged in gx`);
            assert.equal(a[i].gy, b[i].gy, `frame ${frame}: attacker pair ${i} diverged in gy`);
            assert.equal(a[i].hp, b[i].hp, `frame ${frame}: attacker pair ${i} diverged in hp`);
            assert.equal(a[i].state, b[i].state, `frame ${frame}: attacker pair ${i} diverged in state`);
        }
    }
    assert.equal(blue.battleOver, red.battleOver, 'mirror runs must end together');
});
