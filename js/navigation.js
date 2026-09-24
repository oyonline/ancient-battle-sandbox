// 地图静态可见图每种身体半径只建一次；单位保留路线，不逐帧搜索整张地图。
class TerrainNavigation {
    constructor(scene) { this.scene = scene; this.reset(scene.battleOptions?.terrain, scene.battleId); }

    reset(key, battleId) {
        this.key = Terrain.normalize(key); this.battleId = battleId;
        this.graphs = new Map(); this.routes = new Map(); this.queueCounts = { red: [], blue: [] };
        this.lastQueueAt = -Infinity;
        this.stats = { plans: 0, graphBuilds: 0 };
    }

    beginStep(now, units) {
        if (this.key !== 'river' || now - this.lastQueueAt < 500) return;
        this.lastQueueAt = now;
        const bridges = Terrain.geometry(this.key).zones;
        this.queueCounts = { red: bridges.map(() => 0), blue: bridges.map(() => 0) };
        for (const unit of units) {
            if (unit.dead || unit.withdrawn || Math.abs(unit.gx - 35) > 10) continue;
            bridges.forEach((bridge, index) => {
                if (unit.gy >= bridge.y1 - 2 && unit.gy <= bridge.y2 + 2) this.queueCounts[unit.team][index]++;
            });
        }
        // 清除不再参加战斗的单位，缓存不随整局伤亡无限增长。
        for (const unit of this.routes.keys()) if (unit.dead || unit.withdrawn) this.routes.delete(unit);
    }

    graph(radius) {
        if (this.graphs.has(radius)) return this.graphs.get(radius);
        const pad = radius + 0.08, points = [];
        for (const rect of Terrain.geometry(this.key).blockers) {
            const xs = [rect.x1 - pad, rect.x2 + pad];
            if (this.key === 'red_pass') xs.reverse();
            for (const y of [rect.y1 - pad, rect.y2 + pad]) for (const x of xs) {
                if (Terrain.walkable(this.key, x, y, radius)) points.push({ gx: x, gy: y });
            }
        }
        const n = points.length, distances = Array.from({ length: n }, () => Array(n).fill(Infinity));
        const next = Array.from({ length: n }, () => Array(n).fill(-1));
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
            const a = points[i], b = points[j];
            if (Terrain.segmentClear(this.key, a.gx, a.gy, b.gx, b.gy, radius)) {
                distances[i][j] = Math.hypot(a.gx - b.gx, a.gy - b.gy); next[i][j] = j;
            }
        }
        for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
            const candidate = distances[i][k] + distances[k][j];
            if (candidate < distances[i][j] - 1e-9) { distances[i][j] = candidate; next[i][j] = next[i][k]; }
        }
        const graph = { points, distances, next };
        this.graphs.set(radius, graph); this.stats.graphBuilds++;
        return graph;
    }

    riverRoute(unit, goal, radius) {
        const bridges = Terrain.geometry(this.key).zones;
        const direction = goal.gx > unit.gx ? 1 : -1;
        const entryX = direction > 0 ? 32 - radius - 0.12 : 38 + radius + 0.12;
        const exitX = direction > 0 ? 38 + radius + 0.12 : 32 - radius - 0.12;
        let best = null, bestCost = Infinity;
        for (let i = 0; i < bridges.length; i++) {
            const bridge = bridges[i];
            // 桥内锁定当前桥；多条横向槽位让军队排队通过，而非挤向同一个点。
            if (unit.gx > 32 - radius && unit.gx < 38 + radius &&
                (unit.gy < bridge.y1 + radius || unit.gy > bridge.y2 - radius)) continue;
            const width = bridge.y2 - bridge.y1 - 2 * (radius + 0.12);
            const lanes = Math.max(1, Math.floor(width / 0.82));
            if (unit.terrainLaneSeed == null) {
                const x = Math.round(Math.min(unit.gx, 70 - unit.gx) * 1000), y = Math.round(unit.gy * 1000);
                let type = 0; for (const c of unit.type) type = (type * 31 + c.charCodeAt(0)) | 0;
                let seed = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ type) >>> 0;
                seed = Math.imul(seed ^ (seed >>> 16), 0x7feb352d);
                seed = Math.imul(seed ^ (seed >>> 15), 0x846ca68b);
                unit.terrainLaneSeed = (seed ^ (seed >>> 16)) >>> 0;
            }
            const lane = unit.terrainLaneSeed % lanes;
            const y = (bridge.y1 + bridge.y2) / 2 + (lane - (lanes - 1) / 2) * 0.82;
            const entry = { gx: entryX, gy: y }, exit = { gx: exitX, gy: y };
            const inside = unit.gx > 32 - radius && unit.gx < 38 + radius;
            if ((!inside && !Terrain.segmentClear(this.key, unit.gx, unit.gy, entry.gx, entry.gy, radius)) ||
                !Terrain.segmentClear(this.key, exit.gx, exit.gy, goal.gx, goal.gy, radius)) continue;
            const cost = (inside ? Math.hypot(unit.gx - exit.gx, unit.gy - exit.gy) :
                Math.hypot(unit.gx - entry.gx, unit.gy - entry.gy) + Math.abs(exitX - entryX)) +
                Math.hypot(goal.gx - exit.gx, goal.gy - exit.gy) + Math.min(4, (this.queueCounts[unit.team][i] || 0) * 0.04);
            if (cost < bestCost - 1e-9) { bestCost = cost; best = inside ? [exit, goal] : [entry, exit, goal]; }
        }
        return best;
    }

    plan(unit, goal, radius) {
        this.stats.plans++;
        if (this.key === 'river') {
            const river = this.riverRoute(unit, goal, radius);
            if (river) return river;
        }
        const { points, distances, next } = this.graph(radius);
        let best = Infinity, start = -1, end = -1, bestTie = null;
        for (let i = 0; i < points.length; i++) {
            const a = points[i];
            if (!Terrain.segmentClear(this.key, unit.gx, unit.gy, a.gx, a.gy, radius)) continue;
            for (let j = 0; j < points.length; j++) {
                const b = points[j];
                if (!Terrain.segmentClear(this.key, b.gx, b.gy, goal.gx, goal.gy, radius)) continue;
                const cost = Math.hypot(a.gx - unit.gx, a.gy - unit.gy) + distances[i][j] + Math.hypot(b.gx - goal.gx, b.gy - goal.gy);
                const forward = unit.team === 'red' ? -1 : 1;
                const tie = [a.gy, b.gy, a.gx * forward, b.gx * forward];
                const difference = bestTie && tie.findIndex((value, k) => Math.abs(value - bestTie[k]) > 1e-9);
                if (cost < best - 1e-9 || (Number.isFinite(cost) && Math.abs(cost - best) <= 1e-9 &&
                    difference >= 0 && tie[difference] < bestTie[difference])) {
                    best = cost; start = i; end = j; bestTie = tie;
                }
            }
        }
        if (start < 0) return [];
        const route = [points[start]];
        for (let n = 0; start !== end && n < points.length; n++) {
            start = next[start][end];
            if (start < 0) return [];
            route.push(points[start]);
        }
        return [...route, goal];
    }

    nextWaypoint(unit, goalX, goalY, intent = 'walk') {
        if (!Terrain.hasBarriers(this.key)) return { gx: goalX, gy: goalY, direct: true, reachable: true };
        const radius = CombatRules.bodyRadius(unit), now = this.scene.simulationTime || 0;
        const goal = Terrain.projectPoint(this.key, goalX, goalY, radius, unit.team === 'red' ? -1 : 1);
        const direct = Terrain.segmentClear(this.key, unit.gx, unit.gy, goal.gx, goal.gy, radius);
        let cache = this.routes.get(unit);
        // 已入桥的路径不得因目标微动或拥堵快照而换桥；同岸直达则立即释放路线。
        if (direct && !(cache?.bridge && unit.gx > 31.5 && unit.gx < 38.5)) {
            this.routes.delete(unit);
            return { ...goal, direct: true, reachable: true };
        }
        const changed = !cache || cache.intent !== intent || Math.hypot(goal.gx - cache.goal.gx, goal.gy - cache.goal.gy) > 2;
        if (changed && (!cache || now - cache.at >= 500)) {
            cache = { points: this.plan(unit, goal, radius), goal, at: now, intent, bridge: this.key === 'river' };
            this.routes.set(unit, cache);
        }
        if (!cache?.points.length) return { gx: unit.gx, gy: unit.gy, direct: false, reachable: false };
        cache.points[cache.points.length - 1] = goal;
        while (cache.points.length > 1) {
            const point = cache.points[0], next = cache.points[1];
            const close = Math.hypot(unit.gx - point.gx, unit.gy - point.gy) < 0.45;
            const passed = cache.bridge && Math.abs(next.gx - point.gx) > 1 && (unit.gx - point.gx) * (next.gx - point.gx) >= 0;
            if (!(close || passed) || !Terrain.segmentClear(this.key, unit.gx, unit.gy, next.gx, next.gy, radius)) break;
            cache.points.shift();
        }
        const point = cache.points[0];
        if (!Terrain.segmentClear(this.key, unit.gx, unit.gy, point.gx, point.gy, radius)) {
            this.routes.delete(unit);
            return this.nextWaypoint(unit, goalX, goalY, intent);
        }
        return { ...point, direct: false, reachable: true };
    }
}
