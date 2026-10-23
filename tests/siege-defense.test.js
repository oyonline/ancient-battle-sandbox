import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeScene, addUnit, applyDamage } from './battle-harness.js';
import { createSiegeLayer } from '../js/battle/siege.js';
import { CAMP_LAYOUT as L } from '../js/siege3d/layout.js';
import { campBounds, queueCampWalls } from '../js/siege3d/walls.js';
import { createCampSiege, siegeDeployment, installSiegeArrows } from '../js/siege3d/deployment.js';

const DT = 1 / 60;
const distance = (a, b) => Math.hypot(a.gx - b.gx, a.gy - b.gy);
const alive = u => !u.dead && !u.withdrawn && u.hp > 0 && u.moraleState !== 'routing';
function step(s, count = 1) {
    for (let i = 0; i < count; i++) { s.simulationTime += DT * 1000; s.stepBattle(DT); }
}
function deploy(s = makeScene()) {
    s.deployUnits(L.attackers, L.defenders, 'custom', 'custom', { red: 'advance', blue: 'advance' }, { terrain: 'flat' });
    const b = campBounds();
    s.siege = createCampSiege(b, { ladders: true });
    const placements = siegeDeployment(s.units, b, s.siege);
    for (const { unit, gx, gy, siegeAnchor } of placements) Object.assign(unit, { gx, gy, pgx: gx, pgy: gy, siegeAnchor });
    queueCampWalls(s); s.rebuildSpatial();
    return s;
}
const roles = s => Object.fromEntries(['wall', 'reserve', 'archer', 'gate'].map(role =>
    [role, [...s.siege.defense.assignments].filter(([u, a]) => alive(u) && a.role === role).length]));
const digest = s => createHash('sha256').update(JSON.stringify({
    units: s.units.map(u => [u.id, u.gx, u.gy, u.hp, u.dead, u.withdrawn, u.moraleState, u.siegeDefenseRole, u.siegeClimb?.progress]),
    assignments: [...s.siege.defense.assignments].map(([u, a]) => [u.id, a.role, a.post.id]),
    gate: s.siege.gate, ram: s.siege.ram, arrows: s.arrows.map(a => ({ ...a, source: a.source?.id }))
})).digest('hex');

test('defense #1/#2: full deployment holds posts for 600 steps and covers all ladder lips at 120', t => {
    const s = deploy(), b = campBounds(), d = s.siege.defense;
    assert.deepEqual(roles(s), { wall: 162, reserve: 88, archer: 38, gate: 0 });
    const towers = s.units.filter(u => u.team === 'blue' && u.siegeAnchor);
    assert.equal(towers.length, 12);
    const towerPositions = towers.map(u => [u.gx, u.gy]);
    let coverage;
    const initialPosts = new Map([...d.assignments].map(([u, a]) => [u, a.post.id]));
    for (let frame = 1; frame <= 600; frame++) {
        step(s);
        if (frame === 120) {
            coverage = s.siege.ladders.map(l => s.units.filter(u => alive(u) && u.team === 'blue' && distance(u, l.landing) <= .8).length);
            assert.ok(coverage.every(n => n >= 2), `ladder coverage: ${coverage}`);
        }
    }
    // Newly ordered wall transfers cross the courtyard; the idle check still
    // covers reserves and guards whose original station has not changed.
    const idle = s.units.filter(u => alive(u) && u.team === 'blue' && u.type === 'infantry' &&
        Math.min(u.gx - b.x1, b.x2 - u.gx, u.gy - b.y1, b.y2 - u.gy) > 4 &&
        !(d.assignments.get(u)?.role === 'reserve' && distance(u, d.assignments.get(u).post) <= 2) &&
        !(d.assignments.get(u)?.role === 'wall' && d.assignments.get(u).post.id !== initialPosts.get(u)));
    assert.equal(idle.length, 0, `idle: ${JSON.stringify(idle.map(u => ({ id: u.id, gx: u.gx, gy: u.gy, moveX: u.moveX, moveY: u.moveY, assignment: d.assignments.get(u) })))}`);
    assert.deepEqual(roles(s), { wall: 162, reserve: 88, archer: 38, gate: 0 });
    assert.deepEqual(towers.map(u => [u.gx, u.gy]), towerPositions);
    t.diagnostic(`idle=${idle.length}; roles=${JSON.stringify(roles(s))}; towers=${towers.length}; ladderCoverage=${coverage}`);
});

test('defense #3: nearest reserve replaces a dead guard by the next 2000ms allocation', t => {
    const s = deploy(); step(s);
    const d = s.siege.defense;
    const [victim, a] = [...d.assignments].find(([, a]) => a.role === 'wall');
    const reserves = [...d.assignments].filter(([, a]) => a.role === 'reserve').map(([u]) => u);
    applyDamage(victim, 100000);
    let replacement = null, frame = 0, expected, expectedDistance;
    for (; frame < 120 && !replacement;) {
        expected = reserves.filter(alive).sort((u, v) => distance(u, a.post) - distance(v, a.post) || u.id - v.id)[0];
        expectedDistance = distance(expected, a.post);
        step(s); frame++;
        replacement = [...d.assignments].find(([u, entry]) => u !== victim && entry.post === a.post)?.[0];
    }
    assert.ok(replacement); assert.equal(replacement, expected);
    assert.ok(reserves.includes(replacement)); assert.ok(frame <= 120);
    t.diagnostic(`replacementFrame=${frame}; distance=${expectedDistance.toFixed(6)}; replacementId=${replacement.id}; roles=${JSON.stringify(roles(s))}`);
});

function breachScenario() {
    const s = deploy(), d = s.siege.defense;
    installSiegeArrows(s);
    step(s);
    const reserveCount = roles(s).reserve;
    s.siege.gate.hp = 0; // Still require the real ram impact to transition gate.broken.
    const frames = [];
    let brokenAt = null, gateCount = 0, nearby = 0, peakNearby = 0, formedAt = null, enteredAt = null, damageAt = null, forcedEntry = false;
    const hit = s.meleeImpact;
    s.meleeImpact = function (from, to, ...args) {
        if (enteredAt !== null && !from.typeData.ranged && from.team !== to.team && distance(to, d.gateCenter) <= 4.5 &&
            this.battleImpacts.some(hit => hit.from === from && hit.target === to && hit.damage > 0)) damageAt ??= frames.length + 1;
        return hit.call(this, from, to, ...args);
    };
    for (let frame = 1; frame <= 1500; frame++) {
        step(s); frames.push(digest(s));
        if (s.siege.gate.broken && brokenAt === null) {
            brokenAt = frame; gateCount = roles(s).gate;
            assert.equal(gateCount, roles(s).reserve + reserveCount + 12);
            assert.equal(roles(s).reserve, 0);
            assert.deepEqual([...new Set(d.gatePosts.map(p => Number(distance(p, d.gateCenter).toFixed(1))))], [2.5, 3.3, 4.1]);
        }
        if (brokenAt !== null) {
            if (enteredAt === null && s.units.some(u => alive(u) && u.team === 'red' && !u.siegeClimb &&
                Math.abs(u.gx - d.gateCenter.gx) < L.gateWidth / 2 && u.gy < d.gateCenter.gy && u.gy > d.gateCenter.gy - 4.5)) enteredAt = frame;
            if (frame <= brokenAt + 300) {
                nearby = s.units.filter(u => alive(u) && u.team === 'blue' && u.gy < d.gateCenter.gy && distance(u, d.gateCenter) <= 4.5).length;
                peakNearby = Math.max(peakNearby, nearby);
                if (nearby >= reserveCount * .8) formedAt ??= frame - brokenAt;
            }
            // Successful gate defense may stop every natural entrant. Exercise
            // the specified "enemy already inside" case AFTER the formation check,
            // without bypassing movement/targeting/attack during the measured steps.
            if (frame === brokenAt + 300 && enteredAt === null) {
                const invader = s.units.filter(u => alive(u) && u.team === 'red' && !u.siegeAnchor)
                    .sort((a, b) => distance(a, d.gateCenter) - distance(b, d.gateCenter) || a.id - b.id)[0];
                assert.ok(invader);
                Object.assign(invader, { gx: d.gateCenter.gx, gy: d.gateCenter.gy - .6,
                    pgx: d.gateCenter.gx, pgy: d.gateCenter.gy - .6, target: null, meleeTarget: null });
                invader.actionEpoch++;
                enteredAt = frame; forcedEntry = true;
            }
            if (frame >= brokenAt + 300 && enteredAt !== null && damageAt !== null) break;
        }
    }
    assert.notEqual(brokenAt, null); assert.notEqual(enteredAt, null); assert.notEqual(damageAt, null);
    assert.ok(damageAt <= enteredAt + 600);
    return { frames, brokenAt, gateCount, nearby, peakNearby, formedAt, reserveCount, enteredAt, damageAt, forcedEntry };
}

let breachRuns;
const getBreachRuns = () => breachRuns ??= [breachScenario(), breachScenario()];
test('defense #4: real ram breach forms gate semicircle and fights entrants', t => {
    const [first] = getBreachRuns();
    t.diagnostic(JSON.stringify({ ...first, frames: first.frames.length }));
    assert.ok(first.nearby >= first.reserveCount * .8 && first.formedAt <= 300,
        `near gate=${first.nearby}; peak=${first.peakNearby}, expected >=${first.reserveCount * .8}`);
});
test('defense #7: the breach scenario repeats exactly frame-for-frame', t => {
    const [first, second] = getBreachRuns();
    assert.deepEqual(second, first);
    t.diagnostic(`identicalBreachFrames=${first.frames.length}`);
});

test('defense #5: wall guard leash holds with a hostile in the camp center', t => {
    const s = deploy(), d = s.siege.defense;
    // The central invader exercises reserve pursuit and leaves wall targets outside their orders.
    const intruder = addUnit(s, 'red', 'infantry', d.center.gx, d.center.gy);
    let max = 0;
    const settledPosts = new Map([...d.assignments].filter(([, a]) => a.role === 'wall').map(([u, a]) => [u, a.post.id]));
    for (let frame = 0; frame < 600; frame++) {
        step(s);
        for (const [u, a] of d.assignments) if (alive(u) && a.role === 'wall') {
            // A reassigned guard must travel to its new wall before the local
            // leash applies; all settled guards retain the original assertion.
            if (settledPosts.get(u) !== a.post.id) {
                if (distance(u, a.post) > 2.5) continue;
                settledPosts.set(u, a.post.id);
            }
            max = Math.max(max, distance(u, a.post));
            assert.ok(distance(u, a.post) <= 3, `leash unit ${u.id} frame ${frame}: ${distance(u, a.post)}`);
        }
    }
    assert.ok(intruder.dead || intruder.hp < intruder.maxHp);
    t.diagnostic(`maxWallLeash=${max.toFixed(6)}; centralIntruderHp=${intruder.hp}; dead=${intruder.dead}`);
});

test('defense #6: absent, empty and explicitly disabled layers have identical gx/gy/hp/dead trajectories', t => {
    function run(mode) {
        const s = makeScene();
        for (let i = 0; i < 6; i++) { addUnit(s, 'red', 'infantry', 30, 27 + i); addUnit(s, 'blue', 'infantry', 36, 27 + i); }
        if (mode === 'empty') s.siege = createSiegeLayer([]);
        if (mode === 'disabled') s.siege = createSiegeLayer([], { defense: false });
        const frames = [];
        for (let i = 0; i < 600; i++) { step(s); frames.push(s.units.map(u => [u.gx, u.gy, u.hp, u.dead])); }
        return frames;
    }
    const absent = run('absent');
    assert.deepEqual(run('empty'), absent); assert.deepEqual(run('disabled'), absent);
    t.diagnostic('three trajectories deepEqual; frames=600; gx/gy/hp/dead exact');
});

test('defense: redeployment resets assignments, threat, gate posts and role ownership', () => {
    const s = deploy(), old = s.siege.defense;
    step(s, 120);
    deploy(s); step(s);
    assert.notEqual(s.siege.defense, old);
    assert.equal(s.siege.defense.gatePosts.length, 0);
    assert.deepEqual(roles(s), { wall: 162, reserve: 88, archer: 38, gate: 0 });
    assert.ok([...s.siege.defense.assignments.keys()].every(u => s.units.includes(u) && u.team === 'blue' && !u.siegeAnchor));
});

test('defense: routing frees posts and an exhausted reserve pool draws a wall donor', t => {
    const s = makeScene(), b = campBounds();
    s.checkWin = () => {}; // Isolate order replacement, with no opposing army.
    s.siege = createCampSiege(b);
    for (let i = 0; i < 10; i++) addUnit(s, 'blue', 'infantry', b.cx + i * .1, b.cy);
    queueCampWalls(s); step(s);
    const d = s.siege.defense, before = [...d.assignments];
    const [victim, assignment] = before.find(([, a]) => a.role === 'wall');
    for (const [u, a] of before) if (a.role === 'reserve') u.moraleState = 'routing';
    applyDamage(victim, 100000); step(s, 120);
    const replacement = [...d.assignments].find(([, a]) => a.post === assignment.post)?.[0];
    assert.ok(replacement && replacement !== victim);
    assert.ok(before.some(([u, a]) => u === replacement && a.role === 'wall'));
    assert.ok([...d.assignments.keys()].every(alive));
    t.diagnostic(`wallDonor=${replacement.id}; remaining=${JSON.stringify(roles(s))}`);
});

test('defense: reserve seeks an interior intruder beyond 12 cells', t => {
    const s = makeScene(), b = campBounds();
    s.siege = createCampSiege(b);
    const defender = addUnit(s, 'blue', 'infantry', b.x1 + 1, b.y1 + 1);
    const invader = addUnit(s, 'red', 'infantry', b.x2 - 1, b.y2 - 1);
    queueCampWalls(s);
    const initial = distance(defender, invader);
    step(s, 60);
    assert.equal(defender.siegeDefenseRole, 'reserve');
    assert.equal(defender.meleeTarget, invader);
    assert.ok(initial > 12 && distance(defender, invader) < initial - 1);
    t.diagnostic(`reserveEngagementDistance=${initial.toFixed(6)} -> ${distance(defender, invader).toFixed(6)}`);
});

test('defense: breach excludes defenders who routed or died between allocation ticks', () => {
    const s = makeScene(), b = campBounds();
    s.checkWin = () => {};
    s.siege = createCampSiege(b);
    for (let i = 0; i < 20; i++) addUnit(s, 'blue', 'infantry', b.cx + (i % 5 - 2), b.cy + Math.floor(i / 5));
    queueCampWalls(s); step(s);
    const d = s.siege.defense, entries = [...d.assignments];
    const [routed] = entries.find(([, a]) => a.role === 'reserve');
    const [dead] = entries.find(([, a]) => a.role === 'wall');
    routed.moraleState = 'routing'; applyDamage(dead, 100000);
    s.siege.gate.broken = true; // Isolate the reaction between two allocation ticks.
    step(s);
    const gate = [...d.assignments].filter(([, a]) => a.role === 'gate');
    assert.ok(gate.length > 0);
    assert.ok(gate.every(([u]) => alive(u) && u !== routed && u !== dead));
    assert.notEqual(d.assignments.get(routed)?.role, 'gate');
    assert.notEqual(d.assignments.get(dead)?.role, 'gate');
});

// Keep the real step pipeline, movement and morale; remove attackers only when
// measuring a steady allocation independently of casualty/threat changes.
function quietDeployment() {
    const s = deploy();
    for (const u of s.units) if (u.team === 'red') u.withdrawn = true;
    s.checkWin = () => {};
    step(s, 121); // Initial tick plus one threat refresh to settle archer quotas.
    return s;
}
function recordAssignments(d) {
    const calls = [], set = d.assignments.set;
    d.assignments.set = function (unit, assignment) {
        calls.push({ unit, ...assignment });
        return set.call(this, unit, assignment);
    };
    return calls;
}

test('defense a: 1200 steady steps never reassign unchanged posts or clear their state', t => {
    const s = quietDeployment(), d = s.siege.defense;
    const calls = recordAssignments(d), perCycle = [];
    const original = new Map(d.assignments), siegeStep = s.siege.step;
    let allocationChecks = 0;
    // Observe immediately around allocation, before ordinary per-frame AI can
    // update targets or navigation. Existing state must survive unchanged.
    s.siege.step = function (...args) {
        const snapshots = [...d.assignments].map(([u]) => [u, u.target, u.meleeTarget, u.strafeUntil,
            u.blockedEngageAt, u.groundGuardReturning, s.navigation?.routes.get(u)]);
        siegeStep.apply(this, args);
        for (const [u, target, melee, strafe, blocked, returning, route] of snapshots) {
            assert.equal(d.assignments.get(u), original.get(u));
            assert.equal(u.target, target); assert.equal(u.meleeTarget, melee);
            assert.equal(u.strafeUntil, strafe); assert.equal(u.blockedEngageAt, blocked);
            assert.equal(u.groundGuardReturning, returning);
            assert.equal(s.navigation?.routes.get(u), route);
        }
        allocationChecks++;
    };
    for (let cycle = 0; cycle < 10; cycle++) {
        const before = calls.length;
        step(s, 120); perCycle.push(calls.length - before);
    }
    assert.deepEqual(perCycle, Array(10).fill(0));
    assert.equal(allocationChecks, 1200);
    t.diagnostic(`assignCallsPer2000ms=${perCycle}; unchangedUnits=${original.size}; checkedFrames=${allocationChecks}`);
});

test('defense b: drawing one reserve into a vacancy leaves every other reserve slot fixed', t => {
    const s = quietDeployment(), d = s.siege.defense;
    const before = new Map([...d.assignments].filter(([, a]) => a.role === 'reserve')
        .map(([u, a]) => [u, { ...a.post }]));
    const [victim] = [...d.assignments].find(([, a]) => a.role === 'wall');
    const calls = recordAssignments(d);
    victim.withdrawn = true; step(s, 120);
    let preserved = 0;
    for (const [u, post] of before) if (d.assignments.get(u)?.role === 'reserve') {
        assert.deepEqual(d.assignments.get(u).post, post); preserved++;
    }
    assert.equal(preserved, before.size - 1);
    assert.equal(calls.length, 1);
    t.diagnostic(`fixedReserveSlots=${preserved}; vacancy=1; assignCalls=${calls.length}`);
});

test('defense c: breach fills three semicircle ranks and one overflow rank, nearest troops first', t => {
    const s = quietDeployment(), d = s.siege.defense;
    // Normal 100-man muster fits three ranks; extra reserves exercise overflow.
    for (let i = 0; i < 30; i++) addUnit(s, 'blue', 'infantry', d.center.gx + (i % 10) * .2, d.center.gy + Math.floor(i / 10));
    step(s, 120);
    const positions = new Map(s.units.map(u => [u, { gx: u.gx, gy: u.gy }]));
    s.siege.gate.broken = true; step(s);
    const radii = [...new Set(d.gatePosts.map(p => Number(distance(p, d.gateCenter).toFixed(1))))];
    assert.deepEqual(radii, [2.5, 3.3, 4.1, 4.9]);
    const entries = [...d.assignments].filter(([, a]) => a.role === 'gate');
    const counts = radii.map(r => entries.filter(([, a]) => Math.abs(distance(a.post, d.gateCenter) - r) < 1e-8).length);
    assert.deepEqual(counts.slice(0, 3), [31, 41, 51]);
    for (let row = 0; row < radii.length - 1; row++) {
        const front = entries.filter(([, a]) => Math.abs(distance(a.post, d.gateCenter) - radii[row]) < 1e-8);
        const rear = entries.filter(([, a]) => distance(a.post, d.gateCenter) > radii[row] + .1);
        assert.ok(Math.max(...front.map(([u]) => distance(positions.get(u), d.gateCenter))) <=
            Math.min(...rear.map(([u]) => distance(positions.get(u), d.gateCenter))) + 1e-8);
        const angles = front.map(([, a]) => Math.atan2(d.gateCenter.gy - a.post.gy, a.post.gx - d.gateCenter.gx)).sort((a, b) => a - b);
        for (let i = 1; i < angles.length; i++) assert.ok(Math.abs(angles[i] - angles[i - 1] - Math.PI / angles.length) < 1e-8);
    }
    t.diagnostic(`gateRadii=${radii}; rankCounts=${counts}`);
});

test('defense d: deployed wall guards stand at walkway height through the first step', t => {
    const s = deploy(), d = s.siege.defense;
    const guards = [...d.assignments].filter(([, a]) => a.role === 'wall');
    const height = L.walkwayHeight / L.worldHeightScale;
    for (const [u] of guards) assert.equal(s.siege.heightAt(u.gx, u.gy), height);
    step(s);
    for (const [u, a] of guards) {
        assert.equal(s.siege.heightAt(a.post.gx, a.post.gy), height);
        assert.equal(s.siege.heightAt(u.gx, u.gy), height, `guard ${u.id} left walkway`);
    }
    t.diagnostic(`guardsOnWalkway=${guards.length}; height=${height}`);
});

test('defense e: a threat spike moves at most eight wall guards per 2000ms and keeps ladder lips', t => {
    const s = quietDeployment(), d = s.siege.defense, b = campBounds();
    const before = new Map([...d.assignments].filter(([, a]) => a.role === 'wall'));
    const countWest = () => [...d.assignments.values()].filter(a => a.role === 'wall' && a.post.side === 'west').length;
    const westBefore = countWest();
    for (let i = 0; i < 20; i++) {
        const enemy = addUnit(s, 'red', 'infantry', b.x1 - 6, b.cy - 5 + i * .5);
        enemy.typeData = { ...enemy.typeData, speed: 0 };
    }
    const calls = recordAssignments(d);
    step(s, 119);
    assert.equal(countWest(), westBefore, 'threat rebalance must wait until the next 2000ms tick');
    step(s);
    const moves = calls.filter(a => a.role === 'wall');
    assert.ok(countWest() > westBefore);
    assert.equal(moves.length, 8);
    assert.equal(new Set(moves.map(a => a.unit)).size, moves.length);
    for (const [u, a] of before) if (a.post.priority === 0) assert.equal(d.assignments.get(u), a);
    const unchanged = [...before].filter(([u, a]) => d.assignments.get(u) === a).length;
    assert.equal(unchanged, before.size - moves.length);
    t.diagnostic(`westGuards=${westBefore}->${countWest()}; wallAssignCalls=${moves.length}; unchangedWallGuards=${unchanged}`);
});

test('defense f: owned defenders use original fallback and routing handlers before defense orders', t => {
    const s = quietDeployment(), d = s.siege.defense;
    const [u, a] = [...d.assignments].find(([, a]) => a.role === 'reserve');
    const enemy = addUnit(s, 'red', 'infantry', u.gx - 2, u.gy);
    const fallback = s.updateFallingBackUnit, routed = s.updateRoutedUnit, act = d.act;
    let fallbackCalls = 0, routedCalls = 0, defenseCalls = 0;
    s.updateFallingBackUnit = function (unit, ...args) {
        const result = fallback.call(this, unit, ...args);
        if (unit === u && result) fallbackCalls++;
        return result;
    };
    s.updateRoutedUnit = function (unit, ...args) {
        if (unit === u) routedCalls++;
        return routed.call(this, unit, ...args);
    };
    d.act = function (scene, unit, ...args) {
        if (unit === u) defenseCalls++;
        return act.call(this, scene, unit, ...args);
    };
    u.moraleState = 'wavering'; u.moraleFallBackUntil = s.simulationTime + 5000;
    step(s);
    assert.equal(fallbackCalls, 1); assert.equal(defenseCalls, 0);
    assert.ok(u.moveX > 0, `fallback must retreat from enemy ${enemy.id}`);
    assert.equal(d.assignments.get(u), a);
    u.moraleState = 'routing'; u.moraleSheltered = false;
    step(s);
    assert.equal(routedCalls, 1); assert.equal(defenseCalls, 0); assert.equal(d.owns(u), false);
    assert.ok(Math.hypot(u.moveX, u.moveY) > 0);
    t.diagnostic(`originalFallbackCalls=${fallbackCalls}; originalRoutingCalls=${routedCalls}; defenseCalls=${defenseCalls}`);
});

test('defense: archer quota changes preserve posts on unchanged faces and surviving slots', t => {
    const s = quietDeployment(), d = s.siege.defense;
    const before = new Map([...d.assignments].filter(([, a]) => a.role === 'archer'));
    const [victim] = [...before].find(([, a]) => a.post.side === 'south');
    victim.withdrawn = true;
    const calls = recordAssignments(d); step(s, 120);
    let retained = 0;
    for (const [u, a] of before) if (u !== victim && !calls.some(c => c.unit === u)) {
        assert.equal(d.assignments.get(u), a); retained++;
    }
    for (const [u, a] of before) if (['west', 'east'].includes(a.post.side)) assert.equal(d.assignments.get(u), a);
    assert.equal(retained, before.size - 2);
    assert.equal(calls.length, 1);
    t.diagnostic(`archerPostsRetained=${retained}; archerAssignCalls=${calls.length}`);
});

test('defense: wall and gate targeting query only the local spatial index', t => {
    const s = quietDeployment(), d = s.siege.defense;
    const near = s.forEachNear, targetFor = d.targetFor;
    let selecting = null, queries = 0, inspected = 0;
    d.targetFor = function (scene, unit) {
        const a = this.assignments.get(unit);
        if (a.role === 'wall' || a.role === 'gate') selecting = { unit, post: a.post };
        try { return targetFor.call(this, scene, unit); } finally { selecting = null; }
    };
    s.forEachNear = function (gx, gy, r, fn) {
        if (selecting) {
            assert.equal(gx, selecting.post.gx); assert.equal(gy, selecting.post.gy);
            assert.equal(r, 2.5 + selecting.unit.typeData.range + .5); queries++;
        }
        return near.call(this, gx, gy, r, u => { if (selecting) inspected++; fn(u); });
    };
    step(s);
    const wallQueries = queries;
    assert.equal(wallQueries, roles(s).wall);
    s.siege.gate.broken = true; step(s, 120);
    assert.ok(queries > wallQueries);
    assert.ok(inspected < queries * s.units.length);
    t.diagnostic(`wallQueriesFirstStep=${wallQueries}; localQueries=${queries}; inspected=${inspected}; fullScanEquivalent=${queries * s.units.length}`);
});

test('defense: wall threat ratios below 1.5 do not trigger transfers', t => {
    const s = quietDeployment(), d = s.siege.defense, b = campBounds();
    for (const [gx, gy] of [[b.x1 - 6, b.cy], [b.cx, b.y1 - 6], [b.x2 + 6, b.cy], [b.cx, b.y2 + 6]]) {
        const enemy = addUnit(s, 'red', 'infantry', gx, gy);
        enemy.typeData = { ...enemy.typeData, speed: 0 };
    }
    const calls = recordAssignments(d);
    step(s, 120);
    const ratios = Object.entries(d.threat).map(([side, threat]) => threat /
        [...d.assignments.values()].filter(a => a.role === 'wall' && a.post.side === side).length);
    const spread = Math.max(...ratios) / Math.min(...ratios);
    assert.ok(spread < 1.5 && spread > 1);
    assert.equal(calls.filter(a => a.role === 'wall').length, 0);
    t.diagnostic(`threatRatioSpread=${spread.toFixed(6)}; wallAssignCalls=0`);
});
