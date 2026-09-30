// 受阻接战：当前目标被友军挡住枪线时，能在有限时间内换可打目标或挪到合法出枪位。
// 复现案例（任务书）：红枪兵 (30,30)、红剑士阻挡 (30.65,30)、蓝当前目标 (31.3,30)、
// 蓝另一目标 (30,31.2)。修复前：攻击队列为空、计划位移为零，红枪兵永久罚站。
// 全量模拟里蓝军自己会逼近解开僵局，故核心复现采用冻结环境、单驱动红枪兵：
// 环境静止时修复前永久无动作，修复后必须在明确时限内自行解困。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CombatRules } from '../js/combat.js';
import { flushBattleActions } from '../js/battle/core.js';
import { makeScene, addUnit } from './battle-harness.js';

const STEP = 1000 / 60;

// 场景布置：红枪兵被己方剑士挡住对蓝A的枪线；蓝B 在侧翼可直接打到。
function blockedScene({ withBlocker = true, withBlueB = true } = {}) {
    const scene = makeScene();
    const pike = addUnit(scene, 'red', 'pikeman', 30, 30);
    if (withBlocker) addUnit(scene, 'red', 'infantry', 30.65, 30);
    const blueA = addUnit(scene, 'blue', 'infantry', 31.3, 30);
    const blueB = withBlueB ? addUnit(scene, 'blue', 'infantry', 30, 31.2) : null;
    scene.rebuildSpatial();
    pike.meleeTarget = blueA;   // 任务书：meleeTarget 指向第一个蓝兵
    return { scene, pike, blueA, blueB };
}

// 记录红枪兵真实落地的近战打击（meleeImpact 在命中帧结算时被调用）
function trackStrikes(scene, pike) {
    const strikes = [];
    scene.meleeImpact = (from, target) => {
        if (from === pike) strikes.push({ at: scene.simulationTime, target, pikeX: pike.gx, pikeY: pike.gy });
    };
    return strikes;
}

// 冻结环境驱动：只有红枪兵行动，其余单位静止。
// dt 用秒（与 stepBattle 的 SIMULATION_STEP_MS/1000 一致），位移后刷新空间索引
// （clearLane/占位检查都走 forEachNear，陈旧索引会误判）。
// 时钟从 scene.simulationTime 续跑：多次调用组成连续时间线（冷却/阈值不重置）。
function drivePike(scene, pike, frames, onEach) {
    let now = scene.simulationTime || 0;
    for (let i = 0; i < frames; i++) {
        scene.simulationTime = now;
        scene.updateNormalUnit(pike, now, STEP / 1000);
        flushBattleActions(scene);
        scene.rebuildSpatial();
        if (onEach?.(now, i) === true) break;
        now += STEP;
    }
    scene.simulationTime = now;
    return now;
}

// 每次落地打击发生时枪线必须合法（友军阻挡规则未被绕过）
function assertAllStrikesLegal(scene, strikes, pike) {
    for (const s of strikes) {
        assert.ok(CombatRules.clearLane(scene, { ...pike, gx: s.pikeX, gy: s.pikeY }, s.target),
            `打击发生时枪线必须合法（at=${s.at.toFixed(0)}ms）`);
    }
}

test('前置：友军挡枪线时 canStrike 拒绝（阻挡规则成立）', () => {
    const { scene, pike, blueA, blueB } = blockedScene();
    assert.equal(CombatRules.canStrike(scene, pike, blueA, pike.typeData.range), false,
        '剑士在枪线上，蓝A 打不到');
    assert.equal(CombatRules.canStrike(scene, pike, blueB, pike.typeData.range), true,
        '侧翼蓝B 可以直接打到');
});

test('复现：环境静止时受阻枪兵应在明确时限内自行解困（失败路径回归）', () => {
    const { scene, pike, blueA, blueB } = blockedScene();
    const strikes = trackStrikes(scene, pike);
    const startX = pike.gx, startY = pike.gy;
    const endedAt = drivePike(scene, pike, 60 * 4, () => strikes.length > 0);
    assert.ok(strikes.length, '4 秒模拟内红枪兵必须完成一次落地打击');
    assert.ok(endedAt <= 4000, `应在明确时限内重新行动，实际 ${endedAt.toFixed(0)}ms`);
    assertAllStrikesLegal(scene, strikes, pike);
    // 换目标或挪位二者必有其一：要么目标不再是蓝A，要么离开原地找角度
    assert.ok(pike.meleeTarget !== blueA || Math.hypot(pike.gx - startX, pike.gy - startY) > 0.3,
        '应重选可打目标或寻找合法接战位');
    assert.ok(blueB, '场景完整性');
});

test('受阻接战：唯一目标被挡时仍不穿友军，靠挪位解困', () => {
    const { scene, pike, blueA } = blockedScene({ withBlueB: false });
    const strikes = trackStrikes(scene, pike);
    drivePike(scene, pike, 60 * 6, () => strikes.length > 0);
    assert.ok(strikes.length, '6 秒内应通过挪位重新接到唯一目标');
    assertAllStrikesLegal(scene, strikes, pike);
    assert.equal(strikes[0].target, blueA, '唯一目标场景下打回来的还是原目标');
});

test('正常接战：无阻挡时目标保持粘滞、不误切换（正常路径回归）', () => {
    const { scene, pike, blueA, blueB } = blockedScene({ withBlocker: false });
    const strikes = trackStrikes(scene, pike);
    drivePike(scene, pike, 60 * 3);
    assert.ok(strikes.length, '无阻挡时正常输出');
    assert.equal(pike.meleeTarget, blueA, '可打的当前目标不得被无谓切走（目标粘滞）');
    assert.ok(strikes.every(s => s.target === blueA), '粘滞期间只打当前目标');
    assert.ok(!blueB.dead && blueB.hp === blueB.maxHp, '蓝B 不被集火（粘滞在蓝A）');
});

test('正常接战：架枪纪律不受受阻处理影响', () => {
    // 架枪中的枪兵（braceHold）被挡时不挪窝（架枪优先于找角度）。
    // （全量步进里 updatePikeBrace 会按现场重建 braceHold，故此处单步驱动以隔离变量。）
    const { scene, pike } = blockedScene({ withBlueB: false });
    pike.braceHold = true;
    pike.braceReady = true;
    pike.braceSupport = 2;
    const startX = pike.gx, startY = pike.gy;
    drivePike(scene, pike, 60 * 2);
    assert.ok(Math.hypot(pike.gx - startX, pike.gy - startY) < 0.05,
        '架枪中的枪兵不得因受阻处理挪窝');
    assert.equal(pike.braceHold, true, '架枪状态不被清除');
});

test('候选位枪线判定与实际站位判定一致（clearLane 原点统一）', () => {
    // 受阻换位的前提是"从候选位出枪合法"：若候选判定与单位真正站过去的判定不一致，
    // 士兵会挪到打不出去的位置。对一组阻挡体布局逐一验证等价性。
    for (const [bx, by] of [[31.5, 30.3], [31.5, 30.36], [31.2, 29.7], [30.4, 30.2], [32.2, 30.42], [31.8, 29.66]]) {
        const scene = makeScene();
        const unit = addUnit(scene, 'red', 'infantry', 30, 30);
        const blocker = addUnit(scene, 'red', 'infantry', bx, by);
        const target = addUnit(scene, 'blue', 'infantry', 33, 30);
        const sx = 30, sy = 31.5;   // 候选接战位
        scene.rebuildSpatial();
        const fromCandidate = CombatRules.clearLane(scene, unit, target, undefined, sx, sy);
        const stood = { ...unit, gx: sx, gy: sy };
        const fromStood = CombatRules.clearLane(scene, stood, target);
        assert.equal(fromCandidate, fromStood,
            `阻挡(${bx},${by})下候选位判定(${fromCandidate})应与实际站位判定(${fromStood})一致`);
        blocker.gx = bx; blocker.gy = by;   // 防御性：保持现场
    }
});

test('回避重估：旧敌阻挡解除且重新可打时，不再追远处目标（P2 回归）', () => {
    const { scene, pike, blueA, blueB } = blockedScene();
    const strikes = trackStrikes(scene, pike);
    // 阶段一：受阻 → 换到蓝B（回避蓝A）
    drivePike(scene, pike, 60 * 2, () => strikes.length > 0);
    assert.ok(strikes.length, '先完成对蓝B的换目标打击');
    assert.equal(pike.meleeTarget, blueB, '受阻期目标应为蓝B');
    // 阶段二：蓝B 撤到 15 格外，阻挡剑士离场（蓝A 阻挡解除、1.3 格在射程内）
    scene.units.splice(scene.units.findIndex(u => u.gx === 30.65 && u.gy === 30 && u.team === 'red'), 1);
    blueB.gx = 15; blueB.gy = 31.2;
    scene.rebuildSpatial();
    assert.equal(CombatRules.canStrike(scene, pike, blueA, pike.typeData.range), true, '蓝A 应已可打');
    // 阶段三：回避随可接战性重估而失效，立刻（≤200ms）切回蓝A；
    // 打击受枪兵天然攻击冷却限制，应在冷却就绪后立即落到蓝A 身上
    drivePike(scene, pike, 12);   // 200ms 内不追远处目标
    assert.equal(pike.meleeTarget, blueA, '旧敌重新可打时应立刻切回，不追 15 格外的蓝B');
    const readyAt = pike.lastAttack + pike.typeData.atkSpeed;   // 阶段一打击的冷却终点
    const strikesBefore = strikes.length;
    const endedAt = drivePike(scene, pike, 60 * 4, () => strikes.length > strikesBefore);
    assert.ok(strikes.length > strikesBefore, '切回后应在冷却就绪时立即输出');
    assert.equal(strikes[strikes.length - 1].target, blueA);
    assert.ok(endedAt <= readyAt + 500, `打击应只等攻击冷却(至 ${readyAt.toFixed(0)}ms)，实际 ${endedAt.toFixed(0)}ms`);
});

test('受阻计时随脱离接战清零：离开射程再回来重新累计（P3 回归）', () => {
    const { scene, pike, blueA, blueB } = blockedScene();
    pike.typeData = { ...pike.typeData, speed: 0 };   // 冻结位移，隔离时间变量
    // 阶段一：受阻累计 500ms（< 800ms 阈值，未解困）
    drivePike(scene, pike, 30);
    assert.equal(pike.meleeTarget, blueA, '未达阈值不换目标');
    assert.ok(pike.blockedEngageAt != null, '受阻计时应在累计');
    // 阶段二：两蓝撤远（蓝A 出射程 → 逼近分支；蓝B 撤离避免粘滞切换），
    // 单位脱离接战，受阻计时必须清零
    blueA.gx = 36; blueB.gx = 15;
    scene.rebuildSpatial();
    drivePike(scene, pike, 60);
    assert.equal(pike.blockedEngageAt, null, '脱离接战后受阻计时必须清零');
    // 阶段三：两蓝回到原位重新受阻——从零累计，500ms 内不得换目标
    blueA.gx = 31.3; blueB.gx = 30;
    scene.rebuildSpatial();
    drivePike(scene, pike, 30);
    assert.equal(pike.meleeTarget, blueA, '回来后 500ms 内不得沿用旧时间戳直接换目标');
    // 阶段四：累计满 800ms 后正常解困（换到可打的蓝B）
    drivePike(scene, pike, 60 * 2, () => pike.meleeTarget !== blueA);
    assert.equal(pike.meleeTarget, blueB, '持续受阻达阈值后应换到可打目标');
});

test('集成：全量模拟中受阻案例照常解困且打击全部合法', () => {
    const { scene, pike } = blockedScene();
    const strikes = trackStrikes(scene, pike);
    for (let i = 0; i < 60 * 4 && !strikes.length; i++) scene.advanceBattle(STEP);
    assert.ok(strikes.length, '全量模拟 4 秒内应完成落地打击');
    assertAllStrikesLegal(scene, strikes, pike);
});
