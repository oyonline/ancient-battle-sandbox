import { installSiegeRules } from './siege-rules.js';
import { installSiegeDefense } from './siege-defense.js';
import { installPlayerAssault } from './siege-assault.js';
import { CAMP_RULES } from './camps.js';
import { CombatRules } from '../combat.js';
import { Terrain } from '../terrain.js';
import { isHostile } from '../factions.js';
import { moveToward } from '../units.js';
import { board } from '../board.js';

// Terrain height units: 1 height = HEIGHT_SCALE screen pixels = H_WORLD world units.
export function createSiegeLayer(platforms = [], assault = null) {
    // The battle scene has no battle seed. A fixed seed and layer-local sample
    // counter keep shots reproducible; redeployment creates a fresh layer.
    let scatterCounter = 0;
    const random = () => {
        let h = ((assault?.scatterSeed ?? 0x6d2b79f5) + Math.imul(++scatterCounter, 0x6d2b79f5)) | 0;
        h = Math.imul(h ^ (h >>> 15), h | 1);
        h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
        return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
    };
    const rects = platforms.map(p => ({ ...p }));
    const heightAt = (gx, gy) => {
        let height = 0;
        for (const p of rects) {
            if (gx >= p.x1 && gx <= p.x2 && gy >= p.y1 && gy <= p.y2) height = Math.max(height, p.height);
        }
        return height;
    };
    const layer = {
        platforms: rects,
        heightAt,
        scatterArrow(arrow, from) {
            const radius = .12 * Math.hypot(arrow.tx - from.gx, arrow.ty - from.gy);
            const r = radius * Math.sqrt(random()), angle = 2 * Math.PI * random();
            arrow.tx = Math.max(.5, Math.min(board.W - .5, arrow.tx + r * Math.cos(angle)));
            arrow.ty = Math.max(.5, Math.min(board.H - .5, arrow.ty + r * Math.sin(angle)));
        },
        meleeBypass: () => false,
        damageScale(from, target) {
            const difference = heightAt(from.gx, from.gy) - heightAt(target.gx, target.gy);
            let scale = 1;
            if (difference >= .4) scale *= CAMP_RULES.WALL_GUARD_ATTACK;
            if (-difference >= .4) scale *= CAMP_RULES.WALL_GUARD_COVER;
            if (assault?.fenceCover !== undefined && from.typeData.ranged) {
                const b = assault.bounds, t = assault.wallThickness ?? 0;
                const inside = target.gx >= b.x1 && target.gx <= b.x2 && target.gy >= b.y1 && target.gy <= b.y2;
                const outside = from.gx < b.x1 - t || from.gx > b.x2 + t || from.gy < b.y1 - t || from.gy > b.y2 + t;
                if (inside && outside && from.scene.dynamicBlockers?.list.some(r =>
                    (r.kind === 'wall' || (r.kind === 'gate' && !layer.gate?.broken)) &&
                    crossesFence(r, from, target))) scale *= assault.fenceCover;
            }
            return scale;
        }
    };
    // Height-only layers retain the original shape and have no simulation hook.
    if (assault?.attackerControl) installPlayerAssault(layer, assault);
    if (assault?.gate && assault?.ram) installRam(layer, assault);
    if (assault?.ladders?.length) installLadders(layer, assault.ladders, assault.climbSeconds,
        assault.rules?.enabled ? assault.rules.climbersPerLadder : undefined, assault.ladderCarry);
    if (assault?.defense) installSiegeDefense(layer, assault.defense);
    if (assault?.infiltration) installSiegeAssault(layer, assault.infiltration);
    if (assault?.rules?.enabled) installSiegeRules(layer, assault.bounds, assault.rules, assault.wallThickness);
    return layer;
}

// Slab intersection like Terrain.sweep, but include rectangle edges: the two
// halves of a wall share a seam that must not become an arrow-sized opening.
function crossesFence(rect, from, target) {
    let enter = 0, leave = 1;
    for (const [start, delta, lo, hi] of [
        [from.gx, target.gx - from.gx, rect.x1, rect.x2],
        [from.gy, target.gy - from.gy, rect.y1, rect.y2]
    ]) {
        if (Math.abs(delta) < 1e-12) {
            if (start < lo || start > hi) return false;
        } else {
            const a = (lo - start) / delta, b = (hi - start) / delta;
            enter = Math.max(enter, Math.min(a, b));
            leave = Math.min(leave, Math.max(a, b));
        }
        if (enter > leave) return false;
    }
    return leave > 0 && enter < 1;
}

export const LADDER_LIP = .8;
const CLIMB_SECONDS = 2.5, LADDER_RECRUIT_MS = 1000;
// 搬运架设：双人满速、单人拖行半速、无人原地待援（掉落可捡）；
// 到位后架设 2s 才开放攀爬。班组招募与冲车同规则（就近 + id 决胜）。
const CARRY_SPEED = 1.9, DRAG_SPEED = 1, CREW_RECRUIT_MS = 1000, CREW_RADIUS = 6;
export const ERECT_MS = 2000;
const hookedMorale = new WeakSet();

function installLadders(layer, configs, climbSeconds = CLIMB_SECONDS, climbersPerLadder = 2, carry = false) {
    const landed = new WeakSet(), climbing = new Map();
    layer.landedCount = 0;
    layer.ladders = configs.map((c, i) => {
        const dx = c.top.gx - c.foot.gx, dy = c.top.gy - c.foot.gy;
        const length = Math.hypot(dx, dy);
        return {
            id: c.id ?? `ladder-${i}`, team: c.team ?? 'red',
            face: c.face,
            foot: { ...c.foot }, top: { ...c.top }, landing: { ...c.landing },
            across: { gx: dy / length, gy: -dx / length },
            climbers: Array(climbersPerLadder).fill(null), recruitMs: 0, initialized: false,
            // 搬运架设状态机：carrying -> erecting -> placed；无 carry 配置时直接可用。
            state: carry ? 'carrying' : 'placed',
            pos: { ...(carry ? c.start : c.foot) }, start: carry ? { ...c.start } : null,
            crew: [null, null], crewMs: 0, crewInitialized: false, erectMs: 0,
            carryDir: { gx: 0, gy: 0 }
        };
    });
    const alive = u => u && !u.dead && !u.withdrawn && u.hp > 0;
    const resetCombat = u => {
        u.actionEpoch++;
        u.target = u.meleeTarget = null;
        u.lastRetarget = -Infinity;
        u.strafeUntil = 0;
        u.blockedEngageAt = null;
        u.moving = false;
    };
    const release = (u, entry) => {
        entry.ladder.climbers[entry.slot] = null;
        climbing.delete(u);
        delete u.siegeAnchor;
        delete u.siegeRole;
        delete u.siegeClimb;
        resetCombat(u);
    };
    const releaseCrew = u => {
        if (!u) return;
        delete u.siegeRole;
        delete u.siegeAnchor;
        delete u.carryYaw;
        resetCombat(u);
    };
    // 搬运/架设步：班组校验 → 招募补员（就近 + id 决胜）→ 移位/架设 → 班组站位。
    // 班组位置每帧由梯子绝对摆放（同冲车），core 规划循环对 ladderCrew 直接跳过。
    const carryStep = (scene, ladder, dt) => {
        if (layer.assault?.player && !layer.assault.released[ladder.face]) return;
        const byId = new Map(scene.units.map(u => [u.id, u]));
        for (let i = 0; i < ladder.crew.length; i++) {
            const u = byId.get(ladder.crew[i]);
            if (!u || u.dead || u.withdrawn || u.moraleState === 'routing') { releaseCrew(u); ladder.crew[i] = null; }
        }
        ladder.crewMs += dt * 1000;
        if (!ladder.crewInitialized || ladder.crewMs + 1e-7 >= CREW_RECRUIT_MS) {
            ladder.crewMs = ladder.crewInitialized ? Math.max(0, ladder.crewMs - CREW_RECRUIT_MS) % CREW_RECRUIT_MS : 0;
            ladder.crewInitialized = true;
            const distance = u => Math.hypot(u.gx - ladder.pos.gx, u.gy - ladder.pos.gy);
            const candidates = scene.units.filter(u => alive(u) && u.moraleState !== 'routing' && u.team === ladder.team &&
                (!layer.assault?.player || u.siegeWing === ladder.face) &&
                u.type === 'infantry' && !u.siegeRamReserve && !u.siegeRole && !u.siegeAnchor && !u.siegeClimb && distance(u) <= CREW_RADIUS)
                .sort((a, b) => distance(a) - distance(b) || a.id - b.id);
            for (let i = 0; i < ladder.crew.length && candidates.length; i++) {
                if (ladder.crew[i] !== null) continue;
                const u = candidates.shift();
                ladder.crew[i] = u.id;
                u.siegeRole = 'ladderCrew';
                u.siegeAnchor = { ...ladder.pos };
                resetCombat(u);
                u.tacticalRole = null; u.guardAnchor = null; u.groundGuardReturning = false;
                scene.navigation?.routes.delete(u);
            }
        }
        const crewCount = ladder.crew.filter(id => id !== null).length;
        const dx = ladder.foot.gx - ladder.pos.gx, dy = ladder.foot.gy - ladder.pos.gy;
        const d = Math.hypot(dx, dy);
        if (d > 1e-9) ladder.carryDir = { gx: dx / d, gy: dy / d };
        if (ladder.state === 'carrying') {
            if (crewCount && d > 1e-9) {
                const stepLen = (crewCount >= 2 ? CARRY_SPEED : DRAG_SPEED) * dt;
                if (d <= Math.max(.12, stepLen)) {
                    ladder.pos = { ...ladder.foot };
                    ladder.state = 'erecting';
                } else {
                    ladder.pos.gx += ladder.carryDir.gx * stepLen;
                    ladder.pos.gy += ladder.carryDir.gy * stepLen;
                }
            }
        } else if (ladder.state === 'erecting') {
            ladder.erectMs += dt * 1000;
            if (ladder.erectMs + 1e-7 >= ERECT_MS) {
                ladder.state = 'placed';
                for (const id of ladder.crew) releaseCrew(byId.get(id));
                ladder.crew.fill(null);
                return;
            }
        }
        // 班组站位：搬运沿行进方向前后各一人，架设分站梯脚两侧（垂直于墙面朝外）。
        const ux = ladder.carryDir.gx, uy = ladder.carryDir.gy;
        for (let i = 0; i < ladder.crew.length; i++) {
            const u = byId.get(ladder.crew[i]);
            if (!u) continue;
            u.carryYaw = Math.atan2(ux, uy);   // 渲染层朝向（锚定单位不走位移跟随）
            if (ladder.state === 'carrying') {
                u.gx = u.siegeAnchor.gx = ladder.pos.gx + ux * (i === 0 ? .55 : -.55);
                u.gy = u.siegeAnchor.gy = ladder.pos.gy + uy * (i === 0 ? .55 : -.55);
            } else {
                u.gx = u.siegeAnchor.gx = ladder.foot.gx + ladder.across.gx * (i === 0 ? .35 : -.35) + ux * .4;
                u.gy = u.siegeAnchor.gy = ladder.foot.gy + ladder.across.gy * (i === 0 ? .35 : -.35) + uy * .4;
            }
        }
    };
    layer.releaseInvalidClimbers = () => {
        for (const [u, entry] of climbing) {
            if (alive(u) && u.moraleState !== 'routing') continue;
            if (alive(u)) {
                u.gx = entry.ladder.foot.gx; u.gy = entry.ladder.foot.gy;
                u.pgx = u.gx; u.pgy = u.gy;
            }
            release(u, entry);
        }
    };
    const pair = (climber, defender) => {
        const entry = climbing.get(climber);
        return !!entry && alive(climber) && climber.moraleState !== 'routing' &&
            entry.waiting && alive(defender) &&
            isHostile(climber.scene, entry.ladder.team, defender.team) &&
            Math.hypot(defender.gx - entry.landing.gx, defender.gy - entry.landing.gy) <= 1.2;
    };
    layer.meleeBypass = (from, target) => pair(from, target) || pair(target, from);
    // Core already routes anchored soldiers through ordinary AI. Handle only ladder
    // occupants here, keeping cooldown, friendly obstruction and delayed hits intact.
    layer.actClimber = (scene, unit, now) => {
        const entry = climbing.get(unit);
        if (!entry) return false;
        if (!entry.waiting) return true;
        const targets = scene.units.filter(u => pair(unit, u) && CombatRules.canStrike(scene, unit, u, unit.typeData.range))
            .sort((a, b) => Math.hypot(a.gx - unit.gx, a.gy - unit.gy) - Math.hypot(b.gx - unit.gx, b.gy - unit.gy) || a.id - b.id);
        if (targets.length) CombatRules.attack(scene, unit, targets[0], now);
        return true;
    };
    const ramStep = layer.step;
    layer.step = (scene, dt) => {
        if (scene.battleOver) return;
        ramStep?.(scene, dt);
        // Morale runs after damage in the same full step. Release deaths/routs there,
        // without adding a shared core hook or leaving a dead soldier in a slot.
        if (!hookedMorale.has(scene.morale)) {
            const update = scene.morale.update;
            scene.morale.update = function (elapsed) {
                const result = update.call(this, elapsed);
                scene.siege?.releaseInvalidClimbers?.();
                return result;
            };
            hookedMorale.add(scene.morale);
        }
        layer.releaseInvalidClimbers();
        if (scene.resolvingOutcome) return;
        for (const ladder of layer.ladders) {
            if (ladder.state !== 'placed') { carryStep(scene, ladder, dt); continue; }
            ladder.recruitMs += dt * 1000;
            if (!ladder.initialized || ladder.recruitMs + 1e-7 >= LADDER_RECRUIT_MS) {
                ladder.recruitMs = ladder.initialized ? Math.max(0, ladder.recruitMs - LADDER_RECRUIT_MS) % LADDER_RECRUIT_MS : 0;
                ladder.initialized = true;
                const distance = u => Math.hypot(u.gx - ladder.foot.gx, u.gy - ladder.foot.gy);
                const inward = u => (u.gx - ladder.top.gx) * (ladder.landing.gx - ladder.top.gx) +
                    (u.gy - ladder.top.gy) * (ladder.landing.gy - ladder.top.gy);
                const candidates = scene.units.filter(u => alive(u) && u.moraleState !== 'routing' && u.team === ladder.team &&
                    (!layer.assault?.player || u.siegeWing === ladder.face) &&
                    ['infantry', 'pikeman'].includes(u.type) && !u.siegeRamReserve && !u.siegeRole && !u.siegeAnchor && !landed.has(u) &&
                    inward(u) <= 0 && distance(u) <= 4)
                    .sort((a, b) => distance(a) - distance(b) || a.id - b.id);
                for (let slot = 0; slot < ladder.climbers.length && candidates.length; slot++) {
                    if (ladder.climbers[slot] !== null) continue;
                    const offset = slot === 0 ? -.2 : .2;
                    const u = candidates.shift(), entry = { ladder, slot, offset, progress: 0, height: 0, waiting: false,
                        landing: { gx: ladder.landing.gx + ladder.across.gx * offset,
                            gy: ladder.landing.gy + ladder.across.gy * offset } };
                    ladder.climbers[slot] = u.id;
                    climbing.set(u, entry);
                    u.siegeClimb = entry;
                    u.siegeRole = 'ladder';
                    u.siegeAnchor = { ...ladder.foot };
                    resetCombat(u);
                    u.tacticalRole = null; u.guardAnchor = null; u.groundGuardReturning = false;
                    scene.navigation?.routes.delete(u);
                }
            }
            for (const [u, entry] of climbing) {
                if (entry.ladder !== ladder) continue;
                const occupied = scene.units.some(u => alive(u) && isHostile(scene, ladder.team, u.team) &&
                    Math.hypot(u.gx - entry.landing.gx, u.gy - entry.landing.gy) <= .6);
                const next = entry.progress + dt / climbSeconds;
                entry.waiting = occupied && next >= LADDER_LIP;
                entry.progress = entry.waiting ? LADDER_LIP : Math.min(1, next + 1e-12 >= 1 ? 1 : next);
                entry.height = entry.progress * layer.heightAt(entry.landing.gx, entry.landing.gy);
                u.gx = u.siegeAnchor.gx = ladder.foot.gx + (ladder.top.gx - ladder.foot.gx) * entry.progress + ladder.across.gx * entry.offset;
                u.gy = u.siegeAnchor.gy = ladder.foot.gy + (ladder.top.gy - ladder.foot.gy) * entry.progress + ladder.across.gy * entry.offset;
                if (entry.progress < 1) continue;
                // The .3-inset walkway center is narrower than the .36 body radius.
                // Project inward to the existing legal ground position before AI resumes.
                const point = Terrain.projectPoint(scene.battleOptions.terrain, entry.landing.gx, entry.landing.gy,
                    CombatRules.bodyRadius(u), 0, scene.dynamicBlockers);
                u.gx = point.gx; u.gy = point.gy; u.pgx = u.gx; u.pgy = u.gy;
                landed.add(u); layer.landedCount++;
                release(u, entry);
            }
        }
        scene.rebuildSpatial();
    };
}

const IMPACT_MS = 2200, RECRUIT_MS = 2000;
const CREW_SLOTS = [[-.88, -.5], [.88, -.5], [-.88, .5], [.88, .5]];

function installRam(layer, { gate: config, ram: start }) {
    const gate = layer.gate = { blockerId: config.blockerId, hp: config.hp ?? 900, maxHp: config.hp ?? 900, broken: false, brokenAt: null };
    const restOffset = start.restOffset ?? 3.2;
    const ram = layer.ram = {
        gx: start.gx, gy: start.gateOuterY + restOffset, team: start.team ?? 'red',
        restY: start.gateOuterY + restOffset, hitY: start.gateOuterY + 1.45,
        state: 'advancing', crew: [null, null, null, null], initialized: false,
        recruitMs: 0, hitMs: 0, hits: 0, lastHitAt: null
    };
    const release = unit => {
        if (!unit) return;
        delete unit.siegeRole;
        delete unit.siegeAnchor;
        unit.target = null;
        unit.meleeTarget = null;
        unit.lastRetarget = -Infinity;
        unit.moving = false;
    };
    layer.step = (scene, dt) => {
        if (scene.battleOver || scene.resolvingOutcome) return;
        if (layer.assault?.player && !layer.assault.released.ram) return;
        if (ram.state === 'spent') {
            ram.gy = Math.min(ram.restY, ram.gy + .9 * dt);
            return;
        }
        const byId = new Map(scene.units.map(u => [u.id, u]));
        for (let i = 0; i < ram.crew.length; i++) {
            const unit = byId.get(ram.crew[i]);
            if (!unit || unit.dead || unit.withdrawn || unit.moraleState === 'routing') { release(unit); ram.crew[i] = null; }
        }
        ram.recruitMs += dt * 1000;
        if (!ram.initialized || ram.recruitMs + 1e-7 >= RECRUIT_MS) {
            const initial = !ram.initialized;
            ram.initialized = true;
            ram.recruitMs = initial ? 0 : ram.recruitMs - RECRUIT_MS;
            const distance = u => Math.hypot(u.gx - ram.gx, u.gy - ram.gy);
            const candidates = scene.units.filter(u => !u.dead && !u.withdrawn && u.moraleState !== 'routing' && u.team === ram.team &&
                (!layer.assault?.player || u.siegeWing === 'south') &&
                u.type === 'infantry' && !u.siegeRole && !u.siegeAnchor && distance(u) <= 6)
                .sort((a, b) => distance(a) - distance(b) || a.id - b.id);
            for (let i = 0; i < ram.crew.length && candidates.length; i++) {
                if (ram.crew[i] !== null) continue;
                const unit = candidates.shift();
                ram.crew[i] = unit.id;
                unit.siegeRole = 'ram';
                unit.siegeAnchor = { gx: ram.gx, gy: ram.gy };
                unit.target = null;
                unit.meleeTarget = null;
                unit.lastRetarget = -Infinity;
                // Drop old orders and cached routes; core's anchor branch owns crew AI.
                unit.tacticalRole = null;
                unit.guardAnchor = null;
                unit.groundGuardReturning = false;
                scene.navigation?.routes.delete(unit);
            }
            // The first ordinary recruitment gets one chance at the reserves.
            // Unrecruited, dead or routing reserves resume their ordinary AI too.
            if (initial && layer.assault?.player)
                for (const unit of scene.units) delete unit.siegeRamReserve;
        }
        if (ram.crew.filter(id => id !== null).length >= 2) {
            if (ram.state === 'advancing') {
                ram.gy = Math.max(ram.hitY, ram.gy - .48 * dt);
                if (ram.gy <= ram.hitY) ram.state = 'hitting';
            } else {
                ram.hitMs += dt * 1000;
                if (ram.hitMs + 1e-7 >= IMPACT_MS) {
                    ram.hitMs = Math.max(0, ram.hitMs - IMPACT_MS);
                    ram.hits++;
                    ram.lastHitAt = scene.simulationTime;
                    gate.hp = Math.max(0, gate.hp - 150);
                    if (gate.hp === 0) {
                        gate.broken = true;
                        gate.brokenAt = scene.simulationTime;
                        scene.dynamicBlockers.requestRemove(gate.blockerId);
                        ram.state = 'spent';
                        for (const id of ram.crew) release(byId.get(id));
                        ram.crew.fill(null);
                    }
                }
            }
        }
        for (let i = 0; i < ram.crew.length; i++) {
            const unit = byId.get(ram.crew[i]);
            if (!unit) continue;
            const [dx, dy] = CREW_SLOTS[i];
            unit.gx = unit.siegeAnchor.gx = ram.gx + dx;
            unit.gy = unit.siegeAnchor.gy = ram.gy + dy;
        }
        // Recruitment can move a unit across spatial buckets before targeting/arrows.
        scene.rebuildSpatial();
    };
}

// 破门后攻方渗透：每个首次进院的攻方单位按 id%10 确定性分到一个纵深渗透点
// （中军帐区 / 东翼 / 西翼；其余就地参战），未接敌时直线穿插过去——
// 到达或 2 格内遇敌后该点永久失效，AI 恢复正常交战。让院内混战没有分界线。
const hookedInfiltration = new WeakSet();
function installSiegeAssault(layer, { bounds: b, attackerTeam = 'red' }) {
    const assigned = new WeakSet();
    const points = layer.infiltration = new Map();
    const inside = u => !u.siegeClimb && u.gx > b.x1 && u.gx < b.x2 && u.gy > b.y1 && u.gy < b.y2;
    const mulberry = seed => () => {
        seed = seed + 0x6d2b79f5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    function pointFor(u) {
        const zone = u.id % 10;
        if (zone >= 8) return null; // 门区就地参战
        const [anchor, radius] = zone <= 3 ? [{ gx: b.cx, gy: b.cy }, 2.5] :
            zone <= 5 ? [{ gx: b.x2 - 4, gy: b.cy }, 2] : [{ gx: b.x1 + 4, gy: b.cy }, 2];
        const rand = mulberry(Math.imul(u.id, 2654435761) >>> 0);
        const angle = 2 * Math.PI * rand(), r = radius * Math.sqrt(rand());
        return {
            gx: Math.max(b.x1 + 1, Math.min(b.x2 - 1, anchor.gx + r * Math.cos(angle))),
            gy: Math.max(b.y1 + 1, Math.min(b.y2 - 1, anchor.gy + r * Math.sin(angle)))
        };
    }
    function assignPoint(u) {
        assigned.add(u);
        const point = pointFor(u);
        if (!point) return;
        points.set(u, point);
        u.target = u.meleeTarget = null;
        u.lastRetarget = -Infinity;
        u.strafeUntil = 0;
        u.blockedEngageAt = null;
    }
    const defenseStep = layer.step;
    layer.step = (scene, dt) => {
        defenseStep?.(scene, dt);
        if (scene.battleOver || scene.resolvingOutcome) return;
        infiltrationAware(scene);
        if (!layer.gate?.broken) return;
        for (const u of scene.units) {
            if (u.dead || u.withdrawn || u.team !== attackerTeam || u.moraleState === 'routing' ||
                u.siegeRole || assigned.has(u) || !inside(u)) continue;
            assignPoint(u);
        }
    };
}
// 每个场景只包装一次 updateNormalUnit；重部署换新层时通过 scene.siege 动态读
// 当前层的渗透点表，不会叠加旧包装。
export function infiltrationAware(scene) {
    if (hookedInfiltration.has(scene)) return;
    hookedInfiltration.add(scene);
    const original = scene.updateNormalUnit;
    scene.updateNormalUnit = function (unit, now, dt, ...rest) {
        const point = scene.siege?.infiltration?.get(unit);
        if (!point || unit.moraleState === 'routing') return original.call(this, unit, now, dt, ...rest);
        let engaged = false;
        scene.forEachNear(unit.gx, unit.gy, 2, e => {
            if (!e.dead && !e.withdrawn && e.hp > 0 && isHostile(scene, unit.team, e.team)) engaged = true;
        });
        if (engaged || Math.hypot(unit.gx - point.gx, unit.gy - point.gy) <= 1.2) {
            scene.siege.infiltration.delete(unit);
            return original.call(this, unit, now, dt, ...rest);
        }
        moveToward(unit, point.gx, point.gy, unit.typeData.speed, dt);
        unit.moving = true;
    };
}
