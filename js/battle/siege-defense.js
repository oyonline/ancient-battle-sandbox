// Opt-in siege orders. No shared targeting, movement, damage or morale rules are changed.
import { dist, moveToward } from '../units.js';
import { isHostile } from '../factions.js';

const SIDES = ['west', 'north', 'east', 'south'];
const active = u => u && !u.dead && !u.withdrawn && u.hp > 0 && u.moraleState !== 'routing';
const nearest = (units, point) => {
    let best, distance = Infinity;
    for (const u of units) {
        const d = dist(u, point);
        if (d < distance || (d === distance && u.id < best.id)) { best = u; distance = d; }
    }
    return best;
};

export function installSiegeDefense(layer, config) {
    const { bounds: b, team = 'blue', gateHalf = 1.2, wallInset = .38 } = config;
    const center = { gx: b.cx, gy: b.cy }, gateCenter = { gx: b.cx, gy: b.y2 };
    const distanceToGate = u => dist(u, gateCenter);
    const assignments = new Map(), wallPosts = [], gatePosts = [];
    const reservePosts = new Map(), archerPosts = Object.fromEntries(SIDES.map(side => [side, []]));
    let nextReserveSlot = 0, nextArcherSlot = 0;
    let dutyPosts = null;
    let wallCount = null, elapsed = 0, initialized = false, breached = false;
    let enemies = [], intruders = [];
    const threat = Object.fromEntries(SIDES.map(s => [s, 0]));
    const inside = u => !u.siegeClimb && u.gx > b.x1 && u.gx < b.x2 && u.gy > b.y1 && u.gy < b.y2;
    const sideOf = p => SIDES.slice().sort((a, c) => edgeDistance(p, a) - edgeDistance(p, c) || SIDES.indexOf(a) - SIDES.indexOf(c))[0];
    function edgeDistance(p, side) {
        return Math.abs(side === 'west' ? p.gx - b.x1 : side === 'east' ? p.gx - b.x2 : side === 'north' ? p.gy - b.y1 : p.gy - b.y2);
    }
    const pointOn = (side, along, inset) => ({
        gx: side === 'west' ? b.x1 + inset : side === 'east' ? b.x2 - inset : along,
        gy: side === 'north' ? b.y1 + inset : side === 'south' ? b.y2 - inset : along
    });
    const legalAlong = (side, along) => along >= (side === 'west' || side === 'east' ? b.y1 : b.x1) + .65 &&
        along <= (side === 'west' || side === 'east' ? b.y2 : b.x2) - .65 &&
        (side !== 'south' || Math.abs(along - b.cx) >= gateHalf + .4);
    for (const ladder of layer.ladders ?? []) {
        const side = sideOf(ladder.landing), horizontal = side === 'north' || side === 'south';
        for (const offset of [-.37, .37]) wallPosts.push({
            id: `lip-${ladder.id}-${offset}`, side, priority: 0,
            ...pointOn(side, (horizontal ? ladder.landing.gx : ladder.landing.gy) + offset, wallInset)
        });
    }
    // A 20-cell perimeter has fewer 1.5-cell stations than the 162-man quota.
    // Keep those stations first, then give threatened stations adjacent relief slots.
    for (const offset of [0, -.5, .5, -.25, .25]) for (const side of SIDES) {
        const start = side === 'west' || side === 'east' ? b.y1 : b.x1;
        const end = side === 'west' || side === 'east' ? b.y2 : b.x2;
        for (let along = start + .8; along < end - .65; along += 1.5) {
            if (!legalAlong(side, along + offset)) continue;
            const p = pointOn(side, along + offset, wallInset);
            if (wallPosts.some(s => dist(s, p) < .2)) continue;
            wallPosts.push({ id: `wall-${side}-${along}-${offset}`, side, priority: offset === 0 ? 1 : 2, ...p });
        }
    }
    const orderPosts = (a, c) => a.priority - c.priority || threat[c.side] - threat[a.side] || wallPosts.indexOf(a) - wallPosts.indexOf(c);
    function assign(unit, role, post) {
        const old = assignments.get(unit);
        if (old?.post.id === post.id && old.role === role) return;
        assignments.set(unit, { role, post });
        unit.siegeDefenseRole = role;
        unit.guardRadius = 2.5;
        unit.target = unit.meleeTarget = null;
        unit.strafeUntil = 0;
        unit.blockedEngageAt = null;
        unit.groundGuardReturning = false;
        unit.scene?.navigation?.routes.delete(unit);
    }
    function refreshEnemies(units, scene) {
        enemies = units.filter(u => !u.dead && !u.withdrawn && u.hp > 0 && isHostile(scene, team, u.team));
        intruders = enemies.filter(inside);
    }
    function refreshThreat() {
        for (const side of SIDES) threat[side] = 0;
        for (const u of enemies) for (const side of SIDES) {
            const along = side === 'west' || side === 'east' ? u.gy : u.gx;
            const lo = side === 'west' || side === 'east' ? b.y1 : b.x1;
            const hi = side === 'west' || side === 'east' ? b.y2 : b.x2;
            const outside = side === 'west' ? u.gx <= b.x1 : side === 'east' ? u.gx >= b.x2 : side === 'north' ? u.gy <= b.y1 : u.gy >= b.y2;
            if (outside && along >= lo && along <= hi && edgeDistance(u, side) <= 8) threat[side]++;
        }
    }
    function allocate(units, rebalance = false) {
        for (const [u] of assignments) if (!active(u) || u.team !== team || u.siegeAnchor) {
            assignments.delete(u); delete u.siegeDefenseRole;
        }
        const defenders = units.filter(u => active(u) && u.team === team && !u.siegeAnchor);
        const infantry = defenders.filter(u => u.type === 'infantry');
        wallCount ??= Math.floor(infantry.length * .65);
        // Keep occupied orders stable: periodic threat ranking fills vacancies,
        // rather than sending stationed soldiers across the courtyard every 2s.
        if (!dutyPosts) {
            dutyPosts = [];
            const pool = wallPosts.slice(), counts = Object.fromEntries(SIDES.map(side => [side, 0]));
            while (dutyPosts.length < wallCount && pool.length) {
                pool.sort((a, c) => a.priority - c.priority || threat[c.side] - threat[a.side] ||
                    counts[a.side] - counts[c.side] || wallPosts.indexOf(a) - wallPosts.indexOf(c));
                const post = pool.shift(); dutyPosts.push(post); counts[post.side]++;
            }
        }
        const selected = dutyPosts.filter(p => !p.gateTransfer).sort(orderPosts);
        const selectedSet = new Set(selected);
        for (const [u, a] of assignments) if (a.role === 'wall' && !selectedSet.has(a.post)) assignments.delete(u);
        const occupied = new Set([...assignments.values()].map(a => a.post));
        const processed = new Set();
        for (const post of selected) {
            processed.add(post);
            if (occupied.has(post)) continue;
            // Existing reserves get first refusal on a casualty's vacancy.
            const reserves = infantry.filter(u => assignments.get(u)?.role === 'reserve');
            const free = infantry.filter(u => !assignments.has(u));
            let u = nearest(reserves.length ? reserves : free, post);
            if (!u) {
                const donors = infantry.filter(u => assignments.get(u)?.role === 'wall' && !processed.has(assignments.get(u).post) &&
                    assignments.get(u).post.priority >= post.priority)
                    .sort((a, c) => threat[assignments.get(a).post.side] - threat[assignments.get(c).post.side] || dist(a, post) - dist(c, post) || a.id - c.id);
                u = donors[0];
            }
            if (u) {
                occupied.delete(assignments.get(u)?.post);
                assign(u, 'wall', post); occupied.add(post);
            }
        }
        if (rebalance) rebalanceWalls();
        // A unit keeps its original reserve slot even after leaving the reserve.
        // Vacancies do not compact the formation or move any surviving soldier.
        for (const u of infantry) if (!assignments.has(u)) {
            if (!reservePosts.has(u)) {
                const i = nextReserveSlot++;
                reservePosts.set(u, { id: `reserve-${u.id}`, gx: center.gx + (i % 12 - 5.5 + (Math.floor(i / 12) % 2 ? .25 : -.25)) * .85,
                    gy: center.gy + 2 + (Math.floor(i / 12) - 3.5) * .75 });
            }
            assign(u, 'reserve', reservePosts.get(u));
        }
        const archers = defenders.filter(u => u.type === 'archer');
        const counts = Object.fromEntries(SIDES.map(side => [side, 0]));
        for (let i = 0; i < archers.length; i++) {
            const side = SIDES.slice().sort((a, c) => (counts[a] + 1) / (threat[a] + 1) - (counts[c] + 1) / (threat[c] + 1) || SIDES.indexOf(a) - SIDES.indexOf(c))[0];
            counts[side]++;
        }
        for (const side of SIDES) {
            const posts = archerPosts[side];
            if (posts.length === counts[side]) continue;
            // Remove empty slots first, then only the surplus occupied slots.
            posts.sort((a, c) => Number(occupied.has(c)) - Number(occupied.has(a)));
            posts.length = Math.min(posts.length, counts[side]);
            const lo = side === 'west' || side === 'east' ? b.y1 : b.x1;
            const along = p => side === 'west' || side === 'east' ? p.gy : p.gx;
            if (!posts.length) {
                for (let i = 0; i < counts[side]; i++) posts.push({ id: `archer-${side}-${nextArcherSlot++}`, side,
                    ...pointOn(side, lo + 2 + 16 * (i + .5) / counts[side], 2) });
            } else while (posts.length < counts[side]) {
                const edges = [lo + 2, ...posts.map(along).sort((a, c) => a - c), lo + 18];
                let gap = 0;
                for (let i = 1; i < edges.length - 1; i++) if (edges[i + 1] - edges[i] > edges[gap + 1] - edges[gap]) gap = i;
                posts.push({ id: `archer-${side}-${nextArcherSlot++}`, side,
                    ...pointOn(side, (edges[gap] + edges[gap + 1]) / 2, 2) });
            }
        }
        const posts = SIDES.flatMap(side => archerPosts[side]), postIds = new Set(posts.map(p => p.id));
        for (const u of archers) {
            const a = assignments.get(u);
            if (a?.role === 'archer' && !postIds.has(a.post.id)) assignments.delete(u);
        }
        const pool = archers.filter(u => !assignments.has(u));
        const held = new Set([...assignments.values()].map(a => a.post.id));
        for (const post of posts) {
            if (held.has(post.id)) continue;
            const u = nearest(pool, post);
            if (u) { pool.splice(pool.indexOf(u), 1); assign(u, 'archer', post); }
        }
        if (breached) {
            for (const post of gatePosts) {
                if ([...assignments.values()].some(a => a.post === post)) continue;
                const u = nearest(infantry.filter(u => assignments.get(u)?.role === 'reserve'), post);
                if (u) assign(u, 'gate', post);
            }
        }
    }
    function rebalanceWalls() {
        const moved = new Set();
        for (let i = 0; i < 8; i++) {
            const guards = [...assignments].filter(([u, a]) => active(u) && a.role === 'wall');
            const counts = Object.fromEntries(SIDES.map(side => [side, guards.filter(([, a]) => a.post.side === side).length]));
            const ratio = side => threat[side] / Math.max(1, counts[side]);
            const occupied = new Set([...assignments.values()].map(a => a.post.id));
            const destinations = SIDES.filter(side => wallPosts.some(p => p.side === side && !p.gateTransfer && !occupied.has(p.id)))
                .sort((a, c) => ratio(c) - ratio(a) || SIDES.indexOf(a) - SIDES.indexOf(c));
            const sources = SIDES.filter(side => guards.some(([u, a]) => a.post.side === side && a.post.priority > 0 && !moved.has(u)))
                .sort((a, c) => ratio(a) - ratio(c) || SIDES.indexOf(a) - SIDES.indexOf(c));
            const from = sources[0], to = destinations[0];
            if (!from || !to || from === to || ratio(to) <= ratio(from) || ratio(to) < ratio(from) * 1.5) break;
            const post = wallPosts.filter(p => p.side === to && !p.gateTransfer && !occupied.has(p.id)).sort(orderPosts)[0];
            const u = nearest(guards.filter(([u, a]) => a.post.side === from && a.post.priority > 0 && !moved.has(u)).map(([u]) => u), post);
            const old = assignments.get(u).post;
            dutyPosts[dutyPosts.indexOf(old)] = post;
            assign(u, 'wall', post); moved.add(u);
        }
    }
    function breach() {
        breached = true;
        const members = [...assignments].filter(([u, a]) => active(u) && !u.siegeAnchor && a.role === 'reserve').map(([u]) => u);
        for (const sign of [-1, 1]) {
            const guards = [...assignments].filter(([u, a]) => active(u) && !u.siegeAnchor && a.role === 'wall' && (u.gx - b.cx) * sign > 0)
                .map(([u]) => u).sort((a, c) => dist(a, gateCenter) - dist(c, gateCenter) || a.id - c.id).slice(0, 6);
            for (const u of guards) { assignments.get(u).post.gateTransfer = true; members.push(u); wallCount--; }
        }
        // Three semicircles at .8-cell rank spacing and .25-cell arc slots,
        // less dense than the former two ranks; overflow musters behind
        // the third rank. Fill the front ranks with the closest available troops.
        const rows = 3;
        let remaining = members.length;
        for (let row = 0; remaining; row++) {
            const radius = 2.5 + row * .8;
            const count = row < rows ? Math.min(remaining, Math.floor(Math.PI * radius / .25)) : remaining;
            const posts = [];
            for (let i = 0; i < count; i++) {
                const angle = Math.PI * (i + .5) / count;
                posts.push({ id: `gate-${row}-${i}`, gx: gateCenter.gx + radius * Math.cos(angle), gy: gateCenter.gy - radius * Math.sin(angle) });
            }
            const front = members.sort((a, c) => distanceToGate(a) - distanceToGate(c) || a.id - c.id).splice(0, count);
            const pairs = front.flatMap(unit => posts.map((post, index) => ({ unit, post, index, distance: dist(unit, post) })))
                .sort((a, c) => a.distance - c.distance || a.unit.id - c.unit.id || a.index - c.index);
            const usedUnits = new Set(), usedPosts = new Set();
            for (const { unit, post } of pairs) {
                if (usedUnits.has(unit) || usedPosts.has(post)) continue;
                assign(unit, 'gate', post); usedUnits.add(unit); usedPosts.add(post);
            }
            gatePosts.push(...posts); remaining -= count;
        }
    }
    const defense = layer.defense = {
        assignments, wallPosts, gatePosts, threat, center, gateCenter,
        owns: unit => assignments.has(unit) && active(unit) && !unit.siegeAnchor,
        // Initial placement uses the same allocator; it does not advance simulation.
        deploy(units, placements) {
            const positions = new Map(placements.map(p => [p.unit, p]));
            const views = units.map(u => ({ ...u, ...(positions.get(u) ?? {}), unit: undefined }));
            refreshEnemies(views, units[0]?.scene);
            refreshThreat();
            // Tower reservations must be visible before assigning the remaining archers.
            const towers = new Set(placements.filter(p => p.siegeAnchor).map(p => p.unit));
            allocate(units.filter(u => !towers.has(u)));
            for (const [u, a] of assignments) Object.assign(positions.get(u), { gx: a.post.gx, gy: a.post.gy });
        },
        targetFor(scene, unit) {
            const a = assignments.get(unit);
            let candidates;
            if (a.role === 'reserve') candidates = intruders;
            else if (a.role === 'archer') return scene.stickyTarget(unit);
            else {
                candidates = [];
                const radius = 2.5 + unit.typeData.range + .5;
                scene.forEachNear(a.post.gx, a.post.gy, radius, e => {
                    if (!isHostile(scene, unit.team, e.team) || dist(e, a.post) > radius) return;
                    if (a.role === 'gate' ? distanceToGate(e) <= 4.5 &&
                        (inside(e) || (!e.siegeClimb && Math.abs(e.gx - b.cx) <= gateHalf && e.gy <= b.y2 + 1.5)) :
                        dist(e, a.post) <= 2.5 || layer.meleeBypass(unit, e)) candidates.push(e);
                });
            }
            const target = nearest(candidates.filter(e => !e.dead && !e.withdrawn && e.hp > 0), unit) ?? null;
            unit.meleeTarget = target;
            return target;
        },
        act(scene, unit, now, dt) {
            if (!this.owns(unit)) return false;
            const { role, post } = assignments.get(unit);
            if (role !== 'reserve' && dist(unit, post) > 2.5) {
                unit.strafeUntil = 0;
                moveToward(unit, post.gx, post.gy, unit.typeData.speed, dt);
            } else {
                if (role === 'reserve' && !intruders.length) unit.strafeUntil = 0;
                scene.updateNormalUnit(unit, now, dt, post);
            }
            // Dense gate ranks can block a straight walking order. Probe short
            // lateral approaches through the SAME moveToward/contact rules.
            const target = unit.meleeTarget;
            const goal = target && (role === 'reserve' || (role === 'gate' && dist(unit, post) <= 2.5)) ? target : post;
            if ((role === 'gate' || role === 'reserve') && dist(unit, goal) > 1.3 &&
                Math.hypot(unit.moveX, unit.moveY) < unit.typeData.speed * dt * .8) {
                const angle = Math.atan2(goal.gy - unit.gy, goal.gx - unit.gx);
                const capture = () => ({ moveX: unit.moveX, moveY: unit.moveY, pressX: unit.pressX, pressY: unit.pressY, moving: unit.moving });
                let best = capture();
                const score = motion => motion.moveX * Math.cos(angle) + motion.moveY * Math.sin(angle);
                for (const turn of [-.35, .35, -.7, .7, -1.4, 1.4]) {
                    moveToward(unit, unit.gx + 1.2 * Math.cos(angle + turn), unit.gy + 1.2 * Math.sin(angle + turn), unit.typeData.speed, dt);
                    if (score(capture()) > score(best)) best = capture();
                }
                Object.assign(unit, best);
            }
            return true;
        }
    };
    const assaultStep = layer.step;
    layer.step = (scene, dt) => {
        assaultStep?.(scene, dt);
        if (scene.battleOver || scene.resolvingOutcome) return;
        refreshEnemies(scene.units, scene);
        elapsed += dt * 1000;
        if (!initialized || elapsed + 1e-7 >= 2000) {
            elapsed = initialized ? Math.max(0, elapsed - 2000) % 2000 : 0;
            refreshThreat();
            allocate(scene.units, initialized); initialized = true;
        }
        if (layer.gate?.broken && !breached) breach();
    };
}
