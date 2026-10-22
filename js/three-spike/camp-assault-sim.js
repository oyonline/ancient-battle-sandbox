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
// 踩台让行道：墙上的人可换到内道(+1)/外道(-1)，在踩台中线上沿墙面法向（角部平滑过渡）各偏 LANE_W；
// 内外道相距 .6。去木梯的人走外道（墙角处外道放宽、内道收窄），临近梯顶才换到内道起爬；被让行的守军
// 让到与去梯者相反的一道，红方之间由此在单人宽的踩台上错身而过
export const LANE_W = .3, LANE_RATE = 3;
// 渲染坐标（camp.js 与测试共用）：k=1 为踩台位置（墙线径向内缩 WALK_INSET）
export function inwardPoint(x, z, k = 1) {
    const l = Math.hypot(x, z) || 1;
    return [x - x / l * WALK_INSET * k, z - z / l * WALK_INSET * k];
}
// 踩台上第 lane 道的渲染位置：踩台中线 + 指向寨内的平滑墙面法向 × lane × LANE_W（lane 0 即原踩台位置）
export function wallView(x, z, lane = 0) {
    const [bx, bz] = inwardPoint(x, z);
    if (!lane) return [bx, bz];
    const ax = Math.abs(x / WALL_R) ** 32, az = Math.abs(z / WALL_R) ** 32, l = Math.hypot(ax, az) || 1;   // 只在墙角附近转向
    return [bx - Math.sign(x) * ax / l * lane * LANE_W, bz - Math.sign(z) * az / l * lane * LANE_W];
}
export function viewPoint(u) {
    if (u.zone === 'wall') return wallView(u.x, u.z, u.lane || 0);
    return inwardPoint(u.x, u.z, u.zone === 'ladder' ? Math.max(0, (u.y - LADDER_LIP) / (1 - LADDER_LIP)) : 0);
}
// 攀爬区：攻城梯 / 寨内木梯 / 箭塔竖梯。途中不近战、不被近战（弓箭照射）
export const CLIMB_ZONES = new Set(['ladder', 'iladder', 'tladder']);
// 身位口径（R3）：敌我之间、红方之间，同一高度层才互相占位；梯上只算翻墙段（y>=LADDER_LIP，按墙头高度比较）；
// 箭塔弓手只与爬上同一座塔（塔顶或塔梯）的攻方互相占位
export const BODY_GAP = .45;
const bodyHeight = u => u.zone === 'ladder' ? 1 : u.y;
export function bodyPartners(a, b) {
    if (a === b || a.dead || b.dead || a.team === 'blue' && b.team === 'blue') return false;
    if (a.fixed || b.fixed) {
        const [f, o] = a.fixed ? [a, b] : [b, a];
        if (o.fixed || o.team !== 'blue' || f.tower == null || o.tower !== f.tower || o.zone !== 'tower' && o.zone !== 'tladder') return false;
    }
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
// 攻城梯 ×8：门面 4 架（±4.5 / ±6.2）、西墙 2 架、东墙 2 架，北面不搭；0–3 号沿用原位
export const LADDERS = [
    { x: -4.5, z: WALL_R + .62, topX: -4.5, topZ: WALL_R, nx: 0, nz: 1 },
    { x: 4.5, z: WALL_R + .62, topX: 4.5, topZ: WALL_R, nx: 0, nz: 1 },
    { x: -WALL_R - .62, z: 2, topX: -WALL_R, topZ: 2, nx: -1, nz: 0 },
    { x: WALL_R + .62, z: 2, topX: WALL_R, topZ: 2, nx: 1, nz: 0 },
    { x: -6.2, z: WALL_R + .62, topX: -6.2, topZ: WALL_R, nx: 0, nz: 1 },
    { x: 6.2, z: WALL_R + .62, topX: 6.2, topZ: WALL_R, nx: 0, nz: 1 },
    { x: -WALL_R - .62, z: -2.5, topX: -WALL_R, topZ: -2.5, nx: -1, nz: 0 },
    { x: WALL_R + .62, z: -2.5, topX: WALL_R, topZ: -2.5, nx: 1, nz: 0 }
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

// 门队 + 8 个梯队：门队 46%，其余均分到 8 架梯子（余数先给 0、1… 号）
export function formationSizes(meleeTotal) {
    const teams = LADDERS.length;
    if (!Number.isInteger(meleeTotal) || meleeTotal < 4 + teams) throw new RangeError('Four crew and eight ladder teams require >=12 melee');
    const gate = Math.round(meleeTotal * .46), rest = meleeTotal - gate;
    const sizes = [gate, ...LADDERS.map((_, i) => Math.floor(rest / teams) + (i < rest % teams ? 1 : 0))];
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
// 墙面编号与 wallPoint 参数段一致：0 北(z=-r) 1 东(x=+r) 2 南(z=+r，寨门) 3 西(x=-r)；按切比雪夫距离归面
export const WALL_FACE_MS = 2000;                  // 墙上守军按威胁分面的重算周期（模拟时间）
export function wallFace(x, z) {
    return Math.abs(z) >= Math.abs(x) ? (z < 0 ? 0 : 2) : (x > 0 ? 1 : 3);
}
export function wallParamToward(x, z) {
    const r = WALL_R, side = 2 * r;
    const m = Math.max(Math.abs(x), Math.abs(z));
    if (m < 1e-6) return 0;
    const ex = x / m * r, ey = z / m * r;
    if (Math.abs(ex) >= Math.abs(ey)) return ex > 0 ? side + (ey + r) : 3 * side + (r - ey);
    return ey < 0 ? ex + r : 2 * side + (r - ex);
}
// 沿墙环的有向参数差（取最短方向，范围 ±周长/2）
export function alongT(from, to) {
    const per = 8 * WALL_R;
    return ((to - from + per * 1.5) % per) - per / 2;
}

// ---- 寨内木梯：每面墙内侧 2 架（共 8 架），渲染与测试共用这一份位置 ----
// 梯顶抵住踩台内沿、梯脚落在寨内地面（离踩台内沿 .55）；攀爬者从踩台内道（lane +1）的梯顶点
// 顺梯子直下到梯脚站位。上下同速：高度 0↔1.0 线性变化，约 1.2 秒。
export const CLIMB_RATE = 1 / 1.2;                 // 竖直攀爬速度（高度/秒）；箭塔竖梯同速（2.56 约 3.1 秒）
export const INNER_RAIL_TOP_R = WALL_R - WALK_INSET - .3;   // 踩台内沿 6.15
export const INNER_RAIL_FOOT_R = INNER_RAIL_TOP_R - .55;    // 梯脚 5.6
export const INNER_STAND_R = INNER_RAIL_FOOT_R - .2;        // 梯脚站位 5.4
export const TOP_QUEUE_SPACING = .55;              // 梯顶沿踩台排队间距（内道径向收缩后渲染间距仍 > .45）
export const CLIMB_QUEUE_CAPACITY = 4;             // 木梯/塔梯每端（梯顶每侧）显式排队槽位数；满了的人原地等候
export const GRANT_PATIENCE_MS = 3000;             // 轮到上梯的人连续这么久没朝起爬点前进：交还使用权、暂避这架梯子重新排队
export const MATE_GAP = .32;                       // 踩台/梯顶上攻方之间的渲染间距（不叠人；错身走内外道）
export const INNER_LADDERS = [[2.8, WALL_R], [-2.8, WALL_R], [WALL_R, .9], [WALL_R, -.9],
    [2.8, -WALL_R], [-2.8, -WALL_R], [-WALL_R, .9], [-WALL_R, -.9]].map(([wx, wz], id) => {
    const [topX, topZ] = wallView(wx, wz, 1);
    const ns = Math.abs(wz) > Math.abs(wx), a = ns ? topX : topZ;   // a：沿墙坐标
    const nx = ns ? 0 : Math.sign(wx), nz = ns ? Math.sign(wz) : 0;
    const at = r => ns ? { x: a, z: nz * r } : { x: nx * r, z: a };
    const stand = at(INNER_STAND_R);
    // 梯脚排队沿墙朝本面角部方向延伸（不进帐篷、不挡门洞）
    return { id, wx, wz, tTop: wallParamToward(wx, wz), topX, topZ, x: stand.x, z: stand.z, nx, nz,
        qx: ns ? Math.sign(a) : 0, qz: ns ? 0 : Math.sign(a), railFoot: at(INNER_RAIL_FOOT_R), railTop: at(INNER_RAIL_TOP_R) };
});
export function innerFootSlot(l, i) {
    return { x: l.x + l.qx * (i + 1) * LADDER_QUEUE_SPACING, z: l.z + l.qz * (i + 1) * LADDER_QUEUE_SPACING };
}
export function innerTopSlot(l, side, i) { return l.tTop + side * (i + 1) * TOP_QUEUE_SPACING; }
// ---- 箭塔竖梯：模拟可攀爬，规则同寨内木梯；塔顶除 4 名弓手外最多再站 2 名攻方 ----
export const TOWER_Y = 2.56, TOWER_TOP_CAP = 2;
export const TOWER_LADDER_DX = -.716;              // 竖梯贴塔 -x 面（camp.js ladX = -.72×0.8），攀爬站位再外 .14
export const TOWER_YIELD_Z = .5;                   // 有攻方登塔时，-x 侧两名弓手横向让开到 ±.5，让出塔顶通道
export const ARCHER_MELEE_FACTOR = .5;             // 被贴身的塔上弓手近战还手：弓手攻击力 ×0.5
export const HUNTER_SHARE = 1 / 3;                 // 夺旗模式：旗心无可打守军时，最多分出 1/3 寨内近战去打弓手
export const TOWER_LADDERS = TOWER_ORIGINS.map((o, tower) => ({ tower, ox: o.x, oz: o.z, x: o.x + TOWER_LADDER_DX, z: o.z,
    qx: 0, qz: o.z > 0 ? -1 : 1, spots: [{ x: o.x, z: o.z }, { x: o.x - .55, z: o.z }] }));
export function towerFootSlot(t, i) {
    return { x: t.x + t.qx * (i + 1) * LADDER_QUEUE_SPACING, z: t.z + t.qz * (i + 1) * LADDER_QUEUE_SPACING };
}


export function createAssaultSim({ towerPositions = DEFAULT_TOWERS } = {}) {
    const assault = {};
    let random = mulberry32(1), nextId = 0;
    const randomBetween = (lo, hi) => lo + random() * (hi - lo);
    const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
    const radius = u => Math.max(Math.abs(u.x), Math.abs(u.z));
    const wallT = u => wallParamToward(u.x, u.z);
    const emit = (type, details = {}) => assault.events.push({ type, at: assault.elapsedMs, ...details });
    function resetAssault() {
        Object.assign(assault, { active: false, mode: 'flag', attackers: [], defenders: [], formations: [], events: [],
            acc: 0, elapsedMs: 0, result: null, phase: '列阵推进', flagProgress: -1, flagNet: 0, flagAtk: 0, retreatMs: 0,
            retreated: false, holdReason: null, faceAt: 0, gate: { hp: 6, maxHp: 6, broken: false },
            ram: { x: 0, z: RAM_REST, hp: Infinity, crew: [], state: 'waiting', waitingMs: 0, cooldown: RAM_IMPACT_MS },
            ladders: LADDERS.map(p => ({ ...p, climber: null, queue: [], waiters: [],
                slots: Array.from({ length: ladderQueueCapacity(p) }, (_, i) => ladderQueueSlot(p, i)) })),
            // 寨内木梯 / 箭塔竖梯：climber 正在梯上的人；grant 已轮到、正走向起爬点的人；queue 显式排队
            inner: INNER_LADDERS.map(p => ({ ...p, climber: null, grant: null, queue: [] })),
            towerLadders: TOWER_LADDERS.map(p => ({ ...p, climber: null, grant: null, queue: [], occ: [null, null] })),
            seq: 0 });
        nextId = 0;
    }
    function makeUnit(team, type, x, z, yaw) {
        const typeData = UNIT_TYPES[type];
        return { id: nextId++, team, role: team === 'blue' ? 'attack' : 'defend', type, typeData, x, z, yaw,
            spawnX: x, spawnZ: z, y: 0, zone: team === 'blue' ? 'outside' : 'wall',
            hp: typeData.hp, maxHp: typeData.hp, cd: typeData.atkSpeed * randomBetween(.2, 1),
            speed: typeData.speed * randomBetween(.9, 1.1), dead: false, target: null,
            waitState: 'travel', moveTarget: null, enteredVia: null, climbMs: 0, wallMs: 0, crew: false, crewSlot: -1,
            lane: 0, laneFrom: 0, wallDir: 0, passLane: 0, passUntil: -Infinity, grantBest: Infinity, grantSince: 0, avoid: null, leftTop: false, iq: null, climb: null, tower: null, spot: -1, hunter: false, goalId: null, task: null,
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
    // mode：'flag' 夺旗（默认，旗帜拉锯定胜负）/ 'deathmatch' 死斗（守军全灭破寨，不计旗帜）
    function startAssault(preset = 'company', defCount = 6, seed = 1, mode = 'flag') {
        resetAssault(); random = mulberry32(seed); assault.preset = preset;
        assault.mode = mode === 'deathmatch' ? 'deathmatch' : 'flag';
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
            const route = id ? id - 1 : 'gate', l = id ? LADDERS[route] : null, side = l && !l.nz;
            const f = { id, name: id ? `L${route}` : 'G', route,
                x: side ? l.nx * 16 : id ? l.x : 0, z: side ? l.z : 16,
                dx: side ? -l.nx : 0, dz: side ? 0 : -1,
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
        for (const p of towerPositions) {
            // 只有落在模拟箭塔（TOWER_ORIGINS）平台上的弓手才可被登塔；自定义塔位不可攀爬
            const t = TOWER_ORIGINS.findIndex(o => Math.abs(p.x - o.x) <= TOWER_HALF && Math.abs(p.z - o.z) <= TOWER_HALF);
            assault.defenders.push({ ...makeUnit('red', 'archer', p.x, p.z, p.yaw ?? 0), zone: 'tower', y: TOWER_Y, fixed: true,
                tower: t < 0 ? null : t });
        }
        assault.active = true; return assault;
    }
    function move(u, x, z, step) {
        const dx = x - u.x, dz = z - u.z, d = Math.hypot(dx, dz);
        if (d < 1e-9) return;
        const k = Math.min(1, step / d);
        u.x += dx * k; u.z += dz * k; u.yaw = Math.atan2(dx, dz);
    }
    // 寨内地面绕帐篷：直线会穿过帐篷（含避让边距）时，先走向该帐篷外扩一圈的可直达角点
    function segHitsBox(a, b, t, h) {
        let lo = 0, hi = 1;
        for (const [p, d, c] of [[a.x, b.x - a.x, t.x], [a.z, b.z - a.z, t.z]]) {
            if (Math.abs(d) < 1e-12) { if (p <= c - h || p >= c + h) return false; continue; }
            let t0 = (c - h - p) / d, t1 = (c + h - p) / d;
            if (t0 > t1) [t0, t1] = [t1, t0];
            lo = Math.max(lo, t0); hi = Math.min(hi, t1);
            if (lo >= hi) return false;
        }
        return true;
    }
    function steer(u, target) {
        let block = null, enter = Infinity;
        for (const t of TENTS) {
            const h = t.half + .16 - 1e-6;
            if (!segHitsBox(u, target, t, h)) continue;
            const d = Math.hypot(t.x - u.x, t.z - u.z);
            if (d < enter) { enter = d; block = t; }
        }
        if (!block) return target;
        const h = block.half + .16 - 1e-6, H = block.half + .16 + .3;
        let best = null, bestCost = Infinity;
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            const c = { x: block.x + sx * H, z: block.z + sz * H };
            if (Math.hypot(c.x - u.x, c.z - u.z) < .05 || segHitsBox(u, c, block, h)) continue;
            // 角点到目标仍被同一顶帐篷挡住时加罚，保证绕到能看见目标的那一角
            const cost = Math.hypot(c.x - u.x, c.z - u.z) + Math.hypot(target.x - c.x, target.z - c.z) +
                (segHitsBox(c, target, block, h) ? 100 : 0);
            if (cost < bestCost - 1e-9) { bestCost = cost; best = c; }
        }
        return best ?? target;
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
        if (CLIMB_ZONES.has(from.zone) || CLIMB_ZONES.has(to.zone)) return false; // 攀爬途中不近战、不被近战
        if (to.fixed) return from.zone === 'tower' && from.tower === to.tower; // 塔上近战只限同一座塔的塔顶
        if (from.zone === 'tower') return false;
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
        chosen.forEach((u, i) => {
            // 沿踩台走到最近的寨内木梯、顺梯子下到地面，再绕开帐篷走到堵门线
            u.task = 'down';
            u.blockX = (i - (chosen.length - 1) / 2) * .55;
            u.blockPath = [{ x: u.blockX, z: BLOCK_Z }];
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
    // ==================== 寨内木梯 / 箭塔竖梯：显式排队、一次一人、双向 ====================
    // u.iq = { kind: 'inner'|'tower', li, end: 'top'|'foot', side, seq }：排队登记（纯数据，便于逐帧比对）
    const queueOf = u => !u.iq ? null : u.iq.kind === 'inner' ? assault.inner[u.iq.li] : assault.towerLadders[u.iq.li];
    function leaveQueue(u) {
        const l = queueOf(u);
        if (!l) return;
        l.queue = l.queue.filter(v => v !== u);
        if (l.grant === u) l.grant = null;
        u.iq = null;
    }
    function enqueue(u, l, kind, end, side = 0) {
        if (l.queue.filter(v => v.iq.end === end && v.iq.side === side).length >= CLIMB_QUEUE_CAPACITY) return false;
        u.iq = { kind, li: kind === 'inner' ? l.id : l.tower, end, side, seq: assault.seq++ };
        l.queue.push(u);
        return true;
    }
    // 选木梯：取最近的两架；两架都在用（有人在梯上/轮到/排队）时选排队人数少的，人数一样选近的。
    // 踩台上去梯顶时，路上隔着别架梯子正在排队/已轮到的人（单人宽踩台过不去）的那架不选；
    // 刚因被堵交还过使用权的那架暂避（多半改走另一个方向）
    function joinInner(u, end) {
        const cost = l => end === 'top' ? Math.abs(alongT(wallT(u), l.tTop)) : Math.hypot(u.x - l.x, u.z - l.z);
        const reachable = l => {
            if (end !== 'top') return true;
            const span = alongT(wallT(u), l.tTop), dir = Math.sign(span);
            return ![...assault.attackers, ...assault.defenders].some(v => v !== u && !v.dead && v.zone === 'wall' &&
                v.iq?.kind === 'inner' && v.iq.li !== l.id && (() => {
                    const d = alongT(wallT(u), wallT(v));
                    return Math.sign(d) === dir && Math.abs(d) < Math.abs(span) + TOP_QUEUE_SPACING;
                })());
        };
        const sorted = [...assault.inner].sort((p, q) => cost(p) - cost(q) || p.id - q.id);
        const avoided = l => u.avoid?.kind === 'inner' && u.avoid.li === l.id && assault.elapsedMs < u.avoid.until;
        const allowed = sorted.filter(l => !avoided(l));
        const usable = allowed.filter(reachable);
        const [a, b] = usable.length ? usable : allowed;
        const load = l => (l.climber || l.grant ? 1 : 0) + l.queue.length;
        const first = b && load(b) < load(a) ? b : a;
        // 首选那架这一侧槽位已满：按远近改排下一架有空位的（不在踩台上原地干等、堵住梯顶）
        const side = l => end === 'top' ? (alongT(l.tTop, wallT(u)) < 0 ? -1 : 1) : 0;
        for (const l of [first, ...(usable.length ? usable : allowed).filter(l => l !== first)])
            if (enqueue(u, l, 'inner', end, side(l))) return true;
        return false;
    }
    function joinTower(u, tower, end = 'foot') { return enqueue(u, assault.towerLadders[tower], 'tower', end); }
    // 排位：梯顶按离梯顶的踩台距离（单人宽踩台上不能互相越过），梯脚按到达先后
    function queueRank(u) {
        const l = queueOf(u), e = u.iq;
        if (e.kind === 'inner' && e.end === 'top') {
            const d = v => Math.abs(alongT(l.tTop, wallT(v)));
            const mine = d(u);
            return l.queue.filter(v => v !== u && v.iq.end === 'top' && v.iq.side === e.side &&
                (d(v) < mine - 1e-9 || Math.abs(d(v) - mine) <= 1e-9 && v.iq.seq < e.seq)).length;
        }
        return l.queue.filter(v => v !== u && v.iq.end === e.end && v.iq.seq < e.seq).length;
    }
    const towerTop = t => assault.attackers.filter(u => !u.dead && u.zone === 'tower' && u.tower === t.tower).length;
    function grantLadders() {
        for (const l of [...assault.inner, ...assault.towerLadders]) {
            const kind = l.tower == null ? 'inner' : 'tower', li = kind === 'inner' ? l.id : l.tower;
            const mine = u => !u.dead && u.iq?.kind === kind && u.iq.li === li;
            l.queue = l.queue.filter(mine);
            if (l.grant && !mine(l.grant)) l.grant = null;
            if (l.occ) l.occ = l.occ.map(v => v && !v.dead && v.zone === 'tower' ? v : null);
            if (l.climber && (l.climber.dead || !l.climber.climb)) l.climber = null;   // 梯上中箭阵亡：梯子空出
            if (l.grant) {
                // 使用权看门狗：持有人 GRANT_PATIENCE_MS 内没朝起爬点前进（被堵住）就交还使用权，暂避这架梯子重新排队
                const g = l.grant, d = grantDistance(g, l);
                if (d < g.grantBest - .05) { g.grantBest = d; g.grantSince = assault.elapsedMs; }
                else if (assault.elapsedMs - g.grantSince > GRANT_PATIENCE_MS) {
                    leaveQueue(g); g.avoid = { kind, li, until: assault.elapsedMs + 2 * GRANT_PATIENCE_MS };
                }
            }
            if (l.climber || l.grant || !l.queue.length) continue;
            let next;
            if (kind === 'inner') next = l.queue.filter(u => queueRank(u) === 0).sort((a, b) => a.iq.seq - b.iq.seq)[0];
            else {
                // 塔顶下撤优先（腾位）；登塔要求塔顶攻方未满 TOWER_TOP_CAP
                next = l.queue.filter(u => u.iq.end === 'top').sort((a, b) => a.iq.seq - b.iq.seq)[0];
                if (!next && towerTop(l) < TOWER_TOP_CAP) next = l.queue.filter(u => queueRank(u) === 0)[0];
            }
            if (!next) continue;
            l.grant = next; l.queue = l.queue.filter(v => v !== next);
            next.grantBest = grantDistance(next, l); next.grantSince = assault.elapsedMs;
        }
    }
    // 持有人到起爬点的剩余路程（梯顶：沿踩台距离 + 换到内道的差；梯脚/塔上：平面距离）
    function grantDistance(u, l) {
        if (u.iq.kind === 'inner' && u.iq.end === 'top') return Math.abs(alongT(wallT(u), l.tTop)) + Math.abs(1 - (u.lane || 0)) * LANE_W;
        return Math.hypot(u.x - l.x, u.z - l.z);
    }
    function startClimb(u) {
        const l = queueOf(u), e = u.iq;
        l.grant = null; l.climber = u; u.iq = null;
        if (e.kind === 'inner') {
            u.climb = { kind: 'inner', li: l.id, dir: e.end === 'top' ? -1 : 1 };
            if (e.end === 'top') { [u.x, u.z] = viewPoint(u); u.y = 1; } else { u.x = l.x; u.z = l.z; u.y = 0; }
            changeZone(u, 'iladder');
        } else {
            u.climb = { kind: 'tower', li: l.tower, dir: e.end === 'top' ? -1 : 1 };
            if (e.end === 'top') { if (l.occ[u.spot] === u) l.occ[u.spot] = null; u.spot = -1; }
            else { u.y = 0; u.tower = l.tower; }
            u.x = l.x; u.z = l.z;
            changeZone(u, 'tladder');
        }
        u.lane = 0; u.waitState = 'climbing';
    }
    // 向上爬到 y>.69 之前先确认梯顶点一个身位内没有同层的人，否则停在 .69（此时尚未与墙头同层）
    function innerTopClear(l, u) {
        const probe = { team: u.team, zone: 'wall', y: 1 };
        return [...assault.attackers, ...assault.defenders].every(v => v === u || !bodyPartners(probe, v) || (() => {
            const [vx, vz] = viewPoint(v);
            return Math.hypot(vx - l.topX, vz - l.topZ) >= BODY_GAP + .01;
        })()) && (u.team !== 'blue' || wallMates(u).every(([[vx, vz]]) => Math.hypot(vx - l.topX, vz - l.topZ) >= MATE_GAP));
    }
    function updateClimbers(dt) {
        for (const l of assault.inner) {
            const u = l.climber;
            if (!u || u.dead) continue;
            const dir = u.climb.dir;
            let y = dir < 0 ? Math.max(0, u.y - CLIMB_RATE * dt) : Math.min(1, u.y + CLIMB_RATE * dt);
            if (dir > 0 && u.y <= .69 && y > .69 && !innerTopClear(l, u)) y = .69;
            // 每一步都不得向同层的人（墙头或地面）靠近到一个身位以内，否则本帧停在梯上
            const nx = l.x + (l.topX - l.x) * y, nz = l.z + (l.topZ - l.z) * y;
            const probe = { team: u.team, zone: 'iladder', y };
            const blocked = [...assault.attackers, ...assault.defenders].some(v => {
                if (v === u || !bodyPartners(probe, v)) return false;
                const [vx, vz] = viewPoint(v), n = Math.hypot(nx - vx, nz - vz);
                return n < BODY_GAP + .01 && n < Math.hypot(u.x - vx, u.z - vz) - 1e-9;
            }) || u.team === 'blue' && y >= .7 && wallMates(u).some(([[vx, vz]]) => {
                const n = Math.hypot(nx - vx, nz - vz);
                return n < MATE_GAP && n < Math.hypot(u.x - vx, u.z - vz) - 1e-9;
            });
            if (blocked) continue;
            u.y = y; u.x = nx; u.z = nz;
            if (dir < 0 && y === 0) {
                u.climb = null; l.climber = null;
                changeZone(u, 'inside', u.team === 'blue' ? u.enteredVia ?? 'ladder' : null);
            } else if (dir > 0 && y === 1) {
                u.climb = null; l.climber = null;
                changeZone(u, 'wall'); u.x = l.wx; u.z = l.wz; u.lane = 1; u.leftTop = true; u.task = null;
            }
        }
        for (const l of assault.towerLadders) {
            const u = l.climber;
            if (!u || u.dead) continue;
            const dir = u.climb.dir;
            u.y = dir < 0 ? Math.max(0, u.y - CLIMB_RATE * dt) : Math.min(TOWER_Y, u.y + CLIMB_RATE * dt);
            if (dir < 0 && u.y === 0) {
                u.climb = null; l.climber = null; u.tower = null;
                changeZone(u, 'inside', u.enteredVia ?? 'ladder');
            } else if (dir > 0 && u.y === TOWER_Y) {
                u.climb = null; l.climber = null;
                u.spot = l.occ[0] ? 1 : 0; l.occ[u.spot] = u;
                changeZone(u, 'tower');
            }
        }
    }
    // 攻方同伴在墙头层的渲染位置：踩台上、攻城梯翻墙段、木梯上段（与墙头同高的人）
    // 攻城梯上快到梯顶（y >= .6）的人按他余下的翻墙路线（翻墙段起点或当前位置到梯顶落点，取 5 个点）算：
    // 提前让出这段路，他才能翻上来，踩台上的人也不会被夹在他和落点之间
    function wallMates(u) {
        return assault.attackers.filter(v => v !== u && !v.dead && (v.zone === 'wall' || v.zone === 'ladder' && v.y >= .6 ||
            v.zone === 'iladder' && v.y >= .7)).flatMap(v => {
            if (v.zone !== 'ladder') return [[viewPoint(v), v]];
            const l = assault.ladders[v.route], k0 = Math.max(0, (v.y - LADDER_LIP) / (1 - LADDER_LIP));
            return [0, .25, .5, .75, 1].map(f => {
                const k = k0 + (1 - k0) * f, y = LADDER_LIP + k * (1 - LADDER_LIP);
                return [inwardPoint(l.x + (l.topX - l.x) * y, l.z + (l.topZ - l.z) * y, k), v];
            });
        });
    }
    // 踩台行走：沿墙环一步步走，候选位置（含换道）渲染距离要么 >= .46，要么不比当前更近；红方另守攻城梯顶 .5 的旧规
    function walkWall(u, goalT, laneGoal, dt, extra = () => true) {
        const partners = [];
        for (const v of [...assault.attackers, ...assault.defenders]) if (bodyPartners(u, v)) partners.push(viewPoint(v));
        let [cx, cz] = viewPoint(u);
        const ok = (vx, vz) => partners.every(([px, pz]) => {
            const n = Math.hypot(vx - px, vz - pz);
            return n >= BODY_GAP + .01 || n >= Math.hypot(cx - px, cz - pz) - 1e-9;
        });
        // 攻方之间不叠人：渲染间距 >= MATE_GAP（错身靠内外道，内外道相距 .6）
        const mates = u.team !== 'blue' ? [] : wallMates(u);
        let blocker = null;
        const spaced = (vx, vz) => mates.every(([[px, pz], v]) => {
            const n = Math.hypot(vx - px, vz - pz);
            if (n >= MATE_GAP || n >= Math.hypot(cx - px, cz - pz) - 1e-9) return true;
            blocker = v; return false;
        });
        // 被同伴挡住时换到与对方相反的一道错身（迎面都在走时 id 大的让）
        if (u.team === 'blue' && assault.elapsedMs < u.passUntil) laneGoal = u.passLane;
        // 别人的木梯梯顶正被使用（梯顶点在内道）：路过的攻方靠外道让开
        if (u.team === 'blue' && assault.inner.some(l => (l.climber || l.grant) && l.grant !== u && l.climber !== u &&
            Math.abs(alongT(wallT(u), l.tTop)) < .8)) laneGoal = -1;
        const lane = u.lane || 0;
        if (u.team === 'blue') {
            // 攻方换道一次换到位：目标道此处空着才起换（快换，横移不超出单帧位移预算），
            // 半路被挡就退回原道，不停在两道之间把前后的人都堵死
            const free = l => {
                const [vx, vz] = wallView(u.x, u.z, l);
                return partners.every(([px, pz]) => Math.hypot(vx - px, vz - pz) >= BODY_GAP + .01) &&
                    mates.every(([[px, pz]]) => Math.hypot(vx - px, vz - pz) >= MATE_GAP);
            };
            const rate = (u.speed * dt + .015) / LANE_W;
            const at = Number.isInteger(lane);
            if (at && lane !== laneGoal && free(laneGoal)) u.laneFrom = lane;
            const target = at ? (lane !== laneGoal && u.laneFrom === lane ? laneGoal : lane) : laneGoal;
            for (const goal of at ? [target] : [target, u.laneFrom ?? Math.round(lane)]) {
                if (goal === lane) break;
                const next = lane + Math.sign(goal - lane) * Math.min(Math.abs(goal - lane), rate);
                const [vx, vz] = wallView(u.x, u.z, next);
                if (ok(vx, vz) && spaced(vx, vz)) { u.lane = next; cx = vx; cz = vz; break; }
            }
            if (Number.isInteger(u.lane) && u.lane !== lane) u.laneFrom = u.lane;
        } else if (lane !== laneGoal) {
            const next = lane + Math.sign(laneGoal - lane) * Math.min(Math.abs(laneGoal - lane), LANE_RATE * dt);
            const [vx, vz] = wallView(u.x, u.z, next);
            if (ok(vx, vz) && spaced(vx, vz)) { u.lane = next; cx = vx; cz = vz; }
        }
        const have = wallT(u), diff = alongT(have, goalT);
        u.wallDir = Math.abs(diff) < 1e-12 ? 0 : Math.sign(diff);
        if (!u.wallDir) return false;
        blocker = null;
        for (let f = 1; f > 0; f -= .25) {
            const p = wallPoint(have + u.wallDir * Math.min(Math.abs(diff), u.speed * dt) * f);
            const [vx, vz] = wallView(p[0], p[1], u.lane);
            if (ok(vx, vz) && spaced(vx, vz) && extra(p)) { [u.x, u.z] = p; return true; }
        }
        if (blocker && blocker.zone === 'wall' && (!blocker.wallDir || blocker.wallDir === -u.wallDir && u.id > blocker.id)) {
            u.passLane = (blocker.lane || 0) >= 0 ? -1 : 1; u.passUntil = assault.elapsedMs + 1500;
            if (blocker.wallDir === -u.wallDir && u.lane === lane) {
                // 迎面让路的一方此处换不了道：往回退一步拉开间距，再换道错身
                const p = wallPoint(have - u.wallDir * u.speed * dt);
                const [vx, vz] = wallView(p[0], p[1], u.lane);
                if (ok(vx, vz) && spaced(vx, vz) && extra(p)) [u.x, u.z] = p;
            }
        }
        if (blocker?.zone === 'ladder') {
            // 攻城梯上的同伴正翻墙：他优先。朝离他余下翻墙路线更远的方向退一步，让出这段路，
            // 等他翻上来靠内道后再从外道过去
            const path = mates.filter(([, v]) => v === blocker).map(([q]) => q);
            const clearance = (vx, vz) => Math.min(...path.map(([px, pz]) => Math.hypot(vx - px, vz - pz)));
            const now = clearance(cx, cz);
            for (const dir of [-u.wallDir, u.wallDir]) {
                const p = wallPoint(have + dir * u.speed * dt);
                const [vx, vz] = wallView(p[0], p[1], u.lane);
                if (clearance(vx, vz) > now + 1e-9 && ok(vx, vz) && extra(p) && mates.every(([[px, pz], v]) => v === blocker ||
                    Math.hypot(vx - px, vz - pz) >= MATE_GAP || Math.hypot(vx - px, vz - pz) >= Math.hypot(cx - px, cz - pz) - 1e-9)) {
                    [u.x, u.z] = p; break;
                }
            }
        }
        return false;
    }
    // 攻城梯顶有攀爬者时，红方不靠近梯顶 .5（与原守军规则一致）
    function sparesLadderTops(d) {
        const tops = assault.ladders.filter(l => l.climber && !l.climber.dead).map(l => ({ x: l.topX, z: l.topZ }));
        return p => tops.every(v => {
            const n = Math.hypot(p[0] - v.x, p[1] - v.z);
            return n >= .5 + 1e-9 || n >= Math.hypot(d.x - v.x, d.z - v.z) - 1e-9;
        });
    }
    // 去寨内木梯的人：走外道到梯顶排队槽位，轮到后走近梯顶换到内道、走到梯顶点起爬
    function wallQueueMove(u, dt) {
        const l = queueOf(u), granted = l.grant === u;
        const goalT = granted ? l.tTop : innerTopSlot(l, u.iq.side, queueRank(u));
        const [mx, mz] = wallPoint(goalT); u.moveTarget = { x: mx, z: mz };
        const lane = granted && Math.abs(alongT(wallT(u), l.tTop)) < .8 ? 1 : -1;
        const moved = walkWall(u, goalT, lane, dt, u.team === 'red' ? sparesLadderTops(u) : undefined);
        if (granted && Math.abs(alongT(wallT(u), l.tTop)) < 1e-6 && u.lane === 1) { startClimb(u); return; }
        if (!moved && u.team === 'red' && Math.abs(alongT(wallT(u), goalT)) > 1e-6) {
            // 两名去不同木梯的红方在踩台上迎面相遇（同在内道无法错身）：改去对方的木梯，变成同向排队
            const dir = Math.sign(alongT(wallT(u), goalT));
            const p = assault.defenders.find(v => v !== u && !v.dead && v.zone === 'wall' && v.task === 'down' && v.iq &&
                v.iq.li !== u.iq.li && Math.abs(alongT(wallT(u), wallT(v))) < .7 && Math.sign(alongT(wallT(u), wallT(v))) === dir &&
                Math.sign(alongT(wallT(v), assault.inner[v.iq.li].tTop)) === -dir);
            if (p && !granted) {
                const target = assault.inner[p.iq.li];
                leaveQueue(u); enqueue(u, target, 'inner', 'top', alongT(target.tTop, wallT(u)) < 0 ? -1 : 1);
            }
        }
    }
    // 地面上去梯脚：走到梯脚排队槽位（绕帐篷），轮到后走到梯脚站位起爬
    function groundQueueMove(u, dt) {
        const l = queueOf(u), granted = l.grant === u;
        const p = granted ? { x: l.x, z: l.z } : u.iq.kind === 'inner' ? innerFootSlot(l, queueRank(u)) : towerFootSlot(l, queueRank(u));
        u.moveTarget = { ...p };
        if (distance(u, p) <= .04) {
            // 起爬会把人对正到梯脚站位：对正后若压进同层的人一个身位以内（且比现在更近），先等一等
            const snapOk = !granted || [...assault.attackers, ...assault.defenders].every(v => {
                if (v === u || !bodyPartners(u, v)) return true;
                const [vx, vz] = viewPoint(v), n = Math.hypot(p.x - vx, p.z - vz);
                return n >= BODY_GAP + .01 || n >= Math.hypot(u.x - vx, u.z - vz) - 1e-9;
            });
            if (granted && snapOk) startClimb(u); else u.waitState = 'queued';
            return;
        }
        u.waitState = 'travel';
        const w = steer(u, p);
        move(u, w.x, w.z, u.speed * dt); constrain(u);
    }
    // ---- 寨内攻方的去向：夺旗模式的猎弓手 / 死斗模式全体 ----
    const defById = id => assault.defenders.find(d => d.id === id);
    function validGoal(d) {
        if (d.dead) return false;
        if (d.fixed) return d.tower != null;
        if (assault.mode !== 'deathmatch' && d.type !== 'archer') return false;
        return d.zone === 'wall' || assault.mode === 'deathmatch' && d.zone === 'inside';
    }
    // 估算路程：地面直线 + 木梯 1 + 踩台沿墙距离 + 塔高
    function costFromGround(p, d) {
        if (d.zone === 'inside') return Math.hypot(d.x - p.x, d.z - p.z);
        if (d.fixed) { const t = assault.towerLadders[d.tower]; return Math.hypot(t.x - p.x, t.z - p.z) + TOWER_Y; }
        return Math.min(...assault.inner.map(l => Math.hypot(l.x - p.x, l.z - p.z) + 1 + Math.abs(alongT(l.tTop, wallT(d)))));
    }
    function costTo(u, d) {
        if (u.zone === 'wall') {
            if (d.zone === 'wall') return Math.abs(alongT(wallT(u), wallT(d)));
            return Math.min(...assault.inner.map(l => Math.abs(alongT(wallT(u), l.tTop)) + 1 + costFromGround(l, d)));
        }
        if (u.zone === 'tower') {
            if (d.fixed && d.tower === u.tower) return 0;
            return TOWER_Y + costFromGround(assault.towerLadders[u.tower], d);
        }
        return costFromGround(u, d);
    }
    function pickGoal(u) {
        let best = null, bestCost = Infinity;
        for (const d of assault.defenders) {
            if (!validGoal(d)) continue;
            const c = costTo(u, d);
            if (c < bestCost - 1e-9) { bestCost = c; best = d; }
        }
        return best;
    }
    // 认准目标直到它阵亡/失效再换；夺旗模式猎手没有弓手可打时归队守旗
    function goalFor(u) {
        if (assault.mode !== 'deathmatch' && !u.hunter) return null;
        let g = u.goalId == null ? null : defById(u.goalId);
        if (!g || !validGoal(g)) { g = pickGoal(u); u.goalId = g?.id ?? null; }
        if (!g && assault.mode !== 'deathmatch') u.hunter = false;
        return g;
    }
    function hunterOnGround(u, dt) {
        if (nearest(assault.defenders, u, 2.8, d => d.zone === 'inside')) return false; // 先打附近的寨内守军（交给守旗逻辑迎战）
        const granted = u.iq && queueOf(u).grant === u;
        const goal = goalFor(u);
        if (!goal) return false;
        if (goal.zone === 'inside') {
            if (u.iq && !granted) leaveQueue(u);
            if (!u.iq) {
                u.moveTarget = { x: goal.x, z: goal.z };
                if (distance(u, goal) <= rangeOf(u) * .85) { u.waitState = 'staging'; return true; }
                u.waitState = 'travel';
                const w = steer(u, goal); move(u, w.x, w.z, u.speed * dt); constrain(u);
                return true;
            }
        }
        const kind = goal.fixed ? 'tower' : 'inner';
        if (u.iq && !granted && (u.iq.kind !== kind || u.iq.end !== 'foot' || kind === 'tower' && u.iq.li !== goal.tower)) leaveQueue(u);
        if (u.iq || (kind === 'inner' ? joinInner(u, 'foot') : joinTower(u, goal.tower))) groundQueueMove(u, dt);
        else { u.moveTarget = { x: u.x, z: u.z }; u.waitState = 'staging'; }   // 排队槽位已满：原地等候
        return true;
    }
    // 塔顶攻方：本塔还有目标就留在塔顶站位（优先里侧站位 0），否则排队顺塔梯下塔
    function towerAttacker(u, dt) {
        u.waitState = 'climbing';
        const l = assault.towerLadders[u.tower], goal = goalFor(u);
        if (goal?.fixed && goal.tower === u.tower) {
            if (u.iq && l.grant !== u) leaveQueue(u);
            if (!u.iq) {
                if (u.spot === 1 && !l.occ[0]) { l.occ[1] = null; l.occ[0] = u; u.spot = 0; }
                const p = l.spots[u.spot]; u.moveTarget = { ...p };
                move(u, p.x, p.z, u.speed * dt);
                return;
            }
        }
        if (!u.iq && !joinTower(u, u.tower, 'top')) return;
        if (l.grant !== u) return;
        u.moveTarget = { x: l.x, z: l.z };
        move(u, l.x, l.z, u.speed * dt);
        if (distance(u, l) < 1e-9) startClimb(u);
    }
    // 夺旗模式分流：旗心 FLAG_RADIUS 内没有可打的寨内守军、且还有可打的弓手时，
    // 分出最多 1/3（至少 1 人）寨内近战去爬梯打弓手，其余守旗心；旗心来敌时地面上的猎手归队
    function assignHunters() {
        if (assault.mode !== 'flag') return;
        const inCamp = assault.attackers.filter(u => !u.dead && u.type !== 'archer' && (u.zone === 'inside' ||
            u.zone === 'iladder' || u.zone === 'tladder' || u.zone === 'tower' || u.zone === 'wall' && u.hunter));
        const targets = assault.defenders.some(d => !d.dead && d.type === 'archer' && (d.zone === 'wall' || d.fixed && d.tower != null));
        const contested = assault.defenders.some(d => !d.dead && d.zone === 'inside' && Math.hypot(d.x, d.z) <= FLAG_RADIUS);
        if (contested || !targets) {
            for (const u of inCamp) if (u.hunter && u.zone === 'inside') {
                u.hunter = false; u.goalId = null; leaveQueue(u);
            }
            return;
        }
        const quota = Math.max(1, Math.floor(inCamp.length * HUNTER_SHARE));
        let count = inCamp.filter(u => u.hunter).length;
        if (count >= quota) return;
        const pool = inCamp.filter(u => !u.hunter && u.zone === 'inside').map(u => {
            let cost = Infinity;
            for (const d of assault.defenders) if (validGoalFlag(d)) cost = Math.min(cost, costTo(u, d));
            return { u, cost };
        }).sort((a, b) => a.cost - b.cost || a.u.id - b.u.id);
        for (const { u } of pool) {
            if (count >= quota) break;
            u.hunter = true; u.goalId = null; count++;
        }
    }
    const validGoalFlag = d => !d.dead && d.type === 'archer' && (d.zone === 'wall' || d.fixed && d.tower != null);
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
            const clear = nk < LADDER_LIP || assault.defenders.every(d => {   // 到达翻墙段（含 y=LIP 当帧）即与墙头同层
                if (!bodyPartners(ahead, d)) return true;
                const [dx, dz] = viewPoint(d);
                return Math.hypot(dx - px, dz - pz) >= BODY_GAP + .01;
            }) && wallMates(u).every(([[vx, vz]]) => Math.hypot(vx - px, vz - pz) >= MATE_GAP);   // 梯顶落点不压到同伴
            // 停步点取翻墙段之前（y 略低于 LADDER_LIP），停住时尚未与墙头同层
            u.climbMs = clear ? next : Math.max(u.climbMs, Math.min(next, 1600 * LADDER_LIP - 1));
            // 爬过 .6 之前，余下翻墙路线（翻墙段起点到梯顶落点）上不能有踩台上的同伴；过了 .6 踩台上的人会让开这段路
            if (u.climbMs >= 1600 * .6 && u.y < .6) {
                const path = [0, .25, .5, .75, 1].map(k => {
                    const y = LADDER_LIP + k * (1 - LADDER_LIP);
                    return inwardPoint(l.x + (l.topX - l.x) * y, l.z + (l.topZ - l.z) * y, k);
                });
                if (wallMates(u).some(([[vx, vz]]) => path.some(([px, pz]) => Math.hypot(vx - px, vz - pz) < MATE_GAP)))
                    u.climbMs = Math.max(u.y * 1600, 1600 * .6 - 1);
            }
            const k = u.climbMs / 1600;
            u.x = l.x + (l.topX - l.x) * k; u.z = l.z + (l.topZ - l.z) * k; u.y = k;
            if (k === 1) { changeZone(u, 'wall'); u.wallMs = 0; u.leftTop = false; u.lane = 0; }
            return;
        }
        if (CLIMB_ZONES.has(u.zone)) { u.waitState = 'climbing'; return; }  // 寨内木梯 / 塔梯：由 updateClimbers 推进
        if (u.zone === 'wall') {
            u.waitState = 'climbing';
            if (!u.leftTop) {
                // 墙头对砍：1 半径内没有守军才离开梯顶，沿踩台去木梯（或去打墙上守军）
                const l = assault.ladders[u.route];
                u.wallMs += dt * 1000;
                // 在梯顶等候时靠内道，让沿踩台去木梯的同伴从外道过去
                if (u.wallMs < 1000 || nearest(assault.defenders, u, 1, d => d.zone === 'wall')) { walkWall(u, wallT(u), 1, dt); return; }
                u.leftTop = true;
                if (l?.climber === u) l.climber = null;
            }
            const goal = goalFor(u);
            if (goal?.zone === 'wall' && (!u.iq || queueOf(u).grant !== u)) {
                if (u.iq) leaveQueue(u);
                u.moveTarget = { x: goal.x, z: goal.z };
                walkWall(u, wallT(goal), -1, dt);   // 踩台上行进走外道（墙角处外道放宽）
                return;
            }
            if (u.iq || joinInner(u, 'top')) wallQueueMove(u, dt);
            return;
        }
        if (u.zone === 'tower') { towerAttacker(u, dt); return; }
        if (u.zone === 'inside' && (assault.mode === 'deathmatch' || u.hunter) && hunterOnGround(u, dt)) return;
        if (u.zone === 'inside') {
            if (u.iq) leaveQueue(u);
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
        if (assault.gate.broken && Math.abs(u.x) <= 1 && u.z >= MELEE_STOP_R && u.z <= MELEE_STOP_R + .02) {
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
    const onGroundLayer = u => u.zone === 'inside' || u.zone === 'iladder' || u.zone === 'tladder';
    function atFireSlot(u) {
        return u.type === 'archer' && u.zone === 'outside' && u.waitState === 'firing' && distance(u, u.fireSlot) <= .04;
    }
    function fixedAttacker(u) {
        // 寨内梯脚排队的人不算固定：路过的人可以把他挤开，他再走回槽位（否则整排人会把踩台下的人圈住）
        return u.zone === 'ladder' || u.zone === 'wall' || u.zone === 'iladder' || u.zone === 'tladder' ||
            u.zone !== 'inside' && inLadderQueue(u) || atFireSlot(u);
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
            if (d > cap) {
                // 截断后再做边界/帐篷约束可能又被推远：逐级缩小推挤量，直到约束后的位置仍在预算内
                const tx = (u.x - x) * cap / d, tz = (u.z - z) * cap / d;
                for (const f of [1, .75, .5, .25, 0]) {
                    u.x = x + tx * f; u.z = z + tz * f; constrain(u);
                    if (Math.hypot(u.x - x, u.z - z) <= cap + 1e-9) break;
                }
            }
        }
    }
    // 推挤贴着寨墙/帐篷边界、又被单帧位移预算截断时，敌我（红红）之间可能残留不足一个身位：
    // 把这一对里本帧挪动过的人退回帧初位置（上一帧本就满足间距），直到没有残留
    function enforceBodyGap(units, origin) {
        for (let pass = 0; pass < 8; pass++) {
            let reverted = false;
            for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
                const a = units[i], b = units[j];
                if (Math.abs(a.x - b.x) >= BODY_GAP || Math.abs(a.z - b.z) >= BODY_GAP || !bodyPartners(a, b)) continue;
                const [ax, az] = viewPoint(a), [bx, bz] = viewPoint(b);
                if (Math.hypot(ax - bx, az - bz) >= BODY_GAP + 1e-6) continue;
                for (const u of [a, b]) {
                    const o = origin.get(u);
                    if (!o || u.zone !== 'inside' || u.x === o[0] && u.z === o[1]) continue;
                    [u.x, u.z] = o; reverted = true;
                }
            }
            if (!reverted) break;
        }
    }
    // 墙上守军按面分配：每面威胁 = 归属该面的墙外/梯上活着攻方人数；有威胁的面按比例（最大余数法）分人，
    // 无威胁的面各留 1 名哨兵（人数够时）。岗位沿各面均布，守军按环上顺序整体轮转对位（不交叉、
    // 不互相穿越）。轮转按字典序取优：①哨兵由本面或相邻面的刀兵担任（硬优先，做不到才退而用弓手/远面的人）
    // ②哨兵出自本面 ③总步行距离最短。
    function assignFaces(guards, along) {
        const threat = [0, 0, 0, 0];
        for (const u of assault.attackers) if (!u.dead && (u.zone === 'outside' || u.zone === 'ladder')) threat[wallFace(u.x, u.z)]++;
        const total = threat.reduce((a, b) => a + b, 0), n = guards.length;
        if (!total || !n) { for (const d of guards) { d.postT = null; d.postFace = null; } return; }
        const hot = [0, 1, 2, 3].filter(f => threat[f] > 0), cold = [0, 1, 2, 3].filter(f => !threat[f]);
        const count = [0, 0, 0, 0];
        const onFace = f => guards.filter(d => wallFace(d.x, d.z) === f).length;
        cold.sort((a, b) => onFace(b) - onFace(a) || a - b).slice(0, Math.max(0, Math.min(cold.length, n - hot.length)))
            .forEach(f => { count[f] = 1; });
        const rest = n - count.reduce((a, b) => a + b, 0);
        const quota = hot.map(f => ({ f, q: rest * threat[f] / total }));
        for (const { f, q } of quota) count[f] = Math.floor(q);
        let left = rest - quota.reduce((a, { f }) => a + count[f], 0);
        for (const { f } of [...quota].sort((a, b) => (b.q - Math.floor(b.q)) - (a.q - Math.floor(a.q)) || a.f - b.f)) {
            if (left <= 0) break; count[f]++; left--;
        }
        const side = 2 * WALL_R, slots = [];
        for (let f = 0; f < 4; f++) for (let k = 0; k < count[f]; k++)
            slots.push({ f, t: f * side + .5 + (k + .5) * (side - 1) / count[f], sentry: !threat[f] });
        const order = [...guards].sort((a, b) => wallParamToward(a.x, a.z) - wallParamToward(b.x, b.z) || a.id - b.id);
        let best = null, bestCost = null;
        for (let r = 0; r < n; r++) {
            const cost = [0, 0, 0];
            for (let i = 0; i < n; i++) {
                const d = order[i], slot = slots[(i + r) % n], f = wallFace(d.x, d.z);
                cost[2] += Math.abs(along(wallParamToward(d.x, d.z), slot.t));
                if (!slot.sentry) continue;
                if (d.type === 'archer' || (f - slot.f + 4) % 4 === 2) cost[0]++;
                if (f !== slot.f) cost[1]++;
            }
            if (!bestCost || cost[0] < bestCost[0] || cost[0] === bestCost[0] &&
                (cost[1] < bestCost[1] || cost[1] === bestCost[1] && cost[2] < bestCost[2] - 1e-9)) { bestCost = cost; best = r; }
        }
        order.forEach((d, i) => { const slot = slots[(i + best) % n]; d.postT = slot.t; d.postFace = slot.f; });
    }
    function updateDefenders(dt) {
        const tops = assault.ladders.filter(l => l.climber && !l.climber.dead).map(l => ({ x: l.topX, z: l.topZ, ladder: true }));
        const threats = [...tops];
        if (assault.ram.state === 'hitting') threats.push({ x: 0, z: WALL_R });
        // 去木梯的红方（task 'down'）不参与分面与响应，由下方排队逻辑带走
        const guards = assault.defenders.filter(d => !d.dead && !d.fixed && d.zone === 'wall' && d.task !== 'down');
        const assignments = new Map();
        const along = alongT;
        if (assault.elapsedMs >= assault.faceAt) { assignFaces(guards, along); assault.faceAt += WALL_FACE_MS; }
        for (const t of threats) {
            const center = wallParamToward(t.x, t.z), face = wallFace(t.x, t.z);
            // 响应者从分到该面的守军里出（尚未分面时不限）
            const chosen = guards.filter(d => !assignments.has(d) && (d.postFace == null || d.postFace === face))
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
        // 让行：.8 内的木梯梯顶正被使用（有人在梯上，或已轮到某人从任一端起爬；梯顶点在内道）靠外道；
        // 否则 1.2 内有去木梯的红方，让到与他相反的一道
        const passers = assault.defenders.filter(v => !v.dead && v.zone === 'wall' && v.task === 'down');
        const rising = assault.inner.filter(l => l.climber || l.grant);
        const yieldLane = d => {
            if (rising.some(l => Math.abs(alongT(wallT(d), l.tTop)) < .8)) return -1;
            const p = passers.filter(p => distance(p, d) < 1.2).sort((a, b) => distance(a, d) - distance(b, d) || a.id - b.id)[0];
            return p ? (p.lane || 0) > 0 ? -1 : 1 : 0;
        };
        // Reserve unassigned posts first. Guards walk at most one step along the wall and never step
        // closer than one body (rendered) to anyone on the walkway, nor .5 to an occupied ladder top.
        // 腾梯顶：.8 内的木梯梯顶正被使用时，守军沿踩台走到梯顶另一侧 .9 外（轮到的人从哪侧来就让到对侧）
        const clearTop = d => {
            for (const l of rising) {
                const off = alongT(l.tTop, wallT(d));
                if (Math.abs(off) >= .8) continue;
                const side = l.grant?.iq?.end === 'top' ? -l.grant.iq.side : off < 0 ? -1 : 1;
                return l.tTop + side * .9;
            }
            return null;
        };
        for (const d of [...guards].sort((a, b) => Number(assignments.has(a)) - Number(assignments.has(b)) || a.id - b.id))
            walkWall(d, clearTop(d) ?? assignments.get(d) ?? d.postT ?? d.homeT, yieldLane(d), dt, sparesLadderTops(d));
        for (const d of passers) if (d.iq || joinInner(d, 'top')) wallQueueMove(d, dt);
        for (const d of assault.defenders) {
            if (d.dead) continue;
            const enemy = nearest(assault.attackers, d);
            if (d.fixed && d.tower != null) {
                // 有攻方登本塔：-x 侧两名弓手横向让到 ±TOWER_YIELD_Z，让出塔梯口到里侧站位的通道
                const o = TOWER_ORIGINS[d.tower];
                const busy = assault.attackers.some(u => !u.dead && u.tower === d.tower && (u.zone === 'tower' || u.zone === 'tladder'));
                const gz = busy && d.spawnX < o.x ? o.z + Math.sign(d.spawnZ - o.z) * TOWER_YIELD_Z : d.spawnZ;
                move(d, d.spawnX, gz, d.speed * dt);
            } else if (d.zone === 'inside') groundDefender(d, dt);
            if (enemy) d.yaw = Math.atan2(enemy.x - d.x, enemy.z - d.z);
        }
    }
    // 寨内地面守军：先走完堵门路线；3 以内有寨内攻方就迎战；否则经最近的木梯爬回墙头
    function groundDefender(d, dt) {
        const target = nearest(assault.attackers, d, 3, u => u.zone === 'inside');
        if (d.task === 'up' && target) { leaveQueue(d); d.task = null; }   // 3 以内来了寨内攻方：不上墙，先迎战
        if (d.task === 'up') { if (d.iq || joinInner(d, 'foot')) groundQueueMove(d, dt); return; }
        if (d.blockPath?.length) {
            const p = d.blockPath[0], w = steer(d, p);
            move(d, w.x, w.z, d.speed * dt);
            if (distance(d, p) < .04) d.blockPath.shift();
            constrain(d); return;
        }
        if (target) {
            if (distance(d, target) > rangeOf(d) * .8) move(d, target.x, target.z, d.speed * dt);
            constrain(d); return;
        }
        d.task = 'up';
    }
    function strike(from, to, { rawAttack, melee = false } = {}) {
        const multiplier = from.team === 'red' ? CAMP_RULES.WALL_GUARD_ATTACK *
            (from.zone === 'inside' ? GATE_BLOCKER_ATTACK : 1) : 1;
        const cover = to.zone === 'wall' || to.fixed ? ASSAULT_COVER : 1;
        const damage = Math.max(1, Math.floor(calculateAttackDamage(from, to, { multiplier, rawAttack }) * cover));
        to.hp = Math.max(0, to.hp - damage); to.hitAt = assault.elapsedMs;
        const d = distance(from, to) || 1;
        to.hitDX = (to.x - from.x) / d; to.hitDZ = (to.z - from.z) / d;
        if (to.hp === 0) { to.dead = true; to.dieAt = assault.elapsedMs; }
        from.atkAt = assault.elapsedMs;
        emit('attack', { from, to, damage, fromZone: from.zone, toZone: to.zone, ...melee ? { melee: true } : {} });
        from.cd = from.typeData.atkSpeed * randomBetween(.85, 1.15);
    }
    // 守方弓手（墙上与箭塔）选目标：攻方弓手 > 梯上/墙头攻方 > 冲车手 > 其余，同层取最近；
    // 当前目标仍可打且射程内没有更高层目标时锁定不换
    const archerTier = t => t.type === 'archer' ? 0 : CLIMB_ZONES.has(t.zone) || t.zone === 'wall' ? 1 : t.crew ? 2 : 3;   // 攻城梯/木梯/塔梯上与墙头同层
    function guardArcherTarget(u, targets) {
        const ok = t => !t.dead && canHit(u, t) && (t.x - u.x) ** 2 + (t.z - u.z) ** 2 <= rangeOf(u) ** 2;
        let best = null, bestTier = Infinity;
        for (let tier = 0; tier < 4 && !best; tier++) {
            best = nearest(targets, u, rangeOf(u), t => archerTier(t) === tier && canHit(u, t));
            if (best) bestTier = tier;
        }
        const cur = u.target;
        return cur && cur.team !== u.team && ok(cur) && archerTier(cur) <= bestTier ? cur : best;
    }
    function fight(units, targets, ms) {
        const load = new Map();
        for (const u of units) {
            if (u.dead || u.crew || CLIMB_ZONES.has(u.zone)) continue;
            if (u.fixed && u.tower != null) {
                // 塔上弓手被贴身（同塔塔顶有活着的攻方、且对方够得着自己）：改为近战还手，弓手攻击力 ×0.5
                const foe = nearest(targets, u, Infinity, t => t.zone === 'tower' && t.tower === u.tower && distance(t, u) <= rangeOf(t));
                if (foe) {
                    u.target = foe; u.yaw = Math.atan2(foe.x - u.x, foe.z - u.z); u.cd -= ms;
                    if (u.cd <= 0) strike(u, foe, { rawAttack: u.typeData.atk * ARCHER_MELEE_FACTOR, melee: true });
                    continue;
                }
            }
            const target = u.team === 'red' && u.type === 'archer' ? guardArcherTarget(u, targets) :
                nearest(targets, u, rangeOf(u), t => canHit(u, t) &&
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
        if (assault.mode === 'deathmatch') {
            // 死斗：墙上、寨内守军与箭塔弓手全部阵亡才破寨；不计旗帜
            if (assault.defenders.every(d => d.dead)) { assault.result = 'break'; emit('defenders_wiped'); return; }
        } else {
            updateFlag(ms);
            if (assault.flagProgress >= 1) { assault.flagProgress = 1; assault.result = 'break'; emit('flag_captured'); return; }
        }
        // A small assault preserves a withdrawal reserve; larger formations can absorb
        // proportionally more losses before giving up a still-closed gate.
        const retreatAt = Math.max(Math.min(RETREAT_RESERVE, assault.attackers.length * RETREAT_MAX_RESERVE_FRACTION),
            assault.attackers.length * RETREAT_SURVIVOR_FRACTION);
        if (living.length <= retreatAt && !assault.gate.broken &&
            !living.some(u => u.zone !== 'outside' && u.zone !== 'ladder')) {
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
        const origin = new Map([...assault.attackers, ...assault.defenders].filter(u => !u.dead && !u.fixed).map(u => [u, [u.x, u.z]]));
        updateLadderQueues(); grantLadders();
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
            updateClimbers(dt); updateDefenders(dt);
            separateAttackers([...assault.attackers, ...assault.defenders].filter(u => !u.dead && onGroundLayer(u)), origin, dt);
            fight(assault.defenders, assault.attackers, ms);
            assault.retreatMs += ms;
            if (assault.retreatMs >= 3000) assault.result = 'hold';
            limitDuration();
            assault.phase = '溃退'; return assault.events;
        }
        advanceFormations(dt); updateRam(dt); updateLadderQueues(); assignHunters();
        for (const u of assault.attackers) if (!u.dead) advanceAttacker(u, dt);
        updateClimbers(dt);
        // 踩台、塔顶与木梯/塔梯上的攻方不进墙外人群的推挤（墙头只计还守在攻城梯顶的人）
        separateAttackers(assault.attackers.filter(u => !u.dead && (u.zone === 'outside' || u.zone === 'ladder' ||
            u.zone === 'inside' || u.zone === 'wall' && !u.leftTop)), origin, dt);
        // Collision projection runs after movement. Waiting describes the final
        // physical position, never just a reservation or an earlier arrival.
        for (const u of assault.attackers) if (!u.dead && u.zone === 'outside' &&
            ['staging', 'queued', 'firing'].includes(u.waitState) && distance(u, u.moveTarget) > .04)
            u.waitState = 'travel';
        updateDefenders(dt);
        // 寨内敌我同层，守军移动后再分离一次，保证敌我不重叠；木梯/塔梯上的人当作固定占位
        const ground = [...assault.attackers, ...assault.defenders].filter(u => !u.dead && onGroundLayer(u));
        separateAttackers(ground, origin, dt); enforceBodyGap(ground, origin);
        for (const u of ground) if (u.zone === 'inside' && u.waitState === 'queued' && distance(u, u.moveTarget) > .04) u.waitState = 'travel';
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
