// 指令决定去哪里、打谁；普通步行和近战共用这里的接触与命中规则。
// 骑兵冲锋/穿透、已离弦箭矢继续使用各自的接触处理和共同伤害队列。
import { Terrain } from './terrain.js';
import { dist, resolveAttack, knockback } from './units.js';

export const CombatRules = {
    canAct(unit) { return this.canBeHit(unit) && unit.moraleState !== 'routing'; },
    canBeHit(unit) { return !unit.dead && !unit.withdrawn && !unit.garrisonTowerId && unit.hp > 0; },
    bodyRadius(unit) { return unit.typeData.bodyRadius ?? 0.36; },
    contactDistance(a, b) { return this.bodyRadius(a) + this.bodyRadius(b); },
    maxContactDistance(units) {
        let radius = 0.36;
        for (const unit of units) radius = Math.max(radius, this.bodyRadius(unit));
        return radius * 2;
    },

    walkingSpeed(unit, speed) {
        return (unit.scene?.simulationTime ?? 0) < (unit.spearSlowUntil || 0) ? speed * 0.25 : speed;
    },

    constrainWalk(unit, mx, my) {
        const scene = unit.scene;
        if (!scene) return { x: mx, y: my };
        let blockX = 0, blockY = 0;
        const search = (scene.bodyContactDistance || 0.72) + 0.04;
        scene.forEachNear(unit.gx, unit.gy, search, other => {
            if (other === unit || !this.canBeHit(other)) return;
            // 友军给溃兵让路；最终身体分离仍生效，避免把撤退者永久封在己方队列中。
            if (unit.moraleState === 'routing' && other.team === unit.team) return;
            const dx = other.gx - unit.gx, dy = other.gy - unit.gy, distance = Math.hypot(dx, dy);
            if (distance < 0.001 || distance > this.contactDistance(unit, other) + 0.04) return;
            const nx = dx / distance, ny = dy / distance, inward = mx * nx + my * ny;
            if (inward > 0) { blockX += inward * nx; blockY += inward * ny; }
        });
        let x = mx - blockX, y = my - blockY;
        if (x * mx + y * my < 0) { x = 0; y = 0; }
        const length = Math.hypot(x, y), limit = Math.hypot(mx, my);
        if (length > limit && length > 0) { x *= limit / length; y *= limit / length; }
        return { x, y };
    },

    inFacing(unit, target) {
        const dx = target.gx - unit.gx, dy = target.gy - unit.gy, distance = Math.hypot(dx, dy);
        return distance < 0.001 || (dx * unit.guardFacingX + dy * unit.guardFacingY) / distance >= 0.55;
    },

    // fromX/fromY：枪线起点（默认单位当前位置）；受阻接战换位时从候选位预验枪线。
    clearLane(scene, unit, target, spear = unit.type === 'pikeman', fromX = unit.gx, fromY = unit.gy) {
        const terrain = scene.battleOptions?.terrain ?? unit.scene?.battleOptions?.terrain;
        if (!Terrain.segmentClear(terrain, fromX, fromY, target.gx, target.gy)) return false;
        const dx = target.gx - fromX, dy = target.gy - fromY, length2 = dx * dx + dy * dy;
        if (length2 < 0.0001) return true;
        let blocked = false, supporting = 0;
        scene.forEachNear(fromX, fromY, Math.sqrt(length2), other => {
            if (other === unit || other === target || !this.canBeHit(other)) return;
            const projection = ((other.gx - fromX) * dx + (other.gy - fromY) * dy) / length2;
            if (projection <= 0.08 || projection >= 0.92) return;
            // 投影与垂距都以同一原点（fromX/fromY）计算：候选位预验与实际站位
            // 判定才会一致，否则士兵会挪到打不出去的位置。
            const distance = Math.hypot(other.gx - fromX - projection * dx, other.gy - fromY - projection * dy);
            if (distance > this.bodyRadius(other) * (5 / 6)) return;
            const faceX = unit.guardFacingX ?? unit.braceFacingX;
            const faceY = unit.guardFacingY ?? unit.braceFacingY;
            const otherFaceX = other.guardFacingX ?? other.braceFacingX;
            const otherFaceY = other.guardFacingY ?? other.braceFacingY;
            // 一层同向长枪支援是武器规则，普通枪兵与守阵枪兵都适用。
            if (spear && other.team === unit.team && other.type === 'pikeman' && this.canAct(other) &&
                otherFaceX * faceX + otherFaceY * faceY > 0.85) supporting++;
            else blocked = true;
        });
        return !blocked && supporting <= (spear ? 1 : 0);
    },

    canStrike(scene, unit, target, reach, tolerance = 0) {
        return this.canAct(unit) && this.canBeHit(target) && unit.team !== target.team &&
            dist(unit, target) <= reach + tolerance &&
            (unit.tacticalRole !== 'guard' || this.inFacing(unit, target)) && this.clearLane(scene, unit, target);
    },

    // tolerance：出手判定的距离容差，默认 0（所有既有调用不变）。
    // 量化决策的调用方（民夫自卫）传 半量子，保证"量化后够得着"的目标不会被
    // 原始浮点距离卡在名义射程外侧（镜像两侧 0.8999…/0.9000…057 必须同判）。
    attack(scene, unit, target, now, reach = unit.typeData.range, tolerance = 0) {
        const guard = unit.type === 'pikeman' && unit.tacticalRole === 'guard';
        const prepared = guard && unit.guardReady;
        const cooldown = prepared ? 1000 : unit.typeData.atkSpeed;
        if (now - unit.lastAttack <= cooldown || !this.canStrike(scene, unit, target, reach, tolerance)) return;
        unit.lastAttack = now;
        scene.playAttackAnim(unit, target);
        const epoch = unit.actionEpoch;
        scene.scheduleBattleAction(95, () => {
            if (scene.battleOver || unit.actionEpoch !== epoch) return;
            const currentReach = guard && !unit.guardReady ? unit.typeData.range : reach;
            if (!this.canStrike(scene, unit, target, currentReach, 0.12)) return;
            resolveAttack(target, unit);
            if (guard) {
                if (scene.tactics) scene.tactics.metrics.thrusts++;
                if (prepared && unit.guardReady && scene.simulationTime - (target.lastSpearStagger ?? -Infinity) >= 700) {
                    target.lastSpearStagger = scene.simulationTime;
                    target.spearSlowUntil = scene.simulationTime + 340;
                    knockback(target, unit, target.type === 'cavalry' ? 0.08 : 0.42);
                    if (scene.tactics) scene.tactics.metrics.blocked++;
                }
            }
            scene.meleeImpact(unit, target);
        });
    }
};
