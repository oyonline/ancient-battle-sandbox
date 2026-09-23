const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const MoraleSystem = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/morale.js'), 'utf8') + '\nMoraleSystem;');

function fixture() {
    const scene = { units: [], simulationTime: 0, battleId: 1, changes: [],
        onMoraleStateChange(unit, previous, reason) { this.changes.push({ id: unit.id, previous, state: unit.moraleState, reason }); }
    };
    const morale = new MoraleSystem(scene);
    const add = (team = 'red', gx = 0, gy = 0, type = 'infantry') => {
        const unit = { id: scene.units.length + 1, team, type, gx, gy, hp: 100, maxHp: 100,
            battleId: scene.battleId, dead: false, withdrawn: false, moving: false, velX: 0, velY: 0 };
        scene.units.push(unit); morale.initUnit(unit);
        return unit;
    };
    const step = (dt = 0.1, events = () => {}) => {
        scene.simulationTime += dt * 1000;
        morale.beginStep(dt); events(); morale.update(dt);
    };
    return { scene, morale, add, step };
}

function approx(actual, expected, message) { assert.ok(Math.abs(actual - expected) < 1e-7, `${message || ''}: ${actual} ≠ ${expected}`); }

test('local casualties use effective HP damage plus new deaths, without repeating old deaths', () => {
    const { morale, add, step } = fixture();
    const units = Array.from({ length: 20 }, () => add());
    const subject = units[0];
    step(0.1, () => {
        morale.queueDamage(subject, 20);
        for (const dead of units.slice(1, 6)) { dead.dead = true; morale.queueDeath(dead); }
    });
    approx(subject.morale, 100 - 24 * 0.2 - 48 * 5 / 20);
    for (let i = 0; i < 20; i++) step();
    approx(subject.morale, 83.2, 'old death entries affect denominator only');
});

test('casualty reference has a floor, excludes distant deaths, and cannot count a death twice', () => {
    const { morale, add, step } = fixture();
    const subject = add(), nearby = add('red', 4, 0), far = add('red', 6, 0);
    step(0.1, () => {
        nearby.dead = far.dead = true;
        morale.queueDeath(nearby); morale.queueDeath(nearby); morale.queueDeath(far);
    });
    approx(subject.morale, 95.2);
});

test('casualty and charge caps are independent rolling three-second budgets', () => {
    const { morale, add, step } = fixture();
    const subject = add(), cavalry = add('blue', -1, 0, 'cavalry');
    step(0.1, () => { morale.queueDamage(subject, 200); morale.queueCharge(cavalry, subject, false); });
    approx(subject.morale, 46, '30 casualty + 24 charge');
    step(0.1, () => { morale.queueDamage(subject, 50); morale.queueCharge(cavalry, subject, false); });
    approx(subject.morale, 46, 'both windows exhausted');
    cavalry.gx = 20;
    for (let i = 0; i < 29; i++) step();
    step(0.1, () => morale.queueDamage(subject, 10));
    approx(subject.morale, 43.6, 'new event admitted once old window expires');
});

test('charge fear distinguishes front, side and rear, and braced reception suppresses it', () => {
    for (const [x, y, braced, expected] of [[1, 0, false, 8], [0, 1, false, 16], [-1, 0, false, 24], [1, 0, true, 0]]) {
        const { morale, add, step } = fixture();
        const subject = add(), cavalry = add('blue', x, y, 'cavalry');
        step(0.1, () => morale.queueCharge(cavalry, subject, braced));
        approx(subject.morale, 100 - expected);
    }
});

test('charge observers receive half fear once; later mutation cannot rewrite frame-start geometry', () => {
    const { morale, add, step } = fixture();
    const subject = add(), neighbor = add('red', 0, 1), outside = add('red', 0, 3);
    const cavalry = add('blue', -1, 0, 'cavalry');
    step(0.1, () => {
        subject.gx = 30; subject.moraleFacingX = -1; cavalry.gx = 31;
        morale.queueCharge(cavalry, subject, false);
        morale.queueCharge(cavalry, neighbor, false);
    });
    approx(subject.morale, 76);
    approx(neighbor.morale, 88);
    approx(outside.morale, 100);
});

test('new targets behind the soldier cannot cause an instant defensive turn', () => {
    const { morale, add, step } = fixture();
    const subject = add(), cavalry = add('blue', -1, 0, 'cavalry');
    subject.target = cavalry;
    step(1 / 60, () => morale.queueCharge(cavalry, subject, false));
    approx(subject.morale, 76);
    assert.ok(subject.moraleFacingX > 0.99);
});

test('pressure needs one continuous second and is independent of simulation-step size', () => {
    function run(dt) {
        const { add, step } = fixture();
        const subject = add();
        add('blue', 2, 0); add('blue', 2, 0.2);
        for (let i = 0; i < Math.round(2 / dt); i++) step(dt);
        return subject.morale;
    }
    approx(run(0.1), 98);
    approx(run(1 / 60), 98);
});

test('actual opposite and surrounding directions count; a crowd entirely in front does not surround', () => {
    function run(enemies) {
        const { add, step } = fixture();
        const subject = add();
        // Enough allied weight makes pure numerical pressure zero.
        for (let i = 0; i < 4; i++) add('red', 0, 0.1);
        for (const [x, y] of enemies) add('blue', x, y);
        for (let i = 0; i < 20; i++) step();
        return subject.morale;
    }
    approx(run([[2, -0.5], [2, 0], [2, 0.5]]), 100);
    approx(run([[2, 0], [-2, 0]]), 98);
    approx(run([[2, 0], [-1, 1.8], [-1, -1.8]]), 97);
});

test('routing enemies and withdrawn units do not threaten or offer stable support', () => {
    const { add, step } = fixture();
    const subject = add(); subject.morale = 50;
    const enemy = add('blue', 1, 0); enemy.morale = 0; enemy.moraleState = 'routing';
    add('red', 0, 1); add('red', 0, 2);
    const absent = add('red', 0, 3); absent.withdrawn = true;
    for (let i = 0; i < 40; i++) step();
    assert.equal(subject.moraleSheltered, false);
    approx(subject.morale, 50);
});

test('routing requires half a second below threshold and callbacks observe the committed batch', () => {
    const { scene, morale, add, step } = fixture();
    const first = add(), second = add();
    first.morale = second.morale = 30;
    scene.onMoraleStateChange = unit => {
        if (unit.moraleState === 'routing') assert.equal(first.moraleState, second.moraleState);
    };
    step(0.1, () => { morale.queueDamage(first, 25); morale.queueDamage(second, 25); });
    for (let i = 0; i < 3; i++) step();
    assert.equal(first.moraleState, 'wavering');
    step();
    assert.equal(first.moraleState, 'routing');
});

test('pure contagion does not cascade further until the routed unit suffers a new real impact', () => {
    const { morale, add, step } = fixture();
    const source = add('red', 0, 0), middle = add('red', 4, 0), far = add('red', 8, 0);
    source.morale = 30; middle.morale = 25.5;
    step(0.1, () => morale.queueDamage(source, 25));
    for (let i = 0; i < 10; i++) step();
    assert.equal(source.moraleState, 'routing');
    assert.equal(middle.moraleState, 'routing');
    approx(far.morale, 100, 'middle must not pass pure panic down the line');
    step(0.1, () => morale.queueDamage(middle, 1));
    step();
    approx(far.morale, 98, 'a new physical hit permits one spread');
    for (let i = 0; i < 10; i++) step();
    approx(far.morale, 98, 'walking routed units do not emit repeated panic');
});

test('simultaneous nearby routs use the eight-point contagion cap', () => {
    const { morale, add, step } = fixture();
    const subject = add();
    const sources = Array.from({ length: 8 }, () => add());
    for (const source of sources) source.morale = 30;
    step(0.1, () => { for (const source of sources) morale.queueDamage(source, 25); });
    for (let i = 0; i < 5; i++) step();
    approx(subject.morale, 92);
});

test('continuing numerical pressure cannot restart a pure contagion chain', () => {
    const { morale, add, step } = fixture();
    const source = add('red', 0, 0), middle = add('red', 4, 0), far = add('red', 8, 0);
    source.morale = 30; middle.morale = 25.5;
    step(0.1, () => morale.queueDamage(source, 25));
    for (let i = 0; i < 5; i++) step();
    // Middle crossed 25 due to contagion; the pressure appears after that crossing.
    add('blue', 4, 2); add('blue', 4, 2.5);
    for (let i = 0; i < 40; i++) step();
    assert.equal(middle.moraleState, 'routing');
    assert.ok(middle.morale < 23.5, 'ongoing pressure still drains morale');
    approx(far.morale, 100, 'pressure alone must not create a new panic broadcast');
});

test('safe support requires three stable allies, waits three seconds and reforms at 45', () => {
    const { add, step } = fixture();
    const subject = add(); subject.morale = 20; subject.moraleState = 'routing';
    add('red', 0, 1); add('red', 0, 2); add('red', 0, 3);
    for (let i = 0; i < 30; i++) step();
    approx(subject.morale, 20);
    assert.equal(subject.moraleSheltered, true);
    for (let i = 0; i < 83; i++) step();
    assert.equal(subject.moraleState, 'routing');
    step();
    assert.equal(subject.moraleState, 'wavering');
    approx(subject.morale, 45.2);
});

test('damage interrupts safe recovery even when the shooter is beyond the safety radius', () => {
    const { morale, add, step } = fixture();
    const subject = add(); subject.morale = 20; subject.moraleState = 'routing';
    add('red', 0, 1); add('red', 0, 2); add('red', 0, 3);
    for (let i = 0; i < 40; i++) step();
    approx(subject.morale, 23);
    step(0.1, () => morale.queueDamage(subject, 10));
    approx(subject.morale, 20.6);
    assert.equal(subject.moraleSheltered, false);
    for (let i = 0; i < 30; i++) step();
    approx(subject.morale, 20.6);
    step();
    approx(subject.morale, 20.9);
});

test('paused simulation time neither drains queued impacts nor advances routing timers', () => {
    const { scene, morale, add, step } = fixture();
    const subject = add(); subject.morale = 30;
    morale.beginStep(0); morale.queueDamage(subject, 25);
    for (let i = 0; i < 100; i++) morale.update(0.1);
    approx(subject.morale, 30);
    assert.equal(scene.simulationTime, 0);
    step();
    approx(subject.morale, 24);
    assert.equal(subject.moraleState, 'wavering');
});

test('battle epoch changes discard stale casualties, charge and routing events', () => {
    const { scene, morale, add, step } = fixture();
    const old = add(), enemy = add('blue', -1, 0, 'cavalry');
    morale.beginStep(0.1); morale.queueDamage(old, 100); morale.queueDeath(old); morale.queueCharge(enemy, old, false);
    scene.battleId++; scene.simulationTime = 0; scene.units = [];
    const fresh = add();
    morale.queueDamage(old, 100); morale.queueDeath(old); morale.queueCharge(enemy, fresh, false);
    step();
    approx(fresh.morale, 100);
    assert.equal(fresh.moraleState, 'steady');
});

test('mirrored simultaneous events are invariant to unit traversal order and team swap', () => {
    function run(mirror) {
        const { scene, morale, add, step } = fixture();
        const side = mirror ? 'blue' : 'red', other = mirror ? 'red' : 'blue', s = mirror ? -1 : 1;
        const subject = add(side, 0, 0), friend = add(side, s, 0), cavalry = add(other, -2 * s, 0, 'cavalry');
        add(other, s, 2); add(other, s, -2);
        subject.morale = 60;
        if (mirror) scene.units.reverse();
        step(0.1, () => { morale.queueDamage(subject, 20); friend.dead = true; morale.queueDeath(friend); morale.queueCharge(cavalry, subject, false); });
        for (let i = 0; i < 30; i++) step();
        return { morale: subject.morale, state: subject.moraleState, reason: subject.moraleReason };
    }
    assert.deepEqual(run(false), run(true));
});
