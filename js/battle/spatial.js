// ==================== 战场空间哈希（纯模拟，不碰渲染） ====================
// 每 3×3 格一个桶，索敌/碰撞只查附近桶，千人规模避免 O(n²)。
// 从 game.js IsoBattleScene 抽出（第 0 批地基 2/4）；桶坐标按确定性约定量化
// （docs/DETERMINISM.md）：格边上的采样点两座位查同一组桶，镜像不发散。

import { GRID_W, GRID_H } from '../board.js';
import { quantizeBucketCoord } from './determinism.js';

export const SP_CELL = 3;

export class BattleSpatialIndex {
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
            const k = quantizeBucketCoord(u.gx, SP_CELL) * 512 + quantizeBucketCoord(u.gy, SP_CELL);
            let bucket = this.grid.get(k);
            if (!bucket) { bucket = []; this.grid.set(k, bucket); }
            bucket.push(u);
            if (u.team === 'red') { rN++; rX += u.gx; rY += u.gy; }
            else { bN++; bX += u.gx; bY += u.gy; }
        }
        this.redAlive = rN;
        this.blueAlive = bN;
        this.centroid.red.x = rN ? rX / rN : GRID_W / 2;
        this.centroid.red.y = rN ? rY / rN : GRID_H / 2;
        this.centroid.blue.x = bN ? bX / bN : GRID_W / 2;
        this.centroid.blue.y = bN ? bY / bN : GRID_H / 2;
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
