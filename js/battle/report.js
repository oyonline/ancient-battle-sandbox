// ==================== 战报台账（纯模拟，不碰渲染） ====================
// 从 game.js IsoBattleScene 抽出（第 0 批地基 4/4）。
// 持有双方统计（battleStats）、战报事件（battleEvents）、里程碑去重、
// 首次接敌时间与士气播报。场景通过薄委托使用；scene.battleStats 与
// ledger.stats 是同一对象，外部（tactics/tests）读取契约不变。
// 事件一律内联按发生顺序推入，now 由调用方传场景模拟时钟。

import { UNIT_TYPES } from '../units.js';

export class BattleLedger {
    constructor(battleId) {
        this.battleId = battleId;   // 跨场单位（旧 battleId）的伤害不计入本场
        this.stats = {};
        const emptyStats = () => ({ initial: 0, alive: 0, lost: 0, kills: 0, damage: 0,
            withdrawn: 0, routed: 0, rallied: 0, reengaged: 0, postRallyDamage: 0 });
        for (const team of ['red', 'blue']) {
            this.stats[team] = {
                ...emptyStats(),
                byType: Object.fromEntries(Object.keys(UNIT_TYPES).map(type => [type, emptyStats()]))
            };
        }
        this.events = [];
        this.milestones = new Set();
        this.firstContactMs = null;
        this.moraleCue = null;
    }

    register(unit) {
        const team = this.stats[unit.team];
        for (const stats of [team, team.byType[unit.type]]) {
            stats.initial++;
            stats.alive++;
        }
    }

    // attackStartedAt 默认取自攻击者 lastAttack，由调用方传入（单位字段属模拟层）
    recordDamage(now, target, damage, from, attackStartedAt = from?.lastAttack) {
        if (!from || from.battleId !== this.battleId || from.team === target.team) return;
        if (damage > 0 && this.firstContactMs == null) this.firstContactMs = Math.round(now);
        const team = this.stats[from.team];
        team.damage += damage;
        team.byType[from.type].damage += damage;
        if (damage > 0 && from.everRallied && attackStartedAt >= from.lastRalliedAt) {
            for (const stats of [team, team.byType[from.type]]) {
                stats.postRallyDamage += damage;
                if (!from.everReengaged) stats.reengaged++;
            }
            from.everReengaged = true;
            if (from.moralePhase === 'returning') from.moralePhase = null;
        }
    }

    addEvent(now, key, text, team) {
        if (this.milestones.has(key)) return;
        this.milestones.add(key);
        this.events.push({ atMs: Math.round(now), text, team });
        if (/^(morale-|tactic-rally|tactic-rescue)/.test(key)) {
            this.moraleCue = { text, atMs: now };
        }
    }

    // 返回该阵营存活数，供场景同步 redAlive/blueAlive。
    // 事件语义与原版一致：击杀里程碑与半损里程碑按调用序内联推入。
    recordDeath(now, unit, from, battleId) {
        const team = this.stats[unit.team];
        for (const stats of [team, team.byType[unit.type]]) {
            stats.alive--;
            stats.lost++;
        }
        if (from && from.battleId === battleId && from.team !== unit.team) {
            const attacker = this.stats[from.team];
            attacker.kills++;
            attacker.byType[from.type].kills++;
            const side = from.team === 'red' ? '红方' : '蓝方';
            this.addEvent(now, 'first-kill', `${side}${UNIT_TYPES[from.type].name}取得首杀`, from.team);
            if (from.type === 'cavalry' && unit.type === 'archer') {
                this.addEvent(now, 'cavalry-archer', `${side}骑兵首次击杀弓箭手`, from.team);
            }
        }
        if (team.initial > 0 && team.lost * 2 >= team.initial) {
            this.addEvent(now, `half-${unit.team}`, `${unit.team === 'red' ? '红方' : '蓝方'}损失达到初始兵力的一半`, unit.team);
        }
        return team.alive;
    }

    moraleSummary() {
        const result = {};
        for (const team of ['red', 'blue']) {
            const stats = this.stats[team];
            result[team] = { steady: 0, wavering: 0, routing: 0, withdrawn: stats.withdrawn,
                rallied: stats.rallied, reengaged: stats.reengaged, postRallyDamage: stats.postRallyDamage };
        }
        return result;
    }
}
