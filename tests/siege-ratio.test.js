import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeScene, addUnit } from './battle-harness.js';
import { createSiegeLayer } from '../js/battle/siege.js';
import { CAMP_LAYOUT as L } from '../js/siege3d/layout.js';
import { createCampSiege, siegeDeployment, installSiegeArrows } from '../js/siege3d/deployment.js';
import { campBounds, queueCampWalls } from '../js/siege3d/walls.js';

const step = s => { s.simulationTime += 1000 / 60; s.stepBattle(1 / 60); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function record(s) {
    const hits = [], original = s.recordDamage;
    s.recordDamage = function (target, damage, from, started) {
        hits.push([this.simulationTime, from.id, target.id, damage]);
        return original.call(this, target, damage, from, started);
    };
    return hits;
}
function fixed(s, team, type, x, y) {
    const u = addUnit(s, team, type, x, y);
    u.hp = u.maxHp = 100000;
    u.typeData = { ...u.typeData, atk: 100, def: 0, speed: 0 };
    u.meleeRoll = .5; u.nextShift = Infinity;
    u.siegeAnchor = { gx: x, gy: y };
    return u;
}
function singleHit({ cover, outside = false, ranged = false, elevated = false, enabled = true } = {}) {
    const s = makeScene(), b = campBounds();
    s.checkWin = () => {};
    s.siege = createSiegeLayer(createCampSiege(b, { defense: false }).platforms, {
        bounds: b, wallThickness: L.wallThickness, fenceCover: L.fenceCover,
        rules: { ...L.rules, enabled, interiorMeleeCover: cover }
    });
    const x = outside ? b.x1 - 1 : elevated || ranged ? b.x1 + .38 : b.cx;
    // Stay clear of the west tower so the walkway case exercises incoming height cover.
    const y = b.cy + 3;
    const d = fixed(s, 'blue', 'infantry', x, y);
    const a = fixed(s, 'red', ranged ? 'archer' : 'infantry',
        ranged ? b.x1 - 3 : outside ? x - 1.5 : x + 1.5, y);
    if (!ranged) a.typeData = { ...a.typeData, range: 5 };
    const update = s.updateNormalUnit;
    s.updateNormalUnit = function (u, ...args) { if (u === a) return update.call(this, u, ...args); };
    queueCampWalls(s); installSiegeArrows(s); s.rebuildSpatial();
    const hits = record(s);
    for (let i = 0; i < 300 && !hits.length; i++) step(s);
    assert.equal(hits.length, 1, 'one real impact must resolve through step()');
    assert.equal(hits[0][2], d.id);
    return hits[0][3];
}

test('ratio #1: interior and walkway melee receive exactly 0.8; outside, ranged and disabled rules do not', t => {
    for (const elevated of [false, true]) {
        const plain = singleHit({ elevated }), covered = singleHit({ elevated, cover: .8 });
        assert.equal(covered, plain * .8);
        assert.equal(covered / plain, .8);
        assert.equal(singleHit({ elevated, cover: .8, enabled: false }), plain);
        t.diagnostic(`elevated=${elevated}: melee ${plain} -> ${covered}, exact ratio=${covered / plain}`);
    }
    for (const options of [{ outside: true }, { ranged: true }]) {
        const plain = singleHit(options), covered = singleHit({ ...options, cover: .8 });
        assert.equal(covered, plain);
        t.diagnostic(`${JSON.stringify(options)}: ${plain} -> ${covered}`);
    }
});

function climb(configured) {
    const s = makeScene(), b = campBounds();
    const full = createCampSiege(b, { ladders: true, defense: false, ladderCarry: false });
    s.checkWin = () => {};
    s.siege = configured ? full : createSiegeLayer(full.platforms, { ladders: [full.ladders[0]], climbSeconds: L.climbSeconds });
    const ladder = s.siege.ladders[0];
    for (let i = 0; i < 6; i++) {
        const u = fixed(s, 'red', 'infantry', ladder.foot.gx - Math.floor(i / 3) * .75,
            ladder.foot.gy + (i % 3 - 1) * .75);
        delete u.siegeAnchor;
    }
    queueCampWalls(s); s.rebuildSpatial();
    let maximum = 0;
    const capacity = configured ? 1 : 2;
    for (let i = 0; i < 600; i++) {
        step(s);
        for (const l of s.siege.ladders) {
            const occupants = s.units.filter(u => u.siegeClimb?.ladder === l);
            assert.ok(occupants.length <= capacity);
            assert.equal(l.climbers.length, capacity);
            assert.deepEqual(occupants.map(u => u.id).sort((a, b) => a - b),
                l.climbers.filter(id => id !== null).sort((a, b) => a - b));
            maximum = Math.max(maximum, occupants.length);
        }
    }
    assert.equal(maximum, capacity, 'capacity must actually be exercised');
    assert.ok(s.siege.landedCount >= capacity * 2, 'observe replacement recruits and landings');
    return { maximum, landed: s.siege.landedCount };
}
test('ratio #2: createCampSiege passes capacity one; unconfigured siege layer retains capacity two on every step', t => {
    t.diagnostic(`configured=${JSON.stringify(climb(true))}; unconfigured=${JSON.stringify(climb(false))}`);
});

function deploy() {
    const s = makeScene(), b = campBounds();
    s.deployUnits(L.attackers, L.defenders, 'custom', 'custom', { red: 'advance', blue: 'advance' }, { terrain: 'flat' });
    s.siege = createCampSiege(b, { ladders: true });
    const placements = siegeDeployment(s.units, b, s.siege);
    for (const { unit, gx, gy, siegeAnchor } of placements) Object.assign(unit, { gx, gy, pgx: gx, pgy: gy, siegeAnchor });
    queueCampWalls(s); installSiegeArrows(s); s.rebuildSpatial();
    return s;
}
test('ratio #3: actual siege3d deployment contains 470 infantry, 80 pikemen and 50 archers after step()', () => {
    const s = deploy();
    step(s);
    const counts = Object.fromEntries(['infantry', 'pikeman', 'archer'].map(type =>
        [type, s.units.filter(u => u.team === 'red' && u.type === type).length]));
    assert.deepEqual(counts, { infantry: 470, pikeman: 80, archer: 50 });
    assert.equal(Object.values(counts).reduce((a, b) => a + b), 600);
});

function control(legacy = false) {
    const s = makeScene();
    s.siege = createSiegeLayer([{ x1: 31, x2: 34, y1: 27, y2: 32, height: .8 }]);
    if (legacy) s.siege.damageScale = (from, target) => {
        const delta = s.siege.heightAt(from.gx, from.gy) - s.siege.heightAt(target.gx, target.gy);
        return delta >= .4 ? 1.25 : -delta >= .4 ? .7 : 1;
    };
    for (const [team, type, x, y] of [['red', 'infantry', 30, 30], ['blue', 'infantry', 32, 30],
        ['red', 'archer', 27, 28], ['blue', 'archer', 35, 28]]) addUnit(s, team, type, x, y);
    const frames = [], hits = record(s), arrows = [];
    for (let i = 0; i < 600; i++) {
        step(s);
        frames.push(s.units.map(u => [u.id, u.gx, u.gy, u.hp, u.dead, u.withdrawn, u.morale, u.moraleState]));
        arrows.push(s.arrows.map(a => ({ ...a, source: a.source.id })));
    }
    return { frames, hits, arrows };
}
test('ratio #4: unconfigured layer preserves legacy units, hits and arrows (three deepEqual and pre-edit goldens)', t => {
    const before = control(true), after = control();
    assert.deepEqual(after.frames, before.frames);
    assert.deepEqual(after.hits, before.hits);
    assert.deepEqual(after.arrows, before.arrows);
    // Captured from 28d3a8a before changing source, using this exact fixture.
    assert.deepEqual([after.frames, after.hits, after.arrows].map(hash), [
        'ff3a453c8979423a1cbeefdb70af421f167e40dfc34fc0b0fa8e3c20fea0f1c0',
        'cc3a40e8a750625bbdc00f8a013cb846150f71c8e146332c12d1ba8b1dc587d7',
        '52011e008e5bae06e9f457c196be6838cc14003182c3f59e41946511ba047f41'
    ]);
    t.diagnostic(`legacy unchanged: frames=${after.frames.length}; hits=${after.hits.length}; arrowSnapshots=${after.arrows.length}`);
});
function assault() {
    const s = deploy(), frames = [], hits = record(s);
    let occupied = 0;
    for (let i = 0; i < 1800; i++) {
        step(s);
        for (const l of s.siege.ladders) {
            assert.ok(l.climbers.filter(id => id !== null).length <= 1);
            occupied += l.climbers.filter(id => id !== null).length;
        }
        frames.push(hash({
            units: s.units.map(u => [u.id, u.gx, u.gy, u.hp, u.dead, u.withdrawn, u.morale, u.moraleState,
                u.siegeRole, u.siegeDefenseRole, u.siegeClimb?.progress, u.siegeClimb?.height]),
            arrows: s.arrows.map(a => ({ ...a, source: a.source.id })),
            assignments: [...s.siege.defense.assignments].map(([u, a]) => [u.id, a]),
            ladders: s.siege.ladders.map(l => [l.id, l.climbers, l.recruitMs]),
            gate: s.siege.gate, ram: s.siege.ram, landed: s.siege.landedCount,
            capture: s.siege.rules.captureSeconds, loss: s.siege.rules.attackerLossRate,
            lastProgressAt: s.siege.rules.lastProgressAt, everInside: [...s.siege.rules.everInside],
            battleOver: s.battleOver, winner: s.winner
        }));
    }
    assert.ok(occupied > 0);
    assert.ok(hits.length > 0);
    return { frames, hits, occupied };
}
test('ratio #5: two complete deployments match on every one of 1800 step() frames', t => {
    const first = assault(), second = assault();
    assert.deepEqual(second, first);
    t.diagnostic(`identicalFrames=${first.frames.length}; hits=${first.hits.length}; occupiedLadderFrames=${first.occupied}; finalHash=${first.frames.at(-1)}`);
});
