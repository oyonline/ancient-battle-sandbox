// 每场战斗可开关的动态障碍层（"千人攻寨"P0 地基）：
// 障碍归场景所有、运行时增删、固定时点生效、导航缓存随版本作废。
// 默认关闭——不开时所有 Terrain/导航调用走原路径，行为逐字节不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit, moveToward, Terrain, CombatRules } from './battle-harness.js';
import { DynamicBlockers } from '../js/terrain.js';

// 封闭方框：x 30–40 / y 30–40，北墙留 2 格门洞，由 'door' 障碍单独控制。
const WALLS = [
    ['wall-n1', { x1: 30, y1: 30, x2: 34, y2: 30.4, kind: 'wall' }],
    ['door', { x1: 34, y1: 30, x2: 36, y2: 30.4, kind: 'wall' }],
    ['wall-n2', { x1: 36, y1: 30, x2: 40, y2: 30.4, kind: 'wall' }],
    ['wall-s', { x1: 30, y1: 39.6, x2: 40, y2: 40, kind: 'wall' }],
    ['wall-w', { x1: 30, y1: 30, x2: 30.4, y2: 40, kind: 'wall' }],
    ['wall-e', { x1: 39.6, y1: 30, x2: 40, y2: 40, kind: 'wall' }]
];
const DOOR = WALLS[1][1];

// 红方测试兵在框外 (35,25)，目标框心 (35,35)；蓝方旁观兵保证战斗不结算。
function boxedScene() {
    const scene = makeScene();
    scene.dynamicBlockers = new DynamicBlockers();
    for (const [id, rect] of WALLS) scene.dynamicBlockers.requestAdd(id, rect);
    const unit = addUnit(scene, 'red', 'infantry', 35, 25);
    addUnit(scene, 'blue', 'infantry', 60, 60);
    scene.updateNormalUnit = u => {
        if (u !== unit) return;
        u.moveX = 0; u.moveY = 0;
        moveToward(u, 35, 35, u.typeData.speed, 1 / 60);
    };
    return { scene, unit, dyn: scene.dynamicBlockers };
}

function step(scene, frames = 1) {
    for (let i = 0; i < frames; i++) {
        scene.simulationTime += 1000 / 60;
        scene.stepBattle(1 / 60);
    }
}

// 场景 1：封闭方框——框外单位寻路不可达，walkable/segmentClear 穿门判挡住，
// 真实位移管线（stepBattle 的 clipMotion）也进不了框。
test('sealed box: pathing cannot enter, walkable/segmentClear judge the door as blocking', () => {
    const { scene, unit, dyn } = boxedScene();
    step(scene, 3);   // 提交障碍
    // 动态层生效：门洞处不可站立、穿门线段被挡
    assert.equal(Terrain.walkable('flat', 35, 30.2, 0.36, dyn), false);
    assert.equal(Terrain.segmentClear('flat', 35, 28, 35, 35, 0.36, dyn), false);
    // 不带动态层（默认关闭口径）：平地一切照旧——证明关闭时走原路径
    assert.equal(Terrain.walkable('flat', 35, 30.2, 0.36), true);
    assert.equal(Terrain.segmentClear('flat', 35, 28, 35, 35, 0.36), true);
    assert.equal(Terrain.hasBarriers('flat'), false);
    // 寻路不可达
    const point = scene.ensureNavigation().nextWaypoint(unit, 35, 35);
    assert.equal(point.reachable, false);
    // 真实推进 600 帧（10 秒）：单位被门挡住，进不了框
    step(scene, 600);
    assert.ok(unit.gy < 30, `unit entered the box: ${unit.gx},${unit.gy}`);
});

// 场景 2：移除"门"推进一步后——寻路穿门洞入框，导航 graphBuilds 计数增加。
test('removing the door opens a route and rebuilds the navigation graph', () => {
    const { scene, unit, dyn } = boxedScene();
    // 侧翼兵视线被西墙挡住（非直达）：寻路必须走可见图，才能观察 graphBuilds
    const flanker = addUnit(scene, 'red', 'infantry', 28, 25);
    step(scene, 3);
    const nav = scene.ensureNavigation();
    assert.equal(nav.nextWaypoint(flanker, 35, 35).reachable, false);
    const buildsBefore = nav.stats.graphBuilds;
    assert.ok(buildsBefore >= 1, 'graph should have been built once');
    dyn.requestRemove('door');
    step(scene, 1);   // 固定时点提交
    assert.equal(nav.nextWaypoint(flanker, 35, 35).reachable, true);
    assert.ok(nav.stats.graphBuilds > buildsBefore, 'graphBuilds must increase after obstacle change');
    step(scene, 900);
    assert.ok(Math.hypot(unit.gx - 35, unit.gy - 35) < 1.2,
        `unit failed to walk through the doorway: ${unit.gx},${unit.gy}`);
});

// 场景 3：把"门"加回去——恢复不可达，缓存路线作废，没有沿用旧路线穿墙。
test('re-adding the door seals the box again and discards cached routes', () => {
    const { scene, unit, dyn } = boxedScene();
    step(scene, 3);
    const nav = scene.ensureNavigation();
    dyn.requestRemove('door');
    step(scene, 1);
    // 把单位挪到西北侧：视线被西墙挡住（非直达），才会走可见图并缓存路线
    unit.gx = 28; unit.gy = 25;
    assert.equal(nav.nextWaypoint(unit, 35, 35).reachable, true);
    assert.ok(nav.routes.size > 0, 'route should be cached while the door is open');
    dyn.requestAdd('door', DOOR);
    step(scene, 1);
    assert.equal(nav.routes.size, 0, 'stale routes must be discarded on obstacle change');
    assert.equal(nav.nextWaypoint(unit, 35, 35).reachable, false);
    // 物理位移同样恢复封锁：把单位放回门外再推 300 帧，不得入框
    unit.gx = 35; unit.gy = 25;
    step(scene, 300);
    assert.ok(unit.gy < 30, `unit walked through the re-added door: ${unit.gx},${unit.gy}`);
});

// 场景 4：战斗隔离——动态障碍不写共享几何；新开同尺寸战斗看不到上一场的墙；
// 同场景重开一局（resetBattleData）也清空障碍层。
test('a second same-size battle sees none of the first battle\'s obstacles', () => {
    const { scene, dyn } = boxedScene();
    step(scene, 3);
    assert.ok(dyn.size > 0);
    // 共享几何未被污染
    assert.equal(Terrain.geometry('flat').blockers.length, 0);
    // 新开一场同尺寸平地战斗
    const scene2 = makeScene();
    const fresh = addUnit(scene2, 'red', 'infantry', 35, 25);
    addUnit(scene2, 'blue', 'infantry', 60, 60);
    step(scene2, 3);
    assert.equal(scene2.dynamicBlockers, null);
    assert.equal(Terrain.walkable('flat', 35, 30.2, 0.36), true);
    assert.equal(scene2.ensureNavigation().nextWaypoint(fresh, 35, 35).reachable, true);
    // 同场景重开一局：障碍层随战斗数据重置
    scene.resetBattleData();
    assert.equal(scene.dynamicBlockers, null);
});

// 场景 5：确定性——同一初始状态、同一障碍变更序列（含同步多变更）跑两遍，
// 所有单位 gx/gy/hp 完全一致。
test('identical runs with the same obstacle-change sequence are byte-identical', () => {
    const run = () => {
        const scene = makeScene();
        scene.dynamicBlockers = new DynamicBlockers();
        const dyn = scene.dynamicBlockers;
        for (const [id, rect] of WALLS) dyn.requestAdd(id, rect);
        const u1 = addUnit(scene, 'red', 'infantry', 35, 25);
        const u2 = addUnit(scene, 'red', 'infantry', 33.5, 24);
        addUnit(scene, 'blue', 'infantry', 60, 60);
        scene.updateNormalUnit = u => {
            if (u !== u1 && u !== u2) return;
            u.moveX = 0; u.moveY = 0;
            moveToward(u, 35, 35, u.typeData.speed, 1 / 60);
        };
        for (let i = 0; i < 240; i++) {
            // 同一步内多处变更：移除门 + 在远处加一块饵墙（乱序请求，提交按 id 排序）
            if (i === 60) { dyn.requestAdd('zz-bait', { x1: 20, y1: 20, x2: 21, y2: 21.4, kind: 'wall' }); dyn.requestRemove('door'); }
            if (i === 120) dyn.requestAdd('door', DOOR);
            step(scene);
        }
        return scene.units.filter(u => !u.dead && !u.withdrawn)
            .map(u => ({ id: u.id, gx: u.gx, gy: u.gy, hp: u.hp }));
    };
    assert.deepEqual(run(), run());
});
