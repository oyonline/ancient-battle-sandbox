// ==================== 兵种定义（网格坐标系：1格=1个菱形块） ====================
// 亲子版数值：节奏比原仓库快一些，弓箭手攻击间隔缩短
const UNIT_TYPES = {
    infantry: {
        name: '剑士', icon: '⚔️', cost: 5, maxCount: 30,
        hp: 100, atk: 16, def: 10, speed: 1.7, atkSpeed: 1000, range: 0.95,
        scale: 1.0, tip: '均衡耐用，人数就是正义'
    },
    pikeman: {
        name: '长枪兵', icon: '🔱', cost: 6, maxCount: 20,
        hp: 80, atk: 18, def: 8, speed: 1.3, atkSpeed: 2400, range: 1.35,
        antiCav: 2.5, scale: 1.0, tip: '专克骑兵！枪阵是马的噩梦'
    },
    archer: {
        name: '弓箭手', icon: '🏹', cost: 8, maxCount: 20,
        hp: 50, atk: 26, def: 3, speed: 1.7, atkSpeed: 2100, range: 9.5,
        ranged: true, scale: 1.0, tip: '远程输出，怕骑兵近身'
    },
    cavalry: {
        name: '重骑士', icon: '🐴', cost: 12, maxCount: 15,
        hp: 160, atk: 30, def: 15, speed: 3.2, atkSpeed: 1500, range: 1.1,
        chargeSpeed: 4.8, charge: true, scale: 1.15, tip: '冲锋双倍伤害，专抓弓箭手'
    }
};

// ==================== 阵型定义（rows: 前排→后排的兵种优先级） ====================
const FORMATIONS = {
    custom:  { name: '自由队形', rows: ['infantry', 'pikeman', 'archer', 'cavalry'] },
    square:  { name: '方阵',   rows: ['infantry', 'cavalry', 'pikeman', 'archer'] },
    wedge:   { name: '锋矢阵', rows: ['cavalry', 'infantry', 'pikeman', 'archer'] },
    mixed:   { name: '混合阵', rows: ['infantry', 'cavalry', 'archer', 'pikeman'] },
    line:    { name: '长蛇阵', rows: ['infantry', 'pikeman', 'cavalry', 'archer'] }
};

// 初始预算
const BUDGET = 100;

// ==================== 生成一支军队的网格站位 ====================
// team: 'red'(左,朝右) / 'blue'(右,朝左)
function generateArmyPositions(team, config, formationKey) {
    const formation = FORMATIONS[formationKey] || FORMATIONS.custom;
    const remaining = { ...config };
    const positions = [];

    const COLS = 10;              // 每排宽度（占格数）
    const MAX_ROWS = 8;
    const gyCenter = GRID_H / 2;  // 垂直居中
    const frontGX = team === 'red' ? 7 : GRID_W - 7;   // 前排格子（靠边部署，留出中间开阔地）
    const dir = team === 'red' ? -1 : 1;               // 后排延伸方向

    for (let row = 0; row < MAX_ROWS; row++) {
        // 本排兵种 = 阵型 rows 顺序循环
        const primary = formation.rows[row % formation.rows.length];
        for (let col = 0; col < COLS; col++) {
            // 两侧优先放骑兵/长枪（翼），中间放主兵种
            let type = primary;
            const isWing = (col === 0 || col === COLS - 1);
            if (isWing) {
                const wing = ['cavalry', 'pikeman'].find(t => remaining[t] > 0);
                if (wing && row >= 1) type = wing;
            }
            if (remaining[type] > 0) {
                remaining[type]--;
                positions.push({
                    type,
                    gx: frontGX + dir * row * 0.95,
                    gy: gyCenter + (col - (COLS - 1) / 2) * 0.62
                });
            }
        }
    }
    // 溢出兵种堆在最后
    Object.keys(remaining).forEach(type => {
        for (let i = 0; i < remaining[type]; i++) {
            const row = MAX_ROWS + Math.floor(i / COLS);
            const col = i % COLS;
            positions.push({
                type,
                gx: frontGX + dir * row * 0.95,
                gy: gyCenter + (col - (COLS - 1) / 2) * 0.62
            });
        }
    });
    return positions;
}

// ==================== 骑兵 AI（简化状态机） ====================
class CavalryAI {
    // 返回 true 表示已处理本帧
    update(unit, enemies, now, dt) {
        switch (unit.state) {
            case 'charge':   return this.charge(unit, enemies, now, dt);
            case 'pierce':   return this.pierce(unit, enemies, now, dt);
            case 'reform':   return this.reform(unit, enemies, now, dt);
            case 'melee':    return false; // 交还给通用近战逻辑
            default:         unit.state = 'charge'; return true;
        }
    }

    pickTarget(unit, enemies) {
        // 优先切弓箭手（12格内），否则最近敌人
        let best = null, bestD = Infinity;
        enemies.forEach(e => {
            if (e.type !== 'archer') return;
            const d = dist(unit, e);
            if (d < 12 && d < bestD) { bestD = d; best = e; }
        });
        if (best) return best;
        enemies.forEach(e => {
            const d = dist(unit, e);
            if (d < bestD) { bestD = d; best = e; }
        });
        return best;
    }

    charge(unit, enemies, now, dt) {
        if (!unit.target || unit.target.hp <= 0) unit.target = this.pickTarget(unit, enemies);
        if (!unit.target) return true;
        const t = unit.target;
        const d = dist(unit, t);
        const td = UNIT_TYPES.cavalry;

        if (d <= td.range + 0.25) {
            // 撞击：双倍伤害 + 击退
            if (now - unit.lastAttack > td.atkSpeed) {
                unit.lastAttack = now;
                let dmg = Math.max(2, td.atk * 2 - t.typeData.def);
                applyDamage(t, dmg, unit);
                knockback(t, unit, 0.45);
                unit.scene.meleeImpact(unit, t);
                // 长枪兵迎击：冲锋撞上枪阵会挨反击（克制可见化）
                if (t.type === 'pikeman' && !t.dead) {
                    applyDamage(unit, Math.max(3, Math.floor(t.typeData.atk * 2.5 - td.def * 0.5)), t);
                }
                // 凿穿：目标后方5.5格
                const a = Math.atan2(t.gy - unit.gy, t.gx - unit.gx);
                unit.pierceX = clamp(t.gx + Math.cos(a) * 5.5, 1.5, GRID_W - 1.5);
                unit.pierceY = clamp(t.gy + Math.sin(a) * 5.5, 1.5, GRID_H - 1.5);
                unit.state = 'pierce';
                unit.stateTime = 0;
                unit.lastContact = 0;
            }
            return true;
        }
        moveToward(unit, t.gx, t.gy, td.chargeSpeed, dt);
        unit.scene.chargeDust(unit);
        return true;
    }

    pierce(unit, enemies, now, dt) {
        unit.stateTime += dt;
        const d = Math.hypot(unit.pierceX - unit.gx, unit.pierceY - unit.gy);
        if (d < 0.5 || unit.stateTime > 2.5) {
            unit.state = 'reform'; unit.stateTime = 0;
            return true;
        }
        moveToward(unit, unit.pierceX, unit.pierceY, td().chargeSpeed * 0.85, dt);

        // 冲撞沿途伤害（每0.3秒）
        if (now - unit.lastContact > 300) {
            unit.lastContact = now;
            enemies.forEach(e => {
                if (dist(unit, e) < 0.75) {
                    applyDamage(e, Math.max(1, Math.floor(td().atk * 0.5 - e.typeData.def)), unit);
                    // 枪阵刺伤：硬闯长枪阵，马自己也要掉血
                    if (e.type === 'pikeman' && !unit.dead) applyDamage(unit, 6, e);
                }
            });
        }
        // 被围困 → 转近战
        const around = enemies.filter(e => dist(unit, e) < 1.15).length;
        if (around >= 3 && unit.stateTime > 0.8) {
            unit.state = 'melee';
        }
        unit.scene.chargeDust(unit);
        return true;
    }

    reform(unit, enemies, now, dt) {
        unit.stateTime += dt;
        if (!unit.reformX || unit.stateTime === 0) {
            // 远离敌人重心4.5格
            let cx = 0, cy = 0, n = 0;
            enemies.forEach(e => { cx += e.gx; cy += e.gy; n++; });
            if (n > 0) { cx /= n; cy /= n; }
            const a = Math.atan2(unit.gy - cy, unit.gx - cx);
            unit.reformX = clamp(unit.gx + Math.cos(a) * 4.5, 1.6, GRID_W - 1.6);
            unit.reformY = clamp(unit.gy + Math.sin(a) * 4.5, 1.5, GRID_H - 1.5);
        }
        const d = Math.hypot(unit.reformX - unit.gx, unit.reformY - unit.gy);
        if (d < 0.6 || unit.stateTime > 1.8) {
            unit.state = 'charge';
            unit.stateTime = 0;
            unit.reformX = null;
            return true;
        }
        moveToward(unit, unit.reformX, unit.reformY, 2.2, dt);
        return true;
    }
}

// ==================== 通用工具 ====================
function td() { return UNIT_TYPES.cavalry; }
function dist(a, b) { return Math.hypot(a.gx - b.gx, a.gy - b.gy); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function moveToward(unit, tx, ty, speed, dt) {
    const dx = tx - unit.gx, dy = ty - unit.gy;
    const d = Math.hypot(dx, dy);
    if (d < 0.001) return;
    unit.gx += (dx / d) * speed * dt;
    unit.gy += (dy / d) * speed * dt;
    unit.moving = true;
}

function knockback(target, from, amount) {
    const a = Math.atan2(target.gy - from.gy, target.gx - from.gx);
    target.gx = clamp(target.gx + Math.cos(a) * amount, 1.45, GRID_W - 1.45);
    target.gy = clamp(target.gy + Math.sin(a) * amount, 1.45, GRID_H - 1.45);
}

function applyDamage(target, dmg, from) {
    // 长枪兵对骑兵加成（亲子版强化：克制要看得见）
    if (from && from.type === 'pikeman' && target.type === 'cavalry') {
        dmg = Math.max(2, Math.floor(dmg * UNIT_TYPES.pikeman.antiCav - target.typeData.def * 0.5));
    }
    target.hp -= dmg;
    target.flashUntil = (target.scene ? target.scene.time.now : 0) + 90;
    if (target.hp <= 0 && !target.dead) {
        target.dead = true;
        if (target.scene) target.scene.killUnit(target);
    }
}
