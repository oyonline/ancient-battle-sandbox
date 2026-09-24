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
        antiCav: 2.5, scale: 1.0, tip: '站稳架枪、正面成阵才能抵挡骑兵冲锋'
    },
    archer: {
        name: '弓箭手', icon: '🏹', cost: 8, maxCount: 200,
        hp: 50, atk: 26, def: 3, speed: 2.2, atkSpeed: 2100, range: 9.5,
        ranged: true, scale: 1.0, tip: '远程输出，怕骑兵近身'
    },
    cavalry: {
        name: '重骑士', icon: '🐴', cost: 12, maxCount: 150,
        hp: 160, atk: 30, def: 15, speed: 4.0, atkSpeed: 1500, range: 1.1,
        chargeSpeed: 6.0, charge: true, scale: 1.35, tip: '助跑3格后双倍冲锋，擅长追击弓手'
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

// 架枪读本步快照：移动或转向会重置准备，成阵并站稳半秒后才有正面抗冲锋。
function updatePikeBrace(unit, dt) {
    if (unit.moraleState === 'routing' || unit.withdrawn) {
        unit.braceTime = 0; unit.braceReady = false; unit.braceHold = false;
        unit.braceSupport = 0; unit.braceDepth = 0;
        return;
    }
    // 身体分离是消除重叠的几何纠偏，不是主动行军或战斗击退。
    // 只扣除上一步的实际纠偏；moveToward / knockback 的位移仍会打断架枪。
    const vx = (unit.velX || 0) - (unit.separateX || 0) / dt;
    const vy = (unit.velY || 0) - (unit.separateY || 0) / dt;
    const speed = Math.hypot(vx, vy);
    if (unit.moving && speed > 0.15) {
        const fx = vx / speed, fy = vy / speed;
        if (fx * unit.braceFacingX + fy * unit.braceFacingY < 0.95) unit.braceTime = 0;
        unit.braceFacingX = fx; unit.braceFacingY = fy;
    }
    let support = 0, depth = 0, incoming = false, nearestEnemy = null, nearestDistance = Infinity;
    unit.scene.forEachNear(unit.gx, unit.gy, 6, other => {
        if (other === unit || other.dead || other.withdrawn || other.moraleState === 'routing') return;
        const dx = other.gx - unit.gx, dy = other.gy - unit.gy, distance = Math.hypot(dx, dy);
        if (other.team === unit.team && other.type === 'pikeman' && distance <= 2.6) {
            support++;
            if (dx * unit.braceFacingX + dy * unit.braceFacingY < -0.25) depth++;
        } else if (other.team !== unit.team && distance <= 6) {
            if (distance < nearestDistance - 1e-9 ||
                (Math.abs(distance - nearestDistance) <= 1e-9 && other.id < nearestEnemy.id)) {
                nearestEnemy = other; nearestDistance = distance;
            }
            if (other.type === 'cavalry' && (other.state === 'charge' || other.state === 'pierce') &&
                distance > 0.001 && (dx * unit.braceFacingX + dy * unit.braceFacingY) / distance >= 0.5) incoming = true;
        }
    });
    unit.braceSupport = support;
    unit.braceDepth = depth;
    // 在统一快照阶段判断：前方已停住的敌人需要补位，不能被它身后的来骑锁住。
    const nearestIsCharging = nearestEnemy?.type === 'cavalry' &&
        (nearestEnemy.state === 'charge' || nearestEnemy.state === 'pierce');
    unit.braceHold = support >= 2 && incoming && nearestIsCharging;
    unit.braceTime = support >= 2 && !unit.moving && speed <= 0.15 ? Math.min(0.5, unit.braceTime + dt) : 0;
    unit.braceReady = unit.braceTime >= 0.5 - 1e-9;
}

function isPreparedPike(guard, cavalry, dx, dy) {
    if (guard.withdrawn || guard.moraleState === 'routing') return false;
    if (guard.type !== 'pikeman' || !guard.braceReady || guard.braceSupport < 2) return false;
    const distance = dist(guard, cavalry);
    if (distance < 0.001) return false;
    const front = ((cavalry.gx - guard.gx) * guard.braceFacingX + (cavalry.gy - guard.gy) * guard.braceFacingY) / distance;
    return front >= 0.6 && -(dx * guard.braceFacingX + dy * guard.braceFacingY) >= 0.5;
}

// ==================== 骑兵 AI（简化状态机，索敌走场景空间哈希） ====================
class CavalryAI {
    update(unit, now, dt) {
        switch (unit.state) {
            case 'charge': return this.charge(unit, now, dt);
            case 'pierce': return this.pierce(unit, now, dt);
            case 'reform': return this.reform(unit, now, dt);
            case 'melee': return this.melee(unit, now, dt);
            default: this.beginCharge(unit); return true;
        }
    }

    beginCharge(unit) {
        unit.state = 'charge';
        unit.stateTime = 0;
        unit.chargeDistance = 0;
        unit.chargeLastX = null;
        unit.chargeMomentum = 0;
        unit.chargeImpactId = null;
        unit.pierceHits = null;
        unit.target = null;
        unit.lastRetarget = -Infinity;
    }

    enterMelee(unit) {
        unit.state = 'melee';
        unit.stateTime = 0;
        unit.chargeDistance = 0;
        unit.chargeLastX = null;
        unit.chargeMomentum = 0;
    }

    pickTarget(unit) {
        let best = null, bestD = Infinity;
        unit.scene.forEachNear(unit.gx, unit.gy, 12, enemy => {
            if (enemy.team === unit.team || enemy.dead || enemy.withdrawn || enemy.type !== 'archer') return;
            const d = dist(unit, enemy);
            if (d <= 12 && (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && enemy.id < best.id))) {
                bestD = d; best = enemy;
            }
        });
        return best || unit.scene.nearestEnemy(unit);
    }

    // 只对实际行进线上的身体或准备好的正面枪尖产生局部阻力。
    pathContact(unit, tx, ty, speed, dt) {
        const dx = tx - unit.gx, dy = ty - unit.gy, distance = Math.hypot(dx, dy);
        if (distance < 0.001) return null;
        const step = Math.min(distance, speed * movementSpeedMultiplier(unit, tx, ty) * dt);
        const nx = dx / distance, ny = dy / distance;
        let contact = null, bestD = Infinity;
        unit.scene.forEachNear(unit.gx, unit.gy, UNIT_TYPES.pikeman.range + step, enemy => {
            if (enemy.team === unit.team || enemy.dead || enemy.withdrawn || unit.pierceHits?.has(enemy.id)) return;
            const braced = isPreparedPike(enemy, unit, nx, ny);
            const reach = braced ? UNIT_TYPES.pikeman.range : 0.65;
            const ex = enemy.gx - unit.gx, ey = enemy.gy - unit.gy;
            const along = ex * nx + ey * ny;
            if (along < -0.01) return;
            const t = clamp(along, 0, step);
            if (Math.hypot(ex - nx * t, ey - ny * t) > reach) return;
            const d = Math.hypot(ex, ey);
            if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && enemy.id < contact.enemy.id)) {
                contact = { enemy, braced }; bestD = d;
            }
        });
        return contact;
    }

    impact(unit, target, braced, now, first) {
        if (!first && unit.pierceHits.size >= 4) return;
        if (first) {
            unit.scene.morale?.queueCharge(unit, target, braced);
            unit.lastAttack = now;
            unit.chargeImpactId = target.id;
            unit.pierceHits = new Set();
            unit.pierceX = clamp(target.gx + unit.chargeDX * 4 * unit.chargeMomentum, 1.5, GRID_W - 1.5);
            unit.pierceY = clamp(target.gy + unit.chargeDY * 4 * unit.chargeMomentum, 1.5, GRID_H - 1.5);
            unit.state = 'pierce'; unit.stateTime = 0;
            unit.chargeDistance = 0; unit.chargeLastX = null;
        }
        if (unit.pierceHits.has(target.id)) return;
        unit.pierceHits.add(target.id);
        // 首撞与迎击都入同一批伤害，不能因为受到阻力而吞掉骑兵的首撞。
        // 首撞保留已积累的真实动量；后续擦撞只随当前坡向变化，不重复吃阻力衰减。
        const slopeImpact = first ? unit.chargeMomentum :
            Terrain.movementMultiplier(unit.scene?.battleOptions?.terrain, unit.gx, unit.gy, unit.pierceX, unit.pierceY);
        resolveAttack(target, unit, { multiplier: (first ? 2 : 0.5) * slopeImpact });
        knockback(target, unit, (braced ? 0.14 : first ? 0.8 : 0.4) * slopeImpact);
        unit.scene.meleeImpact(unit, target);
        if (first) unit.scene.playAttackAnim(unit, target);
        if (braced && now - target.lastBrace >= 1000) {
            if (unit.scene.collectingImpacts) unit.scene.queueBrace(target, unit);
            else unit.scene.resolveBrace(target, unit);
        }
        const resistance = braced ? Math.min(1, 0.72 + 0.14 * Math.min(2, target.braceDepth))
            : target.type === 'archer' ? 0.16 : target.type === 'cavalry' ? 0.4 : 0.26;
        unit.chargeMomentum = Math.max(0, unit.chargeMomentum - resistance);
        if (unit.chargeMomentum <= 1e-9 || unit.pierceHits.size >= 4) this.enterMelee(unit);
    }

    charge(unit, now, dt) {
        if (unit.chargeLastX != null) {
            // 只累计上一步实际前进的距离，排斥、受阻和原地等待不能攒出冲锋。
            const forward = (unit.gx - unit.chargeLastX) * unit.chargeDX + (unit.gy - unit.chargeLastY) * unit.chargeDY;
            unit.chargeDistance += clamp(forward, 0, unit.chargeLastStep ?? UNIT_TYPES.cavalry.chargeSpeed * dt);
            unit.chargeLastX = null;
        }
        if (!unit.target || unit.target.dead || unit.target.withdrawn || (now - unit.lastRetarget >= 500 && dist(unit, unit.target) > 2)) {
            unit.target = this.pickTarget(unit);
            unit.lastRetarget = now;
        }
        if (!unit.target) return true;
        const target = unit.target, data = UNIT_TYPES.cavalry;
        const distance = dist(unit, target);
        const dx = distance > 0.001 ? (target.gx - unit.gx) / distance : 0;
        const dy = distance > 0.001 ? (target.gy - unit.gy) / distance : 0;
        // 即使新目标就在身边，也必须先检查助跑方向，不能原地掉头继承冲锋。
        if (distance <= 0.001 || (unit.chargeDX != null && dx * unit.chargeDX + dy * unit.chargeDY < 0.8)) unit.chargeDistance = 0;
        unit.chargeDX = dx; unit.chargeDY = dy;
        unit.chargeMomentum = clamp(unit.chargeDistance / 3, 0, 1) *
            Terrain.movementMultiplier(unit.scene?.battleOptions?.terrain, unit.gx, unit.gy, target.gx, target.gy);
        const contact = this.pathContact(unit, target.gx, target.gy, data.chargeSpeed, dt);
        if (contact) {
            // 接触挡路身体就结束助跑，不能顶着前排继续追弓并攒出双倍冲锋。
            if (unit.chargeDistance < 3 || now - unit.lastAttack < data.atkSpeed) {
                this.enterMelee(unit);
                return false;
            }
            this.impact(unit, contact.enemy, contact.braced, now, true);
            return true;
        }
        if (distance <= data.range + 0.25) {
            if (unit.chargeDistance < 3 || now - unit.lastAttack < data.atkSpeed) {
                this.enterMelee(unit);
                return false;
            }
            this.impact(unit, target, isPreparedPike(target, unit, dx, dy), now, true);
            return true;
        }
        unit.chargeLastX = unit.gx; unit.chargeLastY = unit.gy;
        unit.chargeLastStep = data.chargeSpeed * movementSpeedMultiplier(unit, target.gx, target.gy) * dt;
        moveToward(unit, target.gx, target.gy, data.chargeSpeed, dt, 'charge');
        unit.scene.chargeDust(unit);
        return true;
    }

    pierce(unit, now, dt) {
        unit.stateTime += dt;
        if (Math.hypot(unit.pierceX - unit.gx, unit.pierceY - unit.gy) < 0.5 || unit.stateTime > 1.5) {
            unit.state = 'reform'; unit.stateTime = 0; unit.reformX = null;
            return true;
        }
        unit.chargeMomentum = Math.max(0, unit.chargeMomentum - dt * 0.12);
        const speed = UNIT_TYPES.cavalry.chargeSpeed * 0.85 * (0.5 + unit.chargeMomentum * 0.5);
        const contact = this.pathContact(unit, unit.pierceX, unit.pierceY, speed, dt);
        if (contact) this.impact(unit, contact.enemy, contact.braced, now, false);
        if (unit.state === 'melee') return true;
        if (unit.chargeMomentum <= 0) { this.enterMelee(unit); return true; }
        moveToward(unit, unit.pierceX, unit.pierceY, speed, dt, 'charge');
        unit.scene.chargeDust(unit);
        return true;
    }

    melee(unit, now, dt) {
        unit.stateTime += dt;
        const enemy = unit.scene.nearestEnemy(unit);
        if (!enemy) return true;
        if (dist(unit, enemy) > 3 && unit.stateTime >= 2) {
            this.beginCharge(unit);
            return true;
        }
        if (unit.stateTime >= 3) {
            let nearby = 0, spears = false;
            unit.scene.forEachNear(unit.gx, unit.gy, 2.2, other => {
                if (other.team === unit.team || other.dead || other.withdrawn || other.moraleState === 'routing' || dist(unit, other) > 2.2) return;
                nearby++; spears ||= other.type === 'pikeman';
            });
            if (nearby <= 2 && !spears) {
                unit.state = 'reform'; unit.stateTime = 0; unit.reformX = null;
                return true;
            }
        }
        return false;
    }

    reform(unit, now, dt) {
        unit.stateTime += dt;
        if (unit.reformX == null) {
            const center = unit.scene.centroid[unit.team === 'red' ? 'blue' : 'red'];
            const angle = Math.atan2(unit.gy - center.y, unit.gx - center.x);
            unit.reformX = clamp(unit.gx + Math.cos(angle) * 4.5, 1.6, GRID_W - 1.6);
            unit.reformY = clamp(unit.gy + Math.sin(angle) * 4.5, 1.5, GRID_H - 1.5);
        }
        const enemy = unit.scene.nearestEnemy(unit);
        if (!enemy) return true;
        if (dist(unit, enemy) >= 3 && unit.stateTime >= 0.8) {
            this.beginCharge(unit);
            return true;
        }
        if (unit.stateTime > 2.2) { this.enterMelee(unit); return false; }
        moveToward(unit, unit.reformX, unit.reformY, 2.6, dt);
        return true;
    }
}

// ==================== 通用工具 ====================
function td() { return UNIT_TYPES.cavalry; }
function dist(a, b) { return Math.hypot(a.gx - b.gx, a.gy - b.gy); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// 单位专属确定性伪随机（LCG）：微走位等行为抖动不再用 Math.random，
// 固定步长模拟的同阵容重放与红蓝镜像对照保持一致。
// 种子惰性按"当前位置"播种：镜像局中换边配对单位取 min(gx,70-gx) 量化必然同种子，
// 且不受部署指令造成的出生站位差异影响（同一逻辑单位换指令序列不变）。
function unitRand(unit) {
    if (unit.randSeed == null) {
        const mxq = Math.round(Math.min(unit.gx, GRID_W - unit.gx) * 256);
        const myq = Math.round(unit.gy * 256);
        let tc = 0; for (let i = 0; i < unit.type.length; i++) tc = (tc * 31 + unit.type.charCodeAt(i)) | 0;
        unit.randSeed = ((mxq * 73856093) ^ (myq * 19349663) ^ tc) >>> 0;
    }
    unit.randSeed = (Math.imul(unit.randSeed, 1664525) + 1013904223) >>> 0;
    return unit.randSeed / 4294967296;
}

function movementSpeedMultiplier(unit, tx, ty) {
    const dx = tx - unit.gx, dy = ty - unit.gy;
    // 动摇时只放缓向前推进；战术后退与溃逃不受这项限制。
    const advancing = dx * (unit.moraleFacingX || 0) + dy * (unit.moraleFacingY || 0) > 0;
    const caution = unit.moraleState === 'wavering' && advancing ? 0.85 : 1;
    return caution * Terrain.movementMultiplier(unit.scene?.battleOptions?.terrain, unit.gx, unit.gy, tx, ty);
}

function moveToward(unit, tx, ty, speed, dt, movement = 'walk') {
    const dx = tx - unit.gx, dy = ty - unit.gy;
    const d = Math.hypot(dx, dy);
    if (d < 0.001) return;
    if (movement === 'walk') speed = CombatRules.walkingSpeed(unit, speed);
    const step = Math.min(d, speed * movementSpeedMultiplier(unit, tx, ty) * dt);
    const intended = { x: dx / d * step, y: dy / d * step };
    const motion = movement === 'walk' ? CombatRules.constrainWalk(unit, intended.x, intended.y) : intended;
    if (unit.scene && unit.scene.planningStep) {
        unit.moveX = motion.x;
        unit.moveY = motion.y;
    } else {
        unit.gx += motion.x;
        unit.gy += motion.y;
    }
    unit.moving = Math.hypot(motion.x, motion.y) > 0.0001;
    unit.pressX = dx / d; unit.pressY = dy / d;   // 记录通行意图，供 separate 推挤传导
}

function knockback(target, from, amount) {
    if (target.tacticalRole === 'guard' && amount > 0) {
        target.guardReady = false; target.guardStableTime = 0;
        target.braceReady = false; target.braceTime = 0; target.braceHold = false;
    }
    const a = Math.atan2(target.gy - from.gy, target.gx - from.gx);
    if (target.scene && target.scene.planningStep) {
        target.pushX += Math.cos(a) * amount;
        target.pushY += Math.sin(a) * amount;
        return;
    }
    target.gx = clamp(target.gx + Math.cos(a) * amount, 1.45, GRID_W - 1.45);
    target.gy = clamp(target.gy + Math.sin(a) * amount, 1.45, GRID_H - 1.45);
}

// 所有攻击都先由原始攻击力结算一次倍率、一次护甲；applyDamage 只接收最终伤害。
function calculateAttackDamage(from, target, { multiplier = 1, rawAttack = from.typeData.atk } = {}) {
    const counter = from.type === 'pikeman' && target.type === 'cavalry' ? UNIT_TYPES.pikeman.antiCav : 1;
    return Math.max(1, Math.floor(rawAttack * multiplier * counter - target.typeData.def));
}

function resolveAttack(target, from, options = {}) {
    if (target.dead || target.withdrawn || target.hp <= 0) return 0;
    const scene = target.scene;
    const formationMultiplier = scene?.tactics?.incomingMultiplier(from, target) ?? 1;
    const terrainMultiplier = Terrain.attackMultiplier(scene?.battleOptions?.terrain, from, target, options.sourceHeight);
    const damage = calculateAttackDamage(from, target, {
        ...options, multiplier: (options.multiplier ?? 1) * formationMultiplier * terrainMultiplier
    });
    const attackStartedAt = options.attackStartedAt ?? scene?.simulationTime;
    if (scene && scene.collectingImpacts) {
        scene.battleImpacts.push({ target, damage, from, attackStartedAt });
        return damage;
    }
    return applyDamage(target, damage, from, attackStartedAt);
}

function applyDamage(target, dmg, from, attackStartedAt) {
    if (target.dead || target.withdrawn || target.hp <= 0 || !Number.isFinite(dmg) || dmg <= 0) return 0;
    const scene = target.scene;
    if (scene && (target.battleId !== scene.battleId || (from && from.battleId !== scene.battleId))) return 0;
    const effectiveDamage = Math.min(target.hp, dmg);
    target.hp = Math.max(0, target.hp - dmg);
    target.flashUntil = (scene ? scene.simulationTime : 0) + 130;
    if (scene) {
        scene.recordDamage(target, effectiveDamage, from, attackStartedAt);
        scene.morale?.queueDamage(target, effectiveDamage);
    }
    if (target.hp <= 0 && !target.dead) {
        target.dead = true;
        if (scene) {
            scene.morale?.queueDeath(target);
            scene.recordDeath(target, from);
            scene.killUnit(target, from);
        }
    }
    return effectiveDamage;
}
