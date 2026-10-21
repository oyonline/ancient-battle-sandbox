import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createAssaultSim, WALL_R, MELEE_STOP_R, ASSAULT_STEP_MS as STEP, FORCE_PRESETS,
    RAM_IMPACT_MS, FLAG_RADIUS, FLAG_RATE, FLAG_WEIGHT, LADDER_QUEUE_CAPACITY, ASSAULT_COVER, TOWER_RANGE, GUARD_MELEE_CAP, wallPoint, wallParamToward,
    TOWER_HALF, WALK_INSET, viewPoint, meshPoint, bodyGap, bodyPartners, STEP_DOWN_RATE, ramButtonText, formationSizes, DEFAULT_TOWERS, TOWER_ARCHER_SLOTS, TOWER_ORIGINS, LADDERS, ladderQueueSlot, ladderQueueCapacity, gateWaitSlot, RAM_CORRIDOR, RAM_REST, RAM_HIT, BLOCK_Z, ATK_ANIM_MS, HIT_ANIM_MS, TENTS } from '../js/three-spike/camp-assault-sim.js';

const kill = u => { u.dead = true; u.hp = 0; };
const tick = (sim, count = 1) => { for (let i = 0; i < count; i++) sim.stepAssault(STEP); };
const snapshot = s => ({ result: s.result, gate: { ...s.gate }, elapsedMs: s.elapsedMs,
    flagProgress: s.flagProgress, flagNet: s.flagNet, flagAtk: s.flagAtk, retreated: s.retreated,
    units: [...s.attackers, ...s.defenders].map(u => ({
        ...u, typeData: undefined, target: u.target?.id ?? null
    })) });
function finish(sim) {
    for (let i = 0; i < 18000 && !sim.assault.result; i++) sim.stepAssault(STEP);
    assert.ok(sim.assault.result, '300s timeout');
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

const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

test('straight axial queues have .48 spacing and explicit slots beyond capacity', () => {
    for (const l of LADDERS) for (let i = 0; i < 120; i++) {
        const p = ladderQueueSlot(l, i);
        assert.ok(Math.abs((p.x - l.x) * l.nz - (p.z - l.z) * l.nx) < 1e-9);
        assert.ok(Math.abs(distance(p, l) - i * .48) < 1e-9);
        assert.equal(ladderQueueCapacity(l), LADDER_QUEUE_CAPACITY);
    }
});

test('queue claims are reserved at spawn; waiting requires reaching the current slot', () => {
    const { sim, s } = isolated(), l = s.ladders[2];
    const units = s.attackers.filter(u => u.originalRoute === 2);
    units.forEach((u, i) => {
        const p = ladderQueueSlot(l, i + 1);
        revive(u, p.x, p.z); u.cd = 100000;
    });
    s.attackers = units;
    l.climber = { dead: false, x: l.topX, z: l.topZ, zone: 'wall' };
    l.queue = units; l.waiters = [];
    tick(sim);
    assert.ok(units.every(u => u.waitState === 'queued'));
    const tail = units.at(-1); tail.x -= 2;
    tick(sim); assert.equal(tail.waitState, 'travel');
    kill(units[0]); tick(sim); assert.equal(l.queue[0], units[1]);
    s.retreated = true; tick(sim);
    assert.equal(l.climber, null); assert.deepEqual(l.queue, []); assert.deepEqual(l.waiters, []);
});

test('reserved firing, gate, ram and ladder regions are disjoint; spawn rectangles avoid other approach corridors', () => {
    const pointRect = p => ({ minX: p.x - .15, maxX: p.x + .15, minZ: p.z - .15, maxZ: p.z + .15 });
    const overlaps = (a, b) => a.minX < b.maxX - 1e-9 && a.maxX > b.minX + 1e-9 &&
        a.minZ < b.maxZ - 1e-9 && a.maxZ > b.minZ + 1e-9;
    for (const preset of Object.keys(FORCE_PRESETS)) {
        const sim = createAssaultSim(), s = sim.startAssault(preset, 12, 1);
        const waits = s.attackers.filter(u => u.gateSlot != null).map(u => gateWaitSlot(u.waitSide, u.gateSlot));
        const bows = s.attackers.filter(u => u.type === 'archer').map(u => u.fireSlot);
        const queues = s.ladders.map((l, i) => Array.from({ length: s.attackers.filter(u => u.originalRoute === i).length },
            (_, j) => ladderQueueSlot(l, j)));
        const regions = [bows.map(pointRect), waits.map(pointRect), [RAM_CORRIDOR], ...queues.map(q => q.map(pointRect))];
        for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++)
            for (const a of regions[i]) for (const b of regions[j]) assert.ok(!overlaps(a, b), `${preset} regions ${i}/${j}`);
        for (const p of bows) for (const l of LADDERS) {
            const lateral = Math.abs((p.x - l.x) * l.nz - (p.z - l.z) * l.nx);
            assert.ok(lateral >= .6 + .15, 'archer body avoids the queue strip');
        }
        for (const p of waits) for (const l of LADDERS.slice(0, 2))
            assert.ok(Math.abs(p.x - l.x) - .3 >= 1, 'gate/ladder body clearance >= 1');
        const rectangles = s.formations.map(f => {
            const units = f.units.filter(u => u.type !== 'archer');
            return { minX: Math.min(...units.map(u => u.x)) - .15, maxX: Math.max(...units.map(u => u.x)) + .15,
                minZ: Math.min(...units.map(u => u.z)) - .15, maxZ: Math.max(...units.map(u => u.z)) + .15 };
        });
        const corridors = rectangles.map((r, i) => {
            const f = s.formations[i], l = LADDERS[f.route];
            if (!l) return { ...r, minZ: MELEE_STOP_R - .15 };
            return { ...r, minX: Math.min(r.minX, l.x - .15), maxX: Math.max(r.maxX, l.x + .15),
                minZ: Math.min(r.minZ, l.z - .15), maxZ: Math.max(r.maxZ, l.z + .15) };
        });
        for (let i = 0; i < rectangles.length; i++) for (let j = 0; j < corridors.length; j++) if (i !== j)
            assert.ok(!overlaps(rectangles[i], corridors[j]), `${preset} spawn ${i}/corridor ${j}`);
    }
});

test('breached gate admits the reported outside position with ram at impact or rest', t => {
    const rows = [];
    for (const ramZ of [RAM_HIT, RAM_REST]) {
        const { sim, s } = isolated();
        const u = revive(s.attackers.find(u => u.type === 'infantry'), 1.73, 7.74);
        s.attackers = [u]; u.route = 'gate';
        s.gate.broken = true; s.ram.state = 'spent'; s.ram.z = ramZ;
        let frames = 0;
        for (; frames < 360 && u.zone === 'outside'; frames++) tick(sim);
        rows.push({ ramZ, entrySeconds: frames * STEP / 1000, zone: u.zone, via: u.enteredVia });
    }
    rows.forEach(row => t.diagnostic(JSON.stringify(row)));
    for (const row of rows) {
        assert.equal(row.zone, 'inside'); assert.equal(row.via, 'gate');
        assert.ok(row.entrySeconds < 6);
    }
});

test('seeded full battles reproduce every final unit field, result and gate hp; restart resets PRNG', () => {
    const a = createAssaultSim(), b = createAssaultSim(), c = createAssaultSim();
    a.startAssault('company', 12, 1); b.startAssault('company', 12, 1); c.startAssault('company', 12, 2);
    for (let frame = 0; frame < 18000 && !a.assault.result; frame++) {
        a.stepAssault(STEP); b.stepAssault(STEP);
        assert.deepEqual(snapshot(b.assault), snapshot(a.assault), `deterministic frame ${frame}`);
    }
    const expected = snapshot(a.assault);
    assert.ok(expected.result);
    assert.notDeepEqual(finish(c), expected);
    b.startAssault('company', 12, 1);
    assert.deepEqual(finish(b), expected);
    const elapsed = a.assault.elapsedMs;
    assert.deepEqual(a.stepAssault(STEP), []);
    assert.equal(a.assault.elapsedMs, elapsed);
    a.resetAssault(); assert.equal(a.assault.active, false); assert.equal(a.assault.attackers.length, 0);
});

test('27 full battles: A4 arrivals, signed travel progress, provenance, spacing and full-game strike peaks', t => {
    let minAttack = Infinity, minGuard = Infinity, guardOverlaps = 0, longestTravelMs = 0, peak = 0, timeouts = 0;
    let illegalSwordHits = 0, gateEntries = 0, ladderEntries = 0;
    const rows = [], details = [], violations = [], timings = [];
    const check = (ok, text) => { if (!ok && violations.length < 30) violations.push(text); };
    for (const preset of Object.keys(FORCE_PRESETS)) for (const defenders of [6, 12, 24]) {
        const outcomes = [];
        for (const seed of [1, 2, 3]) {
            const sim = createAssaultSim(), s = sim.startAssault(preset, defenders, seed);
            const entryMethods = new Map(), arrivals = new Map(), progress = new Map(), climbed = new Set(), walls = new Set(), entered = new Set();
            const wallCounts = [0, 0, 0, 0], cost = [];
            const label = `${preset}/${defenders}/${seed}`;
            let hits = 0, frames = 0;
            for (; frames < 18000 && !s.result; frames++) {
                const at = performance.now(), events = sim.stepAssault(STEP);
                const duration = performance.now() - at;
                if (preset === 'brigade' && defenders === 24) { timings.push(duration); cost.push(duration); }
                peak = Math.max(peak, events.filter(e => e.type === 'attack').length);
                for (const e of events) {
                    if (e.type === 'ram_hit') { hits++; check(e.hp === s.gate.maxHp - hits, `${label} ram hp`); }
                    if (e.type === 'attack' && e.from.team === 'blue' && e.from.type === 'infantry' &&
                        e.fromZone === 'outside' && e.toZone === 'wall') illegalSwordHits++;
                    if (e.type !== 'zone' || e.unit.team !== 'blue') continue;
                    if (e.zone === 'ladder') { check(e.previous === 'outside', `${label} ladder source`); climbed.add(e.unit.id); }
                    if (e.zone === 'wall') {
                        check(e.previous === 'ladder' && climbed.has(e.unit.id), `${label} wall source`);
                        walls.add(e.unit.id); wallCounts[e.unit.route]++;
                    }
                    if (e.zone === 'inside') {
                        if (e.via === 'gate') { check(e.gateBroken && e.previous === 'outside', `${label} gate source`); gateEntries++; }
                        else { check(e.via === 'ladder' && walls.has(e.unit.id), `${label} inside source`); ladderEntries++; }
                        entered.add(e.unit.id); entryMethods.set(e.unit.id, e.via);
                        check(e.unit.enteredVia === e.via, `${label} entry event provenance`);
                    }
                }
                for (const u of s.attackers) {
                    if (u.dead) { progress.delete(u.id); continue; }
                    check(['travel', 'staging', 'queued', 'climbing', 'firing', 'crew', 'retreat'].includes(u.waitState), `${label} state`);
                    const f = s.formations[u.formation];
                    const arrived = u.type === 'archer' ? u.waitState === 'firing' :
                        u.originalRoute === 'gate' ? u.waitState === 'staging' || u.crew && distance(u, {
                            x: u.crewSlot % 2 ? .88 : -.88, z: s.ram.z + (u.crewSlot < 2 ? -.5 : .5) }) < .18 :
                            ['queued', 'climbing'].includes(u.waitState) || ['wall', 'inside'].includes(u.zone);
                    if (arrived && !arrivals.has(u.id) && s.elapsedMs >= f.departMs)
                        arrivals.set(u.id, (s.elapsedMs - f.departMs) / 1000);
                    if (u.waitState === 'queued') check(distance(u, u.moveTarget) <= .04 + 1e-9, `${label} false queue`);
                    if (u.zone === 'outside' && u.waitState === 'staging')
                        check(distance(u, gateWaitSlot(u.waitSide, u.gateSlot)) <= .04 + 1e-9, `${label} false staging`);
                    if (typeof u.originalRoute === 'number' && s.elapsedMs - f.departMs >= 45000)
                        check(arrivals.has(u.id), `${label} ${u.squad} missed 45s id=${u.id}`);
                    if (entryMethods.has(u.id)) check(u.enteredVia === entryMethods.get(u.id), `${label} enteredVia drift`);
                    if (u.zone === 'outside' && Math.abs(u.z - s.ram.z) < 1.35)
                        check(Math.abs(u.x) >= .78 - 1e-9, `${label} moving ram corridor`);
                    if (u.zone === 'outside') check(Math.max(Math.abs(u.x), Math.abs(u.z)) >= MELEE_STOP_R - 1e-9, `${label} wall penetration`);
                    if (Math.max(Math.abs(u.x), Math.abs(u.z)) < WALL_R)
                        check(u.zone === 'inside' && entered.has(u.id), `${label} unproven inside`);
                    if (u.zone === 'inside') for (const tent of TENTS)
                        check(Math.abs(u.x - tent.x) >= tent.half + .16 - 1e-9 || Math.abs(u.z - tent.z) >= tent.half + .16 - 1e-9, `${label} tent`);
                    if (u.waitState !== 'travel' || s.elapsedMs < f.departMs || !u.moveTarget) { progress.delete(u.id); continue; }
                    let a = progress.get(u.id);
                    if (!a) { a = { x: u.x, z: u.z, target: u.moveTarget, net: 0, high: 0, since: s.elapsedMs, samples: [] }; progress.set(u.id, a); }
                    const dx = a.target.x - a.x, dz = a.target.z - a.z, d = Math.hypot(dx, dz) || 1;
                    a.net += ((u.x - a.x) * dx + (u.z - a.z) * dz) / d;
                    a.x = u.x; a.z = u.z; a.target = u.moveTarget;
                    if (a.net - a.high >= .1) { a.high = a.net; a.since = s.elapsedMs; }
                    longestTravelMs = Math.max(longestTravelMs, s.elapsedMs - a.since);
                    a.samples.push({ at: s.elapsedMs, net: a.net });
                    while (a.samples.length > 1 && s.elapsedMs - a.samples[1].at >= 4000 - 1e-6) a.samples.shift();
                    if (s.elapsedMs - a.samples[0].at >= 4000 - 1e-6)
                        check(a.net - a.samples[0].net >= .1, `${label} travel <.1/4s id=${u.id} at=${(s.elapsedMs / 1000).toFixed(2)} target=${JSON.stringify(u.moveTarget)} pos=${u.x.toFixed(2)},${u.z.toFixed(2)}`);
                }
                for (let route = 0; route < s.ladders.length; route++) {
                    const climbers = s.attackers.filter(u => !u.dead && u.zone === 'ladder' && u.route === route);
                    check(climbers.length <= 1, `${label} ladder ${route} multiple climbers`);
                    if (climbers.length) check(s.ladders[route].climber === climbers[0], `${label} ladder owner at=${s.elapsedMs} id=${climbers[0].id} pos=${climbers[0].x},${climbers[0].z} owner=${s.ladders[route].climber?.id ?? null} retreated=${s.retreated}`);
                }
                const alive = s.attackers.filter(u => !u.dead), guards = s.defenders.filter(u => !u.dead && u.zone === 'wall');
                for (let i = 0; i < alive.length; i++) for (let j = i + 1; j < alive.length; j++) {
                    const d = distance(alive[i], alive[j]); minAttack = Math.min(minAttack, d);
                    check(d >= .3 - 1e-9, `${label} attack spacing ${d}`);
                }
                for (let i = 0; i < guards.length; i++) for (let j = i + 1; j < guards.length; j++) {
                    const d = distance(guards[i], guards[j]); minGuard = Math.min(minGuard, d);
                    if (d < .45 - 1e-9) guardOverlaps++;
                }
            }
            if (!s.result || s.holdReason === 'stalemate') timeouts++;
            for (const u of s.attackers) if (!u.dead && typeof u.originalRoute === 'number')
                check(arrivals.has(u.id), `${label} ${u.squad} missed end deadline id=${u.id}`);
            if (preset === 'squad' && defenders === 24) check(s.result === 'hold', `${label} must hold`);
            if (['company', 'brigade'].includes(preset) && defenders === 12)
                check(wallCounts.every(n => n > 0), `${label} empty ladder ${wallCounts}`);
            if (s.result === 'break') check(s.flagProgress === 1, `${label} break flag`);
            if (s.gate.broken) check(hits === s.gate.maxHp, `${label} breach impacts`);
            const arrivalStats = Object.fromEntries(s.formations.map(f => {
                const times = f.units.filter(u => u.type !== 'archer').map(u => arrivals.get(u.id)).filter(v => v != null);
                return [f.name, { reached: times.length, total: f.units.filter(u => u.type !== 'archer').length,
                    first: times.length ? Math.min(...times) : null, last: times.length ? Math.max(...times) : null }];
            }));
            const sorted = [...cost].sort((a, b) => a - b);
            details.push({ preset, defenders, seed, wallCounts, arrivals: arrivalStats,
                ...(cost.length ? { meanStepMs: cost.reduce((a, b) => a + b, 0) / cost.length, p95: sorted[Math.floor(sorted.length * .95)] } : {}) });
            outcomes.push(`${s.result}@${(s.elapsedMs / 1000).toFixed(2)}s`);
        }
        rows.push({ preset, defenders, outcomes });
    }
    timings.sort((a, b) => a - b);
    // Diagnostics precede all assertions, including balance observations deferred to card C.
    details.forEach(r => t.diagnostic(JSON.stringify(r))); rows.forEach(r => t.diagnostic(JSON.stringify(r)));
    t.diagnostic(`卡 C 重调：除 squad×24 守住之外，所有平衡结果只作诊断。`);
    t.diagnostic(JSON.stringify({ minAttack, minGuard, guardOverlaps, longestTravelSeconds: longestTravelMs / 1000,
        peak, timeouts, illegalSwordHits, gateEntries, ladderEntries,
        brigade24MeanMs: timings.reduce((a, b) => a + b, 0) / timings.length,
        brigade24P95Ms: timings[Math.floor(timings.length * .95)], performanceTargetMs: 1.5, violations }));
    assert.deepEqual(violations, []); assert.equal(timeouts, 0); assert.equal(guardOverlaps, 0);
    assert.ok(minAttack >= .3); assert.ok(minGuard >= .45); assert.equal(illegalSwordHits, 0);
    assert.ok(peak <= 5); assert.ok(gateEntries > 0); assert.ok(ladderEntries > 0);
});

test('27 full battles: no melee across the fence, enemy/red bodies >= .45 apart, no rendered teleport or height drop', t => {
    // R1 墙外打不到墙上、墙上近战只打墙头、寨内只打寨内、下台阶途中不近战；
    // R3 基础渲染位置与最坏姿态（前扑峰值 + 受击后仰满值，经身位截断）的最终网格位置都 >= .45，梯上翻墙段计入；
    // R4 基础渲染位置单帧位移 <= 2 x speed x dt + .02（含换区）；R5 单帧 |dy| <= 1.25 x dt + .005
    const rows = [], violations = [];
    const check = (ok, text) => { if (!ok && violations.length < 30) violations.push(text); };
    for (const preset of Object.keys(FORCE_PRESETS)) for (const defenders of [6, 12, 24]) for (const seed of [1, 2, 3]) {
        const sim = createAssaultSim(), s = sim.startAssault(preset, defenders, seed);
        const label = `${preset}/${defenders}/${seed}`, last = new Map();
        let outsideToWall = 0, wallToOutside = 0, illegalMelee = 0, minGap = Infinity, minMesh = Infinity, maxExcess = 0;
        for (let frame = 0; frame < 18000 && !s.result; frame++) {
            for (const e of sim.stepAssault(STEP)) {
                if (e.type !== 'attack' || e.from.type === 'archer') continue;
                if (e.fromZone === 'outside' && (e.toZone === 'wall' || e.to.fixed)) outsideToWall++;
                if (e.from.team === 'red' && e.fromZone === 'wall' && e.toZone === 'outside') wallToOutside++;
                if (e.to.fixed || e.fromZone === 'outside' || e.fromZone === 'ladder' || e.fromZone === 'wall' && e.toZone !== 'wall' ||
                    e.fromZone === 'inside' && (e.toZone !== 'inside' || e.from.y > 0 || e.to.y > 0)) illegalMelee++;
            }
            const all = [...s.attackers, ...s.defenders];
            const bodies = all.filter(u => !u.dead && !u.fixed).map(u => {
                const [x, z] = viewPoint(u), [mx, mz] = meshPoint(u, .5, 1, bodyGap(u, all));
                return { u, x, z, mx, mz };
            });
            for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
                const a = bodies[i], b = bodies[j];
                if (!bodyPartners(a.u, b.u)) continue;
                const d = Math.hypot(a.x - b.x, a.z - b.z), m = Math.hypot(a.mx - b.mx, a.mz - b.mz);
                minGap = Math.min(minGap, d); minMesh = Math.min(minMesh, m);
                check(d >= .45 - 1e-9 && m >= .45 - 1e-9, `${label} R3 at=${s.elapsedMs.toFixed(0)} ${a.u.team}${a.u.id}/${a.u.zone}/y${a.u.y.toFixed(2)} ${b.u.team}${b.u.id}/${b.u.zone}/y${b.u.y.toFixed(2)} base=${d.toFixed(3)} mesh=${m.toFixed(3)}`);
            }
            for (const u of [...s.attackers, ...s.defenders]) {
                if (u.dead || u.fixed) { last.delete(u); continue; }
                const [x, z] = viewPoint(u), p = last.get(u);
                if (p) {
                    const excess = Math.hypot(x - p.x, z - p.z) - (2 * u.speed * STEP / 1000 + .02);
                    maxExcess = Math.max(maxExcess, excess);
                    check(excess <= 1e-9, `${label} R4 at=${s.elapsedMs.toFixed(0)} ${u.team}${u.id} ${p.zone}->${u.zone} excess=${excess.toFixed(3)}`);
                    const dy = Math.abs(u.y - p.y);
                    check(dy <= STEP_DOWN_RATE * STEP / 1000 + .005, `${label} R5 at=${s.elapsedMs.toFixed(0)} ${u.team}${u.id} ${p.zone}->${u.zone} dy=${dy.toFixed(3)}`);
                }
                last.set(u, { x, z, y: u.y, zone: u.zone });
            }
        }
        check(outsideToWall === 0 && wallToOutside === 0 && illegalMelee === 0, `${label} R1 outside->wall=${outsideToWall} wall->outside=${wallToOutside} illegal=${illegalMelee}`);
        check(s.result && s.holdReason !== 'stalemate', `${label} result=${s.result} reason=${s.holdReason}`);
        rows.push({ label, result: s.result, seconds: +(s.elapsedMs / 1000).toFixed(1), minGap: +minGap.toFixed(3), minMesh: +minMesh.toFixed(3), maxExcess: +maxExcess.toFixed(4) });
    }
    rows.forEach(r => t.diagnostic(JSON.stringify(r)));
    assert.deepEqual(violations, []);
    assert.equal(rows.length, 27);
});

test('five task formations keep swords ahead of pikes, bows out of ladders and seeded phase jitter', () => {
    for (const preset of Object.keys(FORCE_PRESETS)) {
        const sim = createAssaultSim(), s = sim.startAssault(preset, 12, 1), a = s.attackers;
        assert.deepEqual(s.formations.map(f => f.name), ['G', 'L0', 'L1', 'L2', 'L3']);
        assert.equal(new Set(s.formations.map(f => f.departMs)).size, 5);
        const melee = a.filter(u => u.type !== 'archer');
        for (const [i, fraction] of [.46, .15, .15, .12, .12].entries())
            assert.ok(Math.abs(melee.filter(u => u.formation === i).length - melee.length * fraction) <= 1);
        const bows = a.filter(u => u.type === 'archer');
        for (const [group, fraction] of [['G', .6], ['L2', .2], ['L3', .2]])
            assert.ok(Math.abs(bows.filter(u => u.squad === group).length - bows.length * fraction) <= 1);
        assert.equal(s.ram.crew.length, 4);
        assert.ok(s.ram.crew.every(u => u.type === 'infantry' && u.squad === 'G'));
        assert.ok(a.filter(u => u.type === 'archer').every(u => typeof u.route !== 'number'));
        for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) assert.ok(distance(a[i], a[j]) >= .3);
        for (const f of s.formations) {
            assert.ok(f.units.some(u => u.type !== 'archer'), `${preset}/${f.name} melee minimum`);
            if (!f.id) assert.ok(f.units.filter(u => u.type === 'infantry').length >= 4);
            assert.ok(f.departMs >= 0 && f.departMs <= 1500);
            assert.equal(f.speed, Math.min(...f.units.map(u => u.speed)));
            const depth = u => -(u.x - f.x) * f.dx - (u.z - f.z) * f.dz;
            const swords = f.units.filter(u => u.type === 'infantry'), pikes = f.units.filter(u => u.type === 'pikeman');
            assert.ok(Math.max(...swords.map(depth)) <= Math.min(...pikes.map(depth)) + 1e-9);
            if (f.id) assert.ok(f.units.filter(u => u.type !== 'archer').every(u => u.originalRoute === f.route));
        }
        for (const u of [...a, ...s.defenders]) {
            assert.ok(u.cd >= .2 * u.typeData.atkSpeed && u.cd <= u.typeData.atkSpeed);
            assert.ok(u.speed >= .9 * u.typeData.speed && u.speed <= 1.1 * u.typeData.speed);
        }
        const initial = s.formations.map(f => f.units.map(u => [u.x - f.x, u.z - f.z]));
        tick(sim, Math.floor(Math.min(...s.formations.map(f => f.departMs)) / STEP));
        for (const f of s.formations) for (const [i, u] of f.units.entries()) {
            assert.ok(Math.abs(u.x - f.x - initial[f.id][i][0]) < 1e-9);
            assert.ok(Math.abs(u.z - f.z - initial[f.id][i][1]) < 1e-9);
        }
    }
});

test('outside melee cannot hit the walkway: neither swords nor pikes strike across the fence', () => {
    for (const type of ['infantry', 'pikeman']) {
        const { sim, s } = isolated();
        const a = revive(s.attackers.find(u => u.type === type), -WALL_R - .8, -WALL_R);
        s.formations[a.formation].released = false; s.formations[a.formation].departMs = 100000;
        const d = revive(s.defenders[0], -WALL_R, -WALL_R, 'wall');
        d.cd = 100000;
        const before = d.hp;
        tick(sim, 1);
        assert.equal(d.hp < before, false);
    }
});

test('wall swords cannot hit outside targets, and outside swords cannot retaliate', () => {
    const { sim, s } = isolated();
    const a = revive(s.attackers.find(u => u.type === 'infantry'), -WALL_R - .6, -WALL_R);
    s.attackers = [a]; s.formations[a.formation].released = false;
    s.formations[a.formation].departMs = 100000;
    const d = revive(s.defenders[0], -WALL_R, -WALL_R, 'wall');
    const events = sim.stepAssault(STEP);
    assert.ok(!events.some(e => e.type === 'attack' && e.from === d));
    assert.equal(d.hp, d.maxHp); assert.equal(a.hp, a.maxHp);
    d.cd = 0; a.x = -WALL_R - 1.1;
    assert.ok(!sim.stepAssault(STEP).some(e => e.type === 'attack' && e.from === d));
});

test('melee zone matrix: wall melee cannot hit ladder or inside targets; inside melee cannot hit the walkway', () => {
    const l = LADDERS[2];
    const cases = [
        // [攻方 zone/坐标, 守军 zone/坐标, 说明]
        { blue: ['ladder', l.x + (l.topX - l.x) * .9, l.z, .9], red: ['wall', l.topX, l.topZ - .5, 1], text: 'wall sword vs ladder climber' },
        { blue: ['inside', -6.3, 2, 0], red: ['wall', -WALL_R, 2, 1], text: 'wall sword vs inside attacker' }
    ];
    for (const c of cases) {
        const { sim, s } = isolated();
        const a = revive(s.attackers.find(u => u.originalRoute === 2 && u.type === 'infantry'), c.blue[1], c.blue[2], c.blue[0]);
        Object.assign(a, { y: c.blue[3], route: 2, climbMs: 1600 * c.blue[3], enteredVia: 'ladder' }); s.attackers = [a];
        if (c.blue[0] === 'ladder') s.ladders[2].climber = a;
        const d = revive(s.defenders.find(u => u.type === 'infantry'), c.red[1], c.red[2], c.red[0]);
        d.homeT = wallParamToward(d.x, d.z);
        let melee = 0;
        for (let i = 0; i < 30; i++) melee += sim.stepAssault(STEP).filter(e => e.type === 'attack' &&
            (e.from === a && e.to === d || e.from === d && e.to === a) && e.fromZone !== e.toZone).length;
        assert.equal(melee, 0, c.text);
    }
});

test('reset clears gate, ram, ladder occupancy and all unit zones; restart recreates initial zones', () => {
    const sim = createAssaultSim(), s = sim.startAssault('company', 12, 1);
    s.gate.hp = 0; s.gate.broken = true; s.ram.z = RAM_HIT; s.ram.state = 'spent';
    s.attackers[0].zone = 'inside'; s.ladders[0].climber = s.attackers[0];
    s.ladders[0].queue.push(s.attackers[1]); s.ladders[0].waiters.push(s.attackers[2]);
    sim.resetAssault();
    assert.deepEqual(s.gate, { hp: 6, maxHp: 6, broken: false });
    assert.equal(s.ram.z, RAM_REST); assert.equal(s.ram.state, 'waiting');
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
    const a = revive(s.attackers.find(u => u.type === 'archer'), WALL_R + 1, WALL_R);
    const d = revive(s.defenders.find(u => u.type === 'archer'), WALL_R, WALL_R, 'wall');
    s.attackers = [a]; s.retreated = true;
    const events = sim.stepAssault(STEP);
    assert.ok(events.some(e => e.type === 'attack' && e.from === d && e.to === a));
    assert.ok(!events.some(e => e.type === 'attack' && e.from.team === 'blue'));
});

test('ram needs two living crew, recruits nearby melee, and exactly six jittered impacts break the gate', () => {
    const { sim, s } = isolated();
    const crew = s.ram.crew;
    for (const [i, u] of crew.entries()) {
        revive(u, i % 2 ? .88 : -.88, RAM_REST + (i < 2 ? -.5 : .5)); u.crew = true; u.crewSlot = i;
    }
    // Keep an archer alive so this isolated scenario cannot trigger the retreat condition.
    const bows = s.attackers.filter(u => u.type === 'archer');
    bows.forEach((u, i) => revive(u, 15 + i * .8, 15));
    s.attackers = [...crew, ...bows]; s.formations.forEach(f => { f.departMs = 0; });
    tick(sim, 60); assert.ok(s.ram.z < RAM_REST);
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
    const l = s.ladders[2];
    const a = revive(s.attackers.find(u => u.originalRoute === 2 && u.type === 'infantry'), l.x, l.z); a.route = 2;
    const b = revive(s.attackers.find(u => u !== a && u.originalRoute === 2 && u.type === 'infantry'), l.x - .6, l.z); b.route = 2;
    s.attackers = [a, b];
    const d = revive(s.defenders[0], l.topX, l.topZ, 'wall'); d.homeT = wallParamToward(d.x, d.z);
    d.cd = 100000; a.cd = 100000; b.cd = 100000;
    tick(sim); assert.equal(a.zone, 'ladder'); assert.equal(l.climber, a);
    tick(sim, 48); assert.equal(a.zone, 'ladder'); assert.ok(a.y > .49 && a.y < .51);
    tick(sim, 49); assert.equal(a.zone, 'wall'); assert.equal(a.y, 1);
    tick(sim, 90); assert.equal(a.zone, 'wall'); assert.equal(b.zone, 'outside');
    a.cd = 0; const hp = d.hp; tick(sim); assert.ok(d.hp < hp, 'sword can fight on the walkway');
    kill(d); tick(sim); assert.equal(a.zone, 'inside'); assert.equal(a.enteredVia, 'ladder'); assert.equal(a.y, 1, 'steps down from the walkway height');
});

test('climber entering from the wall top and breach blocker both step down monotonically in about .8s without melee', () => {
    const descend = (sim, u) => {
        const ys = [u.y];
        for (let i = 0; i < 120 && u.y > 0; i++) {
            const events = sim.stepAssault(STEP); ys.push(u.y);
            if (u.y > 0) assert.ok(!events.some(e => e.type === 'attack' && e.from.type !== 'archer' && (e.from === u || e.to === u)), 'no melee while stepping down');
        }
        assert.ok(ys.every((y, i) => !i || y <= ys[i - 1]), 'monotonic');
        assert.equal(u.y, 0);
        return (ys.length - 1) * STEP / 1000;
    };
    // 攻方：梯顶守军阵亡后翻入寨内
    {
        const { sim, s } = isolated(), l = s.ladders[2];
        const a = revive(s.attackers.find(u => u.originalRoute === 2 && u.type === 'infantry'), l.topX, l.topZ, 'wall');
        Object.assign(a, { route: 2, wallMs: 1000 }); l.climber = a; s.attackers = [a];
        tick(sim); assert.equal(a.zone, 'inside'); assert.equal(a.y, 1);
        const seconds = descend(sim, a);
        assert.ok(Math.abs(seconds - .8) <= .2, `attacker landed in ${seconds}s`);
    }
    // 守军：破门后下踩台去堵门
    {
        const sim = createAssaultSim({ towerPositions: [] }), s = sim.startAssault('squad', 6, 1);
        s.defenders.forEach(u => { u.cd = 1e9; });
        const keep = s.attackers.find(u => u.type === 'archer'), crew = s.ram.crew;
        s.attackers.forEach(u => { if (u !== keep && !crew.includes(u)) kill(u); }); Object.assign(keep, { x: 20, z: 20, cd: 1e9 });
        s.ram.z = RAM_HIT; s.ram.cooldown = 0; s.gate.hp = 1; s.formations.forEach(f => { f.departMs = 0; });
        for (const u of crew) Object.assign(u, { x: u.crewSlot % 2 ? .88 : -.88, z: RAM_HIT + (u.crewSlot < 2 ? -.5 : .5), cd: 1e9 });
        sim.stepAssault(STEP);
        assert.equal(s.gate.broken, true); crew.forEach(kill);
        const d = s.defenders.find(u => u.zone === 'inside');
        assert.ok(d && d.y < 1 && d.y > .9, 'blocker starts stepping down on the breach frame');
        const seconds = descend(sim, d) + STEP / 1000;
        assert.ok(Math.abs(seconds - .8) <= .2, `blocker landed in ${seconds}s`);
    }
});

test('wall guards respond to ladder/ram threats, return home, and nearest half of swords descend after breach', t => {
    const sim = createAssaultSim(), s = sim.startAssault('company', 12, 1);
    s.formations.forEach(f => { f.departMs = 100000; });
    const l = s.ladders[2], a = s.attackers.find(u => !u.crew);
    Object.assign(a, { x: l.topX, z: l.z, zone: 'wall', y: 1, wallMs: 0, route: 2, cd: 100000 }); l.climber = a;
    const ordered = s.defenders.filter(u => !u.fixed).sort((a, b) =>
        Math.hypot(a.x - l.topX, a.z - l.topZ) - Math.hypot(b.x - l.topX, b.z - l.topZ));
    const d = ordered[0];
    const homePosts = ordered.slice(3).map(u => ({ u, x: u.x, z: u.z }));
    const start = Math.hypot(d.x - l.topX, d.z - l.z);
    tick(sim, 30);
    const response = { at: s.elapsedMs, id: d.id, x: d.x, z: d.z,
        start, distance: Math.hypot(d.x - l.topX, d.z - l.z),
        homePosts: homePosts.map(({ u, x, z }) => ({ id: u.id, displacement: Math.hypot(u.x - x, u.z - z) })) };
    a.dead = true; l.climber = null; tick(sim, 120);
    const home = wallPoint(d.homeT), homeDistance = Math.hypot(d.x - home[0], d.z - home[1]);
    for (const u of s.defenders) { u.cd = 100000; }
    const swords = s.defenders.filter(u => !u.dead && !u.fixed && u.type === 'infantry');
    const expected = [...swords].sort((a, b) => distance(a, { x: 0, z: WALL_R }) - distance(b, { x: 0, z: WALL_R }))
        .slice(0, Math.ceil(swords.length / 2)).map(u => u.id).sort((a, b) => a - b);
    s.ram.z = RAM_HIT; s.ram.cooldown = 0; s.gate.hp = 1;
    // Combat can leave gaps in crewSlot; array indices are not ram slot identities.
    for (const u of s.ram.crew) Object.assign(u, { x: u.crewSlot % 2 ? .88 : -.88,
        z: RAM_HIT + (u.crewSlot < 2 ? -.5 : .5) });
    s.formations.forEach(f => { f.departMs = 0; });
    const crew = s.ram.crew.map(u => ({ id: u.id, slot: u.crewSlot, x: u.x, z: u.z, dead: u.dead }));
    const walk = new Map(swords.map(u => [u, viewPoint(u)]));
    const events = sim.stepAssault(STEP), descended = swords.filter(u => u.zone === 'inside');
    // 堵门守军就地下踩台（渲染位置不变），再沿环道走到堵门线
    const jumps = descended.map(u => Math.max(0, Math.hypot(u.x - walk.get(u)[0], u.z - walk.get(u)[1]) - 2 * u.speed * STEP / 1000));
    // Isolate the walk from the inrush: keep one idle far archer so the breached battle keeps running.
    const keep = s.attackers.find(u => u.type === 'archer');
    s.attackers.forEach(u => { if (u !== keep) kill(u); }); Object.assign(keep, { x: 20, z: 20, cd: 1e9 });
    const arrived = new Map();
    for (let i = 0; i < 600 && descended.some(u => !u.dead && !arrived.has(u)); i++) {
        const before = new Map(descended.map(u => [u, { x: u.x, z: u.z }]));
        tick(sim);
        for (const u of descended) {
            if (u.dead) continue;
            jumps.push(Math.max(0, distance(u, before.get(u)) - 2 * u.speed * STEP / 1000));
            if (!arrived.has(u) && !u.blockPath.length) arrived.set(u, { x: u.x, z: u.z, at: s.elapsedMs });
        }
    }
    t.diagnostic(JSON.stringify({ response, homeDistance, at: s.elapsedMs, crew, expected,
        events: events.map(e => e.type), descended: descended.map(u => ({ id: u.id, y: u.y, arrived: arrived.get(u) })) }));
    assert.ok(response.distance >= .5 - 1e-9 && response.distance <= 1.2 + 1e-9, 'responder flanks the ladder top one body away');
    assert.ok(response.homePosts.every(u => u.displacement < 1e-8), 'nonresponders stay at home');
    assert.ok(homeDistance < .05);
    assert.ok(events.some(e => e.type === 'gate_broken'));
    assert.equal(descended.length, Math.ceil(swords.length / 2));
    assert.deepEqual(descended.map(u => u.id).sort((a, b) => a - b), expected, 'nearest half descend');
    assert.ok(descended.every(u => u.dead || u.y === 0));
    assert.ok(jumps.every(d => d <= .02 + 1e-9), 'blockers walk to the gate line instead of teleporting');
    assert.ok(descended.every(u => u.dead || arrived.has(u) && Math.abs(arrived.get(u).z - BLOCK_Z) < .1));
});

test('defender wipe alone does not win; the flag is a net-weight tug of war that freezes on parity', () => {
    const { sim, s } = isolated();
    const a = revive(s.attackers[0], 0, 1.3, 'inside'); a.enteredVia = 'gate'; s.gate.broken = true;
    s.attackers = [a];
    assert.equal(a.type, 'infantry'); assert.equal(FLAG_WEIGHT.infantry, 10);
    // 一名剑士(10) 独自占据旗圈：净 +10 → 每帧 +10 × FLAG_RATE / 60，从 -1 起步
    tick(sim, 60); assert.equal(s.result, null);
    assert.ok(Math.abs(s.flagProgress - (-1 + 10 * FLAG_RATE)) < 1e-6, `progress=${s.flagProgress}`);
    assert.equal(s.flagAtk, 10); assert.equal(s.flagNet, 10);
    // 对等守方剑士进圈：净 0 → 进度冻结，谁也无法推进
    const d = revive(s.defenders[0], .7, 1.3, 'inside'); d.blockX = .7; d.cd = 100000;
    const held = s.flagProgress;
    tick(sim, 30); assert.equal(s.flagProgress, held); assert.equal(s.flagNet, 0); assert.equal(s.result, null);
    // 守方阵亡 → 恢复净 +10，继续推向 +1 拔旗（有效推进 2 / (10 × FLAG_RATE) = 20 秒）
    kill(d);
    let guard = 0;
    while (s.result === null && guard++ < 1300) sim.stepAssault(STEP);
    assert.equal(s.result, 'break'); assert.equal(s.flagProgress, 1);
    assert.ok(s.elapsedMs > 20000 && s.elapsedMs < 22000, `captured in ${(s.elapsedMs / 1000).toFixed(1)}s`);
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
    assert.match(source, /const \{ x: px, z: pz \} = origin/);
    assert.deepEqual(DEFAULT_TOWERS, TOWER_ORIGINS.flatMap(o => TOWER_ARCHER_SLOTS.map(p => ({ ...p, x: o.x + p.x, z: o.z + p.z }))));
    for (const l of LADDERS) for (let i = 0; i < LADDER_QUEUE_CAPACITY; i++) {
        const slot = ladderQueueSlot(l, i);
        assert.ok(Math.abs(slot.x) >= .78, 'queue slots leave the ram corridor free');
    }
    const sim = createAssaultSim(), s = sim.startAssault();
    assert.deepEqual(s.defenders.filter(u => u.fixed).map(u => ({ x: u.x, z: u.z, yaw: u.yaw })), DEFAULT_TOWERS);
    assert.match(source, /ATK_ANIM_MS, HIT_ANIM_MS/); assert.doesNotMatch(source, /const ATK_ANIM_MS/);
    assert.match(source, /Math\.floor\(\(flagP \+ 1\) \/ 2 \* 100\)/);
    assert.match(source, /flag-fill/);
    assert.doesNotMatch(logic, /FLAG_CAPTURE_MS|assault\.flagMs/);
    assert.equal(FLAG_RADIUS, 3.5); assert.equal(FLAG_RATE, .01);
    assert.deepEqual(FLAG_WEIGHT, { infantry: 10, pikeman: 7, archer: 4, cavalry: 12 });
    assert.equal(ATK_ANIM_MS, 220); assert.equal(HIT_ANIM_MS, 180);
    assert.doesNotMatch(logic, /Math\.random|Date\.|fxMs/);
    assert.doesNotMatch(source, /RAM_FIRST_MS|RAM_EVERY_MS|nextRamAt|assault\.fxMs/);
    assert.throws(() => sim.stepAssault(20), RangeError);
    assert.equal(ASSAULT_COVER, .4); assert.equal(TOWER_RANGE, 12); assert.equal(GUARD_MELEE_CAP, 2);
    for (let t = 0; t < WALL_R * 8; t += .5) {
        const [x, z] = wallPoint(t); assert.deepEqual(wallPoint(wallParamToward(x, z)), [x, z]);
    }
});


test('interior tower, tent, walkway and ladder landing clearances are >= .1', t => {
    const gap = (a, ah, b, bh) => Math.hypot(Math.max(0, Math.abs(a.x - b.x) - ah - bh),
        Math.max(0, Math.abs(a.z - b.z) - ah - bh));
    const inner = WALL_R - WALK_INSET - .3;
    const towers = TOWER_ORIGINS.map(p => ({ ...p, half: TOWER_HALF }));
    const tents = TENTS.map(p => ({ ...p, half: p.half + .05 }));
    const rows = [];
    const buildings = [...towers, ...tents];
    for (let i = 0; i < buildings.length; i++) {
        rows.push({ kind: 'walkway', i, gap: inner - Math.max(Math.abs(buildings[i].x), Math.abs(buildings[i].z)) - buildings[i].half });
        for (let j = i + 1; j < buildings.length; j++)
            rows.push({ kind: 'building', i, j, gap: gap(buildings[i], buildings[i].half, buildings[j], buildings[j].half) });
    }
    for (const [i, l] of LADDERS.entries()) for (const [j, tower] of towers.entries()) {
        const landing = { x: l.topX - l.nx * .6, z: l.topZ - l.nz * .6 };
        rows.push({ kind: 'landing', i, j, gap: gap(landing, .15, tower, tower.half) });
    }
    rows.forEach(r => t.diagnostic(JSON.stringify(r)));
    assert.ok(rows.every(r => r.gap >= .1 - 1e-9));
    // Vertical tower ladder, including rung thickness: x=-.576 +/-.03; z=+/-.136.
    assert.ok(.72 * .8 + .03 <= TOWER_HALF);
    assert.ok(.34 * .8 / 2 <= TOWER_HALF);
    const render = readFileSync(new URL('../js/three-spike/camp.js', import.meta.url), 'utf8');
    assert.match(render, /pt = 2 \* TOWER_HALF/);
    assert.match(render, /topX = l.topX \+ l.nx \* .04, topZ = l.topZ \+ l.nz \* .04/);
});

test('ram button uses simulation durability for 6/12/24 guards and retains manual mode', t => {
    const rows = [6, 12, 24].map(defenders => {
        const sim = createAssaultSim(), s = sim.startAssault('squad', defenders, 1);
        const labels = [];
        for (let hits = 0; hits <= s.gate.maxHp; hits++) {
            s.gate.hp = s.gate.maxHp - hits;
            labels.push(ramButtonText(true, s.gate, 4));
        }
        return { defenders, maxHp: s.gate.maxHp, labels };
    });
    rows.forEach(r => t.diagnostic(JSON.stringify(r)));
    for (const row of rows) for (const [hits, label] of row.labels.entries())
        assert.equal(label, `冲车撞门 (${hits}/${row.maxHp})`);
    assert.deepEqual(rows.map(r => r.maxHp), [6, 9, 12]);
    assert.equal(ramButtonText(false, null, 4), '冲车撞门 (4/6)');
    assert.equal(ramButtonText(false, null, 6), '冲车撞门');
});

test('archers reach firing within 10s when their entire melee formation is killed', t => {
    const rows = [];
    for (const combat of [false, true]) for (const formation of [3, 4]) {
        const sim = createAssaultSim(), s = sim.startAssault('squad', 6, 1);
        const f = s.formations[formation], bows = f.units.filter(u => u.type === 'archer');
        f.units.filter(u => u.type !== 'archer').forEach(kill);
        // Isolate release/arrival from lethal fire, then also replay real combat.
        // Movement correctness cannot guarantee survival after all melee cover dies.
        // Counterexamples: never releasing the formation fails released/firstFiring;
        // steering toward the wall fails firstFiring/slot distance even with damage disabled.
        if (!combat) s.defenders.forEach(u => { u.cd = 100000; });
        const firstFiring = new Map(), deaths = new Map(), drift = [];
        for (let frame = 0; frame < 600; frame++) {
            tick(sim);
            for (const u of bows) {
                if (u.dead && !deaths.has(u.id)) deaths.set(u.id, { at: s.elapsedMs, x: u.x, z: u.z });
                if (u.dead) continue;
                if (u.waitState === 'firing' && !firstFiring.has(u.id)) firstFiring.set(u.id, s.elapsedMs);
                if (firstFiring.has(u.id) && (u.waitState !== 'firing' || distance(u, u.fireSlot) > .04))
                    drift.push({ id: u.id, at: s.elapsedMs, x: u.x, z: u.z, state: u.waitState });
            }
        }
        rows.push({ combat, formation: f.name, released: f.released, drift,
            bows: bows.map(u => ({ id: u.id, dead: u.dead, state: u.waitState, x: u.x, z: u.z,
                fireSlot: u.fireSlot, firstFiring: firstFiring.get(u.id), death: deaths.get(u.id) })) });
    }
    rows.forEach(r => t.diagnostic(JSON.stringify(r)));
    for (const row of rows) {
        assert.equal(row.released, true);
        assert.deepEqual(row.drift, [], 'once firing, living bows hold their own firing slots');
        for (const u of row.bows) {
            if (!row.combat) {
                assert.equal(u.dead, false);
                assert.ok(u.firstFiring <= 10000, `id=${u.id} must reach firing within 10s`);
                assert.equal(u.state, 'firing');
                assert.ok(distance(u, u.fireSlot) <= .04);
            } else {
                assert.ok(u.death || u.firstFiring <= 10000, 'living combat bows must reach firing');
            }
        }
    }
});

test('small formation allocation preserves four gate crew and one melee per ladder', t => {
    const rows = [8, 9, 10, 30, 60, 120].map(total => ({ total, sizes: formationSizes(total) }));
    rows.forEach(r => t.diagnostic(JSON.stringify(r)));
    for (const { total, sizes } of rows) {
        assert.equal(sizes.reduce((a, b) => a + b), total);
        assert.ok(sizes[0] >= 4 && sizes.slice(1).every(n => n >= 1));
    }
});

test('forced ram abandonment takes lateral exit before retreat without dislodging firing archers or stalling', t => {
    const sim = createAssaultSim(), s = sim.startAssault('squad', 6, 1);
    s.ram.crew.forEach(kill);
    s.defenders.forEach(kill);
    // Hold replacement crew at spawn through the 8s timeout; other formations advance normally.
    s.formations[0].departMs = 8100;
    const bows = s.attackers.filter(u => u.squad === 'G' && u.type === 'archer');
    for (const u of bows) { u.x = u.fireSlot.x; u.z = u.fireSlot.z; u.waitState = 'firing'; u.moveTarget = u.fireSlot; }
    let dislodged = 0;
    for (let frame = 0; frame < 481; frame++) {
        tick(sim); dislodged += bows.filter(u => distance(u, u.fireSlot) > .04).length;
    }
    const abandoned = s.ram.state;
    const routes = s.attackers.filter(u => u.fallback).map(u => ({ id: u.id, x: u.x, path: u.fallback.map(p => ({ ...p })) }));
    const violations = [], progress = new Map();
    let longestMs = 0;
    const exits = [], crossedFire = [];
    const segmentDistance = (p, a, b) => {
        const dx = b.x - a.x, dz = b.z - a.z;
        const k = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
        return Math.hypot(p.x - a.x - k * dx, p.z - a.z - k * dz);
    };
    for (let frame = 0; frame < 5400 && !s.result; frame++) {
        const before = s.attackers.filter(u => !u.dead && u.fallback?.length).map(u => ({ u, x: u.x, z: u.z, legs: u.fallback.length }));
        tick(sim);
        for (const p of before) {
            if (p.legs === 3 && p.u.fallback.length === 2) exits.push({ id: p.u.id, x: p.u.x, z: p.u.z });
            for (const bow of bows) if (segmentDistance(bow.fireSlot, p, p.u) < .48 - 1e-9)
                crossedFire.push({ id: p.u.id, bow: bow.id, at: s.elapsedMs });
        }
        dislodged += bows.filter(u => distance(u, u.fireSlot) > .04).length;
        for (const u of s.attackers) {
            if (u.dead || u.waitState !== 'travel' || !u.moveTarget) { progress.delete(u.id); continue; }
            let p = progress.get(u.id);
            if (!p) { p = { x: u.x, z: u.z, target: u.moveTarget, net: 0, high: 0, since: s.elapsedMs }; progress.set(u.id, p); }
            const dx = p.target.x - p.x, dz = p.target.z - p.z, d = Math.hypot(dx, dz) || 1;
            p.net += ((u.x - p.x) * dx + (u.z - p.z) * dz) / d;
            p.x = u.x; p.z = u.z; p.target = u.moveTarget;
            if (p.net - p.high >= .1) { p.high = p.net; p.since = s.elapsedMs; }
            longestMs = Math.max(longestMs, s.elapsedMs - p.since);
            if (s.elapsedMs - p.since >= 4000 && violations.length < 10) violations.push({ id: u.id, x: u.x, z: u.z, target: u.moveTarget });
        }
    }
    t.diagnostic(JSON.stringify({ abandoned, routes, exits, crossedFire, longestMs, dislodged, result: s.result, violations }));
    assert.equal(abandoned, 'abandoned'); assert.ok(routes.length > 0);
    for (const row of routes) {
        assert.ok(Math.abs(row.path[0].x) >= 3.9);
        assert.ok(row.path[1].z > row.path[0].z);
        assert.equal(row.path[0].x, row.path[1].x);
    }
    assert.equal(exits.length, routes.length);
    assert.ok(exits.every(p => Math.abs(p.x) >= 3.9));
    assert.deepEqual(crossedFire, [], 'fallback segments avoid firing slots');
    assert.equal(dislodged, 0); assert.deepEqual(violations, []);
    assert.ok(s.result); assert.notEqual(s.holdReason, 'stalemate');
});

test('retreat crowd separation stays within the per-frame movement budget', () => {
    const sim = createAssaultSim({ towerPositions: [] }), s = sim.startAssault('squad', 6, 1);
    const crowd = [[4, 2, 12], [5, 2.32, 12], [6, 2.64, 12]].map(([id, x, z]) => revive(s.attackers.find(u => u.id === id), x, z));
    s.attackers.forEach(u => { if (!crowd.includes(u)) kill(u); }); s.defenders.forEach(kill);
    s.retreated = true;
    const before = crowd.map(u => ({ x: u.x, z: u.z }));
    tick(sim);
    for (const [i, u] of crowd.entries())
        assert.ok(distance(u, before[i]) <= 2 * u.speed * STEP / 1000 + .02 + 1e-9, `id=${u.id} moved ${distance(u, before[i])}`);
});

test('retreat from a front ladder restores both base coordinates before outward movement', t => {
    const { sim, s } = isolated(), l = s.ladders[0];
    // 合法的梯上状态：位置与 climbMs 一致（离梯脚只剩一帧的攀爬量），本帧爬回梯脚后才外撤
    const k = STEP / 1600;
    const u = revive(s.attackers.find(u => u.originalRoute === 0), l.x + (l.topX - l.x) * k, l.z + (l.topZ - l.z) * k, 'ladder');
    Object.assign(u, { climbMs: STEP, y: k, route: 0 }); s.attackers = [u]; l.climber = u; s.retreated = true;
    tick(sim);
    t.diagnostic(JSON.stringify({ x: u.x, z: u.z, base: { x: l.x, z: l.z }, speed: u.speed }));
    assert.equal(u.x, l.x);
    assert.ok(Math.abs(u.z - (l.z + u.speed * STEP / 1000)) < 1e-9);
    assert.equal(u.zone, 'outside'); assert.equal(u.y, 0);
    assert.equal(l.climber, null, 'ownership clears when the retreating occupant leaves');
});
