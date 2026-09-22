// ==================== 兵种定义（网格坐标系：1格=1个菱形块） ====================
// 70×70 大地图：上限与预算支持 500 vs 500，行军速度按地图尺度上调
const UNIT_TYPES = {
    infantry: {
        name: '剑士', icon: '⚔️', cost: 5, maxCount: 400,
        hp: 100, atk: 16, def: 10, speed: 2.2, atkSpeed: 1000, range: 0.95,
        scale: 1.0, tip: '均衡耐用，人数就是正义'
    },
    pikeman: {
        name: '长枪兵', icon: '🔱', cost: 6, maxCount: 150,
        hp: 80, atk: 18, def: 8, speed: 1.6, atkSpeed: 2400, range: 1.35,
        antiCav: 2.5, scale: 1.0, tip: '专克骑兵！枪阵是马的噩梦'
    },
    archer: {
        name: '弓箭手', icon: '🏹', cost: 8, maxCount: 200,
        hp: 50, atk: 26, def: 3, speed: 2.2, atkSpeed: 2100, range: 9.5,
        ranged: true, scale: 1.0, tip: '远程输出，怕骑兵近身'
    },
    cavalry: {
        name: '重骑士', icon: '🐴', cost: 12, maxCount: 150,
        hp: 160, atk: 30, def: 15, speed: 4.0, atkSpeed: 1500, range: 1.1,
        chargeSpeed: 6.0, charge: true, scale: 1.35, tip: '冲锋双倍伤害，专抓弓箭手'
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

// 千人军团预算：满配 500 人约 3200 金
const BUDGET = 4000;

// ==================== 生成一支军队的网格站位 ====================
// team: 'red'(左,朝右) / 'blue'(右,朝左)
// 大军团自动展开：列数随总兵力自适应（≈√(兵力×1.6)），纵向 1.35 格间距，
// 行深按"前排线→地图边缘"的可用纵深自适应压缩（无论配多少兵都不出界），
// 两翼放骑兵/长枪；本排兵种耗尽时列内自动替补，保证每行尽量放满不空转。
function generateArmyPositions(team, config, formationKey) {
    const formation = FORMATIONS[formationKey] || FORMATIONS.custom;
    const remaining = { ...config };
    const positions = [];

    const total = Object.values(remaining).reduce((a, b) => a + b, 0);
    if (total === 0) return positions;

    const COLS = clamp(Math.ceil(Math.sqrt(total * 1.6)), 8, 42);
    const gySpan = 1.35;
    const gyCenter = GRID_H / 2;
    const frontGX = team === 'red' ? 16 : GRID_W - 16;   // 前排线，中间留开阔地
    const dir = team === 'red' ? -1 : 1;                 // 后排延伸方向
    const depthAvail = team === 'red' ? frontGX - 2.5 : (GRID_W - 2.5) - frontGX;
    const rowsEst = Math.ceil(total / COLS);
    const rowStep = Math.min(0.8, depthAvail / Math.max(rowsEst - 1, 1));
    const maxRows = rowsEst + 2;
    const order = formation.rows;

    for (let row = 0; row < maxRows; row++) {
        // 本排兵种 = 阵型 rows 顺序循环；没了就取顺序里下一个还有余量的（不空转）
        const primary = order[row % order.length];
        for (let col = 0; col < COLS; col++) {
            // 两侧优先放骑兵/长枪（翼），中间放主兵种
            let type = null;
            const isWing = (col === 0 || col === COLS - 1);
            if (isWing && row >= 1) {
                type = ['cavalry', 'pikeman'].find(t => remaining[t] > 0) || null;
            }
            if (!type) {
                type = remaining[primary] > 0 ? primary : order.find(k => remaining[k] > 0) || null;
            }
            if (type) {
                remaining[type]--;
                positions.push({
                    type,
                    gx: frontGX + dir * row * rowStep,
                    gy: gyCenter + (col - (COLS - 1) / 2) * gySpan
                });
            }
        }
        if (Object.values(remaining).every(n => n <= 0)) break;
    }
    return positions;
}

// ==================== 骑兵 AI（简化状态机，索敌走场景空间哈希） ====================
class CavalryAI {
    // 返回 true 表示已处理本帧
    update(unit, now, dt) {
        switch (unit.state) {
            case 'charge':   return this.charge(unit, now, dt);
            case 'pierce':   return this.pierce(unit, now, dt);
            case 'reform':   return this.reform(unit, now, dt);
            case 'melee':    return false; // 交还给通用近战逻辑
            default:         unit.state = 'charge'; return true;
        }
    }

    pickTarget(unit) {
        const scene = unit.scene;
        // 优先切弓箭手（12格内），否则最近敌人
        let best = null, bestD = Infinity;
        scene.forEachNear(unit.gx, unit.gy, 12, e => {
            if (e.team === unit.team || e.dead || e.type !== 'archer') return;
            const d = dist(unit, e);
            if (d < bestD) { bestD = d; best = e; }
        });
        if (best) return best;
        return scene.nearestEnemy(unit);
    }

    charge(unit, now, dt) {
        if (!unit.target || unit.target.dead || unit.target.hp <= 0) unit.target = this.pickTarget(unit);
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
                unit.scene.playAttackAnim(unit);
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

    pierce(unit, now, dt) {
        unit.stateTime += dt;
        const d = Math.hypot(unit.pierceX - unit.gx, unit.pierceY - unit.gy);
        if (d < 0.5 || unit.stateTime > 2.5) {
            unit.state = 'reform'; unit.stateTime = 0;
            return true;
        }
        moveToward(unit, unit.pierceX, unit.pierceY, td().chargeSpeed * 0.85, dt);

        // 冲撞沿途伤害（每0.3秒，只查身边一格半内的敌人）
        if (now - unit.lastContact > 300) {
            unit.lastContact = now;
            unit.scene.forEachNear(unit.gx, unit.gy, 0.75, e => {
                if (e.team === unit.team || e.dead || dist(unit, e) >= 0.75) return;
                applyDamage(e, Math.max(1, Math.floor(td().atk * 0.5 - e.typeData.def)), unit);
                // 枪阵刺伤：硬闯长枪阵，马自己也要掉血
                if (e.type === 'pikeman' && !unit.dead) applyDamage(unit, 6, e);
            });
        }
        // 被围困 → 转近战
        let around = 0;
        unit.scene.forEachNear(unit.gx, unit.gy, 1.15, e => {
            if (e.team !== unit.team && !e.dead && dist(unit, e) < 1.15) around++;
        });
        if (around >= 3 && unit.stateTime > 0.8) unit.state = 'melee';
        unit.scene.chargeDust(unit);
        return true;
    }

    reform(unit, now, dt) {
        unit.stateTime += dt;
        if (!unit.reformX || unit.stateTime === 0) {
            // 远离敌方重心4.5格（重心由场景每帧聚合，O(1) 拿到）
            const c = unit.scene.centroid[unit.team === 'red' ? 'blue' : 'red'];
            const a = Math.atan2(unit.gy - c.y, unit.gx - c.x);
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
        moveToward(unit, unit.reformX, unit.reformY, 2.6, dt);
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
    target.flashUntil = (target.scene ? target.scene.time.now : 0) + 130;
    if (target.hp <= 0 && !target.dead) {
        target.dead = true;
        if (target.scene) target.scene.killUnit(target);
    }
}
