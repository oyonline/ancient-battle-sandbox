// Deterministic camp assault simulation: no THREE, DOM, or wall geometry mutations.
import { UNIT_TYPES, calculateAttackDamage } from '../units.js';
import { CAMP_RULES } from '../battle/camps.js';
export const WALL_R = 5;
const ATK_ANIM_MS = 220, HIT_ANIM_MS = 180;
export const ATTACK_KINDS = ['infantry', 'pikeman', 'archer'];
export const DEF_COUNTS = [6, 12, 24];
export const slotKind = i => i % 3 === 2 ? 'archer' : 'infantry';
export const DEFAULT_TOWERS = [-.176, .176].flatMap(z => [-.336, 0, .336].map(x => ({ x, z: -3.3 + z, yaw: Math.PI / 2 })));

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
    const assault = { active: false, attackers: [], defenders: [], formations: [], events: [],
        acc: 0, elapsedMs: 0, result: null, preset: 'company', fxMs: 0, nextRamAt: 0 };
    let random = mulberry32(1);
    const randomBetween = (lo, hi) => lo + random() * (hi - lo);

    function makeUnit(team, type, x, z, yaw) {
        const typeData = UNIT_TYPES[type];
        return { team, role: team === 'blue' ? 'attack' : 'defend', type, typeData, x, z, yaw,
            hp: typeData.hp, maxHp: typeData.hp, cd: typeData.atkSpeed * randomBetween(.2, 1),
            speed: typeData.speed * randomBetween(.9, 1.1), dead: false, target: null,
            atkAnim: 0, hitAnim: 0, hitDX: 0, hitDZ: 0, dieAt: 0 };
    }
    function resetAssault() {
        Object.assign(assault, { active: false, attackers: [], defenders: [], formations: [], events: [],
            acc: 0, elapsedMs: 0, result: null, fxMs: 0, nextRamAt: 0 });
    }
    function startAssault(preset = 'company', defCount = 6, seed = 1) {
        resetAssault();
        random = mulberry32(seed);
        assault.preset = preset;
        const counts = FORCE_PRESETS[preset] ?? FORCE_PRESETS.company;
        const side = random() < .5 ? -1 : 1;
        const groups = [[], [], []], slots = { infantry: 0, pikeman: 0, archer: 0 };
        // Split every kind proportionately; sorting keeps swords in front, pikes in the middle, bows behind.
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
                u.slot = slots[type]++; u.formation = id;
                f.units.push(u); assault.attackers.push(u);
            });
            f.speed = Math.min(...f.units.map(u => u.speed));
            assault.formations.push(f);
        });
        const n = DEF_COUNTS.includes(defCount) ? defCount : 6;
        for (let i = 0; i < n; i++) {
            const t = i * 8 * WALL_R / n, [x, z] = wallPoint(t);
            assault.defenders.push({ ...makeUnit('red', slotKind(i), x, z, Math.atan2(x, z)), homeT: t, fixed: false });
        }
        for (const p of towerPositions)
            assault.defenders.push({ ...makeUnit('red', 'archer', p.x, p.z, p.yaw ?? 0), fixed: true });
        assault.active = true;
        return assault;
    }

    // Keep the ram corridor clear and project corrections onto the exterior square.
    function constrainAttacker(u) {
        if (u.z >= 6.1 && u.z <= 9 && Math.abs(u.x) < .95)
            u.x = (u.x < 0 ? -1 : 1) * .95;
        const m = Math.max(Math.abs(u.x), Math.abs(u.z));
        if (m < MELEE_STOP_R) {
            const k = MELEE_STOP_R / (m || 1);
            u.x *= k; u.z *= k;
        }
    }
    function advanceFormations(ms) {
        for (const f of assault.formations) {
            if (f.released || assault.elapsedMs <= f.departMs) continue;
            const living = f.units.filter(u => !u.dead);
            // Release near the wall; the rear ranks can then flow around the front ranks.
            if (living.some(u => u.type !== 'archer' && Math.max(Math.abs(u.x), Math.abs(u.z)) <= WALL_R + 2)) {
                f.released = true;
                continue;
            }
            const dt = Math.min(ms, assault.elapsedMs - f.departMs) / 1000;
            const step = f.speed * dt;
            f.x += f.dx * step; f.z += f.dz * step;
            for (const u of living) {
                if (u.type === 'archer' && Math.hypot(u.x, u.z) <= ARCHER_STOP_R + step) continue;
                u.x += f.dx * step; u.z += f.dz * step;
                constrainAttacker(u);
            }
        }
    }
    function advanceAttacker(u, ms) {
        if (!assault.formations[u.formation].released) return;
        const target = nearestOf(assault.defenders, u);
        if (!target) return;
        let tx, tz;
        if (u.type === 'archer') {
            const r = Math.hypot(u.x, u.z);
            if (r <= ARCHER_STOP_R) return;
            tx = u.x * ARCHER_STOP_R / r; tz = u.z * ARCHER_STOP_R / r;
        } else {
            const m = Math.max(Math.abs(target.x), Math.abs(target.z));
            tx = target.x * MELEE_STOP_R / m; tz = target.z * MELEE_STOP_R / m;
        }
        const distance = Math.hypot(tx - u.x, tz - u.z);
        if (distance < 1e-9) return;
        const k = Math.min(1, u.speed * ms / 1000 / distance);
        u.x += (tx - u.x) * k; u.z += (tz - u.z) * k;
        constrainAttacker(u);
    }
    function separateAttackers(units) {
        // Stable pair order and symmetric displacement keep replay deterministic.
        for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
            const a = units[i], b = units[j];
            let dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
            if (d >= .45) continue;
            if (d < 1e-9) { dx = 1; dz = 0; d = 1e-9; }
            const push = (.45 - d) / 2, nx = dx / (Math.hypot(dx, dz) || 1), nz = dz / (Math.hypot(dx, dz) || 1);
            a.x -= nx * push; a.z -= nz * push;
            b.x += nx * push; b.z += nz * push;
            constrainAttacker(a); constrainAttacker(b);
        }
    }
    // 射程内最近的一名目标（水平距离判定，忽略高度差；同距取数组序 → 确定性）
    function nearestInRange(list, from, range) {
        let best = null, bestD = Infinity;
        for (const u of list) {
            if (u.dead) continue;
            const d = Math.hypot(u.x - from.x, u.z - from.z);
            if (d > range) continue;
            if (d < bestD - 1e-9) { bestD = d; best = u; }
        }
        return best;
    }
    function nearestOf(list, from) {
        let best = null, bestD = Infinity;
        for (const u of list) {
            if (u.dead) continue;
            const d = Math.hypot(u.x - from.x, u.z - from.z);
            if (d < bestD - 1e-9) { bestD = d; best = u; }
        }
        return best;
    }

    function strike(target, dmg, from) {
        if (target.dead) return;
        target.hp -= dmg;
        target.hitAnim = HIT_ANIM_MS;                        // 受击后仰（纯视觉）
        if (from) {                                          // 记下受击方向：被顶得往后仰
            const l = Math.hypot(target.x - from.x, target.z - from.z) || 1;
            target.hitDX = (target.x - from.x) / l; target.hitDZ = (target.z - from.z) / l;
        }
        if (target.hp <= 0) { target.hp = 0; target.dead = true; target.dieAt = assault.fxMs; }
    }

    // 步长以毫秒计，与 camp.js 调试接口兼容。冷却仅在射程内走时，保留接敌时的随机相位。
    function stepAssault(ms) {
        if (!assault.active || assault.result !== null) return [];
        assault.events = [];
        assault.elapsedMs += ms;
        const atk = assault.attackers.filter(u => !u.dead);
        const def = assault.defenders.filter(u => !u.dead);
        advanceFormations(ms);
        for (const a of atk) advanceAttacker(a, ms);
        separateAttackers(atk);

        // 垛口名额分配：每个守军同一时刻最多被 2 名近战攻方贴身围攻；多余的改打其他守军或外围待命
        const load = new Map();
        for (const d of def) load.set(d, 0);
        for (const a of atk) {
            a.target = null;
            if (a.type === 'archer') continue;                 // 远程不计入贴身名额
            let best = null, bestD = Infinity;
            for (const d of def) {
                const dd = Math.hypot(a.x - d.x, a.z - d.z);
                if (dd > a.typeData.range) continue;           // 射程外不占名额
                if (load.get(d) >= GUARD_MELEE_CAP) continue;  // 垛口已满 2 人
                if (dd < bestD - 1e-9) { bestD = dd; best = d; }
            }
            if (best) { a.target = best; load.set(best, load.get(best) + 1); }
        }

        for (const a of atk) {
            a.yaw = a.target && !a.target.dead ? Math.atan2(a.target.x - a.x, a.target.z - a.z) : Math.atan2(-a.x, -a.z);
        }

        // 攻方出手：对守军有效伤害 = max(1, floor(base × WALL_GUARD_COVER))（居高临下更耐打）
        for (const a of atk) {
            const tgt = a.type === 'archer' ? nearestInRange(def, a, a.typeData.range) : a.target;
            if (!tgt || tgt.dead) continue;
            a.cd -= ms;
            if (a.cd > 0) continue;
            const base = calculateAttackDamage(a, tgt, { multiplier: 1 });
            strike(tgt, Math.max(1, Math.floor(base * ASSAULT_COVER)), a);
            a.atkAnim = ATK_ANIM_MS;                         // 出手前扑（纯视觉）
            assault.events.push({ from: a, to: tgt });
            a.cd = a.typeData.atkSpeed * randomBetween(.85, 1.15);
        }

        // 守方跑位：沿寨墙环（半边长 5.0）朝最近活着的攻方挪动，不许穿寨；箭塔弓手位置固定、只转向
        const per = 8 * WALL_R;
        for (const d of def) {
            if (d.dead) continue;
            const nf = nearestOf(atk, d);
            if (!d.fixed) {
                const have = wallParamToward(d.x, d.z);
                const want = nf ? wallParamToward(nf.x, nf.z) : d.homeT;
                let diff = want - have;
                if (diff > per / 2) diff -= per; else if (diff < -per / 2) diff += per;
                if (Math.abs(diff) > 1e-3) {
                    const step = Math.min(Math.abs(diff), d.speed * ms / 1000) * Math.sign(diff);
                    const p = wallPoint(have + step, WALL_R);
                    d.x = p[0]; d.z = p[1];
                }
            }
            d.yaw = nf ? Math.atan2(nf.x - d.x, nf.z - d.z) : (d.fixed ? d.yaw : Math.atan2(d.x, d.z));
        }

        // 守方出手：只打射程内最近的一名攻方；居高临下 × WALL_GUARD_ATTACK
        // （寨墙守军近战 range 0.95；寨墙弓手 range 9.5；箭塔弓手吃 TOWER_RANGE 加成、覆盖全场）
        for (const d of def) {
            if (d.dead) continue;
            const tgt = nearestInRange(atk, d, d.fixed ? TOWER_RANGE : d.typeData.range);
            if (!tgt) continue;
            d.cd -= ms;
            if (d.cd > 0) continue;
            strike(tgt, calculateAttackDamage(d, tgt, { multiplier: CAMP_RULES.WALL_GUARD_ATTACK }), d);
            d.atkAnim = ATK_ANIM_MS;
            assault.events.push({ from: d, to: tgt });
            d.cd = d.typeData.atkSpeed * randomBetween(.85, 1.15);
        }

        if (assault.result === null) {
            if (!assault.defenders.some(u => !u.dead)) assault.result = 'break';   // 守军全灭 = 攻方破寨
            else if (!assault.attackers.some(u => !u.dead)) assault.result = 'hold'; // 攻方全灭 = 守方守住
        }
        return assault.events;
    }

    return { assault, startAssault, resetAssault, stepAssault };
}
