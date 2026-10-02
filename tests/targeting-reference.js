// Frozen pre-optimization oracle from 0c7a781. Do not optimize this fixture.
import { battleProjection } from '../js/net/lockstep.js';

// Compare exact primitive simulation state as well as the territory network projection.
// Unit references are represented by ID; Phaser objects/functions are omitted.
export function targetingStateProjection(scene) {
    return JSON.stringify({
        time: scene.simulationTime,
        units: scene.units.map(unit => Object.fromEntries(Object.keys(unit).sort().flatMap(key => {
            if (key === 'bobPhase' || key === 'slideOff') return []; // spawn-only visual randomness
            const value = unit[key];
            if (value === null || ['number', 'string', 'boolean'].includes(typeof value)) return [[key, value]];
            if (value && ['target', 'meleeTarget', 'flankTarget'].includes(key)) return [[key, value.id]];
            return [];
        }))),
        arrows: scene.arrows.map(arrow => ({ ...arrow, source: arrow.source?.id })),
        report: scene.getBattleReport(),
        territory: scene.territory ? battleProjection(scene) : null
    });
}
// ==================== 战场空间哈希（纯模拟，不碰渲染） ====================
// 每 3×3 格一个桶，索敌/碰撞只查附近桶，千人规模避免 O(n²)。
// 从 game.js IsoBattleScene 抽出（第 0 批地基 2/4）；桶坐标按确定性约定量化
// （docs/DETERMINISM.md）：格边上的采样点两座位查同一组桶，镜像不发散。

import { board } from '../js/board.js';
import { quantizeBucketCoord } from '../js/battle/determinism.js';

const SP_CELL = 3;

export class ReferenceSpatialIndex {
    constructor() {
        this.grid = new Map();      // 桶数组复用（length=0 清空），每帧零分配
        this.alive = [];            // 存活单位数组（每帧重建）
        this.redAlive = 0;
        this.blueAlive = 0;
        this.centroid = { red: { x: 0, y: 0 }, blue: { x: 0, y: 0 } };
    }

    // 顺带聚合存活数与双方重心；units 含阵亡/撤离单位，逐帧过滤
    rebuild(units) {
        for (const arr of this.grid.values()) arr.length = 0;
        const alive = this.alive;
        alive.length = 0;
        let rN = 0, bN = 0, rX = 0, rY = 0, bX = 0, bY = 0;
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            if (u.dead || u.withdrawn) continue;
            alive.push(u);
            if (!u.garrisonTowerId) {
                const k = quantizeBucketCoord(u.gx, SP_CELL) * 512 + quantizeBucketCoord(u.gy, SP_CELL);
                let bucket = this.grid.get(k);
                if (!bucket) { bucket = []; this.grid.set(k, bucket); }
                bucket.push(u);
            }
            if (u.team === 'red') { rN++; rX += u.gx; rY += u.gy; }
            else { bN++; bX += u.gx; bY += u.gy; }
        }
        this.redAlive = rN;
        this.blueAlive = bN;
        this.centroid.red.x = rN ? rX / rN : board.W / 2;
        this.centroid.red.y = rN ? rY / rN : board.H / 2;
        this.centroid.blue.x = bN ? bX / bN : board.W / 2;
        this.centroid.blue.y = bN ? bY / bN : board.H / 2;
    }

    // 遍历 (gx,gy) 半径 r 覆盖的所有桶内单位（方形覆盖 ⊇ 圆形，距离由调用方判定）
    forEachNear(gx, gy, r, fn) {
        const c0x = quantizeBucketCoord(gx - r, SP_CELL), c1x = quantizeBucketCoord(gx + r, SP_CELL);
        const c0y = quantizeBucketCoord(gy - r, SP_CELL), c1y = quantizeBucketCoord(gy + r, SP_CELL);
        for (let cx = c0x; cx <= c1x; cx++) {
            for (let cy = c0y; cy <= c1y; cy++) {
                const bucket = this.grid.get(cx * 512 + cy);
                if (!bucket) continue;
                for (let i = 0; i < bucket.length; i++) fn(bucket[i]);
            }
        }
    }
}

// 最近敌人：环形扩张搜索；查到半径 r 内的最佳解即全局最近（圆内 ⊆ 查询方形）。
// 辎重车不可被攻击（劫持玩法）：战斗围绕车身控制权，不围绕拆车——
// 劫掠方的得分手段是把车"劫走"（updateConvoy 的拔河），不是把车砍烂。
// 平局按 id 最小决胜，保证两座位选择一致（docs/DETERMINISM.md）。
export function referenceNearestEnemy(spatial, unit) {
    let best = null, bestD2 = Infinity, r = 6;
    const maxR = board.W + board.H;
    while (true) {
        spatial.forEachNear(unit.gx, unit.gy, r, e => {
            if (e.team === unit.team || e.dead || e.withdrawn || e.type === 'wagon') return;
            const dx = e.gx - unit.gx, dy = e.gy - unit.gy;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2 - 1e-9 || (Math.abs(d2 - bestD2) <= 1e-9 && (!best || e.id < best.id))) { bestD2 = d2; best = e; }
        });
        if (best && bestD2 <= r * r) return best;
        // Across the large territory map, expanding to hundreds of cells visits
        // tens of thousands of empty buckets per soldier. An exact scan of the
        // bounded alive list is cheaper once the nearby circles found no answer.
        // It uses the same distance/id ordering, so this changes work, not targets.
        if (r >= 24 && Array.isArray(spatial.alive)) {
            for (const e of spatial.alive) {
                if (e.team === unit.team || e.dead || e.withdrawn || e.garrisonTowerId || e.type === 'wagon') continue;
                const dx = e.gx - unit.gx, dy = e.gy - unit.gy, d2 = dx * dx + dy * dy;
                if (d2 < bestD2 - 1e-9 || (Math.abs(d2 - bestD2) <= 1e-9 && (!best || e.id < best.id))) {
                    bestD2 = d2; best = e;
                }
            }
            return best;
        }
        if (r >= maxR) return best;
        r *= 2;
    }
}
