// ==================== 战斗核编排（纯模拟；渲染经场景钩子回调） ====================
// 从 game.js IsoBattleScene 抽出（第 0 批地基 0.5 收尾）。
// 本模块是每帧战斗的编排入口：固定步长推进、帧首快照、规划→位移→结算流水线、
// 战斗动作队列与枪阵迎击（brace）候选队列。
// 铁律：本文件不得 import Phaser、不得创建/触碰任何渲染对象；需要出表现的地方
// 一律调用 scene 上注入的钩子（playAttackAnim / meleeImpact / updateArrows 等）。

import { Terrain } from '../terrain.js';
import { CombatRules } from '../combat.js';
import { updatePikeBrace, applyDamage, resolveAttack, moveToward } from '../units.js';
import { board } from '../board.js';

export const SIMULATION_STEP_MS = 1000 / 60;

// 定时战斗动作（如骑兵冲锋后摇）：跨步排队，按到时序执行；跨场（battleId 不符）作废。
// 存储契约：scene.battleQueue 是普通数组（tests 直接 push/读 length），元素
// { atMs, battleId, callback }；队列逻辑在本模块，数据归场景。
export function scheduleBattleAction(scene, delayMs, callback) {
    scene.battleQueue.push({ atMs: scene.simulationTime + delayMs, battleId: scene.battleId, callback });
}

export function flushBattleActions(scene) {
    const now = scene.simulationTime, battleId = scene.battleId;
    const ready = [], pending = [];
    for (const action of scene.battleQueue) {
        (action.atMs <= now + 1e-7 ? ready : pending).push(action);
    }
    scene.battleQueue = pending;
    ready.sort((a, b) => a.atMs - b.atMs);
    for (const action of ready) {
        if (action.battleId === battleId) action.callback();
    }
}

// 枪阵迎击候选：每步先清空，规划期内每个长枪手只保留最近（平局 id 小）的冲锋骑，
// 位移结算后统一判定弹道并结算——保证"同刻将阵亡的枪兵仍能迎击"。
export class BraceQueue {
    constructor() { this.candidates = new Map(); }

    clear() { this.candidates.clear(); }

    queue(guard, cavalry) {
        const distance = Math.hypot(guard.gx - cavalry.gx, guard.gy - cavalry.gy);
        const current = this.candidates.get(guard);
        if (!current || distance < current.distance - 1e-9 ||
            (Math.abs(distance - current.distance) <= 1e-9 && cavalry.id < current.cavalry.id)) {
            this.candidates.set(guard, { cavalry, distance });
        }
    }

    // resolveHook(scene, guard, cavalry)：场景提供表现侧钩子（动画/打击感/战报）
    flush(resolveHook) {
        for (const [guard, { cavalry }] of this.candidates) resolveHook(guard, cavalry);
        this.candidates.clear();
    }
}

// 定步长推进：1x/2x 执行相同战斗步骤（确定性要求，见 docs/DETERMINISM.md）
export function advanceBattle(scene, delta) {
    if (!scene.battleStarted || scene.paused || scene.battleOver) return;
    scene.simulationAccumulator += Math.max(0, Math.min(delta, 50)) * scene.gameSpeed;
    while (scene.simulationAccumulator + 1e-7 >= SIMULATION_STEP_MS && !scene.battleOver) {
        scene.simulationAccumulator = Math.max(0, scene.simulationAccumulator - SIMULATION_STEP_MS);
        scene.simulationTime += SIMULATION_STEP_MS;
        stepBattle(scene, SIMULATION_STEP_MS / 1000);
    }
}

// 单个固定步：先选行动（读帧首快照），再统一位移，最后批量结算命中/迎击/士气。
// scene 钩子：rebuildSpatial / ensureNavigation / updateRoutedUnit / updateFallingBackUnit /
//   separate / updateArrows / updateFlags / updateConvoy / withdrawUnit / checkWin /
//   resolveBraceHook（scene.resolveBrace）
export function stepBattle(scene, dt) {
    const now = scene.simulationTime;
    scene.braceQueue.clear();
    scene.rebuildSpatial();
    const units = scene._aliveArr;
    scene.bodyContactDistance = CombatRules.maxContactDistance(units);
    if (Terrain.hasBarriers(scene.battleOptions.terrain)) scene.ensureNavigation().beginStep(now, units);

    // 帧首：先用上一帧位移估计速度，再刷新快照（供箭矢预判）
    for (let i = 0; i < units.length; i++) {
        const unit = units[i];
        if (unit.pgx !== undefined) {
            unit.velX = (unit.gx - unit.pgx) / dt;
            unit.velY = (unit.gy - unit.pgy) / dt;
        }
        unit.pgx = unit.gx; unit.pgy = unit.gy;
        unit.moveX = 0; unit.moveY = 0;
        unit.pushX = 0; unit.pushY = 0;
        // 冲锋视图快照：规划循环内单位按数组顺序更新，后手会读到先手刚写的新值——
        // 红蓝座位数组顺序相反，读"新鲜/陈旧"不一致即破坏换座对称。统一读帧首快照。
        if (unit.type === 'cavalry') {
            unit.chargeViewX = unit.chargeDX;
            unit.chargeViewY = unit.chargeDY;
            unit.chargeViewState = unit.state;
        }
        // 矛兵 moving 同理：该标记在规划循环内按各单位自己的回合刷新，
        // 骑兵读矛簇 moving 判墙时先手读旧值、后手读新值——统一读帧首快照。
        if (unit.type === 'pikeman') unit.pikeViewMoving = unit.moving;
    }
    for (const unit of units) if (unit.type === 'pikeman' && unit.tacticalRole !== 'guard') updatePikeBrace(unit, dt);
    if (scene.tactics) scene.tactics.beginStep(dt);
    scene.morale.beginStep(dt);
    scene.collectingImpacts = true;
    scene.planningStep = true;
    if (!scene.resolvingOutcome) flushBattleActions(scene);

    for (let i = 0; i < units.length; i++) {
        const unit = units[i];
        if (unit.dead || unit.withdrawn) continue;
        unit.moving = false;
        unit.pressX = 0; unit.pressY = 0;
        if (scene.resolvingOutcome) continue;
        if (unit.moraleState === 'routing') { scene.updateRoutedUnit(unit, dt); continue; }
        if (scene.updateFallingBackUnit(unit, now, dt)) continue;
        if (scene.tactics?.updateGroundGuard(unit, now, dt)) continue;
        if (unit.type === 'cavalry') {
            // 营队接管（可选场景钩子，仅领土征服）：集结/回防/有令时骑兵与全营
            // 同目标行军，不再单骑冲阵；贴脸有敌（钩子返回 null）才交还冲锋状态机。
            const rally = scene.battalionDirectCavalry?.(unit);
            if (rally) {
                moveToward(unit, rally.gx, rally.gy, unit.typeData.speed, dt);
                continue;
            }
            if (scene.cavalryAI.update(unit, now, dt)) continue;
        }
        if (scene.tactics && scene.tactics.updateUnit(unit, now, dt)) continue;
        scene.updateNormalUnit(unit, now, dt);
    }
    scene.planningStep = false;
    for (const unit of units) {
        const motion = Terrain.clipMotion(scene.battleOptions.terrain, unit.gx, unit.gy,
            unit.moveX + unit.pushX, unit.moveY + unit.pushY, CombatRules.bodyRadius(unit));
        unit.gx += motion.x;
        unit.gy += motion.y;
    }
    scene.rebuildSpatial();
    scene.separate(dt);
    scene.rebuildSpatial();
    scene.updateArrows(dt, now);
    scene.braceQueue.flush((guard, cavalry) => scene.resolveBrace(guard, cavalry));
    scene.flushBattleImpacts();
    scene.morale.update(dt);
    if (scene.battleOptions.control) scene.updateFlags(dt);
    else if (scene.battleOptions.territory) scene.updateTerritory(dt);
    if (scene.battleOptions.convoy) scene.updateConvoy(dt);
    for (const unit of units) {
        if (!scene.battleOptions.deathmatch && !unit.dead && !unit.withdrawn && unit.moraleState === 'routing' &&
            (unit.gx <= 0.61 || unit.gx >= board.W - 0.61 || unit.gy <= 0.61 || unit.gy >= board.H - 0.61)) scene.withdrawUnit(unit);
    }
    if (scene.simulationTime - (scene._lastMoraleUI || 0) >= 250) {
        scene._lastMoraleUI = scene.simulationTime; scene._countsDirty = true;
    }
    scene.checkWin();

    // 阵亡单位周期压实，数组不无限膨胀
    scene._compactTick = (scene._compactTick || 0) + 1;
    if (scene._compactTick % 240 === 0) {
        scene.units = scene.units.filter(u => !u.dead && !u.withdrawn);
    }
}

// 批量命中结算：同一步已成立的命中全部生效，攻击者在此批中阵亡也不会抹掉其攻击。
export function flushBattleImpacts(scene) {
    scene.collectingImpacts = false;
    const impacts = scene.battleImpacts;
    scene.battleImpacts = [];
    for (const { target, damage, from, attackStartedAt } of impacts) applyDamage(target, damage, from, attackStartedAt);
}

// 迎击结算：弹道被地形遮挡则落空；迎击倍率与反骑倍率各一次。
// 表现（动画/打击感/战报）经场景钩子，本文件不出任何表现。
export function resolveBrace(scene, guard, cavalry) {
    if (!Terrain.segmentClear(scene.battleOptions.terrain, guard.gx, guard.gy, cavalry.gx, cavalry.gy)) return;
    resolveAttack(cavalry, guard, { multiplier: 1.5 });
    guard.lastBrace = scene.simulationTime;
    scene.playAttackAnim(guard, cavalry);
    scene.meleeImpact(guard, cavalry, 'thrust');   // 迎击是枪刺，不走斩弧
    scene.addBattleEvent(`brace-${guard.team}`, `${guard.team === 'red' ? '红方' : '蓝方'}正面枪阵迎击骑兵冲锋`, guard.team);
}
