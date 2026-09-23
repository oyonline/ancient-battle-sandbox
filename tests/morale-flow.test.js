const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const MoraleSystem = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/morale.js'), 'utf8') + '\nMoraleSystem;');
const { makeScene, snapshot } = require('./battle-harness.js');

function fixture() {
    const scene = { units: [], simulationTime: 0, battleId: 1,
        onMoraleStateChange(unit, previous) {
            if (unit.moraleState === 'routing' && previous !== 'routing') unit.routStartedAt = this.simulationTime;
        } };
    const morale = new MoraleSystem(scene);
    const add = (team = 'red', gx = 0, gy = 0, type = 'infantry') => {
        const unit = { id: scene.units.length + 1, team, type, gx, gy, hp: 100, maxHp: 100,
            battleId: 1, dead: false, withdrawn: false, moving: false, velX: 0, velY: 0 };
        scene.units.push(unit); morale.initUnit(unit); return unit;
    };
    const step = (dt = 0.1, events = () => {}) => {
        scene.simulationTime += dt * 1000;
        morale.beginStep(dt); events(); morale.update(dt);
    };
    return { scene, morale, add, step };
}

function approx(a, b, label = '') { assert.ok(Math.abs(a - b) < 1e-7, `${label}: ${a} differs from ${b}`); }

test('wavering infantry and pikes fall back only after real new impacts, with a five-second cooldown', () => {
    for (const type of ['infantry', 'pikeman']) {
        const { scene, morale, add, step } = fixture();
        const unit = add('red', 0, 0, type); unit.morale = 35;
        step();
        assert.equal(unit.moraleState, 'wavering');
        assert.equal(unit.moraleFallBackUntil, 0, 'low morale alone must not make a soldier repeatedly back away');
        step(0.1, () => morale.queueDamage(unit, 1));
        assert.equal(unit.moraleFallBackUntil, 1100);
        assert.equal(unit.nextMoraleFallBackAt, 5200);
        step(0.1, () => morale.queueDamage(unit, 1));
        assert.equal(unit.moraleFallBackUntil, 1100, 'a second hit cannot extend the retreat every frame');
        while (scene.simulationTime < 5200 - 1e-7) step();
        const previous = unit.moraleFallBackUntil;
        assert.equal(previous, 1100, 'no impact at cooldown expiry means no new retreat');
        step(0.1, () => morale.queueDamage(unit, 1));
        approx(unit.moraleFallBackUntil, scene.simulationTime + 900);
        unit.morale = 60; step();
        assert.equal(unit.moraleState, 'steady');
        assert.equal(unit.moraleFallBackUntil, 0);
        unit.morale = 20; unit.moraleFallBackUntil = scene.simulationTime + 900;
        step(0.5);
        assert.equal(unit.moraleState, 'routing');
        assert.equal(unit.moraleFallBackUntil, 0, 'ordered withdrawal never replaces routing');
    }
});

test('nearby new casualties can trigger fallback; pressure, charge fear, archers and cavalry cannot', () => {
    const { morale, add, step } = fixture();
    const unit = add(); unit.morale = 35;
    const friend = add('red', 1, 0);
    step(0.1, () => { friend.dead = true; morale.queueDeath(friend); });
    assert.equal(unit.moraleFallBackUntil, 1000);
    for (const type of ['archer', 'cavalry']) {
        const f = fixture(), subject = f.add('red', 0, 0, type); subject.morale = 35;
        f.step(0.1, () => f.morale.queueDamage(subject, 1));
        assert.equal(subject.moraleFallBackUntil, 0);
    }
    const f = fixture(), subject = f.add(); subject.morale = 45;
    const horse = f.add('blue', 1, 0, 'cavalry');
    f.step(0.1, () => f.morale.queueCharge(horse, subject, false));
    assert.ok(subject.morale < 38);
    assert.equal(subject.moraleFallBackUntil, 0, 'fear alone is not an actual wound or death');
    for (let i = 0; i < 20; i++) f.step();
    assert.equal(subject.moraleFallBackUntil, 0, 'ongoing numerical pressure cannot repeat a withdrawal cue');
});

function reserveFixture() {
    const scene = makeScene();
    scene.deployUnits({ infantry: 4 }, { pikeman: 1 }, 'custom', 'square',
        { red: 'flank', blue: 'hold' }, { deathmatch: true, reserves: { red: 3, blue: 0 } });
    const group = scene.tactics.groups.red;
    const unit = group.main[0];
    Object.assign(unit, { gx: 25, gy: 35, hp: 37, morale: 20, moraleState: 'routing', routStartedAt: 0 });
    group.reserve.forEach((other, index) => Object.assign(other, { gx: 24, gy: 34 + index }));
    const enemy = scene.units.find(other => other.team === 'blue');
    enemy.gx = 60; enemy.gy = 35;
    const step = (dt = 0.1, events = () => {}) => {
        scene.simulationTime += dt * 1000;
        scene.rebuildSpatial(); scene.tactics.beginStep(dt); scene.morale.beginStep(dt);
        events(); scene.morale.update(dt);
    };
    return { scene, group, unit, enemy, step };
}

test('three actual safe reserves recover after exactly 1.5 seconds at eight per second and rally at 50 without healing', () => {
    const { scene, group, unit, step } = reserveFixture();
    step(1.4);
    assert.equal(scene.tactics.reserveSupport(unit), true);
    approx(unit.morale, 20);
    step(0.2);
    approx(unit.morale, 20.8, 'a step crossing the wait boundary must count only its final 0.1 seconds');
    assert.equal(unit.moralePhase, 'recovering');
    approx(unit.moraleRecoveryProgress, 20.8 / 50);
    for (let i = 0; i < 36; i++) step();
    assert.equal(unit.moraleState, 'routing');
    step();
    assert.equal(unit.moraleState, 'steady');
    approx(unit.morale, 50.4);
    approx(unit.moraleRecoveryProgress, 1);
    assert.equal(unit.hp, 37, 'regrouping changes morale, never health');
    assert.equal(group.reserve.length, 3);
});

test('real reserve acceleration is interrupted by damage, incoming enemies and loss of the third reserve', () => {
    const { scene, group, unit, enemy, step } = reserveFixture();
    for (let i = 0; i < 20; i++) step();
    approx(unit.morale, 24);
    step(0.1, () => scene.morale.queueDamage(unit, 10));
    approx(unit.morale, 21.6);
    assert.equal(unit.moraleSheltered, false);
    assert.equal(unit.moraleRecoveryProgress, 0);
    for (let i = 0; i < 15; i++) step();
    approx(unit.morale, 21.6, 'the full reserve wait must restart after a hit');
    step(); approx(unit.morale, 22.4);
    // Enter between the 200ms local-pressure refreshes: safety must still end this frame.
    enemy.gx = unit.gx + 5.9;
    step(1 / 60);
    assert.equal(unit.moraleSheltered, false);
    assert.equal(unit.moralePhase, 'escaping');
    approx(unit.morale, 22.4);
    enemy.gx = 60;
    group.reserve[0].reserveCommitted = true;
    for (let i = 0; i < 31; i++) step();
    assert.equal(scene.tactics.reserveSupport(unit), false);
    assert.ok(unit.morale < 24, 'two remaining reserves cannot grant the accelerated rate');
    assert.equal(unit.moraleState, 'routing');
});

test('ordinary support and isolated deathmatch retain their old three-second wait and three-point recovery', () => {
    for (const deathmatch of [false, true]) {
        const { scene, add, step } = fixture(); scene.battleOptions = { deathmatch };
        const unit = add(); unit.morale = 20; unit.moraleState = 'routing'; unit.routStartedAt = 0;
        if (!deathmatch) for (let i = 0; i < 3; i++) add('red', 0, i + 1);
        for (let i = 0; i < 30; i++) step();
        approx(unit.morale, 20);
        for (let i = 0; i < 10; i++) step();
        approx(unit.morale, 23);
        unit.morale = deathmatch ? 59.8 : 44.8;
        step();
        assert.equal(unit.moraleState, deathmatch ? 'steady' : 'wavering');
    }
});

test('routing phases follow simulation time and do not overwrite formation or return phases', () => {
    const { scene, morale, add, step } = fixture();
    const unit = add(); unit.morale = 20;
    step(0.5);
    assert.equal(unit.moraleState, 'routing'); assert.equal(unit.moralePhase, 'breaking');
    for (let i = 0; i < 8; i++) step();
    assert.equal(unit.moralePhase, 'breaking');
    step(); assert.equal(unit.moralePhase, 'escaping');
    const before = JSON.stringify([unit.morale, unit.moralePhase, unit.moraleRecoveryProgress, morale.records.get(unit)]);
    for (let i = 0; i < 50; i++) morale.update(0.1);
    assert.equal(JSON.stringify([unit.morale, unit.moralePhase, unit.moraleRecoveryProgress, morale.records.get(unit)]), before);
    assert.equal(scene.simulationTime, 1400);
    for (const phase of ['forming', 'returning']) {
        unit.morale = 70; unit.moraleState = 'steady'; unit.moralePhase = phase;
        step(); assert.equal(unit.moralePhase, phase);
    }
});

test('a newly routing enemy steadies only nearby unhurt combatants once, capped to four points per eight seconds', () => {
    const { scene, morale, add, step } = fixture();
    const nearby = add('red', 0, 0), edge = add('red', 0, 3), far = add('red', 0, 3.01);
    const hurt = add('red', 0, 0.1), broken = add('red', 0, 0.2);
    for (const unit of [nearby, edge, far, hurt]) unit.morale = 70;
    broken.morale = 20; broken.moraleState = 'routing';
    const enemy = add('blue', 0, 0); enemy.morale = 20;
    step(0.5, () => morale.queueDamage(hurt, 1));
    assert.equal(enemy.moraleState, 'routing');
    approx(nearby.morale, 74); approx(edge.morale, 74); approx(far.morale, 70);
    approx(hurt.morale, 69.76); approx(broken.morale, 20);
    assert.equal(nearby.moraleBoostUntil, scene.simulationTime + 1200);
    step(0.1); approx(nearby.morale, 74, 'the same routing enemy must not reward the next frame');
    const second = add('blue', 0, 0); second.morale = 20;
    step(0.5); approx(nearby.morale, 74, 'a second rout inside the cooldown cannot stack another reward');
    while (scene.simulationTime < 8500 - 1e-7) step();
    const before = nearby.morale;
    const third = add('blue', 0, 0); third.morale = 20;
    step(0.5);
    approx(nearby.morale, Math.min(100, before + 4), 'a genuinely new rout after eight seconds can steady the unit again');
});

test('nearby casualties, actual pressure and ongoing collapse block the positive rout signal', () => {
    for (const mode of ['casualty', 'pressure', 'collapse']) {
        const { morale, add, step } = fixture();
        const subject = add(); subject.morale = mode === 'collapse' ? 20 : 70;
        const source = add('blue', 1, 0); source.morale = 20;
        let casualty;
        if (mode === 'casualty') casualty = add('red', 0, 1);
        if (mode === 'pressure') {
            for (let i = 0; i < 3; i++) add('blue', 2, i * 0.1);
            // Keep the future source steady until numerical pressure has crossed its one-second delay.
            source.morale = 100;
            for (let i = 0; i < 11; i++) step();
            source.morale = 20;
        }
        step(0.5, () => { if (casualty) { casualty.dead = true; morale.queueDeath(casualty); } });
        assert.equal(source.moraleState, 'routing');
        assert.equal(subject.moraleBoostUntil, 0);
        if (mode === 'collapse') assert.equal(subject.moraleState, 'routing', 'enemy panic cannot cancel the normal collapse timer');
        else assert.ok(subject.morale < 70);
    }
});

test('rout feedback waits until the nearby sector has no combat-capable enemy, using this step final states', () => {
    const { add, step } = fixture();
    const subject = add('red', 0, 0); subject.morale = 70;
    const first = add('blue', 1, 0); first.morale = 20;
    const remaining = add('blue', 2, 0);
    step(0.5);
    assert.equal(first.moraleState, 'routing');
    approx(subject.morale, 70, 'one fleeing enemy cannot steady a soldier still in close combat');
    assert.equal(subject.moraleBoostUntil, 0);
    remaining.morale = 20;
    step(0.5);
    assert.equal(remaining.moraleState, 'routing');
    approx(subject.morale, 74, 'the last nearby opponent routing this frame must immediately count as no longer combat-capable');
    assert.equal(subject.moraleBoostUntil, 2200);

    const distant = fixture(), own = distant.add('red', 0, 0); own.morale = 70;
    const fleeing = distant.add('blue', 1, 0); fleeing.morale = 20;
    distant.add('blue', 3.01, 0);
    distant.step(0.5);
    approx(own.morale, 74, 'a combatant outside the local three-grid sector must not suppress local feedback');
});

test('simultaneous enemy routs preserve mirror symmetry and traversal independence', () => {
    function run(mirror) {
        const { scene, morale, add, step } = fixture();
        const own = mirror ? 'blue' : 'red', other = mirror ? 'red' : 'blue', sign = mirror ? -1 : 1;
        const subject = add(own, sign, 0); subject.morale = 45;
        const shaken = add(own, sign, 1); shaken.morale = 35;
        for (let i = 0; i < 5; i++) add(own, sign, 1.5);
        for (let i = 0; i < 4; i++) { const enemy = add(other, -sign, i * 0.1); enemy.morale = 20; }
        if (mirror) scene.units.reverse();
        step(0.5, () => morale.queueDamage(shaken, 1));
        return snapshot([subject, shaken].map(unit => ({ morale: unit.morale, state: unit.moraleState,
            fallback: unit.moraleFallBackUntil, boost: unit.moraleBoostUntil, progress: unit.moraleRecoveryProgress })));
    }
    const forward = run(false);
    approx(forward[0].morale, 49, 'four simultaneous enemy routs still grant only one four-point boost');
    assert.deepEqual(forward, run(true));
});

test('reserve recovery has identical timing across step sizes with a wait-boundary crossing', () => {
    function run(dt) {
        const { unit, step } = reserveFixture();
        for (let i = 0; i < Math.round(4 / dt); i++) step(dt);
        return { morale: unit.morale, state: unit.moraleState, progress: unit.moraleRecoveryProgress, hp: unit.hp };
    }
    const fine = run(1 / 60), coarse = run(0.1);
    approx(fine.morale, coarse.morale); approx(fine.progress, coarse.progress);
    assert.equal(fine.state, coarse.state); assert.equal(fine.hp, coarse.hp);
});

test('production pause and 1x/2x preserve reserve recovery progress and morale timers', () => {
    function run(speed) {
        const { scene, unit } = reserveFixture();
        // Keep this fixture's support group stationary while using the real fixed-step engine and routing path.
        scene.tactics.updateUnit = () => true;
        scene.battleStarted = true; scene.setSpeed(speed);
        for (let i = 0; i < 240 / speed; i++) scene.advanceBattle(1000 / 60);
        const state = () => snapshot({ time: scene.simulationTime, morale: unit.morale, phase: unit.moralePhase,
            progress: unit.moraleRecoveryProgress, hp: unit.hp, x: unit.gx, y: unit.gy,
            safe: scene.morale.records.get(unit).safeTime, reserveSafe: scene.morale.records.get(unit).reserveSafeTime });
        const before = state(); scene.togglePause();
        for (let i = 0; i < 120; i++) scene.advanceBattle(1000 / 60);
        assert.deepEqual(state(), before, 'paused real engine must not progress any recovery timer');
        return before;
    }
    assert.deepEqual(run(1), run(2));
});
