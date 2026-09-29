// ==================== 营队系统（纯模拟，不碰渲染；仅领土征服模式启用） ====================
// 军队按营组织：开局常备军确定性三等分为上/中/下营；新兵入集结营，攒满一波
// 整营激活推进（消灭单兵逐个溜达）；营级 AI 按五旗敌我实力多线派营（打得过
// 才打、家旗被犯最近营回援、多营不挤同一目标）；行军步速取营内最慢兵种同步。
// 玩家令优先于 AI 令：选营点旗，夺旗后交还 AI。
//
// 确定性铁律：无 Math.random；遍历序固定（team 序、营创建序、旗序、id 决胜），
// 与 docs/DETERMINISM.md 的换座镜像 / 锁步约定兼容。

import { BATTALION_POWER } from './economy.js';

export const BATTALION = {
    OPENING_LANES: 3,          // 开局常备军分营数（按纵向位置三等分）
    WAVE_SIZE: 8,              // 集结营满员激活阈值
    WAVE_MIN_AGE_MS: 25000,    // 集结超时也激活的门槛（低收入的慢战线不至于永远蹲家）
    WAVE_MIN_SIZE: 5,          // 超时激活的最低人数
    AI_INTERVAL_MS: 2000,      // 营级 AI 评估间隔
    ASSESS_RADIUS: 9,          // 旗附近敌我实力评估半径（格）
    CAVALRY_LEASH: 16,         // 骑兵离营心缰绳距离（行军中超且无敌情则回撤归队）
    LEASH_ENEMY_CLEAR: 10,     // 缰绳生效的"无敌情"判定半径
    GATHER_HOLD_RADIUS: 3,     // 集结营成员围绕集结点的驻留半径
    PACE_SLACK: 1.08           // 行军步速同步的宽容系数（略高于最慢兵种）
};

let battalionSeq = 1;

export class Battalion {
    constructor(team, kind) {
        this.id = battalionSeq++;
        this.team = team;
        this.kind = kind;                 // 'line'（成建制作战营）| 'gathering'（集结中）
        this.gathering = kind === 'gathering';
        this.createdAt = 0;               // 场景模拟时钟（集结超时判定用）
        this.members = [];
        this.orderFlag = null;            // 目标旗 index；null = 无令
        this.playerOrdered = false;       // 玩家令（AI 不覆盖）
        this.retreat = false;             // 玩家回防令
        this.gatherPoint = null;
        this.pace = 2.2;                  // 营行军步速（最慢兵种）
    }

    aliveMembers() {
        return this.members.filter(u => !u.dead && !u.withdrawn);
    }

    center() {
        const alive = this.aliveMembers();
        if (!alive.length) return null;
        let gx = 0, gy = 0;
        for (const u of alive) { gx += u.gx; gy += u.gy; }
        return { gx: gx / alive.length, gy: gy / alive.length };
    }

    power() {
        let total = 0;
        for (const u of this.aliveMembers()) total += BATTALION_POWER[u.type] ?? 5;
        return total;
    }

    refreshPace() {
        let pace = Infinity;
        for (const u of this.aliveMembers()) {
            if (u.type === 'cavalry') continue;      // 骑兵不拴步速（缰绳另行约束）
            pace = Math.min(pace, u.typeData.speed);
        }
        this.pace = Number.isFinite(pace) ? pace : 2.2;
    }
}

export class BattalionSystem {
    constructor(scene) {
        this.scene = scene;                 // 场景钩子：flags / forEachNear / simulationTime
        this.battalions = [];               // 营创建序（确定性）
        this.pool = { red: null, blue: null };   // 各方现役集结营
        this.nextThink = 0;
    }

    homeRally(team) {
        return { gx: team === 'red' ? 8 : this.scene.board_W(), gy: this.scene.board_H() / 2 };
    }

    // 开局分编：按 gy 稳定排序后三等分（id 决胜），形成上/中/下三个成建制营。
    splitOpening(units) {
        for (const team of ['red', 'blue']) {
            const mine = units.filter(u => u.team === team && !u.dead && !u.withdrawn);
            if (!mine.length) continue;
            mine.sort((a, b) => a.gy - b.gy || a.id - b.id);
            const lanes = Math.min(BATTALION.OPENING_LANES, mine.length);
            for (let lane = 0; lane < lanes; lane++) {
                const battalion = new Battalion(team, 'line');
                const from = Math.floor(lane * mine.length / lanes);
                const to = Math.floor((lane + 1) * mine.length / lanes);
                for (let i = from; i < to; i++) {
                    battalion.members.push(mine[i]);
                    mine[i].battalion = battalion;
                }
                battalion.refreshPace();
                this.battalions.push(battalion);
            }
        }
    }

    // 新兵入集结营：满一波（或超时）整营激活并另开新集结营。
    assignReinforcement(unit) {
        const team = unit.team;
        if (!this.pool[team]) {
            this.pool[team] = new Battalion(team, 'gathering');
            this.pool[team].gatherPoint = this.homeRally(team);
            this.pool[team].createdAt = this.scene.simulationTime;
            this.battalions.push(this.pool[team]);
        }
        const pool = this.pool[team];
        pool.members.push(unit);
        unit.battalion = pool;
        pool.refreshPace();
    }

    // 每步推进：剪除阵亡 → 营维护（步速/空营解散/集结激活/夺旗交还）→ 周期性 AI 派营。
    update(now) {
        for (const battalion of this.battalions) {
            if (battalion.members.length !== battalion.aliveMembers().length) {
                battalion.members = battalion.aliveMembers();
            }
            battalion.refreshPace();
        }
        this.battalions = this.battalions.filter(b => b.members.length > 0);
        for (const team of ['red', 'blue']) {
            if (this.pool[team] && this.pool[team].members.length === 0) this.pool[team] = null;
        }
        // 集结激活：满员或超时
        for (const team of ['red', 'blue']) {
            const pool = this.pool[team];
            if (!pool || pool.gathering) continue;
            this.pool[team] = null;      // 已激活的营不再是集结池
        }
        for (const battalion of this.battalions) {
            if (!battalion.gathering) continue;
            const size = battalion.members.length;
            const age = now - battalion.createdAt;
            if (size >= BATTALION.WAVE_SIZE || (age >= BATTALION.WAVE_MIN_AGE_MS && size >= BATTALION.WAVE_MIN_SIZE)) {
                battalion.gathering = false;
                battalion.kind = 'line';
                if (this.pool[battalion.team] === battalion) this.pool[battalion.team] = null;
            }
        }
        // 夺旗交还：目标旗已被本方占领 → 指令完成，营回归 AI（玩家令解除）
        const flags = this.scene.flags || [];
        for (const battalion of this.battalions) {
            if (battalion.orderFlag == null || !flags[battalion.orderFlag]) continue;
            if (flags[battalion.orderFlag].owner === battalion.team) {
                battalion.orderFlag = null;
                battalion.playerOrdered = false;
                battalion.retreat = false;
            }
        }
        if (now >= this.nextThink) {
            this.nextThink = now + BATTALION.AI_INTERVAL_MS;
            this.aiAssign();
        }
    }

    // 营级 AI：按五旗敌我实力派营。无随机数；营遍历序 = 创建序，旗序决胜。
    aiAssign() {
        const scene = this.scene;
        const flags = scene.flags;
        if (!flags || !flags.length) return;
        // 实力图：每旗评估半径内双方占领力（与占旗拔河同权）
        const strength = flags.map(flag => {
            const power = { red: 0, blue: 0 };
            scene.forEachNear(flag.gx, flag.gy, BATTALION.ASSESS_RADIUS, u => {
                if (u.dead || u.withdrawn || u.moraleState === 'routing') return;
                if (Math.hypot(u.gx - flag.gx, u.gy - flag.gy) > BATTALION.ASSESS_RADIUS) return;
                power[u.team] += BATTALION_POWER[u.type] ?? 5;
            });
            return power;
        });
        for (const team of ['red', 'blue']) {
            const foe = team === 'red' ? 'blue' : 'red';
            const active = this.battalions.filter(b => b.team === team && !b.gathering && b.members.length);
            if (!active.length) continue;
            const assignedCount = new Array(flags.length).fill(0);
            // 玩家已指派的营占住目标位，AI 不与之争抢
            for (const b of active) if (b.playerOrdered && b.orderFlag != null) assignedCount[b.orderFlag]++;
            for (const b of active) {
                if (b.playerOrdered) continue;
                const center = b.center();
                let best = -1, bestScore = -Infinity;
                for (let i = 0; i < flags.length; i++) {
                    const flag = flags[i];
                    const mine = strength[i][team], theirs = strength[i][foe];
                    let score;
                    if (flag.owner === team) {
                        // 己方旗：被敌明显进犯才值得派营回援（一旗一营足够）
                        score = theirs > Math.max(12, mine * 1.2) && assignedCount[i] === 0
                            ? 120 + theirs - mine
                            : 4 - mine * 0.1;
                    } else {
                        // 非己方旗：把本营战力计入再判断打得过；打不过直接跳过（不送死）
                        const winnable = mine + b.power() * 0.8 >= theirs * 0.85;
                        if (!winnable && theirs > 0) continue;
                        const neutral = flag.owner == null;
                        score = 50 + (neutral ? 8 : 0) + (mine - theirs) * 0.4
                            - (center ? Math.hypot(flag.gx - center.gx, flag.gy - center.gy) : 0) * 0.35
                            - assignedCount[i] * 30;
                    }
                    // 现任目标黏性：没有明显更优选择就别换旗——防止所有营每轮
                    // 重评估都涌向"当前最优"的中央旗（山河图三线被吃成一条线的元凶）
                    if (i === b.orderFlag) score += 10;
                    if (score > bestScore + 1e-9) { bestScore = score; best = i; }
                }
                if (best >= 0 && bestScore > 10) {
                    b.orderFlag = best;
                    b.retreat = false;
                    assignedCount[best]++;
                } else {
                    // 无仗可打：收缩到最近己方旗驻防（保持存在感，不站桩空地）
                    b.orderFlag = this.nearestOwnFlag(b, flags) ?? b.orderFlag;
                    b.retreat = false;
                }
            }
        }
    }

    nearestOwnFlag(battalion, flags) {
        const center = battalion.center();
        let best = null, bestDistance = Infinity;
        for (let i = 0; i < flags.length; i++) {
            if (flags[i].owner !== battalion.team) continue;
            const d = center ? Math.hypot(flags[i].gx - center.gx, flags[i].gy - center.gy) : 0;
            if (d < bestDistance - 1e-9) { bestDistance = d; best = i; }
        }
        return best;
    }

    // 玩家指挥：选营点旗下令 / 回防集结。返回是否受理。
    orderSelected(flagIndex, scene) {
        const selected = scene.selectedBattalion;
        if (!selected || selected.team !== 'red') return false;
        if (flagIndex === 'home') {
            selected.orderFlag = null;
            selected.playerOrdered = true;
            selected.retreat = true;
            return true;
        }
        if (flagIndex == null || !this.scene.flags[flagIndex]) return false;
        selected.orderFlag = flagIndex;
        selected.playerOrdered = true;
        selected.retreat = false;
        return true;
    }
}
