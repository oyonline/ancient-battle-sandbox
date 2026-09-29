// ==================== 索敌决策（纯模拟，不碰渲染） ====================
// 从 game.js IsoBattleScene 抽出（第 0 批地基 3/4）。
// 全部为纯函数：输入空间索引与单位状态，输出目标；不改单位字段以外的任何场景状态。

import { GRID_W, GRID_H } from '../board.js';
import { dist } from '../units.js';

// 最近敌人：环形扩张搜索；查到半径 r 内的最佳解即全局最近（圆内 ⊆ 查询方形）。
// 辎重车不可被攻击（劫持玩法）：战斗围绕车身控制权，不围绕拆车——
// 劫掠方的得分手段是把车"劫走"（updateConvoy 的拔河），不是把车砍烂。
// 平局按 id 最小决胜，保证两座位选择一致（docs/DETERMINISM.md）。
export function nearestEnemy(spatial, unit) {
    let best = null, bestD2 = Infinity, r = 6;
    const maxR = GRID_W + GRID_H;
    while (true) {
        spatial.forEachNear(unit.gx, unit.gy, r, e => {
            if (e.team === unit.team || e.dead || e.withdrawn || e.type === 'wagon') return;
            const dx = e.gx - unit.gx, dy = e.gy - unit.gy;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2 - 1e-9 || (Math.abs(d2 - bestD2) <= 1e-9 && (!best || e.id < best.id))) { bestD2 = d2; best = e; }
        });
        if (best && bestD2 <= r * r) return best;
        if (r >= maxR) return best;
        r *= 2;
    }
}

// 目标粘滞：换目标需要新目标显著更优（近 20%+）或当前目标倒下，消除等距敌人间的来回抖动。
// 溃逃中的敌人仍是合法目标（追击规则维持现状），只治"选谁"，不改"打不打"。
export function stickyTarget(spatial, unit) {
    const nearest = nearestEnemy(spatial, unit);
    const current = unit.meleeTarget;
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
