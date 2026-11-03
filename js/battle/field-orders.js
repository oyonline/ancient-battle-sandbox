// 非领土全军命令：只读模拟时间，命令在锁步回合边界执行。
import { CombatRules } from '../combat.js';
import { Terrain } from '../terrain.js';
import { dist, moveToward } from '../units.js';
import { TacticsSystem } from '../tactics.js';
import { DECISION_QUANTUM, quantizeDecision } from './determinism.js';

export const FIELD_ORDER_RADIUS = 2.5;
const radiusFor = unit => unit.type === 'archer'
    ? Math.max(FIELD_ORDER_RADIUS, unit.typeData.range) : FIELD_ORDER_RADIUS;
const q = quantizeDecision;

// true 仅表示本回合发生了状态切换；重复命令不释放角色、不重拍锚点。
export function applyFieldOrder(scene, command) {
    if (scene.territory || scene.battleOptions?.coop || command?.k !== 'fieldOrder' ||
        !['red', 'blue'].includes(command.side) || !['advance', 'hold'].includes(command.order)) return false;
    const { side, order } = command;
    if (scene.fieldOrders?.[side] === order) return false;
    if (order === 'hold') scene.tactics ??= new TacticsSystem(scene, {}, { deploy: false });
    scene.tactics?.releaseSide(side);
    scene.fieldOrders ??= { red: null, blue: null };
    scene.fieldOrders[side] = order;
    for (const unit of scene.units) {
        if (unit.team !== side || unit.dead || unit.withdrawn) continue;
        if (order === 'hold') {
            if (unit.type === 'cavalry') scene.cavalryAI.enterMelee(unit);
            unit.fieldOrderAnchor = {
                gx: Math.round(unit.gx * 1e4) / 1e4, gy: Math.round(unit.gy * 1e4) / 1e4
            };
        }
        else delete unit.fieldOrderAnchor;
    }
    return true;
}

// 弓手沿用拉弓→延时放箭→原箭矢结算；近战沿用统一 fight/攻击链。
function fight(scene, unit, target, now, dt) {
    const reach = unit.typeData.ranged
        ? Terrain.rangedRange(scene.battleOptions.terrain, unit, target) : unit.typeData.range;
    if (q(dist(unit, target)) > q(reach) || (!unit.typeData.ranged &&
        !Terrain.segmentClear(scene.battleOptions.terrain, unit.gx, unit.gy, target.gx, target.gy, 0))) {
        moveToward(unit, target.gx, target.gy, unit.typeData.speed, dt);
    } else if (!unit.typeData.ranged) {
        CombatRules.attack(scene, unit, target, now, reach, 0.025);
    } else if (now - unit.lastAttack > unit.typeData.atkSpeed) {
        unit.lastAttack = now;
        scene.playAttackAnim(unit, target);
        const epoch = unit.actionEpoch;
        scene.scheduleBattleAction(110, () => {
            if (!CombatRules.canAct(unit) || !CombatRules.canBeHit(target) || scene.battleOver ||
                unit.actionEpoch !== epoch || q(dist(unit, target)) > q(Terrain.rangedRange(scene.battleOptions.terrain, unit, target))) return;
            scene.fireArrow(unit, target);
        });
    }
}

export function updateFieldOrder(scene, unit, now, dt) {
    if (scene.territory || scene.battleOptions?.coop || scene.fieldOrders?.[unit.team] !== 'hold' ||
        !unit.fieldOrderAnchor || unit.moraleState === 'routing') return false;
    const anchor = unit.fieldOrderAnchor, radius = radiusFor(unit);
    const fromAnchor = q(dist(unit, anchor));
    let target = null, nearest = Infinity;
    // 原判定接受 radius 外半个量子内的距离；查询须覆盖这段再按原条件筛选。
    if (fromAnchor <= q(radius + 1)) scene.forEachNear(anchor.gx, anchor.gy, radius + DECISION_QUANTUM / 2, enemy => {
        if (enemy.team === unit.team || !CombatRules.canBeHit(enemy) || q(dist(anchor, enemy)) > q(radius)) return;
        const distance = q(dist(unit, enemy));
        if (distance < nearest || (distance === nearest && enemy.id < target.id)) {
            target = enemy; nearest = distance;
        }
    });
    unit.target = target;
    if (target) fight(scene, unit, target, now, dt);
    else if (fromAnchor > q(0.3)) moveToward(unit, anchor.gx, anchor.gy, unit.typeData.speed, dt);
    return true;
}

// 位移/挤压后限制从圈内出发的单位；已在圈外的重整溃兵仍逐步走回，不瞬移。
export function boundFieldOrders(scene) {
    if (scene.territory || scene.battleOptions?.coop || !scene.fieldOrders) return;
    for (const unit of scene.units) {
        const anchor = unit.fieldOrderAnchor;
        if (scene.fieldOrders[unit.team] !== 'hold' || !anchor || unit.dead || unit.withdrawn ||
            unit.moraleState === 'routing') continue;
        const limit = radiusFor(unit) + 1, distance = dist(unit, anchor);
        if (distance <= limit || Math.hypot(unit.pgx - anchor.gx, unit.pgy - anchor.gy) > limit) continue;
        // 连续几何裁剪不量化坐标，避免把镜像浮点噪声放大成离散步长。
        unit.gx = anchor.gx + (unit.gx - anchor.gx) * limit / distance;
        unit.gy = anchor.gy + (unit.gy - anchor.gy) * limit / distance;
        unit.target = null;
    }
}
