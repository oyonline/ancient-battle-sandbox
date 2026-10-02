// 民夫有限近战自卫：真实出手/伤害/冷却、不追击、交战停工与脱战续工、
// 溃逃不攻击不施工、仍不能占旗 / 驻塔 / 接攻城令。
// 风格：轻量 harness 场景直接驱动模拟层（同 camps.test.js / healing.test.js）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit } from './battle-harness.js';
import { resetBoardSize, board } from '../js/board.js';
import { UNIT_TYPES } from '../js/units.js';
import { CAMP_RULES } from '../js/battle/camps.js';
import { WORKER_RULES, workerMeleeTarget, workerConstructionPaused } from '../js/battle/worker.js';

const STEP_MS = 1000 / 60;

// 领土场景（双方自动征兵关闭），随后手工放民夫与目标，隔离变量。
function workerScene() {
    const scene = makeScene();
    scene.deployUnits({}, {}, 'custom', 'custom', {},
        { territory: true, terrain: 'flat', territoryAI: false });
    scene.battleStarted = true;
    return scene;
}

// 只推进民夫的营寨入口（含自卫）与到点战斗动作，其他单位不参与，便于精确计时。
function drive(scene, unit, ms) {
    const dt = STEP_MS / 1000;
    const steps = Math.round(ms / STEP_MS);
    for (let i = 0; i < steps; i++) {
        scene.simulationTime += STEP_MS;
        scene.rebuildSpatial();
        scene.territory.camps.updateUnit(unit, scene.simulationTime, dt);
        scene.flushBattleActions();
    }
}

// 同一步内推进两名民夫（共享同一模拟时钟），用于镜像/计时对比。
function drivePair(scene, a, b, ms) {
    const dt = STEP_MS / 1000;
    const steps = Math.round(ms / STEP_MS);
    for (let i = 0; i < steps; i++) {
        scene.simulationTime += STEP_MS;
        scene.rebuildSpatial();
        scene.territory.camps.updateUnit(a, scene.simulationTime, dt);
        scene.territory.camps.updateUnit(b, scene.simulationTime, dt);
        scene.flushBattleActions();
    }
}

test('民夫出手：贴身敌军按 12 攻击力、1.4 秒冷却真实掉血', () => {
    const scene = workerScene();
    const worker = addUnit(scene, 'red', 'worker', 40, 40);
    const target = addUnit(scene, 'blue', 'archer', 40.6, 40);   // 弓手 def 3 → 每击 12-3=9
    const before = target.hp;
    drive(scene, worker, 300);
    assert.equal(before - target.hp, 9, '首次出手造成 12-3=9 伤害');
    drive(scene, worker, 1000);
    assert.equal(before - target.hp, 9, '冷却未到不再出手');
    drive(scene, worker, 500);
    assert.equal(before - target.hp, 18, '1.4 秒冷却后第二击');
    resetBoardSize();
});

test('民夫不追击：远处敌人不引出工地，也不挨打', () => {
    const scene = workerScene();
    scene.territory.econ.treasury.red = 1000;
    const site = 0;   // 西桥头（红方开局据点，无营建加速，纯测量）
    assert.equal(scene.flags[site].owner, 'red');
    const worker = addUnit(scene, 'red', 'worker', 40, 40);
    assert.equal(scene.territory.camps.requestBuild('red', worker.id, 'camp', site), true);
    const building = scene.territory.camps.getBuilding(`camp:red:${site}`);
    worker.gx = building.gx; worker.gy = building.gy;
    const enemy = addUnit(scene, 'blue', 'infantry', worker.gx + 3, worker.gy);   // 3 格：射程外
    const enemyHp = enemy.hp;
    const startX = worker.gx, startY = worker.gy;
    drive(scene, worker, 2000);
    assert.equal(worker.gx, startX, '民夫不被近处敌人引离工地（无追击位移）');
    assert.equal(worker.gy, startY);
    assert.equal(enemy.hp, enemyHp, '射程外的敌人不会被民夫主动攻击');
    resetBoardSize();
});

test('交战停工、脱战续工：进度不重置也不边打边涨', () => {
    const scene = workerScene();
    scene.territory.econ.treasury.red = 1000;
    const site = 0;
    const worker = addUnit(scene, 'red', 'worker', 40, 40);
    assert.equal(scene.territory.camps.requestBuild('red', worker.id, 'camp', site), true);
    const building = scene.territory.camps.getBuilding(`camp:red:${site}`);
    worker.gx = building.gx; worker.gy = building.gy;
    scene.territory.camps.update(STEP_MS / 1000);
    const afterFirst = building.progress;
    assert.ok(afterFirst > 0, '无敌人时正常施工');

    const enemy = addUnit(scene, 'blue', 'infantry', worker.gx + 0.6, worker.gy);
    for (let i = 0; i < 60; i++) {
        scene.simulationTime += STEP_MS;
        scene.rebuildSpatial();
        scene.territory.camps.updateUnit(worker, scene.simulationTime, STEP_MS / 1000);
        scene.flushBattleActions();
        scene.territory.camps.update(STEP_MS / 1000);
    }
    assert.equal(building.progress, afterFirst, '交战期间施工进度完全冻结');
    assert.equal(building.paused, true);
    assert.equal(workerConstructionPaused(worker, scene.simulationTime), true);
    assert.ok(enemy.hp < enemy.maxHp, '停工期间民夫仍在还手');

    // 敌人撤离（远出近战范围）：交战时停，脱战后继续原任务且进度不重置。
    enemy.gx = worker.gx + 6;
    scene.rebuildSpatial();
    for (let i = 0; i < 40; i++) {
        scene.simulationTime += STEP_MS;
        scene.rebuildSpatial();
        scene.territory.camps.updateUnit(worker, scene.simulationTime, STEP_MS / 1000);
        scene.flushBattleActions();
        scene.territory.camps.update(STEP_MS / 1000);
    }
    assert.equal(building.paused, false);
    assert.ok(building.progress > afterFirst, '脱战后从已有进度继续施工');
    assert.equal(worker.workerTask.kind, 'build', '原施工任务保留');
    resetBoardSize();
});

test('溃逃民夫不攻击也不施工，恢复后照旧', () => {
    const scene = workerScene();
    scene.territory.econ.treasury.red = 1000;
    const site = 0;
    const worker = addUnit(scene, 'red', 'worker', 40, 40);
    scene.territory.camps.requestBuild('red', worker.id, 'camp', site);
    const building = scene.territory.camps.getBuilding(`camp:red:${site}`);
    worker.gx = building.gx; worker.gy = building.gy;
    const enemy = addUnit(scene, 'blue', 'infantry', worker.gx + 0.6, worker.gy);
    const enemyHp = enemy.hp;
    worker.moraleState = 'routing';
    const before = building.progress;
    for (let i = 0; i < 90; i++) {
        scene.simulationTime += STEP_MS;
        scene.rebuildSpatial();
        scene.territory.camps.updateUnit(worker, scene.simulationTime, STEP_MS / 1000);
        scene.flushBattleActions();
        scene.territory.camps.update(STEP_MS / 1000);
    }
    assert.equal(enemy.hp, enemyHp, '溃逃中不出手');
    assert.equal(building.progress, before, '溃逃中不施工');
    assert.equal(building.paused, true);

    worker.moraleState = 'steady';
    drive(scene, worker, 200);
    assert.ok(enemy.hp < enemyHp, '恢复后重新自卫');
    resetBoardSize();
});

test('民夫仍不能占旗、不能驻塔、不能接收攻城命令、不进营队', () => {
    const scene = workerScene();
    const worker = addUnit(scene, 'red', 'worker', 40, 40);
    const flag = scene.flags[2];                     // 中央高地：开局中立
    worker.gx = flag.gx; worker.gy = flag.gy;
    const before = flag.progress;
    for (let i = 0; i < 120; i++) {
        scene.simulationTime += STEP_MS;
        scene.rebuildSpatial();
        scene.updateFlags(STEP_MS / 1000);
    }
    assert.equal(flag.progress, before, '民夫站在旗圈内也不产生占领力');
    assert.equal(flag.owner, null);

    const tower = scene.territory.camps.getBuilding('tower:red:home');
    assert.equal(scene.territory.camps.orderGarrison('red', [worker.id], tower.id), false, '民夫不能驻塔');
    assert.equal(scene.territory.camps.orderAttackBuilding('red', [worker.id], tower.id), false, '民夫不能接攻城令');
    scene.battalions.splitOpening([worker]);
    scene.battalions.assignReinforcement(worker);
    assert.equal(scene.battalions.battalions.length, 0, '民夫不编入营队（不参与冲锋）');
    resetBoardSize();
});

test('民夫自卫参数与营寨跳过战斗的旧分支已打通：真实出手且冷却随兵种', () => {
    assert.equal(UNIT_TYPES.worker.atk, 12);
    assert.equal(UNIT_TYPES.worker.atkSpeed, 1400);
    assert.equal(UNIT_TYPES.worker.range, 0.9);
    assert.equal(UNIT_TYPES.worker.hp, 45);
    assert.equal(UNIT_TYPES.worker.def, 0);
    assert.equal(UNIT_TYPES.worker.speed, 2.4);
    assert.equal(UNIT_TYPES.worker.cost, 3);

    const scene = workerScene();
    const worker = addUnit(scene, 'red', 'worker', 40, 40);
    const near = addUnit(scene, 'blue', 'archer', 40.5, 40);
    const far = addUnit(scene, 'blue', 'archer', 41.6, 40);
    scene.rebuildSpatial();
    assert.equal(workerMeleeTarget(scene, worker), near, '只锁近战范围内最近的目标');
    far.gx = 40.55; near.gx = 41.6;                  // 交换：更近者优先，平局按 id
    scene.rebuildSpatial();
    assert.equal(workerMeleeTarget(scene, worker), far);
    resetBoardSize();
});

test('民夫不能替代同规模剑士：等军费下剑士战线胜出', () => {
    const scene = workerScene();
    // 90 军费预算：5 名民夫（18/人）对 3 名剑士（30/人）。领土模式下民夫真正还手。
    const workers = [];
    for (let i = 0; i < 5; i++) workers.push(addUnit(scene, 'blue', 'worker', 41.4, 38.6 + i * 0.7));
    for (let i = 0; i < 3; i++) addUnit(scene, 'red', 'infantry', 39.6, 39.2 + i * 0.9);
    for (let i = 0; i < 60 * 40 && !scene.battleOver; i++) {
        scene.simulationTime += STEP_MS;
        scene.stepBattle(STEP_MS / 1000);
    }
    const swords = scene.units.filter(u => u.team === 'red' && u.type === 'infantry' && !u.dead && !u.withdrawn);
    const alive = scene.units.filter(u => u.team === 'blue' && u.type === 'worker' && !u.dead && !u.withdrawn);
    assert.ok(swords.length > 0, '同军费剑士线存活');
    assert.equal(alive.length, 0, '廉价民夫无法替代同规模剑士');
    assert.ok(workers.some(w => w.dead), '民夫确实参战并被打死');
    resetBoardSize();
});

test('交战回滞窗口覆盖出手结算，施工不会与伤害同拍', () => {
    const scene = workerScene();
    const worker = addUnit(scene, 'red', 'worker', 40, 40);
    const enemy = addUnit(scene, 'blue', 'infantry', 40.6, 40);
    scene.rebuildSpatial();
    scene.simulationTime += STEP_MS;                  // 与真实节奏一致：先推进时间再走单位
    scene.territory.camps.updateUnit(worker, scene.simulationTime, STEP_MS / 1000);
    assert.equal(worker.workerEngageAt, scene.simulationTime);
    scene.simulationTime += WORKER_RULES.ENGAGE_HOLD_MS;
    assert.equal(workerConstructionPaused(worker, scene.simulationTime), true, '回滞窗口内视为仍在交战');
    scene.simulationTime += 1;
    assert.equal(workerConstructionPaused(worker, scene.simulationTime), false, '窗口结束后脱战');
    scene.simulationTime += 100;
    scene.flushBattleActions();                       // 出手在 95ms 后结算（与动画同步）
    assert.ok(enemy.hp < enemy.maxHp);
    resetBoardSize();
});

test('近战范围边界：量化口径下范围内真实出手，量级之外不动手也不停工', () => {
    // 口径统一后的语义：名义射程 0.9，进入离散决策的距离先量化（0.05 量子）。
    // 因此 <0.925（量化后 ≤0.9）都算"够得着"，≥0.95（量化后 >0.9）够不着。
    const scene = workerScene();
    const worker = addUnit(scene, 'red', 'worker', 40, 40);

    const inside = addUnit(scene, 'blue', 'infantry', 40.85, 40);
    drive(scene, worker, 300);
    assert.ok(inside.hp < inside.maxHp, '0.85 格：范围内真实掉血');
    inside.gx = 200;

    const edge = addUnit(scene, 'blue', 'infantry', 40.9, 40);       // 恰好名义边界
    drive(scene, worker, 1800);                                       // 覆盖一个完整冷却
    assert.ok(edge.hp < edge.maxHp, '恰好 0.9 格：边界上真实出手');
    edge.gx = 200;

    const tightOut = addUnit(scene, 'blue', 'infantry', 40.95, 40);   // 紧邻范围外（下一量级）
    drive(scene, worker, 1800);
    assert.equal(tightOut.hp, tightOut.maxHp, '0.95 格不出手');
    assert.equal(workerMeleeTarget(scene, worker), null, '0.95 格不锁定目标');
    assert.equal(workerConstructionPaused(worker, scene.simulationTime), false, '范围外不算交战');
    tightOut.gx = 200;

    const farOut = addUnit(scene, 'blue', 'infantry', 43, 40);        // 明确范围外
    drive(scene, worker, 1800);
    assert.equal(farOut.hp, farOut.maxHp, '3 格外不出手');
    assert.equal(workerMeleeTarget(scene, worker), null);
    assert.equal(worker.gx, 40, '始终不被引离原地（不追击）');
    resetBoardSize();
});

// Review P2-1 复现：镜像两侧坐标对称，原始浮点距离一侧 0.8999…、一侧 0.9000…057。
// 修复前选敌（量化距离）两侧都选中，但出手判定（原始距离）只有西侧通过，
// 东侧民夫选目标却永远打不出去。修复后选敌、出手、伤害、冷却、停工两侧一致。
test('镜像边界一致：同为 0.9 格，东西两侧出手/伤害/冷却/停工完全一致', () => {
    const scene = workerScene();
    const westWorker = addUnit(scene, 'red', 'worker', 40, 40);
    const westEnemy = addUnit(scene, 'blue', 'archer', 40.9, 40);             // 原始距离 0.8999999…86
    const eastWorker = addUnit(scene, 'red', 'worker', board.W - 40, 40);     // 260-40 = 220
    const eastEnemy = addUnit(scene, 'blue', 'archer', board.W - 40.9, 40);   // 260-40.9 = 219.1，距离 0.9000000…57
    const westBefore = westEnemy.hp, eastBefore = eastEnemy.hp;

    drivePair(scene, westWorker, eastWorker, 300);
    assert.equal(westBefore - westEnemy.hp, 9, '西侧民夫真实出手（12 攻击 − 3 护甲）');
    assert.equal(eastBefore - eastEnemy.hp, 9, '镜像侧同样真实出手：出手距离口径两侧一致');
    assert.equal(workerConstructionPaused(westWorker, scene.simulationTime), true, '西侧交战停工');
    assert.equal(workerConstructionPaused(eastWorker, scene.simulationTime), true, '镜像侧同样停工');

    // 冷却节奏两侧一致：1.4 秒冷却未到不出手，到点同时打出第二击。
    drivePair(scene, westWorker, eastWorker, 1000);
    assert.equal(westBefore - westEnemy.hp, 9, '西侧冷却未到不再出手');
    assert.equal(eastBefore - eastEnemy.hp, 9, '东侧冷却未到不再出手');
    drivePair(scene, westWorker, eastWorker, 500);
    assert.equal(westBefore - westEnemy.hp, 18, '西侧 1.4 秒后第二击');
    assert.equal(eastBefore - eastEnemy.hp, 18, '东侧 1.4 秒后第二击');
    resetBoardSize();
});

// ==================== 复审剩余问题（第二轮）：完整距离判定链 ====================
// 复现 A（空间桶漏查）：量化判定接受 0.915（q=0.9），但候选查询半径只有 0.9，
// 相邻空间桶里的合法目标被提前漏掉——一侧 0 伤害不停工，另一侧 9 伤害停工。
// 复现 B（半量子边界分裂）：0.925 的两种浮点表示（0.9249999…972 / 0.9250000…114）
// 量化到不同档位，一侧攻击一侧不攻击。
// 修复要求：候选查询覆盖完整接受带；半量子边界按四舍五入契约统一归属下一档
//（恰好 0.925 两侧都不攻击、不停工；0.915 两侧都攻击）。

function driveMany(scene, units, ms) {
    const dt = STEP_MS / 1000;
    const steps = Math.round(ms / STEP_MS);
    for (let i = 0; i < steps; i++) {
        scene.simulationTime += STEP_MS;
        scene.rebuildSpatial();
        for (const unit of units) scene.territory.camps.updateUnit(unit, scene.simulationTime, dt);
        scene.flushBattleActions();
    }
}

// 量化判定的"应当出手"档位：q(d) ≤ 0.9。恰好 0.925（18.5 量子）按四舍五入契约
// 归属下一档（0.95），不攻击、不锁定、不停工。
const ATTACKS = { 0.85: true, 0.9: true, 0.915: true, 0.924999: true, 0.925: false, 0.925001: false, 0.95: false };

test('复现A 空间桶漏查：0.915 的目标在桶边界两侧都能被查到并真实出手（东/西/南/北 + 镜像）', () => {
    const scene = workerScene();
    // 东西向：敌人在东侧（+x），量化接受但旧查询半径 0.9 漏掉相邻桶。
    const pairs = [
        addUnit(scene, 'red', 'worker', 32.065, 40), addUnit(scene, 'blue', 'archer', 32.98, 40),
        addUnit(scene, 'red', 'worker', 227.935, 40), addUnit(scene, 'blue', 'archer', 227.02, 40),
        // 东西向：敌人在西侧（−x）。
        addUnit(scene, 'red', 'worker', 32.98, 60), addUnit(scene, 'blue', 'archer', 32.065, 60),
        addUnit(scene, 'red', 'worker', 227.02, 60), addUnit(scene, 'blue', 'archer', 227.935, 60),
        // 南北向（y 桶边界同样存在）。
        addUnit(scene, 'red', 'worker', 40, 32.065), addUnit(scene, 'blue', 'archer', 40, 32.98),
        addUnit(scene, 'red', 'worker', 220, 32.065), addUnit(scene, 'blue', 'archer', 220, 32.98)
    ];
    const workers = pairs.filter((u, i) => i % 2 === 0);
    const enemies = pairs.filter((u, i) => i % 2 === 1);
    const before = enemies.map(e => e.hp);
    driveMany(scene, workers, 300);
    enemies.forEach((enemy, i) => {
        assert.equal(before[i] - enemy.hp, 9, `第 ${i + 1} 对（0.915 格）真实出手造成 9 伤害`);
        assert.equal(workerConstructionPaused(workers[i], scene.simulationTime), true, `第 ${i + 1} 对交战停工`);
    });
    resetBoardSize();
});

test('复现B 半量子边界：恰好 0.925 两侧统一归下一档——不攻击、不锁定、不停工', () => {
    const scene = workerScene();
    const westWorker = addUnit(scene, 'red', 'worker', 40, 40);
    const westEnemy = addUnit(scene, 'blue', 'archer', 40.925, 40);            // 0.9249999999999972（量化到 0.9，修复前攻击）
    const eastWorker = addUnit(scene, 'red', 'worker', 220, 40);
    const eastEnemy = addUnit(scene, 'blue', 'archer', 219.075, 40);           // 0.9250000000000114（量化到 0.95，不攻击）
    driveMany(scene, [westWorker, eastWorker], 300);
    assert.equal(westEnemy.hp, westEnemy.maxHp, '西侧 0.925：不攻击');
    assert.equal(eastEnemy.hp, eastEnemy.maxHp, '镜像侧 0.925：同样不攻击（两侧同档）');
    assert.equal(workerMeleeTarget(scene, westWorker), null, '西侧 0.925 不锁定目标');
    assert.equal(workerMeleeTarget(scene, eastWorker), null, '镜像侧 0.925 不锁定目标');
    assert.equal(workerConstructionPaused(westWorker, scene.simulationTime), false, '西侧不因该敌人停工');
    assert.equal(workerConstructionPaused(eastWorker, scene.simulationTime), false, '镜像侧不停工');
    resetBoardSize();
});

test('边界阶梯：0.85/0.9/0.915/0.924999 真实出手，0.925/0.925001/0.95 不出手（含镜像两侧）', () => {
    const scene = workerScene();
    const rows = [];
    let y = 20;
    const pairs = [];
    for (const [label, shouldAttack] of Object.entries(ATTACKS)) {
        const dx = Number(label);
        // 原生坐标 + 镜像坐标成对布置：镜像侧 dx = (W − x) − (W − x − dx) 的浮点结果与原生不同。
        pairs.push({ dx, mirror: false, worker: addUnit(scene, 'red', 'worker', 40, y), label, shouldAttack });
        pairs.push({ dx, mirror: true, worker: addUnit(scene, 'red', 'worker', 220, y + 4), label, shouldAttack });
        rows.push(y);
        y += 12;
    }
    const enemies = pairs.map(p => p.mirror
        ? addUnit(scene, 'blue', 'archer', 220 - p.dx, p.worker.gy)
        : addUnit(scene, 'blue', 'archer', 40 + p.dx, p.worker.gy));
    const before = enemies.map(e => e.hp);
    const startX = pairs.map(p => p.worker.gx), startY = pairs.map(p => p.worker.gy);
    driveMany(scene, pairs.map(p => p.worker), 2000);      // 覆盖一个完整冷却，出手与否都见分晓

    pairs.forEach((pair, i) => {
        const dealt = before[i] - enemies[i].hp;
        const where = `${pair.label} 格·${pair.mirror ? '镜像侧' : '原生侧'}`;
        if (pair.shouldAttack) {
            assert.equal(dealt, 18, `${where}：两击共 18 伤害（12−3 护甲 × 2，冷却 1.4s）`);
            assert.equal(workerConstructionPaused(pair.worker, scene.simulationTime), true, `${where}：交战停工`);
        } else {
            assert.equal(dealt, 0, `${where}：不出手`);
            assert.equal(workerMeleeTarget(scene, pair.worker), null, `${where}：不锁定目标`);
            assert.equal(workerConstructionPaused(pair.worker, scene.simulationTime), false, `${where}：不停工`);
        }
        assert.equal(pair.worker.gx, startX[i], `${where}：不追击（x 不动）`);
        assert.equal(pair.worker.gy, startY[i], `${where}：不追击（y 不动）`);
    });
    resetBoardSize();
});

test('脱战续工在量化边界上成立：0.915 交战停工、敌人撤离后从原进度继续', () => {
    const scene = workerScene();
    scene.territory.econ.treasury.red = 1000;
    const site = 0;
    const worker = addUnit(scene, 'red', 'worker', 40, 40);
    assert.equal(scene.territory.camps.requestBuild('red', worker.id, 'camp', site), true);
    const building = scene.territory.camps.getBuilding(`camp:red:${site}`);
    worker.gx = building.gx; worker.gy = building.gy;
    scene.territory.camps.update(STEP_MS / 1000);
    const base = building.progress;
    assert.ok(base > 0, '无敌人时正常施工');

    // 敌人贴到量化接受带内沿（0.915，桶边界情形）：停工 + 还手。
    const enemy = addUnit(scene, 'blue', 'archer', worker.gx + 0.915, worker.gy);
    scene.rebuildSpatial();
    const startX = worker.gx;
    for (let i = 0; i < 60; i++) {
        scene.simulationTime += STEP_MS;
        scene.rebuildSpatial();
        scene.territory.camps.updateUnit(worker, scene.simulationTime, STEP_MS / 1000);
        scene.flushBattleActions();
        scene.territory.camps.update(STEP_MS / 1000);
    }
    assert.equal(building.paused, true, '量化接受带内的敌人触发停工');
    assert.equal(building.progress, base, '停工期间进度冻结');
    assert.ok(enemy.hp < enemy.maxHp, '民夫在 0.915 距离真实还手');
    assert.equal(worker.gx, startX, '交战不被引离工地');

    // 敌人远撤：回滞窗口过后脱战续工，进度不重置。
    enemy.gx = worker.gx + 8;
    scene.rebuildSpatial();
    for (let i = 0; i < 45; i++) {
        scene.simulationTime += STEP_MS;
        scene.rebuildSpatial();
        scene.territory.camps.updateUnit(worker, scene.simulationTime, STEP_MS / 1000);
        scene.flushBattleActions();
        scene.territory.camps.update(STEP_MS / 1000);
    }
    assert.equal(building.paused, false, '脱战后恢复施工');
    assert.ok(building.progress > base, '从原进度继续推进');
    assert.equal(worker.workerTask?.kind, 'build', '原施工任务保留');
    resetBoardSize();
});
