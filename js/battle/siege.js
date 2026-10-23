import { CAMP_RULES } from './camps.js';

// Terrain height units: 1 height = HEIGHT_SCALE screen pixels = H_WORLD world units.
export function createSiegeLayer(platforms = [], assault = null) {
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
    return layer;
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
