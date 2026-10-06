// 阵位部署与进攻路线规划（原 TacticsSystem 部署组，调用面不变）。
import { board } from '../board.js';
import { Terrain } from '../terrain.js';
import { CombatRules } from '../combat.js';
import { dist } from '../units.js';

export const DeployMethods = {
    place(unit, gx, gy) {
        Object.assign(unit, { gx, gy, pgx: gx, pgy: gy, velX: 0, velY: 0 });
    },

    legalPoint(unit, point) {
        if (!point || !Terrain.hasBarriers(this.scene.battleOptions.terrain)) return point;
        return Terrain.projectPoint(this.scene.battleOptions.terrain, point.gx, point.gy,
            CombatRules.bodyRadius(unit), unit.team === 'red' ? -1 : 1);
    },

    legalizeDeployments() {
        const terrain = this.scene.battleOptions.terrain, placed = [];
        // 刚性枪阵优先占位，其他兵的局部修正不能破坏枪阵的槽位拓扑。
        const units = Object.values(this.formations).flatMap(formation => formation.members)
            .concat(this.scene.units.filter(unit => unit.tacticalRole !== 'guard'));
        const free = (unit, p) => Terrain.walkable(terrain, p.gx, p.gy, CombatRules.bodyRadius(unit)) &&
            placed.every(other => dist(p, other) >= CombatRules.contactDistance(unit, other) + 0.005);
        for (const unit of units) {
            let point = this.legalPoint(unit, unit);
            if (!free(unit, point)) {
                const origin = point, f = this.forward(unit.team);
                point = null;
                for (let ring = 1; ring < 90 && !point; ring++) {
                    for (let x = -ring; x <= ring && !point; x++) for (let y = -ring; y <= ring && !point; y++) {
                        if (Math.max(Math.abs(x), Math.abs(y)) !== ring) continue;
                        const candidate = { gx: origin.gx + f * x * 0.8, gy: origin.gy + y * 0.8 };
                        if (free(unit, candidate)) point = candidate;
                    }
                }
                if (!point) throw new Error('新地形没有合法的不重叠部署位置');
            }
            if (point.gx !== unit.gx || point.gy !== unit.gy) {
                this.place(unit, point.gx, point.gy);
                if (unit.guardAnchor) unit.guardAnchor = { ...point };
            }
            placed.push(unit);
        }
    },

    deployGroundGuards(team) {
        const members = this.scene.units.filter(unit => unit.team === team);
        if (!members.length) return;
        const terrain = this.scene.battleOptions.terrain;
        const defense = Terrain.defenseLayout(terrain, team);
        if (defense) { this.deployPassGuards(team, members, defense); return; }
        const hill = terrain === `${team}_hill` ? Terrain.maps[terrain] : null;
        // 只占己方高地；平地和敌方高地仍守己方出发区，不跨场抢占敌人的山顶。
        const cx = hill?.cx ?? (team === 'red' ? 20 : board.W - 20), cy = hill?.cy ?? board.H / 2;
        const f = this.forward(team);
        const front = members.filter(unit => unit.type === 'pikeman').concat(members.filter(unit => unit.type === 'infantry' || unit.type === 'axe'));
        const archers = members.filter(unit => unit.type === 'archer');
        const cavalry = members.filter(unit => unit.type === 'cavalry');
        const placements = [];
        const assign = (unit, gx, gy, radius, protects = false) => placements.push({ unit, gx, gy, radius, protects });
        const frontCols = Math.max(1, Math.ceil(Math.sqrt(front.length * 1.8)));
        front.forEach((unit, index) => assign(unit, cx + f * (5.5 - Math.floor(index / frontCols) * 0.88),
            cy + (index % frontCols - (Math.min(front.length, frontCols) - 1) / 2) * 0.88, 4));
        const archerCols = Math.max(1, Math.ceil(Math.sqrt(archers.length * 1.5)));
        const frontRear = front.length ? 5.5 - (Math.ceil(front.length / frontCols) - 1) * 0.88 : Infinity;
        const archerFront = Math.min(-0.6, frontRear - 1.2);
        archers.forEach((unit, index) => assign(unit, cx + f * (archerFront - Math.floor(index / archerCols) * 0.86),
            cy + (index % archerCols - (Math.min(archers.length, archerCols) - 1) / 2) * 0.86, 1.5));
        const cavalryCols = Math.max(4, Math.ceil(Math.sqrt(Math.ceil(cavalry.length / 2))));
        const cavalryWing = Math.max(6, (Math.min(front.length, frontCols) - 1) * 0.44 + 1.2,
            (Math.min(archers.length, archerCols) - 1) * 0.43 + 1.2);
        cavalry.forEach((unit, index) => {
            const wing = index % 2 ? 1 : -1, position = Math.floor(index / 2);
            // 守骑同样带护弓标志：侧翼反冲与威胁拦截的筛选都认这个标志——
            // 没有它，平地守区的骑兵再好的出击机会也只能全程站桩。
            assign(unit, cx - f * (2.8 + Math.floor(position / cavalryCols) * 1.08), cy + wing * (cavalryWing + position % cavalryCols * 1.08), 6, true);
        });
        // 整体平移入界，不能逐兵 clamp 把后排压到同一个锚点。
        const shift = (values, limit) => {
            const low = Math.min(...values), high = Math.max(...values);
            return low < 2 ? 2 - low : high > limit - 2 ? limit - 2 - high : 0;
        };
        const shiftX = shift(placements.map(point => point.gx), board.W);
        const shiftY = shift(placements.map(point => point.gy), board.H);
        for (const { unit, gx, gy, radius, protects } of placements) {
            this.place(unit, gx + shiftX, gy + shiftY);
            Object.assign(unit, { tacticalRole: 'ground_guard', guardAnchor: { gx: unit.gx, gy: unit.gy },
                guardRadius: radius, groundGuardTarget: null, groundGuardReturning: false,
                ...(protects ? { protectArchers: true, guardLocalRadius: 6 } : {}) });
        }
        this.groundGuards[team] = { team, cx: cx + shiftX, cy: cy + shiftY, members, onHill: !!hill };
    },

    deployPassGuards(team, members, layout) {
        const terrain = this.scene.battleOptions.terrain, f = this.forward(team), spacing = 0.86;
        const front = members.filter(u => u.type === 'pikeman').concat(members.filter(u => u.type === 'infantry' || u.type === 'axe'));
        const archers = members.filter(u => u.type === 'archer'), cavalry = members.filter(u => u.type === 'cavalry');
        const assigned = new Set(members), occupied = new Map();
        const remember = unit => {
            const key = `${Math.floor(unit.gx)},${Math.floor(unit.gy)}`;
            if (!occupied.has(key)) occupied.set(key, []);
            occupied.get(key).push(unit);
        };
        for (const other of this.scene.units) if (!assigned.has(other)) remember(other);
        const free = (unit, gx, gy) => {
            if (gx < 1.5 || gx > board.W - 1.5 || gy < 1.5 || gy > board.H - 1.5 ||
                !Terrain.walkable(terrain, gx, gy, CombatRules.bodyRadius(unit))) return false;
            for (let x = Math.floor(gx) - 1; x <= Math.floor(gx) + 1; x++) {
                for (let y = Math.floor(gy) - 1; y <= Math.floor(gy) + 1; y++) {
                    for (const other of occupied.get(`${x},${y}`) || []) {
                        if (Math.hypot(gx - other.gx, gy - other.gy) < CombatRules.contactDistance(unit, other) + 0.02) return false;
                    }
                }
            }
            return true;
        };
        // 后方溢出格共享一个占位表；禁止逐兵投影到同一个河岸/岩壁边缘。
        const fallback = [];
        const rearEdge = f > 0 ? layout.archerRect.x1 : layout.archerRect.x2;
        for (const origin of [rearEdge - f * spacing, layout.center.gx]) {
            for (let row = 0; row < 40; row++) {
                const gx = origin - f * row * spacing;
                for (let lane = 0; lane < 80; lane++) {
                    const offset = lane ? Math.ceil(lane / 2) * (lane % 2 ? -1 : 1) : 0;
                    const gy = layout.center.gy + offset * spacing;
                    if (gx >= 1.5 && gx <= board.W - 1.5 && gy >= 1.5 && gy <= board.H - 1.5 &&
                        Terrain.walkable(terrain, gx, gy)) fallback.push({ gx, gy });
                }
            }
        }
        const assign = (unit, gx, gy, radius, protects = false) => {
            if (!free(unit, gx, gy)) {
                const point = fallback.find(point => free(unit, point.gx, point.gy));
                if (!point) throw new Error('坡口守军没有合法的不重叠部署位置');
                ({ gx, gy } = point);
            }
            this.place(unit, gx, gy);
            Object.assign(unit, { tacticalRole: 'ground_guard', guardAnchor: { gx, gy }, guardRadius: radius,
                groundGuardTarget: null, groundGuardReturning: false, protectArchers: protects, guardLocalRadius: 6 });
            remember(unit);
        };
        const rect = layout.archerRect;
        const columns = Math.max(1, Math.floor((rect.y2 - rect.y1 - 1.2) / spacing) + 1);
        const archerX = f > 0 ? rect.x2 - 0.6 : rect.x1 + 0.6;
        // 优先保留弓兵平台，人数过多的前排才向合法后方铺开。
        archers.forEach((unit, i) => assign(unit, archerX - f * Math.floor(i / columns) * spacing,
            layout.center.gy + (i % columns - (Math.min(columns, archers.length) - 1) / 2) * spacing, 1.5));
        const line = layout.frontLine;
        const frontColumns = Math.max(1, Math.floor((line.y2 - line.y1) / spacing) + 1);
        front.forEach((unit, i) => assign(unit, line.gx - f * Math.floor(i / frontColumns) * spacing,
            layout.center.gy + (i % frontColumns - (Math.min(frontColumns, front.length) - 1) / 2) * spacing, 4));
        cavalry.forEach((unit, i) => {
            const post = layout.cavalryPosts[i % layout.cavalryPosts.length], index = Math.floor(i / layout.cavalryPosts.length);
            assign(unit, post.gx - f * Math.floor(index / 3) * 1.08, post.gy + (index % 3 - 1) * 1.08, 20, true);
        });
        this.groundGuards[team] = { team, cx: layout.center.gx, cy: layout.center.gy, members,
            archers, layout, onHill: true, archerThreats: [], threatsAt: -Infinity };
    },

    deployGuards(team) {
        const members = this.scene.units.filter(u => u.team === team && u.type === 'pikeman');
        if (!members.length) return;
        const size = Math.ceil(Math.sqrt(members.length)), spacing = 0.86;
        // 守位中心按棋盘宽度镜像：小棋盘（70 格）下与原先的 22 / 48 完全一致，
        // 领土图（260 格）下蓝方不会被甩到红方半场——旧写死的 48 只在小棋盘成立。
        let cx = team === 'red' ? 22 : board.W - 22;
        const cy = board.H / 2, f = this.forward(team);
        const slots = [];
        // 优先填外围；人数不足一圈时，均匀分到各面，仍会留下真实空隙。
        const cells = [];
        for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
            const edges = [row, size - 1 - row, col, size - 1 - col];
            const rank = Math.min(...edges);
            const face = size === 2 ? (row === 0 ? (col === 0 ? 0 : 3) : (col === 0 ? 2 : 1)) : edges.indexOf(rank);
            cells.push({ row, col, rank, face });
        }
        cells.sort((a, b) => a.rank - b.rank || a.row - b.row || a.col - b.col);
        const perimeter = cells.filter(cell => cell.rank === 0).length;
        if (members.length < perimeter) {
            const sides = [0, 1, 2, 3].map(face => cells.filter(cell => cell.rank === 0 && cell.face === face));
            const spread = [];
            while (sides.some(side => side.length)) for (const side of sides) if (side.length) spread.push(side.shift());
            cells.splice(0, perimeter, ...spread);
        }
        cells.slice(0, members.length).forEach((cell, index) => {
            const unit = members[index];
            const slot = {
                index, rank: cell.rank,
                gx: cx - f * (cell.row - (size - 1) / 2) * spacing,
                gy: cy + (cell.col - (size - 1) / 2) * spacing,
                faceX: cell.face === 0 ? f : cell.face === 1 ? -f : 0,
                faceY: cell.face === 2 ? -1 : cell.face === 3 ? 1 : 0,
                unit
            };
            slots.push(slot);
            this.place(unit, slot.gx, slot.gy);
            Object.assign(unit, { tacticalRole: 'guard', formationSlot: slot,
                guardFacingX: slot.faceX, guardFacingY: slot.faceY, guardReady: false,
                guardStableTime: 0, guardSupport: 0 });
        });
        if (Terrain.hasBarriers(this.scene.battleOptions.terrain)) {
            let shift = 0;
            const legal = offset => slots.every(slot => !slot.unit ||
                Terrain.walkable(this.scene.battleOptions.terrain, slot.gx + offset, slot.gy, CombatRules.bodyRadius(slot.unit)));
            while (!legal(shift) && Math.abs(shift) < 30) shift -= f * spacing;
            if (!legal(shift)) throw new Error('枪阵无法整体移到可通行位置');
            if (shift) {
                cx += shift;
                for (const slot of slots) {
                    slot.gx += shift;
                    if (slot.unit) this.place(slot.unit, slot.gx, slot.gy);
                }
            }
        }
        const half = (size - 1) * spacing / 2;
        this.formations[team] = { team, cx, cy, half, slots, members, sparse: members.length < perimeter || members.length < 4,
            nextRefill: 0, breaches: 0, breached: new Set() };
    },

    deployAttackers(team) {
        const members = this.scene.units.filter(u => u.team === team && u.type === 'infantry');
        if (!members.length) return;
        const order = this.orders[team], f = this.forward(team);
        const target = this.formations[this.enemies(team)];
        // 同样按棋盘宽度镜像：小棋盘下 48 / 22 不变，大棋盘下红方守区不会被甩到蓝方半场
        const cx = target?.cx ?? (team === 'red' ? board.W - 22 : 22), cy = target?.cy ?? board.H / 2;
        const half = target?.half ?? 4;
        const home = team === 'red' ? 20 : board.W - 20;
        const reserveCount = Math.min(Math.max(0, this.scene.battleOptions?.reserves?.[team] || 0), members.length - 1);
        const attackers = members.slice(0, members.length - reserveCount);
        const reserve = members.slice(attackers.length);
        const mainCount = order === 'flank' && attackers.length >= 2 ? Math.ceil(attackers.length / 2) : attackers.length;
        const main = attackers.slice(0, mainCount), flank = attackers.slice(mainCount);
        const group = { team, order, main, flank, launched: !flank.length, phase: flank.length ? '迂回中 · 正面保持距离' : '正面推进',
            cx, cy, half, holdX: cx - f * (half + 3.2), home, firstContact: false,
            reserve, committed: 0, reserveWave: 0, engagedAt: null, lastCommit: 0,
            rallyCenter: { gx: cx - f * (half + 10), gy: cy + 2.5 }, safeReserve: [] };
        this.groups[team] = group;
        const columns = Math.max(2, Math.ceil(Math.sqrt(main.length * 1.5)));
        main.forEach((unit, i) => {
            const row = Math.floor(i / columns), col = i % columns;
            const lane = (col - (columns - 1) / 2) * 0.8;
            this.place(unit, home - f * row * 0.8, cy + lane);
            Object.assign(unit, { tacticalRole: 'main', tacticalRow: row, tacticalLane: lane });
        });
        const flankCols = Math.max(2, Math.ceil(Math.sqrt(flank.length)));
        flank.forEach((unit, i) => {
            const row = Math.floor(i / flankCols), col = i % flankCols;
            const lane = (col - (flankCols - 1) / 2) * 0.78;
            const depth = row * 0.78;
            this.place(unit, home - f * (3 + depth), cy + lane);
            // 两段相切的短弧绕过正面，弯入侧翼；不用先走完整个矩形才允许接战。
            const outsideY = cy - half - 3.2 - row * 0.22 - col * 0.12;
            const start = { gx: unit.gx, gy: unit.gy };
            const bend = { gx: cx - f * (half + 2.3), gy: outsideY };
            const end = { gx: cx + f * (half * 0.35 + row * 0.22), gy: cy - half - 0.9 - col * 0.12 };
            unit.tacticalRole = 'flank'; unit.routeIndex = 0;
            unit.route = [
                ...this.curve(start, { gx: start.gx + f * 7, gy: start.gy - 7 },
                    { gx: bend.gx - f * 7, gy: outsideY }, bend),
                ...this.curve(bend, { gx: bend.gx + f * 4, gy: outsideY },
                    { gx: end.gx - f * 1.8, gy: end.gy - 2 }, end)
            ];
            if (Terrain.hasBarriers(this.scene.battleOptions.terrain)) unit.route = unit.route.map(point => this.legalPoint(unit, point));
        });
        const reserveCols = Math.max(2, Math.ceil(Math.sqrt(reserve.length)));
        reserve.forEach((unit, i) => {
            const row = Math.floor(i / reserveCols), col = i % reserveCols;
            const lane = (col - (reserveCols - 1) / 2) * 0.82;
            this.place(unit, home - f * (9 + row * 0.82), cy + 2.5 + lane);
            Object.assign(unit, { tacticalRole: 'reserve', reserveCommitted: false,
                reserveSlot: this.legalPoint(unit, { gx: group.rallyCenter.gx - f * row * 0.82, gy: group.rallyCenter.gy + lane }) });
        });
    },

    curve(start, a, b, end) {
        const points = [];
        const length = Math.hypot(a.gx - start.gx, a.gy - start.gy) + Math.hypot(b.gx - a.gx, b.gy - a.gy) +
            Math.hypot(end.gx - b.gx, end.gy - b.gy);
        const count = Math.max(4, Math.ceil(length / 1.1));
        for (let i = 1; i <= count; i++) {
            const t = i / count, s = 1 - t;
            points.push({ gx: s ** 3 * start.gx + 3 * s * s * t * a.gx + 3 * s * t * t * b.gx + t ** 3 * end.gx,
                gy: s ** 3 * start.gy + 3 * s * s * t * a.gy + 3 * s * t * t * b.gy + t ** 3 * end.gy });
        }
        return points;
    },

    safeAt(team, gx, gy) {
        let safe = true;
        this.scene.forEachNear(gx, gy, 6, other => {
            if (other.team !== team && this.active(other) && Math.hypot(other.gx - gx, other.gy - gy) <= 6) safe = false;
        });
        return safe;
    },

    outsideRoute(unit, destination, group, padding) {
        destination = this.legalPoint(unit, destination);
        const formation = this.formations[this.enemies(unit.team)];
        if (!formation || !formation.members.some(other => this.active(other))) return destination;
        const left = formation.cx - formation.half - padding, right = formation.cx + formation.half + padding;
        const top = formation.cy - formation.half - padding, bottom = formation.cy + formation.half + padding;
        const front = this.forward(unit.team) > 0 ? left - 0.1 : right + 0.1;
        const rear = this.forward(unit.team) > 0 ? right + 0.1 : left - 0.1;
        const inside = point => point.gx > left && point.gx < right && point.gy > top && point.gy < bottom;
        if (inside(unit)) {
            // 已在危险边缘的人先从最近一面退出，不能为了回接应点横穿敌阵。
            const exits = [{ gx: front, gy: unit.gy }, { gx: rear, gy: unit.gy },
                { gx: unit.gx, gy: top - 0.1 }, { gx: unit.gx, gy: bottom + 0.1 }];
            exits.sort((a, b) => dist(unit, a) - dist(unit, b) || dist(a, destination) - dist(b, destination));
            return this.legalPoint(unit, exits[0]);
        }
        const blocked = (a, b) => {
            let enter = 0, leave = 1;
            for (const [origin, delta, low, high] of [[a.gx, b.gx - a.gx, left, right], [a.gy, b.gy - a.gy, top, bottom]]) {
                if (Math.abs(delta) < 1e-9) { if (origin <= low || origin >= high) return false; continue; }
                const first = (low - origin) / delta, last = (high - origin) / delta;
                enter = Math.max(enter, Math.min(first, last)); leave = Math.min(leave, Math.max(first, last));
            }
            return enter < leave - 1e-8 && leave > 0 && enter < 1;
        };
        if (!blocked(unit, destination)) return destination;
        // 只有四个外角的可见图，选最短安全折线；没有逐兵全图寻路。
        const nodes = [unit, destination, { gx: front, gy: top - 0.1 },
            { gx: rear, gy: top - 0.1 }, { gx: front, gy: bottom + 0.1 },
            { gx: rear, gy: bottom + 0.1 }];
        const costs = [0, Infinity, Infinity, Infinity, Infinity, Infinity], previous = [], visited = new Set();
        for (let step = 0; step < nodes.length; step++) {
            let next = -1;
            for (let i = 0; i < nodes.length; i++) if (!visited.has(i) && (next < 0 || costs[i] < costs[next] - 1e-9)) next = i;
            if (next < 0 || !Number.isFinite(costs[next]) || next === 1) break;
            visited.add(next);
            for (let i = 1; i < nodes.length; i++) {
                if (visited.has(i) || blocked(nodes[next], nodes[i])) continue;
                const cost = costs[next] + dist(nodes[next], nodes[i]);
                if (cost < costs[i] - 1e-9) { costs[i] = cost; previous[i] = next; }
            }
        }
        if (!Number.isFinite(costs[1])) return null;
        let first = 1;
        while (previous[first] !== 0 && previous[first] != null) first = previous[first];
        return this.legalPoint(unit, nodes[first]);
    }
};
