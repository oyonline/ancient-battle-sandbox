import test from 'node:test';
import { CAMP_LAYOUT as L, LADDER_TOP_WORLD } from '../js/siege3d/layout.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeScene, addUnit, CombatRules, Terrain } from './battle-harness.js';
import { createSiegeLayer, LADDER_LIP } from '../js/battle/siege.js';
import { createCampSiege, installSiegeArrows, WALKWAY_HEIGHT } from '../js/siege3d/deployment.js';
import { campBounds, queueCampWalls, disposeCampVisuals } from '../js/siege3d/walls.js';
import { buildSiegeVisuals, climberWorldHeight } from '../js/siege3d/platforms.js';

const STEP_MS = 1000 / 60;
const frameOf = s => Math.round(s.simulationTime / STEP_MS);
function step(s) { s.simulationTime += STEP_MS; s.stepBattle(1 / 60); }
const state = s => s.units.map(({ id, gx, gy, hp, dead }) => ({ id, gx, gy, hp, dead }));
function soldier(s, team, gx, gy, type = 'infantry') {
    const u = addUnit(s, team, type, gx, gy);
    u.hp = u.maxHp = 10000;
    u.typeData = { ...u.typeData, speed: 0 };
    u.nextShift = Infinity;
    return u;
}
function camp(count = 5, defended = false, ladderIndex = 0) {
    const s = makeScene(), b = campBounds(), full = createCampSiege(b, { ladders: true });
    s.battleOptions.deathmatch = true;
    // These fixtures deliberately keep stepping after the last defender dies so
    // the remaining climb and ordinary AI handoff can be observed.
    s.checkWin = () => {};
    s.siege = createSiegeLayer(full.platforms, { ladders: [full.ladders[ladderIndex]] });
    queueCampWalls(s);
    installSiegeArrows(s);
    const l = s.siege.ladders[0];
    const inwardX = Math.sign(l.top.gx - l.foot.gx), inwardY = Math.sign(l.top.gy - l.foot.gy);
    const attackers = Array.from({ length: count }, (_, i) => soldier(s, 'red',
        l.foot.gx - inwardX * .75 * Math.floor(i / 3) + l.across.gx * (i % 3 - 1) * .75,
        l.foot.gy - inwardY * .75 * Math.floor(i / 3) + l.across.gy * (i % 3 - 1) * .75, i === 4 ? 'pikeman' : 'infantry'));
    const defender = defended ? soldier(s, 'blue', l.landing.gx + .08, l.landing.gy) : null;
    if (defender) defender.hp = 12;
    const hits = [], original = s.recordDamage;
    s.recordDamage = function (target, damage, from, started) {
        hits.push({ frame: frameOf(s), target: target.id, from: from.id, damage });
        return original.call(this, target, damage, from, started);
    };
    return { s, b, l, attackers, defender, hits };
}
function assertClimb(s, u) {
    const { progress: p, ladder: l, height, offset, landing } = u.siegeClimb;
    assert.ok(p > 0 && p <= 1);
    assert.equal(u.gx, l.foot.gx + (l.top.gx - l.foot.gx) * p + l.across.gx * offset);
    assert.equal(u.gy, l.foot.gy + (l.top.gy - l.foot.gy) * p + l.across.gy * offset);
    assert.equal(height, p * s.siege.heightAt(landing.gx, landing.gy));
    assert.equal(u.siegeAnchor.gx, u.gx);
    assert.equal(u.siegeAnchor.gy, u.gy);
    assert.equal(u.moving, false);
}
function assertClear(s, u) {
    for (const r of s.dynamicBlockers.list) {
        const dx = u.gx - Math.max(r.x1, Math.min(r.x2, u.gx));
        const dy = u.gy - Math.max(r.y1, Math.min(r.y2, u.gy));
        assert.ok(Math.hypot(dx, dy) >= CombatRules.bodyRadius(u) - 1e-6, `wall overlap: ${u.id} frame ${frameOf(s)}`);
    }
}

test('ladder #1: five infantry (including a pike) enter a sealed camp, capacity two and collision-safe handoff', t => {
    const { s, b, l, attackers, hits } = camp();
    const entries = new Map();
    for (let i = 0; i < 600; i++) {
        step(s);
        assert.ok(l.climbers.filter(id => id !== null).length <= 2);
        if (i === 0) assert.deepEqual(l.climbers, [attackers[1].id, attackers[0].id], 'nearest first, equal distance by id');
        for (const u of attackers) {
            if (u.siegeClimb) assertClimb(s, u);
            else assertClear(s, u);
            if (u.gx > b.x1 && !entries.has(u.id)) {
                entries.set(u.id, frameOf(s));
                assert.ok(Math.abs(u.gx - l.landing.gx) <= .071, 'only existing body-radius projection adjusts landing');
                assert.equal(u.siegeAnchor, undefined);
                assert.equal(u.siegeRole, undefined);
                assert.equal(s.siege.heightAt(u.gx, u.gy), WALKWAY_HEIGHT);
            }
        }
    }
    assert.equal(entries.size, 5);
    assert.ok(Math.abs(Math.min(...entries.values()) - 150) <= 2);
    assert.equal(s.siege.landedCount, 5, 'never recruit or count a landed unit twice');
    assert.deepEqual(l.climbers, [null, null]);
    assert.equal(hits.length, 0);
    t.diagnostic(`firstEntry=${Math.min(...entries.values())}; entries=${[...entries.values()]}; maxClimbers=2; landed=${s.siege.landedCount}`);
});

function contest(extraPair = false) {
    const r = camp(2, true), { s, b, l, attackers, defender, hits } = r;
    let outsiders = [];
    if (extraPair) outsiders = [soldier(s, 'red', b.x2 + .68, b.cy + 1, 'pikeman'),
        soldier(s, 'blue', b.x2 - .38, b.cy + 1, 'pikeman')];
    const frames = [];
    let lipAt = null, deathAt = null, resumedAt = null, enteredAt = null, heldFrames = 0;
    for (let i = 0; i < 900; i++) {
        step(s);
        const u = attackers[0];
        if (u.siegeClimb) {
            assertClimb(s, u);
            if (u.siegeClimb.progress === LADDER_LIP) {
                lipAt ??= frameOf(s);
                heldFrames++;
            }
            if (lipAt && !defender.dead) assert.equal(u.siegeClimb.progress, LADDER_LIP);
            if (deathAt && u.siegeClimb.progress > LADDER_LIP) resumedAt ??= frameOf(s);
        }
        if (defender.dead) deathAt ??= frameOf(s);
        if (s.siege.landedCount) enteredAt ??= frameOf(s);
        if (extraPair) {
            const [a, d] = outsiders;
            assert.ok(Math.hypot(a.gx - d.gx, a.gy - d.gy) < a.typeData.range, 'wall, not range, prevents melee');
            assert.equal(Terrain.segmentClear('flat', a.gx, a.gy, d.gx, d.gy, 0, s.dynamicBlockers), false);
            assert.equal(s.siege.meleeBypass(a, d), false);
        }
        frames.push({ units: state(s), progress: attackers.map(a => a.siegeClimb?.progress ?? null),
            slots: [...l.climbers], landed: s.siege.landedCount });
    }
    assert.equal(lipAt, 120);
    assert.ok(heldFrames > 1);
    assert.notEqual(deathAt, null);
    assert.equal(resumedAt, deathAt + 1);
    assert.equal(enteredAt, deathAt + 30);
    assert.ok(hits.some(h => h.from === defender.id && attackers.some(a => h.target === a.id)));
    assert.ok(hits.some(h => h.target === defender.id && attackers.some(a => h.from === a.id)));
    assert.ok(hits.every(h => h.frame >= lipAt), 'no attack while ascending below 80%');
    return { ...r, frames, lipAt, heldFrames, deathAt, resumedAt, enteredAt, outsiders };
}
test('ladder #2: 80% lip holds, mutual melee kills defender, climb resumes on next step', t => {
    const r = contest();
    t.diagnostic(`lip=${r.lipAt}; heldFrames=${r.heldFrames} (${r.heldFrames * STEP_MS}ms); defenderDeath=${r.deathAt}; resumed=${r.resumedAt}; entry=${r.enteredAt}; mutualHits=${r.hits.length}`);
});
test('ladder #3: a distant pair still cannot attack through the same sealed wall', () => {
    const r = contest(true), ids = r.outsiders.map(u => u.id);
    assert.ok(r.hits.every(h => !ids.includes(h.from) && !ids.includes(h.target)));
    assert.ok(r.outsiders.every(u => u.hp === 10000));
});
test('ladder #4: real arrows kill a climber, release its slot that step, and recruit within 1000ms', t => {
    const { s, l, attackers, hits } = camp(3);
    step(s);
    const aimed = attackers.find(u => u.id === l.climbers[0]);
    let victim = null;
    const reserve = attackers.find(u => !u.siegeClimb);
    const archer = soldier(s, 'blue', l.foot.gx - 2, l.foot.gy, 'archer');
    archer.typeData = { ...archer.typeData, range: 0 };
    for (let i = 0; i < 30; i++) step(s);
    s.fireArrow(archer, aimed, { rawAttack: 100000 });
    assert.ok(s.arrows.some(a => a.targetHeight > 0), 'arrow endpoint includes climb height');
    let deathAt = null, replacementAt = null;
    for (let i = 0; i < 120; i++) {
        step(s);
        victim ??= attackers.find(u => u.dead);
        if (victim && deathAt === null) {
            deathAt = frameOf(s);
            assert.ok(!l.climbers.includes(victim.id), 'released in damage frame');
            assert.equal(victim.siegeAnchor, undefined);
        }
        if (reserve.siegeClimb) { replacementAt = frameOf(s); break; }
    }
    assert.notEqual(deathAt, null);
    assert.notEqual(replacementAt, null);
    assert.ok(replacementAt - deathAt <= 60);
    assert.ok(hits.some(h => h.from === archer.id && h.target === victim.id));
    t.diagnostic(`shot=31; death=${deathAt}; replacement=${replacementAt}; waitMs=${(replacementAt - deathAt) * STEP_MS}`);
});
function control(layer) {
    const s = makeScene(), frames = [];
    if (layer) s.siege = layer;
    for (const [team, type, x, y] of [['red', 'infantry', 30, 30], ['blue', 'infantry', 32, 30],
        ['red', 'archer', 27, 28], ['blue', 'archer', 35, 28]]) addUnit(s, team, type, x, y);
    for (let i = 0; i < 600; i++) { step(s); frames.push(state(s)); }
    return frames;
}
test('ladder #5: absent / height-only / ram-without-ladders traces equal each other and pre-edit HEAD', () => {
    const baseline = control();
    const platforms = [{ x1: 1, y1: 1, x2: 2, y2: 2, height: .5 }];
    const height = createSiegeLayer(platforms);
    const ram = createSiegeLayer(platforms, { gate: { blockerId: 'unused' }, ram: { gx: 3, gateOuterY: 3 } });
    assert.equal(height.meleeBypass({}, {}), false);
    assert.equal(ram.meleeBypass({}, {}), false);
    assert.deepEqual(control(height), baseline);
    assert.deepEqual(control(ram), baseline);
    // Captured from a1f0937 before editing any source, same fixture and JSON bytes.
    assert.equal(createHash('sha256').update(JSON.stringify(baseline)).digest('hex'),
        'e3dd1f7235135d1fe6e7894ec29f6f9a223b5d15c0567b020ddcca7c4f9f01a7');
});
test('ladder #6: two full defended assaults have identical per-frame state and damage', () => {
    const a = contest(), b = contest();
    assert.deepEqual(a.frames, b.frames);
    assert.deepEqual(a.hits, b.hits);
});

test('ladder release: routing returns to foot and ordinary AI; ranged, cavalry and existing siege roles are ineligible', () => {
    const { s, l, attackers } = camp(3);
    const ineligible = ['archer', 'cavalry', 'infantry'].map((type, i) => soldier(s, 'red', l.foot.gx - 2, l.foot.gy + i, type));
    ineligible[2].siegeRole = 'ram';
    step(s);
    const u = attackers.find(a => a.siegeClimb);
    u.moraleState = 'routing';
    step(s);
    assert.equal(u.siegeRole, undefined);
    assert.equal(u.siegeAnchor, undefined);
    assert.ok(Math.hypot(u.gx - l.foot.gx, u.gy - l.foot.gy) < .1);
    for (let i = 0; i < 120; i++) step(s);
    assert.ok(ineligible.every(a => !a.siegeClimb));
});

test('ladder visuals: configured placements, dimensions, materials, shadows and fresh redeployment state', () => {
    const { s } = camp();
    step(s); // Real simulation creates occupied state before rebuilding.
    const b = campBounds(), fresh = createCampSiege(b, { ladders: true });
    assert.equal(fresh.ladders.length, L.sides.length * L.laddersPerSide);
    assert.equal(fresh.landedCount, 0);
    assert.ok(fresh.ladders.every(l => l.climbers.every(id => id === null) && !l.initialized));
    for (const l of fresh.ladders.filter(l => l.id.startsWith('south-'))) {
        assert.ok(Math.abs(l.top.gx - b.cx) - L.gateWidth / 2 >= L.southLadderGateClearance - 1e-9);
    }
    for (const [i, l] of fresh.ladders.filter(l => l.id.startsWith('west-')).entries()) {
        assert.equal(l.foot.gy, b.y1 + 2 * L.halfSize * (i + .5) / L.laddersPerSide);
    }
    const group = buildSiegeVisuals(fresh);
    for (const l of fresh.ladders) {
        const rails = group.children.filter(o => o.name === `${l.id}-rail`);
        const rungs = group.children.filter(o => o.name === `${l.id}-rung`);
        assert.equal(rails.length, 2);
        assert.ok(Math.abs(rails[0].position.distanceTo(rails[1].position) - .5) < 1e-9);
        assert.ok(rungs.length > 5);
        for (const rail of rails) {
            assert.equal(rail.geometry.parameters.width, .08);
            assert.equal(rail.geometry.parameters.depth, .08);
            assert.equal(rail.material.color.getHexString(), '785535');
            assert.equal(rail.position.y, LADDER_TOP_WORLD / 2);
        }
        for (const [i, rung] of rungs.entries()) {
            assert.equal(rung.geometry.parameters.width, .05);
            assert.ok(Math.abs(rung.geometry.parameters.height - .5) < 1e-9);
            assert.equal(rung.material.color.getHexString(), '8a6b42');
            if (i) assert.ok(Math.abs(rung.position.distanceTo(rungs[i - 1].position) - .3) < 1e-9);
        }
        for (const mesh of [...rails, ...rungs]) assert.ok(mesh.castShadow && mesh.receiveShadow);
    }
    disposeCampVisuals(group);
});

test('ladder handoff: a landed soldier uses ordinary AI to leave the walkway and fight inside', t => {
    const { s, b, attackers } = camp(1);
    const u = attackers[0];
    // Restore the real walking speed for the handoff; no defender blocks landing.
    u.typeData = { ...u.typeData, speed: 2.2 };
    while (frameOf(s) < 150) step(s);
    assert.equal(s.siege.landedCount, 1);
    const enemy = soldier(s, 'blue', b.x1 + 3, u.gy);
    let leftWalkwayAt = null;
    const initialHP = enemy.hp;
    for (let i = 0; i < 300; i++) {
        step(s);
        assertClear(s, u);
        assert.equal(u.siegeRole, undefined);
        assert.equal(u.siegeAnchor, undefined);
        if (s.siege.heightAt(u.gx, u.gy) === 0) leftWalkwayAt ??= frameOf(s);
    }
    assert.notEqual(leftWalkwayAt, null);
    assert.ok(enemy.hp < initialHP);
    assert.ok(u.hp < u.maxHp);
    assert.equal(s.siege.landedCount, 1);
    t.diagnostic(`leftWalkway=${leftWalkwayAt}; interiorEnemyDamage=${initialHP - enemy.hp}`);
});

test('ladder lip: bypass is pair-scoped and delayed attacks recheck the defender position', () => {
    const { s, l, attackers, defender, hits } = camp(1, true);
    while (frameOf(s) < 120) step(s);
    const u = attackers[0];
    assert.ok(s.siege.meleeBypass(u, defender));
    assert.ok(s.siege.meleeBypass(defender, u));
    assert.ok(s.battleQueue.length > 0, 'real melee attack has a pending windup');
    // A second landing guard keeps the climber at 80%; the attacked defender
    // moves away before the scheduled hit and must no longer qualify for bypass.
    const guard = soldier(s, 'blue', l.landing.gx + .08, l.landing.gy);
    guard.lastAttack = Infinity;
    defender.gy += 2;
    const oldHp = defender.hp;
    for (let i = 0; i < 8; i++) step(s);
    assert.equal(s.siege.meleeBypass(u, defender), false);
    assert.equal(defender.hp, oldHp);
    assert.ok(hits.every(h => h.target !== defender.id));
    assert.equal(s.siege.meleeBypass(u, { ...guard, team: u.team }), false);
});

test('ladder rework a: resumed climb cannot bypass or exchange damage with a guard 0.8 from landing', t => {
    const { s, attackers: [u], defender, hits } = camp(1, true);
    while (!defender.dead && frameOf(s) < 1200) step(s);
    assert.ok(defender.dead, 'the lip fight must kill the original defender');
    assert.ok(hits.some(h => h.from === u.id && h.target === defender.id));
    assert.ok(hits.some(h => h.from === defender.id && h.target === u.id));
    const deathAt = frameOf(s), { landing } = u.siegeClimb;
    const guard = soldier(s, 'blue', landing.gx + .8, landing.gy);
    assert.ok(Math.abs(Math.hypot(guard.gx - landing.gx, guard.gy - landing.gy) - .8) < 1e-12);
    let resumedFrames = 0;
    while (u.siegeClimb && frameOf(s) < deathAt + 40) {
        const previousAttack = u.lastAttack;
        step(s);
        if (!u.siegeClimb) break;
        resumedFrames++;
        assert.ok(u.siegeClimb.progress > LADDER_LIP && u.siegeClimb.progress < 1);
        assert.equal(u.siegeClimb.waiting, false);
        assert.equal(s.siege.meleeBypass(u, guard), false);
        assert.equal(s.siege.meleeBypass(guard, u), false);
        assert.equal(u.lastAttack, previousAttack, 'ascending climber must not start another attack');
        assert.ok(!hits.some(h => h.frame === frameOf(s) &&
            ((h.from === u.id && h.target === guard.id) || (h.from === guard.id && h.target === u.id))));
    }
    assert.equal(resumedFrames, 29);
    assert.equal(u.siegeClimb, undefined);
    assert.equal(guard.hp, guard.maxHp);
    t.diagnostic(`defenderDeath=${deathAt}; resumedFrames=${resumedFrames}; bypass=false both ways; resumedPairHits=0`);
});

test('ladder rework b: axe at the foot is ineligible and only infantry is recruited', t => {
    const { s, l } = camp(0);
    const axe = soldier(s, 'red', l.foot.gx, l.foot.gy, 'axe');
    const infantry = soldier(s, 'red', l.foot.gx - .5, l.foot.gy);
    for (let i = 0; i < 61; i++) {
        step(s);
        assert.deepEqual(l.climbers, [infantry.id, null]);
        assert.equal(axe.siegeClimb, undefined);
        assert.equal(axe.siegeRole, undefined);
    }
    t.diagnostic(`frames=61 (including refill); recruited=${infantry.type}; axeRecruited=false; occupiedSlots=1`);
});

test('ladder rework c: both slots stay at least 0.35 apart through climbing and landing on every configured ladder', t => {
    for (let index = 0; index < L.sides.length * L.laddersPerSide; index++) {
        const { s, l, attackers } = camp(2, false, index);
        const landings = new Map();
        let minDistance = Infinity, climbingFrames = 0;
        for (let i = 0; i < 150; i++) {
            const previousClimbs = attackers.map(u => u.siegeClimb);
            step(s);
            const distance = Math.hypot(attackers[0].gx - attackers[1].gx, attackers[0].gy - attackers[1].gy);
            minDistance = Math.min(minDistance, distance);
            assert.ok(distance >= .35, `slot overlap: ${l.id} frame ${frameOf(s)}`);
            if (attackers.every(u => u.siegeClimb)) {
                climbingFrames++;
                for (const u of attackers) assertClimb(s, u);
            }
            attackers.forEach((u, j) => {
                if (previousClimbs[j] && !u.siegeClimb) {
                    assert.equal(previousClimbs[j].progress, 1);
                    assert.equal(previousClimbs[j].height, WALKWAY_HEIGHT);
                    assert.equal(climberWorldHeight(previousClimbs[j]), LADDER_TOP_WORLD);
                    landings.set(u.id, { gx: u.gx, gy: u.gy });
                    assertClear(s, u);
                }
            });
        }
        assert.equal(climbingFrames, 149);
        assert.equal(landings.size, 2);
        const [a, b] = [...landings.values()];
        const landingDistance = Math.hypot(a.gx - b.gx, a.gy - b.gy);
        assert.ok(landingDistance >= .35);
        t.diagnostic(`${l.id}: minDistance=${minDistance}; landingDistance=${landingDistance}; climbingFrames=${climbingFrames}`);
    }
});

test('ladder rework d: every lip-fight step preserves exact interpolation and wall clearance; render height follows rails', t => {
    const { s, l, attackers: [u], defender, hits } = camp(1, true);
    defender.hp = defender.maxHp;
    const visuals = buildSiegeVisuals(s.siege);
    const rail = visuals.children.find(o => o.name === `${l.id}-rail`);
    const halfRail = rail.position.clone().set(0, rail.geometry.parameters.height / 2, 0).applyQuaternion(rail.quaternion);
    const footY = rail.position.y - halfRail.y, topY = rail.position.y + halfRail.y;
    assert.ok(Math.abs(footY) < 1e-12);
    assert.ok(Math.abs(topY - LADDER_TOP_WORLD) < 1e-12);
    let heldFrames = 0, maxPositionError = 0, minWallClearance = Infinity;
    for (let i = 0; i < 300; i++) {
        step(s);
        assertClimb(s, u);
        const climb = u.siegeClimb, p = climb.progress;
        const renderHeight = climberWorldHeight(climb);
        assert.ok(Math.abs(renderHeight - (footY + (topY - footY) * p)) < 1e-12);
        if (!climb.waiting) continue;
        heldFrames++;
        assert.equal(p, LADDER_LIP);
        assert.equal(renderHeight, LADDER_LIP * LADDER_TOP_WORLD);
        assert.equal(climb.height, LADDER_LIP * WALKWAY_HEIGHT, 'simulation height remains the walkway interpolation');
        const expectedX = l.foot.gx + (l.top.gx - l.foot.gx) * p + l.across.gx * climb.offset;
        const expectedY = l.foot.gy + (l.top.gy - l.foot.gy) * p + l.across.gy * climb.offset;
        const error = Math.hypot(u.gx - expectedX, u.gy - expectedY);
        maxPositionError = Math.max(maxPositionError, error);
        assert.equal(error, 0);
        assertClear(s, defender);
        for (const r of s.dynamicBlockers.list) {
            const dx = defender.gx - Math.max(r.x1, Math.min(r.x2, defender.gx));
            const dy = defender.gy - Math.max(r.y1, Math.min(r.y2, defender.gy));
            minWallClearance = Math.min(minWallClearance, Math.hypot(dx, dy));
        }
    }
    assert.ok(heldFrames > 1);
    assert.ok(hits.some(h => h.from === u.id && h.target === defender.id));
    assert.ok(hits.some(h => h.from === defender.id && h.target === u.id));
    t.diagnostic(`heldFrames=${heldFrames}; maxPositionError=${maxPositionError}; minDefenderWallClearance=${minWallClearance}; bodyRadius=${CombatRules.bodyRadius(defender)}; renderAtLip=${LADDER_LIP * LADDER_TOP_WORLD}; simulationAtLip=${LADDER_LIP * WALKWAY_HEIGHT}; railTop=${topY}`);
    disposeCampVisuals(visuals);
});
