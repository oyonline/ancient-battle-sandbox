import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit, CombatRules } from './battle-harness.js';
import { createSiegeLayer } from '../js/battle/siege.js';
import { createCampSiege } from '../js/siege3d/deployment.js';
import { campBounds, queueCampWalls, buildCampVisuals, updateCampGate, disposeCampVisuals } from '../js/siege3d/walls.js';
import { buildRamVisual, updateRamVisual } from '../js/siege3d/ram.js';

const STEP_MS = 1000 / 60;
function step(scene) { scene.simulationTime += STEP_MS; scene.stepBattle(1 / 60); }
const frameOf = scene => Math.round(scene.simulationTime / STEP_MS);
const state = scene => scene.units.map(({ id, gx, gy, hp, dead }) => ({ id, gx, gy, hp, dead }));
function record(scene) {
    const hits = [], original = scene.recordDamage;
    scene.recordDamage = function (target, damage, from, started) {
        hits.push({ frame: frameOf(this), target: target.id, from: from.id, damage });
        return original.call(this, target, damage, from, started);
    };
    return hits;
}
function soldier(scene, team, x, y, type = 'infantry') {
    const unit = addUnit(scene, team, type, x, y);
    unit.hp = unit.maxHp = 10000;
    return unit;
}
function camp(extra = false) {
    const scene = makeScene(), b = campBounds();
    scene.battleOptions.deathmatch = true;
    // 机制测试钉回旧紧凑布局：冲车 3.2 格起步，避免按真实出发阵地空跑行程
    scene.siege = createCampSiege(b, { defense: false, ramRestOffset: 3.2 });
    queueCampWalls(scene);
    const { ram } = scene.siege;
    const crew = [-1, 1, -2, 2].map(dx => soldier(scene, 'red', ram.gx + dx * .4, ram.gy));
    const blue = soldier(scene, 'blue', b.cx, b.y2 - 2.2);
    blue.typeData = { ...blue.typeData, speed: 0 };
    const red = extra ? soldier(scene, 'red', b.cx, b.y2 + .8) : null;
    if (red) { red.target = red.meleeTarget = blue; blue.target = blue.meleeTarget = red; }
    return { scene, b, crew, red, blue, hits: record(scene) };
}

function assault(extra = false) {
    const run = camp(extra), { scene, b, crew, red, blue, hits } = run;
    const { ram, gate } = scene.siege;
    const frames = [], impacts = [];
    let arrivedAt = null, brokenAt = null, removedAt = null, enteredAt = null;
    for (let frame = 1; frame <= 2100; frame++) {
        const previousHits = ram.hits;
        step(scene);
        if (frame === 1) assert.deepEqual(ram.crew, crew.map(u => u.id), 'distance ties use ascending id');
        if (ram.state === 'hitting' && arrivedAt === null) arrivedAt = frame;
        if (ram.hits !== previousHits) impacts.push({ frame, hp: gate.hp });
        if (!gate.broken) {
            for (const [i, id] of ram.crew.entries()) {
                const unit = crew.find(u => u.id === id);
                assert.equal(unit.gx, ram.gx + (i % 2 ? .88 : -.88));
                assert.equal(unit.gy, ram.gy + (i < 2 ? -.5 : .5));
                assert.ok(CombatRules.canBeHit(unit));
                assert.ok(!scene.navigation.routes.has(unit), 'pushing never requests a path');
            }
            assert.equal(hits.length, 0, 'closed wall prevents combat, crew never attacks');
        }
        if (gate.broken && brokenAt === null) {
            brokenAt = frame;
            assert.equal(ram.hits, 12);
            assert.equal(ram.state, 'spent');
            assert.ok(scene.dynamicBlockers.list.some(r => r.id === gate.blockerId), 'removal waits for next commit');
            assert.ok(crew.every(u => !u.siegeAnchor && !u.siegeRole));
        }
        if (gate.broken && !scene.dynamicBlockers.list.some(r => r.id === gate.blockerId) && removedAt === null) removedAt = frame;
        if (red && red.gy < b.y2 && red.gx > b.x1 && red.gx < b.x2 && enteredAt === null) enteredAt = frame;
        frames.push({ units: state(scene), ram: [ram.gx, ram.gy, ram.state, ram.hits], hp: gate.hp });
    }
    assert.notEqual(arrivedAt, null);
    assert.equal(impacts.length, 12);
    assert.deepEqual(impacts.map(h => h.hp), Array.from({ length: 12 }, (_, i) => 1800 - 150 * (i + 1)));
    for (let i = 0; i < impacts.length; i++) assert.equal(impacts[i].frame - (i ? impacts[i - 1].frame : arrivedAt), 132);
    assert.equal(removedAt, brokenAt + 1);
    assert.equal(ram.gy, ram.restY, 'spent ram retreats to rest');
    if (red) {
        assert.ok(enteredAt > brokenAt && enteredAt - brokenAt <= 900, `entry=${enteredAt}, breach=${brokenAt}`);
        assert.ok(hits.some(h => h.from === red.id && h.target === blue.id));
        assert.ok(hits.some(h => h.from === blue.id && h.target === red.id));
        assert.ok(hits.every(h => h.frame > brokenAt));
    }
    return { ...run, frames, impacts, arrivedAt, brokenAt, removedAt, enteredAt };
}

test('ram #1: four crew advance, twelfth impact breaches, next step removes blocker, then retreat', t => {
    const r = assault();
    t.diagnostic(`arrival=${r.arrivedAt}; impacts=${r.impacts.map(h => h.frame)}; breach=${r.brokenAt}; removal=${r.removedAt}`);
});

test('ram #2: sealed camp prevents melee; breach opens navigation and both soldiers deal melee damage', t => {
    const r = assault(true);
    t.diagnostic(`breach=${r.brokenAt}; entry=${r.enteredAt}; firstMelee=${r.hits[0]?.frame}; mutualHits=${r.hits.filter(h => h.from === r.red.id || h.target === r.red.id).length}`);
});

test('ram #3: three crew deaths trigger siege withdrawal; battle end freezes ram and crew', t => {
    const { scene, crew, hits } = camp();
    const { ram, gate } = scene.siege;
    while (ram.state !== 'hitting' && frameOf(scene) < 300) step(scene);
    step(scene); // settle velocity before arrows aim
    const archer = soldier(scene, 'blue', ram.gx + 10, ram.gy, 'archer');
    archer.typeData = { ...archer.typeData, speed: 0, range: 0 };
    for (const unit of crew.slice(0, 3)) scene.fireArrow(archer, unit, { rawAttack: 100000 });
    for (let i = 0; i < 46; i++) step(scene);
    assert.equal(crew.filter(u => !u.dead).length, 1);
    assert.ok(crew.slice(0, 3).every(u => hits.some(h => h.from === archer.id && h.target === u.id)));
    const stoppedAt = frameOf(scene), stopped = [ram.gx, ram.gy, gate.hp, ram.hitMs];
    // Plan C requires ≥35% casualties and 20 seconds without progress; allow extra frames after the crew deaths.
    for (let i = 0; i < 1350; i++) {
        step(scene);
        assert.deepEqual([ram.gx, ram.gy, gate.hp, ram.hitMs], stopped);
    }
    assert.equal(scene.battleOver, true);
    assert.equal(scene.endReason, '攻方受挫撤退');
    assert.ok(crew.every(u => u.dead || u.withdrawn));
    const replacement = soldier(scene, 'red', ram.gx + 3, ram.gy);
    const snapshot = () => ({ ram: structuredClone(ram), gate: structuredClone(gate),
        crew: [...crew, replacement].map(u => ({ id: u.id, gx: u.gx, gy: u.gy, hp: u.hp,
            dead: u.dead, withdrawn: u.withdrawn, role: u.siegeRole, anchor: u.siegeAnchor && { ...u.siegeAnchor } })) });
    const ended = snapshot();
    for (let i = 0; i < 252; i++) {
        scene.siege.step(scene, 1 / 60);
        assert.deepEqual(snapshot(), ended, 'battle end freezes ram and crew, including recruitment');
    }
    assert.equal(replacement.siegeRole, undefined);
    t.diagnostic(`stopped=${stoppedAt}; battleOver=${scene.battleOver}; frozenFrames=252`);
});

function control(layer) {
    const scene = makeScene();
    if (layer) scene.siege = layer;
    addUnit(scene, 'red', 'infantry', 30, 30);
    addUnit(scene, 'blue', 'infantry', 32, 30);
    addUnit(scene, 'red', 'archer', 27, 28);
    addUnit(scene, 'blue', 'archer', 35, 28);
    const frames = [];
    for (let i = 0; i < 600; i++) { step(scene); frames.push(state(scene)); }
    return frames;
}
test('ram #4: absent, height-only, and gate-only configurations produce identical frame trajectories', () => {
    const baseline = control();
    assert.deepEqual(control(createSiegeLayer()), baseline);
    const incomplete = createSiegeLayer([], { gate: { blockerId: 'unused' } });
    assert.equal(incomplete.step, undefined);
    assert.deepEqual(control(incomplete), baseline);
});

test('ram #5: two entire assaults have identical frame state, damage, breach and entry frames', t => {
    const first = assault(true), second = assault(true);
    assert.deepEqual(first.frames, second.frames);
    assert.deepEqual(first.hits, second.hits);
    assert.equal(first.brokenAt, second.brokenAt);
    assert.equal(first.enteredAt, second.enteredAt);
    t.diagnostic(`identicalFrames=${first.frames.length}; breach=${first.brokenAt}; entry=${first.enteredAt}`);
});

test('ram visuals: stepped breach opens retained leaves inward in 400ms; deployment rebuild resets all state', () => {
    const { scene } = assault();
    // Real stepped state drives the render functions; geometry can be inspected without WebGL.
    const fresh = camp(), rects = [...fresh.scene.dynamicBlockers.pending.values()];
    const group = buildCampVisuals(rects), ram = buildRamVisual();
    const gate = scene.siege.gate, hinges = group.userData.gateHinges;
    assert.equal(hinges.length, 2);
    updateCampGate(group, gate, gate.brokenAt + 200);
    for (const { hinge, side } of hinges) assert.equal(hinge.rotation.y, -side * Math.PI / 4);
    updateCampGate(group, gate, gate.brokenAt + 400);
    for (const { hinge, side } of hinges) assert.equal(hinge.rotation.y, -side * Math.PI / 2);
    updateRamVisual(ram, scene.siege.ram, scene.siege.ram.lastHitAt + 150);
    assert.equal(ram.userData.log.position.z, .4);
    updateRamVisual(ram, scene.siege.ram, scene.siege.ram.lastHitAt + 300);
    assert.equal(ram.userData.log.position.z, 0);
    assert.equal(fresh.scene.siege.gate.hp, 1800);
    assert.equal(fresh.scene.siege.gate.broken, false);
    assert.equal(fresh.scene.siege.ram.gy, fresh.scene.siege.ram.restY);
    assert.equal(fresh.scene.siege.ram.hits, 0);
    assert.deepEqual(fresh.scene.siege.ram.crew, [null, null, null, null]);
    updateCampGate(group, fresh.scene.siege.gate, 0);
    assert.ok(hinges.every(({ hinge }) => hinge.rotation.y === 0));
    step(fresh.scene);
    assert.equal(fresh.crew.filter(u => u.siegeAnchor && u.siegeRole === 'ram').length, 4);
    disposeCampVisuals(group); disposeCampVisuals(ram);
});

test('ram #6: three crew routs below 35% release to ordinary AI and halt advancing and impacts', t => {
    for (const phase of ['advancing', 'hitting']) {
        const { scene, crew, blue } = camp();
        const { ram, gate } = scene.siege;
        for (let i = 0; i < 6; i++) {
            const filler = soldier(scene, 'red', 3 + i, 3);
            filler.typeData = { ...filler.typeData, speed: 0, range: 0 };
        }
        // Keep every slot threatened: deathmatch routers stop to rally when safe.
        blue.gx = ram.gx + 3;
        blue.gy = ram.gy;
        step(scene);
        if (phase === 'hitting') {
            while (ram.state !== 'hitting' && frameOf(scene) < 300) step(scene);
        }
        assert.equal(ram.state, phase);
        const rout = unit => {
            unit.moraleState = 'routing';
            unit.morale = 0;
            unit.routStartedAt = scene.simulationTime;
            unit.target = unit.meleeTarget = blue;
        };
        crew.slice(0, 2).forEach(rout);
        step(scene);
        assert.equal(ram.crew.filter(id => id !== null).length, 2);
        crew.slice(0, 2).forEach(unit => {
            assert.equal(unit.siegeRole, undefined);
            assert.equal(unit.siegeAnchor, undefined);
            assert.equal(unit.target, null);
            assert.equal(unit.meleeTarget, null);
        });
        rout(crew[2]);
        const stopped = [ram.gx, ram.gy, gate.hp, ram.hitMs];
        step(scene);
        assert.equal(ram.crew.filter(id => id !== null).length, 1);
        assert.equal(scene.siege.rules.attackerLossRate, .3);
        assert.equal(scene.battleOver, false);
        assert.ok(crew.every(u => !u.withdrawn));
        for (const unit of crew.slice(0, 3)) {
            assert.equal(unit.siegeRole, undefined);
            assert.equal(unit.siegeAnchor, undefined);
            assert.equal(unit.meleeTarget, null);
        }
        assert.deepEqual([ram.gx, ram.gy, gate.hp, ram.hitMs], stopped);
        const released = crew.slice(0, 3).map(u => [u.gx, u.gy]);
        for (let i = 0; i < 150; i++) {
            step(scene);
            assert.deepEqual([ram.gx, ram.gy, gate.hp, ram.hitMs], stopped);
        }
        const moved = crew.slice(0, 3).map((u, i) => Math.hypot(u.gx - released[i][0], u.gy - released[i][1]));
        assert.ok(moved.every(d => d > 0), 'released crew return to ordinary AI and move');
        t.diagnostic(`${phase}: crew=1; stopped=${stopped}; routedDisplacement=${moved.map(d => d.toFixed(3))}`);
    }
});

test('ram #7: the only nearby infantry is routing and is never recruited', t => {
    const { scene, crew } = camp();
    const { ram } = scene.siege;
    for (const [i, unit] of crew.entries()) {
        unit.gx = ram.gx + 9 + i;
        unit.typeData = { ...unit.typeData, speed: 0 };
    }
    const router = crew[0];
    router.gx = ram.gx + 4;
    router.moraleState = 'routing';
    router.morale = 0;
    router.routStartedAt = scene.simulationTime;
    step(scene);
    for (let i = 0; i < 120; i++) {
        step(scene);
        assert.deepEqual(ram.crew, [null, null, null, null]);
        assert.equal(router.siegeRole, undefined);
        assert.equal(router.siegeAnchor, undefined);
    }
    assert.equal(router.moraleState, 'routing');
    assert.ok(Math.hypot(router.gx - ram.gx, router.gy - ram.gy) <= 6);
    t.diagnostic(`frames=${frameOf(scene)}; nearbyRoutingDistance=${Math.hypot(router.gx - ram.gx, router.gy - ram.gy)}; crew=0`);
});

test('ram #8: recruitment and release clear meleeTarget; pinned replacement deals no damage', t => {
    const { scene, crew, blue, hits } = camp();
    const { ram } = scene.siege;
    crew[0].target = crew[0].meleeTarget = blue;
    step(scene);
    assert.equal(crew[0].meleeTarget, null, 'initial recruitment clears melee target');
    crew[0].target = crew[0].meleeTarget = blue;
    crew[0].moraleState = 'routing';
    crew[0].morale = 0;
    crew[0].routStartedAt = scene.simulationTime;
    step(scene);
    assert.equal(crew[0].target, null);
    assert.equal(crew[0].meleeTarget, null, 'release clears melee target');
    while (frameOf(scene) < 120) step(scene);
    const enemy = soldier(scene, 'blue', ram.gx - .88 - .8, ram.gy - .5);
    enemy.typeData = { ...enemy.typeData, speed: 0 };
    const replacement = soldier(scene, 'red', ram.gx + 3, ram.gy);
    replacement.target = replacement.meleeTarget = enemy;
    step(scene);
    assert.equal(replacement.siegeRole, 'ram');
    assert.equal(replacement.target, null);
    assert.equal(replacement.meleeTarget, null);
    assert.ok(CombatRules.canStrike(scene, replacement, enemy, replacement.typeData.range), 'enemy is in legal melee reach');
    const recruitedAt = frameOf(scene);
    for (let i = 0; i < 150; i++) {
        step(scene);
        assert.equal(replacement.siegeRole, 'ram');
        assert.equal(replacement.meleeTarget, null);
    }
    assert.equal(hits.filter(h => h.from === replacement.id).length, 0);
    t.diagnostic(`recruited=${recruitedAt}; meleeTarget=${replacement.meleeTarget}; pinnedFrames=151; outgoingDamageRecords=0`);
});

test('ram #9: initial crew respect six tiles and a soldier moved within five is recruited within 2000ms', t => {
    const { scene, crew } = camp();
    const { ram } = scene.siege;
    for (const [i, unit] of crew.entries()) {
        unit.gx = ram.gx + 8 + i;
        unit.typeData = { ...unit.typeData, speed: 0 };
        assert.ok(Math.hypot(unit.gx - ram.gx, unit.gy - ram.gy) > 7);
    }
    step(scene);
    assert.deepEqual(ram.crew, [null, null, null, null]);
    assert.ok(crew.every(u => !u.siegeRole && !u.siegeAnchor));
    const addedAt = frameOf(scene), stopped = [ram.gx, ram.gy];
    crew[0].gx = ram.gx + 5;
    let recruitedAt = null;
    for (let i = 0; i < 120; i++) {
        step(scene);
        if (crew[0].siegeRole === 'ram') { recruitedAt = frameOf(scene); break; }
        assert.deepEqual(ram.crew, [null, null, null, null]);
    }
    assert.notEqual(recruitedAt, null);
    assert.ok(recruitedAt - addedAt <= 120);
    assert.deepEqual(ram.crew.filter(id => id !== null), [crew[0].id]);
    assert.deepEqual([ram.gx, ram.gy], stopped, 'one crew member cannot advance');
    t.diagnostic(`initialCrew=0; recruited=${recruitedAt}; waitMs=${((recruitedAt - addedAt) * STEP_MS).toFixed(3)}; finalCrew=1`);
});
