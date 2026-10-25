import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { makeScene, addUnit, CombatRules } from './battle-harness.js';
import { board } from '../js/board.js';
import { CAMP_LAYOUT as L, LADDER_TOP_WORLD } from '../js/siege3d/layout.js';
import { createCampSiege, siegeDeployment, installSiegeArrows, WALKWAY_HEIGHT } from '../js/siege3d/deployment.js';
import { campBounds, queueCampWalls, buildCampVisuals, disposeCampVisuals } from '../js/siege3d/walls.js';

const DT = 1 / 60;
const total = army => Object.values(army).reduce((sum, n) => sum + n, 0);
function step(scene) { scene.simulationTime += DT * 1000; scene.stepBattle(DT); }
function deploy(scene = makeScene(), compact = false) {
    scene.deployUnits(L.attackers, L.defenders, 'custom', 'custom', { red: 'advance', blue: 'advance' }, { terrain: 'flat' });
    const bounds = campBounds();
    // compact 钉回旧紧凑布局：破门/登墙时间线在 2400 帧预算内（验证全流程确定性）
    scene.siege = createCampSiege(bounds, { ladders: true, defense: false, ...(compact ? { ramRestOffset: 3.2 } : {}) });
    const placements = siegeDeployment(scene.units, bounds, scene.siege, compact ? 6 : L.attackerFrontClearance);
    for (const { unit, gx, gy, siegeAnchor } of placements) Object.assign(unit, { gx, gy, pgx: gx, pgy: gy, siegeAnchor });
    queueCampWalls(scene);
    scene.rebuildSpatial();
    return { scene, bounds, placements };
}
function assertClear(scene) {
    for (const u of scene.units) {
        const radius = CombatRules.bodyRadius(u);
        assert.ok(u.gx >= radius && u.gx <= board.W - radius && u.gy >= radius && u.gy <= board.H - radius, `board: ${u.id}`);
        for (const r of scene.dynamicBlockers.list) {
            const distance = Math.hypot(u.gx - Math.max(r.x1, Math.min(r.x2, u.gx)), u.gy - Math.max(r.y1, Math.min(r.y2, u.gy)));
            assert.ok(distance >= radius - 1e-6, `wall overlap: ${u.id}`);
        }
    }
}

test('siege layout #1: 20-cell camp, four ladders per side, outside feet and walkway landings', () => {
    const { scene: s, bounds: b } = deploy();
    step(s);
    assert.equal(b.x2 - b.x1, 20);
    assert.equal(b.y2 - b.y1, 2 * L.halfSize);
    assert.equal(s.siege.ladders.length, 16);
    for (const side of L.sides) {
        const ladders = s.siege.ladders.filter(l => l.id.startsWith(`${side}-`));
        assert.equal(ladders.length, L.laddersPerSide);
        for (const [i, l] of ladders.entries()) {
            assert.equal(s.siege.heightAt(l.landing.gx, l.landing.gy), WALKWAY_HEIGHT);
            const horizontal = side === 'north' || side === 'south';
            const along = horizontal ? l.top.gx : l.top.gy;
            if (side === 'south') {
                assert.ok(Math.abs(along - b.cx) - L.gateWidth / 2 >= L.southLadderGateClearance - 1e-9);
                if (i) assert.ok(along - ladders[i - 1].top.gx >= L.southLadderSpacing - 1e-9);
            } else assert.equal(along, (horizontal ? b.x1 : b.y1) + 2 * L.halfSize * (i + .5) / L.laddersPerSide);
            assert.ok(side === 'west' ? l.foot.gx < b.x1 - L.wallThickness : side === 'east' ? l.foot.gx > b.x2 + L.wallThickness
                : side === 'north' ? l.foot.gy < b.y1 - L.wallThickness : l.foot.gy > b.y2 + L.wallThickness);
        }
    }
    const visuals = buildCampVisuals(s.dynamicBlockers.list);
    const stakes = visuals.getObjectByName('palisade-stakes');
    stakes.geometry.computeBoundingBox();
    assert.ok(Math.abs(stakes.geometry.boundingBox.max.y - L.wallHeight) < 1e-6);
    disposeCampVisuals(visuals);
});

test('siege layout #2: exact armies, four assault-side towers, proportional four-side deployment and legal bodies', t => {
    const { scene: s, bounds: b, placements } = deploy();
    assert.equal(total(L.attackers), 600); assert.equal(total(L.defenders), 300);
    assert.equal(placements.filter(p => p.unit.team === 'red').length, total(L.attackers));
    assert.equal(placements.filter(p => p.unit.team === 'blue').length, total(L.defenders));
    const towers = s.siege.platforms.filter(p => p.kind === 'tower');
    assert.equal(towers.length, 4);
    for (const [i, p] of towers.entries()) {
        const crew = placements.filter(d => d.siegeAnchor?.platformId === p.id);
        assert.equal(crew.length, L.archersPerTower);
        assert.equal(crew.length, 3);
        assert.ok(crew.every(d => d.unit.type === 'archer' && d.unit.team === 'blue'));
        const centers = [[b.cx, b.y1 + L.towerInset], [b.x2 - L.towerInset, b.cy],
            [b.x1 + L.towerInset, b.cy], [b.cx + 2.4, b.y2 - L.towerInset]];
        assert.equal((p.x1 + p.x2) / 2, centers[i][0]);
        assert.equal((p.y1 + p.y2) / 2, centers[i][1]);
        assert.ok(Math.abs(p.x2 - p.x1 - L.towerSize) < 1e-12);
        assert.ok(Math.abs(p.y2 - p.y1 - L.towerSize) < 1e-12);
        assert.equal(p.height * L.worldHeightScale, L.towerHeight);
    }
    for (const [side, share] of Object.entries(L.attackShares)) {
        const wing = placements.filter(p => p.side === side);
        assert.equal(wing.length, total(L.attackers) * share);
        for (const [type, count] of Object.entries(L.attackers)) assert.equal(wing.filter(p => p.unit.type === type).length, count * share);
        for (const p of wing) {
            const distance = side === 'south' ? p.gy - b.y2 : side === 'north' ? b.y1 - p.gy : side === 'east' ? p.gx - b.x2 : b.x1 - p.gx;
            assert.ok(distance - L.wallThickness >= L.attackerFrontClearance - 1e-9);
            // 钉在地图边缘：后排行军线距边界不小于 edgeMargin
            const inside = side === 'south' ? 70 - p.gy : side === 'north' ? p.gy : side === 'east' ? 70 - p.gx : p.gx;
            assert.ok(inside >= L.attackerEdgeMargin - 1e-9, 'wing rank within map edge');
        }
    }
    step(s); assertClear(s);
    for (const p of placements.filter(p => p.siegeAnchor)) {
        assert.equal(p.unit.gx, p.gx); assert.equal(p.unit.gy, p.gy);
    }
    assert.equal(s.siege.ram.crew.filter(id => id !== null).length, 4);
    const southIds = new Set(placements.filter(p => p.side === 'south').map(p => p.unit.id));
    assert.ok(s.siege.ram.crew.every(id => southIds.has(id)));
    t.diagnostic('attackers south/north/east/west=240/120/120/120; defenders=300; tower archers=12');
});

test('siege layout #3: configured climb completes within one frame of height-scaled duration', t => {
    const s = makeScene(), b = campBounds(), full = createCampSiege(b, { ladders: true, defense: false });
    s.checkWin = () => {}; // Isolate duration, with no defender to hold the lip.
    s.siege = full;
    queueCampWalls(s);
    const l = s.siege.ladders[0], u = addUnit(s, 'red', 'infantry', l.foot.gx, l.foot.gy);
    let frames = 0;
    while (!s.siege.landedCount && frames < 300) { step(s); frames++; }
    assert.equal(s.siege.landedCount, 1);
    assert.equal(frames, Math.ceil(L.climbSeconds / DT));
    assert.ok(Math.abs(frames * DT - L.baselineClimbSeconds * L.wallHeight / L.baselineWallHeight) <= DT);
    assert.equal(u.siegeClimb, undefined);
    t.diagnostic(`climbSeconds=${L.climbSeconds}; completedFrame=${frames}`);
});

function assault() {
    const { scene: s } = deploy(makeScene(), true);
    installSiegeArrows(s);
    const frames = [], landed = Object.fromEntries(L.sides.map(side => [side, 0]));
    let brokenFrame = null;
    // 寨门 1800 hp、默认撞击间隔 2200ms，破门约在第 1803 帧；双跑均观察 2400 帧。
    for (let frame = 1; frame <= 2400; frame++) {
        const climbs = s.units.filter(u => u.siegeClimb).map(u => [u, u.siegeClimb]);
        step(s);
        for (const [u, entry] of climbs) if (entry.progress === 1 && !u.siegeClimb) landed[entry.ladder.id.split('-')[0]]++;
        if (s.siege.gate.broken) brokenFrame ??= frame;
        for (const u of s.units) assert.ok(Number.isFinite(u.gx) && Number.isFinite(u.gy), `NaN: frame ${frame}, unit ${u.id}`);
        assert.equal(typeof s.battleOver, 'boolean');
        if (s.battleOver) assert.ok(['red', 'blue', 'draw', null].includes(s.winner));
        const snapshot = {
            units: s.units.map(u => [u.id, u.gx, u.gy, u.hp, u.dead, u.withdrawn, u.morale, u.moraleState, u.siegeRole,
                u.siegeClimb?.progress, u.siegeClimb?.height]),
            arrows: s.arrows.map(a => ({ ...a, source: a.source?.id })),
            ladders: s.siege.ladders.map(l => [l.id, l.climbers, l.recruitMs]),
            ram: s.siege.ram, gate: s.siege.gate, landed, battleOver: s.battleOver, winner: s.winner
        };
        frames.push(createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'));
    }
    assert.equal(Object.values(landed).reduce((a, b) => a + b, 0), s.siege.landedCount);
    for (const side of L.sides) assert.ok(landed[side] >= 1, `${side} landings: ${JSON.stringify(landed)}`);
    return { frames, landed, brokenFrame, battleOver: s.battleOver };
}

test('siege layout #4/#5: 2400 full steps land on every side and repeat exactly per frame', t => {
    const first = assault(), second = assault();
    assert.deepEqual(second, first);
    t.diagnostic(`frames=${first.frames.length}; landed=${JSON.stringify(first.landed)}; gateBrokenFrame=${first.brokenFrame}; battleOver=${first.battleOver}; identicalFrames=2400`);
});

test('siege layout: redeploy rebuilds all platforms, ladders, anchors and ram state', () => {
    const { scene: s, placements: original } = deploy();
    for (let frame = 0; frame < 240; frame++) step(s);
    const previous = s.siege;
    const { placements } = deploy(s);
    assert.notEqual(s.siege, previous);
    assert.deepEqual(s.siege.platforms, previous.platforms);
    assert.deepEqual(placements.map(p => [p.gx, p.gy, p.siegeAnchor, p.side]), original.map(p => [p.gx, p.gy, p.siegeAnchor, p.side]));
    assert.equal(s.siege.ladders.length, L.sides.length * L.laddersPerSide);
    assert.ok(s.siege.ladders.every(l => !l.initialized && l.climbers.every(id => id === null)));
    assert.equal(s.siege.landedCount, 0); assert.equal(s.siege.ram.hits, 0);
    step(s); assertClear(s);
});

test('siege layout: unchanged camera covers initial camp and four armies at landscape aspect ratios', t => {
    const { placements } = deploy();
    const camera = new THREE.PerspectiveCamera(45, 1, .1, 400);
    camera.position.set(0, 62, 74); camera.lookAt(0, 1, 0); camera.updateMatrixWorld();
    const points = placements.flatMap(p => [0, (p.siegeAnchor ? L.towerHeight : 0) + 2].map(h =>
        new THREE.Vector3(p.gx - board.W / 2, h, p.gy - board.H / 2)));
    for (const x of [-L.halfSize, L.halfSize]) for (const z of [-L.halfSize, L.halfSize]) points.push(new THREE.Vector3(x, LADDER_TOP_WORLD, z));
    const projected = points.map(p => p.clone().project(camera));
    const minAspect = Math.max(...projected.map(p => Math.abs(p.x)));
    for (const aspect of [4 / 3, 16 / 9]) {
        camera.aspect = aspect; camera.updateProjectionMatrix();
        for (const point of points) {
            const p = point.clone().project(camera);
            assert.ok(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && Math.abs(p.z) <= 1);
        }
    }
    t.diagnostic(`camera=(0,62,74), target=(0,1,0), FOV=45; covered at 4:3 and 16:9; minimum aspect=${minAspect.toFixed(4)}; max vertical NDC=${Math.max(...projected.map(p => Math.abs(p.y))).toFixed(4)}`);
});
