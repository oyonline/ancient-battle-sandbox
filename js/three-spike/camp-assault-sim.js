// Deterministic camp assault simulation: no THREE, DOM, or wall geometry mutations.
import { UNIT_TYPES, calculateAttackDamage } from '../units.js';
import { CAMP_RULES } from '../battle/camps.js';
export const WALL_R = 5;
export const ATK_ANIM_MS = 220, HIT_ANIM_MS = 180;
export const ATTACK_KINDS = ['infantry', 'pikeman', 'archer'];
export const DEF_COUNTS = [6, 12, 24];
export const slotKind = i => i % 3 === 2 ? 'archer' : 'infantry';
export const TOWER_ORIGIN = { x: 0, z: -3.3 };
export const TOWER_ARCHER_SLOTS = [-.176, .176].flatMap(z =>
    [-.336, 0, .336].map(x => ({ x, z, yaw: Math.PI / 2 })));
export const DEFAULT_TOWERS = TOWER_ARCHER_SLOTS.map(p =>
    ({ ...p, x: TOWER_ORIGIN.x + p.x, z: TOWER_ORIGIN.z + p.z }));
export const LADDERS = [{ x: -5.62, z: -1.2, topX: -5 }, { x: 5.62, z: 1.2, topX: 5 }];
export const TENTS = [{ x: 0, z: 0, half: 1.1 }, ...[-2.8, 2.8].flatMap(x =>
    [-2.8, 2.8].map(z => ({ x, z, half: .9 })))];

export function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        let t = state += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
export const MELEE_STOP_R = WALL_R + 0.4;          // 近战迫近停步圈（切比雪夫 = 5.4）：不得穿墙
export const ARCHER_STOP_R = 7.5;                  // 弓手停步半径（欧氏 = 7.5），用 range 9.5 远程射
export const GUARD_MELEE_CAP = 2;                  // 一个垛口同时最多被 2 名近战攻方贴身（窄墙头挤不下第三人）
export const ASSAULT_COVER = 0.4;                  // 演示口径：守军受伤系数（真规则 0.7；栅栏+踩台实战遮蔽更强）
export const TOWER_RANGE = 12;                     // 箭塔弓手射程加成：居高远射覆盖全场（基础 9.5 只够半场）
export const ASSAULT_STEP_MS = 1000 / 60;          // 固定步长 1/60 秒
export const FORCE_PRESETS = {                     // 攻方兵力预设；守军数量走 DEF_COUNTS，编制见 slotKind
    squad:   { infantry: 24, pikeman: 6,  archer: 8  },
    company: { infantry: 48, pikeman: 12, archer: 16 },
    brigade: { infantry: 96, pikeman: 24, archer: 32 }
};
export function wallPoint(t, r = WALL_R) {
    const side = 2 * r, per = 8 * r;
    const s = ((t % per) + per) % per;
    const corners = [[-r, -r], [r, -r], [r, r], [-r, r]];
    const i = Math.min(3, Math.floor(s / side));
    const k = (s - i * side) / side;
    const [x0, y0] = corners[i], [x1, y1] = corners[(i + 1) % 4];
    return [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k];
}
export function wallParamToward(x, z) {
    const r = WALL_R, side = 2 * r;
    const m = Math.max(Math.abs(x), Math.abs(z));
    if (m < 1e-6) return 0;
    const ex = x / m * r, ey = z / m * r;
    if (Math.abs(ex) >= Math.abs(ey)) return ex > 0 ? side + (ey + r) : 3 * side + (r - ey);
    return ey < 0 ? ex + r : 2 * side + (r - ex);
}


export function createAssaultSim({ towerPositions = DEFAULT_TOWERS } = {}) {
    const assault = {};
    let random = mulberry32(1), nextId = 0;
    const randomBetween = (lo, hi) => lo + random() * (hi - lo);
    const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
    const radius = u => Math.max(Math.abs(u.x), Math.abs(u.z));
    const emit = (type, details = {}) => assault.events.push({ type, at: assault.elapsedMs, ...details });
    function resetAssault() {
        Object.assign(assault, { active: false, attackers: [], defenders: [], formations: [], events: [],
            acc: 0, elapsedMs: 0, result: null, phase: '列阵推进', flagMs: 0, retreatMs: 0,
            retreated: false, holdReason: null, gate: { hp: 6, maxHp: 6, broken: false },
            ram: { x: 0, z: 8.2, hp: Infinity, crew: [], state: 'waiting', waitingMs: 0, cooldown: 2200 },
            ladders: LADDERS.map(p => ({ ...p, climber: null })) });
        nextId = 0;
    }
    function makeUnit(team, type, x, z, yaw) {
        const typeData = UNIT_TYPES[type];
        return { id: nextId++, team, role: team === 'blue' ? 'attack' : 'defend', type, typeData, x, z, yaw,
            spawnX: x, spawnZ: z, y: 0, zone: team === 'blue' ? 'outside' : 'wall',
            hp: typeData.hp, maxHp: typeData.hp, cd: typeData.atkSpeed * randomBetween(.2, 1),
            speed: typeData.speed * randomBetween(.9, 1.1), dead: false, target: null,
            enteredVia: null, climbMs: 0, wallMs: 0, crew: false, crewSlot: -1,
            atkAt: -Infinity, hitAt: -Infinity, hitDX: 0, hitDZ: 0, dieAt: 0 };
    }
    function changeZone(u, zone, via = null) {
        const previous = u.zone;
        u.zone = zone;
        if (via) u.enteredVia = via;
        emit('zone', { unit: u, previous, zone, via, gateBroken: assault.gate.broken });
    }
    function startAssault(preset = 'company', defCount = 6, seed = 1) {
        resetAssault(); random = mulberry32(seed); assault.preset = preset;
        const counts = FORCE_PRESETS[preset] ?? FORCE_PRESETS.company;
        const side = random() < .5 ? -1 : 1;
        const groups = [[], [], []], slots = { infantry: 0, pikeman: 0, archer: 0 };
        for (const kind of ATTACK_KINDS) {
            const main = Math.round(counts[kind] * .7);
            for (let i = 0; i < counts[kind]; i++) groups[i < main ? i % 2 : 2].push(kind);
        }
        groups.forEach((types, id) => {
            const columns = Math.ceil(Math.sqrt(types.length));
            const rows = Math.ceil(types.length / columns), spacing = .8;
            const f = { id, x: id === 2 ? side * 16 : (id === 0 ? -3.6 : 3.6),
                z: id === 2 ? 0 : 15.5 + id * .6, dx: id === 2 ? -side : 0,
                dz: id === 2 ? 0 : -1, departMs: randomBetween(0, 1500), released: false, units: [] };
            types.forEach((type, i) => {
                const across = (i % columns - (columns - 1) / 2) * spacing;
                const depth = (Math.floor(i / columns) - (rows - 1) / 2) * spacing;
                const u = makeUnit('blue', type, f.x - f.dz * across - f.dx * depth,
                    f.z + f.dx * across - f.dz * depth, Math.atan2(f.dx, f.dz));
                u.slot = slots[type]++; u.formation = id; u.route = 'gate';
                f.units.push(u); assault.attackers.push(u);
            });
            f.speed = Math.min(...f.units.map(u => u.speed)); assault.formations.push(f);
        });
        const melee = assault.attackers.filter(u => u.type !== 'archer');
        // Prefer the diversion's nearest ladder, then fill the other ladder from the main ranks.
        const allotted = new Set();
        for (const index of [side < 0 ? 0 : 1, side < 0 ? 1 : 0]) {
            const ladder = LADDERS[index];
            const diversion = index === (side < 0 ? 0 : 1);
            const candidates = melee.filter(u => (u.formation === 2) === diversion)
                .sort((a, b) => distance(a, ladder) - distance(b, ladder));
            for (const u of candidates.filter(u => !allotted.has(u)).slice(0, Math.round(melee.length * .15))) {
                u.route = index; allotted.add(u);
            }
        }
        // Four rear-rank swordsmen join the ram from behind, rather than spawning at its handles.
        const crewCandidates = melee.filter(u => u.type === 'infantry' && u.route === 'gate' && u.formation !== 2)
            .sort((a, b) => b.z - a.z);
        const crew = [0, 1, 2, 3].map(i => crewCandidates.filter(u => (u.x < 0) === (i % 2 === 0))[Math.floor(i / 2)]);
        crew.forEach((u, i) => { u.crew = true; u.crewSlot = i; });
        assault.ram.crew = crew;
        const gateSlots = { '-1': 0, '1': 0 };
        assault.attackers.filter(u => u.route === 'gate' && !u.crew).forEach(u => {
            u.waitSide = u.x < 0 ? -1 : 1; u.gateSlot = gateSlots[u.waitSide]++;
        });
        const n = DEF_COUNTS.includes(defCount) ? defCount : 6;
        for (let i = 0; i < n; i++) {
            const t = i * 8 * WALL_R / n, [x, z] = wallPoint(t);
            assault.defenders.push({ ...makeUnit('red', slotKind(i), x, z, Math.atan2(x, z)),
                y: 1, homeT: t, fixed: false });
        }
        for (const p of towerPositions) assault.defenders.push({
            ...makeUnit('red', 'archer', p.x, p.z, p.yaw ?? 0), zone: 'tower', y: 2.56, fixed: true });
        assault.active = true; return assault;
    }
    function move(u, x, z, step) {
        const dx = x - u.x, dz = z - u.z, d = Math.hypot(dx, dz);
        if (d < 1e-9) return;
        const k = Math.min(1, step / d);
        u.x += dx * k; u.z += dz * k; u.yaw = Math.atan2(dx, dz);
    }
    function avoidTents(u) {
        for (const t of TENTS) {
            const h = t.half + .16, dx = u.x - t.x, dz = u.z - t.z;
            if (Math.abs(dx) >= h || Math.abs(dz) >= h) continue;
            if (h - Math.abs(dx) < h - Math.abs(dz)) u.x = t.x + (dx < 0 ? -h : h);
            else u.z = t.z + (dz < 0 ? -h : h);
        }
    }
    function constrain(u) {
        if (u.zone === 'outside') {
            const m = radius(u);
            if (m < MELEE_STOP_R) {
                if (Math.abs(u.x) > Math.abs(u.z)) u.x = (u.x < 0 ? -1 : 1) * MELEE_STOP_R;
                else u.z = (u.z < 0 ? -1 : 1) * MELEE_STOP_R;
            }
            // The complete ram body is a reserved corridor, not just its centre point.
            if (u.z > assault.ram.z - 1.35 && u.z < assault.ram.z + 1.35 && Math.abs(u.x) < .78)
                u.x = (u.x < 0 ? -1 : 1) * .78;
        } else if (u.zone === 'inside') {
            u.x = Math.max(-4.78, Math.min(4.78, u.x));
            u.z = Math.max(-4.78, Math.min(u.z > 4.78 && Math.abs(u.x) <= 1 ? 5.39 : 4.78, u.z));
            avoidTents(u);
        }
    }
    function outsideMove(u, x, z, step) {
        // A shared exterior half-plane makes a direct segment safe. Otherwise follow the
        // shorter perimeter direction through exterior corners, including the 5.4 gate mouth.
        const r = 6.05, side = 2 * r, perimeter = 8 * r;
        const sameFace = (u.x <= -MELEE_STOP_R && x <= -MELEE_STOP_R) ||
            (u.x >= MELEE_STOP_R && x >= MELEE_STOP_R) ||
            (u.z <= -MELEE_STOP_R && z <= -MELEE_STOP_R) ||
            (u.z >= MELEE_STOP_R && z >= MELEE_STOP_R);
        if (!sameFace) {
            const param = (px, pz) => {
                const cx = Math.max(-r, Math.min(r, px)), cz = Math.max(-r, Math.min(r, pz));
                if (Math.abs(px) >= Math.abs(pz)) return px > 0 ? side + cz + r : 3 * side + r - cz;
                return pz < 0 ? cx + r : 2 * side + r - cx;
            };
            const have = param(u.x, u.z), want = param(x, z);
            const diff = ((want - have + perimeter * 1.5) % perimeter) - perimeter / 2;
            const corner = diff >= 0 ? (Math.floor((have + 1e-8) / side) + 1) * side :
                (Math.ceil((have - 1e-8) / side) - 1) * side;
            const [cx, cz] = wallPoint(corner, r);
            move(u, cx, cz, step);
        } else if (u.x * x < 0 && Math.min(u.z, z) < assault.ram.z + 1.4 &&
            Math.max(u.z, z) > assault.ram.z - 1.4) {
            if (u.z < assault.ram.z + 1.5) move(u, Math.sign(u.x) * Math.max(.9, Math.abs(u.x)), assault.ram.z + 1.6, step);
            else move(u, x, u.z, step);
        } else move(u, x, z, step);
        constrain(u);
    }
    function nearest(list, from, range = Infinity, predicate = () => true) {
        let best = null, bestD = range * range;
        for (const u of list) {
            if (u.dead || !predicate(u)) continue;
            const d = (u.x - from.x) ** 2 + (u.z - from.z) ** 2;
            if (d <= bestD && (!best || d < bestD - 1e-9)) { bestD = d; best = u; }
        }
        return best;
    }
    function canHit(from, to) {
        if (from.type === 'archer') return true;
        if (from.zone === 'ladder') return false;
        if (to.fixed) return false; // Ground melee cannot hit the elevated tower platform.
        if (from.zone === 'outside') return from.type === 'pikeman' && to.zone === 'wall';
        if (from.zone === 'wall') return to.zone === 'wall' || (from.team === 'red' && to.zone === 'outside');
        if (from.zone === 'inside') return to.zone === 'inside';
        return false;
    }
    function rangeOf(u) { return u.fixed ? TOWER_RANGE : u.type === 'pikeman' ? 1.6 : u.typeData.range; }
    function breakGate() {
        assault.gate.broken = true; emit('gate_broken');
        const swords = assault.defenders.filter(u => !u.dead && !u.fixed && u.type === 'infantry')
            .sort((a, b) => distance(a, { x: 0, z: 5 }) - distance(b, { x: 0, z: 5 }));
        const chosen = swords.slice(0, Math.ceil(swords.length / 2));
        chosen.forEach((u, i) => {
            changeZone(u, 'inside'); u.y = 0;
            u.x = (i - (chosen.length - 1) / 2) * .55; u.z = 3.8;
            u.blockX = u.x;
        });
        for (const u of assault.ram.crew) { u.crew = false; u.crewSlot = -1; }
        assault.ram.crew = []; assault.ram.state = 'spent';
    }
    function updateRam(dt) {
        const r = assault.ram;
        if (assault.gate.broken) { r.z = Math.min(8.2, r.z + .9 * dt); return; }
        if (r.state === 'abandoned') return;
        r.crew = r.crew.filter(u => !u.dead);
        const freeSlots = [0, 1, 2, 3].filter(i => !r.crew.some(u => u.crewSlot === i));
        for (const i of freeSlots) {
            const recruit = nearest(assault.attackers, r, 3,
                u => !u.crew && u.zone === 'outside' && u.route === 'gate' && u.type !== 'archer');
            if (!recruit) break;
            recruit.crew = true; recruit.crewSlot = i; r.crew.push(recruit);
        }
        let ready = 0;
        for (const u of r.crew) {
            if (assault.elapsedMs < assault.formations[u.formation].departMs) continue;
            const x = u.crewSlot % 2 ? .88 : -.88, z = r.z + (u.crewSlot < 2 ? -.5 : .5);
            outsideMove(u, x, z, u.speed * dt);
            if (Math.hypot(u.x - x, u.z - z) < .18) ready++;
        }
        if (r.crew.length < 2 || ready < 2) {
            r.state = 'waiting'; r.waitingMs += dt * 1000;
            if (r.waitingMs >= 8000) {
                for (const u of assault.attackers) if (!u.dead && u.zone === 'outside' && u.type !== 'archer' && u.route === 'gate') {
                    u.crew = false; u.crewSlot = -1;
                    u.route = distance(u, assault.ladders[0]) <= distance(u, assault.ladders[1]) ? 0 : 1;
                }
                r.crew = []; r.state = 'abandoned'; emit('ram_abandoned');
            }
            return;
        }
        r.waitingMs = 0;
        if (r.z > 6.45) {
            const step = Math.min(r.z - 6.45, .48 * dt);
            r.z -= step;
            for (const u of r.crew) if (distance(u, r) < 1.6) u.z -= step;
            r.state = 'advancing'; return;
        }
        r.state = 'hitting'; r.cooldown -= dt * 1000;
        if (r.cooldown <= 0) {
            assault.gate.hp--; emit('ram_hit', { hp: assault.gate.hp });
            r.cooldown = 2200 * randomBetween(.9, 1.1);
            if (assault.gate.hp === 0) breakGate();
        }
    }
    function advanceFormations(dt) {
        for (const f of assault.formations) {
            if (f.released || assault.elapsedMs <= f.departMs) continue;
            const living = f.units.filter(u => !u.dead && !u.crew);
            if (living.some(u => radius(u) <= 7.8)) { f.released = true; continue; }
            const step = f.speed * Math.min(dt, (assault.elapsedMs - f.departMs) / 1000);
            f.x += f.dx * step; f.z += f.dz * step;
            for (const u of living) { u.x += f.dx * step; u.z += f.dz * step; constrain(u); }
        }
    }
    function advanceAttacker(u, dt) {
        if (u.crew || !assault.formations[u.formation].released) return;
        const step = u.speed * dt;
        if (u.zone === 'ladder') {
            const l = assault.ladders[u.route];
            u.climbMs = Math.min(1600, u.climbMs + dt * 1000);
            const k = u.climbMs / 1600;
            u.x = l.x + (l.topX - l.x) * k; u.z = l.z; u.y = k;
            if (k === 1) { changeZone(u, 'wall'); u.wallMs = 0; }
            return;
        }
        if (u.zone === 'wall') {
            const l = assault.ladders[u.route];
            u.wallMs += dt * 1000;
            if (u.wallMs >= 1000 && !nearest(assault.defenders, u, 1, d => d.zone === 'wall')) {
                changeZone(u, 'inside', 'ladder'); u.x = Math.sign(l.topX) * 4.4; u.y = 0;
                if (l.climber === u) l.climber = null;
            }
            return;
        }
        if (u.zone === 'inside') {
            const enemy = nearest(assault.defenders, u, 2.8, d => d.zone === 'inside');
            if (enemy && distance(u, enemy) <= rangeOf(u) * .85) return;
            move(u, enemy ? enemy.x : 0, enemy ? enemy.z : 0, step); constrain(u); return;
        }
        if (u.type === 'archer' && !assault.gate.broken) {
            const r = Math.hypot(u.x, u.z);
            if (r > ARCHER_STOP_R) outsideMove(u, u.x * ARCHER_STOP_R / r, u.z * ARCHER_STOP_R / r, step);
            return;
        }
        if (typeof u.route === 'number' && !assault.gate.broken) {
            const l = assault.ladders[u.route];
            const side = Math.sign(l.x);
            // Leave the gate's waiting ranks before crossing the front face. Keep the
            // waypoint stage so separation cannot repeatedly send us back to the front.
            if (!u.ladderApproach && u.z >= MELEE_STOP_R && u.x * side < MELEE_STOP_R)
                u.ladderApproach = 'outward';
            if (u.ladderApproach === 'outward' && u.z >= 7.6) u.ladderApproach = 'corner';
            if (u.ladderApproach === 'corner' && u.x * side >= 7.15) u.ladderApproach = 'side';
            if (u.ladderApproach === 'outward') {
                move(u, u.x, 7.65, step); constrain(u); return;
            }
            if (u.ladderApproach === 'corner') {
                outsideMove(u, side * 7.2, 7.65, step); return;
            }
            if (l.climber?.dead) l.climber = null;
            if (!l.climber && distance(u, l) < .32) {
                l.climber = u; changeZone(u, 'ladder'); u.climbMs = 0; u.x = l.x; u.z = l.z;
            } else outsideMove(u, l.x + (l.climber ? Math.sign(l.x) * .5 : 0), l.z, step);
            return;
        }
        // A broken gate is the only ground-level transition. Enter at the mouth, never through a wall.
        if (assault.gate.broken && Math.abs(u.x) <= 1 && u.z >= 5.4 && u.z <= 5.6) {
            changeZone(u, 'inside', 'gate'); u.z = 5.39; return;
        }
        const lane = (u.x < 0 ? -1 : 1) * .86;
        const slot = u.gateSlot ?? u.id;
        const waitX = (u.waitSide ?? (u.x < 0 ? -1 : 1)) * (1.2 + slot % 4 * .56);
        const waitZ = 5.75 + Math.floor(slot / 4) * .56;
        outsideMove(u, assault.gate.broken ? lane : waitX, assault.gate.broken ? 5.4 : waitZ, step);
    }
    function separateAttackers(units) {
        const traveling = u => !assault.gate.broken && u.zone === 'outside' && !u.crew &&
            typeof u.route === 'number' && assault.formations[u.formation].released &&
            distance(u, assault.ladders[u.route]) > 1.2;
        // A wider collision diameter leaves margin for corner projection. Squared-distance broad rejection
        // avoids square roots for distant pairs; stable pair order preserves exact replays.
        for (let pass = 0; pass < 16; pass++) {
            let overlaps = false;
            for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
                const a = units[i], b = units[j];
                let dx = b.x - a.x, dz = b.z - a.z;
                const sq = dx * dx + dz * dz;
                if (sq >= .48 * .48) continue;
                overlaps = true;
                const fixedA = a.zone === 'ladder' || a.zone === 'wall' || (a.crew && !b.crew);
                const fixedB = b.zone === 'ladder' || b.zone === 'wall' || (b.crew && !a.crew);
                if (fixedA && fixedB) continue;
                let d = Math.sqrt(sq);
                if (d < 1e-9) { dx = 1; dz = 0; d = 1; }
                const push = .48 - Math.sqrt(sq), nx = dx / d, nz = dz / d;
                // Gate waiters yield to passing ladder traffic; neither side loses its
                // collision radius, and crew / ladder occupants retain their priority.
                let shareA = .5;
                if (traveling(a) && b.zone === 'outside' && b.route === 'gate') shareA = .05;
                else if (traveling(b) && a.zone === 'outside' && a.route === 'gate') shareA = .95;
                if (!fixedA) { const k = fixedB ? 1 : shareA; a.x -= nx * push * k; a.z -= nz * push * k; constrain(a); }
                if (!fixedB) { const k = fixedA ? 1 : 1 - shareA; b.x += nx * push * k; b.z += nz * push * k; constrain(b); }
            }
            if (!overlaps) break;
        }
        // Projection against two perpendicular obstacles can trap a residual overlap. Resolve only
        // those cases against the already placed units; immutable ladder occupants go first.
        const ordered = [...units].sort((a, b) =>
            Number(b.zone === 'ladder' || b.zone === 'wall') - Number(a.zone === 'ladder' || a.zone === 'wall'));
        const placed = [];
        for (const u of ordered) {
            const clear = () => placed.every(v => (u.x - v.x) ** 2 + (u.z - v.z) ** 2 >= .32 ** 2);
            if (!clear() && u.zone !== 'ladder' && u.zone !== 'wall') {
                const x = u.x, z = u.z;
                let found = false;
                for (let ring = 1; ring <= 32 && !found; ring++) for (let i = 0; i < 16; i++) {
                    const angle = i * Math.PI / 8;
                    u.x = x + Math.cos(angle) * ring * .16;
                    u.z = z + Math.sin(angle) * ring * .16;
                    constrain(u);
                    if (clear()) { found = true; break; }
                }
            }
            placed.push(u);
        }
    }
    function updateDefenders(dt) {
        const threats = assault.ladders.filter(l => l.climber && !l.climber.dead);
        if (assault.ram.state === 'hitting') threats.push({ x: 0, z: 5 });
        for (const d of assault.defenders) {
            if (d.dead) continue;
            const enemy = nearest(assault.attackers, d);
            if (d.zone === 'inside') {
                const target = nearest(assault.attackers, d, 3, u => u.zone === 'inside');
                if (!target || distance(d, target) > rangeOf(d) * .8)
                    move(d, target ? target.x : d.blockX, target ? target.z : 3.8, d.speed * dt);
                constrain(d);
            } else if (!d.fixed) {
                const threat = threats.reduce((best, t) => !best || distance(d, t) < distance(d, best) ? t : best, null);
                const have = wallParamToward(d.x, d.z), want = threat ? wallParamToward(threat.x, threat.z) : d.homeT;
                let diff = ((want - have + 60) % 40) - 20;
                const [x, z] = wallPoint(have + Math.sign(diff) * Math.min(Math.abs(diff), d.speed * dt));
                d.x = x; d.z = z;
            }
            if (enemy) d.yaw = Math.atan2(enemy.x - d.x, enemy.z - d.z);
        }
    }
    function strike(from, to) {
        const multiplier = from.team === 'red' && from.zone !== 'inside' ? CAMP_RULES.WALL_GUARD_ATTACK : 1;
        const cover = to.zone === 'wall' || to.fixed ? ASSAULT_COVER : 1;
        const damage = Math.max(1, Math.floor(calculateAttackDamage(from, to, { multiplier }) * cover));
        to.hp = Math.max(0, to.hp - damage); to.hitAt = assault.elapsedMs;
        const d = distance(from, to) || 1;
        to.hitDX = (to.x - from.x) / d; to.hitDZ = (to.z - from.z) / d;
        if (to.hp === 0) { to.dead = true; to.dieAt = assault.elapsedMs; }
        from.atkAt = assault.elapsedMs;
        emit('attack', { from, to, damage, fromZone: from.zone, toZone: to.zone });
        from.cd = from.typeData.atkSpeed * randomBetween(.85, 1.15);
    }
    function fight(units, targets, ms) {
        const load = new Map();
        for (const u of units) {
            if (u.dead || u.crew || u.zone === 'ladder') continue;
            const target = nearest(targets, u, rangeOf(u), t => canHit(u, t) &&
                (u.team !== 'blue' || u.type === 'archer' || (load.get(t) ?? 0) < GUARD_MELEE_CAP));
            u.target = target;
            if (!target) continue;
            if (u.team === 'blue' && u.type !== 'archer') load.set(target, (load.get(target) ?? 0) + 1);
            u.yaw = Math.atan2(target.x - u.x, target.z - u.z); u.cd -= ms;
            if (u.cd <= 0) strike(u, target);
        }
    }
    function updateVictory(ms) {
        const living = assault.attackers.filter(u => !u.dead);
        if (!living.length) { assault.result = 'hold'; return; }
        const flag = living.some(u => u.zone === 'inside' && Math.hypot(u.x, u.z) <= 1.6);
        const contested = assault.defenders.some(u => !u.dead && Math.hypot(u.x, u.z) <= 1.6);
        assault.flagMs = flag && !contested ? assault.flagMs + ms : 0;
        if (assault.flagMs >= 3000) { assault.flagMs = 3000; assault.result = 'break'; emit('flag_captured'); return; }
        if (living.length <= assault.attackers.length * .4 && !assault.gate.broken &&
            !living.some(u => u.zone === 'wall' || u.zone === 'inside')) {
            assault.retreated = true; assault.retreatMs = 0; assault.flagMs = 0; emit('retreat');
        }
    }
    // One call is exactly one logical tick. Frame accumulation belongs to the presentation layer.
    function stepAssault(ms = ASSAULT_STEP_MS) {
        if (Math.abs(ms - ASSAULT_STEP_MS) > 1e-6) throw new RangeError('Assault requires a fixed 1/60s tick');
        if (!assault.active || assault.result !== null) return [];
        assault.events = []; assault.elapsedMs += ms;
        const dt = ms / 1000;
        if (assault.retreated) {
            for (const u of assault.attackers) if (!u.dead) {
                if (u.zone === 'ladder') {
                    changeZone(u, 'outside'); u.y = 0; u.x = assault.ladders[u.route].x;
                }
                const formation = assault.formations[u.formation];
                move(u, u.x - formation.dx, u.z - formation.dz, u.speed * dt);
                constrain(u);
            }
            separateAttackers(assault.attackers.filter(u => !u.dead));
            updateDefenders(dt);
            fight(assault.defenders, assault.attackers, ms);
            assault.retreatMs += ms;
            if (assault.retreatMs >= 3000) assault.result = 'hold';
            limitDuration();
            assault.phase = '溃退'; return assault.events;
        }
        advanceFormations(dt); updateRam(dt);
        for (const u of assault.attackers) if (!u.dead) advanceAttacker(u, dt);
        separateAttackers(assault.attackers.filter(u => !u.dead));
        updateDefenders(dt);
        fight(assault.attackers, assault.defenders, ms); fight(assault.defenders, assault.attackers, ms);
        updateVictory(ms);
        limitDuration();
        assault.phase = assault.retreated ? '溃退' : assault.flagMs > 0 ? '夺旗中' : assault.gate.broken ? '破门涌入' :
            assault.ladders.some(l => l.climber && !l.climber.dead) ? '登城' :
                assault.ram.state === 'hitting' ? '撞门' : '列阵推进';
        return assault.events;
    }
    function limitDuration() {
        if (assault.result === null && assault.elapsedMs >= 180000 - 1e-6) {
            assault.result = 'hold'; assault.holdReason = 'stalemate'; emit('stalemate_hold');
        }
    }
    resetAssault();
    return { assault, startAssault, resetAssault, stepAssault };
}
