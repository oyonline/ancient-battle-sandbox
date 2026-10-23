import test from 'node:test';
import { CAMP_LAYOUT as L } from '../js/siege3d/layout.js';
import assert from 'node:assert/strict';
import { makeScene, addUnit } from './battle-harness.js';
import { createSiegeLayer } from '../js/battle/siege.js';
import { board } from '../js/board.js';
import { campBounds, queueCampWalls } from '../js/siege3d/walls.js';
import { ATTACKERS, DEFENDERS, createCampSiege, siegeDeployment, installSiegeArrows } from '../js/siege3d/deployment.js';

const SHOTS = 200, HP = 1e9;
function step(scene) {
    scene.simulationTime += 1000 / 60;
    scene.stepBattle(1 / 60);
}

function shootingRange({ distance = 9, dense = false, centerFocus = true, siege = true, wrap = true, scene = makeScene(),
    platforms = [], terrain = 'flat', targetX = 30, targetY = 30 } = {}) {
    scene.setTerrain(terrain);
    if (siege) scene.siege = createSiegeLayer(platforms);
    if (wrap) installSiegeArrows(scene);
    const archer = addUnit(scene, 'red', 'archer', targetX - distance, targetY);
    // Keep distance fixed while retaining real AI, cooldown, draw delay and flight.
    archer.typeData = { ...archer.typeData, speed: 0 };
    archer.nextShift = Infinity;
    const targets = [];
    for (let y = dense ? -1 : 0; y <= (dense ? 1 : 0); y++) {
        for (let x = dense ? -1 : 0; x <= (dense ? 1 : 0); x++) {
            const u = addUnit(scene, 'blue', 'infantry', targetX + x * .6, targetY + y * .6);
            u.hp = u.maxHp = HP;
            // Normal AI focuses the wounded center. This keeps >=6 enemies within
            // one cell of the aim point, rather than aiming at a four-neighbor corner.
            if (dense && centerFocus && x === 0 && y === 0) u.hp = HP / 2;
            // Siege posts keep the dense formation stationary through separation too.
            if (siege) u.siegeAnchor = { gx: u.gx, gy: u.gy };
            targets.push(u);
        }
    }
    const update = scene.updateNormalUnit;
    scene.updateNormalUnit = function (u, ...args) {
        if (u.team === 'blue' || shots.length >= SHOTS) return;
        return update.call(this, u, ...args);
    };
    const shots = [], seen = new WeakSet();
    const fire = scene.fireArrow;
    scene.fireArrow = function (from, target, options) {
        const d = Math.hypot(target.gx - from.gx, target.gy - from.gy);
        const dur = Math.max(.3, Math.min(.75, d / 12));
        const lead = v => v ? Math.max(-1.5, Math.min(1.5, v * dur)) : 0;
        const predicted = [
            Math.max(.5, Math.min(board.W - .5, target.gx + lead(target.velX))),
            Math.max(.5, Math.min(board.H - .5, target.gy + lead(target.velY)))
        ];
        const result = fire.call(this, from, target, options);
        for (const a of this.arrows) if (!seen.has(a)) {
            seen.add(a);
            shots.push({ ...a, source: a.source.id, predicted });
        }
        return result;
    };
    let hits = 0;
    const record = scene.recordDamage;
    scene.recordDamage = function (target, damage, from, started) {
        if (from === archer) hits++;
        return record.call(this, target, damage, from, started);
    };
    let frames = 0;
    while (frames++ < 30000 && (shots.length < SHOTS || scene.arrows.length || scene.battleQueue.length)) step(scene);
    scene.updateNormalUnit = update;
    scene.fireArrow = fire;
    scene.recordDamage = record;
    assert.equal(shots.length, SHOTS, `shots after ${frames} frames`);
    assert.equal(scene.arrows.length, 0, 'all arrows landed through step()');
    assert.equal(scene.battleQueue.length, 0, 'all scheduled releases completed');
    for (const u of targets) assert.equal(u.dead, false);
    return { scene, shots, hits, rate: hits / shots.length };
}

function report(t, run) {
    t.diagnostic(`hits=${run.hits}/${run.shots.length}; rate=${(100 * run.rate).toFixed(2)}%`);
}

test('siege archery #1: stationary single target at 9 cells hits 40–60%', t => {
    const run = shootingRange();
    report(t, run);
    assert.ok(run.rate >= .4 && run.rate <= .6, `rate=${run.rate}`);
    for (const a of run.shots) {
        const r = .12 * Math.hypot(a.predicted[0] - a.sx, a.predicted[1] - a.sy);
        assert.ok(Math.hypot(a.tx - a.predicted[0], a.ty - a.predicted[1]) <= r + 1e-12);
    }
});

test('siege archery #2: stationary single target at 3 cells hits at least 90%', t => {
    const run = shootingRange({ distance: 3 });
    report(t, run);
    assert.ok(run.rate >= .9, `rate=${run.rate}`);
});

test('siege archery #3: 3×3 enemy formation at 0.6 spacing hits at least 90%', t => {
    const run = shootingRange({ dense: true });
    report(t, run);
    const aimCounts = new Map();
    for (const a of run.shots) {
        const aim = a.predicted.join(',');
        aimCounts.set(aim, (aimCounts.get(aim) ?? 0) + 1);
        const nearby = run.scene.units.filter(u => u.team === 'blue' &&
            Math.hypot(u.gx - a.predicted[0], u.gy - a.predicted[1]) <= 1);
        assert.ok(nearby.length >= 6, 'dense-target premise holds for every shot');
    }
    t.diagnostic(`predicted targets: ${JSON.stringify(Object.fromEntries(aimCounts))}`);
    for (const u of run.scene.units.filter(u => u.team === 'blue')) {
        assert.equal(u.gx, u.siegeAnchor.gx);
        assert.equal(u.gy, u.siegeAnchor.gy);
    }
    assert.ok(run.rate >= .9, `rate=${run.rate}`);
});

test('siege archery: equal-HP formation diagnoses edge focus outside the dense-target premise', t => {
    const run = shootingRange({ dense: true, centerFocus: false });
    report(t, run);
    const underDensity = run.shots.filter(a => run.scene.units.filter(u => u.team === 'blue' &&
        Math.hypot(u.gx - a.predicted[0], u.gy - a.predicted[1]) <= 1).length < 6).length;
    assert.ok(underDensity > 0, 'ordinary equal-HP targeting also aims outside the >=6-neighbor premise');
    t.diagnostic(`shots outside dense-target premise=${underDensity}/${run.shots.length}; R remains 0.12d`);
});

test('siege archery #4: without siege every endpoint equals its prediction and the unwrapped emitter', t => {
    const wrapped = shootingRange({ siege: false }), original = shootingRange({ siege: false, wrap: false });
    for (const a of wrapped.shots) assert.deepEqual([a.tx, a.ty], a.predicted);
    assert.deepEqual(wrapped.shots, original.shots, 'every emitted arrow field remains identical');
    assert.deepEqual(wrapped.scene.units.map(u => [u.gx, u.gy, u.hp]), original.scene.units.map(u => [u.gx, u.gy, u.hp]));
    report(t, wrapped);
});

test('siege archery #5: repeated battles and redeployment reset the exact endpoint sequence', () => {
    const first = shootingRange(), second = shootingRange();
    const endpoints = run => run.shots.map(a => [a.tx, a.ty]);
    assert.deepEqual(endpoints(second), endpoints(first));
    const scene = first.scene;
    scene.deployUnits({}, {}, 'custom', 'custom', { red: 'advance', blue: 'advance' }, { terrain: 'flat' });
    const redeployed = shootingRange({ scene, wrap: false }); // wrapper survives deployment, layer is rebuilt
    assert.deepEqual(endpoints(redeployed), endpoints(first));
});

test('siege archery #6: stepped siege3d deployment has configured armies and tower archers', () => {
    const scene = makeScene();
    scene.deployUnits(ATTACKERS, DEFENDERS, 'custom', 'custom', { red: 'advance', blue: 'advance' }, { terrain: 'flat' });
    const bounds = campBounds();
    scene.siege = createCampSiege(bounds);
    const deployment = siegeDeployment(scene.units, bounds, scene.siege);
    for (const { unit, gx, gy, siegeAnchor } of deployment) Object.assign(unit, { gx, gy, pgx: gx, pgy: gy, siegeAnchor });
    queueCampWalls(scene);
    installSiegeArrows(scene);
    step(scene);
    const count = (team, type) => scene.units.filter(u => u.team === team && (!type || u.type === type)).length;
    assert.equal(count('red'), Object.values(L.attackers).reduce((a, b) => a + b, 0));
    assert.equal(count('red', 'archer'), L.attackers.archer);
    assert.equal(count('blue'), Object.values(L.defenders).reduce((a, b) => a + b, 0));
    assert.equal(count('blue', 'archer'), L.defenders.archer);
    const towerArchers = scene.units.filter(u => u.siegeAnchor?.platformId?.startsWith('tower-'));
    assert.equal(towerArchers.length, L.towerCount * L.archersPerTower);
    assert.ok(towerArchers.every(u => u.team === 'blue' && u.type === 'archer'));
    assert.ok(scene.units.every(u => Number.isFinite(u.gx) && Number.isFinite(u.gy)));
});

test('siege archery: scattered landing samples terrain/platform height and stays inside the board', () => {
    const platform = { id: 'small-post', x1: 29.9, y1: 29.9, x2: 30.1, y2: 30.1, height: .5 };
    const run = shootingRange({ platforms: [platform], terrain: 'hill' });
    assert.ok(run.shots.some(a => run.scene.siege.heightAt(a.tx, a.ty) === 0));
    assert.ok(run.shots.some(a => run.scene.siege.heightAt(a.tx, a.ty) === .5));
    for (const a of run.shots) {
        const expected = run.scene.terrainHeight(a.tx, a.ty) + run.scene.siege.heightAt(a.tx, a.ty);
        assert.ok(Math.abs(a.targetHeight - expected) < 1e-12);
        assert.equal(a.sourceHeight, run.scene.terrainHeight(a.sx, a.sy));
    }
    const edge = shootingRange({ targetX: board.W - .6, targetY: board.H - .6 });
    assert.ok(edge.shots.some(a => a.tx === board.W - .5 || a.ty === board.H - .5));
    for (const a of edge.shots) {
        assert.ok(a.tx >= .5 && a.tx <= board.W - .5);
        assert.ok(a.ty >= .5 && a.ty <= board.H - .5);
    }
});
