// 逐帧编排与死斗解除（原 TacticsSystem 步进组，调用面不变）。
import { Terrain } from '../terrain.js';
import { CombatRules } from '../combat.js';
import { dist, moveToward } from '../units.js';

export const StepsMethods = {
    beginStep(dt) {
        const now = this.scene.simulationTime;
        for (const formation of Object.values(this.formations)) {
            for (const unit of formation.members) if (!this.active(unit)) {
                unit.guardReady = false; unit.guardStableTime = 0; unit.braceReady = false;
            }
            const guards = formation.members.filter(u => this.active(u));
            for (const guard of guards) {
                const slot = guard.formationSlot;
                const threat = this.guardThreat(guard);
                guard.tacticNearest = threat;
                guard.target = threat;
                const distance = threat ? dist(guard, threat) : Infinity;
                const dx = threat ? threat.gx - guard.gx : 0, dy = threat ? threat.gy - guard.gy : 0;
                const front = distance > 0.001 ? (dx * slot.faceX + dy * slot.faceY) / distance : 1;
                // 保留本面的长枪屏障；真正逼到身边的侧后敌人才让这一小片守军转向。
                guard.guardReacting = !!threat && front < (guard.guardReacting ? 0.65 : 0.55) &&
                    distance <= (guard.guardReacting ? 2.15 : 1.8);
                const fx = guard.guardReacting ? dx : slot.faceX, fy = guard.guardReacting ? dy : slot.faceY;
                guard.guardTurning = this.turnGuard(guard, fx, fy, dt) > dt * 0.35;
                guard.guardEngaging = !!threat;
            }
            // 队形支撑来自邻近活跃友军的身体；穿过友军的枪线另由 clearLane 限制同向长枪。
            // 守军自己的走动、转向和受击仍会打断自己的架枪，不把邻兵转身扩散成全排失架。
            for (const guard of guards) {
                const slot = guard.formationSlot;
                const inPost = Math.hypot(guard.gx - slot.gx, guard.gy - slot.gy) <= 0.81;
                let support = 0, depth = 0;
                this.scene.forEachNear(guard.gx, guard.gy, 1.7, other => {
                    if (other === guard || other.team !== guard.team || other.tacticalRole !== 'guard' || !this.active(other)) return;
                    if (dist(guard, other) < 1.65) support++;
                    if (dist(guard, other) < 1.7 && (other.gx - guard.gx) * guard.guardFacingX +
                        (other.gy - guard.gy) * guard.guardFacingY < -0.3) depth++;
                });
                guard.guardSupport = support;
                const vx = (guard.velX || 0) - (guard.separateX || 0) / dt;
                const vy = (guard.velY || 0) - (guard.separateY || 0) / dt;
                guard.guardStableTime = !guard.moving && Math.hypot(vx, vy) <= 0.15 &&
                    !guard.guardTurning && inPost && support >= 2
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
            this.updateRallyWaves(group, now);
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
        this.updateCounterRaids(now);
    },

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
    },

    updateUnit(unit, now, dt) {
        if (unit.tacticalRole === 'guard') { this.updateGuard(unit, now, dt); return true; }
        if (this.updateSlopeApproach(unit, dt)) return true;
        if (!['main', 'flank', 'reserve'].includes(unit.tacticalRole)) return false;
        const group = this.groups[unit.team];
        const enemy = this.scene.nearestEnemy(unit);
        if (!enemy) return true;
        if (unit.rallyWaiting) return true;
        if (unit.moralePhase === 'returning') {
            let target = enemy, score = dist(unit, enemy) + (this.clearLane(unit, enemy) ? 0 : 2.5);
            this.scene.forEachNear(unit.gx, unit.gy, 6, other => {
                if (other.team === unit.team || !CombatRules.canBeHit(other)) return;
                const distance = dist(unit, other);
                if (distance > 6 + 1e-9) return;
                const candidate = distance + (this.clearLane(unit, other) ? 0 : 2.5);
                if (candidate < score - 1e-9 || (Math.abs(candidate - score) <= 1e-9 && other.id < target.id)) {
                    target = other; score = candidate;
                }
            });
            this.fight(unit, target, now, dt, unit.typeData.range);
            return true;
        }
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
                const slot = unit.receptionSlot && this.safeAt(unit.team, unit.receptionSlot.gx, unit.receptionSlot.gy)
                    ? this.outsideRoute(unit, unit.receptionSlot, group, 6.3) : unit.reserveSlot;
                if (!slot) return true;
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
    },

    updateSlopeApproach(unit, dt) {
        const approach = unit.slopeApproach;
        if (!approach || approach.released || unit.tacticalRole || this.orders[unit.team] !== 'advance' ||
            !Terrain.isNaturalSlope(this.scene.battleOptions.terrain)) return false;
        if (!this.active(unit) || unit.everRouted || unit.hp < unit.maxHp) {
            approach.released = true;
            return false;
        }
        const enemy = this.scene.nearestEnemy(unit);
        if (!enemy) return false;
        // 远处保持各自纵向队列，近敌/受击后永久交回普通接战，不来回拉回出生线。
        // 若敌人已到侧后，也必须解除行军，否则边翼会停在敌人横坐标上等不到接触。
        if (dist(unit, enemy) <= 5.5 || (enemy.gx - unit.gx) * this.forward(unit.team) <= 1) {
            approach.released = true;
            return false;
        }
        unit.target = enemy;
        this.move(unit, enemy.gx, approach.gy, unit.typeData.speed, dt);
        return true;
    },

    fight(unit, target, now, dt, reach) {
        if (dist(unit, target) > reach || !Terrain.segmentClear(this.scene.battleOptions.terrain,
            unit.gx, unit.gy, target.gx, target.gy)) this.move(unit, target.gx, target.gy, unit.typeData.speed, dt);
        else this.attack(unit, target, now, reach);
    },

    attack(unit, target, now, reach) {
        CombatRules.attack(this.scene, unit, target, now, reach);
    },

    move(unit, gx, gy, speed, dt) { moveToward(unit, gx, gy, speed, dt); },

    isStalemate() {
        const active = this.scene.units.filter(unit => this.active(unit));
        const damage = this.scene.battleStats.red.damage + this.scene.battleStats.blue.damage;
        const waiting = active.some(u => u.team === 'red') && active.some(u => u.team === 'blue') &&
            active.every(u => (u.tacticalRole === 'guard' || this.isGroundGuard(u)) && !u.moving) &&
            !this.scene.arrows.length && !this.scene.battleQueue.length && damage === this.lastDamage;
        this.lastDamage = damage;
        if (!waiting) this.stalemateSince = null;
        else if (this.stalemateSince == null) this.stalemateSince = this.scene.simulationTime;
        return this.stalemateSince != null && this.scene.simulationTime - this.stalemateSince >= 10000;
    },

    breakStalemate() {
        for (const [team, ground] of Object.entries(this.groundGuards)) {
            for (const unit of ground.members) {
                delete unit.tacticalRole;
                delete unit.guardAnchor;
                delete unit.guardRadius;
                delete unit.groundGuardTarget;
                delete unit.groundGuardReturning;
                unit.guardIntercept = null; unit.guardPursueTarget = null; unit.guardPursueFor = 0;
                delete unit.counterRaid;
                unit.raidRecall = false;
            }
            delete this.groundGuards[team];
            this.orders[team] = 'advance';
        }
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
};
