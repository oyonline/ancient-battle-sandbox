import test from 'node:test';
import { LEGACY_LAYOUT as L } from './siege-legacy-support.js';
import assert from 'node:assert/strict';
import { makeScene, addUnit, CombatRules } from './battle-harness.js';
import { createSiegeLayer } from '../js/battle/siege.js';
import { campBounds, queueCampWalls, disposeCampVisuals } from '../js/siege3d/walls.js';
import { createCampSiege, deployCampArmies, installSiegeArrows, H_WORLD } from '../js/siege3d/deployment.js';
import { buildSiegeVisuals } from '../js/siege3d/platforms.js';

function step(scene) {
    scene.simulationTime += 1000 / 60;
    scene.stepBattle(1 / 60);
}
function record(scene) {
    const hits = [], original = scene.recordDamage;
    scene.recordDamage = function (target, damage, from, started) {
        hits.push({ frame: Math.round(this.simulationTime / (1000 / 60)), target: target.id, from: from.id, damage });
        return original.call(this, target, damage, from, started);
    };
    return hits;
}
const state = scene => scene.units.map(({ id, gx, gy, hp, dead }) => ({ id, gx, gy, hp, dead }));
const inside = (p, u) => u.gx >= p.x1 && u.gx <= p.x2 && u.gy >= p.y1 && u.gy <= p.y2;
const platform = { id: 'test-tower', x1: 29.3, y1: 29.3, x2: 30.7, y2: 30.7, height: 1.28, kind: 'tower' };

function duel(layer, defense = 0) {
    const scene = makeScene();
    if (layer) scene.siege = layer;
    installSiegeArrows(scene);
    const a = addUnit(scene, 'red', 'archer', 30, 30), b = addUnit(scene, 'blue', 'archer', 36, 30);
    for (const u of [a, b]) {
        // Large HP keeps all shots measurable; neutral roll isolates the prescribed multiplier.
        u.hp = u.maxHp = 10000;
        u.typeData = { ...u.typeData, atk: defense ? 26 : 100, def: defense, speed: 0 };
        u.meleeRoll = .5; u.nextShift = Infinity;
    }
    const hits = record(scene), heights = [];
    for (let i = 0; i < 300; i++) {
        step(scene);
        for (const arrow of scene.arrows) heights.push([arrow.source.id, arrow.sourceHeight, arrow.targetHeight]);
    }
    return { a, b, hits, heights };
}

test('siege height: stepped archers deal 1.25 outgoing / 0.7 incoming, with elevated arrow endpoints', t => {
    const rect = { ...platform, kind: 'walkway', height: 1 / H_WORLD };
    const layer = createSiegeLayer([{ ...rect, height: .1 }, rect]);
    const flat = duel(), high = duel(layer), armored = duel(layer, 3);
    assert.equal(layer.heightAt(30, 30), .5, 'overlap takes the highest platform');
    assert.equal(layer.heightAt(36, 30), 0);
    for (const h of flat.hits) assert.equal(h.damage, 100);
    assert.ok(high.hits.some(h => h.from === high.a.id));
    assert.ok(high.hits.some(h => h.from === high.b.id));
    for (const h of high.hits) assert.equal(h.damage, h.from === high.a.id ? 125 : 70);
    assert.ok(high.heights.some(([id, source, target]) => id === high.a.id && source === .5 && target === 0));
    assert.ok(high.heights.some(([id, source, target]) => id === high.b.id && source === 0 && target === .5));
    for (const h of armored.hits) assert.equal(h.damage, h.from === armored.a.id ? 29 : 15);
    t.diagnostic(`neutral armor: 100 -> 125 / 70; default archer armor, neutral roll: 23 -> 29 / 15; hits=${high.hits.length}`);
});

function towerBattle() {
    const scene = makeScene();
    scene.siege = createSiegeLayer([platform]);
    installSiegeArrows(scene);
    const tower = addUnit(scene, 'blue', 'archer', 30, 30);
    tower.siegeAnchor = { gx: 30, gy: 30, platformId: platform.id };
    tower.hp = tower.maxHp = 10000;
    for (let i = 0; i < 30; i++) {
        const angle = i * Math.PI * 2 / 30;
        const u = addUnit(scene, 'red', 'infantry', 30 + Math.cos(angle) * 1.1, 30 + Math.sin(angle) * 1.1);
        u.hp = u.maxHp = 10000;
    }
    const enemy = addUnit(scene, 'red', 'archer', 36, 30);
    enemy.hp = enemy.maxHp = 10000;
    enemy.typeData = { ...enemy.typeData, speed: 0 };
    const hits = record(scene), frames = [];
    for (let i = 0; i < 600; i++) {
        step(scene);
        assert.ok(inside(platform, tower), `left platform at frame ${i}`);
        assert.equal(tower.gx, 30); assert.equal(tower.gy, 30);
        frames.push(state(scene));
    }
    return { scene, tower, enemy, hits, frames };
}

test('siege anchor: 600 stepped frames resist 30 infantry, remain hittable and keep shooting', t => {
    const { tower, enemy, hits, scene } = towerBattle();
    assert.ok(CombatRules.canBeHit(tower));
    assert.equal(tower.garrisonTowerId, undefined);
    const incoming = hits.filter(h => h.target === tower.id && h.from === enemy.id);
    const outgoing = hits.filter(h => h.from === tower.id);
    assert.ok(incoming.length > 0, 'real enemy arrows must hit');
    assert.ok(tower.hp < 10000);
    assert.ok(outgoing.length >= 2, 'tower archer must shoot repeatedly');
    assert.ok(outgoing.some(h => h.frame > 450), 'tower still fires late in the run');
    assert.ok(!scene.navigation?.routes?.has(tower.id), 'no tower path request');
    t.diagnostic(`tower hp=${tower.hp}; enemy-arrow hits=${incoming.length}; outgoing hits=${outgoing.length}; last shot hit frame=${outgoing.at(-1)?.frame}`);
});

function controlTrace(layer) {
    const scene = makeScene();
    if (layer) scene.siege = layer;
    installSiegeArrows(scene);
    addUnit(scene, 'red', 'archer', 30, 28);
    addUnit(scene, 'blue', 'archer', 36, 28);
    addUnit(scene, 'red', 'infantry', 32, 31);
    addUnit(scene, 'blue', 'infantry', 33, 31);
    const hits = record(scene), frames = [];
    for (let i = 0; i < 600; i++) { step(scene); frames.push(state(scene)); }
    assert.ok(hits.some(h => h.from <= 2), 'archer combat exercised');
    assert.ok(hits.some(h => h.from >= 3), 'melee combat exercised');
    return frames;
}

test('siege off: absent, empty and distant layers have identical archer + melee trajectories each step', () => {
    const absent = controlTrace();
    assert.deepEqual(controlTrace(createSiegeLayer()), absent);
    assert.deepEqual(controlTrace(createSiegeLayer([{ ...platform, x1: 1, y1: 1, x2: 2, y2: 2 }])), absent);
});

test('siege determinism: two complete 600-frame tower battles match positions, hp, deaths and damage', () => {
    const a = towerBattle(), b = towerBattle();
    assert.deepEqual(a.frames, b.frames);
    assert.deepEqual(a.hits, b.hits);
});

test('siege3d deployment: configured tower archers and crew, infantry walkway priority and no wall overlap', t => {
    const scene = makeScene();
    // Retain enough infantry to exercise walkway overflow into interior slots.
    const { bounds: b, placements: deployment } = deployCampArmies(scene, {
        layout: L, defense: false, ladders: false });
    const towers = scene.siege.platforms.filter(p => p.kind === 'tower');
    assert.equal(deployment.filter(p => p.siegeAnchor).length, L.towerCount * L.archersPerTower);
    for (const p of towers) {
        const crew = deployment.filter(d => d.siegeAnchor?.platformId === p.id);
        assert.equal(crew.length, L.archersPerTower);
        assert.ok(crew.every(d => d.unit.type === 'archer' && inside(p, d)));
        assert.equal(p.height * H_WORLD, L.towerHeight);
    }
    const walkers = deployment.filter(d => d.platformId?.startsWith('walk-'));
    assert.ok(walkers.length > 0 && walkers.length < L.defenders.infantry);
    for (const d of walkers) {
        const p = scene.siege.platforms.find(p => p.id === d.platformId);
        assert.ok(inside(p, d));
        assert.equal(d.unit.type, 'infantry');
        assert.equal(p.height * H_WORLD, L.walkwayHeight);
    }
    assert.equal(scene.siege.heightAt(b.cx, b.y2 - .3), 0, '2.4-wide gate gap');
    const assertClear = () => {
        for (const u of scene.units) for (const r of scene.dynamicBlockers.list) {
            const x = Math.max(r.x1, Math.min(r.x2, u.gx)), y = Math.max(r.y1, Math.min(r.y2, u.gy));
            assert.ok(Math.hypot(u.gx - x, u.gy - y) >= CombatRules.bodyRadius(u) - 1e-6, `wall overlap: ${u.id}`);
        }
    };
    // Include the pending walls before step and their committed form after the full simulation step.
    for (const u of scene.units) assert.ok(Number.isFinite(u.gx) && Number.isFinite(u.gy));
    const pending = [...scene.dynamicBlockers.pending.values()];
    for (const u of scene.units) for (const r of pending) {
        assert.ok(Math.hypot(u.gx - Math.max(r.x1, Math.min(r.x2, u.gx)),
            u.gy - Math.max(r.y1, Math.min(r.y2, u.gy))) >= CombatRules.bodyRadius(u) - 1e-6);
    }
    step(scene); assertClear();
    const visuals = buildSiegeVisuals(scene.siege);
    visuals.traverse(o => { if (o.isMesh) assert.ok(o.castShadow && o.receiveShadow); });
    disposeCampVisuals(visuals);
    const rebuilt = createCampSiege(b, { defense: false });
    assert.notEqual(rebuilt, scene.siege);
    assert.deepEqual(rebuilt.platforms, scene.siege.platforms);
    t.diagnostic(`deployment=${deployment.length}; tower=${L.towerCount * L.archersPerTower}; walkway=${walkers.length}; interior=${Object.values(L.defenders).reduce((sum, n) => sum + n, 0) - L.towerCount * L.archersPerTower - walkers.length}`);
});
