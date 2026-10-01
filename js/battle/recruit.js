// ==================== 领土征服征兵与战略 AI（纯模拟，出兵经场景钩子） ====================
// 征兵：扣军费入队 → 训练时长后从老家出兵（场景 spawnTerritoryUnit 钩子）。
// 战略 AI：按目标兵种配比补缺口，缺口并列取固定兵种序——无随机数，
// 红蓝镜像局面下两侧决策一致（换座对称 / 锁步友好）。
// 铁律：本文件不得 import Phaser、不得创建渲染对象。

import { TERRITORY } from './economy.js';
import { UNIT_TYPES } from '../units.js';

export class RecruitSystem {
    constructor(scene) {
        this.scene = scene;                          // 场景钩子：territory.econ / simulationTime / spawnTerritoryUnit / aliveCount
        this.queues = { red: [], blue: [] };
        this.spawned = { red: 0, blue: 0 };
    }

    // 入队即扣费（训练中钱已花掉）；队列满 / 钱不够 / 在场+队列超过兵种上限均拒绝。
    enqueue(team, type) {
        if (!this.queues[team] || (type === 'worker' && !this.scene.battleOptions?.territory)) return false;
        const econ = this.scene.territory.econ;
        const queue = this.queues[team];
        if (queue.length >= TERRITORY.QUEUE_CAP) return false;
        if (!econ.canAfford(team, type)) return false;
        const typeData = UNIT_TYPES[type];
        const aliveOfType = this.scene.aliveCount(team, type) + queue.filter(item => item.type === type).length;
        if (!typeData || typeData.maxCount <= 0 || aliveOfType >= typeData.maxCount) return false;
        const cost = econ.costOf(type);
        econ.treasury[team] -= cost;
        econ.spent[team] += cost;
        queue.push({ type, readyAt: this.scene.simulationTime + TERRITORY.TRAIN_MS[type] });
        return true;
    }

    // 到点出兵；在场达到 ALIVE_CAP 时暂扣在队里（不弃单），腾出名额立即补上。
    update() {
        for (const team of ['red', 'blue']) {
            const queue = this.queues[team];
            while (queue.length && queue[0].readyAt <= this.scene.simulationTime + 1e-7) {
                if (this.scene.aliveCount(team) >= TERRITORY.ALIVE_CAP) break;
                const item = queue.shift();
                this.scene.spawnTerritoryUnit(team, item.type);
                this.spawned[team]++;
            }
        }
    }
}

// 朴素战略 AI：目标配比 步兵45% / 弓25% / 枪20% / 骑10% / 医师5%。
// 每 AI_INTERVAL_MS 决策一次：按"在场+队列"计数找缺口最大的兵种，
// 买得起就补一个；买不起就攒钱（不降级乱买）。
export class TerritoryAI {
    static MIX = { infantry: 0.45, pikeman: 0.2, archer: 0.25, cavalry: 0.1, medic: 0.05 };
    static ORDER = ['infantry', 'archer', 'pikeman', 'cavalry', 'medic'];   // 缺口并列时的固定决胜序

    constructor(scene, team) {
        this.scene = scene;
        this.team = team;
        this.nextThink = 0;
    }

    update(now) {
        if (now < this.nextThink) return;
        this.nextThink = now + TERRITORY.AI_INTERVAL_MS;
        const scene = this.scene;
        const recruit = scene.territory.recruit;
        if (recruit.queues[this.team].length >= TERRITORY.QUEUE_CAP) return;

        const counts = {};
        let total = 0;
        for (const unit of scene._aliveArr) {
            if (unit.team !== this.team || !(unit.type in TerritoryAI.MIX)) continue;
            counts[unit.type] = (counts[unit.type] || 0) + 1;
            total++;
        }
        for (const item of recruit.queues[this.team]) {
            if (!(item.type in TerritoryAI.MIX)) continue;
            counts[item.type] = (counts[item.type] || 0) + 1;
            total++;
        }
        // 缺口按配比 × 兵力基数计算。基数下限 24：战损后 army 缩水时不停止采购
        // （否则缺口恒小于 1，军费堆到几千也不补兵——平衡探针实测的囤钱问题）。
        const base = Math.max(total, 24);
        let best = null, bestDeficit = 0;
        for (const type of TerritoryAI.ORDER) {
            const deficit = TerritoryAI.MIX[type] * base - (counts[type] || 0);
            if (deficit > bestDeficit + 1e-9) { bestDeficit = deficit; best = type; }
        }
        // Reserve a pending field fort's cost; continuous troop spending must not starve construction forever.
        const reserve = scene.territory.camps?.aiSavingsBudget(this.team) ?? 0;
        if (best && bestDeficit >= 1 && scene.territory.econ.treasury[this.team] >= reserve + scene.territory.econ.costOf(best)) recruit.enqueue(this.team, best);
        else if (scene.territory.econ.treasury[this.team] > 400) recruit.enqueue(this.team, 'infantry');   // 富余：补兵线
    }
}
