import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createAssaultSim, WALL_R, MELEE_STOP_R, ASSAULT_STEP_MS as STEP, FORCE_PRESETS,
    RAM_IMPACT_MS, FLAG_CAPTURE_MS, LADDER_QUEUE_CAPACITY, LADDER_QUEUE_SPACING, ASSAULT_COVER, TOWER_RANGE, GUARD_MELEE_CAP, wallPoint, wallParamToward,
    DEFAULT_TOWERS, TOWER_ARCHER_SLOTS, TOWER_ORIGIN, ATK_ANIM_MS, HIT_ANIM_MS, TENTS } from '../js/three-spike/camp-assault-sim.js';

const kill = u => { u.dead = true; u.hp = 0; };
const tick = (sim, count = 1) => { for (let i = 0; i < count; i++) sim.stepAssault(STEP); };
const snapshot = s => ({ result: s.result, gate: { ...s.gate }, elapsedMs: s.elapsedMs,
    flagMs: s.flagMs, retreated: s.retreated,
    units: [...s.attackers, ...s.defenders].map(u => ({
        ...u, typeData: undefined, target: u.target?.id ?? null
    })) });
function finish(sim) {
    for (let i = 0; i < 10800 && !sim.assault.result; i++) sim.stepAssault(STEP);
    assert.ok(sim.assault.result, '180s timeout');
    return snapshot(sim.assault);
}
function isolated() {
    const sim = createAssaultSim({ towerPositions: [] });
    const s = sim.startAssault('squad', 6, 1);
    s.attackers.forEach(kill); s.defenders.forEach(kill);
    s.formations.forEach(f => { f.released = true; });
    return { sim, s };
}
function revive(u, x, z, zone = 'outside') {
    Object.assign(u, { dead: false, hp: u.maxHp, x, z, zone, y: zone === 'wall' ? 1 : 0, cd: 0, crew: false });
    return u;
}

function ladderQueues(s) {
    return s.ladders.map(l => [...l.queue, ...l.waiters]);
}
function isQueued(s, u, queues) {
    const l = s.ladders[u.route], queue = queues[u.route];
    const index = queue.indexOf(u);
    if (index < 0) return false;
    const previous = queue[index - 1] ?? l.climber;
    if (!previous || previous.dead) return false;
    const target = l.slots[index] ?? { x: l.x, z: l.z + index * LADDER_QUEUE_SPACING };
    const atSlot = Math.hypot(u.x - target.x, u.z - target.z) <= .06;
    const distance = Math.hypot(u.x - target.x, u.z - target.z);
    const step = Math.min(.05, distance), k = distance > 0 ? step / distance : 0;
    const next = { x: u.x + (target.x - u.x) * k, z: u.z + (target.z - u.z) * k };
    const blocked = [...queue.filter(v => v !== u), l.climber].some(v => v && !v.dead &&
        Math.hypot(next.x - v.x, next.z - v.z) < .32);
    const pathX = Math.max(Math.min(l.x, l.topX), Math.min(Math.max(l.x, l.topX), u.x));
    const occupiedClimbPath = index === 0 && l.climber &&
        Math.hypot(u.x - pathX, u.z - l.z) <= .4;
    return atSlot || blocked || Boolean(occupiedClimbPath);
}

test('explicit ladder slots follow the previous member and recognize overflow-tail waits', () => {
    const { sim, s } = isolated();
    const l = s.ladders[0];
    const units = s.attackers.filter(u => u.type !== 'archer').slice(0, LADDER_QUEUE_CAPACITY + 2);
    units.forEach((u, i) => { revive(u, l.x, l.z + i * LADDER_QUEUE_SPACING); u.route = 0; u.cd = 100000; });
    s.attackers = units;
    l.queue = units.slice(0, LADDER_QUEUE_CAPACITY); l.waiters = units.slice(LADDER_QUEUE_CAPACITY);
    assert.equal(isQueued(s, units[0], ladderQueues(s)), false, 'empty foot must advance');
    assert.equal(isQueued(s, units.at(-1), ladderQueues(s)), true, 'overflow waits behind its predecessor');
    const frontPosition = { x: units[0].x, z: units[0].z };
    Object.assign(units[0], { x: l.x + .2, z: l.z + .325 });
    l.climber = { dead: false, x: l.topX, z: l.z };
    assert.equal(isQueued(s, units[0], ladderQueues(s)), true, 'an occupied full climb path keeps its safety margin at the foot');
    Object.assign(units[0], frontPosition); l.climber = null;
    const tail = units.at(-1), saved = { x: tail.x, z: tail.z };
    tail.x -= 3; tail.z += 3;
    assert.equal(isQueued(s, tail, ladderQueues(s)), false, 'a detached reservation with a clear path cannot excuse waiting');
    Object.assign(tail, saved);
    for (const [i, slot] of l.slots.entries()) {
        assert.ok(Math.max(Math.abs(slot.x), Math.abs(slot.z)) >= MELEE_STOP_R);
        assert.ok(Math.abs(slot.x) >= .78);
        if (i) assert.ok(Math.hypot(slot.x - l.slots[i - 1].x, slot.z - l.slots[i - 1].z) >= .3);
    }
    const oldZ = units[1].z;
    tick(sim, 12);
    assert.equal(units[0].zone, 'ladder');
    assert.ok(units[1].z < oldZ, 'successor advances toward the freed slot');
    assert.equal(l.queue[0], units[1]);
    assert.equal(l.queue.length, LADDER_QUEUE_CAPACITY);
    assert.equal(l.waiters.length, 1);
    kill(units[1]); units[2].route = 'gate';
    tick(sim);
    assert.equal(l.queue[0], units[3], 'death and route changes release slots');
    s.retreated = true; tick(sim);
    assert.equal(l.climber, null); assert.deepEqual(l.queue, []); assert.deepEqual(l.waiters, []);
});

test('ladder claims preserve arrival order when a lower-id soldier arrives later', () => {
    const { sim, s } = isolated(), l = s.ladders[0];
    const [later, first] = s.attackers.filter(u => u.type === 'infantry');
    revive(first, l.x - .85, l.z); first.route = 0;
    revive(later, l.x - 4, l.z); later.route = 0;
    s.attackers = [later, first];
    l.climber = { dead: false, x: l.topX, z: l.z, zone: 'wall' };
    tick(sim);
    assert.equal(l.queue[0], first);
    tick(sim, 120);
    assert.deepEqual(l.queue, [first, later]);
});

test('seeded full battles reproduce every final unit field, result and gate hp; restart resets PRNG', () => {
    const a = createAssaultSim(), b = createAssaultSim(), c = createAssaultSim();
    a.startAssault('company', 12, 1); b.startAssault('company', 12, 1); c.startAssault('company', 12, 2);
    const expected = finish(a);
    assert.deepEqual(finish(b), expected);
    assert.notDeepEqual(finish(c), expected);
    b.startAssault('company', 12, 1);
    assert.deepEqual(finish(b), expected);
    const elapsed = a.assault.elapsedMs;
    assert.deepEqual(a.stepAssault(STEP), []);
    assert.equal(a.assault.elapsedMs, elapsed);
    a.resetAssault(); assert.equal(a.assault.active, false); assert.equal(a.assault.attackers.length, 0);
});

test('27 full battles plus seven balance seeds: per-frame wall/entry provenance and no sword damage across walls; sampled separation and cost', t => {
    let totalIllegalDamage = 0, minDistance = Infinity, timeouts = 0, ladderEntries = 0, gateEntries = 0, fallbackHolds = 0;
    let wallMeleeHits = 0, longestStillMs = 0, longestUnjustifiedWaitMs = 0;
    const ladderRows = [], violations = [], id15Trace = [];
    let id15FootAt = null, id15ClimbAt = null;
    // Finish the matrix and print its diagnostics even when an invariant fails.
    const check = (condition, message) => { if (!condition && violations.length < 20) violations.push(message); };
    const rows = [], costs = [];
    let company24Wins = 0;
    for (const preset of Object.keys(FORCE_PRESETS)) for (const defCount of [6, 12, 24]) {
        const outcomes = [];
        const seeds = preset === 'company' && defCount === 24 ? Array.from({ length: 10 }, (_, i) => i + 1) : [1, 2, 3];
        for (const seed of seeds) {
            const sim = createAssaultSim(), s = sim.startAssault(preset, defCount, seed);
            const climbed = new Set(), reachedWall = new Set(), entered = new Map();
            let frames = 0, cost = 0, hits = 0, gateAt = null;
            const wallCounts = [0, 0], stationary = new Map(), unjustifiedWait = new Map();
            let routeStillMs = 0, unjustifiedWaitMs = 0;
            let stillPeak = null, waitPeak = null;
            const trackStill = (samples, u, eligible) => {
                if (!eligible) { samples.delete(u.id); return 0; }
                const anchor = samples.get(u.id);
                if (!anchor || Math.hypot(u.x - anchor.x, u.z - anchor.z) >= .05) {
                    samples.set(u.id, { x: u.x, z: u.z, at: s.elapsedMs });
                    return 0;
                }
                return s.elapsedMs - anchor.at;
            };
            for (; frames < 10800 && !s.result; frames++) {
                const started = performance.now();
                const events = sim.stepAssault(STEP);
                cost += performance.now() - started;
                for (const e of events) {
                    if (e.type === 'gate_broken') gateAt = e.at;
                    if (e.type === 'ram_hit') {
                        hits++; check(e.hp === s.gate.maxHp - hits, 'ram hp / impact count');
                        check(s.gate.broken === (hits === s.gate.maxHp), 'ram breach / impact count');
                    }
                    if (preset === 'company' && defCount === 12 && seed === 1 && e.type === 'attack' &&
                        e.from.team === 'red' && e.from.type === 'infantry' && e.fromZone === 'wall' && e.toZone === 'outside') wallMeleeHits++;
                    if (e.type === 'attack' && e.from.team === 'blue' && e.from.type === 'infantry' &&
                        e.fromZone === 'outside' && e.toZone === 'wall') totalIllegalDamage++;
                    if (e.type !== 'zone' || e.unit.team !== 'blue') continue;
                    if (e.zone === 'ladder') { check(e.previous === 'outside', 'ladder source'); climbed.add(e.unit.id); }
                    if (e.zone === 'wall') { check(e.previous === 'ladder' && climbed.has(e.unit.id), 'wall source'); reachedWall.add(e.unit.id); wallCounts[e.unit.route]++; }
                    if (e.zone === 'inside') {
                        if (e.via === 'gate') { check(e.gateBroken, 'entry before breach'); gateEntries++; }
                        else { check(e.via === 'ladder' && reachedWall.has(e.unit.id), 'inside source'); ladderEntries++; }
                        entered.set(e.unit.id, e.via);
                    }
                }
                const queues = ladderQueues(s);
                for (const u of s.attackers) {
                    {
                        const ladder = typeof u.route === 'number' ? s.ladders[u.route] : null;
                        const formation = s.formations[u.formation];
                        const departed = formation.released || s.elapsedMs > formation.departMs;
                        const eligible = !s.gate.broken && !s.retreated && !u.dead && !u.crew &&
                            u.zone === 'outside' && ladder && departed;
                        const footDistance = ladder ? Math.hypot(u.x - ladder.x, u.z - ladder.z) : Infinity;
                        const hasWaitReason = eligible && isQueued(s, u, queues);
                        // Preserve the < .05 displacement anchor. Only a connected queue
                        // excuses stationary units, wherever its tail is relative to the foot.
                        const stillMs = trackStill(stationary, u, eligible && !hasWaitReason);
                        if (stillMs > routeStillMs) {
                            routeStillMs = stillMs;
                            stillPeak = { id: u.id, at: s.elapsedMs / 1000, x: u.x, z: u.z };
                        }
                        const waitingAtFoot = eligible && footDistance <= 1;
                        // A legitimate queue resets the counter in the very frame its reason is observed.
                        const waitMs = trackStill(unjustifiedWait, u, waitingAtFoot && !hasWaitReason);
                        if (waitMs > unjustifiedWaitMs) {
                            unjustifiedWaitMs = waitMs;
                            waitPeak = { id: u.id, at: s.elapsedMs / 1000, x: u.x, z: u.z };
                        }
                        if (preset === 'brigade' && defCount === 12 && seed === 3 && u.id === 15) {
                            const arrived = !u.dead && footDistance <= 1 && id15FootAt == null;
                            const climbing = u.zone === 'ladder' && id15ClimbAt == null;
                            if (arrived) id15FootAt = s.elapsedMs / 1000;
                            if (climbing) id15ClimbAt = s.elapsedMs / 1000;
                            if ((frames % 120 === 0 && id15ClimbAt == null && !u.dead && !s.gate.broken) || arrived || climbing)
                                id15Trace.push({ at: +(s.elapsedMs / 1000).toFixed(3), x: +u.x.toFixed(3), z: +u.z.toFixed(3),
                                    zone: u.zone, route: u.route, approach: u.ladderApproach ?? null });
                        }
                    }
                    const r = Math.max(Math.abs(u.x), Math.abs(u.z));
                    if (u.zone === 'outside') {
                        check(r >= MELEE_STOP_R - 1e-9, `${preset}/${defCount}/${seed} frame=${frames} outside r=${r}`);
                        if (!u.dead && Math.abs(u.z - s.ram.z) < 1.35)
                            check(Math.abs(u.x) >= .78 - 1e-9, `${preset}/${defCount}/${seed} ram corridor id=${u.id}`);
                    }
                    if (r < WALL_R) check(u.zone === 'inside' && u.enteredVia === entered.get(u.id) && entered.has(u.id), 'interior entry provenance');
                    if (!u.dead && u.zone === 'inside') for (const tent of TENTS) {
                        check(Math.abs(u.x - tent.x) >= tent.half + .16 - 1e-9 ||
                            Math.abs(u.z - tent.z) >= tent.half + .16 - 1e-9, 'tent penetration');
                    }
                }
                for (const ladder of s.ladders) check(s.attackers.filter(u => !u.dead && u.zone === 'ladder' && u.route === s.ladders.indexOf(ladder)).length <= 1, 'ladder occupancy');
                if (frames % 60 === 0) {
                    const alive = s.attackers.filter(u => !u.dead);
                    for (let i = 0; i < alive.length; i++) for (let j = i + 1; j < alive.length; j++) {
                        const d = Math.hypot(alive[i].x - alive[j].x, alive[i].z - alive[j].z);
                        minDistance = Math.min(minDistance, d);
                        check(d >= .3 - 1e-9, `${preset}/${defCount}/${seed} frame=${frames} separation=${d}`);
                    }
                }
            }
            if (!s.result) timeouts++;
            if (s.holdReason === 'stalemate') fallbackHolds++;
            longestStillMs = Math.max(longestStillMs, routeStillMs);
            longestUnjustifiedWaitMs = Math.max(longestUnjustifiedWaitMs, unjustifiedWaitMs);
            ladderRows.push({ preset, defenders: defCount, seed, wallCounts, longestStillSeconds: routeStillMs / 1000,
                longestUnjustifiedWaitSeconds: unjustifiedWaitMs / 1000, stillPeak, waitPeak });
            if (preset === 'squad' && defCount >= 12) check(s.result === 'hold', `squad/${defCount}/${seed} holds`);
            if (s.result === 'break') check(s.flagMs === FLAG_CAPTURE_MS, 'flag dwell');
            outcomes.push(`${s.result}@${(s.elapsedMs / 1000).toFixed(2)}s gate=${gateAt == null ? '—' : (gateAt / 1000).toFixed(2)} hits=${hits}`);
            if (preset === 'brigade' && defCount === 24) costs.push(cost / frames);
        }
        if (preset === 'company' && defCount === 24) {
            company24Wins = outcomes.filter(o => o.startsWith('break')).length;
        }
        rows.push({ preset, defenders: defCount, outcomes });
    }
    for (const row of ladderRows) t.diagnostic(JSON.stringify(row));
    for (const row of rows) t.diagnostic(JSON.stringify(row));
    t.diagnostic(JSON.stringify({ id15FootAt, id15ClimbAt, id15Trace }));
    t.diagnostic(JSON.stringify({ battles: 34, company24Wins, timeouts, totalIllegalDamage, minDistance, gateEntries, ladderEntries,
        fallbackHolds, wallMeleeHits, longestStillSeconds: longestStillMs / 1000,
        longestUnjustifiedWaitSeconds: longestUnjustifiedWaitMs / 1000,
        brigade24MeanStepMs: costs, worstMeanStepMs: Math.max(...costs), violations }));
    assert.deepEqual(violations, []);
    assert.equal(timeouts, 0); assert.equal(totalIllegalDamage, 0);
    assert.ok(rows.filter(r => r.preset === 'brigade').some(r => r.outcomes.some(o => o.startsWith('break'))));
    assert.ok(ladderEntries > 0); assert.ok(gateEntries > 0);
    assert.equal(fallbackHolds, 0);
    assert.ok(wallMeleeHits > 0);
    for (const row of ladderRows.filter(r => ['company', 'brigade'].includes(r.preset) && r.defenders === 12))
        assert.ok(row.wallCounts.every(n => n > 0), `${row.preset}/12/${row.seed}: both ladders reach the wall`);
    assert.ok(longestStillMs < 3000, `outside ladder route stationary=${longestStillMs / 1000}s`);
    assert.ok(longestUnjustifiedWaitMs < 3000, `unjustified ladder foot wait=${longestUnjustifiedWaitMs / 1000}s`);
    assert.ok(id15Trace.some(p => p.x <= -MELEE_STOP_R), 'brigade/12/3 id 15 reaches the west face');
    assert.ok(company24Wins >= 4 && company24Wins <= 6, `company/24 seeds1..10 break=${company24Wins}`);
});

test('queued soldiers reserve the full moving climber path: every-frame separation in company/12/3', () => {
    const sim = createAssaultSim(), s = sim.startAssault('company', 12, 3);
    let minDistance = Infinity;
    while (s.result === null) {
        sim.stepAssault(STEP);
        const alive = s.attackers.filter(u => !u.dead);
        for (let i = 0; i < alive.length; i++) for (let j = i + 1; j < alive.length; j++) {
            const d = Math.hypot(alive[i].x - alive[j].x, alive[i].z - alive[j].z);
            minDistance = Math.min(minDistance, d);
            assert.ok(d >= .3 - 1e-9, `at=${s.elapsedMs} ids=${alive[i].id}/${alive[j].id} distance=${d}`);
        }
    }
    assert.ok(minDistance >= .3);
});

test('directional formations retain ordered ranks, staggered departures, initial spacing and randomized phase', () => {
    for (const preset of Object.keys(FORCE_PRESETS)) {
        const sim = createAssaultSim(), s = sim.startAssault(preset, 12, 1), a = s.attackers;
        assert.equal(s.formations.length, 3);
        assert.equal(new Set(s.formations.map(f => f.departMs)).size, 3);
        assert.ok(a.filter(u => u.z > 0 && Math.abs(u.x) < Math.abs(u.z) + 1).length / a.length >= .6);
        for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++)
            assert.ok(Math.hypot(a[i].x - a[j].x, a[i].z - a[j].z) >= .4);
        const melee = a.filter(u => u.type !== 'archer');
        for (const route of [0, 1]) assert.equal(melee.filter(u => u.route === route).length, Math.round(melee.length * .15));
        const diversionRoute = s.formations[2].x < 0 ? 0 : 1;
        assert.ok(melee.filter(u => u.route === diversionRoute).every(u => u.formation === 2));
        assert.ok(melee.filter(u => u.route === 1 - diversionRoute).every(u => u.formation !== 2));
        assert.equal(s.ram.crew.length, 4);
        assert.ok(s.ram.crew.every(u => u.type === 'infantry' && u.z > s.ram.z));
        for (const f of s.formations) {
            assert.ok(f.departMs >= 0 && f.departMs <= 1500);
            assert.equal(f.speed, Math.min(...f.units.map(u => u.speed)));
            const depth = u => -(u.x - f.x) * f.dx - (u.z - f.z) * f.dz;
            for (let i = 1; i < f.units.length; i++) assert.ok(depth(f.units[i]) >= depth(f.units[i - 1]) - 1e-9);
        }
        for (const u of [...a, ...s.defenders]) {
            assert.ok(u.cd >= .2 * u.typeData.atkSpeed && u.cd <= u.typeData.atkSpeed);
            assert.ok(u.speed >= .9 * u.typeData.speed && u.speed <= 1.1 * u.typeData.speed);
        }
        const initial = s.formations.map(f => f.units.map(u => [u.x - f.x, u.z - f.z]));
        // Crew now physically leave their ranks; collision avoidance may move their neighbours.
        // The rigid offset contract applies before departure, followed by directional group motion.
        tick(sim, Math.floor(Math.min(...s.formations.map(f => f.departMs)) / STEP));
        for (const f of s.formations) for (const [i, u] of f.units.entries()) {
            assert.ok(Math.abs(u.x - f.x - initial[f.id][i][0]) < 1e-9);
            assert.ok(Math.abs(u.z - f.z - initial[f.id][i][1]) < 1e-9);
        }
        const centres = s.formations.map(f => [f.x, f.z]);
        tick(sim, 120);
        for (const f of s.formations) {
            const dx = f.x - centres[f.id][0], dz = f.z - centres[f.id][1];
            assert.ok(dx * f.dx + dz * f.dz > 0);
            assert.ok(Math.abs(dx * f.dz - dz * f.dx) < 1e-9);
        }
    }
});

test('outside swords cannot hit the walkway; pikes can strike across the fence at range 1.6', () => {
    for (const type of ['infantry', 'pikeman']) {
        const { sim, s } = isolated();
        const a = revive(s.attackers.find(u => u.type === type), -5.8, -5);
        s.formations[a.formation].released = false; s.formations[a.formation].departMs = 100000;
        const d = revive(s.defenders[0], -5, -5, 'wall');
        d.cd = 100000;
        const before = d.hp;
        tick(sim, 1);
        assert.equal(d.hp < before, type === 'pikeman');
    }
});

test('wall swords hit outside targets with their own range, while outside swords cannot retaliate', () => {
    const { sim, s } = isolated();
    const a = revive(s.attackers.find(u => u.type === 'infantry'), -5.6, -5);
    s.attackers = [a]; s.formations[a.formation].released = false;
    s.formations[a.formation].departMs = 100000;
    const d = revive(s.defenders[0], -5, -5, 'wall');
    const events = sim.stepAssault(STEP);
    assert.ok(events.some(e => e.type === 'attack' && e.from === d && e.to === a && e.damage > 0));
    assert.equal(d.hp, d.maxHp);
    d.cd = 0; a.x = -6.1;
    assert.ok(!sim.stepAssault(STEP).some(e => e.type === 'attack' && e.from === d));
});

test('reset clears gate, ram, ladder occupancy and all unit zones; restart recreates initial zones', () => {
    const sim = createAssaultSim(), s = sim.startAssault('company', 12, 1);
    s.gate.hp = 0; s.gate.broken = true; s.ram.z = 6.45; s.ram.state = 'spent';
    s.attackers[0].zone = 'inside'; s.ladders[0].climber = s.attackers[0];
    s.ladders[0].queue.push(s.attackers[1]); s.ladders[0].waiters.push(s.attackers[2]);
    sim.resetAssault();
    assert.deepEqual(s.gate, { hp: 6, maxHp: 6, broken: false });
    assert.equal(s.ram.z, 8.2); assert.equal(s.ram.state, 'waiting');
    assert.equal(s.ram.waitingMs, 0); assert.deepEqual(s.ram.crew, []);
    assert.equal(s.holdReason, null); assert.equal(s.active, false);
    assert.equal(s.attackers.length, 0); assert.equal(s.defenders.length, 0);
    assert.ok(s.ladders.every(l => l.climber === null && l.queue.length === 0 && l.waiters.length === 0));
    sim.startAssault('company', 12, 1);
    assert.ok(s.attackers.every(u => u.zone === 'outside'));
    assert.ok(s.defenders.every(u => u.zone === (u.fixed ? 'tower' : 'wall')));
});

test('pikes replace ram crew; eight seconds without two ready crew sends gate melee to ladders', () => {
    const { sim, s } = isolated();
    const pike = revive(s.attackers.find(u => u.type === 'pikeman'), -.88, s.ram.z - .5);
    pike.route = 'gate'; s.ram.crew = [];
    const bow = revive(s.attackers.find(u => u.type === 'archer'), 20, 20);
    s.attackers = [pike, bow]; s.formations.forEach(f => { f.departMs = 0; });
    tick(sim); assert.ok(s.ram.crew.includes(pike));
    tick(sim, 480);
    assert.equal(s.ram.state, 'abandoned'); assert.equal(s.ram.crew.length, 0);
    assert.equal(pike.crew, false); assert.equal(typeof pike.route, 'number');
    assert.equal(bow.route, 'gate');
});

test('180s stalemate produces a separately identified hold and stops logical time', () => {
    const { sim, s } = isolated();
    const bow = revive(s.attackers.find(u => u.type === 'archer'), 20, 20);
    s.attackers = [bow]; s.elapsedMs = 180000 - STEP;
    const events = sim.stepAssault(STEP);
    assert.equal(s.result, 'hold'); assert.equal(s.holdReason, 'stalemate');
    assert.ok(events.some(e => e.type === 'stalemate_hold'));
    const elapsed = s.elapsedMs; tick(sim); assert.equal(s.elapsedMs, elapsed);
});

test('defenders keep firing during retreat while attackers stop fighting', () => {
    const { sim, s } = isolated();
    const a = revive(s.attackers.find(u => u.type === 'archer'), 6, 5);
    const d = revive(s.defenders.find(u => u.type === 'archer'), 5, 5, 'wall');
    s.attackers = [a]; s.retreated = true;
    const events = sim.stepAssault(STEP);
    assert.ok(events.some(e => e.type === 'attack' && e.from === d && e.to === a));
    assert.ok(!events.some(e => e.type === 'attack' && e.from.team === 'blue'));
});

test('ram needs two living crew, recruits nearby melee, and exactly six jittered impacts break the gate', () => {
    const { sim, s } = isolated();
    const crew = s.ram.crew;
    for (const [i, u] of crew.entries()) {
        revive(u, i % 2 ? .88 : -.88, 8.2 + (i < 2 ? -.5 : .5)); u.crew = true; u.crewSlot = i;
    }
    // Keep an archer alive so this isolated scenario cannot trigger the retreat condition.
    const bows = s.attackers.filter(u => u.type === 'archer');
    bows.forEach((u, i) => revive(u, 15 + i * .8, 15));
    s.attackers = [...crew, ...bows]; s.formations.forEach(f => { f.departMs = 0; });
    tick(sim, 60); assert.ok(s.ram.z < 8.2);
    crew.forEach(kill);
    const stopped = s.ram.z; tick(sim, 120); assert.equal(s.ram.z, stopped);
    assert.equal(s.ram.state, 'waiting');
    // One nearby infantry isn't enough; a second can replace a killed crew member.
    revive(crew[0], -.88, stopped - .5); crew[0].crew = false;
    tick(sim); assert.equal(s.ram.z, stopped); assert.ok(s.ram.crew.includes(crew[0]));
    revive(crew[1], .88, stopped - .5); crew[1].crew = false;
    const times = [];
    for (let i = 0; i < 1800 && !s.gate.broken; i++) for (const e of sim.stepAssault(STEP)) if (e.type === 'ram_hit') {
        times.push(e.at); assert.equal(s.gate.hp, 6 - times.length);
        assert.equal(s.gate.broken, times.length === 6);
    }
    assert.equal(times.length, 6); assert.equal(s.gate.hp, 0); assert.equal(s.ram.hp, Infinity);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= RAM_IMPACT_MS * .9 && times[i] - times[i - 1] <= RAM_IMPACT_MS * 1.1 + STEP);
});

test('single ladder occupant climbs for 1.6s, fights on top, and cannot jump past a guard', () => {
    const { sim, s } = isolated();
    const l = s.ladders[0];
    const a = revive(s.attackers.find(u => u.type === 'infantry'), l.x, l.z); a.route = 0;
    const b = revive(s.attackers.find(u => u !== a && u.type === 'infantry'), l.x - .6, l.z); b.route = 0;
    s.attackers = [a, b];
    const d = revive(s.defenders[0], -5, -1.2, 'wall'); d.homeT = wallParamToward(d.x, d.z);
    d.cd = 100000; a.cd = 100000; b.cd = 100000;
    tick(sim); assert.equal(a.zone, 'ladder'); assert.equal(l.climber, a);
    tick(sim, 48); assert.equal(a.zone, 'ladder'); assert.ok(a.y > .49 && a.y < .51);
    tick(sim, 49); assert.equal(a.zone, 'wall'); assert.equal(a.y, 1);
    tick(sim, 90); assert.equal(a.zone, 'wall'); assert.equal(b.zone, 'outside');
    a.cd = 0; const hp = d.hp; tick(sim); assert.ok(d.hp < hp, 'sword can fight on the walkway');
    kill(d); tick(sim); assert.equal(a.zone, 'inside'); assert.equal(a.enteredVia, 'ladder'); assert.equal(a.y, 0);
});

test('wall guards respond to ladder/ram threats, return home, and nearest half of swords descend after breach', () => {
    const sim = createAssaultSim(), s = sim.startAssault('company', 12, 1);
    s.formations.forEach(f => { f.departMs = 100000; });
    const l = s.ladders[0], a = s.attackers.find(u => !u.crew);
    Object.assign(a, { x: l.topX, z: l.z, zone: 'wall', y: 1, wallMs: 0, route: 0, cd: 100000 }); l.climber = a;
    const d = s.defenders.find(u => !u.fixed && u.homeT === 0);
    const start = Math.hypot(d.x - l.topX, d.z - l.z);
    tick(sim, 30); assert.ok(Math.hypot(d.x - l.topX, d.z - l.z) < start);
    a.dead = true; l.climber = null; tick(sim, 120);
    const home = wallPoint(d.homeT); assert.ok(Math.hypot(d.x - home[0], d.z - home[1]) < .05);
    for (const u of s.defenders) { u.cd = 100000; }
    const swords = s.defenders.filter(u => !u.fixed && u.type === 'infantry');
    s.ram.z = 6.45; s.ram.cooldown = 0; s.gate.hp = 1;
    for (const [i, u] of s.ram.crew.entries()) Object.assign(u, { x: i % 2 ? .88 : -.88, z: 6.45 + (i < 2 ? -.5 : .5) });
    s.formations.forEach(f => { f.departMs = 0; });
    const events = sim.stepAssault(STEP);
    assert.ok(events.some(e => e.type === 'gate_broken'));
    assert.equal(swords.filter(u => u.zone === 'inside').length, Math.ceil(swords.length / 2));
    assert.ok(swords.filter(u => u.zone === 'inside').every(u => u.y === 0 && Math.abs(u.z - 3.8) < .1));
});

test('defender wipe does not win; uncontested 5s flag dwell wins and an interruption resets progress', () => {
    const { sim, s } = isolated();
    const a = revive(s.attackers[0], 0, 1.3, 'inside'); a.enteredVia = 'gate'; s.gate.broken = true;
    s.attackers = [a];
    tick(sim, 60); assert.equal(s.result, null); assert.ok(s.flagMs > 990);
    const d = revive(s.defenders[0], .7, 1.3, 'inside'); d.blockX = .7; d.cd = 100000;
    tick(sim); assert.equal(s.flagMs, 0);
    kill(d); tick(sim, 299); assert.equal(s.result, null);
    tick(sim, 2); assert.equal(s.result, 'break'); assert.equal(s.flagMs, FLAG_CAPTURE_MS);
});

test('60% casualties before breach trigger a non-attacking 3s retreat; a breached gate suppresses morale retreat', () => {
    for (const broken of [false, true]) {
        const sim = createAssaultSim(), s = sim.startAssault('squad', 24, 1);
        s.gate.broken = broken;
        s.attackers.slice(0, Math.ceil(s.attackers.length * .6)).forEach(kill);
        tick(sim); assert.equal(s.retreated, !broken);
        if (!broken) {
            const before = new Map(s.attackers.filter(u => !u.dead).map(u => [u.id, [u.x, u.z]]));
            let attacks = 0;
            for (let i = 0; i < 181; i++) attacks += sim.stepAssault(STEP).filter(e => e.type === 'attack' && e.from.team === 'blue').length;
            assert.equal(attacks, 0); assert.equal(s.result, 'hold'); assert.equal(s.phase, '溃退');
            for (const [i, u] of s.attackers.filter(u => !u.dead).entries()) {
                const f = s.formations[u.formation];
                assert.ok(-(u.x - before.get(u.id)[0]) * f.dx - (u.z - before.get(u.id)[1]) * f.dz > 0, 'retreat toward the formation spawn side');
            }
        }
    }
    const sim = createAssaultSim(); sim.startAssault(); sim.assault.attackers.forEach(kill);
    tick(sim); assert.equal(sim.assault.result, 'hold');
});

test('tower slots and animation durations have one source shared with camp.js; pure fixed-step contract', () => {
    const source = readFileSync(new URL('../js/three-spike/camp.js', import.meta.url), 'utf8');
    const logic = readFileSync(new URL('../js/three-spike/camp-assault-sim.js', import.meta.url), 'utf8');
    assert.match(source, /for \(const \{ x: ox, z: oz, yaw \} of TOWER_ARCHER_SLOTS\)/);
    assert.match(source, /const \{ x: px, z: pz \} = TOWER_ORIGIN/);
    assert.deepEqual(DEFAULT_TOWERS, TOWER_ARCHER_SLOTS.map(p => ({ ...p, x: TOWER_ORIGIN.x + p.x, z: TOWER_ORIGIN.z + p.z })));
    const sim = createAssaultSim(), s = sim.startAssault();
    assert.deepEqual(s.defenders.filter(u => u.fixed).map(u => ({ x: u.x, z: u.z, yaw: u.yaw })), DEFAULT_TOWERS);
    assert.match(source, /ATK_ANIM_MS, HIT_ANIM_MS/); assert.doesNotMatch(source, /const ATK_ANIM_MS/);
    assert.match(source, /assault\.flagMs \/ FLAG_CAPTURE_MS \* 100/);
    assert.equal(ATK_ANIM_MS, 220); assert.equal(HIT_ANIM_MS, 180);
    assert.doesNotMatch(logic, /Math\.random|Date\.|fxMs/);
    assert.doesNotMatch(source, /RAM_FIRST_MS|RAM_EVERY_MS|nextRamAt|assault\.fxMs/);
    assert.throws(() => sim.stepAssault(20), RangeError);
    assert.equal(ASSAULT_COVER, .4); assert.equal(TOWER_RANGE, 12); assert.equal(GUARD_MELEE_CAP, 2);
    for (let t = 0; t < WALL_R * 8; t += .5) {
        const [x, z] = wallPoint(t); assert.deepEqual(wallPoint(wallParamToward(x, z)), [x, z]);
    }
});

// 卡 1 验收：运行期出手相位不退化成齐射（卡 2 返工中被误删，按卡 1 口径补回）
test('randomized strike phase stays desynchronized during the first 20 seconds', t => {
    let maxPeak = 0;
    for (const preset of ['squad', 'company', 'brigade']) for (const defCount of [6, 12, 24]) for (let seed = 1; seed <= 3; seed++) {
        const sim = createAssaultSim(), s = sim.startAssault(preset, defCount, seed);
        let peak = 0, attackFrames = 0;
        for (let frame = 0; frame < 1200 && !s.result; frame++) {
            const units = [...s.attackers, ...s.defenders], cds = units.map(u => u.cd);
            const events = sim.stepAssault(STEP);
            const strikes = events.filter(e => e.type === 'attack').length;
            const resets = units.filter((u, i) => !u.dead && u.cd > cds[i]).length;
            peak = Math.max(peak, resets, strikes);
            if (resets) attackFrames++;
        }
        maxPeak = Math.max(maxPeak, peak);
        assert.ok(peak <= 5, `${preset}/${defCount}/${seed} same-frame strike peak=${peak}`);
        if (preset === 'company' && defCount === 12) assert.ok(attackFrames > 50, `${preset}/${defCount}/${seed} attackFrames=${attackFrames}`);
    }
    t.diagnostic(`max same-frame strike peak=${maxPeak}`);
});
