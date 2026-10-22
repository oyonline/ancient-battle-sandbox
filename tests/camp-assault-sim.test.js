import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createAssaultSim, WALL_R, MELEE_STOP_R, ASSAULT_STEP_MS as STEP, FORCE_PRESETS,
    RAM_IMPACT_MS, FLAG_RADIUS, FLAG_RATE, FLAG_WEIGHT, LADDER_QUEUE_CAPACITY, ASSAULT_COVER, TOWER_RANGE, GUARD_MELEE_CAP, wallPoint, wallParamToward,
    TOWER_HALF, WALK_INSET, wallFace, viewPoint, meshPoint, bodyGap, bodyPartners, ramButtonText, formationSizes, DEFAULT_TOWERS, TOWER_ARCHER_SLOTS, TOWER_ORIGINS, LADDERS, ladderQueueSlot, ladderQueueCapacity, gateWaitSlot, RAM_CORRIDOR, RAM_REST, RAM_HIT, BLOCK_Z, ATK_ANIM_MS, HIT_ANIM_MS, TENTS,
    INNER_LADDERS, INNER_RAIL_TOP_R, INNER_RAIL_FOOT_R, innerFootSlot, innerTopSlot, TOWER_LADDERS, towerFootSlot, TOWER_Y, TOWER_TOP_CAP,
    CLIMB_RATE, ARCHER_MELEE_FACTOR, CLIMB_QUEUE_CAPACITY, GATE_HALF, alongT, CLIMB_ZONES, LANE_W, MATE_GAP, GRANT_PATIENCE_MS } from '../js/three-spike/camp-assault-sim.js';
import { calculateAttackDamage } from '../js/units.js';
import { CAMP_RULES } from '../js/battle/camps.js';
const MAX_DY_RATE = 1.25;   // R5：每帧 |Δy| <= 1.25 × dt + .005

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
function isolated(preset = 'squad', mode = 'flag') {
    const sim = createAssaultSim({ towerPositions: [] });
    const s = sim.startAssault(preset, 6, 1, mode);
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
    // 8 架梯子后 squad 每架只有 2 人（杀 1 人即触发溃退），改用 company（每架 4 人）
    const { sim, s } = isolated('company'), l = s.ladders[2];
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
        // 每架攻城梯：梯身占地（梯脚到墙线，横向 ±.175）+ 梯脚队列，各自一组
        const queues = s.ladders.map((l, i) => [{ minX: Math.min(l.x, l.topX) - (l.nz ? .175 : 0), maxX: Math.max(l.x, l.topX) + (l.nz ? .175 : 0),
            minZ: Math.min(l.z, l.topZ) - (l.nx ? .175 : 0), maxZ: Math.max(l.z, l.topZ) + (l.nx ? .175 : 0) },
        ...Array.from({ length: s.attackers.filter(u => u.originalRoute === i).length }, (_, j) => pointRect(ladderQueueSlot(l, j)))]);
        assert.equal(queues.length, 8);
        const regions = [bows.map(pointRect), waits.map(pointRect), [RAM_CORRIDOR], ...queues];
        for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++)
            for (const a of regions[i]) for (const b of regions[j]) assert.ok(!overlaps(a, b), `${preset} regions ${i}/${j}`);
        for (const p of bows) for (const l of LADDERS) {
            const lateral = Math.abs((p.x - l.x) * l.nz - (p.z - l.z) * l.nx);
            assert.ok(lateral >= .6 + .15, 'archer body avoids the queue strip');
        }
        for (const p of waits) for (const l of LADDERS.filter(l => l.nz === 1))
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
    let minAttack = Infinity, minGuard = Infinity, minWallMate = Infinity, guardOverlaps = 0, longestTravelMs = 0, peak = 0, timeouts = 0;
    let illegalSwordHits = 0, gateEntries = 0, ladderEntries = 0;
    const rows = [], details = [], violations = [], timings = [];
    const check = (ok, text) => { if (!ok && violations.length < 30) violations.push(text); };
    for (const preset of Object.keys(FORCE_PRESETS)) for (const defenders of [6, 12, 24]) {
        const outcomes = [];
        for (const seed of [1, 2, 3]) {
            const sim = createAssaultSim(), s = sim.startAssault(preset, defenders, seed);
            const entryMethods = new Map(), arrivals = new Map(), progress = new Map(), climbed = new Set(), walls = new Set(), entered = new Set();
            const wallCounts = LADDERS.map(() => 0), cost = [];
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
                    // 上墙：攻城梯翻墙，或从寨内经木梯爬回墙头；下寨：破门入口，或经寨内木梯/塔梯下到地面
                    if (e.zone === 'wall') {
                        check(e.previous === 'ladder' && climbed.has(e.unit.id) || e.previous === 'iladder' && entered.has(e.unit.id), `${label} wall source`);
                        if (e.previous === 'ladder') { walls.add(e.unit.id); wallCounts[e.unit.route]++; }
                    }
                    if (e.zone === 'iladder') check(e.previous === 'wall' || e.previous === 'inside' && entered.has(e.unit.id), `${label} inner ladder source`);
                    if (e.zone === 'tladder' || e.zone === 'tower') check(entered.has(e.unit.id), `${label} tower source`);
                    if (e.zone === 'inside') {
                        if (e.previous === 'outside') { check(e.via === 'gate' && e.gateBroken, `${label} gate source`); gateEntries++; }
                        else if (e.previous === 'iladder' && !entered.has(e.unit.id)) { check(e.via === 'ladder' && walls.has(e.unit.id), `${label} inside source`); ladderEntries++; }
                        else check(entered.has(e.unit.id) && (e.previous === 'iladder' || e.previous === 'tladder'), `${label} re-entry source ${e.previous}`);
                        entered.add(e.unit.id); if (!entryMethods.has(e.unit.id)) entryMethods.set(e.unit.id, e.via);
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
                        check(['inside', 'iladder', 'tladder', 'tower'].includes(u.zone) && (entered.has(u.id) || u.zone === 'iladder' && walls.has(u.id)), `${label} unproven inside`);
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
                // 地面层人群（墙外、攻城梯、寨内、木梯/塔梯）互相 >= .3；踩台单列与塔顶的攻方另有分层规则，不按平面坐标比
                const alive = s.attackers.filter(u => !u.dead && u.zone !== 'tower' && !(u.zone === 'wall' && u.leftTop)),
                    guards = s.defenders.filter(u => !u.dead && u.zone === 'wall');
                for (let i = 0; i < alive.length; i++) for (let j = i + 1; j < alive.length; j++) {
                    const d = distance(alive[i], alive[j]); minAttack = Math.min(minAttack, d);
                    check(d >= .3 - 1e-9, `${label} attack spacing ${d}`);
                }
                // 墙头层的攻方（踩台、攻城梯翻墙段、木梯上段）按渲染位置互相 >= MATE_GAP（错身走内外道，平面坐标可重合）
                const top = s.attackers.filter(u => !u.dead && (u.zone === 'wall' || u.zone === 'ladder' && u.y >= .8 || u.zone === 'iladder' && u.y >= .7))
                    .map(u => { const [x, z] = viewPoint(u); return { u, x, z }; });
                for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
                    const d = distance(top[i], top[j]); minWallMate = Math.min(minWallMate, d);
                    check(d >= MATE_GAP - 1e-9, `${label} wall mates ${top[i].u.id}/${top[j].u.id} ${d.toFixed(3)} at=${s.elapsedMs.toFixed(0)}`);
                }
                // 踩台有让行内外道（红方错身时平面坐标可重合），守军间距按渲染位置量
                const guardViews = guards.map(u => { const [x, z] = viewPoint(u); return { x, z }; });
                for (let i = 0; i < guards.length; i++) for (let j = i + 1; j < guards.length; j++) {
                    const d = distance(guardViews[i], guardViews[j]); minGuard = Math.min(minGuard, d);
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
    t.diagnostic(JSON.stringify({ minAttack, minGuard, minWallMate, guardOverlaps, longestTravelSeconds: longestTravelMs / 1000,
        peak, timeouts, illegalSwordHits, gateEntries, ladderEntries,
        brigade24MeanMs: timings.reduce((a, b) => a + b, 0) / timings.length,
        brigade24P95Ms: timings[Math.floor(timings.length * .95)], performanceTargetMs: 1.5, violations }));
    assert.deepEqual(violations, []); assert.equal(timeouts, 0); assert.equal(guardOverlaps, 0);
    assert.ok(minAttack >= .3); assert.ok(minGuard >= .45); assert.equal(illegalSwordHits, 0);
    assert.ok(peak <= 5); assert.ok(gateEntries > 0); assert.ok(ladderEntries > 0);
});

test('54 full battles (flag + deathmatch): no melee across the fence, enemy/red bodies >= .45 apart, no rendered teleport or height jump', t => {
    // R1 墙外打不到墙上、墙上近战只打墙头、寨内只打寨内同层；攀爬途中（攻城梯/寨内木梯/塔梯）不近战也不被近战；
    //    塔上近战只限同一座塔的塔顶（攻方打弓手、被贴身弓手还手）；
    // R3 基础渲染位置与最坏姿态（前扑峰值 + 受击后仰满值，经身位截断）的最终网格位置都 >= .45，梯上翻墙段、
    //    木梯/塔梯攀爬者、塔顶攻方与同塔弓手都计入；
    // R4 基础渲染位置单帧位移 <= 2 x speed x dt + .02（含换区）；R5 单帧 |dy| <= 1.25 x dt + .005
    const rows = [], violations = [];
    const check = (ok, text) => { if (!ok && violations.length < 30) violations.push(text); };
    for (const mode of ['flag', 'deathmatch'])
    for (const preset of Object.keys(FORCE_PRESETS)) for (const defenders of [6, 12, 24]) for (const seed of [1, 2, 3]) {
        const sim = createAssaultSim(), s = sim.startAssault(preset, defenders, seed, mode);
        const label = `${mode}/${preset}/${defenders}/${seed}`, last = new Map(), holders = new Map();
        let stuckLate = 0;
        let outsideToWall = 0, wallToOutside = 0, illegalMelee = 0, minGap = Infinity, minMesh = Infinity, maxExcess = 0;
        for (let frame = 0; frame < 18000 && !s.result; frame++) {
            for (const e of sim.stepAssault(STEP)) {
                if (e.type !== 'attack') continue;
                if (e.melee) {
                    // 被贴身的塔上弓手近战还手：只打同塔塔顶的攻方
                    if (!(e.from.fixed && e.toZone === 'tower' && e.to.tower === e.from.tower)) illegalMelee++;
                    continue;
                }
                if (e.from.type === 'archer') continue;
                if (e.fromZone === 'outside' && (e.toZone === 'wall' || e.to.fixed)) outsideToWall++;
                if (e.from.team === 'red' && e.fromZone === 'wall' && e.toZone === 'outside') wallToOutside++;
                if (CLIMB_ZONES.has(e.fromZone) || CLIMB_ZONES.has(e.toZone) || e.fromZone === 'outside' ||
                    e.to.fixed && !(e.fromZone === 'tower' && e.from.tower === e.to.tower) ||
                    e.fromZone === 'tower' && !e.to.fixed || e.fromZone === 'wall' && e.toZone !== 'wall' ||
                    e.fromZone === 'inside' && (e.toZone !== 'inside' || e.from.y > 0 || e.to.y > 0)) illegalMelee++;
            }
            const all = [...s.attackers, ...s.defenders];
            const bodies = all.filter(u => !u.dead).map(u => {
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
            for (const u of all) {
                if (u.dead) { last.delete(u); continue; }
                const [x, z] = viewPoint(u), p = last.get(u);
                if (p) {
                    const excess = Math.hypot(x - p.x, z - p.z) - (2 * u.speed * STEP / 1000 + .02);
                    maxExcess = Math.max(maxExcess, excess);
                    check(excess <= 1e-9, `${label} R4 at=${s.elapsedMs.toFixed(0)} ${u.team}${u.id} ${p.zone}->${u.zone} excess=${excess.toFixed(3)}`);
                    const dy = Math.abs(u.y - p.y);
                    check(dy <= MAX_DY_RATE * STEP / 1000 + .005, `${label} R5 at=${s.elapsedMs.toFixed(0)} ${u.team}${u.id} ${p.zone}->${u.zone} dy=${dy.toFixed(3)}`);
                }
                last.set(u, { x, z, y: u.y, zone: u.zone });
            }
            // 活性：持有梯子使用权的人不得连续 5 秒没朝起爬点前进（木梯两端与塔梯）；
            // 看门狗交还后 1 秒内又轮到同一人，视为连续持有（防止"交还—再领"掩盖死锁）；与敌接战被挡不计
            const seen = new Set();
            for (const [kind, list] of [['inner', s.inner], ['tower', s.towerLadders]]) for (const [i, l] of list.entries()) {
                const g = l.grant;
                if (!g || g.dead) continue;
                const key = `${kind}${i}:${g.id}`; seen.add(key);
                const d = g.iq.kind === 'inner' && g.iq.end === 'top' ? Math.abs(alongT(wallParamToward(g.x, g.z), l.tTop)) + Math.abs(1 - (g.lane || 0)) * LANE_W
                    : Math.hypot(g.x - l.x, g.z - l.z);
                const h = holders.get(key);
                if (h) h.seen = s.elapsedMs;
                // 被 1 以内的敌人挡住正在对砍（墙头对砍规则）不算卡死：计时从脱离接战起算
                const engaged = (g.team === 'blue' ? s.defenders : s.attackers).some(e => !e.dead && e.zone === g.zone && distance(e, g) <= 1);
                if (!h || engaged || d < h.best - .05) holders.set(key, { best: d, since: s.elapsedMs, seen: s.elapsedMs });
                else if (s.elapsedMs - h.since > 5000) {
                    check(false, `${label} grant holder stuck ${key} at=${s.elapsedMs.toFixed(0)} pos=${g.x.toFixed(2)},${g.z.toFixed(2)}`);
                    if (s.elapsedMs > 150000) stuckLate++;
                }
            }
            for (const [key, h] of [...holders]) if (!seen.has(key) && s.elapsedMs - h.seen > 1000) holders.delete(key);
        }
        check(outsideToWall === 0 && wallToOutside === 0 && illegalMelee === 0, `${label} R1 outside->wall=${outsideToWall} wall->outside=${wallToOutside} illegal=${illegalMelee}`);
        check(s.result, `${label} no result`);
        // 夺旗模式不得出现 180s 僵持（与改前一致）；死斗僵持保留规则，但最后 30 秒不得有梯子使用权卡死（不能来自死锁）
        if (mode === 'flag') check(s.holdReason !== 'stalemate', `${label} result=${s.result} reason=${s.holdReason}`);
        else if (s.holdReason === 'stalemate') check(stuckLate === 0, `${label} stalemate with stuck ladder grants`);
        rows.push({ label, result: s.result, reason: s.holdReason, seconds: +(s.elapsedMs / 1000).toFixed(1), minGap: +minGap.toFixed(3), minMesh: +minMesh.toFixed(3), maxExcess: +maxExcess.toFixed(4) });
    }
    rows.forEach(r => t.diagnostic(JSON.stringify(r)));
    t.diagnostic(JSON.stringify({ deathmatchStalemates: rows.filter(r => r.reason === 'stalemate').map(r => r.label) }));
    assert.deepEqual(violations, []);
    assert.equal(rows.length, 54);
});

test('nine task formations (gate + 8 ladders) keep swords ahead of pikes, bows out of ladders and seeded phase jitter', () => {
    for (const preset of Object.keys(FORCE_PRESETS)) {
        const sim = createAssaultSim(), s = sim.startAssault(preset, 12, 1), a = s.attackers;
        assert.deepEqual(s.formations.map(f => f.name), ['G', 'L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']);
        assert.equal(new Set(s.formations.map(f => f.departMs)).size, 9);
        const melee = a.filter(u => u.type !== 'archer');
        // 门队 46%，其余均分到 8 架梯子
        for (const [i, fraction] of [.46, ...Array(8).fill(.54 / 8)].entries())
            assert.ok(Math.abs(melee.filter(u => u.formation === i).length - melee.length * fraction) <= 1);
        // 门面 4 架、东西各 2 架、北面不搭
        assert.deepEqual([0, 1, 2, 3].map(face => LADDERS.filter(l => wallFace(l.topX, l.topZ) === face).length), [0, 2, 4, 2]);
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
    // 墙头守军阵亡后不能原地跳下：沿踩台走到寨内木梯、顺梯子下到地面
    kill(d);
    const zones = [a.zone];
    for (let i = 0; i < 600 && a.zone !== 'inside'; i++) { tick(sim); if (zones.at(-1) !== a.zone) zones.push(a.zone); }
    assert.deepEqual(zones, ['wall', 'iladder', 'inside']); assert.equal(a.enteredVia, 'ladder'); assert.equal(a.y, 0);
});

test('wall-top climber and breach blocker walk the walkway to the nearest inner ladder and climb down it in ~1.2s without melee', () => {
    // R5 定向：只能顺寨内木梯下来——y 单调 1→0、每帧 |dy| <= 1.25 x dt + .005、全程约 1.2 秒，
    // 梯上位置始终在该木梯的梯顶点—梯脚站位连线上，途中不近战也不被近战
    const descend = (sim, s, u) => {
        let frames = 0;
        for (; frames < 1200 && u.zone !== 'iladder'; frames++) sim.stepAssault(STEP);
        assert.equal(u.zone, 'iladder', 'walks to an inner ladder');
        // 起爬那一帧已顺梯下了一步
        const l = s.inner[u.climb.li], ys = u.y < 1 ? [1, u.y] : [1];
        assert.ok(u.y >= 1 - CLIMB_RATE * STEP / 1000 - 1e-9);
        while (u.zone === 'iladder') {
            const events = sim.stepAssault(STEP); ys.push(u.y);
            assert.ok(!events.some(e => e.type === 'attack' && e.from.type !== 'archer' && (e.from === u || e.to === u)), 'no melee on the ladder');
            const k = u.y, px = l.x + (l.topX - l.x) * k, pz = l.z + (l.topZ - l.z) * k;
            if (u.zone === 'iladder') assert.ok(Math.hypot(u.x - px, u.z - pz) < 1e-9, 'on the ladder line');
            assert.ok(ys.length < 200);
        }
        assert.ok(ys.every((y, i) => !i || y <= ys[i - 1] && ys[i - 1] - y <= MAX_DY_RATE * STEP / 1000 + .005), 'monotonic and continuous');
        assert.equal(u.zone, 'inside'); assert.equal(u.y, 0);
        // 落地帧守军已朝堵门线迈出一步（攻方在本帧移动之后才落地）
        assert.ok(Math.hypot(u.x - l.x, u.z - l.z) <= u.speed * STEP / 1000 + 1e-9, 'lands on the ladder foot');
        return { l, seconds: (ys.length - 1) * STEP / 1000 };
    };
    // 攻方：梯顶守军阵亡后沿踩台走到最近的木梯
    {
        const { sim, s } = isolated(), l = s.ladders[2];
        const a = revive(s.attackers.find(u => u.originalRoute === 2 && u.type === 'infantry'), l.topX, l.topZ, 'wall');
        Object.assign(a, { route: 2, wallMs: 1000 }); l.climber = a; s.attackers = [a];
        const { l: used, seconds } = descend(sim, s, a);
        const nearestLadder = [...INNER_LADDERS].sort((p, q) => Math.abs(alongT(wallParamToward(l.topX, l.topZ), p.tTop)) -
            Math.abs(alongT(wallParamToward(l.topX, l.topZ), q.tTop)))[0];
        assert.equal(used.id, nearestLadder.id, 'nearest inner ladder');
        assert.ok(Math.abs(seconds - 1.2) <= .2, `attacker landed in ${seconds}s`);
    }
    // 守军：破门后沿踩台去木梯、下到地面去堵门
    {
        const sim = createAssaultSim({ towerPositions: [] }), s = sim.startAssault('squad', 6, 1);
        s.defenders.forEach(u => { u.cd = 1e9; });
        const keep = s.attackers.find(u => u.type === 'archer'), crew = s.ram.crew;
        s.attackers.forEach(u => { if (u !== keep && !crew.includes(u)) kill(u); }); Object.assign(keep, { x: 20, z: 20, cd: 1e9 });
        s.ram.z = RAM_HIT; s.ram.cooldown = 0; s.gate.hp = 1; s.formations.forEach(f => { f.departMs = 0; });
        for (const u of crew) Object.assign(u, { x: u.crewSlot % 2 ? .88 : -.88, z: RAM_HIT + (u.crewSlot < 2 ? -.5 : .5), cd: 1e9 });
        sim.stepAssault(STEP);
        assert.equal(s.gate.broken, true); crew.forEach(kill);
        const d = s.defenders.find(u => u.task === 'down');
        assert.ok(d && d.zone === 'wall' && d.y === 1, 'blocker stays on the walkway on the breach frame');
        const { seconds } = descend(sim, s, d);
        assert.ok(Math.abs(seconds - 1.2) <= .2, `blocker landed in ${seconds}s`);
    }
});

function archerRange(tower = null) {
    const sim = createAssaultSim({ towerPositions: tower ? [tower] : [] }), s = sim.startAssault('squad', 6, 1);
    s.attackers.forEach(kill); s.defenders.forEach(kill);
    s.formations.forEach(f => { f.released = false; f.departMs = 1e9; });
    s.faceAt = Infinity;
    const d = tower ? revive(s.defenders.find(u => u.fixed), tower.x, tower.z, 'tower')
        : revive(s.defenders.find(u => u.type === 'archer' && !u.fixed), -2, WALL_R, 'wall');
    if (tower) d.y = 2.56; else d.homeT = wallParamToward(d.x, d.z);
    d.cd = 1e9;
    const all = [...s.attackers], crew = s.ram.crew[0];
    const take = (pred, x, z, zone = 'outside') => {
        const u = all.find(v => v.dead && v !== crew && pred(v));
        revive(u, x, z, zone); u.cd = 1e9; s.attackers.push(u); return u;
    };
    s.attackers = [];
    // 一名射程外的寨内攻方：防止人数过少触发溃退
    take(u => u.type === 'infantry', 6, -6, 'inside');
    const climb = (route, k = .5) => {
        const l = s.ladders[route], u = take(u => u.originalRoute === route, l.x + (l.topX - l.x) * k, l.z + (l.topZ - l.z) * k, 'ladder');
        Object.assign(u, { y: k, climbMs: 1600 * k, route }); l.climber = u; return u;
    };
    const ram = () => {
        revive(crew, -.88, RAM_REST - .5); Object.assign(crew, { crew: true, crewSlot: 0, cd: 1e9 });
        s.ram.crew = [crew]; s.attackers.push(crew); return crew;
    };
    return { sim, s, d, take, climb, ram };
}

for (const tower of [null, { x: -2, z: 5.3, yaw: 0 }]) {
    test(`${tower ? 'tower' : 'wall'} archers pick bows, then ladder/wall-top climbers, then ram crew, then the rest`, () => {
        const { sim, d, take, climb, ram } = archerRange(tower);
        const other = take(u => u.type === 'infantry', 4, 11), crew = ram(), climber = climb(0);
        const bow = take(u => u.type === 'archer', -2, 11);
        const picks = [];
        for (const u of [bow, climber, crew, other]) { tick(sim); picks.push(d.target?.id); kill(u); }
        assert.deepEqual(picks, [bow, climber, crew, other].map(u => u.id));
    });
}

test('a wall-top attacker is tier 2: it outranks ram crew and closer plain attackers', () => {
    const { sim, s, d, take, ram } = archerRange();
    const l = s.ladders[1];
    const top = take(u => u.originalRoute === 1, l.topX, l.topZ, 'wall');
    Object.assign(top, { y: 1, route: 1, wallMs: 0 }); l.climber = top;
    ram(); take(u => u.type === 'infantry', -2.5, 8.5);
    assert.ok(distance(d, top) > distance(d, s.ram.crew[0]));
    tick(sim); assert.equal(d.target, top);
});

test('same tier picks the nearer candidate; the lock holds against a closer peer and releases out of range', () => {
    const { sim, s, d, take, climb } = archerRange();
    // 两人离冲车都 >3（不会被征为冲车手），同属第 4 层
    const near = take(u => u.type === 'pikeman', -4, 12), far = take(u => u.type === 'infantry', 4, 13);
    assert.ok(distance(d, near) < distance(d, far));
    tick(sim); assert.equal(d.target, near, 'nearest within the same tier');
    assert.ok(!near.crew && !far.crew);
    // 同层另一名挪到比当前目标更近处（离冲车 >3，不会被征为冲车手）：锁定不换
    Object.assign(far, { x: -3.5, z: 9 });
    assert.ok(distance(far, d) < distance(near, d));
    for (let i = 0; i < 30; i++) { tick(sim); assert.equal(d.target, near, 'same tier never steals the lock'); }
    // 当前目标出射程：解除锁定，改打射程内的
    Object.assign(near, { x: -2, z: WALL_R + 20 });
    tick(sim); assert.equal(d.target, far, 'out-of-range target releases the lock');
    const climber = climb(0);
    tick(sim); assert.equal(d.target, climber, 'a ladder climber outranks the locked target immediately');
});

// 面编号：0 北 1 东 2 南 3 西
function faceScene(spots, seed = 1) {
    const sim = createAssaultSim({ towerPositions: [] }), s = sim.startAssault('squad', 12, seed);
    const all = [...s.attackers];
    all.forEach(kill); s.ram.crew = [];
    s.formations.forEach(f => { f.released = false; f.departMs = 1e9; });
    const melee = all.filter(u => u.type !== 'archer');
    s.attackers = spots.map(([x, z], i) => { const u = revive(melee[i], x, z); u.cd = 1e9; return u; });
    s.defenders.forEach(u => { u.cd = 1e9; });
    const guards = s.defenders.filter(u => !u.fixed);
    const posts = () => [0, 1, 2, 3].map(f => guards.filter(u => u.postFace === f).length);
    const standing = () => [0, 1, 2, 3].map(f => guards.filter(u => wallFace(u.x, u.z) === f).length);
    return { sim, s, guards, posts, standing, spare: melee[spots.length] };
}

test('face reassignment: one sentry per quiet face, largest-remainder split of the rest, guards walk there', t => {
    // 南 8、东 4：哨兵北 1 西 1；余 10 → 南 6.67 东 3.33 → 取整 6/3，余 1 给余数大的南 → [1, 3, 7, 1]
    const south = Array.from({ length: 8 }, (_, i) => [-2.8 + i * .8, 12]);
    const east = Array.from({ length: 4 }, (_, i) => [12, -1.2 + i * .8]);
    const { sim, posts, standing } = faceScene([...south, ...east]);
    tick(sim);
    assert.deepEqual(posts(), [1, 3, 7, 1]);
    tick(sim, 600);
    t.diagnostic(JSON.stringify({ posts: posts(), standing: standing() }));
    assert.deepEqual(standing(), [1, 3, 7, 1], 'guards walk to their assigned faces');
});

test('a quiet-face sentry is a sword when a sword is on that face (archer #40 vs sword #39 case)', () => {
    const { sim, guards } = faceScene([[20, 0], [0, 20], [-20, 0], [-20, .5]]);
    const northSwords = guards.filter(u => wallFace(u.x, u.z) === 0 && u.type !== 'archer');
    assert.ok(northSwords.length > 0 && guards.some(u => wallFace(u.x, u.z) === 0 && u.type === 'archer'));
    tick(sim);
    const sentries = guards.filter(u => u.postFace === 0);
    assert.equal(sentries.length, 1);
    assert.notEqual(sentries[0].type, 'archer', `north sentry #${sentries[0].id} must be a sword`);
});

test('posts change only at the 2s boundary of simulated time, not when the threat moves mid-period', () => {
    const { sim, s, guards } = faceScene(Array.from({ length: 6 }, (_, i) => [-2 + i * .8, 12]));
    const snap = () => guards.map(u => `${u.postFace}:${u.postT}`).join();
    tick(sim); const first = snap();
    // 1 秒时把全部攻方挪到北面
    while (s.elapsedMs < 1000) tick(sim);
    s.attackers.forEach((u, i) => Object.assign(u, { x: -2 + i * .8, z: -12 }));
    while (s.elapsedMs < 1950) { tick(sim); assert.equal(snap(), first, `unchanged at ${s.elapsedMs.toFixed(0)}ms`); }
    while (s.elapsedMs < 2050) tick(sim);
    assert.notEqual(snap(), first, 'reassigned after the 2s boundary');
    assert.ok(guards.filter(u => u.postFace === 0).length > guards.filter(u => u.postFace === 2).length);
});

test('with face posts on, ladder-top responders come from the threatened face and return to their posts', () => {
    const { sim, s, guards, spare } = faceScene([[-16, 2], [-16, 2.8], [-16, 1.2], [16, 2], [0, 16], [.8, 16]]);
    while (s.elapsedMs < 24100) tick(sim); // 先走到各自岗位，并刚过一个 2s 边界（9 个编组改变了随机序列，20s 时仍有人在换岗途中）
    // 另加一名墙头攻方（不改变墙外/梯上的威胁计数）
    const l = s.ladders[3], a = revive(spare, l.topX, l.topZ, 'wall');
    Object.assign(a, { wallMs: 0, route: 3, cd: 1e9 }); s.attackers.push(a); l.climber = a;
    const before = new Map(guards.map(u => [u, { x: u.x, z: u.z, postT: u.postT, face: u.postFace }]));
    tick(sim, 20);
    const moved = guards.filter(u => Math.hypot(u.x - before.get(u).x, u.z - before.get(u).z) > .05 &&
        Math.abs(wallParamToward(u.x, u.z) - before.get(u).postT) > .05);
    assert.ok(moved.length > 0, 'someone responds');
    assert.ok(moved.every(u => u.postFace === 1), 'responders are posted on the threatened (east) face');
    kill(a); l.climber = null;
    tick(sim, 100);
    for (const u of guards) {
        const [x, z] = wallPoint(u.postT);
        assert.ok(Math.hypot(u.x - x, u.z - z) < .05, `#${u.id} back at its post`);
    }
});

test('in a full battle a guard changes its post face only at a 2s reassignment tick', () => {
    const sim = createAssaultSim(), s = sim.startAssault('company', 24, 1);
    const last = new Map();
    let off = 0;
    for (let i = 0; i < 18000 && !s.result; i++) {
        const period = Math.floor(s.elapsedMs / 2000);
        tick(sim);
        const crossed = Math.floor(s.elapsedMs / 2000) !== period;
        for (const u of s.defenders) {
            if (u.fixed || u.dead) continue;
            if (last.has(u) && last.get(u) !== u.postFace && !crossed) off++;
            last.set(u, u.postFace);
        }
    }
    assert.equal(off, 0);
});

test('wall guards respond to ladder/ram threats, return home, and nearest half of swords descend after breach', t => {
    const sim = createAssaultSim(), s = sim.startAssault('company', 12, 1);
    s.formations.forEach(f => { f.departMs = 100000; });
    s.faceAt = Infinity; // 隔离按面分配（另有定向测试），这里只验梯顶响应、回原位与破门下台
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
    const events = sim.stepAssault(STEP), descended = swords.filter(u => u.task === 'down');
    // 堵门守军沿踩台走到寨内木梯、顺梯子下到地面，再绕开帐篷走到堵门线（按渲染位置量位移）
    const view = u => { const [x, z] = viewPoint(u); return { x, z }; };
    const jumps = descended.map(u => Math.max(0, distance(view(u), { x: walk.get(u)[0], z: walk.get(u)[1] }) - 2 * u.speed * STEP / 1000));
    // Isolate the walk from the inrush: keep one idle far archer so the breached battle keeps running.
    const keep = s.attackers.find(u => u.type === 'archer');
    s.attackers.forEach(u => { if (u !== keep) kill(u); }); Object.assign(keep, { x: 20, z: 20, cd: 1e9 });
    const arrived = new Map();
    for (let i = 0; i < 600 && descended.some(u => !u.dead && !arrived.has(u)); i++) {
        const before = new Map(descended.map(u => [u, view(u)]));
        tick(sim);
        for (const u of descended) {
            if (u.dead) continue;
            jumps.push(Math.max(0, distance(view(u), before.get(u)) - 2 * u.speed * STEP / 1000));
            if (!arrived.has(u) && !u.blockPath.length) arrived.set(u, { x: u.x, z: u.z, y: u.y, zone: u.zone, at: s.elapsedMs });
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
    // 到达堵门线时在寨内地面（之后 3 以内无寨内攻方会经木梯回墙头）
    assert.ok(descended.every(u => u.dead || arrived.get(u)?.y === 0 && arrived.get(u)?.zone === 'inside'));
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
    // 寨内木梯 ×8：梯身占地（梯脚 5.6 到踩台内沿 6.15、横向 ±.175）与箭塔、帐篷、门洞、攻城梯落点、塔梯、其余木梯净距 >= .1
    const rect = (x0, x1, z0, z1) => ({ minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1) });
    const around = (p, h) => rect(p.x - h, p.x + h, p.z - h, p.z + h);
    const rectGap = (a, b) => Math.hypot(Math.max(0, a.minX - b.maxX, b.minX - a.maxX), Math.max(0, a.minZ - b.maxZ, b.minZ - a.maxZ));
    const innerRects = INNER_LADDERS.map(l => l.nz ? rect(l.railFoot.x - .175, l.railTop.x + .175, l.railFoot.z, l.railTop.z)
        : rect(l.railFoot.x, l.railTop.x, l.railFoot.z - .175, l.railTop.z + .175));
    const obstacles = [
        ...towers.map((p, i) => ({ kind: `tower${i}`, r: around(p, p.half) })),
        ...tents.map((p, i) => ({ kind: `tent${i}`, r: around(p, p.half) })),
        { kind: 'gate', r: rect(-GATE_HALF - .05, GATE_HALF + .05, INNER_RAIL_TOP_R, WALL_R) },
        ...LADDERS.map((l, i) => ({ kind: `landing${i}`, r: around({ x: l.topX - l.nx * .6, z: l.topZ - l.nz * .6 }, .15) })),
        ...TOWER_LADDERS.map((l, i) => ({ kind: `towerLadder${i}`, r: rect(l.x - .15, l.ox - .576 + .03, l.z - .17, l.z + .17) }))];
    assert.equal(INNER_LADDERS.length, 8);
    assert.deepEqual([0, 1, 2, 3].map(f => INNER_LADDERS.filter(l => wallFace(l.wx, l.wz) === f).length), [2, 2, 2, 2]);
    for (const [i, r] of innerRects.entries()) {
        for (const o of obstacles) rows.push({ kind: `inner${i}/${o.kind}`, gap: rectGap(r, o.r) });
        for (let j = i + 1; j < innerRects.length; j++) rows.push({ kind: `inner${i}/inner${j}`, gap: rectGap(r, innerRects[j]) });
        // 梯脚站位与梯脚排队槽位（容量内）不进帐篷避让区、在寨内地面范围内
        const l = INNER_LADDERS[i];
        for (const p of [l, ...Array.from({ length: CLIMB_QUEUE_CAPACITY }, (_, k) => innerFootSlot(l, k))]) {
            assert.ok(Math.max(Math.abs(p.x), Math.abs(p.z)) <= WALL_R - .22, `inner${i} slot inside`);
            for (const tent of TENTS) assert.ok(Math.abs(p.x - tent.x) >= tent.half + .16 || Math.abs(p.z - tent.z) >= tent.half + .16, `inner${i} slot vs tent`);
        }
        assert.ok(Math.abs(INNER_RAIL_TOP_R - INNER_RAIL_FOOT_R - .55) < 1e-9, 'ladder foot .55 from the walkway inner edge');
    }
    for (const l of TOWER_LADDERS) for (let k = 0; k < CLIMB_QUEUE_CAPACITY; k++) {
        const p = towerFootSlot(l, k);
        for (const tent of TENTS) assert.ok(Math.abs(p.x - tent.x) >= tent.half + .16 || Math.abs(p.z - tent.z) >= tent.half + .16, 'tower queue vs tent');
    }
    rows.forEach(r => t.diagnostic(JSON.stringify(r)));
    assert.ok(rows.every(r => r.gap >= .1 - 1e-9), JSON.stringify(rows.filter(r => r.gap < .1 - 1e-9)));
    // Vertical tower ladder, including rung thickness: x=-.576 +/-.03; z=+/-.136.
    assert.ok(.72 * .8 + .03 <= TOWER_HALF);
    assert.ok(.34 * .8 / 2 <= TOWER_HALF);
    const render = readFileSync(new URL('../js/three-spike/camp.js', import.meta.url), 'utf8');
    assert.match(render, /pt = 2 \* TOWER_HALF/);
    assert.match(render, /topX = l.topX \+ l.nx \* .04, topZ = l.topZ \+ l.nz \* .04/);
    // 寨内木梯渲染与模拟共用同一份位置
    assert.match(render, /for \(const l of INNER_LADDERS\) rungs\(l\.railFoot\.x, l\.railFoot\.z, l\.railTop\.x, WALKWAY_H, l\.railTop\.z, l\.nx, l\.nz\)/);
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
    // 门队 4 名冲车手 + 8 架梯子各 >=1 人：下限 12
    assert.throws(() => formationSizes(11), RangeError);
    const rows = [12, 13, 14, 30, 60, 120].map(total => ({ total, sizes: formationSizes(total) }));
    rows.forEach(r => t.diagnostic(JSON.stringify(r)));
    for (const { total, sizes } of rows) {
        assert.equal(sizes.reduce((a, b) => a + b), total);
        assert.equal(sizes.length, 9);
        assert.ok(sizes[0] >= 4 && sizes.slice(1).every(n => n >= 1));
    }
});

test('forced ram abandonment takes lateral exit before retreat without dislodging firing archers or stalling', t => {
    const sim = createAssaultSim(), s = sim.startAssault('squad', 6, 1);
    s.ram.crew.forEach(kill);
    // 8 架梯子会让无守军的寨子 ~13s 即被拔旗：守军先不出手、不阵亡（墙头对砍规则把攻方挡在梯顶，暂不进寨），
    // 全部改道者走到出口后再清场，让战斗正常结束
    s.defenders.forEach(u => Object.assign(u, { cd: 1e9, hp: 1e9, maxHp: 1e9 }));
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
        if (exits.length === routes.length && s.defenders.some(u => !u.dead)) s.defenders.forEach(kill);   // 全部撤出后清场
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
    // 8 架梯子后无守军的寨子在 ~13s 即被拔旗，最后一名改道者可能还在横移途中；要求未到出口者仍在推进（violations 为空）
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

// ==================== 寨内木梯 / 箭塔竖梯 / 夺旗分流 / 死斗模式（定向） ====================
// 空场：全员阵亡、编组不出发；towers 为真时保留默认两座箭塔
function emptyCamp({ preset = 'company', mode = 'flag', towers = false, defenders = 12 } = {}) {
    const sim = towers ? createAssaultSim() : createAssaultSim({ towerPositions: [] });
    const s = sim.startAssault(preset, defenders, 1, mode);
    s.attackers.forEach(kill); s.defenders.forEach(kill); s.ram.crew = [];
    s.formations.forEach(f => { f.released = true; f.departMs = 0; });
    s.faceAt = Infinity;
    const pool = [...s.attackers];
    const blue = (type, x, z, zone = 'inside') => {
        const u = revive(pool.find(v => v.dead && v.type === type && !s.attackers.includes(v) || v.dead && v.type === type && v.hp === 0), x, z, zone);
        u.cd = 1e9; if (!s.attackers.includes(u)) s.attackers.push(u); return u;
    };
    s.attackers = [];
    // 远处一名不出手的弓手：保证"攻方全灭 → hold"不提前结束定向场景
    const keeper = blue('archer', 20, 20, 'outside');
    Object.assign(keeper, { fireSlot: { x: 20, z: 20 }, waitState: 'firing', moveTarget: { x: 20, z: 20 } });
    const red = (pred, x, z, zone = 'inside') => {
        const d = revive(s.defenders.find(v => v.dead && pred(v)), x, z, zone);
        d.cd = 1e9; d.homeT = wallParamToward(d.x, d.z); return d;
    };
    return { sim, s, blue, red };
}
const climbersOn = (s, li) => [...s.attackers, ...s.defenders].filter(u => !u.dead && u.zone === 'iladder' && u.climb?.li === li);

test('inner ladder: one climber at a time, explicit foot slots, queue picks the less loaded of the two nearest (tie -> nearer), ~1.2s climb', t => {
    const { sim, s, red } = emptyCamp();
    // 三名寨内守军，附近没有寨内攻方：经最近的木梯爬回墙头
    const spots = [[1.6, 4.0], [1.6, 4.5], [1.0, 4.5]];
    const reds = spots.map(([x, z]) => red(u => u.type === 'infantry', x, z));
    const foot = l => Math.hypot(l.x - 1.6, l.z - 4.25);
    const [near, second] = [...INNER_LADDERS].sort((a, b) => foot(a) - foot(b));
    tick(sim, 2);   // 第 1 帧判定"附近无敌、回墙头"，第 2 帧按序排队
    // 第 1 人：两架都空 → 近的那架；第 2 人：近的那架已有人（轮到/排队）→ 人少的那架；第 3 人：两架各 1 人 → 近的那架
    assert.deepEqual(reds.map(u => u.iq?.li), [near.id, second.id, near.id]);
    assert.ok(reds.every(u => u.task === 'up' && u.iq.end === 'foot'));
    const spans = new Map(), maxOn = new Map();
    let slotted = false;
    for (let i = 0; i < 900 && reds.some(u => u.zone !== 'wall'); i++) {
        tick(sim);
        // 第 3 人在近的那架梯脚排第 1 位：站在显式槽位上等
        if (reds[2].waitState === 'queued') slotted ||= distance(reds[2], innerFootSlot(near, 0)) <= .04 + 1e-9;
        for (const l of INNER_LADDERS) maxOn.set(l.id, Math.max(maxOn.get(l.id) ?? 0, climbersOn(s, l.id).length));
        for (const u of reds) if (u.zone === 'iladder') spans.set(u, (spans.get(u) ?? 0) + 1);
    }
    t.diagnostic(JSON.stringify({ seconds: reds.map(u => (spans.get(u) ?? 0) * STEP / 1000), maxOn: [...maxOn] }));
    assert.ok([...maxOn.values()].every(n => n <= 1), 'one at a time');
    assert.ok(slotted, 'waits on the explicit foot slot');
    assert.ok(reds.every(u => u.zone === 'wall' && u.y === 1));
    for (const u of reds) assert.ok(Math.abs(spans.get(u) * STEP / 1000 - 1.2) <= .2, `climb ${spans.get(u) * STEP / 1000}s`);
});

test('inner ladder climbers can be shot but never meleed; a defender on the ground climbs back to the wall and rejoins the face posts', () => {
    const { sim, s, blue, red } = emptyCamp();
    const l = INNER_LADDERS[0];
    const d = red(u => u.type === 'infantry', l.x - .6, l.z - .6);
    for (let i = 0; i < 120 && d.zone !== 'iladder'; i++) tick(sim);
    assert.equal(d.zone, 'iladder');
    // 攀爬途中：梯脚旁来一名剑士（贴身）和一名墙外弓手
    const sword = blue('infantry', l.x - .5, l.z - .2); sword.cd = 0;
    const bow = blue('archer', l.x, WALL_R + 3, 'outside'); bow.cd = 0; bow.fireSlot = { x: bow.x, z: bow.z };
    Object.assign(bow, { waitState: 'firing', moveTarget: { ...bow.fireSlot } });
    let melee = 0, arrows = 0;
    while (d.zone === 'iladder' && !d.dead) for (const e of sim.stepAssault(STEP)) if (e.type === 'attack' && (e.to === d || e.from === d)) {
        if (e.from.type === 'archer') arrows++; else melee++;
    }
    assert.equal(melee, 0, 'no melee to or from a climber');
    assert.ok(arrows > 0, 'arrows still hit the climber');
    // 已回到墙头：守军照常参与按面分配（到下一个 2s 边界拿到岗位）
    if (!d.dead) {
        assert.equal(d.zone, 'wall'); assert.equal(d.task, null);
        kill(sword); kill(bow); blue('infantry', 0, -16, 'outside');
        s.faceAt = s.elapsedMs; tick(sim);
        assert.ok(d.postFace != null && d.postT != null, 'gets a face post again after climbing back');
    }
});

test('an attacker inside climbs an inner ladder back to the wall to fight a wall archer (wall-top melee)', () => {
    const { sim, s, blue, red } = emptyCamp();
    const archer = red(u => u.type === 'archer', 2, -WALL_R, 'wall');
    const a = blue('infantry', 0, -3); a.cd = 0;
    const zones = [a.zone];
    let hit = 0;
    for (let i = 0; i < 900 && !archer.dead; i++) for (const e of sim.stepAssault(STEP)) {
        if (zones.at(-1) !== a.zone) zones.push(a.zone);
        if (e.type === 'attack' && e.from === a && e.to === archer) { hit++; assert.equal(e.fromZone, 'wall'); assert.equal(e.toZone, 'wall'); }
    }
    assert.ok(a.hunter, 'flag mode: the only inside melee becomes the archer hunter');
    assert.deepEqual(zones.slice(0, 3), ['inside', 'iladder', 'wall']);
    assert.ok(hit > 0 && archer.dead);
});

test('tower ladder: attackers climb in ~3.1s one at a time, at most 2 on the platform, the rest queue at the foot; tower archers shoot climbers', t => {
    const { sim, s, blue } = emptyCamp({ mode: 'deathmatch', towers: true });
    const archers = s.defenders.filter(u => u.fixed && u.tower === 0);
    archers.forEach(d => Object.assign(d, { dead: false, hp: 1e6, cd: 1e9 }));
    const tl = TOWER_LADDERS[0];
    const team = [0, 1, 2, 3].map(i => blue('infantry', tl.x + 1 + (i % 2) * .5, tl.z - 2 - Math.floor(i / 2) * .5));
    let maxTop = 0, queuedWhileFull = 0, onLadder = 0;
    const climbFrames = new Map();
    for (let i = 0; i < 1500; i++) {
        tick(sim);
        const top = team.filter(u => u.zone === 'tower').length;
        maxTop = Math.max(maxTop, top);
        onLadder = Math.max(onLadder, team.filter(u => u.zone === 'tladder').length);
        if (top === TOWER_TOP_CAP && team.some(u => u.iq?.kind === 'tower' && u.iq.end === 'foot')) queuedWhileFull++;
        for (const u of team) if (u.zone === 'tladder') climbFrames.set(u, (climbFrames.get(u) ?? 0) + 1);
    }
    const seconds = [...climbFrames.values()].map(n => n * STEP / 1000);
    t.diagnostic(JSON.stringify({ maxTop, onLadder, queuedWhileFull, seconds }));
    assert.equal(TOWER_TOP_CAP, 2); assert.equal(maxTop, 2); assert.equal(onLadder, 1);
    assert.ok(queuedWhileFull > 0, 'the rest wait in the foot queue');
    assert.equal(team.filter(u => u.zone === 'tower').length, 2);
    for (const sec of seconds) assert.ok(Math.abs(sec - TOWER_Y / CLIMB_RATE) <= .2 && Math.abs(sec - 3.1) <= .2, `tower climb ${sec}s`);
    // 塔上弓手射攀爬者
    const { sim: sim2, s: s2, blue: blue2 } = emptyCamp({ mode: 'deathmatch', towers: true });
    s2.defenders.filter(u => u.fixed && u.tower === 0).forEach(d => Object.assign(d, { dead: false, hp: 1e6, cd: 0 }));
    const climber = blue2('infantry', tl.x + 1, tl.z - 2); climber.hp = 1e6;
    let shotWhileClimbing = 0;
    for (let i = 0; i < 600; i++) for (const e of sim2.stepAssault(STEP))
        if (e.type === 'attack' && e.to === climber && e.toZone === 'tladder' && e.from.fixed && !e.melee) shotWhileClimbing++;
    assert.ok(shotWhileClimbing > 0);
});

test('tower top melee: attackers hit archers of the same tower; a bumped tower archer strikes back at archer attack x0.5', () => {
    const { sim, s, blue } = emptyCamp({ mode: 'deathmatch', towers: true });
    const archers = s.defenders.filter(u => u.fixed && u.tower === 0);
    archers.forEach(d => Object.assign(d, { dead: false, hp: 1e6, cd: 1e9 }));
    const tl = TOWER_LADDERS[0];
    const a = blue('infantry', tl.x + 1, tl.z - 2); a.hp = 1e6;
    for (let i = 0; i < 600 && a.zone !== 'tower'; i++) tick(sim);
    for (let i = 0; i < 60; i++) tick(sim);
    assert.equal(a.zone, 'tower'); assert.equal(a.y, TOWER_Y);
    a.cd = 0; archers.forEach(d => { d.cd = 0; });
    const melee = [], hits = [];
    for (let i = 0; i < 300; i++) for (const e of sim.stepAssault(STEP)) if (e.type === 'attack') {
        if (e.from === a) hits.push(e);
        if (e.to === a) melee.push(e);
    }
    assert.ok(hits.length > 0 && hits.every(e => e.to.fixed && e.to.tower === 0 && e.fromZone === 'tower'));
    const bumped = melee.filter(e => e.melee);
    assert.ok(bumped.length > 0, 'bumped archers strike back in melee');
    const archer = bumped[0].from;
    const half = Math.max(1, Math.floor(calculateAttackDamage(archer, a, { multiplier: CAMP_RULES.WALL_GUARD_ATTACK, rawAttack: archer.typeData.atk * ARCHER_MELEE_FACTOR })));
    const full = Math.max(1, Math.floor(calculateAttackDamage(archer, a, { multiplier: CAMP_RULES.WALL_GUARD_ATTACK })));
    assert.equal(ARCHER_MELEE_FACTOR, .5);
    assert.ok(bumped.every(e => e.damage === half), `melee ${bumped[0].damage} vs expected ${half}`);
    assert.ok(half < full);
    assert.ok(bumped.every(e => distance(e.from, a) <= .95 + 1e-9), 'only archers within the attacker reach are bumped');
    // 不在塔顶的近战够不到塔上弓手
    const ground = blue('infantry', tl.ox + .2, tl.oz + 1.2); ground.cd = 0;
    for (let i = 0; i < 120; i++) assert.ok(!sim.stepAssault(STEP).some(e => e.type === 'attack' && e.from === ground && e.to.fixed));
});

test('flag mode split: with no hittable defender near the flag, at most 1/3 (at least 1) of inside melee hunt archers; a defender at the flag recalls ground hunters', () => {
    for (const [n, quota] of [[1, 1], [3, 1], [9, 3], [10, 3]]) {
        const { sim, s, blue, red } = emptyCamp({ preset: 'brigade' });
        red(u => u.type === 'archer', 0, -WALL_R, 'wall');
        const team = Array.from({ length: n }, (_, i) => blue('infantry', -1.6 + (i % 4) * .6, 1.6 + Math.floor(i / 4) * .6));
        tick(sim);
        assert.equal(team.filter(u => u.hunter).length, quota, `${n} inside -> ${quota} hunters`);
        tick(sim, 30);
        assert.equal(team.filter(u => u.hunter).length, quota);
        if (n === 9) {
            red(u => u.type === 'infantry', 0, -2.2);
            tick(sim);
            assert.equal(team.filter(u => u.hunter && u.zone === 'inside').length, 0, 'ground hunters return to the flag');
        }
    }
    // 没有弓手可打时不分流
    const { sim, s, blue, red } = emptyCamp();
    red(u => u.type === 'infantry', 0, -WALL_R, 'wall');
    const team = [0, 1, 2].map(i => blue('infantry', -1 + i * .6, 1.6));
    tick(sim); assert.equal(team.filter(u => u.hunter).length, 0);
});

test('deathmatch: wall, inside and tower defenders must all fall for a break; flag progress is never updated; retreat and annihilation still hold', () => {
    const { sim, s, blue } = emptyCamp({ mode: 'deathmatch', towers: true });
    s.defenders.filter(u => u.fixed).forEach(d => Object.assign(d, { dead: false, hp: 1, cd: 1e9 }));
    s.gate.broken = true;
    const team = [0, 1, 2].map(i => blue('infantry', -.6 + i * .6, 1.4));
    tick(sim, 60);
    assert.equal(s.result, null, 'living tower archers block the break');
    assert.equal(s.flagProgress, -1); assert.equal(s.flagNet, 0); assert.equal(s.phase === '夺旗中', false);
    s.defenders.forEach(kill);
    tick(sim);
    assert.equal(s.result, 'break'); assert.equal(s.flagProgress, -1);
    // 攻方全灭 → hold
    const a = emptyCamp({ mode: 'deathmatch' });
    a.red(u => u.type === 'infantry', 0, -WALL_R, 'wall');
    a.s.attackers.forEach(kill);
    tick(a.sim); assert.equal(a.s.result, 'hold');
    // 破门前伤亡过半 → 溃退 → hold（与夺旗模式同一规则）
    const sim2 = createAssaultSim(), s2 = sim2.startAssault('squad', 24, 1, 'deathmatch');
    s2.attackers.slice(0, Math.ceil(s2.attackers.length * .6)).forEach(kill);
    tick(sim2); assert.equal(s2.retreated, true);
    tick(sim2, 181); assert.equal(s2.result, 'hold');
});

test('mode defaults to flag: omitted / explicit flag / unknown mode replay identically; flag half vs pre-change results is diagnostic', t => {
    const runs = [undefined, 'flag', 'bogus'].map(mode => {
        const sim = createAssaultSim(), s = mode === undefined ? sim.startAssault('company', 12, 2) : sim.startAssault('company', 12, 2, mode);
        assert.equal(s.mode, 'flag');
        return finish(sim);
    });
    assert.deepEqual(runs[1], runs[0]); assert.deepEqual(runs[2], runs[0]);
    assert.equal(runs[0].result, 'break'); assert.equal(runs[0].flagProgress, 1);
    // 改前（HEAD 3f4055b）27 局结果：用来对照，8 架攻城梯与木梯会改变节奏，只作诊断
    const before = { 'squad/6': ['break', 'break', 'break'], 'squad/12': ['hold', 'hold', 'hold'], 'squad/24': ['hold', 'hold', 'hold'],
        'company/6': ['break', 'break', 'break'], 'company/12': ['break', 'break', 'break'], 'company/24': ['break', 'hold', 'break'],
        'brigade/6': ['break', 'break', 'break'], 'brigade/12': ['break', 'break', 'break'], 'brigade/24': ['break', 'break', 'break'] };
    t.diagnostic(JSON.stringify(before));
});

test('crossing walkway queues cannot deadlock: two grant holders and a waiter between them all get down (Codex repro)', () => {
    const { sim, s, blue } = emptyCamp();
    s.gate.broken = true;
    const [l0, l1] = [s.inner[0], s.inner[1]];
    const wallAt = x => { const t = wallParamToward(x, WALL_R); return wallPoint(t); };
    const put = x => { const [wx, wz] = wallAt(x), u = blue('infantry', wx, wz, 'wall'); Object.assign(u, { y: 1, lane: 1, leftTop: true }); return u; };
    const A = put(2.908), B = put(2.579), C = put(2.25);
    const side = (l, u) => alongT(l.tTop, wallParamToward(u.x, u.z)) < 0 ? -1 : 1;
    A.iq = { kind: 'inner', li: l0.id, end: 'top', side: side(l0, A), seq: s.seq++ }; l0.grant = A;
    B.iq = { kind: 'inner', li: l1.id, end: 'top', side: side(l1, B), seq: s.seq++ }; l1.grant = B;
    C.iq = { kind: 'inner', li: l0.id, end: 'top', side: side(l0, C), seq: s.seq++ }; l0.queue.push(C);
    const team = [A, B, C];
    let frames = 0;
    for (; frames < 1200 && team.some(u => u.zone !== 'inside'); frames++) tick(sim);
    assert.ok(team.every(u => u.zone === 'inside' && u.y === 0), `all three climbed down within ${frames * STEP / 1000}s: ${team.map(u => u.zone)}`);
    assert.ok(frames * STEP / 1000 < 15);
});

test('climbers on inner ladders and tower ladders are tier-2 targets: they outrank ram crew and break a lock on crew', () => {
    for (const kind of ['iladder', 'tladder']) {
        const { sim, s, d, take, ram } = archerRange();
        const crew = ram();
        // 寨内的攀爬者：放在射程内、比冲车手更远
        const l = kind === 'iladder' ? s.inner[0] : s.towerLadders[0];
        const climber = take(u => u.type === 'infantry', l.x, l.z, kind);
        Object.assign(climber, { y: .5, climb: { kind: kind === 'iladder' ? 'inner' : 'tower', li: kind === 'iladder' ? l.id : l.tower, dir: 1 } });
        if (kind === 'tladder') climber.tower = l.tower;
        (kind === 'iladder' ? s.inner[0] : s.towerLadders[0]).climber = climber;
        assert.ok(distance(d, climber) > distance(d, crew) && distance(d, climber) <= 9.5);
        tick(sim); assert.equal(d.target, climber, `${kind} climber outranks ram crew`);
        // 锁定冲车手时出现攀爬者：立即改打攀爬者
        const { sim: sim2, s: s2, d: d2, take: take2, ram: ram2 } = archerRange();
        const crew2 = ram2();
        tick(sim2); assert.equal(d2.target, crew2);
        const l2 = kind === 'iladder' ? s2.inner[0] : s2.towerLadders[0];
        const c2 = take2(u => u.type === 'infantry', l2.x, l2.z, kind);
        Object.assign(c2, { y: .5, climb: { kind: kind === 'iladder' ? 'inner' : 'tower', li: kind === 'iladder' ? l2.id : l2.tower, dir: 1 } });
        if (kind === 'tladder') c2.tower = l2.tower;
        l2.climber = c2;
        tick(sim2); assert.equal(d2.target, c2, `${kind} climber breaks the crew lock`);
    }
});

test('walkway ladder choice never routes through another ladder\'s waiting queue (the emptier far ladder is skipped)', () => {
    const { sim, s, blue } = emptyCamp();
    s.gate.broken = true;
    const [l0, l1] = [s.inner[0], s.inner[1]];
    const put = (x, lane) => { const [wx, wz] = wallPoint(wallParamToward(x, WALL_R)), u = blue('infantry', wx, wz, 'wall'); Object.assign(u, { y: 1, lane, leftTop: true }); return u; };
    // 梯 0 已有人轮到（A）且左侧有人候梯（C）；U 夹在 C 与梯 0 之间。梯 1 空着，但去梯 1 必须穿过 C
    const A = put(2.95, 1), C = put(2.2, 1), U = put(2.55, 0);
    A.iq = { kind: 'inner', li: l0.id, end: 'top', side: 1, seq: s.seq++ }; l0.grant = A; A.grantBest = 0; A.grantSince = 0;
    C.iq = { kind: 'inner', li: l0.id, end: 'top', side: -1, seq: s.seq++ }; l0.queue.push(C);
    tick(sim);
    assert.equal(U.iq?.li, l0.id, 'joins the near ladder instead of crossing C');
});
