// ==================== 溃兵收容与战地医疗（纯模拟，不碰渲染） ====================
// v0 溃兵收容循环：领土模式下崩溃士兵不再只靠接应锚重整——撤退目标改为最近的
// 己方据点（含老家），进点疗伤（回满 HP 与士气、不战斗不占旗），痊愈后归队。
// v1 医疗：医帐（第三种建筑，民夫施工）提速扩容；医师（新兵种）战场光环急救，
// 可入驻医帐再加速据点疗伤。
//
// 状态位：unit.healSiteId（溃逃途中指定的疗伤据点）→ 到点置 unit.healingAt
// （站定疗伤中）。疗伤期间保持 moraleState='routing'，复用全部既有排除面
// （不攻击/不被计战力/不占旗/胜负口径），morale.js 的自动重整被 healingAt
// 拦住，直到 HP 回满才转为 steady 归队——士气先回血后回的顺序由此保证。
//
// 确定性铁律：无 Math.random；选址/急救目标距离优先、平局 id 决胜；
// 遍历序固定（units 数组序），重赋值按固定节拍（ASSIGN_INTERVAL_MS），
// 与 docs/DETERMINISM.md 的换座镜像 / 锁步约定兼容。

import { board } from '../board.js';
import { moveToward } from '../units.js';
import { quantizeDecision as q } from './determinism.js';

// 距离比较一律先量化到 0.05 网格再与网格阈值比较（阈值 2.2/3.6/3.2/1.2/4 均为
// 0.05 整数倍）——镜像坐标的浮点噪声（~1e-15）在量化后归到同一格点，
// 换座两侧的离散决策一致（docs/DETERMINISM.md，同 camps.js distance 约定）。
const qdist = (a, b) => q(Math.hypot(a.gx - b.gx, a.gy - b.gy));

export const HEALING_RULES = {
    ENTER_REACH: 2.2,          // 进点疗伤半径（据点圈附近即可开始疗伤）
    FULL_HEAL_MS: 20000,       // 基准：从 1 血回满约 20 秒，按损血比例折算
    MORALE_REGEN: 30,          // 疗伤期间士气恢复（点/秒，快于战地自然恢复）
    ASSIGN_INTERVAL_MS: 500,   // 溃逃单位疗伤据点（重）分配节拍
    BASE_CAPACITY: 8,          // 每据点同时疗伤容量基线
    TENT_CAPACITY: 16,         // 该点有完工医帐时的容量
    TENT_SPEED_BONUS: 1.2,     // 医帐治疗速度加成（总速 1.0 → 2.2 倍）
    TENT_MEDIC_SLOTS: 2,       // 医帐可入驻医师数
    TENT_MEDIC_SPEED_BONUS: 0.8, // 每名驻帐医师再加（叠加制：1.0+1.2+0.8n）
    MEDIC_AURA_RADIUS: 3.6,    // 战地急救光环半径（格）
    MEDIC_AURA_RATE: 3.0,      // 光环治疗 HP/秒
    MEDIC_AURA_TARGETS: 2      // 每名医师同时急救人数
};

export class HealingSystem {
    constructor(scene) {
        this.scene = scene;                 // 场景钩子：flags / territory.camps / battalions / units
        this.nextAssign = 0;
    }

    site(team, siteId) {
        if (siteId === 'home') return { gx: team === 'red' ? 7 : board.W - 7, gy: board.H / 2 };
        return Number.isInteger(siteId) ? this.scene.flags?.[siteId] ?? null : null;
    }

    ownsSite(team, siteId) {
        if (siteId === 'home') return true;
        return this.site(team, siteId)?.owner === team;
    }

    tentAt(team, siteId) {
        const tent = this.scene.territory?.camps?.getBuilding(`tent:${team}:${siteId}`);
        return tent && !tent.dead && tent.complete ? tent : null;
    }

    medicsInTent(team, siteId) {
        return this.tentAt(team, siteId)?.garrisonIds.length ?? 0;
    }

    capacity(team, siteId) {
        return this.tentAt(team, siteId) ? HEALING_RULES.TENT_CAPACITY : HEALING_RULES.BASE_CAPACITY;
    }

    // 据点当前占用：正在疗伤 + 已被指定前往该点（含在途）的人数。
    load(team, siteId) {
        let count = 0;
        for (const u of this.scene.units) {
            if (u.dead || u.withdrawn || u.team !== team || u.moraleState !== 'routing') continue;
            if (u.healingAt === siteId || (u.healingAt == null && u.healSiteId === siteId)) count++;
        }
        return count;
    }

    // 最近的有空位己方据点；量化距离优先，平局用镜像不变量决胜（先离左右边
    // 最近距离、再离上下边最近距离——镜像局红蓝取到同一相对据点），最后才
    // 落到据点序号（home 视作 -1，仅作确定性兜底）。无可用据点返回 null
    // （溃逃回退旧行为：接应锚 / 家边缘撤离）。
    pickSite(unit) {
        let best = null, bestD = Infinity;
        const candidates = [{ siteId: 'home', order: -1, point: this.site(unit.team, 'home') }];
        const flags = this.scene.flags ?? [];
        for (let i = 0; i < flags.length; i++) {
            if (flags[i].owner !== unit.team) continue;
            candidates.push({ siteId: i, order: i, point: flags[i] });
        }
        // 平局决胜比较：先距左右边最近距离，再距上下边最近距离，最后据点序兜底。
        const tieBreak = (a, b) => a.mirrorX !== b.mirrorX ? a.mirrorX - b.mirrorX
            : a.mirrorY !== b.mirrorY ? a.mirrorY - b.mirrorY : a.order - b.order;
        for (const candidate of candidates) {
            if (!candidate.point || this.load(unit.team, candidate.siteId) >= this.capacity(unit.team, candidate.siteId)) continue;
            const d = qdist(unit, candidate.point);
            candidate.mirrorX = q(Math.min(candidate.point.gx, board.W - candidate.point.gx));
            candidate.mirrorY = q(Math.min(candidate.point.gy, board.H - candidate.point.gy));
            if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && tieBreak(candidate, best) < 0)) {
                bestD = d; best = candidate;
            }
        }
        return best?.siteId ?? null;
    }

    // 溃逃导航锚点：有指定疗伤据点且仍属己方时，撤退方向指向该据点。
    // 据点丢失即作废（返回 null 前清位），下一拍重新选址。
    rallyAnchor(unit) {
        if (unit.moraleState !== 'routing' || unit.healSiteId == null) return null;
        if (!this.ownsSite(unit.team, unit.healSiteId)) { unit.healSiteId = null; return null; }
        return this.site(unit.team, unit.healSiteId);
    }

    // 疗伤站定：updateRoutedUnit 顶部调用，疗伤中的单位不再逃逸。
    holdRouted(unit) {
        return unit.healingAt != null && unit.moraleState === 'routing' &&
            this.ownsSite(unit.team, unit.healingAt);
    }

    // 据点在疗人数按阵营计数：双方大本营共用 'home' 键，绝不能串用容量
    // （红方本营满员不挡蓝方本营——评审 P1-1）。
    healingCount(team, siteId) {
        let count = 0;
        for (const u of this.scene.units) {
            if (u.team === team && u.healingAt === siteId && !u.dead && !u.withdrawn) count++;
        }
        return count;
    }

    speed(team, siteId) {
        let value = 1;
        if (this.tentAt(team, siteId)) value += HEALING_RULES.TENT_SPEED_BONUS;
        value += HEALING_RULES.TENT_MEDIC_SPEED_BONUS * this.medicsInTent(team, siteId);
        return value;
    }

    update(dt) {
        const scene = this.scene, now = scene.simulationTime;
        // ① 疗伤据点（重）分配：固定节拍，粘性保留仍合法的当前选择。
        if (q(now) >= q(this.nextAssign)) {
            this.nextAssign = now + HEALING_RULES.ASSIGN_INTERVAL_MS;
            for (const u of scene.units) {
                if (u.dead || u.withdrawn || u.type === 'wagon') { u.healSiteId = null; continue; }
                if (u.moraleState !== 'routing' || u.healingAt != null) continue;
                const siteId = u.healSiteId;
                if (siteId != null && (!this.ownsSite(u.team, siteId) ||
                    this.load(u.team, siteId) > this.capacity(u.team, siteId))) u.healSiteId = null;
                if (u.healSiteId == null) u.healSiteId = this.pickSite(u);
            }
        }
        // ② 到点入住：量化距离判定（镜像对称），有空位才入住。
        for (const u of scene.units) {
            if (u.dead || u.withdrawn || u.moraleState !== 'routing' || u.healingAt != null ||
                u.healSiteId == null || !this.ownsSite(u.team, u.healSiteId)) continue;
            const point = this.site(u.team, u.healSiteId);
            if (qdist(u, point) > HEALING_RULES.ENTER_REACH) continue;
            if (this.healingCount(u.team, u.healSiteId) >= this.capacity(u.team, u.healSiteId)) {
                u.healSiteId = null;    // 满员：下一拍改投次近据点
                continue;
            }
            u.healingAt = u.healSiteId;
            u.healingSince = now;
            u.healCount = (u.healCount || 0) + 1;
            u.moving = false; u.moveX = 0; u.moveY = 0;
            scene.addBattleEvent?.(`heal-enter-${u.id}-${u.healCount}`,
                `${u.team === 'red' ? '红方' : '蓝方'}${u.typeData.name}退入${u.healingAt === 'home' ? '大本营' : this.scene.flags[u.healingAt].name}疗伤`, u.team);
        }
        // ③ 疗伤推进：HP 按损血比例回满，士气同步恢复；据点失守立即中断再溃逃。
        // 毁帐降容语义：已入住者继续治完（不赶人），新入住按当前容量（评审 P2 决策）。
        for (const u of scene.units) {
            if (u.healingAt == null) continue;
            if (u.dead || u.withdrawn || u.moraleState !== 'routing' ||
                !this.ownsSite(u.team, u.healingAt)) {
                u.healingAt = null; u.healSiteId = null;
                continue;
            }
            const siteId = u.healingAt;
            u.hp = Math.min(u.maxHp, u.hp + u.maxHp / HEALING_RULES.FULL_HEAL_MS * 1000 * this.speed(u.team, siteId) * dt);
            u.morale = Math.min(100, u.morale + HEALING_RULES.MORALE_REGEN * dt);
            if (u.hp >= u.maxHp - 1e-9) {
                // 伤愈归队：转 steady、触发既有重整钩子（战报/骑兵归队/营队）。
                u.hp = u.maxHp; u.morale = 100;
                u.healingAt = null; u.healSiteId = null;
                u.moraleState = 'steady';
                u.moraleReason = '据点疗伤完毕，伤愈归队';
                scene.onMoraleStateChange?.(u, 'routing', u.moraleReason);
                scene.addBattleEvent?.(`heal-done-${u.id}-${u.healCount}`,
                    `${u.team === 'red' ? '红方' : '蓝方'}${u.typeData.name}伤愈归队，重返战线`, u.team);
                scene._countsDirty = true;
            }
        }
        // ④ 医师战地急救光环：无攻击、按血量比例最低优先，平局 id 决胜。
        const medics = scene.units
            .filter(u => !u.dead && !u.withdrawn && u.type === 'medic' &&
                u.moraleState !== 'routing' && !u.garrisonTowerId && !u.garrisonOrderId)
            .sort((a, b) => a.id - b.id);
        for (const medic of medics) {
            const radius = HEALING_RULES.MEDIC_AURA_RADIUS;
            const wounded = [];
            scene.forEachNear(medic.gx, medic.gy, radius, target => {
                if (target.team !== medic.team || target.dead || target.withdrawn ||
                    target.type === 'wagon' || target.type === 'medic' ||
                    target.moraleState === 'routing' || target.healingAt != null ||
                    target.garrisonTowerId || target.hp >= target.maxHp - 1e-9) return;
                if (qdist(medic, target) > radius) return;   // 半径量化：镜像光环边界一致
                wounded.push({ target, ratio: target.hp / target.maxHp });
            });
            wounded.sort((a, b) => a.ratio - b.ratio || a.target.id - b.target.id);
            for (const { target } of wounded.slice(0, HEALING_RULES.MEDIC_AURA_TARGETS)) {
                target.hp = Math.min(target.maxHp,
                    target.hp + HEALING_RULES.MEDIC_AURA_RATE * dt);
            }
        }
    }
}

// 医师战场行为（unit-ai 委托）：不攻击不占旗，随营行军；敌近且贴身时且战且退。
// 驻塔/驻帐令由 CampSystem.updateUnit 先行接管，这里只处理野战随队。
// 距离阈值均量化（镜像对称，见文件头 qdist 约定）。
export function updateMedic(scene, unit, now, dt) {
    const battalion = scene.battleOptions.territory ? unit.battalion : null;
    let target = null;
    if (battalion?.gathering) target = battalion.gatherPoint;
    else if (battalion?.retreat) target = scene.battalions?.homeRally(unit.team);
    else if (battalion?.orderPoint) target = battalion.orderPoint;
    else if (battalion?.orderFlag != null && scene.flags?.[battalion.orderFlag] &&
        scene.flags[battalion.orderFlag].owner !== unit.team) target = scene.flags[battalion.orderFlag];
    else {
        const center = battalion?.center();
        if (center && qdist(unit, center) > 4) target = center;
    }
    // 敌人贴身：优先保命后撤（医师是对方斩医疗的优先目标）。
    let nearest = null, nearestD = Infinity;
    scene.forEachNear(unit.gx, unit.gy, 4, enemy => {
        if (enemy.team === unit.team || enemy.dead || enemy.withdrawn ||
            enemy.moraleState === 'routing' || enemy.type === 'wagon') return;
        const d = qdist(unit, enemy);
        if (d < nearestD - 1e-9 || (Math.abs(d - nearestD) <= 1e-9 && enemy.id < nearest.id)) { nearestD = d; nearest = enemy; }
    });
    if (nearest && nearestD <= 3.2) {
        const dx = unit.gx - nearest.gx, dy = unit.gy - nearest.gy, length = Math.hypot(dx, dy) || 1;
        moveToward(unit, unit.gx + dx / length * 3, unit.gy + dy / length * 3, unit.typeData.speed, dt);
        return;
    }
    if (target && qdist(unit, target) > 1.2) {
        const pace = battalion && !battalion.gathering && unit.type !== 'cavalry'
            ? Math.min(unit.typeData.speed, battalion.pace * 1.08) : unit.typeData.speed;
        moveToward(unit, target.gx, target.gy, pace, dt);
    }
}
