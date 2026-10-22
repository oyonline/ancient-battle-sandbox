// 每场战斗可开关的动态障碍层（"千人攻寨"P0 地基）：
// 障碍归场景所有、运行时增删、固定时点生效、导航缓存随版本+层对象作废。
// 默认关闭——不开时所有 Terrain/导航调用走原路径，行为逐字节不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit, moveToward, Terrain, CombatRules, knockback, resolveAttack } from './battle-harness.js';
import { DynamicBlockers } from '../js/terrain.js';
import { resolveBrace } from '../js/battle/core.js';

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

// 身体圆 vs 墙体矩形：圆心到矩形最近点的距离必须不小于身体半径（容 1e-6 的量化/浮点误差）。
// 逐帧调用——任何一帧"身体嵌进墙里"都会当场失败，而不是只在终点抽查。
function assertNotInWalls(unit, walls) {
    const radius = CombatRules.bodyRadius(unit);
    for (const wall of walls) {
        const closestX = Math.max(wall.x1, Math.min(unit.gx, wall.x2));
        const closestY = Math.max(wall.y1, Math.min(unit.gy, wall.y2));
        const distance = Math.hypot(unit.gx - closestX, unit.gy - closestY);
        assert.ok(distance >= radius - 1e-6,
            `unit ${unit.id} body overlaps wall ${wall.id}: center=(${unit.gx.toFixed(6)},${unit.gy.toFixed(6)}) ` +
            `radius=${radius} distance=${distance.toFixed(6)}`);
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
    // 加回门之前先记下导航图构建计数和那条"开门时"的旧路线对象
    const buildsBefore = nav.stats.graphBuilds;
    const oldRoute = nav.routes.get(unit);
    assert.ok(oldRoute && oldRoute.points.length > 0, 'a real route must be cached while the door is open');
    dyn.requestAdd('door', DOOR);
    step(scene, 1);
    // 加回门后导航按新障碍重建：单位视线被西墙挡住 → 必须走 graph 但目标不可达
    assert.equal(nav.nextWaypoint(unit, 35, 35).reachable, false);
    // 旧路线必须作废：导航图重建、缓存路线对象被换掉
    assert.ok(nav.stats.graphBuilds > buildsBefore,
        `graphBuilds must increase after re-adding the door (${buildsBefore} -> ${nav.stats.graphBuilds})`);
    const newRoute = nav.routes.get(unit);
    assert.notEqual(newRoute, oldRoute, 'the cached route object must be discarded after re-adding the door');
    // 新路线里不得有任何航点落在门洞矩形内——封死后不能再借门洞穿墙
    // （封死时新路线为空：目标不可达，根本没有航点；只要出现航点就逐点检查）
    for (const [index, point] of (newRoute?.points ?? []).entries()) {
        assert.ok(!(point.gx > DOOR.x1 && point.gx < DOOR.x2 && point.gy > DOOR.y1 && point.gy < DOOR.y2),
            `new route waypoint #${index} falls inside the re-added door: (${point.gx},${point.gy})`);
    }
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
    step(scene, 1);   // 固定时点提交 + beginStep（清空 graphs/routes）+ updateNormalUnit（按新层重建）
    // 关键验证：graphBuilds 必须增加——说明导航检测到层变化、清空旧缓存、按新层重建了
    assert.ok(nav.stats.graphBuilds > buildsAfterA, 'graphBuilds must increase when rebuilt for new layer');
    assert.equal(nav.nextWaypoint(unit, 35, 35).reachable, false);
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
// 变更序列是完整的"关门→开门→再关门"：i=60 去门（开门）、i=120 把门加回（再关门）。
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
            // 完整"关门→开门→再关门"序列：正序（swap=false）和乱序（swap=true）两个变体都执行这一步。
            if (i === 120) dyn.requestAdd('door', DOOR);
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

// 步骤 2 · 接入移动类调用后的行为验证
// —— 单位直线被西墙挡住（x=28→36, y=32），门开着时导航绕行入框，plans 增加；
//    逐帧检查身体圆不与任何实体墙重叠（门板已移除，墙表不含门），循环结束后仍在框内。
test('open door: unit outside walks around walls via navigation into box', () => {
    const scene = makeScene();
    scene.dynamicBlockers = new DynamicBlockers();
    const dyn = scene.dynamicBlockers;
    for (const [id, rect] of WALLS) dyn.requestAdd(id, rect);
    // 兵 1：(28,32) → (36,32) 直线穿西墙，必须导航绕行入框
    const u1 = addUnit(scene, 'red', 'infantry', 28, 32);
    // 兵 2：框外旁观，保证不结算
    addUnit(scene, 'blue', 'infantry', 60, 60);
    scene.updateNormalUnit = u => {
        if (u === u1) { u.moveX = 0; u.moveY = 0; moveToward(u, 36, 32, u.typeData.speed, 1 / 60); }
    };
    // 先提交框墙 → 导航 graphs 里有墙
    step(scene, 3);
    const nav = scene.ensureNavigation();
    const plansBefore = nav.stats.plans;
    // 开门
    dyn.requestRemove('door');
    step(scene, 1);
    // 门已移除：墙表只含剩余实体墙（北墙两段 + 南/西/东各一段，共 5 段，不含门）
    const walls = WALLS.filter(([id]) => id !== 'door').map(([id, rect]) => ({ ...rect, id }));
    // 逐帧推进 1500 帧（25 秒）：每一帧都断言身体圆不与任何墙体重叠
    for (let frame = 0; frame < 1500; frame++) {
        step(scene, 1);
        assertNotInWalls(u1, walls);
    }
    assert.ok(nav.stats.plans > plansBefore, `navigation plans must increase (got ${nav.stats.plans} vs ${plansBefore})`);
    assert.ok(u1.gx > 30 && u1.gx < 40 && u1.gy > 30 && u1.gy < 40,
        `unit should be inside box, ended at (${u1.gx.toFixed(1)},${u1.gy.toFixed(1)})`);
});

// —— 门关着，单位始终进不了框（被导航判不可达 + clipMotion 挡住）。
//    逐帧检查：中心不得进入框内，身体圆也不得与任何墙体（含门）重叠。
test('closed door: unit never reaches box, stays outside', () => {
    const scene = makeScene();
    scene.dynamicBlockers = new DynamicBlockers();
    const dyn = scene.dynamicBlockers;
    for (const [id, rect] of WALLS) dyn.requestAdd(id, rect);
    const u1 = addUnit(scene, 'red', 'infantry', 28, 32);
    addUnit(scene, 'blue', 'infantry', 60, 60);
    scene.updateNormalUnit = u => {
        if (u === u1) { u.moveX = 0; u.moveY = 0; moveToward(u, 36, 32, u.typeData.speed, 1 / 60); }
    };
    step(scene, 3);
    const nav = scene.ensureNavigation();
    // 不可达：框被封死，目标点不在可达区域
    assert.equal(nav.nextWaypoint(u1, 36, 32).reachable, false);
    // 门关着：墙表含门，共 6 段——逐帧检查框内与墙体
    const walls = WALLS.map(([id, rect]) => ({ ...rect, id }));
    for (let frame = 0; frame < 1500; frame++) {
        step(scene, 1);
        assert.ok(!(u1.gx > 30 && u1.gx < 40 && u1.gy > 30 && u1.gy < 40),
            `unit unexpectedly reached inside box at frame ${frame}: (${u1.gx.toFixed(2)},${u1.gy.toFixed(2)})`);
        assertNotInWalls(u1, walls);
    }
});

// —— 击退朝墙（目标在墙外 0.3 处，amount=5）：knockback 一返回就检查，身体不得嵌进墙里。
test('knockback toward wall: body stays out of the wall immediately after knockback', () => {
    const scene = makeScene();
    scene.dynamicBlockers = new DynamicBlockers();
    // 只放一堵竖直墙在 x=40，y=30-40
    scene.dynamicBlockers.requestAdd('wall-knock', { x1: 39.6, y1: 30, x2: 40, y2: 40, kind: 'wall' });
    step(scene, 1);   // 提交墙，让 dynOf 返回非 null
    const u = addUnit(scene, 'red', 'infantry', 38, 35);   // 墙左侧 2 格
    addUnit(scene, 'blue', 'infantry', 60, 60);
    // 直接调用 knockback：朝 +x 方向（朝墙内） amount=5
    const from = { gx: 35, gy: 35 };
    const gx0 = u.gx;
    knockback(u, from, 5);   // angle = atan2(0,3)=0 → 朝 +x
    assert.ok(u.gx > gx0, `knockback must push the unit (${gx0} → ${u.gx})`);
    const wall = scene.dynamicBlockers.active.get('wall-knock');
    // 去掉事后的 step：knockback 返回的当帧，单位中心 + 身体半径就不得越过墙的近端面
    assert.ok(u.gx + CombatRules.bodyRadius(u) <= wall.x1 + 1e-6,
        `knockback embedded the body into the wall: gx=${u.gx}, radius=${CombatRules.bodyRadius(u)}, wall.x1=${wall.x1}`);
    // 穿墙判定：圆心进入墙体内部（gx 在 [x1, x2] 且 gy 在 [y1, y2]）
    const inside = u.gx > wall.x1 && u.gx < wall.x2 && u.gy > wall.y1 && u.gy < wall.y2;
    assert.ok(!inside, `knockback pushed unit center through wall: (${u.gx.toFixed(2)},${u.gy.toFixed(2)})`);
    assert.ok(u.gx <= wall.x2, `unit should not be on wall's far side: gx=${u.gx}`);
});

// —— 同一方 5 个兵在墙边密集站位（x≈34.15 一带，间距 0.26 < 身体直径 0.72），
//    不手动塞 separateX/Y，靠真实推挤分离逻辑产生推力。两组对照：
//    1) 无墙：同样站位，推进后必须有人被推过墙所在的 x 坐标——证明推挤确实发生；
//    2) 有墙：挂墙，墙两侧各一组镜像密集兵，逐帧断言两侧身体都不与墙体重叠，
//       也没有人被推到墙的另一侧（右侧兵 gx < wall.x1，左侧兵 gx > wall.x2）。
test('separation near a wall: crowding really pushes bodies, wall never lets one overlap it', () => {
    const CRAMPED_X = [33.63, 33.89, 34.15, 34.41, 34.67];
    const WALL_SEP = { x1: 35.2, y1: 32, x2: 35.6, y2: 38, kind: 'wall' };
    // 以墙中心 (35.4, 35) 为对称轴：x → 70.8 - x，y 不变
    const RIGHT_X = CRAMPED_X.map(x => 70.8 - x);   // → [36.13, 36.39, 36.65, 36.91, 37.17]
    const crowd = (withWall, mirrored = false) => {
        const scene = makeScene();
        if (withWall) {
            scene.dynamicBlockers = new DynamicBlockers();
            scene.dynamicBlockers.requestAdd('wall-sep', WALL_SEP);
        }
        const leftUnits = CRAMPED_X.map(x => addUnit(scene, 'red', 'infantry', x, 35));
        let rightUnits = [];
        if (mirrored) {
            rightUnits = RIGHT_X.map(x => addUnit(scene, 'red', 'infantry', x, 35));
        }
        const units = [...leftUnits, ...rightUnits];
        addUnit(scene, 'blue', 'infantry', 60, 60);   // 框外旁观，保证不结算
        // 只留推挤分离：所有单位都不主动移动
        scene.updateNormalUnit = unit => { unit.moveX = 0; unit.moveY = 0; };
        return { scene, units, leftUnits, rightUnits };
    };
    // 对照 1：无墙——推挤必须真的把兵推过墙所在的 x 坐标（否则本用例就是空测）
    const open = crowd(false);
    step(open.scene, 240);
    const pushed = open.units.filter(unit => unit.gx > WALL_SEP.x1);
    assert.ok(pushed.length > 0,
        `separation never pushed anyone past x=${WALL_SEP.x1}: ${open.units.map(unit => unit.gx.toFixed(3)).join(', ')}`);
    // 对照 2：有墙 + 两侧镜像兵——逐帧断言身体不嵌入墙；墙必须真正吃住推力
    const sealed = crowd(true, true);
    const wall = { ...WALL_SEP, id: 'wall-sep' };
    const wallMidX = (WALL_SEP.x1 + WALL_SEP.x2) / 2;   // 35.4
    const initLeftIds = new Set(sealed.leftUnits.map(u => u.id));
    const initRightIds = new Set(sealed.rightUnits.map(u => u.id));
    for (let frame = 0; frame < 240; frame++) {
        step(sealed.scene, 1);
        for (const unit of sealed.units) assertNotInWalls(unit, [wall]);
        // 初始在墙左的兵始终在墙左，不得越过 wall.x1
        for (const unit of sealed.units) {
            if (initLeftIds.has(unit.id)) {
                assert.ok(unit.gx < WALL_SEP.x1 + 1e-6,
                    `left-side unit ${unit.id} was pushed through wall to right side: gx=${unit.gx}, wall.x1=${WALL_SEP.x1}`);
            } else if (initRightIds.has(unit.id)) {
                assert.ok(unit.gx > WALL_SEP.x2 - 1e-6,
                    `right-side unit ${unit.id} was pushed through wall to left side: gx=${unit.gx}, wall.x2=${WALL_SEP.x2}`);
            }
        }
    }
    const radius = CombatRules.bodyRadius(sealed.leftUnits[0]);
    const maxX = Math.max(...sealed.leftUnits.map(unit => unit.gx));
    assert.ok(maxX > WALL_SEP.x1 - radius - 0.01,
        `crowd never pressed against the wall: max gx=${maxX}, expected ~${WALL_SEP.x1 - radius}`);
});

// —— 关闭对照（真实对比，不再是口头声明）：同一平地场景、相同兵力与站位，分别在
//    ① 不挂动态层（scene.dynamicBlockers = null，P0 前的原路径）
//    ② 挂一个空 DynamicBlockers、从不添加障碍
//    ③ 挂一个层，第 1 步加一块远离所有单位的障碍、第 2 步再删掉
//    三种配置下各跑 300 步，逐步记录每个单位的 id/gx/gy/hp/dead，三份轨迹必须完全一致。
test('disabled layer, empty layer and a transient far obstacle produce byte-identical trajectories', () => {
    const FRAMES = 300;
    const trace = (configure, withTransient) => {
        const scene = makeScene();
        configure(scene);
        addUnit(scene, 'red', 'infantry', 25, 35);
        addUnit(scene, 'red', 'infantry', 26.5, 34);
        addUnit(scene, 'blue', 'infantry', 45, 35);
        addUnit(scene, 'blue', 'infantry', 43.5, 36);
        const frames = [];
        for (let frame = 0; frame < FRAMES; frame++) {
            // 只有 withTransient=true 时才加/删远处障碍；空层和关闭层永远不碰障碍
            if (withTransient && frame === 0) scene.dynamicBlockers?.requestAdd('far-obstacle', { x1: 10, y1: 10, x2: 11, y2: 11.4, kind: 'wall' });
            if (withTransient && frame === 1) scene.dynamicBlockers?.requestRemove('far-obstacle');
            step(scene, 1);
            frames.push(scene.units.map(unit => ({
                id: unit.id, gx: unit.gx, gy: unit.gy, hp: unit.hp, dead: unit.dead
            })));
        }
        if (withTransient && scene.dynamicBlockers) {
            assert.ok(scene.dynamicBlockers.version >= 2,
                `transient layer version must reach >=2 (got ${scene.dynamicBlockers.version}) proving add+remove were both committed`);
        }
        return frames;
    };
    const disabled = trace(scene => { scene.dynamicBlockers = null; }, false);
    const empty = trace(scene => { scene.dynamicBlockers = new DynamicBlockers(); }, false);
    const transient = trace(scene => { scene.dynamicBlockers = new DynamicBlockers(); }, true);
    assert.equal(disabled.length, FRAMES);
    assert.deepEqual(empty, disabled, 'an empty dynamic layer must not change the simulation');
    assert.deepEqual(transient, disabled, 'a transient far-away obstacle must not change the simulation');
});

// ============================================================
// P0 第三轮新增：近战类攻击判定感知动态障碍，弓箭不受影响
// ============================================================

// —— 测试 1：隔墙近战砍不到。
//    墙竖直 x=38.9~39.1, y=30~40。两侧各放一名步兵，直线距离 0.8 < range 0.95，
//    中间被墙挡住。直接调用 resolveAttack，应返回 0。
test('melee attack blocked by a dynamic wall between attacker and target yields 0 damage', () => {
    const scene = makeScene();
    scene.dynamicBlockers = new DynamicBlockers();
    scene.dynamicBlockers.requestAdd('wall-melee', { x1: 38.9, y1: 30, x2: 39.1, y2: 40, kind: 'wall' });
    step(scene, 1);   // 提交墙，让 dynOf 返回非 null
    const red = addUnit(scene, 'red', 'infantry', 38.6, 35);
    const blue = addUnit(scene, 'blue', 'infantry', 39.4, 35);
    const dmg = resolveAttack(blue, red);
    assert.equal(dmg, 0, `melee through dynamic wall must yield 0 damage, got ${dmg}`);
    assert.equal(blue.hp, blue.maxHp, 'target hp must be unchanged');
});

// —— 测试 2：无墙对照——同站位无墙时，resolveAttack 返回 > 0，证明距离确实够近战。
test('melee without wall at same range yields positive damage (control case)', () => {
    const scene = makeScene();
    // 不挂动态层（dynOf 返回 null → 走原 segmentClear 路径）
    const red = addUnit(scene, 'red', 'infantry', 38.6, 35);
    const blue = addUnit(scene, 'blue', 'infantry', 39.4, 35);
    const dmg = resolveAttack(blue, red);
    assert.ok(dmg > 0, `melee without wall must deal positive damage, got ${dmg}`);
    assert.ok(blue.hp < blue.maxHp, 'target hp must decrease when no wall blocks');
});

// —— 测试 3：弓箭能越墙。墙隔开弓手和目标，弓手射程内，resolveAttack 远程仍能打中。
test('archer attack is NOT blocked by a dynamic wall — ranged still hits through', () => {
    const scene = makeScene();
    scene.dynamicBlockers = new DynamicBlockers();
    scene.dynamicBlockers.requestAdd('wall-archer', { x1: 39.8, y1: 30, x2: 40.2, y2: 40, kind: 'wall' });
    step(scene, 1);
    const archer = addUnit(scene, 'red', 'archer', 35, 35);   // range 9.5
    const target = addUnit(scene, 'blue', 'infantry', 43, 35);  // 距离 = 8 < 9.5
    const hpBefore = target.hp;
    const dmg = resolveAttack(target, archer);
    assert.ok(dmg > 0, `ranged attack through dynamic wall must still deal damage, got ${dmg}`);
    assert.ok(target.hp < hpBefore, 'target hp must decrease from ranged shot over wall');
});

// —— 测试 4：骑兵隔墙 → 枪兵迎击不结算。
//    墙隔开枪兵和骑兵，resolveBrace 检查 segmentClear 返回 false，迎击不触发。
test('cavalry-charge brace is blocked by dynamic wall — no brace damage or lastBrace stamp', () => {
    const scene = makeScene();
    scene.dynamicBlockers = new DynamicBlockers();
    scene.dynamicBlockers.requestAdd('wall-brace', { x1: 38.9, y1: 32, x2: 39.1, y2: 38, kind: 'wall' });
    step(scene, 1);
    const pike = addUnit(scene, 'blue', 'pikeman', 39.4, 35);
    const cavalry = addUnit(scene, 'red', 'cavalry', 38.6, 35);
    pike.lastBrace = 0;   // 初始化为 0，若 resolveBrace 不触发，它保持 0
    cavalry.hp = cavalry.maxHp;
    const hpBefore = cavalry.hp;
    resolveBrace(scene, pike, cavalry);
    assert.equal(pike.lastBrace, 0, `resolveBrace must not trigger when wall blocks LOS, lastBrace=${pike.lastBrace}`);
    assert.equal(cavalry.hp, hpBefore, 'cavalry must take no brace damage through wall');
});

// —— 测试 5：关闭对照——近战交战 + 弓箭对射，三份轨迹完全一致。
//    ① 不挂动态层（原路径）
//    ② 挂空 DynamicBlockers、永不添加障碍
//    ③ 挂一层，第 0 步加一块远离所有单位的障碍、第 1 步再删掉
//    各跑 300 帧，记录每个单位的 hp/dead，必须逐帧一致；
//    transient 组额外断言 version >= 2，证明临时障碍确实被提交并删除。
test('dynamic blockers OFF: melee vs ranged battle yields identical trajectories in disabled/empty/transient layers', () => {
    const FRAMES = 300;
    const trace = (configure, withTransient) => {
        const scene = makeScene();
        configure(scene);
        const redInf = addUnit(scene, 'red', 'infantry', 30, 30);
        const redArch = addUnit(scene, 'red', 'archer', 25, 35);
        const blueInf = addUnit(scene, 'blue', 'infantry', 40, 38);
        const blueArch = addUnit(scene, 'blue', 'archer', 45, 35);
        const frames = [];
        for (let frame = 0; frame < FRAMES; frame++) {
            if (withTransient && frame === 0) scene.dynamicBlockers?.requestAdd('far-wall', { x1: 10, y1: 50, x2: 11, y2: 50.4, kind: 'wall' });
            if (withTransient && frame === 1) scene.dynamicBlockers?.requestRemove('far-wall');
            step(scene, 1);
            frames.push(scene.units.map(u => ({
                id: u.id, gx: u.gx, gy: u.gy, hp: u.hp, dead: u.dead
            })));
        }
        if (withTransient && scene.dynamicBlockers) {
            assert.ok(scene.dynamicBlockers.version >= 2,
                `transient layer version must reach >=2 (got ${scene.dynamicBlockers.version}) proving add+remove were both committed`);
        }
        return frames;
    };
    const disabled = trace(s => { s.dynamicBlockers = null; }, false);
    const empty = trace(s => { s.dynamicBlockers = new DynamicBlockers(); }, false);
    const transient = trace(s => { s.dynamicBlockers = new DynamicBlockers(); }, true);
    assert.equal(disabled.length, FRAMES);
    assert.deepEqual(empty, disabled, 'empty DynamicBlockers must not alter melee/ranged battle');
    assert.deepEqual(transient, disabled, 'transient far obstacle must not alter melee/ranged battle');
});
