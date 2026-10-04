// 士气桥：士气系统的场景钩子（快照汇总/状态迁移/退守与溃逃推进/撤离），经场景单行委托调用。
import { board } from '../board.js';
import { Terrain } from '../terrain.js';
import { CombatRules } from '../combat.js';
import { dist, moveToward } from '../units.js';
import { TEAMS, isHostile, sameSide, teamName } from '../factions.js';

export function getMoraleSummary(scene) {
    const result = {};
    for (const team of TEAMS) {
        const stats = scene.battleStats[team];
        result[team] = { steady: 0, wavering: 0, routing: 0, withdrawn: stats.withdrawn,
            rallied: stats.rallied, reengaged: stats.reengaged, postRallyDamage: stats.postRallyDamage,
            fallingBack: 0, escaping: 0, recovering: 0, forming: 0, returning: 0,
            average: 0, lastReason: scene.moraleLastReason[team] };
    }
    for (const unit of scene.units) {
        if (unit.dead || unit.withdrawn) continue;
        const stats = result[unit.team];
        stats[unit.moraleState || 'steady']++;
        stats.average += unit.morale ?? 100;
        if (unit.moraleState === 'routing') {
            if (unit.moralePhase === 'recovering') stats.recovering++;
            else stats.escaping++;
        } else if (unit.rallyWaiting) stats.forming++;
        else if (unit.moraleState === 'wavering' && unit.moraleFallBackUntil > scene.simulationTime) stats.fallingBack++;
        else if (unit.moralePhase === 'returning') stats.returning++;
    }
    for (const stats of Object.values(result)) {
        const count = stats.steady + stats.wavering + stats.routing;
        stats.average = count ? Math.round(stats.average / count) : 0;
    }
    return result;
}

export function onMoraleStateChange(scene, unit, previousState, reason) {
    const side = teamName(unit.team);
    const state = unit.moraleState;
    const stats = scene.battleStats[unit.team];
    if (state === 'routing') {
        unit.routStartedAt = scene.simulationTime;
        unit.moralePhase = 'breaking';
        unit.moraleFallBackUntil = 0;
        unit.rallyWaiting = false; unit.rallyReadyAt = null;
        unit.tacticalRejoined = false;
        unit.guardReady = false; unit.guardStableTime = 0;
        unit.actionEpoch = (unit.actionEpoch || 0) + 1;
        unit.braceReady = false; unit.braceHold = false; unit.braceTime = 0;
        scene.cavalryAI?.enterMelee(unit);
        unit.target = null;
        unit.animState = null; unit.animLock = 0;
        scene.tweens.killTweensOf(unit.lunge);
        unit.lunge.x = 0; unit.lunge.y = 0;
        if (!unit.everRouted) {
            unit.everRouted = true;
            stats.routed++; stats.byType[unit.type].routed++;
        }
    } else if (previousState === 'routing') {
        unit.lastRalliedAt = scene.simulationTime;
        unit.moralePhase = 'returning';
        scene.tactics?.onRallied?.(unit);
        if (!unit.everRallied) {
            unit.everRallied = true;
            stats.rallied++; stats.byType[unit.type].rallied++;
        }
        if (unit.type === 'cavalry') scene.cavalryAI?.beginCharge(unit);
    }
    const label = state === 'routing' ? '开始溃逃' : previousState === 'routing' ? '完成重整'
        : state === 'wavering' ? '出现动摇' : '稳住阵脚';
    const sector = scene.moraleSector(unit);
    const text = `${side}${sector}${unit.typeData.name}${label}：${reason}`;
    scene.moraleLastReason[unit.team] = `${sector}${label} · ${reason}`;
    scene.addBattleEvent(`morale-${unit.team}-${sector}-${previousState === 'routing' ? 'rally' : state}`, text, unit.team);
    scene._countsDirty = true;
}

export function moraleSector(scene, unit) {
    const middle = scene.tactics?.formations[unit.team]?.cy ?? board.H / 2;
    return unit.gy < middle - 3 ? '上翼' : unit.gy > middle + 3 ? '下翼' : '中路';
}

export function updateFallingBackUnit(scene, unit, now, dt) {
    if (unit.moraleState !== 'wavering' || !(unit.moraleFallBackUntil > now) ||
        !['infantry', 'pikeman'].includes(unit.type)) return false;
    const slot = unit.formationSlot;
    if (unit.tacticalRole === 'guard' && scene.tactics?.formations[unit.team] &&
        slot?.unit === unit && unit.guardSupport >= 2 && Math.hypot(unit.gx - slot.gx, unit.gy - slot.gy) <= 0.81) {
        // 有邻兵支援时由战阵统一转向、迎击与补位，不因同一处伤亡让整排自行后退。
        unit.moraleFallBackUntil = 0;
        return false;
    }
    const enemy = scene.nearestEnemy(unit);
    if (!enemy || dist(unit, enemy) > 3) return false;
    const dx = enemy.gx - unit.gx, dy = enemy.gy - unit.gy, length = Math.hypot(dx, dy) || 1;
    unit.retreatFacingX = dx / length; unit.retreatFacingY = dy / length;
    moveToward(unit, unit.gx - dx / length, unit.gy - dy / length, unit.typeData.speed * 0.45, dt);
    if (unit.moving) {
        unit.guardReady = false; unit.guardStableTime = 0;
        unit.braceReady = false; unit.braceHold = false; unit.braceTime = 0;
    }
    // 有序后退仍能自卫；真正溃逃由 routing 分支接管并禁止攻击。
    CombatRules.attack(scene, unit, enemy, now, unit.typeData.range);
    return true;
}

export function updateRoutedUnit(scene, unit, dt) {
    // 据点疗伤中的溃兵站定接受治疗（回满才归队），不再逃逸。
    if (scene.territory?.healing?.holdRouted(unit)) { unit.moving = false; return; }
    // 在安全友军身边停下等待重整，不能边逃边自动回满士气。
    if (unit.moraleSheltered) return;
    const now = scene.simulationTime;
    if (now - scene._rallyRefresh >= 500) {
        scene._rallyRefresh = now;
        scene._rallyAnchors = scene.units.filter(other => {
            if (other.dead || other.withdrawn || other.moraleState !== 'steady') return false;
            let support = 0, threatened = false;
            scene.forEachNear(other.gx, other.gy, 6, neighbor => {
                if (neighbor.dead || neighbor.withdrawn || neighbor.moraleState === 'routing') return;
                const distance = dist(other, neighbor);
                if (isHostile(scene, neighbor.team, other.team) && distance <= 6) threatened = true;
                if (sameSide(scene, neighbor.team, other.team) && neighbor.moraleState === 'steady' && distance <= 5) support++;
            });
            // 接应点可包含锚点自己：三名预备队足以接应，不能误要求第四人。
            return !threatened && support >= 3;
        });
    }
    if (!unit.rallyTarget || unit.rallyTarget.dead || unit.rallyTarget.withdrawn ||
        unit.rallyTarget.moraleState !== 'steady' || now >= (unit.nextRallySearch || 0)) {
        unit.nextRallySearch = now + 500;
        unit.rallyTarget = null;
        let best = 18 * 18;
        for (const other of scene._rallyAnchors) {
            if (!sameSide(scene, other.team, unit.team) || other.dead || other.withdrawn || other.moraleState !== 'steady') continue;
            const distance = (other.gx - unit.gx) ** 2 + (other.gy - unit.gy) ** 2;
            if (distance < best - 1e-9 || (unit.rallyTarget && Math.abs(distance - best) <= 1e-9 && other.id < unit.rallyTarget.id)) {
                best = distance; unit.rallyTarget = other;
            }
        }
    }
    // 疗伤据点优先于接应锚：溃兵按收容循环直奔最近己方据点（无令时）。
    const anchor = scene.tactics?.rallyPoint(unit) || scene.territory?.healing?.rallyAnchor(unit) || unit.rallyTarget;
    // 无指定接应点时回撤向"自家出生方向"：红西、蓝东、黑南（合作模式）。
    const homeX = unit.team === 'black' ? board.W / 2 : unit.team === 'red' ? 0 : board.W;
    const homeY = unit.team === 'black' ? board.H : unit.gy;
    let dx = (anchor ? anchor.gx : homeX) - unit.gx;
    let dy = anchor ? anchor.gy - unit.gy : homeY - unit.gy;
    const length = Math.hypot(dx, dy) || 1;
    dx /= length; dy /= length;
    // 邻近敌人使逃跑方向偏离危险处，仍保留回撤方向，防止原地左右振荡。
    scene.forEachNear(unit.gx, unit.gy, 4, enemy => {
        if (!isHostile(scene, unit.team, enemy.team) || enemy.dead || enemy.withdrawn || enemy.moraleState === 'routing') return;
        const ex = unit.gx - enemy.gx, ey = unit.gy - enemy.gy, d = Math.hypot(ex, ey);
        if (d <= 0.001 || d > 4) return;
        const weight = (4 - d) / 4;
        dx += ex / d * weight; dy += ey / d * weight;
    });
    const direction = Math.hypot(dx, dy);
    if (direction < 0.001) { dx = unit.team === 'black' ? 0 : unit.team === 'red' ? -1 : 1; dy = unit.team === 'black' ? 1 : 0; }
    const normalize = Math.hypot(dx, dy);
    const closeEnemy = now - (unit.routStartedAt ?? -Infinity) < 900 ? scene.nearestEnemy(unit) : null;
    const breaking = closeEnemy && dist(unit, closeEnemy) < 3;
    if (Terrain.hasBarriers(scene.battleOptions.terrain)) {
        // 隔岸时保留全局接应点；三格的局部躲避点可能落水，不能用它取代回撤路线。
        const fallbackX = unit.team === 'black' ? board.W / 2 : unit.team === 'red' ? 0.6 : board.W - 0.6;
        const fallbackY = unit.team === 'black' ? board.H - 0.6 : unit.gy;
        moveToward(unit, anchor ? anchor.gx : fallbackX,
            anchor ? anchor.gy : fallbackY, unit.typeData.speed * (breaking ? 0.7 : 1), dt);
        return;
    }
    moveToward(unit, unit.gx + dx / normalize * 3, unit.gy + dy / normalize * 3,
        unit.typeData.speed * (breaking ? 0.7 : 1), dt);
}

export function withdrawUnit(scene, unit) {
    if (scene.battleOptions.deathmatch) return;
    if (unit.dead || unit.withdrawn || unit.battleId !== scene.battleId) return;
    unit.withdrawn = true;
    unit.actionEpoch = (unit.actionEpoch || 0) + 1;
    const team = scene.battleStats[unit.team];
    for (const stats of [team, team.byType[unit.type]]) { stats.alive--; stats.withdrawn++; }
    scene.setAlive?.(unit.team, team.alive);
    scene.tweens.killTweensOf(unit.spr); scene.tweens.killTweensOf(unit.lunge);
    unit.spr.destroy(); unit.shadow.destroy();
    scene._countsDirty = true;
    scene.addBattleEvent(`withdraw-${unit.team}`, `${teamName(unit.team)}溃兵开始撤离战场`, unit.team);
}
