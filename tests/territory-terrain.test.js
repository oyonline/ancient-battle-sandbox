// 山河领土图：几何布局 / 通行规则 / 高地高度场 / 旗点可立 / 镜像对称 / 跨桥行军 / 全局对局
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit } from './battle-harness.js';
import { board } from '../js/board.js';
import { Terrain } from '../js/terrain.js';
import { TERRITORY } from '../js/battle/economy.js';

const STEP = 1000 / 60;

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

test('山河图几何：蜿蜒河横贯+中央独桥+两端浅滩+镜像对称（104×72）', () => {
    board.W = 104; board.H = 72;
    // 蜿蜒河：多条竖切线上都能遇到水面；全图左右镜像逐位一致
    let waterColumns = 0, mirrored = true;
    for (let x = 20.3; x < 84; x += 4) {   // 0.3 偏移避开窄条边界（含严格不等式的零宽缝）
        let has = false;
        for (let y = 6; y < 24; y += 0.5) if (Terrain.surface('territory', x, y) === 'water') { has = true; break; }
        if (has) waterColumns++;
        for (let y = 4; y < 68; y += 2.3) {
            if (Terrain.surface('territory', x, y) !== Terrain.surface('territory', 104 - x, y)) { mirrored = false; break; }
        }
    }
    assert.ok(waterColumns >= 13, `河应横贯（有水切线 ${waterColumns}/17，桥位与窄条边界除外）`);
    assert.ok(mirrored, '左右镜像逐位一致（含蜿蜒河/悬崖/林带/浅滩）');
    assert.equal(Terrain.surface('territory', 52, 16), 'bridge', '中央独桥');
    assert.equal(Terrain.surface('territory', 6, 16), 'grass', '浅滩之外的远岸草地');
    assert.equal(Terrain.surface('territory', 39, 56), 'forest', '西林斑核心');
    assert.equal(Terrain.surface('territory', 65, 56), 'forest', '东林斑核心');
    assert.equal(Terrain.surface('territory', 52, 57), 'grass', '下翼中央走廊开阔');
    let shallowSeen = false;
    for (let x = 6; x < 18; x += 0.7) for (let y = 6; y < 24; y += 0.7) if (Terrain.surface('territory', x, y) === 'shallow') shallowSeen = true;
    assert.ok(shallowSeen, '西端有浅滩（东端由镜像保证）');
    board.W = 70; board.H = 70;
});

test('山河图通行：河面 walkable=false，桥与浅滩可通过；林带减速骑兵', () => {
    board.W = 104; board.H = 72;
    assert.equal(Terrain.walkable('territory', 40, 16), false, '河面不可站');
    assert.equal(Terrain.walkable('territory', 52, 16), true, '桥面可站');
    assert.equal(Terrain.walkable('territory', 10, 16), true, '浅滩可站');
    assert.equal(Terrain.surfaceSpeed('territory', 'cavalry', 38, 57), 0.55, '林内骑兵 55%');
    assert.equal(Terrain.surfaceSpeed('territory', 'infantry', 38, 57), 0.85, '林内步兵 85%');
    assert.equal(Terrain.surfaceSpeed('territory', 'cavalry', 52, 57), 1, '走廊全速');
    board.W = 70; board.H = 70;
});

test('中央高地：仍是制高点，全图缓丘镜像对称，弓兵居高射程增益', () => {
    board.W = 104; board.H = 72;
    // 坡顶（椭圆核心）显著高于远处平地（缓丘 ±1 层内）
    assert.ok(Terrain.height('territory', 52, 36) - Terrain.height('territory', 52, 52) > 1.2, '坡顶高于坡脚以南');
    // 全图缓丘：既非全平（远处也有起伏），又左右镜像逐位一致
    let rollingSeen = false;
    for (let x = 4; x < 100; x += 3.7) for (let y = 24; y < 68; y += 2.9) {
        const h = Terrain.height('territory', x, y);
        if (h > 0.25) rollingSeen = true;
        assert.ok(Math.abs(h - Terrain.height('territory', 104 - x, y)) < 1e-9, `镜像对称 @(${x.toFixed(1)},${y.toFixed(1)})`);
    }
    assert.ok(rollingSeen, '中央高地之外也存在缓丘（"没有一寸平地"）');
    // 居高射程增益（通用坡度规则自动生效）
    const highArcher = { typeData: { range: 9.5 }, gx: 52, gy: 36 };
    const lowTarget = { gx: 52, gy: 52 };
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
    const foes = scene.units.filter(u => u.team === 'blue');
    foes.forEach((u, i) => { u.gx = 52; u.gy = 8 + i; });     // 蓝兵钉在北岸（河北 y<13）
    scene.rebuildSpatial();
    const troop = addUnit(scene, 'red', 'infantry', 30, 24);   // 南岸红兵
    scene.rebuildSpatial();
    let crossed = false;
    for (let i = 0; i < 60 * 45; i++) {
        foes.forEach((u, j) => { u.gx = 52; u.gy = 8 + j; u.hp = u.maxHp; });
        troop.hp = troop.maxHp;
        scene.advanceBattle(STEP);
        if (troop.dead || troop.withdrawn) break;
        assert.notEqual(Terrain.surface('territory', troop.gx, troop.gy), 'water', '全程不得踩水');
        if (troop.gy < 12.5) { crossed = true; break; }        // 抵达北岸
    }
    assert.ok(crossed, '应经桥或浅滩抵达北岸');
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
    board.W = 104; board.H = 72;
    assert.equal(Terrain.surface('territory', 40, 68), 'rock', '下翼悬崖脊');
    assert.equal(Terrain.walkable('territory', 40, 68), false, '悬崖不可站');
    assert.equal(Terrain.surface('territory', 64, 68), 'rock', '镜像悬崖脊');
    assert.equal(Terrain.surface('territory', 16, 12), 'shallow', '西端浅滩');
    assert.equal(Terrain.surface('territory', 88, 12), 'shallow', '东端浅滩');
    assert.equal(Terrain.walkable('territory', 16, 12), true, '浅滩可通行');
    assert.ok(Terrain.surfaceSpeed('territory', 'cavalry', 16, 12) < 1, '浅滩减速');
    // 关键可达点不被新地形堵死
    for (const [x, y] of [[8, 36], [96, 36], [25, 24], [79, 24], [34, 58], [70, 58], [52, 36]]) {
        assert.equal(Terrain.walkable('territory', x, y), true, `(${x},${y}) 应可站`);
    }
    board.W = 70; board.H = 70;
});
