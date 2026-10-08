import { homePosition } from '../territory-map.js';
// Territory construction and garrisons. All clocks and decisions use simulation state.
import { board } from '../board.js';
import { Terrain } from '../terrain.js';
import { CombatRules } from '../combat.js';
import { moveToward, calculateAttackDamage, resolveAttack } from '../units.js';
import { quantizeDecision as q } from './determinism.js';
import { HEALING_RULES } from './healing.js';
import { updateWorkerCombat, workerConstructionPaused } from './worker.js';
import { buildSpeedScale, buildingDamageScale, buildSiteBonus } from './site-traits.js';
import { RELATIONS_MUTUAL, activeTeams, isHostile, sameSide, canonicalOf, teamName, TEAMS } from '../factions.js';

export const CAMP_RULES = {
    camp: { cost: 160, seconds: 18, hp: 850, def: 10, radius: 2.2 },
    tower: { cost: 120, seconds: 14, hp: 1200, def: 6, radius: 0.9 },
    tent: { cost: 140, seconds: 15, hp: 550, def: 4, radius: 1.5 },   // 医帐：据点疗伤提速扩容
    HOME_HP: 1800, FIELD_TOWER_CAP: 8, ENEMY_HOME_CLEARANCE: 12, TOWER_ATTACK: 1.20, CAPACITY: 4, TOWER_RANGE: 14, GARRISON_HEIGHT_PX: 82,
    TENT_GARRISON_HEIGHT_PX: 14,   // 医帐无高台：驻帐军医站在帐篷门口地面，不上 82px 平台
    BUILD_REACH: 1.6, ENTER_REACH: 1.15, AI_INTERVAL_MS: 1800,
    // 营寨守军：近战兵站上寨墙垛口，居高临下打得更狠、也更耐打（可被击杀，攻方有解法）。
    // 垛口数按寨墙周长推：前线营寨 6、大本营 10；墙环半径与渲染层栅栏同一口径。
    WALL_SLOTS: 6, HOME_WALL_SLOTS: 10, WALL_RADIUS: 2.65, HOME_WALL_RADIUS: 3.5,
    WALL_GUARD_MELEE: ['infantry', 'axe', 'pikeman', 'cavalry'],
    WALL_GUARD_ATTACK: 1.25,       // 居高临下：守军造成的伤害倍率
    WALL_GUARD_COVER: 0.7,         // 居高临下：守军受到的伤害倍率
    WALL_GUARD_ENGAGE: 6,          // 寨墙外这个距离内的敌人，会把守军引到最近的一段墙
    WALL_GUARD_LIFT_PX: 28         // 站上墙顶的抬升（墙贴图 80×98、锚点在 70/98）
};

// 寨墙环几何：与渲染层的方形栅栏同口径（边长 2r，参数从左上角起顺时针一圈）。
export function wallRadius(building) {
    return building?.siteId === 'home' ? CAMP_RULES.HOME_WALL_RADIUS : CAMP_RULES.WALL_RADIUS;
}
export function wallSlots(building) {
    return building?.siteId === 'home' ? CAMP_RULES.HOME_WALL_SLOTS : CAMP_RULES.WALL_SLOTS;
}
export function wallPerimeter(building) { return 8 * wallRadius(building); }
export function wallPointAt(building, t) {
    const r = wallRadius(building), side = 2 * r, per = 8 * r;
    const s = ((t % per) + per) % per;
    const corners = [[-r, -r], [r, -r], [r, r], [-r, r]];
    const i = Math.min(3, Math.floor(s / side));
    const k = (s - i * side) / side;
    const [x0, y0] = corners[i], [x1, y1] = corners[(i + 1) % 4];
    return { gx: q(building.gx + x0 + (x1 - x0) * k), gy: q(building.gy + y0 + (y1 - y0) * k) };
}
// 墙环上离给定点最近的位置参数：中心朝目标方向射线与正方形边界的交点。
export function wallParamToward(building, gx, gy) {
    const r = wallRadius(building), side = 2 * r;
    const dx = gx - building.gx, dy = gy - building.gy;
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    if (m < 1e-6) return 0;
    const ex = dx / m * r, ey = dy / m * r;
    if (Math.abs(ex) >= Math.abs(ey)) return q(ex > 0 ? side + (ey + r) : 3 * side + (r - ey));
    return q(ey < 0 ? ex + r : 2 * side + (r - ex));
}
// 第 index 个垛口的墙环参数（守军无敌人时的岗位）。
export function wallSlotParam(building, index) {
    const slots = Math.max(1, wallSlots(building));
    return q((Math.max(0, index) % slots) * wallPerimeter(building) / slots);
}

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
        this.nextBuildingSeq = 1;
        this.byId = new Map();
        this.grid = new Map();
        this.unitsById = new Map();
        this.refreshUnits();
        for (const team of activeTeams(scene)) {
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
                : kind === 'tent' ? HEALING_RULES.TENT_MEDIC_SLOTS
                    : kind === 'camp' ? CAMP_RULES.WALL_SLOTS : 0
        } : null;
    }
    projection() {
        return {
            nextThink: this.nextThink, nextBuildingSeq: this.nextBuildingSeq,
            buildings: this.buildings.map(b => ({ id: b.id, type: b.type, team: b.team, siteId: b.siteId,
                gx: b.gx, gy: b.gy, hp: b.hp, maxHp: b.maxHp, progress: b.progress,
                complete: b.complete, dead: b.dead, workerId: b.workerId, paused: b.paused,
                garrisonIds: [...b.garrisonIds] }))
        };
    }
    unit(id) { return this.unitsById.get(id) ?? this.scene.units.find(u => u.id === id); }
    id(team, type, siteId) { return `${type}:${team}:${siteId}`; }
    site(team, siteId) {
        if (siteId === 'home') return homePosition(team, board.W, board.H, this.scene.battleOptions?.coop);
        return Number.isInteger(siteId) ? this.scene.flags?.[siteId] : null;
    }
    ownsSite(team, siteId) {
        if (siteId === 'home') return true;
        const owner = this.site(team, siteId)?.owner;
        return owner != null && sameSide(this.scene, team, owner);
    }

    placement(team, type, siteId) {
        const s = this.site(team, siteId);
        if (!s) return null;
        const mir = team === 'red' ? 1 : team === 'blue' ? -1 : 0;   // 黑方（北侧）无横向镜像
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

    createBuilding(team, type, siteId, complete = false, positionOverride = null) {
        const position = positionOverride ?? this.placement(team, type, siteId);
        if (!position) return null;
        const rule = CAMP_RULES[type], home = type === 'camp' && siteId === 'home';
        const b = {
            id: siteId == null ? `${type}:${team}:field-${this.nextBuildingSeq++}` : this.id(team, type, siteId), type, team, siteId, ...position,
            hp: home ? CAMP_RULES.HOME_HP : rule.hp, maxHp: home ? CAMP_RULES.HOME_HP : rule.hp,
            progress: complete ? 1 : 0, complete, dead: false, workerId: null,
            paused: false, garrisonIds: [],
            capacity: type === 'tower' ? CAMP_RULES.CAPACITY
                : type === 'tent' ? HEALING_RULES.TENT_MEDIC_SLOTS
                    : type === 'camp' ? wallSlots({ siteId }) : 0,
            radius: rule.radius,
            garrisonHeight: type === 'tent' ? CAMP_RULES.TENT_GARRISON_HEIGHT_PX
                : type === 'camp' ? CAMP_RULES.WALL_GUARD_LIFT_PX : CAMP_RULES.GARRISON_HEIGHT_PX,
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

    // Buildings remain outside dynamic navigation; bridge mouths stay clear by placement rules.
    towerPlacement(team, gx, gy) {
        const position = { gx: Number.isFinite(gx) ? q(gx) : gx, gy: Number.isFinite(gy) ? q(gy) : gy };
        const reject = reason => ({ ...position, ok: false, reason });
        if (!activeTeams(this.scene).includes(team)) return reject('无效阵营');
        const radius = CAMP_RULES.tower.radius, terrain = this.scene.battleOptions?.terrain;
        if (!Terrain.walkable(terrain, position.gx, position.gy, radius)) return reject('箭塔需要完整可通行的陆地');
        const zones = Terrain.geometry(terrain).zones;
        if (zones.some(zone => ['bridge', 'shallow', 'water'].includes(zone.kind) &&
            Terrain.contains(zone, position.gx, position.gy, radius + (zone.kind === 'bridge' ? 1 : 0)))) {
            return reject('桥面、桥口与浅滩需要保持通行');
        }
        if (this.buildings.some(b => !b.dead && distance(b, position) < b.radius + radius + 0.5)) return reject('与已有建筑距离太近');
        if (activeTeams(this.scene).some(enemy => isHostile(this.scene, team, enemy) &&
            distance(position, this.site(enemy, 'home')) < CAMP_RULES.ENEMY_HOME_CLEARANCE + radius)) return reject('距离敌方大本营至少12格');
        if (this.buildings.filter(b => !b.dead && b.team === team && b.type === 'tower' && b.siteId !== 'home').length >= CAMP_RULES.FIELD_TOWER_CAP) {
            return reject('每方最多8座野外箭塔（含施工中）');
        }
        return { ...position, ok: true, reason: '' };
    }

    requestBuildAt(team, workerId, kind, gx, gy, buildingId = null) {
        const w = this.unit(workerId);
        if (kind !== 'tower' || !activeTeams(this.scene).includes(team) || !ready(w) || w.type !== 'worker' || w.team !== team) return false;
        let b = buildingId ? this.getBuilding(buildingId) : null;
        if (buildingId) {
            if (!b || b.dead || b.type !== 'tower' || b.team !== team || b.complete ||
                (b.workerId != null && b.workerId !== w.id && ready(this.unit(b.workerId)))) return false;
        } else {
            const p = this.towerPlacement(team, gx, gy);
            if (!p.ok) return false;
            const terrain = this.scene.battleOptions?.terrain, radius = CombatRules.bodyRadius(w);
            if (!Terrain.segmentClear(terrain, w.gx, w.gy, p.gx, p.gy, radius) &&
                !this.scene.ensureNavigation().plan(w, p, radius).length) return false;
            const econ = this.scene.territory.econ, rule = CAMP_RULES.tower;
            if (Math.floor((econ.treasury[team] + 1e-7) * 20) / 20 < rule.cost) return false;
            b = this.createBuilding(team, 'tower', null, false, { gx: p.gx, gy: p.gy });
            econ.treasury[team] -= rule.cost;
            econ.spent[team] += rule.cost;
        }
        this.releaseWorker(w);
        b.workerId = w.id;
        w.workerTask = { kind: 'build', buildingId: b.id };
        return true;
    }

    canConstruct(b) { return b.siteId == null || this.ownsSite(b.team, b.siteId); }

    requestBuild(team, workerId, kind, siteId) {
        const w = this.unit(workerId), rule = CAMP_RULES[kind];
        if (!activeTeams(this.scene).includes(team) || !['camp', 'tower', 'tent'].includes(kind) || !rule || !ready(w) || w.type !== 'worker' || w.team !== team ||
            siteId === 'home' || !this.ownsSite(team, siteId) || !this.placement(team, kind, siteId)) return false;
        const camp = this.getBuilding(this.id(team, 'camp', siteId));
        if (kind === 'tent' && (!camp?.complete || camp.dead)) return false;
        let b = this.getBuilding(this.id(team, kind, siteId));
        if (b && !b.dead && (b.complete || (b.workerId != null && b.workerId !== w.id && ready(this.unit(b.workerId))))) return false;
        // A captured flag does not transfer its surviving enemy fortification.
        if (this.buildings.some(other => !other.dead && other.siteId === siteId && other.team !== team)) return false;
        if (!b || b.dead) {
            if (kind === 'tower' && this.buildings.filter(b => !b.dead && b.type === 'tower' && b.team === team && b.siteId !== 'home').length >= CAMP_RULES.FIELD_TOWER_CAP) return false;
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
        for (const u of this.scene.units) if (ready(u) && u.garrisonOrderId === tower.id && !u.garrisonTowerId && !u.wallGuardId) n++;
        return n;
    }

    // 驻军指令被拒的具体原因（UI 反馈与容量判断共用同一口径，避免两处各写一套）。
    // 返回 null 表示可以受理。容量计入"已预约入驻"的弓手，防止重复下令超额预订。
    garrisonRejectReason(team, towerId, unitIds = null) {
        const b = this.getBuilding(towerId);
        if (!b) return '请点选一座建筑';
        const acceptType = b.type === 'tower' ? 'archer' : b.type === 'tent' ? 'medic' : null;
        if (!acceptType) return '这里不能驻军：只有箭塔收弓手、医帐收军医';
        if (b.dead) return '这座建筑已被摧毁';                 // 先看是否还存在，再看归属
        if (!sameSide(this.scene, b.team, team)) return `这是敌方${b.type === 'tower' ? '箭塔' : '医帐'}，不能驻军`;
        if (!b.complete) return `${b.type === 'tower' ? '箭塔' : '医帐'}尚未完工，民夫施工完成后才能驻军`;
        const cap = b.capacity;
        if (this.reserved(b) >= cap) return `${b.type === 'tower' ? '箭塔' : '医帐'}已满（${this.reserved(b)}/${cap}，含正在前往的）`;
        if (Array.isArray(unitIds)) {
            const candidates = [...new Set(unitIds)].map(id => this.unit(id))
                .filter(u => ready(u) && u.team === team && u.type === acceptType && !u.garrisonTowerId && u.garrisonOrderId !== towerId);
            if (!candidates.length) return acceptType === 'archer' ? '选中的部队里没有可入驻的弓箭手' : '选中的部队里没有可入驻的军医';
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
        // 箭塔收弓手；医帐收军医；营寨收近战（上墙当守军）。其它组合一律不接受。
        const acceptTypes = b?.type === 'tower' ? ['archer']
            : b?.type === 'tent' ? ['medic']
                : b?.type === 'camp' ? CAMP_RULES.WALL_GUARD_MELEE : null;
        if (!b || !acceptTypes || !sameSide(this.scene, b.team, team) || b.dead || !b.complete || !Array.isArray(unitIds)) return [];
        let count = this.reserved(b);
        const accepted = [];
        for (const id of [...new Set(unitIds)].sort((a, z) => a - z)) {
            const u = this.unit(id);
            if (!ready(u) || u.team !== team || !acceptTypes.includes(u.type) || u.garrisonTowerId || u.wallGuardId ||
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
        if (!b || b.dead || !isHostile(this.scene, team, b.team) || !Array.isArray(unitIds)) return false;
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

    // 上墙：守军站到自己的垛口，取得居高临下的攻防加成；仍是普通单位，可被击杀（攻方的解法）。
    mountWallGuard(b, u) {
        u.wallGuardId = b.id;
        u.garrisonHeight = b.garrisonHeight;
        u.guardCoverScale = CAMP_RULES.WALL_GUARD_COVER;
        u.guardSlot = Math.max(0, b.garrisonIds.indexOf(u.id));
        const p = wallPointAt(b, wallSlotParam(b, u.guardSlot));
        u.gx = p.gx; u.gy = p.gy; u.pgx = p.gx; u.pgy = p.gy;
        u.moving = false; u.velX = 0; u.velY = 0;
    }

    exitUnit(tower, u, slot) {
        const p = this.exitPosition(tower, slot);
        u.gx = p.gx; u.gy = p.gy; u.pgx = p.gx; u.pgy = p.gy;
        u.garrisonTowerId = null; u.garrisonOrderId = null; u.garrisonHeight = 0;
        u.wallGuardId = null; u.guardCoverScale = 1; u.guardSlot = null;
        u.target = null; u.meleeTarget = null; u.moveX = 0; u.moveY = 0;
        u.velX = 0; u.velY = 0;
        if (alive(u)) this.scene.battalions?.assignReinforcement(u);
    }

    ungarrison(team, towerId) {
        const b = this.getBuilding(towerId);
        if (!b || !sameSide(this.scene, b.team, team) || !['tower', 'tent', 'camp'].includes(b.type) || b.dead) return false;
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
            (source && (!isHostile(this.scene, source.team, b.team) || source.battleId !== b.battleId))) return 0;
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
            this.scene.addBattleEvent?.(`building-${b.id}-${Math.floor(this.scene.simulationTime)}`, `${teamName(b.team)}${b.type === 'tower' ? '箭塔' : b.type === 'tent' ? '医帐' : b.siteId === 'home' ? '大本营' : '营寨'}被摧毁`, b.team);
            this.scene._countsDirty = true;
        }
        return dealt;
    }

    winner() {
        // 按同盟组判定：某组所有大本营尽毁即该组战败；仅剩一组存活时该组代表获胜。
        // 二元模式 groups=[[red],[blue],[black]]，黑方未参战被过滤，结果与旧实现逐位一致。
        const groups = this.scene.relationGroups || RELATIONS_MUTUAL;
        const active = groups.map((group, i) => ({ i, group,
            present: group.some(team => activeTeams(this.scene).includes(team)),
            defeated: group.every(team => this.getBuilding(this.id(team, 'camp', 'home'))?.dead === true) }))
            .filter(g => g.present);
        if (!active.length) return null;
        if (active.every(g => g.defeated)) return 'draw';
        const alive = active.filter(g => !g.defeated);
        return active.length > 1 && alive.length === 1 ? canonicalOf(alive[0].group) : null;
    }

    nearBuilding(unit, radius = 14) {
        let best = null, bestD = Infinity;
        const x0 = Math.floor(q(unit.gx - radius) / 16), x1 = Math.floor(q(unit.gx + radius) / 16);
        const y0 = Math.floor(q(unit.gy - radius) / 16), y1 = Math.floor(q(unit.gy + radius) / 16);
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
            for (const b of this.grid.get(`${x},${y}`) ?? []) {
                if (b.dead || !isHostile(this.scene, unit.team, b.team) || this.getBuilding(b.id) !== b) continue;
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
            if (!alive(e) || e.garrisonTowerId || !isHostile(this.scene, unit.team, e.team) || e.type === 'wagon') return;
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

    // 寨墙守军：沿墙环跑位——附近有敌人就赶到离他最近的一段墙、居高临下打；没有就回自己的垛口。
    // 站在墙上：造成伤害 ×1.25、受到伤害 ×0.7。溃逃或换防离开墙环就失去加成。
    updateWallGuard(u, now, dt) {
        const b = this.getBuilding(u.wallGuardId);
        if (!b || b.dead || !ready(u)) {
            if (b) { b.garrisonIds = b.garrisonIds.filter(id => id !== u.id); this.exitUnit(b, u, u.guardSlot ?? 0); }
            else { u.wallGuardId = null; u.guardCoverScale = 1; u.guardSlot = null; u.garrisonHeight = 0; }
            return u.dead;
        }
        const foe = this.localEnemy(u, CAMP_RULES.WALL_GUARD_ENGAGE);
        u.target = foe;
        const per = wallPerimeter(b);
        const have = wallParamToward(b, u.gx, u.gy);
        const want = foe ? wallParamToward(b, foe.gx, foe.gy) : wallSlotParam(b, u.guardSlot ?? 0);
        let diff = want - have;
        if (diff > per / 2) diff -= per;
        else if (diff < -per / 2) diff += per;
        if (Math.abs(diff) > 0.02) {
            const step = Math.min(Math.abs(diff), u.typeData.speed * dt) * Math.sign(diff);
            const at = wallPointAt(b, have + step);
            u.gx = at.gx; u.gy = at.gy;
            u.moving = true;
        } else u.moving = false;
        if (!foe || q(now - u.lastAttack) < u.typeData.atkSpeed) return true;
        const reach = u.typeData.range + 0.45;
        if (q(Math.hypot(foe.gx - u.gx, foe.gy - u.gy)) > reach) return true;
        u.lastAttack = now;
        this.scene.playAttackAnim?.(u, foe);
        const epoch = u.actionEpoch;
        this.scene.scheduleBattleAction(95, () => {
            if (this.scene.battleOver || u.actionEpoch !== epoch || !ready(u) || !foe || foe.dead || foe.withdrawn) return;
            if (q(Math.hypot(foe.gx - u.gx, foe.gy - u.gy)) > reach + 0.15) return;
            resolveAttack(foe, u, { multiplier: CAMP_RULES.WALL_GUARD_ATTACK });
            this.scene.meleeImpact?.(u, foe);
        });
        return true;
    }

    updateUnit(u, now, dt) {
        if (u.wallGuardId) return this.updateWallGuard(u, now, dt);
        if (u.garrisonTowerId) {
            const tower = this.getBuilding(u.garrisonTowerId);
            if (!ready(u) || !tower || tower.dead) {
                if (tower) { tower.garrisonIds = tower.garrisonIds.filter(id => id !== u.id); this.exitUnit(tower, u, 0); }
                else { u.garrisonTowerId = null; u.garrisonHeight = 0; }
                return u.dead;
            }
            u.gx = tower.gx; u.gy = tower.gy; u.moving = false;
            // 驻塔弓手按自身冷却射击；驻帐军医只提供疗伤加成（HealingSystem 读取）。
            if (tower.type === 'tower') {
                const enemy = this.localEnemy(u, CAMP_RULES.TOWER_RANGE);
                u.target = enemy;
                if (enemy && q(now - u.lastAttack) >= u.typeData.atkSpeed) {
                    u.lastAttack = now;
                    this.scene.playAttackAnim?.(u, enemy);
                    this.scene.fireArrow(u, enemy, { rawAttack: u.typeData.atk * CAMP_RULES.TOWER_ATTACK });
                }
            } else u.target = null;
            return true;
        }
        // Explicit building attacks stay committed through nearby defenders; a battalion
        // retreat still cancels them immediately for every combat troop.
        if (u.battalion?.retreat && !u.battalion.gathering) { u.orderBuildingId = null; return false; }
        if (!ready(u)) return false;
        if (u.type === 'worker') {
            // 自卫优先：近身有敌就地还手、原地不动；脱离交战才回到原移动 / 施工任务。
            if (updateWorkerCombat(this.scene, u, now)) return true;
            const task = u.workerTask;
            if (task?.kind === 'gather' || task?.kind === 'deliver') {
                this.scene.territory.resources?.updateWorker(u, dt);
            } else if (task?.kind === 'move') {
                if (distance(u, task) <= 0.3) u.workerTask = null;
                else moveToward(u, task.gx, task.gy, u.typeData.speed, dt);
            } else if (task?.kind === 'build') {
                const b = this.getBuilding(task.buildingId);
                if (!b || b.dead || b.complete) this.releaseWorker(u);
                else if (this.canConstruct(b) && distance(u, b) > CAMP_RULES.BUILD_REACH) moveToward(u, b.gx, b.gy, u.typeData.speed, dt);
            }
            return true;
        }
        if (u.garrisonOrderId) {
            const b = this.getBuilding(u.garrisonOrderId);
            if (!b || b.dead || !sameSide(this.scene, b.team, u.team) || !b.complete) u.garrisonOrderId = null;
            else if (distance(u, b) <= CAMP_RULES.ENTER_REACH && b.garrisonIds.length < b.capacity) {
                // Enter in the settlement phase, so later planners see the same ground snapshot.
                u.moveX = 0; u.moveY = 0;
                return true;
            } else if (!this.localEnemy(u, 4)) {
                moveToward(u, b.gx, b.gy, u.typeData.speed, dt);
                return true;
            }
        }
        // 军医不由营寨系统驱动（随营行军+急救光环见 healing.updateMedic），
        // 但也不能落入下面的攻寨分支（无攻击却会摸建筑）。
        if (u.type === 'medic') return false;
        let b = this.getBuilding(u.orderBuildingId);
        if (b?.dead) { u.orderBuildingId = null; b = null; }
        if (!b) b = this.nearBuilding(u);
        if (!b || (!u.orderBuildingId && this.localEnemy(u, u.typeData.ranged ? 5 : 4))) return false;
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
                    this.damageBuilding(b, calculateAttackDamage(u, b), u);
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
            if (!ready(u) || !b || b.dead || !b.complete || u.garrisonTowerId || u.wallGuardId ||
                distance(u, b) > CAMP_RULES.ENTER_REACH || b.garrisonIds.length >= b.capacity) continue;
            b.garrisonIds.push(u.id); b.garrisonIds.sort((a, z) => a - z);
            u.garrisonOrderId = null;
            u.moveX = 0; u.moveY = 0; u.pushX = 0; u.pushY = 0;
            u.actionEpoch = (u.actionEpoch ?? 0) + 1;
            u.battalion = null; u.meleeTarget = null; u.target = null;
            if (b.type === 'camp') this.mountWallGuard(b, u);
            else {
                u.garrisonTowerId = b.id; u.garrisonHeight = b.garrisonHeight;
                u.gx = b.gx; u.gy = b.gy; u.pgx = b.gx; u.pgy = b.gy;
            }
        }
        for (const b of this.buildings) {
            if (b.dead) continue;
            b.garrisonIds = b.garrisonIds.filter(id => {
                const u = this.unit(id);
                if (!u) return false;
                // 阵亡守军：清掉墙上的加成与抬升，避免尸身留在墙顶继续吃掩体系数
                if (!alive(u)) {
                    if (u.wallGuardId === b.id) {
                        u.wallGuardId = null; u.guardCoverScale = 1; u.guardSlot = null; u.garrisonHeight = 0;
                    }
                    return false;
                }
                return b.type === 'camp' ? u.wallGuardId === b.id : u.garrisonTowerId === b.id;
            });
            if (b.complete) continue;
            const w = this.unit(b.workerId);
            if (!alive(w)) b.workerId = null;
            // 交战停工：民夫近身交战时施工暂停，脱离交战后继续原任务（进度不重置）。
            b.paused = !ready(w) || !this.canConstruct(b) || w.workerTask?.buildingId !== b.id ||
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
        for (const team of activeTeams(this.scene)) if (this.scene.territory.autoBuy?.[team]) this.ai(team);
    }

    ai(team) {
        const workers = this.scene.units.filter(u => ready(u) && u.team === team && u.type === 'worker').sort((a, b) => a.id - b.id);
        const recruit = this.scene.territory.recruit;
        if (workers.length + recruit.queues[team].filter(i => i.type === 'worker').length < 2) recruit.enqueue(team, 'worker');
        for (const w of workers) {
            if (w.workerTask) continue;
            const owned = (this.scene.flags ?? []).map((f, i) => ({ f, i }))
                .filter(({ f }) => f.owner != null && sameSide(this.scene, team, f.owner));
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
        // 前线营寨上墙：每座就近派 2 名近战守军。大本营营寨不驻——AI 得把主力留在野战，
        // 否则一座座营寨会把部队钉死在原地，战线推不动。
        const melee = this.scene.units.filter(u => ready(u) && u.team === team &&
            CAMP_RULES.WALL_GUARD_MELEE.includes(u.type) && !u.garrisonTowerId && !u.wallGuardId &&
            !u.garrisonOrderId && !u.orderBuildingId && !u.battalion?.playerOrdered).sort((a, b) => a.id - b.id);
        for (const camp of this.buildings) {
            if (camp.team !== team || camp.dead || !camp.complete || camp.type !== 'camp' || camp.siteId === 'home') continue;
            const need = Math.min(2, camp.capacity) - this.reserved(camp);
            if (need <= 0) continue;
            const choices = melee.filter(u => !u.garrisonOrderId && !u.wallGuardId && !u.orderBuildingId && distance(u, camp) <= 30)
                .sort((a, b) => distance(a, camp) - distance(b, camp) || a.id - b.id);
            if (choices.length) this.orderGarrison(team, choices.slice(0, need).map(u => u.id), camp.id);
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
