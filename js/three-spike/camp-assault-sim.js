// Deterministic camp assault simulation: no THREE, DOM, or wall geometry mutations.
import { UNIT_TYPES, calculateAttackDamage } from '../units.js';
import { CAMP_RULES } from '../battle/camps.js';
export const WALL_R = 7;
export const ATK_ANIM_MS = 220, HIT_ANIM_MS = 180;
export const ATTACK_KINDS = ['infantry', 'pikeman', 'archer'];
export const DEF_COUNTS = [6, 12, 24];
export const slotKind = i => i % 3 === 2 ? 'archer' : 'infantry';
// All camp placement lives here; presentation consumes these coordinates.
export const GATE_HALF = 1.2;
export const WALK_INSET = .55;
export const LADDER_LIP = .8;                      // 梯顶最后 20% 才翻过栅栏、内缩到踩台；墙头有守军时攀爬停在此处
export const STEP_DOWN_RATE = 1.25, STEP_DOWN_RUN = .4; // 下踩台：竖直 1.25/秒（1→0 约 .8 秒），同时朝寨内水平走 .4
// 渲染坐标（camp.js 与测试共用）：k=1 为踩台位置（墙线径向内缩 WALK_INSET）
export function inwardPoint(x, z, k = 1) {
    const l = Math.hypot(x, z) || 1;
    return [x - x / l * WALK_INSET * k, z - z / l * WALK_INSET * k];
}
export function viewPoint(u) {
    const k = u.zone === 'wall' ? 1 : u.zone === 'ladder' ? Math.max(0, (u.y - LADDER_LIP) / (1 - LADDER_LIP)) : 0;
    return inwardPoint(u.x, u.z, k);
}
// 身位口径（R3）：敌我之间、红方之间，同一高度层才互相占位；梯上只算翻墙段（y>=LADDER_LIP，按墙头高度比较）
export const BODY_GAP = .45;
const bodyHeight = u => u.zone === 'ladder' ? 1 : u.y;
export function bodyPartners(a, b) {
    if (a === b || a.dead || b.dead || a.fixed || b.fixed || a.team === 'blue' && b.team === 'blue') return false;
    if (a.zone === 'ladder' && a.y < LADDER_LIP || b.zone === 'ladder' && b.y < LADDER_LIP) return false;
    return Math.abs(bodyHeight(a) - bodyHeight(b)) <= .3;
}
// 与最近身位伙伴的基础渲染距离
export function bodyGap(u, units) {
    const [x, z] = viewPoint(u);
    let gap = Infinity;
    for (const v of units) if (bodyPartners(u, v)) {
        const [vx, vz] = viewPoint(v); gap = Math.min(gap, Math.hypot(x - vx, z - vz));
    }
    return gap;
}
// 出手前扑 .18 / 受击后仰 .09 的姿态偏移；按身位余量截断（双方各让一半），最终网格不压破 BODY_GAP
export function poseOffset(u, atkN, hitN, gap = Infinity) {
    const lunge = Math.sin(Math.PI * atkN) * .18, recoil = .09 * hitN;
    let lx = Math.sin(u.yaw) * lunge - u.hitDX * recoil, lz = Math.cos(u.yaw) * lunge - u.hitDZ * recoil;
    const n = Math.hypot(lx, lz), cap = Math.max(0, (gap - BODY_GAP) / 2);
    if (n > cap) { lx *= cap / n; lz *= cap / n; }
    return [lx, lz];
}
// 最终网格平面位置 = 基础渲染位置 + 截断后的姿态偏移（camp.js 与测试共用）
export function meshPoint(u, atkN, hitN, gap = Infinity) {
    const [x, z] = viewPoint(u), [lx, lz] = poseOffset(u, atkN, hitN, gap);
    return [x + lx, z + lz];
}
export const RAM_REST = WALL_R + 3.2, RAM_HIT = WALL_R + 1.45;
export const BLOCK_Z = WALL_R - 1.2;
export const TOWER_HALF = .68;
export const TOWER_ORIGINS = [{ x: -5.3, z: 5.3 }, { x: 0, z: -5.3 }];
export const TOWER_ARCHER_SLOTS = [
    { x: -.35, z: -.42, yaw: 0 }, { x: .35, z: -.42, yaw: 0 },
    { x: -.35, z: .42, yaw: Math.PI }, { x: .35, z: .42, yaw: Math.PI }
];
export const DEFAULT_TOWERS = TOWER_ORIGINS.flatMap(o => TOWER_ARCHER_SLOTS.map(p =>
    ({ ...p, x: o.x + p.x, z: o.z + p.z })));
export const LADDERS = [
    { x: -4.5, z: WALL_R + .62, topX: -4.5, topZ: WALL_R, nx: 0, nz: 1 },
    { x: 4.5, z: WALL_R + .62, topX: 4.5, topZ: WALL_R, nx: 0, nz: 1 },
    { x: -WALL_R - .62, z: 2, topX: -WALL_R, topZ: 2, nx: -1, nz: 0 },
    { x: WALL_R + .62, z: 2, topX: WALL_R, topZ: 2, nx: 1, nz: 0 }
];
// Reserved lanes are shared by movement, rendering and geometry tests.
export const GATE_WAIT_INNER = 1.4, GATE_WAIT_COLUMNS = 4, GATE_WAIT_SPACING = .48;
export const RAM_CORRIDOR = { minX: -.78, maxX: .78, minZ: RAM_HIT - 1.35, maxZ: RAM_REST + 1.35 };
export const ladderQueueCapacity = () => LADDER_QUEUE_CAPACITY;
export function ladderQueueSlot(l, i) {
    return { x: l.x + l.nx * i * LADDER_QUEUE_SPACING, z: l.z + l.nz * i * LADDER_QUEUE_SPACING };
}
export function gateWaitSlot(side, i) {
    return { x: side * (GATE_WAIT_INNER + i % GATE_WAIT_COLUMNS * GATE_WAIT_SPACING),
        z: MELEE_STOP_R + Math.floor(i / GATE_WAIT_COLUMNS) * GATE_WAIT_SPACING };
}
export function archerFireSlot(group, i) {
    if (group === 'G') return { x: (i % 2 ? 1 : -1) * (1.2 + Math.floor(i / 2) % 5 * .6),
        z: 10.8 + Math.floor(i / 10) * .48 };
    return { x: (group === 'L2' ? -1 : 1) * (10.4 + Math.floor(i / 3) * .8), z: .8 - i % 3 * .6 };
}
export const TENTS = [{ x: 0, z: 0, half: 1.1 }, ...[-3.5, 3.5].flatMap(x =>
    [-3.5, 3.5].map(z => ({ x, z, half: .9 })))];

// Presentation text uses simulation durability while active, manual hits otherwise.
export function ramButtonText(active, gate, manualHits = 0, manualMaxHp = 6) {
    if (active) return `冲车撞门 (${gate.maxHp - gate.hp}/${gate.maxHp})`;
    return manualHits > 0 && manualHits < manualMaxHp ? `冲车撞门 (${manualHits}/${manualMaxHp})` : '冲车撞门';
}

export function formationSizes(meleeTotal) {
    if (!Number.isInteger(meleeTotal) || meleeTotal < 8) throw new RangeError('Four crew and four ladder teams require >=8 melee');
    const gate = Math.round(meleeTotal * .46), front = Math.round(meleeTotal * .15);
    const side = meleeTotal - gate - 2 * front;
    const sizes = [gate, front, front, Math.floor(side / 2), Math.ceil(side / 2)];
    for (let i = 1; i < sizes.length; i++) if (sizes[i] < 1) { sizes[0] -= 1 - sizes[i]; sizes[i] = 1; }
    while (sizes[0] < 4) {
        const donor = sizes.findIndex((n, i) => i > 0 && n > 1);
        sizes[donor]--; sizes[0]++;
    }
    return sizes;
}

export function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        let t = state += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
export const MELEE_STOP_R = WALL_R + 0.4;          // 外墙之外 .4 的切比雪夫停步圈
export const ARCHER_STOP_R = WALL_R + 2.5;                  // 弓手停步欧氏半径，随墙线外移
export const GUARD_MELEE_CAP = 2;                  // 一个垛口同时最多被 2 名近战攻方贴身（窄墙头挤不下第三人）
export const GATE_BLOCKER_ATTACK = 1.20;           // 破门后堵门守军在原驻军攻击加成上的近战加成
export const ASSAULT_COVER = 0.4;                  // 演示口径：守军受伤系数（真规则 0.7；栅栏+踩台实战遮蔽更强）
export const TOWER_RANGE = 12;                     // 箭塔弓手射程加成：居高远射覆盖全场（基础 9.5 只够半场）
export const RETREAT_SURVIVOR_FRACTION = .335;
export const RETREAT_RESERVE = 18;
export const RETREAT_MAX_RESERVE_FRACTION = .5;
export const RAM_IMPACT_MS = 2200;
export const FLAG_RADIUS = 3.5;                    // 旗心判定半径：净权重对冲的参与圈（寨内 10 格宽，取中军大帐外半圈）
export const FLAG_RATE = 0.01;                     // 拉锯速度：净占领力 10 → 每秒 0.1 进度（沿用 2D updateFlags 的 RATE）
export const FLAG_WEIGHT = { infantry: 10, pikeman: 7, archer: 4, cavalry: 12 }; // 兵种占领力，对齐 2D POWER 表
export const LADDER_QUEUE_CAPACITY = 8;
export const LADDER_QUEUE_SPACING = .48;
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
    let random = mulberry32(1), nextId = 0, frameOrigin = null;
    const randomBetween = (lo, hi) => lo + random() * (hi - lo);
    const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
    const radius = u => Math.max(Math.abs(u.x), Math.abs(u.z));
    const emit = (type, details = {}) => assault.events.push({ type, at: assault.elapsedMs, ...details });
    function resetAssault() {
        Object.assign(assault, { active: false, attackers: [], defenders: [], formations: [], events: [],
            acc: 0, elapsedMs: 0, result: null, phase: '列阵推进', flagProgress: -1, flagNet: 0, flagAtk: 0, retreatMs: 0,
            retreated: false, holdReason: null, gate: { hp: 6, maxHp: 6, broken: false },
            ram: { x: 0, z: RAM_REST, hp: Infinity, crew: [], state: 'waiting', waitingMs: 0, cooldown: RAM_IMPACT_MS },
            ladders: LADDERS.map(p => ({ ...p, climber: null, queue: [], waiters: [],
                slots: Array.from({ length: ladderQueueCapacity(p) }, (_, i) => ladderQueueSlot(p, i)) })) });
        nextId = 0;
    }
    function makeUnit(team, type, x, z, yaw) {
        const typeData = UNIT_TYPES[type];
        return { id: nextId++, team, role: team === 'blue' ? 'attack' : 'defend', type, typeData, x, z, yaw,
            spawnX: x, spawnZ: z, y: 0, zone: team === 'blue' ? 'outside' : 'wall',
            hp: typeData.hp, maxHp: typeData.hp, cd: typeData.atkSpeed * randomBetween(.2, 1),
            speed: typeData.speed * randomBetween(.9, 1.1), dead: false, target: null,
            waitState: 'travel', moveTarget: null, enteredVia: null, climbMs: 0, wallMs: 0, crew: false, crewSlot: -1,
            atkAt: -Infinity, hitAt: -Infinity, hitDX: 0, hitDZ: 0, dieAt: 0 };
    }
    function changeZone(u, zone, via = null) {
        const previous = u.zone;
        u.zone = zone;
        if (via) u.enteredVia = via;
        if (previous === 'ladder' || previous === 'wall') {
            const l = assault.ladders[u.route];
            if (zone !== 'ladder' && zone !== 'wall' && l?.climber === u) l.climber = null;
        }
        emit('zone', { unit: u, previous, zone, via, gateBroken: assault.gate.broken });
    }
    function startAssault(preset = 'company', defCount = 6, seed = 1) {
        resetAssault(); random = mulberry32(seed); assault.preset = preset;
        const counts = FORCE_PRESETS[preset] ?? FORCE_PRESETS.company;
        const meleeTotal = counts.infantry + counts.pikeman;
        const sizes = formationSizes(meleeTotal);
        if (counts.infantry < 4) throw new RangeError('Gate crew requires >=4 swords');
        const pikes = sizes.map(n => Math.round(n * counts.pikeman / meleeTotal));
        pikes[0] += counts.pikeman - pikes.reduce((a, b) => a + b, 0);
        // Reserve the four gate swords before distributing the remaining pikes.
        for (let i = 1; pikes[0] > sizes[0] - 4 && i < sizes.length; i++) {
            const transfer = Math.min(pikes[0] - (sizes[0] - 4), sizes[i] - pikes[i]);
            pikes[0] -= transfer; pikes[i] += transfer;
        }
        const slots = { infantry: 0, pikeman: 0, archer: 0 };
        sizes.forEach((n, id) => {
            const route = id ? id - 1 : 'gate', l = id ? LADDERS[route] : null;
            const f = { id, name: id ? `L${route}` : 'G', route,
                x: id >= 3 ? l.nx * 16 : id ? l.x : 0, z: id >= 3 ? 2 : 16,
                dx: id >= 3 ? -l.nx : 0, dz: id >= 3 ? 0 : -1,
                departMs: randomBetween(0, 1500), released: false, units: [] };
            const swords = n - pikes[id];
            for (let i = 0; i < n; i++) {
                const type = i < swords ? 'infantry' : 'pikeman';
                let x, z;
                if (!id) {
                    // Crew lead in the reserved centre; waiting ranks use their own columns.
                    if (i < 4) { x = i % 2 ? .88 : -.88; z = 14.8 + Math.floor(i / 2) * .8; }
                    else {
                        const slot = gateWaitSlot(i % 2 ? 1 : -1, Math.floor((i - 4) / 2));
                        x = slot.x; z = 16 + slot.z - MELEE_STOP_R;
                    }
                } else {
                    // Stagger the two files by half a rank. Every soldier has a distinct
                    // longitudinal position before the files merge into one straight queue.
                    const across = (i % 2 ? 1 : -1) * .4, depth = i * LADDER_QUEUE_SPACING;
                    x = f.x - f.dz * across - f.dx * depth;
                    z = f.z + f.dx * across - f.dz * depth;
                }
                const u = makeUnit('blue', type, x, z, Math.atan2(f.dx, f.dz));
                Object.assign(u, { slot: slots[type]++, formation: id, squad: f.name, route, originalRoute: route });
                if (!id && i < 4) { u.crew = true; u.crewSlot = i; assault.ram.crew.push(u); }
                else if (!id) { u.waitSide = i % 2 ? 1 : -1; u.gateSlot = Math.floor((i - 4) / 2); }
                f.units.push(u); assault.attackers.push(u);
            }
            assault.formations.push(f);
        });
        const gateBows = Math.round(counts.archer * .6), sideBows = counts.archer - gateBows;
        for (const [group, count, formation] of [['G', gateBows, 0],
            ['L2', Math.floor(sideBows / 2), 3], ['L3', Math.ceil(sideBows / 2), 4]]) {
            const f = assault.formations[formation];
            for (let i = 0; i < count; i++) {
                const fireSlot = archerFireSlot(group, i);
                const x = group === 'G' ? fireSlot.x : f.x - f.dx * (3 + Math.floor(i / 3) * .8);
                const z = group === 'G' ? 24 + Math.floor(i / 10) * .48 : fireSlot.z;
                const u = makeUnit('blue', 'archer', x, z, Math.atan2(f.dx, f.dz));
                Object.assign(u, { slot: slots.archer++, formation, squad: group, route: 'gate', fireSlot });
                f.units.push(u); assault.attackers.push(u);
            }
        }
        for (const f of assault.formations) {
            f.speed = Math.min(...f.units.map(u => u.speed));
            if (typeof f.route === 'number') {
                const members = f.units.filter(u => u.type !== 'archer');
                assault.ladders[f.route].queue = members.slice(0, LADDER_QUEUE_CAPACITY);
                assault.ladders[f.route].waiters = members.slice(LADDER_QUEUE_CAPACITY);
            }
        }
        const n = DEF_COUNTS.includes(defCount) ? defCount : 6;
        assault.gate.hp = assault.gate.maxHp = { 6: 6, 12: 9, 24: 12 }[n];
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
    // 从踩台下到寨内：渲染位置不变地换区，之后 y 逐帧下降、沿墙面法向朝寨内走下台阶
    function startStepDown(u) {
        [u.x, u.z] = inwardPoint(u.x, u.z); frameOrigin?.set(u, [u.x, u.z]); // 换区后位移预算从踩台渲染位置算起
        const onZ = Math.abs(u.z) >= Math.abs(u.x);
        u.foot = { x: onZ ? u.x : u.x - Math.sign(u.x) * STEP_DOWN_RUN, z: onZ ? u.z - Math.sign(u.z) * STEP_DOWN_RUN : u.z };
    }
    function stepDown(u, dt) {
        if (u.zone !== 'inside' || !(u.y > 0)) return false;
        const dy = Math.min(u.y, STEP_DOWN_RATE * dt);
        u.y -= dy; move(u, u.foot.x, u.foot.z, STEP_DOWN_RUN * dy); constrain(u);
        return true;
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
            // 按最浅穿透方向推出，冲车前移压到人时顺着车头推开而不是横向瞬移
            const front = u.z - (assault.ram.z - 1.35), rear = assault.ram.z + 1.35 - u.z, side = .78 - Math.abs(u.x);
            if (front > 0 && rear > 0 && side > 0) {
                if (front <= side && front <= rear && assault.ram.z - 1.35 - 1e-6 >= MELEE_STOP_R) u.z = assault.ram.z - 1.35 - 1e-6;
                else if (rear < side) u.z = assault.ram.z + 1.35 + 1e-6;
                else u.x = (u.x < 0 ? -1 : 1) * .78;
            }
        } else if (u.zone === 'inside') {
            const mouth = WALL_R - .22;
            u.x = Math.max(-mouth, Math.min(mouth, u.x));
            u.z = Math.max(-mouth, Math.min(MELEE_STOP_R - .01, u.z));
            // 门洞只有 |x|<=1 宽：按较浅的穿透方向推回，避免门洞内外切换时瞬移
            if (u.z > mouth && Math.abs(u.x) > 1) {
                if (Math.abs(u.x) - 1 < u.z - mouth) u.x = Math.sign(u.x); else u.z = mouth;
            }
            avoidTents(u);
        }
    }
    function outsideMove(u, x, z, step) {
        // All regular objectives are on the spawn face. Only gate traffic may need
        // to pass behind the ram; no ladder route follows exterior corners anymore.
        if (u.x * x < 0 && Math.min(u.z, z) < assault.ram.z + 1.4 &&
            Math.max(u.z, z) > assault.ram.z - 1.4) {
            if (u.z < assault.ram.z + 1.5) move(u, Math.sign(u.x) * Math.max(.9, Math.abs(u.x)), assault.ram.z + 1.6, step);
            else move(u, x, u.z, step);
        } else move(u, x, z, step);
        constrain(u);
    }
    function travel(u, target, step) {
        u.moveTarget = { ...target }; u.waitState = 'travel';
        outsideMove(u, target.x, target.z, step);
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
        if (from.zone === 'outside') return false; // 墙外近战（含长枪）够不到墙上
        if (from.zone === 'wall') return to.zone === 'wall'; // 墙头只与爬上墙头的人对砍
        if (from.zone === 'inside') return to.zone === 'inside' && !(from.y > 0) && !(to.y > 0); // 下台阶途中不近战
        return false;
    }
    function rangeOf(u) { return u.fixed ? TOWER_RANGE : u.type === 'pikeman' ? 1.6 : u.typeData.range; }
    function breakGate() {
        assault.gate.broken = true; emit('gate_broken');
        const swords = assault.defenders.filter(u => !u.dead && !u.fixed && u.type === 'infantry')
            .sort((a, b) => distance(a, { x: 0, z: WALL_R }) - distance(b, { x: 0, z: WALL_R }));
        const chosen = swords.slice(0, Math.ceil(swords.length / 2)).sort((a, b) => a.x - b.x || a.id - b.id);
        const c = WALL_R - WALK_INSET;
        chosen.forEach((u, i) => {
            // 就地下踩台（渲染位置不变），再沿踩台内侧环道绕开帐篷/箭塔走到堵门线
            const sx = u.x < 0 ? -1 : 1, back = u.z < -Math.abs(u.x), front = u.z >= Math.abs(u.x);
            changeZone(u, 'inside'); startStepDown(u);
            u.blockX = (i - (chosen.length - 1) / 2) * .55;
            u.blockPath = [...back ? [{ x: sx * c, z: -c }] : [], ...front ? [] : [{ x: sx * c, z: c }],
                { x: u.blockX, z: c }, { x: u.blockX, z: BLOCK_Z }];
        });
        for (const u of assault.ram.crew) { u.crew = false; u.crewSlot = -1; }
        assault.ram.crew = []; assault.ram.state = 'spent';
    }
    function updateRam(dt) {
        const r = assault.ram;
        if (assault.gate.broken) { r.z = Math.min(RAM_REST, r.z + .9 * dt); return; }
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
            u.moveTarget = { x, z }; u.waitState = 'crew';
            outsideMove(u, x, z, u.speed * dt);
            if (Math.hypot(u.x - x, u.z - z) < .18) ready++;
        }
        if (r.crew.length < 2 || ready < 2) {
            r.state = 'waiting'; r.waitingMs += dt * 1000;
            if (r.waitingMs >= 8000) {
                // Outer soldiers turn first; inner soldiers retreat further before turning,
                // so their transverse leg cannot cut through the outer retreat leg.
                const fallback = assault.attackers.filter(u => !u.dead && u.zone === 'outside' &&
                    u.type !== 'archer' && u.route === 'gate').sort((a, b) => Math.abs(b.x) - Math.abs(a.x) || a.id - b.id);
                const ranks = [0, 0];
                for (const u of fallback) {
                    u.crew = false; u.crewSlot = -1;
                    u.route = u.x < 0 ? 0 : 1;
                    const l = assault.ladders[u.route], tail = [...l.queue, ...l.waiters];
                    const rank = ranks[u.route]++;
                    const outer = Math.max(16, ladderQueueSlot(l, tail.length + 2).z) + rank * LADDER_QUEUE_SPACING;
                    // 同排多人各取一个转身点（按 rank 外移一个身位），避免争抢同一点互相顶开
                    const exitX = Math.sign(l.x) * (Math.max(3.9, Math.abs(u.x)) + rank * LADDER_QUEUE_SPACING);
                    u.fallback = [{ x: exitX, z: u.z }, { x: exitX, z: outer },
                        { x: l.x + Math.sign(l.x) * .8, z: outer }];
                    l.waiters.push(u);
                }
                r.crew = []; r.state = 'abandoned'; emit('ram_abandoned');
            }
            return;
        }
        r.waitingMs = 0;
        if (r.z > RAM_HIT) {
            const step = Math.min(r.z - RAM_HIT, .48 * dt);
            r.z -= step;
            for (const u of r.crew) if (distance(u, r) < 1.6) u.z -= step;
            r.state = 'advancing'; return;
        }
        r.state = 'hitting'; r.cooldown -= dt * 1000;
        if (r.cooldown <= 0) {
            assault.gate.hp--; emit('ram_hit', { hp: assault.gate.hp });
            r.cooldown = RAM_IMPACT_MS * randomBetween(.9, 1.1);
            if (assault.gate.hp === 0) breakGate();
        }
    }
    function advanceFormations(dt) {
        for (const f of assault.formations) {
            if (f.released || assault.elapsedMs <= f.departMs) continue;
            const living = f.units.filter(u => !u.dead && !u.crew && !u.fallback?.length); // 已改走侧翼的不随阵前推
            const melee = living.filter(u => u.type !== 'archer');
            if (!melee.length || melee.some(u => radius(u) <= WALL_R + 4.6)) { f.released = true; continue; }
            const step = f.speed * Math.min(dt, (assault.elapsedMs - f.departMs) / 1000);
            f.x += f.dx * step; f.z += f.dz * step;
            for (const u of living) {
                // An archer already on its reserved firing post has left formation travel.
                if (atFireSlot(u)) continue;
                u.moveTarget = { x: u.x + f.dx * 30, z: u.z + f.dz * 30 }; u.waitState = 'travel';
                u.x += f.dx * step; u.z += f.dz * step; constrain(u);
            }
        }
    }
    function advanceAttacker(u, dt) {
        if (u.crew) { u.waitState = 'crew'; return; }
        if (!assault.formations[u.formation].released && !u.fallback?.length) return;
        const step = u.speed * dt;
        if (u.zone === 'ladder') {
            u.waitState = 'climbing';
            const l = assault.ladders[u.route];
            // 翻墙段按实际渲染位置让位：下一步离同层守军（墙上或正下台阶）不足一个身位时停在栅栏外沿，等守军让开
            const next = Math.min(1600, u.climbMs + dt * 1000), nk = next / 1600;
            const ahead = { ...u, x: l.x + (l.topX - l.x) * nk, z: l.z + (l.topZ - l.z) * nk, y: nk };
            const [px, pz] = viewPoint(ahead);
            const clear = nk <= LADDER_LIP || assault.defenders.every(d => {
                if (!bodyPartners(ahead, d)) return true;
                const [dx, dz] = viewPoint(d);
                return Math.hypot(dx - px, dz - pz) >= BODY_GAP + .01;
            });
            u.climbMs = clear ? next : Math.max(u.climbMs, Math.min(next, 1600 * LADDER_LIP));
            const k = u.climbMs / 1600;
            u.x = l.x + (l.topX - l.x) * k; u.z = l.z + (l.topZ - l.z) * k; u.y = k;
            if (k === 1) { changeZone(u, 'wall'); u.wallMs = 0; }
            return;
        }
        if (u.zone === 'wall') {
            u.waitState = 'climbing';
            const l = assault.ladders[u.route];
            u.wallMs += dt * 1000;
            if (u.wallMs >= 1000 && !nearest(assault.defenders, u, 1, d => d.zone === 'wall')) {
                changeZone(u, 'inside', 'ladder'); startStepDown(u);
                if (l.climber === u) l.climber = null;
            }
            return;
        }
        if (stepDown(u, dt)) { u.waitState = 'climbing'; return; }
        if (u.zone === 'inside') {
            const enemy = nearest(assault.defenders, u, 2.8, d => d.zone === 'inside');
            u.moveTarget = enemy ? { x: enemy.x, z: enemy.z } : { x: 0, z: 0 };
            if (enemy && distance(u, enemy) <= rangeOf(u) * .85 || !enemy && Math.hypot(u.x, u.z) < FLAG_RADIUS - .2) {
                u.waitState = 'staging'; return;
            }
            u.waitState = 'travel';
            move(u, u.moveTarget.x, u.moveTarget.z, step); constrain(u); return;
        }
        if (u.type === 'archer') {
            travel(u, u.fireSlot, step);
            if (distance(u, u.fireSlot) <= .04) u.waitState = 'firing';
            return;
        }
        if (typeof u.route === 'number') {
            const l = assault.ladders[u.route];
            const members = [...l.queue, ...l.waiters];
            let index = members.indexOf(u);
            if (index < 0) { l.waiters.push(u); index = members.length; }
            const target = ladderSlot(l, index);
            if (u.fallback?.length) {
                travel(u, u.fallback[0], step);
                if (distance(u, u.fallback[0]) < .04) {
                    const p = u.fallback.shift(); u.x = p.x; u.z = p.z;
                }
                return;
            }
            travel(u, target, step);
            if (distance(u, target) <= .04) u.waitState = 'queued';
            if (index === 0 && !l.climber && distance(u, l) < .04) {
                l.queue.shift(); if (l.waiters.length) l.queue.push(l.waiters.shift());
                l.climber = u; changeZone(u, 'ladder'); u.climbMs = 0; u.x = l.x; u.z = l.z;
                u.waitState = 'climbing';
            }
            return;
        }
        // A broken gate is the only ground-level transition. Enter at the mouth, never through a wall.
        if (assault.gate.broken && Math.abs(u.x) <= 1 && u.z >= MELEE_STOP_R && u.z <= MELEE_STOP_R + 1e-6) {
            changeZone(u, 'inside', 'gate'); u.z = (MELEE_STOP_R - .01); return;
        }
        const lane = (u.x < 0 ? -1 : 1) * .86;
        const target = assault.gate.broken ? { x: lane, z: MELEE_STOP_R } : gateWaitSlot(u.waitSide, u.gateSlot);
        travel(u, target, step);
        if (!assault.gate.broken && distance(u, target) <= .04) u.waitState = 'staging';
    }
    function ladderSlot(l, index) {
        // Keep the occupied climb path free by waiting at the next explicit slot.
        return ladderQueueSlot(l, index + (l.climber ? 1 : 0));
    }
    function inLadderQueue(u) {
        const l = assault.ladders[u.route];
        return l && u.waitState === 'queued' && distance(u, u.moveTarget) <= .04;
    }
    function updateLadderQueues() {
        for (const [route, l] of assault.ladders.entries()) {
            // Retreat keeps ownership until the occupant actually leaves the ladder.
            if (l.climber?.dead || l.climber && !(l.climber.zone === 'ladder' || l.climber.zone === 'wall' && !assault.retreated))
                l.climber = null;
            const valid = u => !u.dead && !u.crew && u.zone === 'outside' && u.route === route &&
                !assault.retreated;
            const members = [...l.queue, ...l.waiters].filter(valid);
            l.queue = members.slice(0, l.slots.length);
            l.waiters = members.slice(l.slots.length);
        }
    }
    function atFireSlot(u) {
        return u.type === 'archer' && u.zone === 'outside' && u.waitState === 'firing' && distance(u, u.fireSlot) <= .04;
    }
    function fixedAttacker(u) {
        return u.zone === 'ladder' || u.zone === 'wall' || inLadderQueue(u) || atFireSlot(u);
    }
    function separateAttackers(units, origin = null, dt = 0) {
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
                const fixedA = fixedAttacker(a) || (a.crew && !b.crew);
                const fixedB = fixedAttacker(b) || (b.crew && !a.crew);
                if (fixedA && fixedB) continue;
                let d = Math.sqrt(sq);
                if (d < 1e-9) { dx = 1; dz = 0; d = 1; }
                const push = .48 - Math.sqrt(sq), nx = dx / d, nz = dz / d;
                const shareA = .5;
                if (!fixedA) { const k = fixedB ? 1 : shareA; a.x -= nx * push * k; a.z -= nz * push * k; constrain(a); }
                if (!fixedB) { const k = fixedA ? 1 : 1 - shareA; b.x += nx * push * k; b.z += nz * push * k; constrain(b); }
            }
            if (!overlaps) break;
        }
        // Projection against two perpendicular obstacles can trap a residual overlap. Resolve only
        // those cases against the already placed units; immutable ladder occupants go first.
        const ordered = [...units].sort((a, b) =>
            Number(fixedAttacker(b)) - Number(fixedAttacker(a)));
        const placed = [];
        for (const u of ordered) {
            const clear = () => placed.every(v => (u.x - v.x) ** 2 + (u.z - v.z) ** 2 >= .32 ** 2);
            if (!clear() && !fixedAttacker(u)) {
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
        // 本帧总位移（移动 + 推挤）不超过 2 x speed x dt：人群里是挤开而不是瞬移
        if (origin) for (const u of units) {
            const o = origin.get(u);
            if (!o || fixedAttacker(u)) continue;
            const [x, z] = o, d = Math.hypot(u.x - x, u.z - z), cap = 2 * u.speed * dt + .015;
            if (d > cap) { u.x = x + (u.x - x) * cap / d; u.z = z + (u.z - z) * cap / d; constrain(u); }
        }
    }
    function updateDefenders(dt) {
        const tops = assault.ladders.filter(l => l.climber && !l.climber.dead).map(l => ({ x: l.topX, z: l.topZ, ladder: true }));
        const threats = [...tops];
        if (assault.ram.state === 'hitting') threats.push({ x: 0, z: WALL_R });
        const guards = assault.defenders.filter(d => !d.dead && !d.fixed && d.zone === 'wall');
        const assignments = new Map(), per = 8 * WALL_R;
        const along = (from, to) => ((to - from + per * 1.5) % per) - per / 2;
        for (const t of threats) {
            const center = wallParamToward(t.x, t.z);
            const chosen = guards.filter(d => !assignments.has(d))
                .sort((a, b) => distance(a, t) - distance(b, t) || a.id - b.id).slice(0, 3);
            const side = d => along(center, wallParamToward(d.x, d.z));
            chosen.sort((a, b) => side(a) - side(b) || a.homeT - b.homeT);
            // 梯顶有攻方：守军按所在侧分站梯顶两侧、隔一个身位对砍，不站到攻方身上
            const left = chosen.filter(d => side(d) < 0).length;
            const offsets = !t.ladder ? chosen.map((_, i) => (i - (chosen.length - 1) / 2) * .6) :
                chosen.length === 1 ? [side(chosen[0]) < 0 ? -.6 : .6] :
                    chosen.length === 2 ? [-.6, .6] : left >= 2 ? [-1.2, -.6, .6] : [-.6, .6, 1.2];
            chosen.forEach((d, i) => assignments.set(d, center + offsets[i]));
        }
        // Reserve unassigned posts first. Guards walk at most one step along the wall and never
        // step closer than .5 to another guard or an occupied ladder top (no hopping past anyone);
        // .5 on the logical wall leaves at least .45 between the inset walkway positions.
        for (const d of [...guards].sort((a, b) => Number(assignments.has(a)) - Number(assignments.has(b)) || a.id - b.id)) {
            const have = wallParamToward(d.x, d.z), diff = along(have, assignments.get(d) ?? d.homeT);
            if (Math.abs(diff) < 1e-12) continue;
            const others = [...guards.filter(v => v !== d && !v.dead && v.zone === 'wall'), ...tops];
            // 翻墙段的攀爬者、刚下台阶的人与墙上守军同层，按渲染位置让出一个身位
            const near = [...assault.attackers, ...assault.defenders].filter(v => v.zone !== 'wall' && bodyPartners(d, v))
                .map(viewPoint);
            const dv = inwardPoint(d.x, d.z);
            const ok = p => {
                const pv = inwardPoint(p[0], p[1]);
                return others.every(v => {
                    const n = Math.hypot(p[0] - v.x, p[1] - v.z);
                    return n >= .5 + 1e-9 || n >= Math.hypot(d.x - v.x, d.z - v.z) - 1e-9;
                }) && near.every(([vx, vz]) => {
                    const n = Math.hypot(pv[0] - vx, pv[1] - vz);
                    return n >= BODY_GAP + .01 || n >= Math.hypot(dv[0] - vx, dv[1] - vz) - 1e-9;
                });
            };
            for (let f = 1; f > 0; f -= .25) {
                const p = wallPoint(have + Math.sign(diff) * Math.min(Math.abs(diff), d.speed * dt) * f);
                if (ok(p)) { [d.x, d.z] = p; break; }
            }
        }
        for (const d of assault.defenders) {
            if (d.dead) continue;
            const enemy = nearest(assault.attackers, d);
            if (stepDown(d, dt)) {
                // 下台阶途中不追敌、不走环道
            } else if (d.zone === 'inside' && d.blockPath?.length) {
                move(d, d.blockPath[0].x, d.blockPath[0].z, d.speed * dt);
                if (distance(d, d.blockPath[0]) < .04) d.blockPath.shift();
                constrain(d);
            } else if (d.zone === 'inside') {
                const target = nearest(assault.attackers, d, 3, u => u.zone === 'inside');
                if (!target || distance(d, target) > rangeOf(d) * .8)
                    move(d, target ? target.x : d.blockX, target ? target.z : BLOCK_Z, d.speed * dt);
                constrain(d);
            }
            if (enemy) d.yaw = Math.atan2(enemy.x - d.x, enemy.z - d.z);
        }
    }
    function strike(from, to) {
        const multiplier = from.team === 'red' ? CAMP_RULES.WALL_GUARD_ATTACK *
            (from.zone === 'inside' ? GATE_BLOCKER_ATTACK : 1) : 1;
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
    // 净权重对冲夺旗（对齐 2D updateFlags）：旗心半径内按兵种占领力累加，
    // 净力决定进度方向与速度；不计阵亡、箭塔守军（u.fixed）、冲车推车兵。
    function flagPower(u) {
        if (u.dead || u.crew || u.fixed) return 0;
        return Math.hypot(u.x, u.z) > FLAG_RADIUS ? 0 : (FLAG_WEIGHT[u.type] ?? 5);
    }
    function updateFlag(ms) {
        let atk = 0, def = 0;
        for (const u of assault.attackers) atk += flagPower(u);
        for (const u of assault.defenders) def += flagPower(u);
        assault.flagAtk = atk; assault.flagNet = atk - def;
        if (assault.flagNet !== 0)
            assault.flagProgress = Math.max(-1, Math.min(1,
                assault.flagProgress + assault.flagNet * FLAG_RATE * (ms / 1000)));
    }
    function updateVictory(ms) {
        const living = assault.attackers.filter(u => !u.dead);
        if (!living.length) { assault.result = 'hold'; return; }
        updateFlag(ms);
        if (assault.flagProgress >= 1) { assault.flagProgress = 1; assault.result = 'break'; emit('flag_captured'); return; }
        // A small assault preserves a withdrawal reserve; larger formations can absorb
        // proportionally more losses before giving up a still-closed gate.
        const retreatAt = Math.max(Math.min(RETREAT_RESERVE, assault.attackers.length * RETREAT_MAX_RESERVE_FRACTION),
            assault.attackers.length * RETREAT_SURVIVOR_FRACTION);
        if (living.length <= retreatAt && !assault.gate.broken &&
            !living.some(u => u.zone === 'wall' || u.zone === 'inside')) {
            assault.retreated = true; assault.retreatMs = 0; assault.flagProgress = -1; assault.flagNet = 0; assault.flagAtk = 0;
            updateLadderQueues(); emit('retreat');
        }
    }
    // One call is exactly one logical tick. Frame accumulation belongs to the presentation layer.
    function stepAssault(ms = ASSAULT_STEP_MS) {
        if (Math.abs(ms - ASSAULT_STEP_MS) > 1e-6) throw new RangeError('Assault requires a fixed 1/60s tick');
        if (!assault.active || assault.result !== null) return [];
        assault.events = []; assault.elapsedMs += ms;
        const dt = ms / 1000;
        const origin = frameOrigin = new Map([...assault.attackers, ...assault.defenders].filter(u => !u.dead && !u.fixed).map(u => [u, [u.x, u.z]]));
        updateLadderQueues();
        if (assault.retreated) {
            for (const u of assault.attackers) if (!u.dead) {
                if (u.zone === 'ladder') {
                    // 顺梯子爬回梯脚再后撤，不瞬移
                    const l = assault.ladders[u.route];
                    u.climbMs = Math.max(0, u.climbMs - dt * 1000);
                    const k = u.climbMs / 1600;
                    u.x = l.x + (l.topX - l.x) * k; u.z = l.z + (l.topZ - l.z) * k; u.y = k;
                    if (k > 0) { u.waitState = 'retreat'; continue; }
                    changeZone(u, 'outside'); u.y = 0;
                }
                u.waitState = 'retreat';
                const formation = assault.formations[u.formation];
                move(u, u.x - formation.dx, u.z - formation.dz, u.speed * dt);
                constrain(u);
            }
            separateAttackers(assault.attackers.filter(u => !u.dead), origin, dt);
            updateDefenders(dt);
            fight(assault.defenders, assault.attackers, ms);
            assault.retreatMs += ms;
            if (assault.retreatMs >= 3000) assault.result = 'hold';
            limitDuration();
            assault.phase = '溃退'; return assault.events;
        }
        advanceFormations(dt); updateRam(dt); updateLadderQueues();
        for (const u of assault.attackers) if (!u.dead) advanceAttacker(u, dt);
        separateAttackers(assault.attackers.filter(u => !u.dead), origin, dt);
        // Collision projection runs after movement. Waiting describes the final
        // physical position, never just a reservation or an earlier arrival.
        for (const u of assault.attackers) if (!u.dead && u.zone === 'outside' &&
            ['staging', 'queued', 'firing'].includes(u.waitState) && distance(u, u.moveTarget) > .04)
            u.waitState = 'travel';
        updateDefenders(dt);
        // 寨内敌我同层，守军移动后再分离一次，保证敌我不重叠
        separateAttackers([...assault.attackers, ...assault.defenders].filter(u => !u.dead && u.zone === 'inside'), origin, dt);
        fight(assault.attackers, assault.defenders, ms); fight(assault.defenders, assault.attackers, ms);
        updateVictory(ms);
        limitDuration();
        assault.phase = assault.retreated ? '溃退' : assault.flagAtk > 0 || assault.flagProgress > -1 ? '夺旗中' :
            assault.gate.broken ? '破门涌入' :
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
