import { CAMP_RULES } from './camps.js';
import { CombatRules } from '../combat.js';
import { Terrain } from '../terrain.js';
import { isHostile } from '../factions.js';
import { board } from '../board.js';

// Terrain height units: 1 height = HEIGHT_SCALE screen pixels = H_WORLD world units.
export function createSiegeLayer(platforms = [], assault = null) {
    // The battle scene has no battle seed. A fixed seed and layer-local sample
    // counter keep shots reproducible; redeployment creates a fresh layer.
    let scatterCounter = 0;
    const random = () => {
        let h = (0x6d2b79f5 + Math.imul(++scatterCounter, 0x6d2b79f5)) | 0;
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
            return scale;
        }
    };
    // Height-only layers retain the original shape and have no simulation hook.
    if (assault?.gate && assault?.ram) installRam(layer, assault);
    if (assault?.ladders?.length) installLadders(layer, assault.ladders, assault.climbSeconds);
    return layer;
}

export const LADDER_LIP = .8;
const CLIMB_SECONDS = 2.5, LADDER_RECRUIT_MS = 1000;
const hookedMorale = new WeakSet();

function installLadders(layer, configs, climbSeconds = CLIMB_SECONDS) {
    const landed = new WeakSet(), climbing = new Map();
    layer.landedCount = 0;
    layer.ladders = configs.map((c, i) => {
        const dx = c.top.gx - c.foot.gx, dy = c.top.gy - c.foot.gy;
        const length = Math.hypot(dx, dy);
        return {
            id: c.id ?? `ladder-${i}`, team: c.team ?? 'red',
            foot: { ...c.foot }, top: { ...c.top }, landing: { ...c.landing },
            across: { gx: dy / length, gy: -dx / length },
            climbers: [null, null], recruitMs: 0, initialized: false
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
            ladder.recruitMs += dt * 1000;
            if (!ladder.initialized || ladder.recruitMs + 1e-7 >= LADDER_RECRUIT_MS) {
                ladder.recruitMs = ladder.initialized ? Math.max(0, ladder.recruitMs - LADDER_RECRUIT_MS) % LADDER_RECRUIT_MS : 0;
                ladder.initialized = true;
                const distance = u => Math.hypot(u.gx - ladder.foot.gx, u.gy - ladder.foot.gy);
                const inward = u => (u.gx - ladder.top.gx) * (ladder.landing.gx - ladder.top.gx) +
                    (u.gy - ladder.top.gy) * (ladder.landing.gy - ladder.top.gy);
                const candidates = scene.units.filter(u => alive(u) && u.moraleState !== 'routing' && u.team === ladder.team &&
                    ['infantry', 'pikeman'].includes(u.type) && !u.siegeRole && !u.siegeAnchor && !landed.has(u) &&
                    inward(u) <= 0 && distance(u) <= 4)
                    .sort((a, b) => distance(a) - distance(b) || a.id - b.id);
                for (let slot = 0; slot < 2 && candidates.length; slot++) {
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
    const gate = layer.gate = { blockerId: config.blockerId, hp: 900, maxHp: 900, broken: false, brokenAt: null };
    const ram = layer.ram = {
        gx: start.gx, gy: start.gateOuterY + 3.2, team: start.team ?? 'red',
        restY: start.gateOuterY + 3.2, hitY: start.gateOuterY + 1.45,
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
        if (scene.resolvingOutcome) return;
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
