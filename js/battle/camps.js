// Territory construction and garrisons. All clocks and decisions use simulation state.
import { board } from '../board.js';
import { Terrain } from '../terrain.js';
import { CombatRules } from '../combat.js';
import { moveToward } from '../units.js';
import { quantizeDecision as q } from './determinism.js';
import { HEALING_RULES } from './healing.js';
import { updateWorkerCombat, workerConstructionPaused } from './worker.js';
import { buildSpeedScale, buildingDamageScale, buildSiteBonus } from './site-traits.js';

export const CAMP_RULES = {
    camp: { cost: 160, seconds: 18, hp: 850, def: 10, radius: 2.2 },
    tower: { cost: 120, seconds: 14, hp: 650, def: 6, radius: 0.9 },
    tent: { cost: 140, seconds: 15, hp: 550, def: 4, radius: 1.5 },   // 医帐：据点疗伤提速扩容
    HOME_HP: 1800, CAPACITY: 4, TOWER_RANGE: 14, GARRISON_HEIGHT_PX: 82,
    TENT_GARRISON_HEIGHT_PX: 14,   // 医帐无高台：驻帐医师站在帐篷门口地面，不上 82px 平台
    BUILD_REACH: 1.6, ENTER_REACH: 1.15, AI_INTERVAL_MS: 1800
};

// 驻军读数（模拟与渲染共用的唯一口径）：reserved 含"已预约入驻"的在途单位。
export function garrisonStatusLabel(inside, reserved, capacity) {
    return { inside, reserved, capacity, full: reserved >= capacity,
        label: `${inside}/${capacity}${reserved > inside ? `（+${reserved - inside} 前往中）` : ''}` };
}

// 在途预约计数（towerId → 在途人数）：渲染层每帧只扫一次，避免"塔数 × 单位数"逐帧扫描。
export function pendingGarrisonCounts(units) {
    const counts = new Map();
    for (const u of units) {
        if (!alive(u) || u.moraleState === 'routing' || !u.garrisonOrderId || u.garrisonTowerId) continue;
        counts.set(u.garrisonOrderId, (counts.get(u.garrisonOrderId) ?? 0) + 1);
    }
    return counts;
}

const alive = u => u && !u.dead && !u.withdrawn && u.hp > 0;
const ready = u => alive(u) && u.moraleState !== 'routing';
const distance = (a, b) => q(Math.hypot(a.gx - b.gx, a.gy - b.gy));

export class CampSystem {
    constructor(scene) {
        this.scene = scene;
        this.buildings = [];
        this.nextThink = 0;
        this.byId = new Map();
        this.grid = new Map();
        this.unitsById = new Map();
        this.refreshUnits();
        for (const team of ['red', 'blue']) {
            this.createBuilding(team, 'camp', 'home', true);
            this.createBuilding(team, 'tower', 'home', true);
        }
    }

    refreshUnits() {
        this.unitsById.clear();
        for (const u of this.scene.units) this.unitsById.set(u.id, u);
    }

    getBuilding(id) { return this.byId.get(id) ?? null; }
    buildInfo(kind) {
        if (!['camp', 'tower', 'tent'].includes(kind)) return null;
        const r = CAMP_RULES[kind];
        return r ? {
            cost: r.cost, buildMs: r.seconds * 1000, maxHp: r.hp,
            capacity: kind === 'tower' ? CAMP_RULES.CAPACITY
                : kind === 'tent' ? HEALING_RULES.TENT_MEDIC_SLOTS : 0
        } : null;
    }
    projection() {
        return {
            nextThink: this.nextThink,
            buildings: this.buildings.map(b => ({ id: b.id, type: b.type, team: b.team, siteId: b.siteId,
                gx: b.gx, gy: b.gy, hp: b.hp, maxHp: b.maxHp, progress: b.progress,
                complete: b.complete, dead: b.dead, workerId: b.workerId, paused: b.paused,
                garrisonIds: [...b.garrisonIds] }))
        };
    }
    unit(id) { return this.unitsById.get(id) ?? this.scene.units.find(u => u.id === id); }
    id(team, type, siteId) { return `${type}:${team}:${siteId}`; }
    site(team, siteId) {
        if (siteId === 'home') return { gx: team === 'red' ? 7 : board.W - 7, gy: board.H / 2 };
        return Number.isInteger(siteId) ? this.scene.flags?.[siteId] : null;
    }
    ownsSite(team, siteId) { return siteId === 'home' || this.site(team, siteId)?.owner === team; }

    placement(team, type, siteId) {
        const s = this.site(team, siteId);
        if (!s) return null;
        const mir = team === 'red' ? 1 : -1;
        // Put the compound behind its flag, keeping the capture circle and bridge open.
        // 医帐放据点北侧（旗圈外沿），不与南侧营寨/箭塔争地。
        const p = type === 'tower'
            ? { gx: s.gx + mir * (siteId === 'home' ? 2.4 : -1), gy: s.gy + (siteId === 'home' ? 0.5 : 1) }
            : type === 'tent'
                ? { gx: s.gx - mir * (siteId === 'home' ? 0 : 2.4), gy: s.gy - 3.2 }
                : { gx: s.gx - mir * (siteId === 'home' ? 0 : 3.5), gy: s.gy + 3.5 };
        if (p.gx < 2.5 || p.gx > board.W - 2.5 || p.gy < 3 || p.gy > board.H - 3) return null;
        return Terrain.walkable(this.scene.battleOptions?.terrain, p.gx, p.gy, CAMP_RULES[type].radius) ? p : null;
    }

    createBuilding(team, type, siteId, complete = false) {
        const position = this.placement(team, type, siteId);
        if (!position) return null;
        const rule = CAMP_RULES[type], home = type === 'camp' && siteId === 'home';
        const b = {
            id: this.id(team, type, siteId), type, team, siteId, ...position,
            hp: home ? CAMP_RULES.HOME_HP : rule.hp, maxHp: home ? CAMP_RULES.HOME_HP : rule.hp,
            progress: complete ? 1 : 0, complete, dead: false, workerId: null,
            paused: false, garrisonIds: [],
            capacity: type === 'tower' ? CAMP_RULES.CAPACITY
                : type === 'tent' ? HEALING_RULES.TENT_MEDIC_SLOTS : 0,
            radius: rule.radius,
            garrisonHeight: type === 'tent' ? CAMP_RULES.TENT_GARRISON_HEIGHT_PX : CAMP_RULES.GARRISON_HEIGHT_PX,
            isBuilding: true, typeData: { def: rule.def, atk: 0, range: 0, speed: 0, bodyRadius: rule.radius },
            scene: this.scene, battleId: this.scene.battleId
        };
        this.buildings.push(b);
        this.byId.set(b.id, b);
        const key = `${Math.floor(q(b.gx) / 16)},${Math.floor(q(b.gy) / 16)}`;
        if (!this.grid.has(key)) this.grid.set(key, []);
        this.grid.get(key).push(b);
        return b;
    }

    requestBuild(team, workerId, kind, siteId) {
        const w = this.unit(workerId), rule = CAMP_RULES[kind];
        if (!['red', 'blue'].includes(team) || !['camp', 'tower', 'tent'].includes(kind) || !rule || !ready(w) || w.type !== 'worker' || w.team !== team ||
            siteId === 'home' || !this.ownsSite(team, siteId) || !this.placement(team, kind, siteId)) return false;
        const camp = this.getBuilding(this.id(team, 'camp', siteId));
        if ((kind === 'tower' || kind === 'tent') && (!camp?.complete || camp.dead)) return false;
        let b = this.getBuilding(this.id(team, kind, siteId));
        if (b && !b.dead && (b.complete || (b.workerId != null && b.workerId !== w.id && ready(this.unit(b.workerId))))) return false;
        // A captured flag does not transfer its surviving enemy fortification.
        if (this.buildings.some(other => !other.dead && other.siteId === siteId && other.team !== team)) return false;
        if (!b || b.dead) {
            const econ = this.scene.territory.econ;
            if (Math.floor((econ.treasury[team] + 1e-7) * 20) / 20 < rule.cost) return false;
            econ.treasury[team] -= rule.cost;
            econ.spent[team] += rule.cost;
            b = this.createBuilding(team, kind, siteId);
        }
        this.releaseWorker(w);
        b.workerId = w.id;
        w.workerTask = { kind: 'build', buildingId: b.id };
        return true;
    }

    releaseWorker(w) {
        if (w.workerTask?.kind === 'build') {
            const b = this.getBuilding(w.workerTask.buildingId);
            if (b?.workerId === w.id) b.workerId = null;
        }
        w.workerTask = null;
    }

    orderWorkerMove(team, id, gx, gy) {
        const w = this.unit(id);
        if (!ready(w) || w.team !== team || w.type !== 'worker' || !Number.isFinite(gx) || !Number.isFinite(gy) ||
            gx < 1 || gx > board.W - 1 || gy < 1 || gy > board.H - 1 ||
            !Terrain.walkable(this.scene.battleOptions?.terrain, q(gx), q(gy))) return false;
        this.releaseWorker(w);
        w.workerTask = { kind: 'move', gx: q(gx), gy: q(gy) };
        return true;
    }

    reserved(tower) {
        let n = tower.garrisonIds.length;
        for (const u of this.scene.units) if (ready(u) && u.garrisonOrderId === tower.id && !u.garrisonTowerId) n++;
        return n;
    }

    // 驻军指令被拒的具体原因（UI 反馈与容量判断共用同一口径，避免两处各写一套）。
    // 返回 null 表示可以受理。容量计入"已预约入驻"的弓手，防止重复下令超额预订。
    garrisonRejectReason(team, towerId, unitIds = null) {
        const b = this.getBuilding(towerId);
        if (!b) return '请点选一座建筑';
        const acceptType = b.type === 'tower' ? 'archer' : b.type === 'tent' ? 'medic' : null;
        if (!acceptType) return '这里不能驻军：只有箭塔收弓手、医帐收医师';
        if (b.dead) return '这座建筑已被摧毁';                 // 先看是否还存在，再看归属
        if (b.team !== team) return `这是敌方${b.type === 'tower' ? '箭塔' : '医帐'}，不能驻军`;
        if (!b.complete) return `${b.type === 'tower' ? '箭塔' : '医帐'}尚未完工，民夫施工完成后才能驻军`;
        const cap = b.capacity;
        if (this.reserved(b) >= cap) return `${b.type === 'tower' ? '箭塔' : '医帐'}已满（${this.reserved(b)}/${cap}，含正在前往的）`;
        if (Array.isArray(unitIds)) {
            const candidates = [...new Set(unitIds)].map(id => this.unit(id))
                .filter(u => ready(u) && u.team === team && u.type === acceptType && !u.garrisonTowerId && u.garrisonOrderId !== towerId);
            if (!candidates.length) return acceptType === 'archer' ? '选中的部队里没有可入驻的弓箭手' : '选中的部队里没有可入驻的医师';
        }
        return null;
    }

    // 玩家语言的驻军状态：驻军数（含预约）。
    garrisonStatus(tower) {
        return garrisonStatusLabel(tower.garrisonIds.length, this.reserved(tower), tower.capacity);
    }

    // 共享受理口径：这批单位里模拟层真正会接受的子集（按 id 升序、去重，
    // 过滤溃逃/死亡/撤离/类型不符/已驻塔/已预约本塔，并截断到剩余容量）。
    // orderGarrison 的执行与 UI 的"多少人会前往"提示都只从这里取数——
    // 两处共用同一套过滤规则，提示人数永远等于实际受理人数。
    garrisonAcceptList(team, unitIds, towerId) {
        const b = this.getBuilding(towerId);
        // 箭塔收弓手；医帐收医师。其它组合一律不接受。
        const acceptType = b?.type === 'tower' ? 'archer' : b?.type === 'tent' ? 'medic' : null;
        if (!b || !acceptType || b.team !== team || b.dead || !b.complete || !Array.isArray(unitIds)) return [];
        let count = this.reserved(b);
        const accepted = [];
        for (const id of [...new Set(unitIds)].sort((a, z) => a - z)) {
            const u = this.unit(id);
            if (!ready(u) || u.team !== team || u.type !== acceptType || u.garrisonTowerId ||
                u.garrisonOrderId === towerId || count >= b.capacity) continue;
            accepted.push(u);
            count++;
        }
        return accepted;
    }

    orderGarrison(team, unitIds, towerId) {
        const accepted = this.garrisonAcceptList(team, unitIds, towerId);
        if (!accepted.length) return false;
        for (const u of accepted) {
            u.orderBuildingId = null;
            u.garrisonOrderId = towerId;
            u.meleeTarget = null;
            u.target = null;
        }
        return true;
    }

    cancelUnitOrders(team, unitIds) {
        for (const id of unitIds) {
            const u = this.unit(id);
            if (!alive(u) || u.team !== team) continue;
            u.orderBuildingId = null;
            u.garrisonOrderId = null;
        }
    }

    orderAttackBuilding(team, unitIds, buildingId) {
        const b = this.getBuilding(buildingId);
        if (!b || b.dead || b.team === team || !Array.isArray(unitIds)) return false;
        let accepted = false;
        for (const id of [...new Set(unitIds)].sort((a, z) => a - z)) {
            const u = this.unit(id);
            if (!ready(u) || u.team !== team || u.type === 'worker' || u.type === 'wagon' ||
                u.type === 'medic' || u.garrisonTowerId) continue;
            u.garrisonOrderId = null;
            u.orderBuildingId = buildingId;
            accepted = true;
        }
        return accepted;
    }

    exitPosition(tower, slot) {
        const mir = tower.team === 'red' ? 1 : -1;
        for (let ring = 0; ring < 6; ring++) {
            const radius = 1.5 + ring * 0.8;
            for (let i = 0; i < 8; i++) {
                const a = (slot + i) * Math.PI / 4;
                const gx = q(tower.gx - mir * Math.cos(a) * radius), gy = q(tower.gy + Math.sin(a) * radius);
                if (gx <= 0.6 || gx >= board.W - 0.6 || gy <= 0.6 || gy >= board.H - 0.6 ||
                    !Terrain.walkable(this.scene.battleOptions?.terrain, gx, gy, 0.36)) continue;
                // Include soldiers which exited earlier in this same settlement batch.
                const occupied = this.scene.units.some(u => alive(u) && !u.garrisonTowerId && distance({ gx, gy }, u) < 0.72);
                if (!occupied) return { gx, gy };
            }
        }
        // Tower placement is walkable; never fall back to a point across a river.
        return { gx: tower.gx, gy: tower.gy };
    }

    exitUnit(tower, u, slot) {
        const p = this.exitPosition(tower, slot);
        u.gx = p.gx; u.gy = p.gy; u.pgx = p.gx; u.pgy = p.gy;
        u.garrisonTowerId = null; u.garrisonOrderId = null; u.garrisonHeight = 0;
        u.target = null; u.meleeTarget = null; u.moveX = 0; u.moveY = 0;
        u.velX = 0; u.velY = 0;
        if (alive(u)) this.scene.battalions?.assignReinforcement(u);
    }

    ungarrison(team, towerId) {
        const b = this.getBuilding(towerId);
        if (!b || b.team !== team || (b.type !== 'tower' && b.type !== 'tent') || b.dead) return false;
        for (const u of this.scene.units) if (u.garrisonOrderId === b.id) u.garrisonOrderId = null;
        for (let i = 0; i < b.garrisonIds.length; i++) {
            const u = this.unit(b.garrisonIds[i]);
            if (u) this.exitUnit(b, u, i);
        }
        b.garrisonIds = [];
        return true;
    }

    damageBuilding(b, damage, source) {
        if (!b || this.getBuilding(b.id) !== b || b.dead || !Number.isFinite(damage) || damage <= 0 ||
            (source && (source.team === b.team || source.battleId !== b.battleId))) return 0;
        // 桥头工事：本点己方建筑受到伤害 −10%，只在统一结算入口应用一次；
        // 取整与最低伤害沿用既有口径（向下取整、至少 1 点），易主后立即失效。
        const scale = buildingDamageScale(this.scene, b);
        const finalDamage = scale === 1 ? damage : Math.max(1, Math.floor(damage * scale));
        const dealt = Math.min(b.hp, finalDamage);
        b.hp -= dealt;
        b.flashUntil = this.scene.simulationTime + 130;
        if (b.hp === 0) {
            b.dead = true;
            const w = this.unit(b.workerId);
            if (w?.workerTask?.buildingId === b.id) w.workerTask = null;
            b.workerId = null;
            for (let i = 0; i < b.garrisonIds.length; i++) {
                const u = this.unit(b.garrisonIds[i]);
                if (u) this.exitUnit(b, u, i);
            }
            b.garrisonIds = [];
            this.scene.addBattleEvent?.(`building-${b.id}-${Math.floor(this.scene.simulationTime)}`, `${b.team === 'red' ? '红方' : '蓝方'}${b.type === 'tower' ? '箭塔' : b.type === 'tent' ? '医帐' : b.siteId === 'home' ? '大本营' : '营寨'}被摧毁`, b.team);
            this.scene._countsDirty = true;
        }
        return dealt;
    }

    winner() {
        const red = this.getBuilding(this.id('red', 'camp', 'home'))?.dead;
        const blue = this.getBuilding(this.id('blue', 'camp', 'home'))?.dead;
        return red && blue ? 'draw' : red ? 'blue' : blue ? 'red' : null;
    }

    nearBuilding(unit, radius = 14) {
        let best = null, bestD = Infinity;
        const x0 = Math.floor(q(unit.gx - radius) / 16), x1 = Math.floor(q(unit.gx + radius) / 16);
        const y0 = Math.floor(q(unit.gy - radius) / 16), y1 = Math.floor(q(unit.gy + radius) / 16);
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
            for (const b of this.grid.get(`${x},${y}`) ?? []) {
                if (b.dead || b.team === unit.team || this.getBuilding(b.id) !== b) continue;
                const d = distance(unit, b);
                if (d > radius || d >= bestD) continue;
                best = b; bestD = d;
            }
        }
        return best;
    }

    localEnemy(unit, radius) {
        let best = null, bestD = Infinity;
        this.scene.forEachNear(unit.gx, unit.gy, radius, e => {
            if (!alive(e) || e.garrisonTowerId || e.team === unit.team || e.type === 'wagon') return;
            const d = distance(unit, e);
            if (d > radius || d > bestD || (d === bestD && best && e.id >= best.id)) return;
            best = e; bestD = d;
        });
        return best;
    }

    moveAroundBlockedBuilding(u, building, dt) {
        const mir = u.team === 'red' ? 1 : -1;
        const angle = Math.atan2(u.gy - building.gy, (u.gx - building.gx) * mir);
        const radius = building.radius + u.typeData.range * 0.85;
        for (const offset of [0.65, -0.65, 1.1, -1.1]) {
            const gx = q(building.gx + mir * Math.cos(angle + offset) * radius);
            const gy = q(building.gy + Math.sin(angle + offset) * radius);
            if (!Terrain.walkable(this.scene.battleOptions?.terrain, gx, gy, CombatRules.bodyRadius(u)) ||
                !CombatRules.clearLane(this.scene, u, building, undefined, gx, gy)) continue;
            let occupied = false;
            this.scene.forEachNear(gx, gy, 0.8, other => {
                if (other !== u && CombatRules.canBeHit(other) && distance({ gx, gy }, other) < q(CombatRules.contactDistance(u, other))) occupied = true;
            });
            if (occupied) continue;
            moveToward(u, gx, gy, u.typeData.speed, dt);
            return true;
        }
        return false; // No legal shoulder: let the ordinary AI deal with nearby combat/movement.
    }

    updateUnit(u, now, dt) {
        if (u.garrisonTowerId) {
            const tower = this.getBuilding(u.garrisonTowerId);
            if (!ready(u) || !tower || tower.dead) {
                if (tower) { tower.garrisonIds = tower.garrisonIds.filter(id => id !== u.id); this.exitUnit(tower, u, 0); }
                else { u.garrisonTowerId = null; u.garrisonHeight = 0; }
                return u.dead;
            }
            u.gx = tower.gx; u.gy = tower.gy; u.moving = false;
            // 驻塔弓手按自身冷却射击；驻帐医师只提供疗伤加成（HealingSystem 读取）。
            if (tower.type === 'tower') {
                const enemy = this.localEnemy(u, CAMP_RULES.TOWER_RANGE);
                u.target = enemy;
                if (enemy && q(now - u.lastAttack) >= u.typeData.atkSpeed) {
                    u.lastAttack = now;
                    this.scene.playAttackAnim?.(u, enemy);
                    this.scene.fireArrow(u, enemy);
                }
            } else u.target = null;
            return true;
        }
        // F4：骑兵营队回撤令优先于攻寨自动接管——正在打建筑的骑兵收到回撤令必须
        // 立即脱战（交还 battalionDirectCavalry 的回撤分支行军）。只豁免"骑兵+营队
        // 回撤"这一条路径：民夫自卫、驻塔、施工、医师与其余兵种的攻寨行为不变。
        if (u.type === 'cavalry' && u.battalion?.retreat && !u.battalion.gathering) return false;
        if (!ready(u)) return false;
        if (u.type === 'worker') {
            // 自卫优先：近身有敌就地还手、原地不动；脱离交战才回到原移动 / 施工任务。
            if (updateWorkerCombat(this.scene, u, now)) return true;
            const task = u.workerTask;
            if (task?.kind === 'move') {
                if (distance(u, task) <= 0.3) u.workerTask = null;
                else moveToward(u, task.gx, task.gy, u.typeData.speed, dt);
            } else if (task?.kind === 'build') {
                const b = this.getBuilding(task.buildingId);
                if (!b || b.dead || b.complete) this.releaseWorker(u);
                else if (this.ownsSite(u.team, b.siteId) && distance(u, b) > CAMP_RULES.BUILD_REACH) moveToward(u, b.gx, b.gy, u.typeData.speed, dt);
            }
            return true;
        }
        if (u.garrisonOrderId) {
            const b = this.getBuilding(u.garrisonOrderId);
            if (!b || b.dead || b.team !== u.team || !b.complete) u.garrisonOrderId = null;
            else if (distance(u, b) <= CAMP_RULES.ENTER_REACH && b.garrisonIds.length < b.capacity) {
                // Enter in the settlement phase, so later planners see the same ground snapshot.
                u.moveX = 0; u.moveY = 0;
                return true;
            } else if (!this.localEnemy(u, 4)) {
                moveToward(u, b.gx, b.gy, u.typeData.speed, dt);
                return true;
            }
        }
        // 医师不由营寨系统驱动（随营行军+急救光环见 healing.updateMedic），
        // 但也不能落入下面的攻寨分支（无攻击却会摸建筑）。
        if (u.type === 'medic') return false;
        let b = this.getBuilding(u.orderBuildingId);
        if (b?.dead) { u.orderBuildingId = null; b = null; }
        if (!b) b = this.nearBuilding(u);
        if (!b || this.localEnemy(u, u.typeData.ranged ? 5 : 4)) return false;
        const reach = u.typeData.range + b.radius;
        u.target = b;
        if (distance(u, b) > reach) moveToward(u, b.gx, b.gy, u.typeData.speed, dt);
        else if (!u.typeData.ranged && !CombatRules.clearLane(this.scene, u, b)) {
            return this.moveAroundBlockedBuilding(u, b, dt);
        } else if (q(now - u.lastAttack) >= u.typeData.atkSpeed && (u.typeData.ranged ||
            Terrain.segmentClear(this.scene.battleOptions?.terrain, u.gx, u.gy, b.gx, b.gy))) {
            u.lastAttack = now;
            this.scene.playAttackAnim?.(u, b);
            if (u.typeData.ranged) this.scene.fireArrow(u, b);
            else {
                const epoch = u.actionEpoch;
                this.scene.scheduleBattleAction(95, () => {
                    if (this.scene.battleOver || u.actionEpoch !== epoch || !ready(u) || b.dead || distance(u, b) > reach + 0.15 ||
                        !CombatRules.clearLane(this.scene, u, b)) return;
                    this.damageBuilding(b, Math.max(1, u.typeData.atk - b.typeData.def), u);
                    this.scene.meleeImpact?.(u, b);
                });
            }
        }
        return true;
    }

    update(dt) {
        this.refreshUnits();
        for (const u of this.scene.units) {
            const b = this.getBuilding(u.garrisonOrderId);
            if (!ready(u) || !b || b.dead || !b.complete || u.garrisonTowerId ||
                distance(u, b) > CAMP_RULES.ENTER_REACH || b.garrisonIds.length >= b.capacity) continue;
            b.garrisonIds.push(u.id); b.garrisonIds.sort((a, z) => a - z);
            u.garrisonTowerId = b.id; u.garrisonOrderId = null; u.garrisonHeight = b.garrisonHeight;
            u.gx = b.gx; u.gy = b.gy; u.pgx = b.gx; u.pgy = b.gy;
            u.moveX = 0; u.moveY = 0; u.pushX = 0; u.pushY = 0;
            u.actionEpoch = (u.actionEpoch ?? 0) + 1;
            u.battalion = null; u.meleeTarget = null; u.target = null;
        }
        for (const b of this.buildings) {
            if (b.dead) continue;
            b.garrisonIds = b.garrisonIds.filter(id => alive(this.unit(id)) && this.unit(id).garrisonTowerId === b.id);
            if (b.complete) continue;
            const w = this.unit(b.workerId);
            if (!alive(w)) b.workerId = null;
            // 交战停工：民夫近身交战时施工暂停，脱离交战后继续原任务（进度不重置）。
            b.paused = !ready(w) || !this.ownsSite(b.team, b.siteId) || w.workerTask?.buildingId !== b.id ||
                distance(w, b) > CAMP_RULES.BUILD_REACH || workerConstructionPaused(w, this.scene.simulationTime);
            if (b.paused) continue;
            // 林口营建：本点归属方施工速度 ×1.25（有效施工时间 −20%），只加快施工。
            b.progress = Math.min(1, b.progress + dt * buildSpeedScale(this.scene, b) / CAMP_RULES[b.type].seconds);
            if (b.progress >= 1 - 1e-9) {
                b.progress = 1; b.complete = true; b.workerId = null; w.workerTask = null;
                this.scene._countsDirty = true;
            }
        }
        if (q(this.scene.simulationTime) < q(this.nextThink)) return;
        this.nextThink = this.scene.simulationTime + CAMP_RULES.AI_INTERVAL_MS;
        for (const team of ['red', 'blue']) if (this.scene.territory.autoBuy?.[team]) this.ai(team);
    }

    ai(team) {
        const workers = this.scene.units.filter(u => ready(u) && u.team === team && u.type === 'worker').sort((a, b) => a.id - b.id);
        const recruit = this.scene.territory.recruit;
        if (workers.length + recruit.queues[team].filter(i => i.type === 'worker').length < 2) recruit.enqueue(team, 'worker');
        for (const w of workers) {
            if (w.workerTask) continue;
            const owned = (this.scene.flags ?? []).map((f, i) => ({ f, i })).filter(({ f }) => f.owner === team);
            // 建设链：营寨 → 箭塔 → 医帐（有医帐的据点收容力翻倍，AI 同样受益）。
            // 据点特色偏好：同等距离时优先能把建筑放进有奖励的据点（林口加速、路口扩收容、桥头护塔）；
            // 纯读当前归属，无随机数，红蓝镜像同序。
            const plans = owned.map(({ f, i }) => {
                const camp = this.getBuilding(this.id(team, 'camp', i));
                const tower = this.getBuilding(this.id(team, 'tower', i));
                const kind = !camp || camp.dead || !camp.complete ? 'camp'
                    : !tower || tower.dead || !tower.complete ? 'tower' : 'tent';
                return { i, kind, d: distance(w, f), bonus: buildSiteBonus(this.scene, team, i, kind) };
            }).sort((a, b) => (a.d - a.bonus) - (b.d - b.bonus) ||
                this.scene.flags[a.i].gy - this.scene.flags[b.i].gy || a.i - b.i);
            for (const plan of plans) if (this.requestBuild(team, w.id, plan.kind, plan.i)) break;
        }
        const archers = this.scene.units.filter(u => ready(u) && u.team === team && u.type === 'archer' && !u.garrisonTowerId && !u.garrisonOrderId && !u.orderBuildingId && !u.battalion?.playerOrdered).sort((a, b) => a.id - b.id);
        for (const tower of this.buildings) {
            if (tower.team !== team || tower.dead || !tower.complete || tower.type !== 'tower') continue;
            // Keep most archers in the field. AI staffs each tower with two rather than draining whole battalions.
            if (this.reserved(tower) >= 2) continue;
            const choices = archers.filter(u => !u.garrisonOrderId && !u.garrisonTowerId && !u.orderBuildingId && distance(u, tower) <= 28)
                .sort((a, b) => distance(a, tower) - distance(b, tower) || a.id - b.id);
            this.orderGarrison(team, choices.slice(0, 2 - this.reserved(tower)).map(u => u.id), tower.id);
        }
    }

    aiSavingsBudget(team) {
        if (!this.scene.units.some(u => ready(u) && u.team === team && u.type === 'worker' && !u.workerTask)) return 0;
        for (let i = 0; i < (this.scene.flags?.length ?? 0); i++) {
            if (!this.ownsSite(team, i) || this.buildings.some(b => !b.dead && b.siteId === i && b.team !== team)) continue;
            const camp = this.getBuilding(this.id(team, 'camp', i));
            const tower = this.getBuilding(this.id(team, 'tower', i));
            const tent = this.getBuilding(this.id(team, 'tent', i));
            if ((!camp || camp.dead) && this.placement(team, 'camp', i)) return CAMP_RULES.camp.cost;
            if (camp?.complete && (!tower || tower.dead) && this.placement(team, 'tower', i)) return CAMP_RULES.tower.cost;
            if (camp?.complete && tower?.complete && (!tent || tent.dead) && this.placement(team, 'tent', i)) return CAMP_RULES.tent.cost;
        }
        return 0;
    }
}
