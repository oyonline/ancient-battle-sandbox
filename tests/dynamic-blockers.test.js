// 每场战斗可开关的动态障碍层（"千人攻寨"P0 地基）：
// 障碍归场景所有、运行时增删、固定时点生效、导航缓存随版本+层对象作废。
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

// 场景 1：封闭方框——框外单位寻路不可达、walkable/segmentClear 穿门判挡、
// 真实位移管线也进不了框；关闭口径保持原行为不变。
test('sealed box: pathing cannot enter, walkable/segmentClear judge the door as blocking', () => {
    const { scene, unit, dyn } = boxedScene();
    step(scene, 3);
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

// 修复 3.1：换层不撞号——同一个导航实例，换了新层实例即使 version 同值，
// graphs/routes 也必须清空并按新层重建。
test('replacing the DynamicBlockers instance invalidates cached navigation even with matching version numbers', () => {
    const scene = makeScene();
    scene.dynamicBlockers = new DynamicBlockers();
    const dynA = scene.dynamicBlockers;
    for (const [id, rect] of WALLS) dynA.requestAdd(id, rect);
    const unit = addUnit(scene, 'red', 'infantry', 28, 25);   // 视线被西墙挡住
    addUnit(scene, 'blue', 'infantry', 60, 60);
    scene.updateNormalUnit = u => { u !== unit ? null : (u.moveX = 0, u.moveY = 0, moveToward(u, 35, 35, u.typeData.speed, 1 / 60)); };
    step(scene, 3);
    const nav = scene.ensureNavigation();
    assert.equal(nav.nextWaypoint(unit, 35, 35).reachable, false);
    const buildsAfterA = nav.stats.graphBuilds;
    assert.ok(buildsAfterA >= 1);
    // B 层也放一堵完整方框墙（和 A 层几何完全一致），但新实例——version 撞号 1，
    // 只有 _dynRef 不同；这样 unit→goal 仍被西墙挡住，nextWaypoint 必须走 graph 重建
    const dynB = new DynamicBlockers();
    for (const [id, rect] of WALLS) dynB.requestAdd('B-' + id, rect);
    scene.dynamicBlockers = dynB;
    step(scene, 1);   // 固定时点提交 + beginStep（触发 _syncBlockers 清空 graphs/routes）
    assert.equal(nav.graphs.size, 0, 'graphs must be cleared after replacing layer');
    // 下一次访问导航时重建（graphBuilds 增加）
    assert.equal(nav.nextWaypoint(unit, 35, 35).reachable, false);
    assert.ok(nav.stats.graphBuilds > buildsAfterA, 'graphBuilds must increase when rebuilt for new layer');
});

// 修复 3.2：缓存复用——同一层同一版本 dyn.list 与 Terrain.blockersOf 返回同一个数组；
// 提交一次后返回新数组（冻结）。
test('list and merged blockers cache across repeated reads, version bump produces a fresh array', () => {
    const scene = makeScene();
    scene.dynamicBlockers = new DynamicBlockers();
    const dyn = scene.dynamicBlockers;
    for (const [id, rect] of WALLS) dyn.requestAdd(id, rect);
    const staticBlockers = Terrain.geometry('flat').blockers;
    // 提交 1 次
    dyn.commit();
    assert.equal(dyn.version, 1);
    const listV1a = dyn.list;
    const listV1b = dyn.list;
    assert.ok(listV1a === listV1b, 'dyn.list must be === across two reads at same version');
    assert.equal(listV1a.length, 6);
    const mergedV1a = Terrain.blockersOf('flat', dyn);
    const mergedV1b = Terrain.blockersOf('flat', dyn);
    assert.ok(mergedV1a === mergedV1b, 'blockersOf must be === across two reads at same version');
    assert.equal(mergedV1a.length, staticBlockers.length + 6);
    assert.ok(mergedV1a !== listV1a, 'merged and list are different arrays (static + dynamic)');
    // 提交第 2 次（增一扇子门；内容变了，version 仍只递增 1）
    dyn.requestAdd('vent', { x1: 32, y1: 35, x2: 32.4, y2: 35.4, kind: 'wall' });
    dyn.commit();
    assert.equal(dyn.version, 2);
    const listV2 = dyn.list;
    assert.ok(listV2 !== listV1a, 'list must be a new frozen array after version bump');
    assert.equal(listV2.length, 7);
    const mergedV2 = Terrain.blockersOf('flat', dyn);
    assert.ok(mergedV2 !== mergedV1a, 'merged must be a new array after version bump');
    assert.equal(mergedV2.length, staticBlockers.length + 7);
});

// 场景 5：确定性——同一初始状态、同一障碍变更序列（含同步多变更乱序请求）跑两遍，
// 所有单位 gx/gy/hp/dead/withdrawn 完全一致；dyn.version/list、navigation.stats 也一致。
// 再加反向请求顺序变体：requestAdd('zz-bait') + requestRemove('door') 顺序反转后结果相同。
test('identical runs with the same obstacle-change sequence are byte-identical; reverse request order yields same result', () => {
    const run = (swap) => {
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
            if (i === 60) {
                const addReq = ['zz-bait', { x1: 20, y1: 20, x2: 21, y2: 21.4, kind: 'wall' }];
                const remReq = 'door';
                if (swap) { dyn.requestAdd(...addReq); dyn.requestRemove(remReq); }
                else     { dyn.requestRemove(remReq); dyn.requestAdd(...addReq); }
            }
            step(scene);
        }
        return {
            dynVersion: dyn.version,
            dynList: [...dyn.list],
            navStats: { ...scene.ensureNavigation().stats },
            units: scene.units.map(u => ({
                id: u.id, gx: u.gx, gy: u.gy, hp: u.hp, dead: u.dead, withdrawn: u.withdrawn
            }))
        };
    };
    // 两次原序必须逐字节一致
    const a = run(false), b = run(false);
    assert.deepEqual(a, b);
    // 反向请求顺序也必须一致——同批按 id 排序提交，请求先后不影响结果
    const rev = run(true);
    assert.deepEqual(a, rev, 'request order within a commit must not affect deterministic result');
});
