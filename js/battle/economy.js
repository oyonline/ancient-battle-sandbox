// ==================== 领土征服经济（纯模拟，不碰渲染） ====================
// 英雄连式循环：占旗 → 军费流入 → 征兵出兵 → 抢旗。数值均为 v0 实施默认
// （KB 立项稿 20260929-122504 §边界：收入/造价/票数需试玩校正）。
//
// 确定性：收入与票数按固定步长 dt 累加，红蓝各自独立计算、无跨方交互顺序，
// 与 docs/DETERMINISM.md 的换座镜像 / 将来锁步联网约定兼容。
// 造价 = UNIT_TYPES.cost × COST_MULT（沿用既有兵种金币基准 5/6/8/12）。

import { UNIT_TYPES } from '../units.js';
import { board } from '../board.js';
import { territoryLayout } from '../territory-map.js';

export const TERRITORY = {
    W: 260, H: 180,                   // 领土面积为原版四倍；常规模式仍为 70×70
    BASE_INCOME: 5,                   // 基础军费收入（军费/秒，无旗也有）
    FLAG_INCOME: 4,                   // 每面归属旗额外收入（军费/秒）
    START_TREASURY: 150,              // 开局军费
    TICKETS: 900,                     // 双方开局票数
    TICKET_DRAIN: 1.6,                // 票数流失速率 = 旗数差 × 此值（票/秒）
    COST_MULT: 6,                     // 兵种造价系数（剑士30/枪36/弓48/骑72）
    TRAIN_MS: { infantry: 3000, pikeman: 4000, archer: 5000, cavalry: 8000, worker: 3500 },
    ALIVE_CAP: 220,                   // 单方在场兵力上限（性能与规模护栏；队列出兵到顶暂停）
    QUEUE_CAP: 8,                     // 单方训练队列上限
    OPENING: { infantry: 14, pikeman: 6, archer: 8, cavalry: 3, worker: 2 },
    AI_INTERVAL_MS: 1200              // 战略 AI 决策间隔
};

// 占领力权重：占旗拔河与营队实力评估共用同一张表（人多/兵种强 = 占领力高）。
export const BATTALION_POWER = { infantry: 10, pikeman: 7, archer: 4, cavalry: 12, worker: 0 };

// 五旗与实际桥头、高地、林口共用同一布局；起始归属与经济规则不变。
export function makeTerritoryFlags() {
    return territoryLayout(board.W, board.H).sites.map(f => ({ ...f, contested: false }));
}

export class TerritoryEconomy {
    constructor() {
        this.treasury = { red: TERRITORY.START_TREASURY, blue: TERRITORY.START_TREASURY };
        this.earned = { red: 0, blue: 0 };
        this.spent = { red: 0, blue: 0 };
    }

    incomeRate(ownedFlags) {
        return TERRITORY.BASE_INCOME + ownedFlags * TERRITORY.FLAG_INCOME;
    }

    tick(dt, owned) {
        for (const team of ['red', 'blue']) {
            const amount = this.incomeRate(owned[team]) * dt;
            this.treasury[team] += amount;
            this.earned[team] += amount;
        }
    }

    costOf(type) {
        return (UNIT_TYPES[type]?.cost ?? 0) * TERRITORY.COST_MULT;
    }

    canAfford(team, type) {
        return this.treasury[team] >= this.costOf(type);
    }
}

// 票数流失：占多数旗的一方让对方流失，速率 = 旗数差 × TICKET_DRAIN。
// 5 面旗下 3:2 → 1.6/秒（约 9 分钟耗尽 900 票）；4:1 / 5:0 递增压制。
export class TicketSystem {
    constructor() {
        this.tickets = { red: TERRITORY.TICKETS, blue: TERRITORY.TICKETS };
    }

    tick(dt, owned) {
        const margin = owned.red - owned.blue;
        if (margin > 0) {
            this.tickets.blue = Math.max(0, this.tickets.blue - margin * TERRITORY.TICKET_DRAIN * dt);
        } else if (margin < 0) {
            this.tickets.red = Math.max(0, this.tickets.red + margin * TERRITORY.TICKET_DRAIN * dt);
        }
    }

    // 票数归零且对方仍有票 → 对方获胜；同时归零视为未定（继续打到歼灭/再分差）。
    winner() {
        if (this.tickets.blue <= 0 && this.tickets.red > 0) return 'red';
        if (this.tickets.red <= 0 && this.tickets.blue > 0) return 'blue';
        return null;
    }
}
