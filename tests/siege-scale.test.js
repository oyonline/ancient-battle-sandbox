import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { makeScene, UNIT_TYPES, Terrain } from './battle-harness.js';
import { board, setBoardSize } from '../js/board.js';
import { battleProjection } from '../js/net/lockstep.js';
import { CAMP_LAYOUT as L } from '../js/siege3d/layout.js';
import { deployCampArmies, configureCampArmies } from '../js/siege3d/deployment.js';
import { buildCampTents, buildSurroundings } from '../js/siege3d/scenery.js';
import { disposeCampVisuals } from '../js/siege3d/walls.js';
import { deployVariant, step } from '../tools/siege-balance.mjs';
import { stateSummary, digest } from './siege-assault-support.js';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

test('scale: default/territory/coop preserve pre-A1 deployment and 120-step state', () => {
    const golden = fixture('siege-scale-nonsiege-f6ac8a6.json');
    for (const [mode, options] of Object.entries(golden.scenarios)) {
        const s = makeScene();
        s.deployUnits(golden.config, golden.config, 'custom', 'custom', {}, options);
        assert.deepEqual([board.W, board.H], mode === 'territory' ? [260, 180] : [70, 70]);
        assert.equal(UNIT_TYPES.archer.range, 9.5);
        assert.ok(s.units.filter(u => u.type === 'archer').every(u => u.typeData.range === 9.5));
        step(s, golden.steps); s.flags ??= [];
        const summary = { units: s.units.map(u => Object.fromEntries(Object.entries(u).filter(([k, v]) =>
            !['bobPhase', 'slideOff'].includes(k) && (v === null || ['number', 'string', 'boolean'].includes(typeof v))))),
        projection: s.territory ? battleProjection(s) : null, stats: s.battleStats, time: s.simulationTime };
        assert.equal(digest(summary), golden.hashes[mode], mode);
    }
});

test('scale: shared deployment initializes 100x100, 300/100, instance range and queued walls without stepping', () => {
    const s = makeScene();
    s.ensureNavigation().routes.set('stale', {});
    setBoardSize(70, 70);
    const oldTerrain = Terrain.geometry('flat');
    const { bounds: b } = deployCampArmies(s);
    assert.deepEqual([board.W, board.H, board.MARGIN], [100, 100, 0]);
    assert.equal(s.units.filter(u => u.team === 'red').length, 300);
    assert.equal(s.units.filter(u => u.team === 'blue').length, 100);
    for (const u of s.units) {
        assert.equal(u.typeData.range, u.type === 'archer' ? 20 : UNIT_TYPES[u.type].range);
        if (u.type === 'archer') assert.notEqual(u.typeData, UNIT_TYPES.archer);
        else assert.equal(u.typeData, UNIT_TYPES[u.type]);
    }
    assert.equal(UNIT_TYPES.archer.range, 9.5);
    assert.equal(s.navigation.routes.size, 0);
    assert.notEqual(Terrain.geometry('flat'), oldTerrain);
    assert.equal(s.simulationTime, 0); assert.equal(s.dynamicBlockers.size, 0);
    assert.equal(s.dynamicBlockers.pending.size, 9);
    const tower = s.units.filter(u => u.siegeAnchor);
    assert.equal(tower.length, 12);
    assert.equal(s.units.filter(u => u.team === 'blue' && u.type === 'archer' && !u.siegeAnchor).length, 8);
    const south = s.siege.ladders.filter(l => l.face === 'south').map(l => l.top.gx);
    assert.deepEqual(south, [44.8, 46.8, 53.2, 55.2]);
    assert.ok(south.every(x => Math.abs(x - b.cx) - L.gateWidth / 2 >= 2 - 1e-9));
    step(s); assert.equal(s.dynamicBlockers.size, 9);
});

test('scale: actual archer releases at 15 cells via complete step and delayed release', () => {
    const s = makeScene();
    deployCampArmies(s, { defense: false, ladders: false, rules: false });
    const archer = s.units.find(u => u.team === 'red' && u.type === 'archer');
    const target = s.units.find(u => u.team === 'blue' && u.type === 'infantry');
    s.units = [archer, target]; s.checkWin = () => {};
    for (const [u, gx] of [[archer, 10], [target, 25]]) {
        Object.assign(u, { gx, pgx: gx, gy: 20, pgy: 20, siegeAnchor: { gx, gy: 20 }, nextShift: Infinity });
        u.typeData = { ...u.typeData, speed: 0 };
    }
    const shots = [], fire = s.fireArrow;
    s.fireArrow = function (from, to, options) {
        shots.push({ from: from.id, to: to.id, distance: Math.hypot(from.gx - to.gx, from.gy - to.gy), at: this.simulationTime });
        return fire.call(this, from, to, options);
    };
    s.rebuildSpatial(); step(s, 120);
    assert.ok(shots.some(a => a.from === archer.id && a.to === target.id && a.distance > 9.5 && a.distance <= 20 && a.at >= 110));
});

test('scale: tents follow camp center and all 1500 tree instance origins remain outside the field', () => {
    const build = size => { setBoardSize(size, size); return buildCampTents(); };
    const before = build(70), after = build(100);
    assert.equal(before.children.length, 9); assert.equal(after.children.length, 9);
    for (let i = 0; i < before.children.length; i++) {
        assert.ok(Math.abs((after.children[i].position.x + 50) - (before.children[i].position.x + 35) - 15) < 1e-10);
        assert.ok(Math.abs((after.children[i].position.z + 50) - (before.children[i].position.z + 35) - 15) < 1e-10);
    }
    const surroundings = buildSurroundings(new THREE.Texture());
    const trees = surroundings.getObjectByName('outskirts-trees'), matrix = new THREE.Matrix4();
    assert.equal(trees.count, 1500);
    let inside = 0;
    for (let i = 0; i < trees.count; i++) {
        trees.getMatrixAt(i, matrix);
        const x = matrix.elements[12], z = matrix.elements[14];
        if (Math.abs(x) <= board.W / 2 && Math.abs(z) <= board.H / 2) inside++;
    }
    assert.equal(inside, 0);
    for (const group of [before, after, surroundings]) disposeCampVisuals(group);
});

test('scale: page startBattle(player) invokes configuration only, retaining all 400 unit objects', () => {
    const source = readFileSync(new URL('../js/siege3d/main.js', import.meta.url), 'utf8');
    const s = makeScene(); deployCampArmies(s);
    const units = [...s.units], nextId = s.nextId;
    s.clearUnits = () => {}; // Match the real page contract.
    s.deployUnits = () => assert.fail('startBattle must not generate units');
    const context = { scene: s, deploying: false, configureCampArmies,
        refreshCampVisuals() {}, syncAssaultControls() {}, sync3D() {},
        $: () => ({}), Snd: { play() {} }, campVersion: 0 };
    vm.runInNewContext(source.match(/function positionArmies\([^]*?\n}/)[0] + '\n' +
        source.match(/function startBattle\([^]*?\n}/)[0] + "\nstartBattle('player');", context);
    assert.equal(s.units.length, 400); assert.equal(s.nextId, nextId);
    assert.ok(s.units.every((u, i) => u === units[i]));
    assert.equal(s.siege.assault.player, true); assert.equal(s.siege.assault.stagingClearance, 27);
    assert.equal(s.simulationTime, 0);
    const defenders = s.units.filter(u => u.team === 'blue');
    for (const u of s.units.filter(u => u.team === 'red' && !u.typeData.ranged)) {
        assert.ok(Math.abs(Math.hypot(u.gx - u.siegeStaging.gx, u.gy - u.siegeStaging.gy) - 5) < 1e-10);
        assert.ok(defenders.every(d => Math.hypot(d.gx - u.siegeStaging.gx, d.gy - u.siegeStaging.gy) > 24));
    }
});

test('scale: fixed config seed173 variants1/6 auto golden at 60-frame samples through 600', () => {
    const golden = fixture('siege-auto-100x100-300v100-range20-seed173.json');
    const { archerLineClearance, ...autoLayout } = L;
    assert.equal(archerLineClearance, 18.5);
    assert.deepEqual(golden.layout, autoLayout);
    for (const variant of golden.variants) {
        const s = deployVariant({ layout: golden.layout, seed: golden.seed, variant: variant.id, jitter: golden.jitter });
        for (const row of variant.samples) {
            step(s, golden.sampleEvery);
            assert.equal(digest(stateSummary(s)), row.sha256, `variant=${variant.id}, frame=${row.frame}`);
        }
    }
});
