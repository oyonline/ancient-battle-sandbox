// ==================== 战场空间哈希（纯模拟，不碰渲染） ====================
// 每 3×3 格一个桶，索敌/碰撞只查附近桶，千人规模避免 O(n²)。
// 从 game.js IsoBattleScene 抽出（第 0 批地基 2/4）；桶坐标按确定性约定量化
// （docs/DETERMINISM.md）：格边上的采样点两座位查同一组桶，镜像不发散。

import { board } from '../board.js';
import { quantizeBucketCoord } from './determinism.js';
import { TEAMS, isHostile } from '../factions.js';

export const SP_CELL = 3;
const NEAREST_GROUP_SIZE = 16;

export class BattleSpatialIndex {
    constructor() {
        this.grid = new Map();      // 桶数组复用（length=0 清空），每帧零分配
        this.alive = [];            // 存活单位数组（每帧重建）
        this.teamBounds = new Map(); // 实际有兵的桶范围：远处索敌无需遍历整片空桶
        this.nearestGroups = [];    // 按 alive 原顺序分组，不重排 1e-9 平局候选
        this.nearestGroupCount = 0;
        // 逐队聚合：aliveByTeam/_sum 为三方通用存储；redAlive/blueAlive/blackAlive 为兼容别名。
        this.aliveByTeam = { red: 0, blue: 0, black: 0 };
        this._sum = { red: { x: 0, y: 0 }, blue: { x: 0, y: 0 }, black: { x: 0, y: 0 } };
        this.redAlive = 0;
        this.blueAlive = 0;
        this.blackAlive = 0;
        this.centroid = { red: { x: 0, y: 0 }, blue: { x: 0, y: 0 }, black: { x: 0, y: 0 } };
    }

    // 顺带聚合存活数与双方重心；units 含阵亡/撤离单位，逐帧过滤
    rebuild(units) {
        for (const arr of this.grid.values()) arr.length = 0;
        const alive = this.alive;
        alive.length = 0;
        this.nearestGroupCount = 0;
        for (const bounds of this.teamBounds.values()) {
            bounds.minX = bounds.minY = Infinity;
            bounds.maxX = bounds.maxY = -Infinity;
        }
        let rN = 0, bN = 0;
        const counts = this.aliveByTeam, sums = this._sum;
        for (const team of TEAMS) { counts[team] = 0; sums[team].x = 0; sums[team].y = 0; }
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            if (u.dead || u.withdrawn) continue;
            alive.push(u);
            const groupIndex = Math.floor((alive.length - 1) / NEAREST_GROUP_SIZE);
            let group = this.nearestGroups[groupIndex];
            if (!group) {
                group = {}; this.nearestGroups[groupIndex] = group;
            }
            if ((alive.length - 1) % NEAREST_GROUP_SIZE === 0) {
                this.nearestGroupCount++;
                group.minX = group.maxX = u.gx; group.minY = group.maxY = u.gy;
                group.team = u.team;
                group.hasGarrison = !!u.garrisonTowerId;
            } else {
                group.minX = Math.min(group.minX, u.gx); group.maxX = Math.max(group.maxX, u.gx);
                group.minY = Math.min(group.minY, u.gy); group.maxY = Math.max(group.maxY, u.gy);
                if (group.team !== u.team) group.team = null;
                if (u.garrisonTowerId) group.hasGarrison = true;
            }
            if (!u.garrisonTowerId) {
                const cx = quantizeBucketCoord(u.gx, SP_CELL), cy = quantizeBucketCoord(u.gy, SP_CELL);
                const k = cx * 512 + cy;
                let bucket = this.grid.get(k);
                if (!bucket) { bucket = []; this.grid.set(k, bucket); }
                bucket.push(u);
                let bounds = this.teamBounds.get(u.team);
                if (!bounds) {
                    bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
                    this.teamBounds.set(u.team, bounds);
                }
                bounds.minX = Math.min(bounds.minX, cx); bounds.maxX = Math.max(bounds.maxX, cx);
                bounds.minY = Math.min(bounds.minY, cy); bounds.maxY = Math.max(bounds.maxY, cy);
            }
            // 逐队聚合存活数与重心：已知阵营按各自桶计；未知阵营沿用旧口径（并入蓝方）。
            const slot = Object.hasOwn(counts, u.team) ? u.team : 'blue';
            counts[slot]++; sums[slot].x += u.gx; sums[slot].y += u.gy;
        }
        const centerX = board.W / 2, centerY = board.H / 2;
        for (const team of TEAMS) {
            const n = counts[team];
            this.centroid[team].x = n ? sums[team].x / n : centerX;
            this.centroid[team].y = n ? sums[team].y / n : centerY;
        }
        rN = counts.red; bN = counts.blue;
        this.redAlive = rN;
        this.blueAlive = bN;
        this.blackAlive = counts.black;
    }

    // 指定阵营的「敌人合力重心」：按敌对关系把各敌队的存活重心按人数加权合并。
    // 三方模式下黑方的敌人是红蓝两家，此处天然得到两军联合重心；无敌人时回地图中心。
    enemyCentroid(scene, team) {
        const counts = this.aliveByTeam, sums = this._sum;
        let n = 0, x = 0, y = 0;
        for (const other of TEAMS) {
            if (!isHostile(scene, team, other)) continue;
            const c = counts[other] || 0;
            if (!c) continue;
            n += c; x += sums[other].x; y += sums[other].y;
        }
        return n ? { x: x / n, y: y / n } : { x: board.W / 2, y: board.H / 2 };
    }

    // 只供 planningStep 使用：战斗核先规划全部单位，再统一位移，期间这些包围盒有效。
    // 非规划调用仍走原 alive 实时扫描，避免移动后尚未 rebuild 时误用旧坐标边界。
    // 保持原 alive 顺序，并给 1e-9 同距规则保留余量；不排序、不缓存选中的目标。
    nearestGroundEnemy(unit, best, bestD2) {
        const alive = this.alive;
        for (let n = 0; n < this.nearestGroupCount; n++) {
            const group = this.nearestGroups[n];
            if (!isHostile(unit.scene, unit.team, group.team)) continue;
            const dx = Math.max(group.minX - unit.gx, 0, unit.gx - group.maxX);
            const dy = Math.max(group.minY - unit.gy, 0, unit.gy - group.maxY);
            // 定时攻寨可能在规划开头摧毁箭塔并把驻军立即放到地面；该组读实时坐标。
            if (!group.hasGarrison && dx * dx + dy * dy > bestD2 + 1e-9) continue;
            const end = Math.min(alive.length, (n + 1) * NEAREST_GROUP_SIZE);
            for (let i = n * NEAREST_GROUP_SIZE; i < end; i++) {
                const e = alive[i];
                if (!isHostile(unit.scene, unit.team, e.team) || e.dead || e.withdrawn || e.garrisonTowerId || e.type === 'wagon') continue;
                const dx = e.gx - unit.gx, dy = e.gy - unit.gy, d2 = dx * dx + dy * dy;
                if (d2 < bestD2 - 1e-9 || (Math.abs(d2 - bestD2) <= 1e-9 && (!best || e.id < best.id))) {
                    bestD2 = d2; best = e;
                }
            }
        }
        return best;
    }

    // 同一空间快照、同一桶遍历顺序，只裁掉不含敌队的边缘空桶。
    // 地面成员资格按 rebuild 固定；距离、阵亡及撤离仍由调用方读实时字段。
    forEachEnemyNear(unit, r, fn) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [team, bounds] of this.teamBounds) {
            if (!isHostile(unit.scene, unit.team, team)) continue;
            minX = Math.min(minX, bounds.minX); maxX = Math.max(maxX, bounds.maxX);
            minY = Math.min(minY, bounds.minY); maxY = Math.max(maxY, bounds.maxY);
        }
        const c0x = Math.max(minX, quantizeBucketCoord(unit.gx - r, SP_CELL));
        const c1x = Math.min(maxX, quantizeBucketCoord(unit.gx + r, SP_CELL));
        const c0y = Math.max(minY, quantizeBucketCoord(unit.gy - r, SP_CELL));
        const c1y = Math.min(maxY, quantizeBucketCoord(unit.gy + r, SP_CELL));
        for (let cx = c0x; cx <= c1x; cx++) {
            for (let cy = c0y; cy <= c1y; cy++) {
                const bucket = this.grid.get(cx * 512 + cy);
                if (!bucket) continue;
                for (let i = 0; i < bucket.length; i++) fn(bucket[i]);
            }
        }
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
