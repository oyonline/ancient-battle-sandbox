// ==================== 索敌决策（纯模拟，不碰渲染） ====================
// 从 game.js IsoBattleScene 抽出（第 0 批地基 3/4）。
// 全部为纯函数：输入空间索引与单位状态，输出目标；不改单位字段以外的任何场景状态。

import { board } from '../board.js';
import { dist } from '../units.js';
import { CombatRules } from '../combat.js';

// 最近敌人：环形扩张搜索；查到半径 r 内的最佳解即全局最近（圆内 ⊆ 查询方形）。
// 辎重车不可被攻击（劫持玩法）：战斗围绕车身控制权，不围绕拆车——
// 劫掠方的得分手段是把车"劫走"（updateConvoy 的拔河），不是把车砍烂。
// 平局按 id 最小决胜，保证两座位选择一致（docs/DETERMINISM.md）。
export function nearestEnemy(spatial, unit) {
    let best = null, bestD2 = Infinity, r = 6;
    const maxR = board.W + board.H;
    while (true) {
        const visit = e => {
            if (e.team === unit.team || e.dead || e.withdrawn || e.type === 'wagon') return;
            const dx = e.gx - unit.gx, dy = e.gy - unit.gy;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2 - 1e-9 || (Math.abs(d2 - bestD2) <= 1e-9 && (!best || e.id < best.id))) { bestD2 = d2; best = e; }
        };
        if (spatial.forEachEnemyNear) spatial.forEachEnemyNear(unit, r, visit);
        else spatial.forEachNear(unit.gx, unit.gy, r, visit);
        if (best && bestD2 <= r * r) return best;
        // Across the large territory map, expanding to hundreds of cells visits
        // tens of thousands of empty buckets per soldier. An exact scan of the
        // bounded alive list is cheaper once the nearby circles found no answer.
        // It uses the same distance/id ordering, so this changes work, not targets.
        if (r >= 24 && Array.isArray(spatial.alive)) {
            if (unit.scene?.planningStep && spatial.nearestGroundEnemy) {
                return spatial.nearestGroundEnemy(unit, best, bestD2);
            }
            for (const e of spatial.alive) {
                if (e.team === unit.team || e.dead || e.withdrawn || e.garrisonTowerId || e.type === 'wagon') continue;
                const dx = e.gx - unit.gx, dy = e.gy - unit.gy, d2 = dx * dx + dy * dy;
                if (d2 < bestD2 - 1e-9 || (Math.abs(d2 - bestD2) <= 1e-9 && (!best || e.id < best.id))) {
                    bestD2 = d2; best = e;
                }
            }
            return best;
        }
        if (r >= maxR) return best;
        r *= 2;
    }
}

// 目标粘滞：换目标需要新目标显著更优（近 20%+）或当前目标倒下，消除等距敌人间的来回抖动。
// 溃逃中的敌人仍是合法目标（追击规则维持现状），只治"选谁"，不改"打不打"。
// 受阻接战的回避目标（avoidTargetId，见 unit-ai 受阻接战处理）按现场实时重估：
// - 旧敌仍是最近敌且仍打不出去 → 保持新目标（防翻回打不出去的旧敌）；
// - 旧敌重新打得着（阻挡解除/回到射程）→ 回避失效，正常粘滞接管；
// - 新目标已离开有效接战范围 → 强制安排整体作废，回到正常粘滞（旧敌仍受阻
//   会再次触发受阻解困，重新挑身边可打的目标），不追远处目标忽略身边之敌。
export function stickyTarget(spatial, unit) {
    const nearest = nearestEnemy(spatial, unit);
    const current = unit.meleeTarget;
    if (current && !current.dead && !current.withdrawn && nearest &&
        nearest.id === unit.avoidTargetId && (unit.avoidUntil ?? 0) > (unit.scene?.simulationTime ?? 0)) {
        if (unit.scene && CombatRules.canStrike(unit.scene, unit, nearest, unit.typeData.range)) {
            unit.avoidTargetId = null;   // 旧敌重新打得着：回避失效，落入正常粘滞
        } else if (dist(unit, current) > unit.typeData.range) {
            // 新目标已出接战范围：强制换目标的安排失效，正常粘滞重选
            unit.avoidTargetId = null;
            unit.meleeTarget = null;
        } else return current;   // 旧敌仍受阻且新目标仍在射程内：保持新目标
    }
    if (!current || current.dead || current.withdrawn || current === nearest) {
        unit.meleeTarget = nearest;
        return nearest;
    }
    if (!nearest) return current;
    const dc = dist(unit, current), dn = dist(unit, nearest);
    if (dn < dc * 0.8) { unit.meleeTarget = nearest; return nearest; }
    return current;
}

// 遇骑结阵的探测器：半径内朝本队冲锋（含穿刺）且弹道指向 ±60° 扇区内的敌骑，取 id 最小者决胜。
// 读帧首冲锋视图快照（chargeView*），保证换座对称——见 stepBattle 帧首注释。
export function incomingCharge(spatial, unit, radius) {
    let threat = null;
    spatial.forEachNear(unit.gx, unit.gy, radius, e => {
        if (e.team === unit.team || e.dead || e.withdrawn || e.type !== 'cavalry') return;
        const view = e.chargeViewState;
        if (view !== 'charge' && view !== 'pierce') return;
        const dx = unit.gx - e.gx, dy = unit.gy - e.gy, d = Math.hypot(dx, dy);
        if (d > radius || d < 0.05) return;
        if ((e.chargeViewX ?? 0) * dx + (e.chargeViewY ?? 0) * dy < d * 0.5) return;
        if (!threat || e.id < threat.id) threat = e;
    });
    return threat;
}
