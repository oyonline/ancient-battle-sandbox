import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssaultSim, WALL_R, MELEE_STOP_R, ASSAULT_STEP_MS, FORCE_PRESETS,
    ASSAULT_COVER, TOWER_RANGE, GUARD_MELEE_CAP, wallPoint, wallParamToward } from '../js/three-spike/camp-assault-sim.js';

const snapshot = s => [...s.assault.attackers, ...s.assault.defenders].map(({ x, z, hp, dead }) => ({ x, z, hp, dead }));
function run(seed = 1, preset = 'company') {
    const sim = createAssaultSim();
    sim.startAssault(preset, 12, seed);
    let peak = 0, attackFrames = 0, minWall = Infinity;
    for (let frame = 0; frame < 1200; frame++) {
        const units = [...sim.assault.attackers, ...sim.assault.defenders];
        const cds = units.map(u => u.cd);
        sim.stepAssault(ASSAULT_STEP_MS);
        const resets = units.filter((u, i) => !u.dead && u.cd > cds[i]).length;
        peak = Math.max(peak, resets);
        if (resets) attackFrames++;
        for (const u of sim.assault.attackers) {
            const r = Math.max(Math.abs(u.x), Math.abs(u.z));
            minWall = Math.min(minWall, r);
            assert.ok(r >= WALL_R, `wall crossing: seed=${seed} frame=${frame}`);
            assert.ok(!(u.z >= 6.45 && u.z <= 8.2 && Math.abs(u.x) < .6), 'ram lane occupied');
        }
    }
    return { sim, peak, attackFrames, minWall };
}

test('same seed reproduces every frame for 20 seconds; different seed diverges', () => {
    const a = createAssaultSim(), b = createAssaultSim();
    a.startAssault('company', 12, 1); b.startAssault('company', 12, 1);
    for (let i = 0; i < 1200; i++) {
        a.stepAssault(ASSAULT_STEP_MS); b.stepAssault(ASSAULT_STEP_MS);
        assert.deepEqual(snapshot(a), snapshot(b));
    }
    const c = run(2);
    assert.notDeepEqual(snapshot(a), snapshot(c.sim));
    // Restarting an existing simulator also resets the PRNG and all logical state.
    b.startAssault('company', 12, 1);
    for (let i = 0; i < 1200; i++) b.stepAssault(ASSAULT_STEP_MS);
    assert.deepEqual(snapshot(a), snapshot(b));
});

test('company + 12 guards: attack cooldown reset peak <= 5 and no wall/ram crossing', t => {
    const { peak, attackFrames, minWall } = run();
    t.diagnostic(JSON.stringify({ seed: 1, steps: 1200, peak, attackFrames, minWall }));
    assert.ok(peak <= 5, `peak=${peak}`);
    assert.ok(attackFrames > 50, `attackFrames=${attackFrames}`);
    assert.ok(minWall >= MELEE_STOP_R - 1e-9);
});

test('all presets start in spaced directional formations with ordered ranks and staggered departures', t => {
    for (const preset of Object.keys(FORCE_PRESETS)) {
        const s = createAssaultSim();
        s.startAssault(preset, 12, 1);
        const a = s.assault.attackers;
        const gateSide = a.filter(u => u.z > 0 && Math.abs(u.x) < Math.abs(u.z) + 1).length;
        let minDistance = Infinity;
        for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++)
            minDistance = Math.min(minDistance, Math.hypot(a[i].x - a[j].x, a[i].z - a[j].z));
        assert.ok(gateSide / a.length >= .6);
        assert.ok(minDistance >= .4);
        assert.equal(s.assault.formations.length, 3);
        const departures = s.assault.formations.map(f => f.departMs);
        assert.equal(new Set(departures).size, 3);
        for (const f of s.assault.formations) {
            assert.ok(f.departMs >= 0 && f.departMs <= 1500);
            assert.equal(f.speed, Math.min(...f.units.map(u => u.speed)));
            const depth = u => -(u.x - f.x) * f.dx - (u.z - f.z) * f.dz;
            for (let i = 1; i < f.units.length; i++) assert.ok(depth(f.units[i]) >= depth(f.units[i - 1]) - 1e-9);
        }
        for (const u of [...a, ...s.assault.defenders]) {
            assert.ok(u.cd >= .2 * u.typeData.atkSpeed && u.cd <= u.typeData.atkSpeed);
            assert.ok(u.speed >= .9 * u.typeData.speed && u.speed <= 1.1 * u.typeData.speed);
        }
        t.diagnostic(JSON.stringify({ preset, attackers: a.length, gateSide, gatePercent: 100 * gateSide / a.length, minDistance, departures }));
    }
});

test('other presets and flank seeds stay outside walls for all 1200 steps', () => {
    for (const preset of ['squad', 'brigade']) for (const seed of [1, 2]) run(seed, preset);
});

test('formation offsets stay fixed before dispersal; defenders stay on wall or tower', () => {
    const s = createAssaultSim(); s.startAssault('company', 12, 1);
    const initial = s.assault.formations.map(f => f.units.map(u => [u.x - f.x, u.z - f.z]));
    for (let i = 0; i < 120; i++) s.stepAssault(ASSAULT_STEP_MS);
    for (const f of s.assault.formations) for (const [i, u] of f.units.entries()) {
        assert.ok(Math.abs(u.x - f.x - initial[f.id][i][0]) < 1e-9);
        assert.ok(Math.abs(u.z - f.z - initial[f.id][i][1]) < 1e-9);
    }
    for (const u of s.assault.defenders.filter(u => !u.fixed)) assert.equal(Math.max(Math.abs(u.x), Math.abs(u.z)), WALL_R);
    assert.equal(s.assault.defenders.filter(u => u.fixed).length, 6);
});

test('damage constants, victory rules, reset and pure wall helpers retain their contract', () => {
    assert.equal(ASSAULT_COVER, .4); assert.equal(TOWER_RANGE, 12); assert.equal(GUARD_MELEE_CAP, 2);
    for (let t = 0; t < WALL_R * 8; t += .5) {
        const [x, z] = wallPoint(t);
        assert.deepEqual(wallPoint(wallParamToward(x, z)), [x, z]);
    }
    for (const [side, result] of [['defenders', 'break'], ['attackers', 'hold']]) {
        const s = createAssaultSim(); s.startAssault('company', 12);
        s.assault[side].forEach(u => { u.dead = true; u.hp = 0; });
        s.stepAssault(ASSAULT_STEP_MS);
        assert.equal(s.assault.result, result);
        const elapsed = s.assault.elapsedMs;
        assert.deepEqual(s.stepAssault(ASSAULT_STEP_MS), []);
        assert.equal(s.assault.elapsedMs, elapsed);
        s.resetAssault();
        assert.equal(s.assault.active, false); assert.equal(s.assault.attackers.length, 0);
        assert.equal(s.assault.defenders.length, 0); assert.equal(s.assault.result, null);
    }
});
