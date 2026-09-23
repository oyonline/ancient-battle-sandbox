// 战术只在明确选择时启用；所有指令共用 CombatRules 的接触与命中规则。
// 阵位、路线与命中都使用模拟坐标/时钟，画面与音效不参与胜负。
const TACTIC_LABELS = { advance: '自由接敌', assault: '正面强攻', flank: '单翼迂回', hold: '枪阵守位' };

class TacticsSystem {
    constructor(scene, orders) {
        this.scene = scene;
        this.orders = { red: orders.red || 'advance', blue: orders.blue || 'advance' };
        this.formations = {};
        this.groups = {};
        this.metrics = { thrusts: 0, blocked: 0, deflections: 0, replacements: 0 };
        // 先布置防阵，再按真实边界规划进攻路线。
        for (const team of ['red', 'blue']) {
            if (this.orders[team] === 'hold') this.deployGuards(team);
        }
        for (const team of ['red', 'blue']) {
            if (['assault', 'flank'].includes(this.orders[team]) || this.scene.battleOptions?.reserves?.[team] > 0) {
                this.deployAttackers(team);
            }
        }
    }

    active(unit) { return !unit.dead && !unit.withdrawn && unit.moraleState !== 'routing'; }
    enemies(team) { return team === 'red' ? 'blue' : 'red'; }
    forward(team) { return team === 'red' ? 1 : -1; }

    place(unit, gx, gy) {
        Object.assign(unit, { gx, gy, pgx: gx, pgy: gy, velX: 0, velY: 0 });
    }

    deployGuards(team) {
        const members = this.scene.units.filter(u => u.team === team && u.type === 'pikeman');
        if (!members.length) return;
        const size = Math.ceil(Math.sqrt(members.length)), spacing = 0.86;
        const cx = team === 'red' ? 22 : 48, cy = GRID_H / 2, f = this.forward(team);
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
        const half = (size - 1) * spacing / 2;
        this.formations[team] = { team, cx, cy, half, slots, members, sparse: members.length < perimeter || members.length < 4,
            nextRefill: 0, breaches: 0, breached: new Set() };
    }

    deployAttackers(team) {
        const members = this.scene.units.filter(u => u.team === team && u.type === 'infantry');
        if (!members.length) return;
        const order = this.orders[team], f = this.forward(team);
        const target = this.formations[this.enemies(team)];
        const cx = target?.cx ?? (team === 'red' ? 48 : 22), cy = target?.cy ?? GRID_H / 2;
        const half = target?.half ?? 4;
        const home = team === 'red' ? 20 : 50;
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
        });
        const reserveCols = Math.max(2, Math.ceil(Math.sqrt(reserve.length)));
        reserve.forEach((unit, i) => {
            const row = Math.floor(i / reserveCols), col = i % reserveCols;
            const lane = (col - (reserveCols - 1) / 2) * 0.82;
            this.place(unit, home - f * (9 + row * 0.82), cy + 2.5 + lane);
            Object.assign(unit, { tacticalRole: 'reserve', reserveCommitted: false,
                reserveSlot: { gx: group.rallyCenter.gx - f * row * 0.82, gy: group.rallyCenter.gy + lane } });
        });
    }

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
    }

    safeAt(team, gx, gy) {
        let safe = true;
        this.scene.forEachNear(gx, gy, 6, other => {
            if (other.team !== team && this.active(other) && Math.hypot(other.gx - gx, other.gy - gy) <= 6) safe = false;
        });
        return safe;
    }

    reserveSupport(unit) {
        const group = this.groups[unit.team];
        return !!group && this.safeAt(unit.team, unit.gx, unit.gy) &&
            group.safeReserve.filter(other => other !== unit && this.active(other) && other.moraleState === 'steady' &&
                !other.reserveCommitted && dist(unit, other) <= 5 && this.safeAt(other.team, other.gx, other.gy)).length >= 3;
    }

    rallyPoint(unit) {
        const group = this.groups[unit.team];
        const reserves = group?.safeReserve.filter(other => this.active(other) && !other.reserveCommitted &&
            other.moraleState === 'steady' && this.safeAt(other.team, other.gx, other.gy)) || [];
        if (reserves.length < 3) return null;
        const anchors = reserves.filter(candidate => reserves.filter(other => dist(candidate, other) <= 4).length >= 3);
        anchors.sort((a, b) => {
            const delta = dist(unit, a) - dist(unit, b);
            return Math.abs(delta) > 1e-9 ? delta : a.id - b.id;
        });
        if (!anchors.length) return null;
        const center = { gx: anchors[0].gx, gy: anchors[0].gy };
        const f = this.forward(unit.team);
        // 已绕到侧后的溃兵先沿方阵外侧退回，接应点不能诱导他们横穿整座敌阵。
        if ((unit.gx - group.cx) * f > -group.half - 2.5) {
            const sign = unit.gy <= group.cy ? -1 : 1;
            const outsideY = group.cy + sign * (group.half + 7);
            if (Math.abs(unit.gy - group.cy) < group.half + 6.5) return { gx: unit.gx, gy: outsideY };
            return { gx: group.cx - f * (group.half + 3.5), gy: outsideY };
        }
        return center;
    }

    updateReserves(group, now) {
        if (!group.reserve.length) return;
        group.safeReserve = group.reserve.filter(unit => this.active(unit) && !unit.reserveCommitted &&
            unit.moraleState === 'steady' && this.safeAt(unit.team, unit.gx, unit.gy));
        const front = [...group.main, ...group.flank, ...group.reserve.filter(unit => unit.reserveCommitted)];
        const ready = front.filter(unit => this.active(unit));
        const routing = front.filter(unit => !unit.dead && !unit.withdrawn && unit.moraleState === 'routing').length;
        if (group.engagedAt == null && (front.some(unit => unit.dead || unit.everRouted) || ready.some(unit => {
            const enemy = this.scene.nearestEnemy(unit);
            return enemy && dist(unit, enemy) < 2.5;
        }))) group.engagedAt = now;
        if (group.engagedAt == null) return;
        const waiting = group.reserve.filter(unit => this.active(unit) && !unit.reserveCommitted);
        if (!waiting.length || now - group.lastCommit < 8000) return;
        const initial = group.main.length + group.flank.length;
        const elapsed = now - group.engagedAt;
        let commit = false;
        if (group.reserveWave === 0) commit = routing >= 8 || ready.length <= initial * 0.82 || elapsed >= 18000;
        else if (group.reserveWave === 1) commit = routing >= 15 || ready.length <= initial * 0.6 || now - group.lastCommit >= 30000;
        else commit = ready.length <= Math.max(4, waiting.length * 0.8) || (elapsed >= 90000 && routing === 0);
        if (!commit) return;
        const amount = group.reserveWave < 2 ? Math.max(1, Math.ceil(group.reserve.length * 0.4)) : waiting.length;
        for (const unit of waiting.slice(0, amount)) unit.reserveCommitted = true;
        group.committed += Math.min(amount, waiting.length);
        group.reserveWave++; group.lastCommit = now;
        group.phase = group.reserveWave < 3 ? '预备队分批增援 · 后队收拢溃兵' : '最后预备队投入 · 全军再战';
        this.scene.addBattleEvent(`tactic-reserve-${group.team}-${group.reserveWave}`,
            `${group.team === 'red' ? '红方' : '蓝方'}投入${Math.min(amount, waiting.length)}名预备队`, group.team);
    }

    beginStep(dt) {
        const now = this.scene.simulationTime;
        for (const formation of Object.values(this.formations)) {
            for (const unit of formation.members) if (!this.active(unit)) {
                unit.guardReady = false; unit.guardStableTime = 0; unit.braceReady = false;
            }
            const guards = formation.members.filter(u => this.active(u));
            for (const guard of guards) {
                const slot = guard.formationSlot;
                const closest = this.scene.nearestEnemy(guard);
                guard.tacticNearest = closest;
                const dx = closest ? closest.gx - guard.gx : 0, dy = closest ? closest.gy - guard.gy : 0;
                const enemyBehind = closest && dist(guard, closest) < 1.1 && dx * slot.faceX + dy * slot.faceY < -0.12;
                this.turnGuard(guard, enemyBehind ? dx : slot.faceX, enemyBehind ? dy : slot.faceY, dt);
                const atSlot = Math.hypot(guard.gx - slot.gx, guard.gy - slot.gy) < 0.24;
                let support = 0, depth = 0;
                this.scene.forEachNear(guard.gx, guard.gy, 1.7, other => {
                    if (other === guard || other.team !== guard.team || other.tacticalRole !== 'guard' || !this.active(other)) return;
                    if (dist(guard, other) < 1.65) support++;
                    if (dist(guard, other) < 1.7 && (other.gx - guard.gx) * guard.guardFacingX +
                        (other.gy - guard.gy) * guard.guardFacingY < -0.3) depth++;
                });
                guard.guardSupport = support;
                const aligned = guard.guardFacingX * slot.faceX + guard.guardFacingY * slot.faceY > 0.94;
                guard.guardStableTime = !guard.moving && !enemyBehind && atSlot && aligned && support >= 2
                    ? Math.min(0.65, guard.guardStableTime + dt) : 0;
                guard.guardReady = guard.guardStableTime >= 0.65 - 1e-9;
                // 既有骑兵迎击读取同一架枪状态；不另叠一份伤害或护甲。
                guard.braceFacingX = guard.guardFacingX; guard.braceFacingY = guard.guardFacingY;
                guard.braceReady = guard.guardReady; guard.braceSupport = support;
                guard.braceDepth = Math.min(1, depth);
            }
            if (now >= formation.nextRefill) {
                formation.nextRefill = now + 200;
                this.refill(formation, guards);
            }
        }
        for (const group of Object.values(this.groups)) {
            this.updateReserves(group, now);
            if (!group.launched) {
                const flank = group.flank.filter(u => this.active(u));
                const arrived = flank.filter(u => u.routeIndex >= u.route.length).length;
                const intercepted = flank.some(u => u.tacticalContact);
                if (!flank.length || arrived >= Math.ceil(flank.length * 0.8) || intercepted || now >= 45000) {
                    group.launched = true;
                    group.phase = intercepted ? '迂回队遭遇拦截 · 正面接应' : arrived ? '侧后到位 · 两面接战' : '迂回受阻 · 转入接战';
                    this.scene.addBattleEvent('tactic-launch-' + group.team, `${group.team === 'red' ? '红方' : '蓝方'}${group.phase}`, group.team);
                }
            }
            if (group.launched && group.flank.length && group.flank.every(u => !this.active(u))) group.phase = '迂回队失去战力 · 正面继续接战';
        }
    }

    refill(formation, guards) {
        let replacements = 0;
        for (const slot of formation.slots) {
            if (slot.rank !== 0 || (slot.unit && this.active(slot.unit))) continue;
            if (!formation.breached.has(slot.index)) {
                formation.breached.add(slot.index); formation.breaches++;
                this.scene.addBattleEvent('tactic-gap-' + formation.team, `${formation.team === 'red' ? '红方' : '蓝方'}枪阵出现缺口，后排尝试补位`, formation.team);
            }
            if (replacements >= 2) continue;
            let occupied = false;
            this.scene.forEachNear(slot.gx, slot.gy, 0.85, other => {
                if (other.team !== formation.team && this.active(other) && Math.hypot(other.gx - slot.gx, other.gy - slot.gy) < 0.85) occupied = true;
            });
            if (occupied) continue;
            const candidates = guards.filter(u => u.formationSlot.rank > 0 && Math.hypot(u.gx - slot.gx, u.gy - slot.gy) < 2.8);
            candidates.sort((a, b) => {
                const delta = Math.hypot(a.gx - slot.gx, a.gy - slot.gy) - Math.hypot(b.gx - slot.gx, b.gy - slot.gy);
                return Math.abs(delta) > 1e-9 ? delta : a.id - b.id;
            });
            const replacement = candidates[0];
            if (!replacement) continue;
            const vacated = replacement.formationSlot, displaced = slot.unit;
            // 溃兵重整后返回预备位置，不能与补位者争同一阵位。
            vacated.unit = displaced && !displaced.dead && !displaced.withdrawn ? displaced : null;
            if (vacated.unit) {
                displaced.formationSlot = vacated;
                displaced.guardReady = false; displaced.guardStableTime = 0; displaced.braceReady = false;
            }
            replacement.formationSlot = slot; slot.unit = replacement;
            replacement.guardReady = false; replacement.guardStableTime = 0; replacement.braceReady = false;
            replacements++; this.metrics.replacements++;
        }
    }

    turnGuard(unit, fx, fy, dt) {
        const wanted = Math.atan2(fy, fx), current = Math.atan2(unit.guardFacingY, unit.guardFacingX);
        let delta = Math.atan2(Math.sin(wanted - current), Math.cos(wanted - current));
        if (Math.abs(delta) < 1e-9) {
            const length = Math.hypot(fx, fy);
            unit.guardFacingX = fx / length; unit.guardFacingY = fy / length;
            return;
        }
        delta = clamp(delta, -2.6 * dt, 2.6 * dt);
        unit.guardFacingX = Math.cos(current + delta); unit.guardFacingY = Math.sin(current + delta);
    }

    updateUnit(unit, now, dt) {
        if (unit.tacticalRole === 'guard') { this.updateGuard(unit, now, dt); return true; }
        if (!['main', 'flank', 'reserve'].includes(unit.tacticalRole)) return false;
        const group = this.groups[unit.team];
        const enemy = this.scene.nearestEnemy(unit);
        if (!enemy) return true;
        if (unit.everRallied && !unit.tacticalRejoined) {
            unit.tacticalRejoined = true;
            unit.tacticalContact = true;
            if (unit.route) unit.routeIndex = unit.route.length;
        }
        if (unit.tacticalRole === 'reserve' && !unit.reserveCommitted) {
            if (dist(unit, enemy) < 2.5) {
                // 接应队确实被冲到面前时自卫；不享受永久安全或额外战斗属性。
                this.fight(unit, enemy, now, dt, unit.typeData.range);
            } else {
                const slot = unit.reserveSlot;
                if (Math.hypot(unit.gx - slot.gx, unit.gy - slot.gy) > 0.2) {
                    this.move(unit, slot.gx, slot.gy, unit.typeData.speed, dt);
                }
            }
            return true;
        }
        if (unit.tacticalRole === 'flank' && unit.routeIndex < unit.route.length && !unit.tacticalContact) {
            const atSide = Math.abs(unit.gy - group.cy) > group.half + 0.3 &&
                (unit.gx - group.cx) * this.forward(unit.team) > -group.half - 1.5;
            const opening = atSide && dist(unit, enemy) < 3.5 &&
                (enemy.tacticalRole !== 'guard' || !enemy.guardReady || !this.inFacing(enemy, unit));
            // 近处发生拦截，或侧面出现真实空隙时，顺路切入；不被远处目标吸回正面。
            if (dist(unit, enemy) < 1.3 || opening) {
                unit.tacticalContact = true;
            } else {
                while (unit.routeIndex < unit.route.length &&
                    Math.hypot(unit.gx - unit.route[unit.routeIndex].gx, unit.gy - unit.route[unit.routeIndex].gy) < 0.45) {
                    unit.routeIndex++;
                }
                if (unit.routeIndex < unit.route.length) {
                    const point = unit.route[unit.routeIndex];
                    this.move(unit, point.gx, point.gy, unit.typeData.speed, dt);
                }
                return true;
            }
        }
        if (unit.tacticalRole === 'main' && !group.launched && dist(unit, enemy) > 1.15) {
            this.move(unit, group.holdX - this.forward(unit.team) * unit.tacticalRow * 0.78,
                group.cy + unit.tacticalLane, unit.typeData.speed, dt);
            return true;
        }
        if (unit.tacticalRole === 'flank' && !group.launched && dist(unit, enemy) > 1.15) return true;
        this.fight(unit, enemy, now, dt, unit.typeData.range);
        return true;
    }

    updateGuard(unit, now, dt) {
        const slot = unit.formationSlot;
        const closest = unit.tacticNearest;
        if (!closest) return;
        const nearDistance = dist(unit, closest);
        if (Math.hypot(unit.gx - slot.gx, unit.gy - slot.gy) >= 0.24 && nearDistance > 0.82) {
            this.move(unit, slot.gx, slot.gy, unit.typeData.speed * 0.8, dt);
        }
        const reach = unit.guardReady && slot.rank < 2 ? 2.35 : unit.typeData.range;
        let target = null, score = Infinity;
        this.scene.forEachNear(unit.gx, unit.gy, reach, other => {
            if (other.team === unit.team || !CombatRules.canBeHit(other)) return;
            const distance = dist(unit, other);
            if (distance > reach || !this.inFacing(unit, other) || !this.clearLane(unit, other, true)) return;
            if (slot.rank >= 2 && distance > 1.05) return;
            if (distance < score - 1e-9 || (Math.abs(distance - score) <= 1e-9 && other.id < target.id)) { score = distance; target = other; }
        });
        if (target) this.attack(unit, target, now, reach);
    }

    inFacing(unit, target) { return CombatRules.inFacing(unit, target); }

    incomingMultiplier(from, target) {
        // 站稳、有人支援且距离尚未被突破时，正面剑击先受到枪杆格挡。
        // 入阵近身、侧后命中、补位或溃逃均恢复完整伤害；箭与骑兵走原规则。
        if (from.type !== 'infantry' || target.tacticalRole !== 'guard' || !target.guardReady ||
            !this.active(target) || target.guardSupport < 2 || dist(from, target) < 0.72 || !this.inFacing(target, from)) return 1;
        this.metrics.deflections++;
        return 0.65;
    }

    clearLane(unit, target, spear = false) {
        return CombatRules.clearLane(this.scene, unit, target, spear);
    }

    fight(unit, target, now, dt, reach) {
        if (dist(unit, target) > reach) this.move(unit, target.gx, target.gy, unit.typeData.speed, dt);
        else this.attack(unit, target, now, reach);
    }

    attack(unit, target, now, reach) {
        CombatRules.attack(this.scene, unit, target, now, reach);
    }

    move(unit, gx, gy, speed, dt) { moveToward(unit, gx, gy, speed, dt); }

    summary() {
        const result = {};
        for (const team of ['red', 'blue']) {
            const formation = this.formations[team], group = this.groups[team];
            const guards = formation?.members.filter(u => this.active(u)) || [];
            result[team] = {
                order: this.orders[team], label: TACTIC_LABELS[this.orders[team]],
                stage: group?.phase || (formation ? (formation.breaches ? '阵线受压 · 就近补位' :
                    formation.sparse ? '小队守位 · 阵线稀疏' : '四面守位 · 等待接敌') : '自由接敌'),
                main: group ? group.main.filter(u => this.active(u)).length :
                    this.scene.units.filter(u => u.team === team && this.active(u)).length,
                flank: group?.flank.filter(u => this.active(u)).length || 0,
                reserve: group?.reserve.filter(u => this.active(u) && !u.reserveCommitted).length || 0,
                regrouping: group ? [...group.main, ...group.flank, ...group.reserve].filter(u =>
                    !u.dead && !u.withdrawn && u.moraleState === 'routing').length : 0,
                committed: group?.committed || 0,
                rallied: group ? [...group.main, ...group.flank, ...group.reserve].filter(u => u.everRallied).length : 0,
                ready: guards.filter(u => u.guardReady).length,
                slots: formation?.slots.length || 0, breaches: formation?.breaches || 0
            };
        }
        return result;
    }

    isStalemate() {
        const active = this.scene.units.filter(unit => this.active(unit));
        const damage = this.scene.battleStats.red.damage + this.scene.battleStats.blue.damage;
        const waiting = active.some(u => u.team === 'red') && active.some(u => u.team === 'blue') &&
            active.every(u => u.tacticalRole === 'guard' && !u.moving) &&
            !this.scene.arrows.length && !this.scene.battleQueue.length && damage === this.lastDamage;
        this.lastDamage = damage;
        if (!waiting) this.stalemateSince = null;
        else if (this.stalemateSince == null) this.stalemateSince = this.scene.simulationTime;
        return this.stalemateSince != null && this.scene.simulationTime - this.stalemateSince >= 10000;
    }

    breakStalemate() {
        for (const team of Object.keys(this.formations)) {
            for (const unit of this.formations[team].members) {
                // 溃兵也解除旧阵位，重整后才能与全队一样继续推进。
                delete unit.tacticalRole;
                delete unit.formationSlot;
                delete unit.guardFacingX;
                delete unit.guardFacingY;
                Object.assign(unit, { guardReady: false, guardStableTime: 0, guardSupport: 0,
                    braceReady: false, braceHold: false, braceTime: 0, braceSupport: 0, braceDepth: 0,
                    braceFacingX: this.forward(team), braceFacingY: 0 });
            }
            delete this.formations[team];
            this.orders[team] = 'advance';
        }
        this.stalemateSince = null;
        this.scene.addBattleEvent('tactic-deathmatch-advance', '死斗解除固守，继续接战', null);
    }
}
