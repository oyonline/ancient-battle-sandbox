import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { board } from '../js/board.js';
import { makeScene, addUnit } from './battle-harness.js';
import { createSiegeLayer } from '../js/battle/siege.js';
import { CAMP_LAYOUT as L } from '../js/siege3d/layout.js';
import { createCampSiege, siegeDeployment, installSiegeArrows } from '../js/siege3d/deployment.js';
import { campBounds, queueCampWalls } from '../js/siege3d/walls.js';
import { buildSiegeVisuals } from '../js/siege3d/platforms.js';
import { disposeCampVisuals } from '../js/siege3d/walls.js';

const DT = 1 / 60;
function step(s) { s.simulationTime += DT * 1000; s.stepBattle(DT); }
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inRect = (p, r) => p.gx >= r.x1 && p.gx <= r.x2 && p.gy >= r.y1 && p.gy <= r.y2;
function record(s) {
    const hits = [], original = s.recordDamage;
    s.recordDamage = function (target, damage, from, started) {
        hits.push([this.simulationTime, from.id, target.id, damage]);
        return original.call(this, target, damage, from, started);
    };
    return hits;
}

function duel({ cover = .5, reverse = false, gate = false, broken = false, legacy = false,
    melee = false, bothInside = false, bothOutside = false, unrelatedBlocker = false } = {}) {
    const s = makeScene(), b = campBounds();
    const platforms = createCampSiege(b, { defense: false }).platforms;
    s.siege = createSiegeLayer(platforms, {
        ...(cover == null ? {} : { fenceCover: cover }), bounds: b, wallThickness: L.wallThickness,
        gate: { blockerId: 'south-gate' }, ram: { gx: b.cx, gateOuterY: b.y2 + L.wallThickness }
    });
    if (legacy) s.siege.damageScale = (from, target) => {
        const difference = s.siege.heightAt(from.gx, from.gy) - s.siege.heightAt(target.gx, target.gy);
        let scale = 1;
        if (difference >= .4) scale *= 1.25;
        if (-difference >= .4) scale *= .7;
        return scale;
    };
    queueCampWalls(s);
    if (broken) {
        s.siege.gate.broken = true;
        s.dynamicBlockers.requestRemove('south-gate');
    }
    // A split-wall seam is intentional: north consists of two adjacent rectangles.
    const outside = gate ? [b.cx, b.y2 + 2] : [b.cx, b.y1 - 2];
    const inside = gate ? [b.cx, b.y2 - 1] : [b.cx, b.y1 + .38];
    if (bothInside) outside.splice(0, 2, b.cx + 2, b.y1 + .38);
    if (bothOutside) inside.splice(0, 2, b.cx + 2, b.y1 - 2);
    const a = addUnit(s, 'red', melee ? 'infantry' : 'archer', ...(reverse ? inside : outside));
    const d = addUnit(s, 'blue', 'infantry', ...(reverse ? outside : inside));
    for (const u of [a, d]) {
        u.hp = u.maxHp = 100000;
        u.typeData = { ...u.typeData, atk: 100, def: 0, speed: 0, ...(melee ? { range: 5 } : {}) };
        u.meleeRoll = .5; u.nextShift = Infinity;
        u.siegeAnchor = { gx: u.gx, gy: u.gy };
    }
    // Only the shooter acts; emission, delay, scatter, collision and damage stay real.
    const update = s.updateNormalUnit;
    s.updateNormalUnit = function (u, ...args) { if (u === a) return update.call(this, u, ...args); };
    if (unrelatedBlocker) {
        s.dynamicBlockers.requestAdd('unrelated', { x1: b.cx - 1, x2: b.cx + 1, y1: b.y2 + .8, y2: b.y2 + 1, kind: 'rock' });
    }
    installSiegeArrows(s);
    const hits = record(s), frames = [], arrows = [];
    for (let frame = 0; frame < 240; frame++) {
        step(s);
        frames.push(s.units.map(u => [u.id, u.gx, u.gy, u.hp, u.dead, u.morale, u.moraleState]));
        arrows.push(s.arrows.map(a => ({ ...a, source: a.source.id })));
    }
    assert.ok(hits.length > 0, 'damage must resolve through step()');
    return { hits, frames, arrows, first: hits[0][3] };
}

test('siege cover #1: outside arrows into walkway multiply height cover by exactly 0.5', t => {
    const plain = duel({ cover: null }), covered = duel();
    assert.equal(plain.first, 70); assert.equal(covered.first, 35);
    assert.deepEqual(covered.hits, plain.hits.map(h => [...h.slice(0, 3), h[3] * .5]));
    t.diagnostic(`walkway: ${plain.first} -> ${covered.first}; ratio=${covered.first / plain.first}; hits=${covered.hits.length}`);
});

test('siege cover #2: outgoing and same-side arrows receive no fence reduction', t => {
    for (const options of [{ reverse: true }, { bothInside: true }, { bothOutside: true }]) {
        const plain = duel({ ...options, cover: null }), covered = duel(options);
        assert.deepEqual(covered.hits, plain.hits);
        t.diagnostic(`${JSON.stringify(options)} damage=${covered.first}`);
    }
});

test('siege cover #3: intact gate covers; broken gate and unrelated obstacles do not', t => {
    const closed = duel({ gate: true }), open = duel({ gate: true, broken: true });
    assert.equal(closed.first, 50); assert.equal(open.first, 100);
    assert.deepEqual(open.hits, duel({ gate: true, broken: true, cover: null }).hits);
    assert.deepEqual(open.hits, duel({ gate: true, broken: true, unrelatedBlocker: true }).hits);
    t.diagnostic(`gate closed=${closed.first}; broken=${open.first}`);
});

test('siege cover #4: unconfigured layer matches pre-cover height rules every frame (three deepEqual)', t => {
    // null requests omission (undefined in a destructured argument uses its default).
    const original = duel({ cover: null, legacy: true }), current = duel({ cover: null });
    assert.deepEqual(current.frames, original.frames);
    assert.deepEqual(current.hits, original.hits);
    assert.deepEqual(current.arrows, original.arrows);
    t.diagnostic(`legacy match: ${current.frames.length} frames, ${current.hits.length} hits, ${current.arrows.length} arrow snapshots`);
});

function deploy() {
    const s = makeScene(), b = campBounds();
    s.deployUnits(L.attackers, L.defenders, 'custom', 'custom', { red: 'advance', blue: 'advance' }, { terrain: 'flat' });
    s.siege = createCampSiege(b, { ladders: true });
    const placements = siegeDeployment(s.units, b, s.siege);
    for (const { unit, gx, gy, siegeAnchor } of placements) Object.assign(unit, { gx, gy, pgx: gx, pgy: gy, siegeAnchor });
    queueCampWalls(s); installSiegeArrows(s); s.rebuildSpatial();
    return { s, b, placements };
}

function assertPostsClear(s) {
    const towers = s.siege.platforms.filter(p => p.kind === 'tower');
    for (const post of [...s.siege.defense.wallPosts, ...s.siege.defense.gatePosts,
        ...[...s.siege.defense.assignments.values()].map(a => a.post)]) {
        assert.ok(towers.every(t => !inRect(post, t)), `post overlaps tower: ${post.id}`);
    }
}

test('siege cover #5: assault-side towers clear landings, walkways and defense / gate posts', t => {
    const { s, b, placements } = deploy();
    step(s);
    const towers = s.siege.platforms.filter(p => p.kind === 'tower');
    const centers = towers.map(p => ({ gx: (p.x1 + p.x2) / 2, gy: (p.y1 + p.y2) / 2 }));
    assert.deepEqual(centers.slice(0, 3), [{ gx: b.cx, gy: b.y1 + 1.6 },
        { gx: b.x2 - 1.6, gy: b.cy }, { gx: b.x1 + 1.6, gy: b.cy }]);
    const south = centers[3], gateDistance = Math.hypot(south.gx - (b.cx + L.gateWidth / 2), south.gy - b.y2);
    const landingDistance = Math.min(...s.siege.ladders.map(l => Math.hypot(south.gx - l.landing.gx, south.gy - l.landing.gy)));
    assert.ok(south.gx > b.cx + L.gateWidth / 2 && south.gx < b.cx + L.gateWidth / 2 + L.southLadderGateClearance);
    assert.ok(gateDistance >= 2 - 1e-12); assert.ok(landingDistance >= 1.5);
    for (const tower of towers) {
        assert.ok(s.siege.ladders.every(l => !inRect(l.landing, tower)));
        for (const p of s.siege.platforms.filter(p => p.kind === 'walkway')) {
            assert.ok(tower.x2 < p.x1 || tower.x1 > p.x2 || tower.y2 < p.y1 || tower.y1 > p.y2);
        }
        const crew = placements.filter(p => p.siegeAnchor?.platformId === tower.id);
        assert.equal(crew.length, 3);
        for (const p of crew) {
            assert.equal(p.unit.type, 'archer'); assert.equal(p.unit.team, 'blue');
            assert.ok(inRect(p.unit, tower));
            assert.deepEqual([p.unit.gx, p.unit.gy], [p.gx, p.gy]);
        }
    }
    assertPostsClear(s);
    const roles = [...s.siege.defense.assignments.values()].map(a => a.role);
    assert.equal(roles.filter(r => r === 'wall').length, 162);
    assert.equal(roles.filter(r => r === 'reserve').length, 88);
    assert.equal(roles.filter(r => r === 'archer').length, 38);
    const visuals = buildSiegeVisuals(s.siege);
    const decks = visuals.children.filter(o => o.geometry?.parameters.height === .12);
    assert.equal(decks.length, 4);
    assert.deepEqual(decks.map(o => [o.position.x + board.W / 2, o.position.z + board.H / 2]),
        centers.map(p => [p.gx, p.gy]));
    disposeCampVisuals(visuals);
    // Trigger the existing breach transition through a full step, then inspect all ranks.
    s.siege.gate.broken = true; s.dynamicBlockers.requestRemove('south-gate'); step(s);
    assert.ok(s.siege.defense.gatePosts.length > 0); assertPostsClear(s);
    t.diagnostic(`centers=${JSON.stringify(centers)}; gateDistance=${gateDistance}; nearestLanding=${landingDistance}; skipped=${JSON.stringify([...s.siege.defense.skippedTowerPosts.keys()])}`);
});

function assault() {
    const { s } = deploy(), frames = [], hits = record(s);
    let gateFrame = null;
    for (let frame = 1; frame <= 1800; frame++) {
        step(s); assertPostsClear(s);
        if (s.siege.gate.broken) gateFrame ??= frame;
        frames.push(digest({
            units: s.units.map(u => [u.id, u.gx, u.gy, u.hp, u.dead, u.withdrawn, u.morale, u.moraleState,
                u.siegeRole, u.siegeDefenseRole, u.siegeClimb?.progress]),
            arrows: s.arrows.map(a => ({ ...a, source: a.source.id })),
            assignments: [...s.siege.defense.assignments].map(([u, a]) => [u.id, a]),
            ladders: s.siege.ladders.map(l => [l.id, l.climbers, l.recruitMs]),
            gate: s.siege.gate, ram: s.siege.ram, landed: s.siege.landedCount,
            battleOver: s.battleOver, winner: s.winner
        }));
    }
    return { frames, hits, gateFrame, landed: s.siege.landedCount };
}

test('siege cover #6: two complete siege3d deployments match on all 1800 steps', t => {
    const first = assault(), second = assault();
    assert.deepEqual(second, first);
    t.diagnostic(`identicalFrames=${first.frames.length}; hits=${first.hits.length}; gateFrame=${first.gateFrame}; landed=${first.landed}; finalHash=${first.frames.at(-1)}`);
});
