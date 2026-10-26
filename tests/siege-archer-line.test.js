import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit } from './battle-harness.js';
import { deployVariant, step } from '../tools/siege-balance.mjs';
import { CAMP_LAYOUT as L } from '../js/siege3d/layout.js';
import { configureCampArmies, createCampSiege } from '../js/siege3d/deployment.js';
import { installPlayerAssault } from '../js/battle/siege-assault.js';
import { createSiegeLayer } from '../js/battle/siege.js';
import { campBounds, queueCampWalls } from '../js/siege3d/walls.js';
import { setBoardSize } from '../js/board.js';

const faces = ['north', 'east', 'south', 'west'];
const player = () => deployVariant({ seed: 173, variant: 1, siegeOptions: { attackerControl: 'player' } });
const alive = u => !u.dead && !u.withdrawn && u.hp > 0;
const onDuty = (s, u) => alive(u) && u.moraleState !== 'routing';
const distance = (u, p) => Math.hypot(u.gx - p.gx, u.gy - p.gy);
const walkway = (s, u) => s.siege.platforms.some(p => p.kind === 'walkway' &&
    u.gx >= p.x1 && u.gx <= p.x2 && u.gy >= p.y1 && u.gy <= p.y2);
const archers = s => s.units.filter(u => u.team === 'red' && u.type === 'archer');
const releasedState = u => {
    assert.equal(u.siegeArcherPost, undefined);
    assert.equal(u.guardRadius, undefined);
    assert.equal(u.groundGuardReturning, false);
    assert.equal(u.groundGuardTarget, null);
};

test('A2: player rejects missing, non-finite and overlapping archer clearances', () => {
    for (const archerLineClearance of [undefined, NaN, Infinity, 27, 28]) {
        assert.throws(() => installPlayerAssault({}, {
            attackerControl: 'player', stagingClearance: 27, archerHoldClearance: 26, archerLineClearance
        }), /archerLineClearance < stagingClearance/);
    }
    assert.throws(() => createCampSiege(campBounds(), {
        attackerControl: 'player', stagingClearance: 18.5
    }), /archerLineClearance < stagingClearance/);
    assert.doesNotThrow(() => installPlayerAssault({}, {
        attackerControl: 'player', stagingClearance: 27, archerHoldClearance: 26, archerLineClearance: 18.5
    }));
    assert.doesNotThrow(() => installPlayerAssault({}, { attackerControl: 'auto' }));
});

const release = (s, face) => s.applyNetCommand(face === 'ram'
    ? { k: 'siegeRam', side: 'red' } : { k: 'siegeAssault', side: 'red', face });

// Keep the original melee cohort, including later crew and casualties, so the
// average cannot improve merely because lagging soldiers disappear from units.
function advanceWindow(s, face, withRam = false) {
    const b = campBounds(), ram = s.siege.ram, ramStart = ram.gy;
    const wallDistance = u => Math.hypot(
        Math.max(b.x1 - L.wallThickness - u.gx, 0, u.gx - b.x2 - L.wallThickness),
        Math.max(b.y1 - L.wallThickness - u.gy, 0, u.gy - b.y2 - L.wallThickness));
    const soldiers = s.units.filter(u => u.team === 'red' && u.siegeWing === face &&
        ['infantry', 'pikeman'].includes(u.type));
    const mean = () => soldiers.reduce((sum, u) => sum + wallDistance(u), 0) / soldiers.length;
    const before = mean(), started = new Set(), ladders = s.siege.ladders.filter(l => l.face === face);
    const southArchers = archers(s).filter(u => u.siegeWing === 'south');
    let completed = 0, ramMonotonic = true, previousY = ram.gy, maxSouthPostError = 0;
    let minSouthDuty = southArchers.length;
    for (let frame = 1; frame <= 1800; frame++) {
        assert.equal(s.battleOver, false, `release window ended before frame ${frame}`);
        step(s); completed++;
        if (withRam && ram.gy > previousY) ramMonotonic = false;
        previousY = ram.gy;
        for (const l of ladders) if (l.crewInitialized && distance(l.pos, l.start) > 0) started.add(l.id);
        if (!s.siege.assault.released.south) {
            const duty = southArchers.filter(u => onDuty(s, u));
            minSouthDuty = Math.min(minSouthDuty, duty.length);
            for (const u of duty) {
                assert.ok(u.siegeArcherPost && u.guardRadius === 1.25);
                maxSouthPostError = Math.max(maxSouthPostError, distance(u, u.siegeArcherPost));
            }
        }
    }
    return { completed, meleeCount: soldiers.length, meleeBefore: before, meleeAfter: mean(),
        meleeAdvance: before - mean(), started: [...started],
        ladders: ladders.map(l => ({ id: l.id, advance: distance(l.pos, l.start), state: l.state })),
        ramAdvance: ramStart - ram.gy, ramY: ram.gy, ramHitY: ram.hitY, ramMonotonic,
        maxSouthPostError, minSouthDuty };
}

for (const face of ['south', 'north']) test(`A2: ${face} release advances ladders and melee within 30 seconds${face === 'south' ? ' with ram' : ' while south archers hold'}`, t => {
    const s = player(); step(s, 600);
    assert.equal(release(s, face), true);
    if (face === 'south') assert.equal(release(s, 'ram'), true);
    const result = advanceWindow(s, face, face === 'south');
    t.diagnostic(JSON.stringify({ face, ...result }));
    assert.equal(result.completed, 1800);
    assert.equal(result.started.length, result.ladders.length);
    assert.ok(result.ladders.every(l => l.advance >= 8));
    assert.ok(result.meleeAdvance >= 8, `melee advance ${result.meleeAdvance}`);
    if (face === 'south') {
        assert.equal(result.ramMonotonic, true);
        assert.ok(result.ramY <= result.ramHitY || result.ramAdvance >= 8);
    } else {
        assert.equal(s.siege.assault.released.south, false);
        assert.ok(result.minSouthDuty > 0);
        assert.ok(result.maxSouthPostError <= 1.75);
    }
});

test('A2: ram-only release crosses the unreleased south archer line within 30 seconds', t => {
    const s = player(); step(s, 600);
    assert.equal(release(s, 'ram'), true);
    const result = advanceWindow(s, 'south', true);
    t.diagnostic(JSON.stringify({ release: 'ram-only', ...result }));
    assert.equal(result.completed, 1800);
    assert.equal(s.siege.assault.released.south, false);
    assert.equal(result.ramMonotonic, true);
    assert.ok(result.ramY <= result.ramHitY || result.ramAdvance >= 8);
    assert.ok(result.minSouthDuty > 0);
    assert.ok(result.maxSouthPostError <= 1.75);
    assert.ok(s.siege.ladders.filter(l => l.face === 'south').every(l =>
        !l.crewInitialized && distance(l.pos, l.start) === 0));
});

test('A2: player archers form centered single rows at clearance 26 then 18.5, separate from melee staging', () => {
    const s = player(), b = campBounds();
    for (const clearance of [26, 18.5]) {
        if (clearance === 18.5) assert.equal(s.applyNetCommand({ k: 'siegeArchers', side: 'red' }), true);
        for (const face of faces) {
            const row = archers(s).filter(u => u.siegeWing === face);
            assert.equal(row.length, face === 'south' ? 10 : 5);
            const horizontal = face === 'north' || face === 'south';
            row.forEach((u, i) => {
                assert.equal(u.siegeAnchor, undefined);
                assert.equal(u.siegeStaging, undefined);
                const p = u.siegeArcherPost;
                assert.equal(horizontal ? p.gx : p.gy, 50 + i - (row.length - 1) / 2);
                const normal = horizontal ? p.gy : p.gx;
                const edge = face === 'north' ? b.y1 : face === 'south' ? b.y2 : face === 'west' ? b.x1 : b.x2;
                assert.ok(Math.abs(Math.abs(normal - edge) - L.wallThickness - clearance) < 1e-12);
                if (clearance === 26) assert.ok(distance(u, p) <= Math.SQRT2 * .3);
            });
        }
    }
});

test('A2: seed173 variant1 waits all 3600 complete steps with four-face wall fire and tower return fire', t => {
    const s = player(), initial = [...s.units], attackers = archers(s);
    const initialWall = initial.filter(u => u.team === 'blue' && u.siegeDefenseRole === 'wall');
    const shots = [], fire = s.fireArrow, routed = new Set();
    s.fireArrow = function (from, target, options) {
        shots.push({ from, target, time: this.simulationTime, distance: distance(from, target), wallTarget: target.team === 'blue' && target.type !== 'archer' && walkway(this, target),
            shooter: from.team === 'red' ? from.type : from.siegeAnchor ? 'towerArcher' : 'groundArcher' });
        return fire.call(this, from, target, options);
    };
    let samples = 0, maxError = 0, completed = 0;
    for (let frame = 1; frame <= 3600; frame++) {
        assert.equal(s.battleOver, false, `ended before frame ${frame}`);
        if (frame === 600) assert.equal(s.applyNetCommand({ k: 'siegeArchers', side: 'red' }), true);
        step(s); completed++;
        const duty = attackers.filter(u => onDuty(s, u));
        assert.ok(duty.length > 0, `no on-duty samples at frame ${frame}`);
        for (const u of duty) {
            const b = campBounds(), face = u.siegeWing;
            const normal = face === 'north' ? b.y1 - u.gy : face === 'south' ? u.gy - b.y2 :
                face === 'west' ? b.x1 - u.gx : u.gx - b.x2;
            assert.ok(normal - L.wallThickness >= 18.5 - .3, `crossed line at frame ${frame}`);
            if (frame >= 600 && frame < 1800) continue;
            samples++;
            const error = distance(u, u.siegeArcherPost);
            maxError = Math.max(maxError, error);
            assert.ok(error <= 1.25 + .5, `frame ${frame}, archer ${u.id}: ${error}`);
        }
        for (const u of attackers) if (u.moraleState === 'routing') routed.add(u.id);
    }
    assert.equal(completed, 3600);
    assert.ok(Math.abs(s.simulationTime - 60000) < 1e-6);
    assert.equal(s.battleOver, false);
    const attackShots = shots.filter(a => a.from.team === 'red');
    for (const face of faces) assert.ok(attackShots.some(a => a.from.siegeWing === face && a.wallTarget), face);
    assert.ok(shots.some(a => a.shooter === 'towerArcher' && a.target.team === 'red' && a.target.type === 'archer'));
    const exceptions = attackShots.filter(a => !a.wallTarget);
    const wallTargetRatio = (attackShots.length - exceptions.length) / attackShots.length;
    const targetExceptions = [];
    for (const shot of exceptions) {
        let row = targetExceptions.find(e => e.from === shot.from.id && e.target === shot.target.id);
        if (!row) {
            row = { from: shot.from.id, face: shot.from.siegeWing, target: shot.target.id,
                type: shot.target.type, role: shot.target.siegeAnchor ? 'towerArcher' : shot.target.siegeDefenseRole,
                count: 0, firstMs: shot.time, lastMs: shot.time, minDistance: shot.distance, maxDistance: shot.distance };
            targetExceptions.push(row);
        }
        row.count++; row.lastMs = shot.time;
        row.minDistance = Math.min(row.minDistance, shot.distance);
        row.maxDistance = Math.max(row.maxDistance, shot.distance);
    }
    const deaths = units => units.filter(u => u.dead || u.hp <= 0).length;
    const meleeDead = Object.fromEntries(['infantry', 'pikeman'].map(type => [type,
        deaths(initial.filter(u => u.team === 'red' && u.type === type))]));
    assert.ok(samples > 0);
    t.diagnostic(JSON.stringify({ completed, samples, maxError,
        beforeOrderShots: { red: shots.filter(a => a.time < 10000 && a.from.team === 'red').length, blue: shots.filter(a => a.time < 10000 && a.from.team === 'blue').length },
        shots: Object.fromEntries(['archer', 'towerArcher', 'groundArcher'].map(k => [k, shots.filter(a => a.shooter === k).length])),
        wallTargetShots: attackShots.length - exceptions.length, attackShots: attackShots.length,
        wallTargetRatio, targetExceptions, meleeDead,
        wounded: Object.fromEntries(['red', 'blue'].map(team => [team,
            initial.filter(u => u.team === team && alive(u) && u.hp < u.maxHp).length])),
        wallWounded: initialWall.filter(u => alive(u) && u.hp < u.maxHp).length,
        meleeWounded: Object.fromEntries(['infantry', 'pikeman'].map(type => [type,
            initial.filter(u => u.team === 'red' && u.type === type && alive(u) && u.hp < u.maxHp).length])),
        attackShotsByFace: Object.fromEntries(faces.map(face => [face, attackShots.filter(a => a.from.siegeWing === face).length])),
        dead: { red: deaths(initial.filter(u => u.team === 'red')), blue: deaths(initial.filter(u => u.team === 'blue')),
            wall: deaths(initialWall) },
        withdrawn: { red: initial.filter(u => u.team === 'red' && u.withdrawn).length,
            blue: initial.filter(u => u.team === 'blue' && u.withdrawn).length },
        attackArcherRoutedEver: routed.size,
        attackArcherRoutingAtEnd: attackers.filter(u => u.moraleState === 'routing').length }));
    assert.ok(wallTargetRatio >= .9, `wall target ratio ${wallTargetRatio}`);
    assert.equal(meleeDead.infantry + meleeDead.pikeman, 0);
});

test('A2: north release clears guard lifecycle while the other three archer lines stay on duty', () => {
    const s = player(); step(s, 120);
    const north = archers(s).filter(u => u.siegeWing === 'north');
    assert.ok(north.every(u => u.guardRadius === 1.25));
    assert.equal(s.applyNetCommand({ k: 'siegeAssault', side: 'red', face: 'north' }), true);
    for (const u of north) {
        releasedState(u);
        assert.equal(s.siege.assault.act(s, u, s.simulationTime, 1 / 60), false);
    }
    step(s, 60);
    for (const face of faces.filter(f => f !== 'north')) {
        const row = archers(s).filter(u => u.siegeWing === face && onDuty(s, u));
        assert.ok(row.length > 0);
        assert.ok(row.every(u => u.siegeArcherPost && u.guardRadius === 1.25 && distance(u, u.siegeArcherPost) <= 1.75));
    }
});

test('A2: routing keeps priority while wavering archers retain post guard through fallback', () => {
    for (const state of ['routing', 'wavering']) {
        const s = player(); step(s);
        const u = archers(s)[0], act = s.siege.assault.act;
        const intercepted = [];
        let postedCalls = 0;
        const normal = s.updateNormalUnit;
        s.updateNormalUnit = function (unit, now, dt, anchor) {
            if (unit === u && anchor === u.siegeArcherPost) postedCalls++;
            return normal.call(this, unit, now, dt, anchor);
        };
        s.siege.assault.act = function (scene, unit, ...args) {
            const result = act.call(this, scene, unit, ...args);
            if (unit === u) intercepted.push(result);
            return result;
        };
        u.moraleState = state; u.morale = state === 'routing' ? 0 : 30;
        u.moraleFallBackUntil = s.simulationTime + 1000;
        if (state === 'routing') {
            assert.equal(act(s, u, s.simulationTime, 1 / 60), false);
            step(s);
            assert.deepEqual(intercepted, []);
            assert.equal(postedCalls, 0);
        } else {
            const post = u.siegeArcherPost;
            u.gy -= 1; u.pgy = u.gy;
            const before = distance(u, post);
            // Cover both the active fallback window and wavering after it expires.
            for (let frame = 1; frame <= 90; frame++) {
                step(s);
                assert.equal(u.moraleState, 'wavering');
                assert.equal(postedCalls, frame);
                assert.equal(intercepted.at(-1), true);
                assert.ok(distance(u, post) <= 1.75);
            }
            assert.ok(s.simulationTime > u.moraleFallBackUntil);
            assert.ok(distance(u, post) < before);
        }
    }
});

test('A2: displaced archer returns through normal AI; player/auto redeployment clears stale guard state', () => {
    const s = player(); step(s);
    const u = archers(s).find(u => u.siegeWing === 'north'), oldPost = u.siegeArcherPost;
    u.gy -= 1; u.pgy = u.gy;
    const before = distance(u, oldPost);
    step(s, 60);
    assert.ok(distance(u, oldPost) < before);
    assert.ok(distance(u, oldPost) <= .2);
    assert.equal(u.groundGuardReturning, true);
    const units = [...s.units];
    configureCampArmies(s, { attackerControl: 'player' });
    assert.ok(s.units.every((unit, i) => unit === units[i]));
    assert.notEqual(u.siegeArcherPost, oldPost);
    assert.equal(u.guardRadius, undefined);
    assert.equal(u.groundGuardReturning, false);
    assert.equal(u.groundGuardTarget, null);
    step(s);
    configureCampArmies(s, { attackerControl: 'auto' });
    for (const a of archers(s)) releasedState(a);
});

// New A2 per-step projection: exact values for replay, reflected coordinates
// rounded only for the independent mirror fixture's floating-point arithmetic.
function summary(s, initial, mirrored = false, normalize = false) {
    const number = n => normalize ? Number(n.toFixed(10)) : n;
    const x = n => number(mirrored ? 100 - n : n);
    return { units: initial.map(u => [u.id, x(u.gx), number(u.gy), u.hp, number(u.morale), u.moraleState,
        u.dead, u.withdrawn, u.siegeArcherPost ? [x(u.siegeArcherPost.gx), number(u.siegeArcherPost.gy)] : null]),
    arrows: s.arrows.length, time: s.simulationTime, battleOver: s.battleOver };
}

test('A2: full player seed173 variant1 replays every step through 600 including posts and arrows', () => {
    const run = () => {
        const s = player(), initial = [...s.units], frames = [];
        for (let frame = 1; frame <= 600; frame++) {
            assert.equal(s.battleOver, false);
            if (frame === 60) assert.equal(s.applyNetCommand({ k: 'siegeArchers', side: 'red' }), true);
            step(s); frames.push(summary(s, initial));
        }
        return frames;
    };
    const expected = run(), actual = run();
    for (let frame = 0; frame < 600; frame++) assert.deepEqual(actual[frame], expected[frame], `step ${frame + 1}`);
    assert.ok(expected.some(frame => frame.arrows > 0));
});

// Isolate A2's seat symmetry with four real archer/guard/tower exchanges.
// Static defender posts avoid testing the unrelated allocator and scatter RNG.
function mirrorFixture(swapped) {
    setBoardSize(100, 100);
    const s = makeScene(), b = campBounds(), x = n => swapped ? 100 - n : n;
    const attackerTeam = swapped ? 'blue' : 'red', defenderTeam = swapped ? 'red' : 'blue';
    const platforms = createCampSiege(b, { defense: false }).platforms.map(p => swapped ?
        { ...p, x1: x(p.x2), x2: x(p.x1) } : p);
    s.siege = createSiegeLayer(platforms, { attackerControl: 'player', attackerTeam,
        stagingClearance: 27, archerLineClearance: 18.5, archerHoldClearance: 26, bounds: b, wallThickness: .3,
        rules: { ...L.rules, attackerTeam, defenderTeam } });
    for (const face of faces) {
        const horizontal = face === 'north' || face === 'south', sign = ['north', 'west'].includes(face) ? -1 : 1;
        const point = offset => horizontal ? { gx: 50, gy: 50 + sign * offset } : { gx: 50 + sign * offset, gy: 50 };
        const spawn = (team, type, p) => {
            const u = addUnit(s, team, type, x(p.gx), p.gy);
            if (type === 'archer') u.typeData = { ...u.typeData, range: 20 };
            return u;
        };
        const a = spawn(attackerTeam, 'archer', point(10 + .3 + 18.5));
        a.siegeWing = swapped ? ({ east: 'west', west: 'east' }[face] ?? face) : face;
        a.siegeArcherPost = { gx: a.gx, gy: a.gy };
        const wall = spawn(defenderTeam, 'infantry', point(10 - .38));
        wall.siegeAnchor = { gx: wall.gx, gy: wall.gy };
        const p = platforms.filter(p => p.kind === 'tower').sort((a, b) =>
            Math.hypot((a.x1 + a.x2) / 2 - x(point(8.4).gx), (a.y1 + a.y2) / 2 - point(8.4).gy) -
            Math.hypot((b.x1 + b.x2) / 2 - x(point(8.4).gx), (b.y1 + b.y2) / 2 - point(8.4).gy))[0];
        const tower = spawn(defenderTeam, 'archer', { gx: x((p.x1 + p.x2) / 2), gy: (p.y1 + p.y2) / 2 });
        tower.siegeAnchor = { gx: tower.gx, gy: tower.gy };
    }
    // The four exposed archers can all die before 600 steps. A real waiting
    // reserve keeps the side alive without disabling outcomes or changing combat stats.
    const reserve = addUnit(s, attackerTeam, 'infantry', x(10), 10);
    reserve.siegeWing = 'north';
    reserve.siegeStaging = { gx: reserve.gx, gy: reserve.gy };
    queueCampWalls(s); s.rebuildSpatial();
    return s;
}

test('A2: four-face player ranged chain mirrors swapped teams every step through 600', () => {
    const s = mirrorFixture(false), mirrored = mirrorFixture(true);
    const initial = [...s.units], mirroredInitial = [...mirrored.units];
    let arrowFrames = 0;
    for (let frame = 1; frame <= 600; frame++) {
        assert.equal(s.battleOver, false); assert.equal(mirrored.battleOver, false);
        step(s); step(mirrored);
        assert.deepEqual(summary(mirrored, mirroredInitial, true, true), summary(s, initial, false, true), `step ${frame}`);
        if (s.arrows.length) arrowFrames++;
    }
    assert.ok(arrowFrames > 0);
    assert.ok(initial.some(u => u.hp < u.maxHp));
});
