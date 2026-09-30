// 山河领土图：几何布局 / 通行规则 / 高地高度场 / 旗点可立 / 镜像对称 / 跨桥行军 / 全局对局
// 坐标一律由 TERRITORY 尺寸与 territoryLayout 推导，跟随地图放大自动适配。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit } from './battle-harness.js';
import { board } from '../js/board.js';
import { Terrain } from '../js/terrain.js';
import { TERRITORY } from '../js/battle/economy.js';
import { territoryLayout } from '../js/territory-map.js';

const STEP = 1000 / 60;
// 常用布局锚点：河心 / 桥心 / 浅滩 / 中央高地 / 西林斑核心（林带矩形中心，噪声斑最厚处）
const CX = () => board.W / 2, CY = () => board.H / 2;
const GEO = () => territoryLayout(board.W, board.H);
const BRIDGE_Y = () => Math.round(board.H * 2 / 9);
const FORD_Y = () => GEO().fordY;
const FOREST_X = () => (Math.round(board.W * 0.31) + Math.round(board.W * 0.44)) / 2;
const FOREST_Y = () => (Math.round(board.H * 0.70) + Math.round(board.H * 0.88)) / 2;

function terrainScene(options = {}, red = { ...TERRITORY.OPENING }, blue = { ...TERRITORY.OPENING }) {
    const scene = makeScene();
    scene.deployUnits(red, blue, 'custom', 'custom', {},
        { territory: true, terrain: 'territory', ...options });
    scene.battleStarted = true;
    return scene;
}

function run(scene, seconds) {
    for (let i = 0; i < 60 * seconds && !scene.battleOver; i++) scene.advanceBattle(STEP);
}

test('山河图几何：纵河分隔上翼+中央独桥+南端浅滩+镜像对称', () => {
    board.W = TERRITORY.W; board.H = TERRITORY.H;
    let waterRows = 0;
    for (let y = 0.3; y < FORD_Y() - 2; y += 0.5) {
        if (Terrain.surface('territory', CX(), y) === 'water') waterRows++;
        for (let x = 5.3; x < board.W - 5; x += 2.3) {
            assert.equal(Terrain.surface('territory', x, y), Terrain.surface('territory', board.W - x, y), '河岸左右镜像');
        }
    }
    assert.ok(waterRows >= 40, '纵河分隔上翼两岸，桥位留出真实缺口');
    assert.equal(Terrain.surface('territory', CX(), BRIDGE_Y()), 'bridge', '中央独桥');
    assert.equal(Terrain.surface('territory', 6, BRIDGE_Y()), 'grass', '浅滩之外的远岸草地');
    assert.equal(Terrain.surface('territory', FOREST_X(), FOREST_Y()), 'forest', '西林斑核心');
    assert.equal(Terrain.surface('territory', board.W - FOREST_X(), FOREST_Y()), 'forest', '东林斑核心');
    assert.equal(Terrain.surface('territory', CX(), Math.round(board.H * 0.79)), 'grass', '下翼中央走廊开阔');
    let shallowSeen = false;
    for (let x = CX() - 4; x < CX() + 4; x += 0.7) for (let y = FORD_Y() - 2; y < FORD_Y() + 2; y += 0.7) if (Terrain.surface('territory', x, y) === 'shallow') shallowSeen = true;
    assert.ok(shallowSeen, '南端有可绕行浅滩');
    board.W = 70; board.H = 70;
});

test('山河图通行：河面 walkable=false，桥与浅滩可通过；林带减速骑兵', () => {
    board.W = TERRITORY.W; board.H = TERRITORY.H;
    assert.equal(Terrain.walkable('territory', CX(), BRIDGE_Y() - 6), false, '河面不可站');
    assert.equal(Terrain.walkable('territory', CX(), BRIDGE_Y()), true, '桥面可站');
    assert.equal(Terrain.walkable('territory', CX(), FORD_Y() - 1), true, '浅滩可站');
    assert.equal(Terrain.surfaceSpeed('territory', 'cavalry', FOREST_X(), FOREST_Y()), 0.55, '林内骑兵 55%');
    assert.equal(Terrain.surfaceSpeed('territory', 'infantry', FOREST_X(), FOREST_Y()), 0.85, '林内步兵 85%');
    assert.equal(Terrain.surfaceSpeed('territory', 'cavalry', CX(), Math.round(board.H * 0.79)), 1, '走廊全速');
    board.W = 70; board.H = 70;
});

test('中央高地：仍是制高点，全图缓丘镜像对称，弓兵居高射程增益', () => {
    board.W = TERRITORY.W; board.H = TERRITORY.H;
    // 坡顶（椭圆核心）显著高于远处平地（缓丘 ±1 层内）
    assert.ok(Terrain.height('territory', CX(), CY()) - Terrain.height('territory', CX(), CY() + 16) > 1.2, '坡顶高于坡脚以南');
    // 全图缓丘：既非全平（远处也有起伏），又左右镜像逐位一致
    let rollingSeen = false;
    for (let x = 4; x < board.W - 4; x += 3.7) for (let y = Math.round(board.H * 0.33); y < Math.round(board.H * 0.94); y += 2.9) {
        const h = Terrain.height('territory', x, y);
        if (h > 0.25) rollingSeen = true;
        assert.ok(Math.abs(h - Terrain.height('territory', board.W - x, y)) < 1e-9, `镜像对称 @(${x.toFixed(1)},${y.toFixed(1)})`);
    }
    assert.ok(rollingSeen, '中央高地之外也存在缓丘（"没有一寸平地"）');
    // 居高射程增益（通用坡度规则自动生效）
    const highArcher = { typeData: { range: 9.5 }, gx: CX(), gy: CY() };
    const lowTarget = { gx: CX(), gy: CY() + 16 };
    assert.ok(Terrain.rangedRange('territory', highArcher, lowTarget) > 9.5, '居高俯射射程增益');
    board.W = 70; board.H = 70;
});

test('五旗落位：全部立于可通行地面，坐标镜像自对称', () => {
    const scene = terrainScene();
    for (const flag of scene.flags) {
        assert.equal(Terrain.walkable('territory', flag.gx, flag.gy), true, `${flag.name} 应可站立`);
    }
    const flags = scene.flags;
    for (let i = 0; i < 2; i++) {
        assert.ok(Math.abs(flags[i].gx + flags[3 + i].gx - board.W) < 1e-9, '镜像 x 对称');
        assert.equal(flags[i].gy, flags[3 + i].gy, 'y 相等');
    }
});

test('开局与出兵：常备军、增援、集结点全部不在水里', () => {
    const scene = terrainScene({ territoryAI: false }, {}, {});
    scene.territory.econ.treasury.red = 300;
    for (let i = 0; i < 6; i++) scene.territory.recruit.enqueue('red', 'infantry');
    run(scene, 8);
    for (const unit of scene.units) {
        assert.notEqual(Terrain.surface('territory', unit.gx, unit.gy), 'water', `单位 ${unit.id} 不得站在水中`);
    }
});

test('跨桥行军：被河分隔的目标经导航走桥/浅滩抵达（无人下水）', () => {
    const scene = terrainScene({ territoryAI: false }, {}, { infantry: 2 });
    const east = scene.flags.find(f => f.name === '东桥头'), west = scene.flags.find(f => f.name === '西桥头');
    const foes = scene.units.filter(u => u.team === 'blue');
    foes.forEach((u, i) => { u.gx = east.gx; u.gy = east.gy + i; });     // 蓝兵钉在东桥头
    scene.rebuildSpatial();
    const troop = addUnit(scene, 'red', 'infantry', west.gx, west.gy);   // 西桥头红兵
    scene.rebuildSpatial();
    let crossed = false;
    for (let i = 0; i < 60 * 45; i++) {
        foes.forEach((u, j) => { u.gx = east.gx; u.gy = east.gy + j; u.hp = u.maxHp; });
        troop.hp = troop.maxHp;
        scene.advanceBattle(STEP);
        if (troop.dead || troop.withdrawn) break;
        assert.notEqual(Terrain.surface('territory', troop.gx, troop.gy), 'water', '全程不得踩水');
        if (troop.gx > board.W / 2 + 5) { crossed = true; break; }        // 抵达东岸
    }
    assert.ok(crossed, '应经桥或浅滩抵达东岸');
});

test('山河图全局对局：营队+山河地形同构两局镜像一致，且能正常分出胜负', () => {
    const play = () => {
        const scene = terrainScene({ territoryAI: true });
        run(scene, 300);
        return JSON.stringify({
            red: scene.redAlive, blue: scene.blueAlive,
            flags: scene.flags.map(f => f.owner),
            tickets: [Math.round(scene.territory.tickets.tickets.red), Math.round(scene.territory.tickets.tickets.blue)],
            spawned: scene.territory.recruit.spawned,
            endReason: scene.endReason, over: scene.battleOver
        });
    };
    const a = play();
    const b = play();
    assert.equal(a, b, '山河图同构对局应逐位一致');
    const result = JSON.parse(a);
    assert.ok(result.over || result.tickets[0] < 900 || result.tickets[1] < 900, '对局应有实质进展');
});

test('山河图2.0：悬崖脊不可通行，浅滩可通行减速，旗点与出兵线仍可达', () => {
    board.W = TERRITORY.W; board.H = TERRITORY.H;
    const rockX = Math.round(board.W * 0.35), rockY = Math.round(board.H * 0.95);
    assert.equal(Terrain.surface('territory', rockX, rockY), 'rock', '下翼悬崖脊');
    assert.equal(Terrain.walkable('territory', rockX, rockY), false, '悬崖不可站');
    assert.equal(Terrain.surface('territory', board.W - rockX, rockY), 'rock', '镜像悬崖脊');
    assert.equal(Terrain.surface('territory', CX() - 2, FORD_Y() - 1), 'shallow', '南端西半浅滩');
    assert.equal(Terrain.surface('territory', CX() + 2, FORD_Y() - 1), 'shallow', '南端东半浅滩');
    assert.equal(Terrain.walkable('territory', CX() - 2, FORD_Y() - 1), true, '浅滩可通行');
    assert.ok(Terrain.surfaceSpeed('territory', 'cavalry', CX() - 2, FORD_Y() - 1) < 1, '浅滩减速');
    // 关键可达点不被新地形堵死
    for (const [x, y] of [[8, CY()], [board.W - 8, CY()], [CX() - 12, BRIDGE_Y()], [CX() + 12, BRIDGE_Y()], [CX() - 10, CY() + 16], [CX() + 10, CY() + 16], [CX(), CY()]]) {
        assert.equal(Terrain.walkable('territory', x, y), true, `(${x},${y}) 应可站`);
    }
    board.W = 70; board.H = 70;
});
