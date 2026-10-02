// ==================== 民夫自卫（纯模拟，不碰渲染） ====================
// 民夫获得有限近战自卫：只打"已经贴到近战范围内"的敌人，不主动寻找远方目标、
// 不追击、不参与营队冲锋。保留原移动 / 施工任务：近身交战时暂停施工进度，
// 脱离交战后继续原任务；不能一边攻击一边推进施工。
//
// 出手复用既有链路：CombatRules.attack → 动画钩子 → scheduleBattleAction(95)
// → resolveAttack → applyDamage（护甲 / 地形 / 伤害队列 / 士气全线一致），
// 因此不需要任何民夫专用的伤害或命中规则。
//
// 确定性：无随机数；目标选择"距离优先、平局 id 小者"；距离阈值先量化
// （docs/DETERMINISM.md），红蓝换座镜像两侧行为一致。

import { CombatRules } from '../combat.js';
import { quantizeDecision as q, DECISION_QUANTUM } from './determinism.js';

export const WORKER_RULES = {
    // 交战回滞：出手在 95ms 后结算，加一点余量保证"最后一击"落账期间施工仍是停的。
    ENGAGE_HOLD_MS: 300,
    // 出手容差 = 决策量子的一半：选敌用量化距离（q(d) ≤ 射程 ⟺ d < 射程 + 0.025，
    // 半量子点 0.925 按四舍五入契约统一归属下一档），出手判定（CombatRules.canStrike
    // 用原始距离）带上同样的半量子，两条口径对齐。名义射程仍是 0.9：
    // 这只是让"量化后够得着"的目标不被浮点噪声卡掉，不放大有效射程的量级。
    STRIKE_TOLERANCE: DECISION_QUANTUM / 2
};

// 贴上来的敌军：只看近战范围内的活敌（溃逃中的敌人不构成威胁，不打断施工）。
// 候选查询半径必须覆盖【最终量化判定】可能接受的全部目标：接受带是
// q(d) ≤ 射程 ⟺ d < 射程 + 半量子（0.925），所以查 0.9 会把相邻空间桶里
// 0.915 的合法目标提前漏掉（一侧打得到、镜像侧打不到）。扩大候选查询
// 不等于扩大攻击范围——最终仍由量化距离阈值裁决。
export function workerMeleeTarget(scene, unit) {
    const reach = unit.typeData.range;
    const queryReach = reach + WORKER_RULES.STRIKE_TOLERANCE;
    let best = null, bestD = Infinity;
    scene.forEachNear(unit.gx, unit.gy, queryReach, other => {
        if (other === unit || other.team === unit.team) return;
        if (other.dead || other.withdrawn || other.hp <= 0 || other.isBuilding) return;
        if (other.type === 'wagon' || other.moraleState === 'routing') return;
        const distance = q(Math.hypot(other.gx - unit.gx, other.gy - unit.gy));
        if (distance > reach) return;
        if (distance < bestD - 1e-9 || (Math.abs(distance - bestD) <= 1e-9 && (!best || other.id < best.id))) {
            bestD = distance; best = other;
        }
    });
    return best;
}

// 每步调用：范围内有敌就地自卫（冷却就绪才真正出手），返回是否处于交战。
// 不产生任何位移——民夫不会被近处敌人从工地引开。
// 选敌与出手共用同一距离口径：量化比较选敌（下方 workerMeleeTarget），
// 出手把半量子容差传给 CombatRules.attack（canStrike 的原始距离比较），
// 因此"选中的目标一定能出手"，且镜像两侧在名义射程边界上判定一致。
export function updateWorkerCombat(scene, unit, now) {
    const target = workerMeleeTarget(scene, unit);
    if (!target) return false;
    unit.workerEngageAt = now;
    unit.target = target;
    unit.meleeTarget = target;
    if (now - unit.lastAttack >= unit.typeData.atkSpeed) {
        CombatRules.attack(scene, unit, target, now, unit.typeData.range, WORKER_RULES.STRIKE_TOLERANCE);
    }
    return true;
}

// 施工暂停判定：交战当帧 + 回滞窗口内都不推进进度。
// 入参可为空（施工者阵亡/被解绑时营寨循环仍会调用），空值一律视为"没人交战"。
export function workerConstructionPaused(unit, now) {
    return !!unit && unit.workerEngageAt != null &&
        now - unit.workerEngageAt <= WORKER_RULES.ENGAGE_HOLD_MS;
}
