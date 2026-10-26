import { createSiegeLayer } from '../battle/siege.js';
import { board } from '../board.js';
import { CAMP_LAYOUT as L } from './layout.js';
import { avoidTowerPosts } from './defense-posts.js';

export const H_WORLD = L.worldHeightScale;
export const WALKWAY_HEIGHT = L.walkwayHeight / H_WORLD;
export const TOWER_HEIGHT = L.towerHeight / H_WORLD;
export const ATTACKERS = L.attackers;
export const DEFENDERS = L.defenders;

export function createCampSiege(b, { ladders = false, defense = true, rules = {}, scatterSeed, ramRestOffset = L.attackerFrontClearance, ladderRestOffset = L.attackerFrontClearance, ladderCarry = true,
    attackerControl = 'auto', stagingClearance = 11,
    battleDeadlineSeconds = attackerControl === 'player' ? 360 : null } = {}) {
    if (!['auto', 'player'].includes(attackerControl)) throw new Error('Invalid attackerControl');
    if (attackerControl === 'player' && !ladderCarry) throw new Error('player assault requires ladderCarry');
    if (attackerControl === 'player') ramRestOffset = ladderRestOffset = stagingClearance;
    const config = rules === false ? null : { ...L.rules, ...rules };
    const w = L.walkwayWidth, gateHalf = L.gateWidth / 2;
    const walkway = (id, x1, y1, x2, y2) => ({ id, x1, y1, x2, y2, height: WALKWAY_HEIGHT, kind: 'walkway' });
    const platforms = [
        walkway('walk-north', b.x1, b.y1, b.x2, b.y1 + w),
        walkway('walk-west', b.x1, b.y1 + w, b.x1 + w, b.y2 - w),
        walkway('walk-east', b.x2 - w, b.y1 + w, b.x2, b.y2 - w),
        walkway('walk-south-west', b.x1, b.y2 - w, b.cx - gateHalf, b.y2),
        walkway('walk-south-east', b.cx + gateHalf, b.y2 - w, b.x2, b.y2)
    ];
    L.towerPositions.forEach(({ side, offset }, i) => {
        const x = side === 'west' ? b.x1 + L.towerInset : side === 'east' ? b.x2 - L.towerInset : b.cx + offset;
        const y = side === 'north' ? b.y1 + L.towerInset : side === 'south' ? b.y2 - L.towerInset : b.cy + offset;
        const half = L.towerSize / 2;
        platforms.push({ id: `tower-${i}`, x1: x - half, y1: y - half, x2: x + half, y2: y + half,
            height: TOWER_HEIGHT, kind: 'tower' });
    });
    const ladderConfigs = L.sides.flatMap(side => Array.from({ length: L.laddersPerSide }, (_, i) => {
        const fraction = (i + .5) / L.laddersPerSide;
        const horizontal = side === 'north' || side === 'south';
        let along = horizontal ? b.x1 + (b.x2 - b.x1) * fraction : b.y1 + (b.y2 - b.y1) * fraction;
        if (side === 'south') {
            const perHalf = L.laddersPerSide / 2;
            const sign = i < perHalf ? -1 : 1;
            const rank = i < perHalf ? perHalf - 1 - i : i - perHalf;
            along = b.cx + sign * (gateHalf + L.southLadderGateClearance + rank * L.southLadderSpacing);
        }
        const edge = { west: b.x1, east: b.x2, north: b.y1, south: b.y2 }[side];
        const outward = side === 'west' || side === 'north' ? -1 : 1;
        const point = offset => horizontal ? { gx: along, gy: edge + outward * offset }
            : { gx: edge + outward * offset, gy: along };
        return { id: `${side}-${i}`, face: side, foot: point(L.ladderFootOffset),
            top: point(L.wallThickness / 2), landing: point(-w / 2),
            // 搬运出发点：与攻方出发阵地前沿齐平（随攻城方一起走，到位才架设）。
            start: point(L.wallThickness + ladderRestOffset) };
    }));
    const siege = createSiegeLayer(platforms, {
        attackerControl, stagingClearance, battleDeadlineSeconds: attackerControl === 'player' ? battleDeadlineSeconds : null,
        attackerTeam: config?.attackerTeam ?? 'red',
        rules: config, scatterSeed,
        fenceCover: L.fenceCover, bounds: b, wallThickness: L.wallThickness,
        ...(defense ? { defense: { bounds: b, gateHalf, wallInset: L.defenderWallClearance, towerClearance: L.towerClearance },
            infiltration: { bounds: b, attackerTeam: 'red' } } : {}),
        gate: { blockerId: 'south-gate', hp: config?.gateHp ?? L.rules.gateHp },
        // 冲车随南翼出发阵地一同启动（嵌入前沿），补员足够后才自行推向寨门
        ram: { gx: b.cx, gateOuterY: b.y2 + L.wallThickness, restOffset: ramRestOffset, team: 'red' },
        ...(ladders ? { ladders: ladderConfigs, climbSeconds: L.climbSeconds, ladderCarry } : {})
    });
    if (defense) avoidTowerPosts(siege, b);
    return siege;
}

// The page and headless tests consume the same placements and initial siege orders.
export function siegeDeployment(units, b, siege, frontClearance = L.attackerFrontClearance) {
    const result = [], defenders = units.filter(u => u.team === 'blue');
    const archers = defenders.filter(u => u.type === 'archer');
    const towers = siege.platforms.filter(p => p.kind === 'tower');
    let towerIndex = 0;
    for (const p of towers) for (const slot of L.towerArcherSlots) {
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
        const fixed = horizontal ? (p.y1 === b.y1 ? b.y1 + L.defenderWallClearance : b.y2 - L.defenderWallClearance)
            : (p.x1 === b.x1 ? b.x1 + L.defenderWallClearance : b.x2 - L.defenderWallClearance);
        const start = (horizontal ? p.x1 : p.y1) + L.defenderSpacing, end = (horizontal ? p.x2 : p.y2) - L.defenderSpacing;
        for (let along = start; along <= end; along += L.defenderSpacing) slots.push({
            gx: horizontal ? along : fixed, gy: horizontal ? fixed : along, platformId: p.id
        });
    }
    for (let gy = b.y1 + L.interiorInset; gy <= b.y2 - L.interiorInset; gy += L.defenderSpacing) {
        for (let gx = b.x1 + L.interiorInset; gx <= b.x2 - L.interiorInset; gx += L.defenderSpacing) {
            if (towers.some(p => gx >= p.x1 - L.towerClearance && gx <= p.x2 + L.towerClearance && gy >= p.y1 - L.towerClearance && gy <= p.y2 + L.towerClearance)) continue;
            slots.push({ gx, gy });
        }
    }
    remaining.forEach((unit, i) => result.push({ unit, ...slots[i] }));
    const wings = Object.fromEntries(Object.keys(L.attackShares).map(side => [side, []]));
    for (const type of Object.keys(ATTACKERS)) {
        const soldiers = units.filter(u => u.team === 'red' && u.type === type);
        let cursor = 0;
        Object.entries(L.attackShares).forEach(([side, share], index, entries) => {
            const count = index === entries.length - 1 ? soldiers.length - cursor : Math.round(soldiers.length * share);
            wings[side].push(...soldiers.slice(cursor, cursor + count));
            cursor += count;
        });
    }
    for (const [side, soldiers] of Object.entries(wings)) {
        const horizontal = side === 'south' || side === 'north';
        // 出发阵地钉在地图边缘：前沿距墙外沿 frontClearance，
        // 纵深由"前沿到地图边缘"的可用空间倒推排数，列数随该翼人数自适应。
        const frontOut = L.wallThickness + frontClearance;
        const spanAvail = (side === 'south' ? board.H - b.y2 : side === 'north' ? b.y1
            : side === 'east' ? board.W - b.x2 : b.x1) - L.attackerEdgeMargin;
        const ranks = Math.max(1, Math.floor((spanAvail - frontOut) / L.attackerDepthSpacing) + 1);
        const columns = Math.ceil(soldiers.length / ranks);
        soldiers.forEach((unit, i) => {
            const depth = Math.floor(i / columns), col = i % columns;
            const along = (col - (columns - 1) / 2) * L.attackerSpacing;
            const outward = frontOut + depth * L.attackerDepthSpacing;
            unit.siegeWing = side;
            if (siege.assault?.player) {
                const stagingOut = L.wallThickness + siege.assault.stagingClearance + depth * L.attackerDepthSpacing;
                unit.siegeStaging = {
                    gx: horizontal ? b.cx + along : side === 'west' ? b.x1 - stagingOut : b.x2 + stagingOut,
                    gy: horizontal ? (side === 'north' ? b.y1 - stagingOut : b.y2 + stagingOut) : b.cy + along
                };
            } else delete unit.siegeStaging;
            result.push({ unit, side,
                gx: horizontal ? b.cx + along : side === 'west' ? b.x1 - outward : b.x2 + outward,
                gy: horizontal ? (side === 'north' ? b.y1 - outward : b.y2 + outward) : b.cy + along });
        });
    }
    siege.defense?.deploy(units, result);
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
