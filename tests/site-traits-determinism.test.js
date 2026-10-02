// 新规则的确定性验收：东西镜像一致、单机 1x/2x 结果一致、双端锁步逐位一致，
// 以及"派生缓存与展示状态不进哈希"的边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit } from './battle-harness.js';
import { setBoardSize, resetBoardSize, board } from '../js/board.js';
import { TERRITORY } from '../js/battle/economy.js';
import { battleProjection, hashProjection, LOCKSTEP, NetBattle, SIM_VERSION } from '../js/net/lockstep.js';
import { buildSpeedScale, buildingDamageScale, shallowSpeedFor, traitState } from '../js/battle/site-traits.js';
import { CAMP_RULES } from '../js/battle/camps.js';
import { WORKER_RULES, workerConstructionPaused } from '../js/battle/worker.js';

setBoardSize(TERRITORY.W, TERRITORY.H);
test.after(() => resetBoardSize());

const STEP = 1000 / 60;

function territoryScene({ net = false, mySide = 'red', config = { infantry: 8, archer: 4, worker: 2 } } = {}) {
    const scene = makeScene();
    scene.deployUnits({ ...config }, { ...config }, 'custom', 'custom', {},
        { territory: true, terrain: 'territory', territoryAI: false, net, mySide });
    scene.battleStarted = true;
    return scene;
}

function hash(scene) { return hashProjection(battleProjection(scene)); }

test('东西同类据点镜像一致：施工加速与建筑减伤两侧等价', () => {
    const scene = territoryScene();
    const camps = scene.territory.camps;
    const west = scene.flags.findIndex(f => f.name === '西林口');
    const east = scene.flags.findIndex(f => f.name === '东林口');
    scene.flags[west].owner = 'red';
    scene.flags[east].owner = 'blue';
    traitState(scene).refresh();
    const redCamp = camps.createBuilding('red', 'camp', west, false);
    const blueCamp = camps.createBuilding('blue', 'camp', east, false);
    const redWorker = addUnit(scene, 'red', 'worker', redCamp.gx, redCamp.gy);
    const blueWorker = addUnit(scene, 'blue', 'worker', blueCamp.gx, blueCamp.gy);
    camps.requestBuild('red', redWorker.id, 'camp', west);
    camps.requestBuild('blue', blueWorker.id, 'camp', east);
    // 两侧都已在施工（createBuilding 后 requestBuild 续用同一对象）
    redCamp.workerId = redWorker.id; redWorker.workerTask = { kind: 'build', buildingId: redCamp.id };
    blueCamp.workerId = blueWorker.id; blueWorker.workerTask = { kind: 'build', buildingId: blueCamp.id };
    redWorker.gx = redCamp.gx; redWorker.gy = redCamp.gy;
    blueWorker.gx = blueCamp.gx; blueWorker.gy = blueCamp.gy;
    camps.update(1);
    assert.ok(Math.abs(redCamp.progress - blueCamp.progress) < 1e-12, '两侧林口同速');
    assert.equal(buildSpeedScale(scene, redCamp), buildSpeedScale(scene, blueCamp));
    assert.equal(buildingDamageScale(scene, redCamp), buildingDamageScale(scene, blueCamp));

    const westBridge = scene.flags.findIndex(f => f.name === '西桥头');
    const eastBridge = scene.flags.findIndex(f => f.name === '东桥头');
    scene.flags[westBridge].owner = 'red';
    scene.flags[eastBridge].owner = 'blue';
    traitState(scene).refresh();
    const redBridgeCamp = camps.createBuilding('red', 'camp', westBridge, true);
    const blueBridgeCamp = camps.createBuilding('blue', 'camp', eastBridge, true);
    assert.equal(buildingDamageScale(scene, redBridgeCamp), buildingDamageScale(scene, blueBridgeCamp));
    assert.equal(redBridgeCamp.gx + blueBridgeCamp.gx, board.W, '东西据点建筑坐标镜像');
    assert.equal(redBridgeCamp.gy, blueBridgeCamp.gy);
});

test('单机 1x 与 2x：固定步长下结果逐位一致（含据点特色与民夫自卫）', () => {
    const run = speed => {
        const scene = territoryScene();
        scene.gameSpeed = speed;
        // 制造特色局面：红拿渡口 + 林口，蓝拿另一侧，双方各有一组民夫施工。
        scene.flags.find(f => f.name === '西渡口').owner = 'red';
        scene.flags.find(f => f.name === '东林口').owner = 'blue';
        traitState(scene).refresh();
        const camps = scene.territory.camps;
        scene.territory.econ.treasury.red = 2000;
        scene.territory.econ.treasury.blue = 2000;
        const redWorker = scene.units.find(u => u.team === 'red' && u.type === 'worker');
        const site = scene.flags.findIndex(f => f.owner === 'red' && f.role === 'forest');
        camps.requestBuild('red', redWorker.id, 'camp', site);
        const building = camps.getBuilding(`camp:red:${site}`);
        redWorker.gx = building.gx; redWorker.gy = building.gy;
        addUnit(scene, 'blue', 'infantry', building.gx + 0.6, building.gy);   // 逼出民夫自卫
        const calls = speed === 1 ? 600 : 300;                                // 两边都是 600 步
        for (let i = 0; i < calls; i++) scene.advanceBattle(STEP);
        return scene;
    };
    const one = run(1), two = run(2);
    assert.equal(battleProjection(one), battleProjection(two));
    assert.equal(hash(one), hash(two));
    assert.equal(one.simulationTime, two.simulationTime);
    assert.ok(one.territory.camps.buildings.some(b => b.progress > 0), '施工真的推进了');
});

test('双端锁步：据点特色与民夫自卫下仍逐位一致，且两端相同时刻哈希相同', () => {
    const build = mySide => {
        const scene = territoryScene({ net: true, mySide });
        // 开局归属固定，特色状态由地图决定；两端必须算出同一份派生状态。
        traitState(scene).refresh();
        return scene;
    };
    const a = build('red'), b = build('blue');
    const deliver = packet => { a.net.handle(packet); b.net.handle(packet); };
    a.net = new NetBattle(a, { send: deliver });
    b.net = new NetBattle(b, { send: deliver });
    a.net.start(); b.net.start();

    const workerA = a.units.find(u => u.team === 'red' && u.type === 'worker');
    const workerB = b.units.find(u => u.team === 'blue' && u.type === 'worker');
    const site = 0;
    a.territory.econ.treasury.red = 900; b.territory.econ.treasury.red = 900;
    a.territory.econ.treasury.blue = 900; b.territory.econ.treasury.blue = 900;
    let checkpoints = 0;
    let probeA = null, probeB = null;   // 持有被贴身敌军攻击的那名民夫（阵亡压实后数组里换人）
    for (let turn = 0; turn < 60 * 12; turn++) {
        if (turn === 10) {
            a.net.lockstep.act({ k: 'build', side: 'red', worker: workerA.id, kind: 'camp', site });
            a.net.lockstep.act({ k: 'worker-move', side: 'red', worker: workerA.id, gx: 120, gy: 90 });
        }
        if (turn === 12) {
            // 两端同坐标放置贴身敌军（状态操作，非命令）：民夫自卫与 workerEngageAt
            // 由此进入双端模拟——历史交战时刻若只在一端入投影，哈希校验会当场暴露。
            probeA = a.units.find(u => u.team === 'red' && u.type === 'worker');
            probeB = b.units.find(u => u.team === 'red' && u.type === 'worker');
            addUnit(a, 'blue', 'infantry', probeA.gx + 0.6, probeA.gy);
            addUnit(b, 'blue', 'infantry', probeB.gx + 0.6, probeB.gy);
            a.rebuildSpatial(); b.rebuildSpatial();
        }
        if (turn === 60) {
            b.net.lockstep.act({ k: 'build', side: 'blue', worker: workerB.id, kind: 'camp', site: 3 });
        }
        const readyA = a.net.lockstep.canStep(), readyB = b.net.lockstep.canStep();
        assert.equal(readyA, readyB, '两端推进节奏一致');
        if (!readyA) break;
        for (const scene of [a, b]) {
            const commands = scene.net.lockstep.takeCommands();
            for (const command of commands) scene.applyNetCommand(command);
            scene.simulationTime += STEP;
            scene.stepBattle(STEP / 1000);
            scene.net.onTurnDone();
        }
        if (turn > 0 && turn % LOCKSTEP.HASH_EVERY === 0) {
            checkpoints++;
            assert.equal(hash(a), hash(b), `第 ${turn} 回合哈希一致`);
        }
    }
    assert.ok(checkpoints >= 2, '至少两次哈希校验');
    assert.equal(a.net.desynced, false);
    assert.equal(b.net.desynced, false);
    // 民夫自卫真的在双端发生过，且历史交战时刻两端一致（进投影后被哈希覆盖）。
    assert.ok(probeA?.workerEngageAt != null, '红方民夫在 A 端交战过');
    assert.ok(probeB?.workerEngageAt != null, '同一战斗在 B 端同样交战');
    assert.equal(probeA.workerEngageAt, probeB.workerEngageAt, '历史交战时刻两端一致');
    // 派生状态两端一致
    assert.equal(buildSpeedScale(a, a.territory.camps.buildings[0]),
        buildSpeedScale(b, b.territory.camps.buildings[0]));
    assert.equal(shallowSpeedFor(a, 'red'), shallowSpeedFor(b, 'red'));
    assert.equal(shallowSpeedFor(a, 'blue'), shallowSpeedFor(b, 'blue'));
});

test('模拟版本随本轮行为变化更新，旧页面无法混用', () => {
    // 第二批（r2）：量化半量子边界统一归属 + 民夫候选查询覆盖完整接受带，
    // 噪声带内离散决策结果改变 → 状态哈希整体改变，混版本必须拒绝。
    assert.equal(SIM_VERSION, '2026-10-02-review-fixes-r2');
    assert.notEqual(SIM_VERSION, '2026-10-02-review-fixes', '相对第一批必须递增');
    assert.notEqual(SIM_VERSION, '2026-10-02-site-traits', '相对上一批必须递增，混版本会被拒绝');
});

test('纯派生缓存与展示状态不进哈希：只改缓存不改模拟结果', () => {
    const scene = territoryScene();
    const before = hash(scene);
    scene.siteTraits = null;                     // 丢弃派生缓存（下次访问重建）
    scene.flags[0].displayColor = 0x123456;      // 渲染插值色
    scene.flags[0].pulseAt = 12345;
    scene.territory.camps.buildings[0].renderBounds = { x: 1, y: 2, width: 3, height: 4 };
    assert.equal(hash(scene), before, '派生/展示字段不影响同步投影');
    // 但真实模拟结果仍然入哈希：桥头减伤按最终伤害落账 → 建筑血量变化必须被检出。
    const camps = scene.territory.camps;
    const bridge = scene.flags.findIndex(f => f.role === 'bridge' && f.owner === 'red');
    const building = camps.createBuilding('red', 'tower', bridge, true);
    const seeded = hash(scene);
    const beforeHp = building.hp;
    const dealt = camps.damageBuilding(building, 100, addUnit(scene, 'blue', 'infantry', 12, 12));
    assert.equal(dealt, 90, '桥头减伤后 100 → 90（取整口径固定）');
    assert.equal(beforeHp - building.hp, 90, '血量变化与结算值一致');
    assert.notEqual(hash(scene), seeded, '减伤后的真实血量变化仍在投影里');
    assert.equal(building.maxHp, CAMP_RULES.tower.hp);
});

// Review P2-2 复现：workerEngageAt 是"过去接敌的模拟时刻"，单独决定之后 300ms
// 的施工暂停，属于历史模拟状态而非派生/展示字段。修复前它不在同步投影里：
// 同一模拟时刻把 800 改成 600，施工暂停从 true 变 false，投影哈希却完全相同——
// 这是一个同步检测盲点（字段遗漏本身不必然导致漂移，但漂移发生时无法被检出）。
test('workerEngageAt 是历史模拟状态：同模拟时刻不同历史必须被投影检出', () => {
    const scene = territoryScene();
    const worker = scene.units.find(u => u.team === 'red' && u.type === 'worker');
    scene.simulationTime = 1000;
    worker.workerEngageAt = 800;
    const hashEarly = hash(scene);
    assert.equal(workerConstructionPaused(worker, scene.simulationTime), true, '800 时仍在回滞窗口内：施工暂停');
    worker.workerEngageAt = 600;
    assert.equal(workerConstructionPaused(worker, scene.simulationTime), false, '600 时已脱战：施工恢复');
    assert.notEqual(hashEarly, hash(scene), '历史交战时刻不同 → 投影必须不同（否则是同步检测盲点）');
    // "从未交战"有明确空表示，且有效的 0ms 不与空值混同。
    worker.workerEngageAt = null;
    const hashNever = hash(scene);
    assert.notEqual(hashEarly, hashNever, '从未交战与 800ms 交战可区分');
    worker.workerEngageAt = 0;
    assert.notEqual(hash(scene), hashNever, '0ms 是有效交战时刻，不能被当成空值');
    assert.equal(workerConstructionPaused(worker, WORKER_RULES.ENGAGE_HOLD_MS), true, '0ms 在窗口内确实暂停');
});

test('真实交战写入的 workerEngageAt 进入投影（选敌→出手→停工全真路径）', () => {
    const scene = territoryScene();
    const worker = scene.units.find(u => u.team === 'red' && u.type === 'worker');
    worker.gx = 40; worker.gy = 40;
    const enemy = addUnit(scene, 'blue', 'infantry', 40.6, 40);
    const before = battleProjection(scene);
    scene.rebuildSpatial();
    // 第一步：冷却就绪 → 出手（此时 engageAt == lastAttack，与既有 lastAttack 投影
    // 字段 token 碰撞，单独断言无判别力）。
    scene.simulationTime += 1000 / 60;
    scene.territory.camps.updateUnit(worker, scene.simulationTime, 1 / 60);
    // 第二步：冷却未到不再出手，但交战仍在继续 → engageAt 前进而 lastAttack 不动。
    // 此时投影里必须出现 engageAt 自己的值（且区别于 lastAttack），A 树（无此字段）
    // 必然失败——这条断言才有判别力。
    scene.simulationTime += 1000 / 60;
    scene.territory.camps.updateUnit(worker, scene.simulationTime, 1 / 60);
    scene.flushBattleActions();
    // 让第一步出手的 95ms 延迟命中的确结算（不推进 updateUnit，engageAt 保持第二步值）。
    scene.simulationTime += 100;
    scene.flushBattleActions();
    const after = battleProjection(scene);
    assert.ok(worker.workerEngageAt != null, '贴身敌军真的触发自卫');
    assert.notEqual(worker.workerEngageAt, worker.lastAttack, '第二步后交战时刻已离开出手时刻（避免 token 碰撞）');
    assert.notEqual(before, after, '交战事实改变投影');
    assert.ok(after.includes(String(Math.round(worker.workerEngageAt * 1e3))),
        '交战时刻的量化值必须在投影字符串里（且非 lastAttack 的碰撞值）');
    assert.ok(enemy.hp < enemy.maxHp, '第一步确实真实出手并造成伤害');
});
