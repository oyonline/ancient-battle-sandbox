import { createSiegeLayer } from '../battle/siege.js';
import { board } from '../board.js';
import { campBounds, queueCampWalls } from './walls.js';
import { CAMP_LAYOUT as L, PLAYER_ASSAULT_LAYOUT } from './layout.js';
import { avoidTowerPosts } from './defense-posts.js';
import { clearSiegeArcherPost } from '../battle/siege-assault.js';

export const H_WORLD = L.worldHeightScale;
export const WALKWAY_HEIGHT = L.walkwayHeight / H_WORLD;
export const TOWER_HEIGHT = L.towerHeight / H_WORLD;
export const ATTACKERS = L.attackers;
export const DEFENDERS = L.defenders;

export function createCampSiege(b, { layout = L, ladders = false, defense = true, rules = {}, scatterSeed, ramRestOffset = layout.attackerFrontClearance, ladderRestOffset = layout.attackerFrontClearance, ladderCarry = true,
    attackerControl = 'auto', stagingClearance = layout.stagingClearance,
    archerLineClearance = layout.archerLineClearance ?? L.archerLineClearance,
    archerHoldClearance = layout.archerHoldClearance ?? PLAYER_ASSAULT_LAYOUT.archerHoldClearance,
    battleDeadlineSeconds = attackerControl === 'player' ? 360 : null } = {}) {
    if (!['auto', 'player'].includes(attackerControl)) throw new Error('Invalid attackerControl');
    if (attackerControl === 'player' && !ladderCarry) throw new Error('player assault requires ladderCarry');
    if (attackerControl === 'player') ramRestOffset = ladderRestOffset = stagingClearance;
    const config = rules === false ? null : { ...layout.rules, ...rules };
    const w = layout.walkwayWidth, gateHalf = layout.gateWidth / 2;
    const walkway = (id, x1, y1, x2, y2) => ({ id, x1, y1, x2, y2, height: WALKWAY_HEIGHT, kind: 'walkway' });
    const platforms = [
        walkway('walk-north', b.x1, b.y1, b.x2, b.y1 + w),
        walkway('walk-west', b.x1, b.y1 + w, b.x1 + w, b.y2 - w),
        walkway('walk-east', b.x2 - w, b.y1 + w, b.x2, b.y2 - w),
        walkway('walk-south-west', b.x1, b.y2 - w, b.cx - gateHalf, b.y2),
        walkway('walk-south-east', b.cx + gateHalf, b.y2 - w, b.x2, b.y2)
    ];
    layout.towerPositions.forEach(({ side, offset }, i) => {
        const x = side === 'west' ? b.x1 + layout.towerInset : side === 'east' ? b.x2 - layout.towerInset : b.cx + offset;
        const y = side === 'north' ? b.y1 + layout.towerInset : side === 'south' ? b.y2 - layout.towerInset : b.cy + offset;
        const half = layout.towerSize / 2;
        platforms.push({ id: `tower-${i}`, x1: x - half, y1: y - half, x2: x + half, y2: y + half,
            height: TOWER_HEIGHT, kind: 'tower' });
    });
    const ladderConfigs = layout.sides.flatMap(side => Array.from({ length: layout.laddersPerSide }, (_, i) => {
        const fraction = (i + .5) / layout.laddersPerSide;
        const horizontal = side === 'north' || side === 'south';
        let along = horizontal ? b.x1 + (b.x2 - b.x1) * fraction : b.y1 + (b.y2 - b.y1) * fraction;
        if (side === 'south') {
            const perHalf = layout.laddersPerSide / 2;
            const sign = i < perHalf ? -1 : 1;
            const rank = i < perHalf ? perHalf - 1 - i : i - perHalf;
            along = b.cx + sign * (gateHalf + layout.southLadderGateClearance + rank * layout.southLadderSpacing);
        }
        const edge = { west: b.x1, east: b.x2, north: b.y1, south: b.y2 }[side];
        const outward = side === 'west' || side === 'north' ? -1 : 1;
        const point = offset => horizontal ? { gx: along, gy: edge + outward * offset }
            : { gx: edge + outward * offset, gy: along };
        return { id: `${side}-${i}`, face: side, foot: point(layout.ladderFootOffset),
            top: point(layout.wallThickness / 2), landing: point(-w / 2),
            // 搬运出发点：与攻方出发阵地前沿齐平（随攻城方一起走，到位才架设）。
            start: point(layout.wallThickness + ladderRestOffset) };
    }));
    const siege = createSiegeLayer(platforms, {
        attackerControl, stagingClearance, archerLineClearance, archerHoldClearance, battleDeadlineSeconds: attackerControl === 'player' ? battleDeadlineSeconds : null,
        attackerTeam: config?.attackerTeam ?? 'red',
        rules: config, scatterSeed,
        fenceCover: layout.fenceCover, bounds: b, wallThickness: layout.wallThickness,
        ...(defense ? { defense: { bounds: b, gateHalf, wallInset: layout.defenderWallClearance, towerClearance: layout.towerClearance },
            infiltration: { bounds: b, attackerTeam: 'red' } } : {}),
        gate: { blockerId: 'south-gate', hp: config?.gateHp ?? layout.rules.gateHp },
        // 冲车随南翼出发阵地一同启动（嵌入前沿），补员足够后才自行推向寨门
        ram: { gx: b.cx, gateOuterY: b.y2 + layout.wallThickness, restOffset: ramRestOffset, team: 'red' },
        ...(ladders ? { ladders: ladderConfigs, climbSeconds: layout.climbSeconds, ladderCarry } : {})
    });
    if (defense) avoidTowerPosts(siege, b);
    return siege;
}

// The page and headless tests consume the same placements and initial siege orders.
export function siegeDeployment(units, b, siege, frontClearance = L.attackerFrontClearance, layout = L) {
    for (const unit of units) clearSiegeArcherPost(unit);
    const result = [], defenders = units.filter(u => u.team === 'blue');
    const archers = defenders.filter(u => u.type === 'archer');
    const towers = siege.platforms.filter(p => p.kind === 'tower');
    let towerIndex = 0;
    for (const p of towers) for (const slot of layout.towerArcherSlots) {
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
        const fixed = horizontal ? (p.y1 === b.y1 ? b.y1 + layout.defenderWallClearance : b.y2 - layout.defenderWallClearance)
            : (p.x1 === b.x1 ? b.x1 + layout.defenderWallClearance : b.x2 - layout.defenderWallClearance);
        const start = (horizontal ? p.x1 : p.y1) + layout.defenderSpacing, end = (horizontal ? p.x2 : p.y2) - layout.defenderSpacing;
        for (let along = start; along <= end; along += layout.defenderSpacing) slots.push({
            gx: horizontal ? along : fixed, gy: horizontal ? fixed : along, platformId: p.id
        });
    }
    for (let gy = b.y1 + layout.interiorInset; gy <= b.y2 - layout.interiorInset; gy += layout.defenderSpacing) {
        for (let gx = b.x1 + layout.interiorInset; gx <= b.x2 - layout.interiorInset; gx += layout.defenderSpacing) {
            if (towers.some(p => gx >= p.x1 - layout.towerClearance && gx <= p.x2 + layout.towerClearance && gy >= p.y1 - layout.towerClearance && gy <= p.y2 + layout.towerClearance)) continue;
            slots.push({ gx, gy });
        }
    }
    remaining.forEach((unit, i) => result.push({ unit, ...slots[i] }));
    const wings = Object.fromEntries(Object.keys(layout.attackShares).map(side => [side, []]));
    for (const type of Object.keys(layout.attackers)) {
        const soldiers = units.filter(u => u.team === 'red' && u.type === type);
        let cursor = 0;
        Object.entries(layout.attackShares).forEach(([side, share], index, entries) => {
            const count = index === entries.length - 1 ? soldiers.length - cursor : Math.round(soldiers.length * share);
            wings[side].push(...soldiers.slice(cursor, cursor + count));
            cursor += count;
        });
    }
    for (const [side, wing] of Object.entries(wings)) {
        const archers = siege.assault?.player ? wing.filter(u => u.type === 'archer') : [];
        const soldiers = siege.assault?.player ? wing.filter(u => u.type !== 'archer') : wing;
        const horizontal = side === 'south' || side === 'north';
        // 出发阵地钉在地图边缘：前沿距墙外沿 frontClearance，
        // 纵深由"前沿到地图边缘"的可用空间倒推排数，列数随该翼人数自适应。
        const frontOut = layout.wallThickness + frontClearance;
        const spanAvail = (side === 'south' ? board.H - b.y2 : side === 'north' ? b.y1
            : side === 'east' ? board.W - b.x2 : b.x1) - layout.attackerEdgeMargin;
        const ranks = Math.max(1, Math.floor((spanAvail - frontOut) / layout.attackerDepthSpacing) + 1);
        const columns = Math.ceil(soldiers.length / ranks);
        soldiers.forEach((unit, i) => {
            const depth = Math.floor(i / columns), col = i % columns;
            const along = (col - (columns - 1) / 2) * layout.attackerSpacing;
            const outward = frontOut + depth * layout.attackerDepthSpacing;
            unit.siegeWing = side;
            if (siege.assault?.player) {
                const stagingOut = layout.wallThickness + siege.assault.stagingClearance + depth * layout.attackerDepthSpacing;
                unit.siegeStaging = {
                    gx: horizontal ? b.cx + along : side === 'west' ? b.x1 - stagingOut : b.x2 + stagingOut,
                    gy: horizontal ? (side === 'north' ? b.y1 - stagingOut : b.y2 + stagingOut) : b.cy + along
                };
            } else delete unit.siegeStaging;
            result.push({ unit, side,
                gx: horizontal ? b.cx + along : side === 'west' ? b.x1 - outward : b.x2 + outward,
                gy: horizontal ? (side === 'north' ? b.y1 - outward : b.y2 + outward) : b.cy + along });
        });
        archers.forEach((unit, i) => {
            const along = i - (archers.length - 1) / 2;
            const outward = layout.wallThickness + siege.assault.archerHoldClearance;
            const gx = horizontal ? b.cx + along : side === 'west' ? b.x1 - outward : b.x2 + outward;
            const gy = horizontal ? (side === 'north' ? b.y1 - outward : b.y2 + outward) : b.cy + along;
            unit.siegeWing = side;
            delete unit.siegeStaging;
            unit.siegeArcherPost = { gx, gy };
            const lineOut = layout.wallThickness + siege.assault.archerLineClearance;
            unit.siegeArcherLinePost = {
                gx: horizontal ? b.cx + along : side === 'west' ? b.x1 - lineOut : b.x2 + lineOut,
                gy: horizontal ? (side === 'north' ? b.y1 - lineOut : b.y2 + lineOut) : b.cy + along
            };
            result.push({ unit, side, gx, gy });
        });
    }
    siege.defense?.deploy(units, result);
    return result;
}

// Generation is separate: the page's player start reuses existing units (clearUnits is a no-op there).
export function deployCampArmies(scene, options = {}) {
    const layout = options.layout ?? L;
    scene.deployUnits(options.attackers ?? layout.attackers, options.defenders ?? layout.defenders, 'custom', 'custom',
        { red: 'advance', blue: 'advance' }, { terrain: 'flat', boardSize: layout.boardSize });
    return configureCampArmies(scene, options);
}

export function configureCampArmies(scene, { layout = L, frontClearance = layout.attackerFrontClearance,
    placementOffset = null, ...siegeOptions } = {}) {
    for (const unit of scene.units) if (unit.type === 'archer')
        unit.typeData = { ...unit.typeData, range: layout.archerRange };
    const bounds = campBounds();
    scene.siege = createCampSiege(bounds, { ladders: true, layout, ...siegeOptions });
    const placements = siegeDeployment(scene.units, bounds, scene.siege, frontClearance, layout);
    for (const placement of placements) {
        const { unit, siegeAnchor } = placement;
        const { gx, gy } = placementOffset ? placementOffset(placement) : placement;
        Object.assign(unit, { gx, gy, pgx: gx, pgy: gy, siegeAnchor,
            moveX: 0, moveY: 0, pushX: 0, pushY: 0, velX: 0, velY: 0 });
    }
    // Never commit walls here: core.js submits them at the first fixed step.
    queueCampWalls(scene);
    scene.rebuildSpatial();
    scene.ensureNavigation().reset(scene.battleOptions.terrain, scene.battleId);
    return { scene, bounds, placements };
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
