// 守卫与守骑的接战纪律（原 TacticsSystem 守备组，调用面不变）。
import { board } from '../board.js';
import { CombatRules } from '../combat.js';
import { dist, clamp } from '../units.js';

export const GuardsMethods = {
    passArcherThreats(team) {
        const group = this.groundGuards[team], now = this.scene.simulationTime;
        if (!group?.layout) return [];
        const living = group.archers.filter(archer => CombatRules.canBeHit(archer));
        if (!living.length) { group.archerThreats = []; group.threatsAt = now; return []; }
        if (now - group.threatsAt >= 100) {
            // 前瞻触发：敌骑在 9.5 格内逼近就入列（步兵只有真正贴到弓手跟前才算），
            // 威胁带 600ms 粘滞防止边界抖动反复打散守骑的追击。
            const PROX = 9.5, CLOSE = 3.5, STICKY = 600;
            const next = new Map();
            const mark = (enemy, radius) => {
                const previous = next.get(enemy.id);
                next.set(enemy.id, { enemy, radius, until: Math.max(previous?.until ?? -Infinity, now + STICKY) });
            };
            for (const entry of group.archerThreats || [])
                if (entry.until > now && CombatRules.canAct(entry.enemy)) next.set(entry.enemy.id, entry);
            for (const archer of living) {
                this.scene.forEachNear(archer.gx, archer.gy, PROX, other => {
                    if (other.team === team || !CombatRules.canAct(other) || dist(archer, other) > PROX) return;
                    const distance = dist(archer, other);
                    if (other.type === 'cavalry') {
                        if (distance > CLOSE && !this.approachingUnit(other, archer)) return;
                        mark(other, PROX + 1.5);
                    } else if (distance <= 4.2) mark(other, 5.7);
                });
            }
            // 对冲拦截：远处正在冲锋且弹道将扫过弓手集群的敌骑，提前视为威胁迎面拦截。
            let sx = 0, sy = 0;
            for (const archer of living) { sx += archer.gx; sy += archer.gy; }
            const cx = sx / living.length, cy = sy / living.length;
            let spread = 0;
            for (const archer of living) spread = Math.max(spread, Math.hypot(archer.gx - cx, archer.gy - cy));
            const reach = 16 + spread;
            this.scene.forEachNear(cx, cy, reach, other => {
                if (other.team === team || other.type !== 'cavalry' || other.state !== 'charge' ||
                    other.chargeDX == null || !CombatRules.canAct(other)) return;
                if (Math.hypot(other.gx - cx, other.gy - cy) > reach) return;
                const ahead = (cx - other.gx) * other.chargeDX + (cy - other.gy) * other.chargeDY;
                if (ahead <= 0) return;
                const miss = Math.hypot(cx - (other.gx + other.chargeDX * ahead), cy - (other.gy + other.chargeDY * ahead));
                if (miss > spread + 2.5) return;
                mark(other, reach + 2);
            });
            // 翼位分工需要知道每翼还剩多少守骑；与威胁表同步刷新。
            let upper = 0, lower = 0;
            for (const member of group.members) {
                if (member.type !== 'cavalry' || !member.protectArchers ||
                    !this.active(member) || !this.isGroundGuard(member)) continue;
                if (member.guardAnchor.gy < group.cy - 0.5) upper++;
                else if (member.guardAnchor.gy > group.cy + 0.5) lower++;
            }
            group.upperWingCavalry = upper; group.lowerWingCavalry = lower;
            group.archerThreats = [...next.values()];
            group.threatsAt = now;
        }
        // 死亡与撤离当步生效；缓存仅省去空间查询，不继承已消失的护弓理由。
        return group.archerThreats.filter(entry => entry.until > now && CombatRules.canAct(entry.enemy) &&
            living.some(archer => dist(archer, entry.enemy) <= entry.radius));
    },


    // 方向过滤：敌人正在逼近该弓手（速度朝向或冲锋朝向）才算前瞻威胁。
    approachingUnit(enemy, archer) {
        const dx = archer.gx - enemy.gx, dy = archer.gy - enemy.gy;
        const distance = Math.hypot(dx, dy);
        if (distance <= 0.001) return true;
        const vx = enemy.velX || 0, vy = enemy.velY || 0, speed = Math.hypot(vx, vy);
        if (speed > 0.1) return (dx * vx + dy * vy) / (distance * speed) >= 0.2;
        if (enemy.type === 'cavalry' && enemy.state === 'charge' && enemy.chargeDX != null)
            return dx * enemy.chargeDX + dy * enemy.chargeDY >= 0.2 * distance;
        return false;
    },

    isGroundGuard(unit) {
        return unit.tacticalRole === 'ground_guard' && (unit.type !== 'cavalry' ||
            (this.scene.battleOptions.cavalryOrders?.[unit.team] || 'auto') === 'auto');
    },

    groundThreat(unit) {
        let target = null, nearest = Infinity;
        if (unit.type === 'cavalry' && unit.protectArchers) {
            const group = this.groundGuards[unit.team];
            for (const entry of this.passArcherThreats(unit.team)) {
                const other = entry.enemy;
                if (dist(unit.guardAnchor, other) > unit.guardRadius) continue;
                if (group && !this.wingAllows(unit, group, other)) continue;
                const distance = dist(unit, other);
                if (distance < nearest - 1e-9 || (Math.abs(distance - nearest) <= 1e-9 && other.id < target.id)) {
                    nearest = distance; target = other;
                }
            }
            if (target) return target;
        }
        const radius = unit.protectArchers ? unit.guardLocalRadius : unit.guardRadius;
        const consider = other => {
            if (other.team === unit.team || !CombatRules.canBeHit(other)) return;
            const distance = dist(unit, other);
            if (dist(unit.guardAnchor, other) > radius && distance > unit.typeData.range) return;
            if (distance < nearest - 1e-9 || (Math.abs(distance - nearest) <= 1e-9 && other.id < target.id)) {
                nearest = distance; target = other;
            }
        };
        this.scene.forEachNear(unit.guardAnchor.gx, unit.guardAnchor.gy, radius, consider);
        this.scene.forEachNear(unit.gx, unit.gy, unit.typeData.range, consider);
        return target;
    },


    // 翼位分工：守骑优先接本翼与中性带（±4 格）的威胁；
    // 只有威胁所在翼已无守骑时才越权接对翼威胁，避免两翼全员扑向同一侧。
    wingAllows(unit, group, other) {
        const cy = group.cy ?? board.H / 2;
        const side = other.gy < cy - 4 ? -1 : other.gy > cy + 4 ? 1 : 0;
        if (side === 0) return true;
        const wing = unit.guardAnchor.gy < cy - 0.5 ? -1 : unit.guardAnchor.gy > cy + 0.5 ? 1 : 0;
        if (wing === 0 || side === wing) return true;
        return (side < 0 ? group.upperWingCavalry : group.lowerWingCavalry) === 0;
    },


    // 对冲拦截的预计相遇点：按双方当前速度外推，守骑迎着弹道对冲而不是原地等。
    interceptPoint(unit, target) {
        const vx = target.velX || 0, vy = target.velY || 0;
        const closing = (unit.typeData.chargeSpeed ?? unit.typeData.speed) + Math.hypot(vx, vy);
        const lead = clamp(dist(unit, target) / Math.max(closing, 1), 0, 1.2);
        return { id: target.id,
            gx: clamp(target.gx + vx * lead, 1.5, board.W - 1.5),
            gy: clamp(target.gy + vy * lead, 1.5, board.H - 1.5) };
    },

    boundGroundMove(unit) {
        if (!this.scene.planningStep) return;
        const anchor = unit.guardAnchor;
        const dx = unit.gx + unit.moveX - anchor.gx, dy = unit.gy + unit.moveY - anchor.gy;
        const offset = Math.hypot(dx, dy);
        if (offset <= unit.guardRadius) return;
        // 只约束主动移动；击退和身体挤压仍然真实生效，超界后下一步自行走回。
        unit.moveX = anchor.gx + dx / offset * unit.guardRadius - unit.gx;
        unit.moveY = anchor.gy + dy / offset * unit.guardRadius - unit.gy;
        if (unit.type === 'cavalry') this.scene.cavalryAI.enterMelee(unit);
    },


    // 侧翼反冲（D 防守补强）：敌步兵线咬住我守区前排后，护弓守骑抽一翼出击敌线侧后
    // （弓手/纵深软单位），得手或失血都按计时收手返锚——守骑本职仍是护弓，
    // 反冲只是打乱敌推进节奏的短促突击。咬合=敌我地面单位首次贴身（<2.5），
    // 一次性计时（与预备队 engagedAt 同口径）；200ms 节流做组级扫描。
    // 镜像安全：时间/数量比较确定；选翼按存活守骑数（平局取上翼），换座两侧
    // 选的是同一世界翼；出击骑按 (距冲击点, gy) 排序，键均为镜像不变量。
    updateCounterRaids(now) {
        for (const group of Object.values(this.groundGuards)) {
            if (now < (group.nextRaidCheck ?? 0)) continue;
            group.nextRaidCheck = now + 200;
            const front = group.members.filter(u => this.active(u) && u.type !== 'cavalry' && !u.typeData.ranged);
            if (group.biteAt == null) {
                if (front.some(u => { const e = this.scene.nearestEnemy(u); return e && dist(u, e) < 2.5; }))
                    group.biteAt = now;
            }
            if (group.biteAt == null || now - group.biteAt < 4000) continue;      // 咬稳再说：刚接触就出击会被正面缠住
            if (now - (group.lastRaidAt ?? -Infinity) < 20000) continue;          // 冷却：出击8s+返锚5s+重整，一波接一波轮换
            if (group.members.some(u => u.counterRaid)) continue;
            // 出击理由：优先敌弓纵深（侧后软单位）；敌弓清光但敌步兵仍压在我前排
            // 4 格内（战线咬合未解）时，改为冲击压境敌线的侧腰——守骑是预备队，
            // 不能看着前排被逐排啃光而全程旁观。
            const foe = this.enemies(group.team);
            const archers = this.scene.units.filter(u => u.team === foe && u.type === 'archer' && CombatRules.canBeHit(u));
            let ax = 0, ay = 0, raidFlank = false, pressing = 0;
            if (archers.length) {
                for (const a of archers) { ax += a.gx; ay += a.gy; }
                ax /= archers.length; ay /= archers.length;
            } else {
                for (const u of front) {
                    const e = this.scene.nearestEnemy(u);
                    if (!e || e.type === 'cavalry' || dist(u, e) > 4) continue;   // 只算仍压在前排门口的敌步/矛
                    ax += e.gx; ay += e.gy; pressing++;
                }
                if (!pressing) continue;                                           // 没弓可打也没敌压门：安稳守位
                ax /= pressing; ay /= pressing; raidFlank = true;
            }
            const riders = group.members.filter(u => this.active(u) && u.type === 'cavalry' &&
                u.protectArchers && this.isGroundGuard(u) && !u.counterRaid && u.moraleState === 'steady');
            const upper = riders.filter(u => u.guardAnchor.gy < group.cy - 0.5);
            const lower = riders.filter(u => u.guardAnchor.gy > group.cy + 0.5);
            const wing = lower.length > upper.length ? lower : upper;
            if (wing.length < 2) continue;                                          // 至少双骑出击：单骑冲阵必被围死
            const side = wing === upper ? -1 : 1, f = this.forward(group.team);
            const raidX = clamp(ax + (raidFlank ? 0 : f * 1.5), 2, board.W - 2), raidY = clamp(ay + side * 3, 2, board.H - 2);
            wing.sort((a, b) => Math.hypot(a.gx - raidX, a.gy - raidY) - Math.hypot(b.gx - raidX, b.gy - raidY) ||
                a.guardAnchor.gy - b.guardAnchor.gy);
            // 出击规模：侧腰冲击按压境敌规模成波压上（约每 5 敌出 1 骑，2~全翼）——
            // 零散 2 骑撞大阵是排队送死；敌骑仍有存活时压回 2 骑快速袭击（留人护弓）。
            const foeCavalry = this.scene.units.filter(u => u.team === foe && u.type === 'cavalry' && CombatRules.canBeHit(u)).length;
            const count = foeCavalry >= 1 ? Math.min(2, wing.length)
                : raidFlank ? Math.min(wing.length, Math.max(2, Math.ceil(pressing / 5)))
                : Math.min(3, wing.length);
            for (const rider of wing.slice(0, count)) {
                rider.counterRaid = { until: now + 8000, hpAtStart: rider.hp, gx: raidX, gy: raidY };
                this.scene.cavalryAI.beginCharge(rider);
            }
            group.lastRaidAt = now;
            this.scene.addBattleEvent('tactic-raid-' + group.team + '-' + Math.floor(now),
                `${group.team === 'red' ? '红方' : '蓝方'}守骑${count}骑自${side < 0 ? '上' : '下'}翼出击，${raidFlank ? '冲击敌线侧腰' : '冲击敌线侧后'}`, group.team);
        }
    },

    updateGroundGuard(unit, now, dt) {
        if (!this.isGroundGuard(unit)) {
            if (unit.guardIntercept || unit.guardPursueTarget || unit.counterRaid || unit.raidRecall) {
                unit.guardIntercept = null; unit.guardPursueTarget = null; unit.guardPursueFor = 0;
                delete unit.counterRaid;
                unit.raidRecall = false;
            }
            return false;
        }
        // 侧翼反冲执行：冲击敌线侧后的短促突击，得手/失败均按计时收手返锚。
        if (unit.counterRaid) {
            const raid = unit.counterRaid;
            if (now > raid.until || unit.hp < raid.hpAtStart * 0.55 || unit.moraleState !== 'steady') {
                delete unit.counterRaid;
                unit.guardIntercept = null; unit.guardPursueTarget = null; unit.guardPursueFor = 0;
                // 收手即召回：突击窗结束的骑手深处敌阵，fromPost<guardRadius 时
                // 常规返锚分支不触发——不召回就会就地恋战被围殴（送死的观感来源）。
                unit.raidRecall = true;
            } else {
                // 冲击点附近选最近敌（过滤界=查询界，桶毛边不泄漏）；落点与矛墙由
                // detourPikes 自行处理。无目标可打=纵深软单位已清，得手收手。
                let target = null, best = Infinity;
                this.scene.forEachNear(raid.gx, raid.gy, 6, other => {
                    if (other.team === unit.team || !CombatRules.canBeHit(other)) return;
                    const dx = other.gx - raid.gx, dy = other.gy - raid.gy, d2 = dx * dx + dy * dy;
                    if (d2 > 36) return;
                    if (d2 < best - 1e-9 || (Math.abs(d2 - best) <= 1e-9 && other.id < target.id)) {
                        best = d2; target = other;
                    }
                });
                if (!target) { delete unit.counterRaid; unit.raidRecall = true; }
                else {
                    unit.groundGuardTarget = target; unit.target = target;
                    unit.guardIntercept = null;
                    // 反冲目标由守卫逻辑独占：压制 charge 内部的 500ms 重选，
                    // 否则最近的正面敌（常是矛兵）会把出击骑从侧后线上拽走。
                    unit.lastRetarget = now;
                    if (!this.scene.cavalryAI.update(unit, now, dt))
                        this.fight(unit, target, now, dt, unit.typeData.range);
                    return true;
                }
            }
        }
        const anchor = unit.guardAnchor, fromPost = dist(unit, anchor);
        // 召回中：敌逼弓的拦截永远优先（护弓是本职），否则脱离敌群直奔锚点，
        // 到家(≤2.5)才解除——召回期不恋战，骑速 4.0 步兵追不上，短暂挨打可接受。
        if (unit.raidRecall && !this.groundThreat(unit)) {
            unit.groundGuardReturning = true;
            unit.groundGuardTarget = null; unit.target = null;
            if (unit.state !== 'melee') this.scene.cavalryAI.enterMelee(unit);
            this.move(unit, anchor.gx, anchor.gy, unit.typeData.speed, dt);
            if (fromPost <= 2.5) unit.raidRecall = false;
            return true;
        }
        if (unit.raidRecall) unit.raidRecall = false;   // 有真威胁拦截优先，召回作废
        unit.groundGuardReturning = false;
        if (unit.typeData.ranged) {
            this.scene.updateNormalUnit(unit, now, dt, anchor);
            if (fromPost <= unit.guardRadius) this.boundGroundMove(unit);
            return true;
        }
        let target = this.groundThreat(unit);
        let grace = false;
        if (!target && unit.type === 'cavalry' && fromPost > 1 && (unit.guardPursueFor ?? 0) > 0 &&
            unit.guardPursueTarget && CombatRules.canBeHit(unit.guardPursueTarget)) {
            // 时机纪律：威胁刚消失的一小段时间继续追击，不清冲锋动量；
            // 宽限按步数倒数且自身不续期，只有真实威胁才能重新装满。
            target = unit.guardPursueTarget;
            grace = true;
            unit.guardPursueFor -= dt;
        }
        if (target && !grace) { unit.guardPursueTarget = target; unit.guardPursueFor = 0.35; }
        else if (!target) { unit.guardPursueTarget = null; unit.guardPursueFor = 0; }
        unit.groundGuardTarget = target;
        unit.target = target;
        if (fromPost > unit.guardRadius + 0.02 || !target) {
            if (unit.type === 'cavalry') {
                if (!target && fromPost <= 0.2) this.scene.cavalryAI.beginCharge(unit);
                else this.scene.cavalryAI.enterMelee(unit);
            }
            if (target && dist(unit, target) <= unit.typeData.range) this.attack(unit, target, now, unit.typeData.range);
            if (fromPost > 0.2) {
                unit.groundGuardReturning = true;
                this.move(unit, anchor.gx, anchor.gy, unit.typeData.speed, dt);
            }
            return true;
        }
        if (unit.type === 'cavalry') {
            // 对冲拦截：敌骑冲锋中按预计相遇点迎面拦截，命中仍按真实目标结算。
            unit.guardIntercept = target.type === 'cavalry' && (target.state === 'charge' || target.state === 'pierce')
                ? this.interceptPoint(unit, target) : null;
            // 守骑不站桩：目标超出近身距离立即转冲锋，不等 melee 状态自带的 2 秒迟疑。
            if (unit.state === 'melee' && dist(unit, target) > 2) this.scene.cavalryAI.beginCharge(unit);
            if (!this.scene.cavalryAI.update(unit, now, dt)) this.fight(unit, target, now, dt, unit.typeData.range);
        } else if (unit.type === 'pikeman' && unit.braceHold && dist(unit, target) > unit.typeData.range) {
            // 与自由接敌共用架枪迎击，不让守位命令放下已备好的长枪。
        } else this.fight(unit, target, now, dt, unit.typeData.range);
        this.boundGroundMove(unit);
        return true;
    },

    turnGuard(unit, fx, fy, dt) {
        if (Math.hypot(fx, fy) < 0.001) return 0;
        const wanted = Math.atan2(fy, fx), current = Math.atan2(unit.guardFacingY, unit.guardFacingX);
        let delta = Math.atan2(Math.sin(wanted - current), Math.cos(wanted - current));
        if (Math.abs(Math.abs(delta) - Math.PI) < 1e-9) delta = Math.PI * this.forward(unit.team);
        if (Math.abs(delta) < 1e-9) {
            const length = Math.hypot(fx, fy);
            unit.guardFacingX = fx / length; unit.guardFacingY = fy / length;
            return 0;
        }
        delta = clamp(delta, -2.6 * dt, 2.6 * dt);
        unit.guardFacingX = Math.cos(current + delta); unit.guardFacingY = Math.sin(current + delta);
        return Math.abs(delta);
    },

    guardThreat(unit) {
        const candidates = [];
        this.scene.forEachNear(unit.gx, unit.gy, 2.8, other => {
            if (other.team !== unit.team && CombatRules.canBeHit(other) && dist(unit, other) <= 2.8) candidates.push(other);
        });
        candidates.sort((a, b) => {
            const state = Number(a.moraleState === 'routing') - Number(b.moraleState === 'routing');
            const distance = dist(unit, a) - dist(unit, b);
            return state || (Math.abs(distance) > 1e-9 ? distance : a.id - b.id);
        });
        const best = candidates[0], previous = unit.tacticNearest;
        // 距离相近就继续应付原来的敌人；更迫近的敌人可以立即接管注意力。
        if (best && candidates.includes(previous) && previous.moraleState === best.moraleState &&
            dist(unit, previous) <= dist(unit, best) + 0.3) return previous;
        return best || null;
    },

    updateGuard(unit, now, dt) {
        const slot = unit.formationSlot;
        const closest = unit.tacticNearest;
        unit.guardEngaging = !!closest && unit.guardTurning;
        if (!closest) {
            if (Math.hypot(unit.gx - slot.gx, unit.gy - slot.gy) >= 0.2) this.moveGuard(unit, slot, dt);
            return;
        }
        const reach = unit.guardReady && slot.rank < 2 ? 2.35 : unit.typeData.range;
        let target = null, score = Infinity;
        this.scene.forEachNear(unit.gx, unit.gy, reach, other => {
            if (other.team === unit.team || !CombatRules.canBeHit(other)) return;
            const distance = dist(unit, other);
            if (distance > reach || !this.inFacing(unit, other) || !this.clearLane(unit, other, true)) return;
            if (distance < score - 1e-9 || (Math.abs(distance - score) <= 1e-9 && other.id < target.id)) { score = distance; target = other; }
        });
        if (target) {
            unit.guardEngaging = true;
            unit.target = target;
            this.attack(unit, target, now, reach);
            return;
        }
        if (Math.hypot(unit.gx - slot.gx, unit.gy - slot.gy) > 0.82) {
            this.moveGuard(unit, slot, dt);
            return;
        }
        const formation = this.formations[unit.team];
        const intruding = formation && Math.abs(closest.gx - formation.cx) <= formation.half + 0.1 &&
            Math.abs(closest.gy - formation.cy) <= formation.half + 0.1;
        // 正面完整的枪墙让来敌进入枪距，不为了追近半步反复放下整排长枪。
        // 被侧后贴近或已有敌人入阵时，附近守军才离开自己的站位迎击。
        if (!unit.guardReacting && !intruding) return;
        // 架枪中的前排只做小幅迎击；受威胁转身和内排自卫都用普通枪距。
        const standoff = reach - 0.12;
        const dx = closest.gx - unit.gx, dy = closest.gy - unit.gy, distance = Math.hypot(dx, dy);
        const nx = distance > 0.001 ? dx / distance : slot.faceX;
        const ny = distance > 0.001 ? dy / distance : slot.faceY;
        const advance = Math.max(0, distance - standoff);
        const direct = { gx: unit.gx + nx * advance, gy: unit.gy + ny * advance };
        const options = [direct];
        if (!this.clearLane(unit, closest, true)) {
            const side = this.forward(unit.team);
            options.push({ gx: unit.gx - ny * 0.45 * side + nx * 0.15, gy: unit.gy + nx * 0.45 * side + ny * 0.15 },
                { gx: unit.gx + ny * 0.45 * side + nx * 0.15, gy: unit.gy - nx * 0.45 * side + ny * 0.15 });
        }
        let chosen = null, best = Infinity;
        for (const point of options) {
            const fromSlotX = point.gx - slot.gx, fromSlotY = point.gy - slot.gy;
            const offset = Math.hypot(fromSlotX, fromSlotY);
            if (offset > 0.8) {
                point.gx = slot.gx + fromSlotX / offset * 0.8;
                point.gy = slot.gy + fromSlotY / offset * 0.8;
            }
            const travel = Math.hypot(point.gx - unit.gx, point.gy - unit.gy);
            if (travel < 0.08) continue;
            let occupied = false;
            this.scene.forEachNear(point.gx, point.gy, 0.73, other => {
                if (other !== unit && CombatRules.canBeHit(other) &&
                    Math.hypot(other.gx - point.gx, other.gy - point.gy) < CombatRules.contactDistance(unit, other)) occupied = true;
            });
            if (occupied) continue;
            const projected = { ...unit, gx: point.gx, gy: point.gy };
            const scene = { forEachNear: (gx, gy, radius, visit) => this.scene.forEachNear(gx, gy, radius,
                other => { if (other !== unit) visit(other); }) };
            const clear = CombatRules.clearLane(scene, projected, closest, true);
            const score = (clear ? 0 : 4) + Math.hypot(point.gx - closest.gx, point.gy - closest.gy) + travel * 0.2;
            if (score < best - 1e-9) { best = score; chosen = point; }
        }
        if (chosen) this.moveGuard(unit, chosen, dt);
    },

    moveGuard(unit, point, dt) {
        this.move(unit, point.gx, point.gy, unit.typeData.speed * 0.8, dt);
        if (unit.moving) {
            if (unit.tacticNearest) unit.guardEngaging = true;
            unit.guardReady = false; unit.guardStableTime = 0;
            unit.braceReady = false; unit.braceTime = 0; unit.braceHold = false;
        }
    },

    inFacing(unit, target) { return CombatRules.inFacing(unit, target); },

    incomingMultiplier(from, target) {
        // 站稳、有人支援且距离尚未被突破时，正面剑击先受到枪杆格挡。
        // 入阵近身、侧后命中、补位或溃逃均恢复完整伤害；箭与骑兵走原规则。
        if (from.type !== 'infantry' || target.tacticalRole !== 'guard' || !target.guardReady ||
            !this.active(target) || target.guardSupport < 2 || dist(from, target) < 0.72 || !this.inFacing(target, from)) return 1;
        this.metrics.deflections++;
        return 0.65;
    },

    clearLane(unit, target, spear = false) {
        return CombatRules.clearLane(this.scene, unit, target, spear);
    }
};
