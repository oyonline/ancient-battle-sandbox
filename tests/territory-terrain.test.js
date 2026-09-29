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

test('山河图几何：上翼横河+中央独桥+两端浅滩，下翼双林带夹走廊（104×72）', () => {
    board.W = TERRITORY.W; board.H = TERRITORY.H;
    const W = TERRITORY.W, H = TERRITORY.H;
    assert.equal(Terrain.surface('territory', 40, 16), 'water', '河面不可通行');
    assert.equal(Terrain.surface('territory', 20, 16), 'water', '河西段');
    assert.equal(Terrain.surface('territory', 80, 16), 'water', '河东段');
    assert.equal(Terrain.surface('territory', 52, 16), 'bridge', '中央独桥');
    assert.equal(Terrain.surface('territory', 10, 16), 'grass', '西端浅滩可绕');
    assert.equal(Terrain.surface('territory', 92, 16), 'grass', '东端浅滩可绕');
    assert.equal(Terrain.surface('territory', 38, 57), 'forest', '西林带');
    assert.equal(Terrain.surface('territory', 65, 57), 'forest', '东林带');
    assert.equal(Terrain.surface('territory', 52, 57), 'grass', '下翼中央走廊开阔');
    board.W = 70; board.H = 70;
    assert.ok(W === 104 && H === 72);
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

test('中央高地：坡顶 3 层，坡脚归零，弓兵居高射程增益', () => {
    board.W = 104; board.H = 72;
    assert.ok(Math.abs(Terrain.height('territory', 52, 36) - 3) < 0.35, '坡顶约 3 层');
    assert.equal(Terrain.height('territory', 52, 52), 0, '坡脚以南平地');
    assert.equal(Terrain.height('territory', 52, 12), 0, '河界以北平地');
    const highArcher = { typeData: { range: 9.5 }, gx: 52, gy: 36 };
    const lowTarget = { gx: 52, gy: 50 };
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
