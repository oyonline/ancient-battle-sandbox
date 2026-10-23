import { createSiegeLayer } from '../battle/siege.js';
import { WALL_R, TOWER_ORIGINS, TOWER_ARCHER_SLOTS } from '../three-spike/camp-assault-sim.js';

export const H_WORLD = 2;
export const WALKWAY_HEIGHT = 1 / H_WORLD;
export const TOWER_HEIGHT = 2.56 / H_WORLD;
export const ATTACKERS = { infantry: 450, pikeman: 80, archer: 70 };
export const DEFENDERS = { infantry: 150, archer: 50 };

export function createCampSiege(b, { ladders = false } = {}) {
    const w = .6;
    const walkway = (id, x1, y1, x2, y2) => ({ id, x1, y1, x2, y2, height: WALKWAY_HEIGHT, kind: 'walkway' });
    const platforms = [
        walkway('walk-north', b.x1, b.y1, b.x2, b.y1 + w),
        walkway('walk-west', b.x1, b.y1 + w, b.x1 + w, b.y2 - w),
        walkway('walk-east', b.x2 - w, b.y1 + w, b.x2, b.y2 - w),
        walkway('walk-south-west', b.x1, b.y2 - w, b.cx - 1.2, b.y2),
        walkway('walk-south-east', b.cx + 1.2, b.y2 - w, b.x2, b.y2)
    ];
    const scale = (b.x2 - b.x1) / (2 * WALL_R);
    TOWER_ORIGINS.forEach((o, i) => {
        const x = b.cx + o.x * scale, y = b.cy + o.z * scale;
        platforms.push({ id: `tower-${i}`, x1: x - .7, y1: y - .7, x2: x + .7, y2: y + .7,
            height: TOWER_HEIGHT, kind: 'tower' });
    });
    return createSiegeLayer(platforms, {
        gate: { blockerId: 'south-gate' },
        ram: { gx: b.cx, gateOuterY: b.y2 + .3, team: 'red' },
        ...(ladders ? { ladders: [
            ...[1 / 3, 2 / 3].map((fraction, i) => {
                const gy = b.y1 + (b.y2 - b.y1) * fraction;
                return { id: `west-${i}`, foot: { gx: b.x1 - 1.3, gy },
                    top: { gx: b.x1 - .15, gy }, landing: { gx: b.x1 + .3, gy } };
            }),
            ...[-1, 1].map(side => {
                const gx = b.cx + side * (1.2 + 2.5);
                return { id: `south-${side}`, foot: { gx, gy: b.y2 + 1.3 },
                    top: { gx, gy: b.y2 + .15 }, landing: { gx, gy: b.y2 - .3 } };
            })
        ] } : {})
    });
}

// Pure placement data: the page and headless tests consume exactly the same slots.
export function siegeDeployment(units, b, siege) {
    const result = [], defenders = units.filter(u => u.team === 'blue');
    const archers = defenders.filter(u => u.type === 'archer');
    const towers = siege.platforms.filter(p => p.kind === 'tower');
    let towerIndex = 0;
    for (const p of towers) for (const slot of TOWER_ARCHER_SLOTS) {
        const unit = archers[towerIndex++];
        if (!unit) continue;
        const gx = (p.x1 + p.x2) / 2 + slot.x, gy = (p.y1 + p.y2) / 2 + slot.z;
        result.push({ unit, gx, gy, platformId: p.id, siegeAnchor: { gx, gy, platformId: p.id } });
    }
    const placed = new Set(result.map(p => p.unit));
    const remaining = defenders.filter(u => !placed.has(u)).sort((a, z) =>
        Number(a.type === 'archer') - Number(z.type === 'archer') || a.id - z.id);
    const slots = [];
    for (const p of siege.platforms.filter(p => p.kind === 'walkway')) {
        const horizontal = p.x2 - p.x1 > p.y2 - p.y1;
        // .38 from the wall clears the existing .36 body radius; .8 spacing avoids corner overlap.
        const fixed = horizontal ? (p.y1 === b.y1 ? b.y1 + .38 : b.y2 - .38)
            : (p.x1 === b.x1 ? b.x1 + .38 : b.x2 - .38);
        const start = (horizontal ? p.x1 : p.y1) + .8, end = (horizontal ? p.x2 : p.y2) - .8;
        for (let along = start; along <= end; along += .8) slots.push({
            gx: horizontal ? along : fixed, gy: horizontal ? fixed : along, platformId: p.id
        });
    }
    for (let gy = b.y1 + 1.3; gy <= b.y2 - 1.3; gy += .8) {
        for (let gx = b.x1 + 1.3; gx <= b.x2 - 1.3; gx += .8) {
            if (towers.some(p => gx >= p.x1 - .4 && gx <= p.x2 + .4 && gy >= p.y1 - .4 && gy <= p.y2 + .4)) continue;
            slots.push({ gx, gy });
        }
    }
    remaining.forEach((unit, i) => result.push({ unit, ...slots[i] }));
    units.filter(u => u.team === 'red').forEach((unit, i) => {
        const wingIndex = Math.floor(i / 2), depth = Math.floor(wingIndex / 20), col = wingIndex % 20;
        result.push({ unit, gx: i % 2 === 0 ? b.x1 - .3 - 6 - depth * .85 : b.cx - 9.5 + col,
            gy: i % 2 === 0 ? b.cy - 9.5 + col : b.y2 + .3 + 6 + depth * .85 });
    });
    return result;
}

// Wrap only the siege3d scene; the shared arrow emitter and other modes stay untouched.
export function installSiegeArrows(scene) {
    const fireArrow = scene.fireArrow;
    scene.fireArrow = function (from, target, options) {
        const start = this.arrows.length;
        const result = fireArrow.call(this, from, target, options);
        if (this.siege) for (let i = start; i < this.arrows.length; i++) {
            const arrow = this.arrows[i];
            const originalTerrainHeight = this.terrainHeight(arrow.tx, arrow.ty);
            this.siege.scatterArrow(arrow, from);
            arrow.sourceHeight += from.siegeClimb?.height ?? this.siege.heightAt(arrow.sx, arrow.sy);
            arrow.targetHeight += this.terrainHeight(arrow.tx, arrow.ty) - originalTerrainHeight +
                (target.siegeClimb?.height ?? this.siege.heightAt(arrow.tx, arrow.ty));
        }
        return result;
    };
}
