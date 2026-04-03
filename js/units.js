// ==================== 预设阵型定义 ====================
const FORMATIONS = {
    custom: {
        name: '自定义',
        description: '按兵种顺序排列',
        rows: null // null 表示使用原来自定义逻辑
    },
    square: {
        name: '方阵',
        description: '步兵前排，长枪侧翼，弓箭中后，骑兵两翼',
        rows: ['infantry', 'cavalry', 'pikeman', 'archer'],
        priority: ['infantry', 'cavalry', 'pikeman', 'archer']
    },
    wedge: {
        name: '锋矢阵',
        description: '骑兵前锋，步兵跟进，弓箭后援',
        rows: ['cavalry', 'infantry', 'pikeman', 'archer'],
        priority: ['cavalry', 'infantry', 'pikeman', 'archer']
    },
    mixed: {
        name: '混合阵',
        description: '步兵中前，骑兵侧翼，长枪保护，弓箭居中',
        rows: ['infantry', 'cavalry', 'pikeman', 'archer'],
        priority: ['infantry', 'cavalry', 'archer', 'pikeman']
    },
    line: {
        name: '长蛇阵',
        description: '一字长蛇，步兵在前，层层递进',
        rows: ['infantry', 'pikeman', 'cavalry', 'archer'],
        priority: ['infantry', 'pikeman', 'cavalry', 'archer']
    }
};

// ==================== 单位类型定义 ====================
const UNIT_TYPES = {
    // hp: 生命值, atk: 攻击力, def: 防御力
    // speed: 移动速度, atkSpeed: 攻击间隔(毫秒), range: 攻击范围
    // size: 单位大小(像素), color: 颜色, shape: 形状

    infantry: { 
        name: '步兵', hp: 100, atk: 16, def: 10, speed: 40, atkSpeed: 1000, range: 1.2,
        size: 5, color: 0xffffff, shape: 'square' 
    },
    pikeman: { 
        name: '长枪兵', hp: 80, atk: 18, def: 8, speed: 30, atkSpeed: 3000, range: 2.2,
        size: 5, color: 0xffffaa, shape: 'rect', antiCav: 1.5  // 对骑兵加成减少到1.5倍（原2.5倍减40%）
    },
    archer: { 
        name: '弓箭手', hp: 50, atk: 20, def: 3, speed: 40, atkSpeed: 6500, range: 40,
        size: 3, color: 0xaaffaa, shape: 'circle', ranged: true
    },
    cavalry: { 
        name: '骑兵', hp: 160, atk: 30, def: 15, speed: 100, atkSpeed: 1500, range: 1.4,
        size: 8, color: 0xffaa88, shape: 'triangle', charge: true
    }
};

// ==================== 骑兵 AI 状态机 ====================
class CavalryAI {
    constructor(scene) {
        this.scene = scene;
    }

    update(unit, enemies, now, dt, cellSize) {
        const { nearest, minDist } = this.findNearestEnemy(unit, enemies);
        
        // 如果在回调整备但没有敌人了，结束回调整备
        if (!nearest && unit.isReforming) {
            unit.isReforming = false;
            unit.hasCharged = false;
            return;
        }
        
        if (!nearest) return;
        
        const attackRange = unit.typeData.range * cellSize;
        const maxSpeed = unit.typeData.speed * 1.5;  // 最高150%速度
        
        // 【方案A】骑兵优先攻击弓箭手（切后排）
        let target = nearest;
        let targetDist = minDist;
        
        // 在射程内找弓箭手
        const archersInRange = enemies.filter(e => 
            e.type === 'archer' && 
            e.hp > 0 && 
            Phaser.Math.Distance.Between(unit.x, unit.y, e.x, e.y) <= attackRange * 1.5
        );
        
        if (archersInRange.length > 0) {
            // 有弓箭手在射程内，优先攻击最近的弓箭手
            archersInRange.sort((a, b) => {
                const distA = Phaser.Math.Distance.Between(unit.x, unit.y, a.x, a.y);
                const distB = Phaser.Math.Distance.Between(unit.x, unit.y, b.x, b.y);
                return distA - distB;
            });
            target = archersInRange[0];
            targetDist = Phaser.Math.Distance.Between(unit.x, unit.y, target.x, target.y);
        }
        
        // 状态0：被困住（被步兵包围，无法冲锋）
        if (unit.isTrapped) {
            return this.handleTrapped(unit, enemies, now, dt, cellSize);
        }
        
        // 【方向D】状态：脱困逃跑（直接跑，不绕路）
        if (unit.isEscaping) {
            return this.handleEscaping(unit, enemies, dt, cellSize);
        }
        
        // 状态1：回调整备（凿穿后拉开距离）
        if (unit.isReforming) {
            return this.handleReforming(unit, nearest, dt, cellSize);
        }
        
        // 【方案A】如果优先目标是弓箭手，直接冲锋/攻击它
        if (target.type === 'archer' && targetDist > attackRange * 0.8) {
            return this.handleCharging(unit, target, dt, maxSpeed);
        }
        
        if (target.type === 'archer' && targetDist <= attackRange * 0.8) {
            return this.handleImpact(unit, target, now, maxSpeed);
        }
        
        // 【修改】冲锋时只考虑前方的敌人（非弓箭手目标）
        const { nearest: frontEnemy, minDist: frontDist } = this.findNearestEnemyInFront(unit, enemies);
        
        // 状态2：冲锋接近（前方有敌人且距离足够）
        if (frontEnemy && frontDist > attackRange * 0.8) {
            return this.handleCharging(unit, frontEnemy, dt, maxSpeed);
        }
        
        // 状态3：撞击并凿穿（前方敌人在攻击范围内）
        if (frontEnemy && frontDist <= attackRange * 0.8) {
            return this.handleImpact(unit, frontEnemy, now, maxSpeed);
        }
        
        // 前方没有敌人，但周围有敌人（敌人可能在背后）
        // 先转向前方最近的敌人，不冲锋
        if (nearest && minDist <= attackRange * 2) {
            // 转向最近的敌人（不管前后）
            const angleToEnemy = Phaser.Math.Angle.Between(unit.x, unit.y, nearest.x, nearest.y);
            this.scene.smoothRotate(unit, angleToEnemy + Math.PI/2, dt * 5);
            return true;
        }
    }

    findNearestEnemy(unit, enemies) {
        let nearest = null;
        let minDist = Infinity;
        
        enemies.forEach(enemy => {
            const dist = Phaser.Math.Distance.Between(unit.x, unit.y, enemy.x, enemy.y);
            if (dist < minDist) {
                minDist = dist;
                nearest = enemy;
            }
        });
        
        return { nearest, minDist };
    }
    
    // 【新增】找前方最近的敌人（用于冲锋判定）
    findNearestEnemyInFront(unit, enemies, frontAngle = Math.PI * 0.6) {
        let nearest = null;
        let minDist = Infinity;
        
        // 获取骑兵当前朝向（弧度）
        const facingAngle = unit.container.rotation - Math.PI / 2;
        
        enemies.forEach(enemy => {
            const dist = Phaser.Math.Distance.Between(unit.x, unit.y, enemy.x, enemy.y);
            
            // 计算敌人相对于骑兵的角度
            const angleToEnemy = Phaser.Math.Angle.Between(unit.x, unit.y, enemy.x, enemy.y);
            const angleDiff = Math.abs(Phaser.Math.Angle.Wrap(angleToEnemy - facingAngle));
            
            // 只考虑前方的敌人（默认前方120度范围）
            if (angleDiff < frontAngle / 2 && dist < minDist) {
                minDist = dist;
                nearest = enemy;
            }
        });
        
        return { nearest, minDist };
    }

    // 【方向D】被困住状态：缺口检测 + 直接脱困逃跑
    handleTrapped(unit, enemies, now, dt, cellSize) {
        // 挣扎动画效果
        unit.trappedStrugglePhase = (unit.trappedStrugglePhase || 0) + dt * 10;
        const struggleOffset = Math.sin(unit.trappedStrugglePhase) * 1.5;
        const struggleRotate = Math.sin(unit.trappedStrugglePhase * 0.7) * 0.1;
        
        // 突围机制：有几率强行突围
        if (!unit.breakoutCooldown || now - unit.breakoutCooldown > 2000) {
            if (Math.random() < 0.2) {
                unit.breakoutCooldown = now;
                const breakoutAngle = this.findBreakoutDirection(unit, enemies);
                
                unit.isTrapped = false;
                unit.passingThrough = true;
                unit.passTimer = 0;
                unit.chargeAngle = breakoutAngle;
                unit.currentSpeed = unit.typeData.speed * 0.8;
                unit.hp -= 10;
                
                return true;
            }
        }
        
        // 【方向D】脱困逻辑：找到最畅通的方向直接跑
        const bestEscapeDir = this.findBestEscapeDirection(unit, enemies, 60);
        
        if (bestEscapeDir.open) {
            // 有缺口！直接脱困逃跑
            unit.isTrapped = false;
            // 不进入回调整备，直接进入"脱困逃跑"状态
            unit.isEscaping = true;
            unit.escapeAngle = bestEscapeDir.angle;
            unit.escapeTimer = 0;
            unit.currentSpeed = unit.typeData.speed; // 100%速度逃跑
            return true;
        }
        
        // 没有明显缺口，继续近战缠斗
        // 找最近的敌人
        let nearest = null;
        let minDist = Infinity;
        enemies.forEach(enemy => {
            const dist = Phaser.Math.Distance.Between(unit.x, unit.y, enemy.x, enemy.y);
            if (dist < minDist) {
                minDist = dist;
                nearest = enemy;
            }
        });
        
        if (!nearest) {
            // 周围没敌人了，脱困
            unit.isTrapped = false;
            unit.isReforming = true;
            unit.reformTimer = 0;
            return true;
        }
        
        if (minDist <= unit.typeData.range * cellSize) {
            // 攻击间隔变长
            const trappedAtkSpeed = unit.typeData.atkSpeed * 1.3;
            if (now - unit.lastAttack > trappedAtkSpeed) {
                unit.lastAttack = now;
                
                // 【方案D】计算围攻人数（30像素内的敌人）
                const surroundingEnemies = enemies.filter(e => {
                    const dist = Phaser.Math.Distance.Between(unit.x, unit.y, e.x, e.y);
                    return dist < 35; // 35像素内算围攻
                });
                const enemyCount = surroundingEnemies.length;
                
                // 【方案D】每多1个敌人，伤害+20%
                // 1人=100%, 2人=120%, 3人=140%, 以此类推
                const surroundBonus = 1 + (enemyCount - 1) * 0.5;
                
                let damage = Math.max(1, unit.trappedAtk - nearest.typeData.def);
                
                // 长枪兵基础加成
                if (nearest.type === 'pikeman') {
                    damage = Math.floor(damage * 1.3); // 降低为1.3倍，与围攻加成叠加
                }
                
                // 应用围攻加成（最低1.0，即单人时无加成）
                const finalMultiplier = Math.max(1.0, surroundBonus);
                damage = Math.floor(damage * finalMultiplier);
                
                nearest.hp -= damage;
                this.scene.showAttackEffect(unit, nearest);
            }
        } else {
            // 向最近的敌人移动
            const angle = Phaser.Math.Angle.Between(unit.x, unit.y, nearest.x, nearest.y);
            unit.x += Math.cos(angle) * unit.trappedSpeed * dt;
            unit.y += Math.sin(angle) * unit.trappedSpeed * dt;
        }
        
        // 应用挣扎偏移
        unit.container.x = unit.x + struggleOffset;
        unit.container.y = unit.y + struggleOffset * 0.5;
        unit.container.rotation += struggleRotate;
        
        // 边界限制
        unit.x = Phaser.Math.Clamp(unit.x, 20, WIDTH - 20);
        unit.y = Phaser.Math.Clamp(unit.y, 20, HEIGHT - 20);
        
        this.scene.applyCollisionRepulsion(unit, dt);
        return true;
    }
    
    // 【方向D】处理脱困逃跑状态
    handleEscaping(unit, enemies, dt, cellSize) {
        unit.escapeTimer += dt;
        
        // 朝逃跑方向跑
        unit.x += Math.cos(unit.escapeAngle) * unit.currentSpeed * dt;
        unit.y += Math.sin(unit.escapeAngle) * unit.currentSpeed * dt;
        
        // 转身朝向逃跑方向
        this.scene.smoothRotate(unit, unit.escapeAngle + Math.PI/2, dt * 5);
        
        // 逃跑1.5秒后，进入回调整备状态
        if (unit.escapeTimer > 1.5) {
            unit.isEscaping = false;
            unit.isReforming = true;
            unit.reformTimer = 0;
            unit.currentSpeed = 0;
            this.scene.calculateReformTarget(unit, enemies);
            return true;
        }
        
        // 边界限制
        unit.x = Phaser.Math.Clamp(unit.x, 20, WIDTH - 20);
        unit.y = Phaser.Math.Clamp(unit.y, 20, HEIGHT - 20);
        
        unit.container.x = unit.x;
        unit.container.y = unit.y;
        this.scene.applyCollisionRepulsion(unit, dt);
        return true;
    }
    
    // 【方向D】找到最佳逃跑方向（最畅通的方向）
    findBestEscapeDirection(unit, enemies, checkDist = 60) {
        let bestAngle = 0;
        let maxClearDist = 0;
        let open = false;
        
        // 检测16个方向（更精细）
        for (let i = 0; i < 16; i++) {
            const angle = (i / 16) * Math.PI * 2;
            let clearDist = checkDist;
            
            // 检查这个方向上最近的敌人距离
            for (const enemy of enemies) {
                const enemyAngle = Phaser.Math.Angle.Between(unit.x, unit.y, enemy.x, enemy.y);
                const angleDiff = Math.abs(Phaser.Math.Angle.Wrap(enemyAngle - angle));
                
                // 如果敌人在该方向±20度范围内
                if (angleDiff < 0.35) { // 约20度
                    const distToEnemy = Phaser.Math.Distance.Between(unit.x, unit.y, enemy.x, enemy.y);
                    if (distToEnemy < clearDist) {
                        clearDist = distToEnemy;
                    }
                }
            }
            
            // 找到最畅通的方向
            if (clearDist > maxClearDist) {
                maxClearDist = clearDist;
                bestAngle = angle;
            }
        }
        
        // 如果最畅通的方向有至少40像素空间，认为可以逃跑
        if (maxClearDist >= 40) {
            open = true;
        }
        
        return { angle: bestAngle, open, clearDist: maxClearDist };
    }

    // 【新增】检测8个方向有多少个畅通（方向1：缺口检测）
    countOpenDirections(unit, enemies, checkDist = 50) {
        let openCount = 0;
        
        // 检测8个方向（每45度一个方向）
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2;
            const checkX = unit.x + Math.cos(angle) * checkDist;
            const checkY = unit.y + Math.sin(angle) * checkDist;
            
            // 检查这个方向是否有敌人阻挡
            let blocked = false;
            for (const enemy of enemies) {
                const distToLine = this.pointToLineDistance(
                    enemy.x, enemy.y,
                    unit.x, unit.y,
                    checkX, checkY
                );
                // 如果敌人在路径附近且距离合适，算阻挡
                if (distToLine < enemy.collisionRadius + 5) {
                    const distToEnemy = Phaser.Math.Distance.Between(unit.x, unit.y, enemy.x, enemy.y);
                    if (distToEnemy < checkDist + enemy.collisionRadius) {
                        blocked = true;
                        break;
                    }
                }
            }
            
            if (!blocked) {
                openCount++;
            }
        }
        
        return openCount;
    }
    
    // 辅助：点到线段的距离
    pointToLineDistance(px, py, x1, y1, x2, y2) {
        const A = px - x1;
        const B = py - y1;
        const C = x2 - x1;
        const D = y2 - y1;
        
        const dot = A * C + B * D;
        const lenSq = C * C + D * D;
        let param = -1;
        
        if (lenSq !== 0) {
            param = dot / lenSq;
        }
        
        let xx, yy;
        
        if (param < 0) {
            xx = x1;
            yy = y1;
        } else if (param > 1) {
            xx = x2;
            yy = y2;
        } else {
            xx = x1 + param * C;
            yy = y1 + param * D;
        }
        
        const dx = px - xx;
        const dy = py - yy;
        
        return Math.sqrt(dx * dx + dy * dy);
    }

    // 【新增】找突围方向（敌人最少的方向）
    findBreakoutDirection(unit, enemies) {
        // 8个方向检测
        const directions = [];
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2;
            const checkX = unit.x + Math.cos(angle) * 60;
            const checkY = unit.y + Math.sin(angle) * 60;
            
            // 计算该方向的敌人数量
            const enemyCount = enemies.filter(e => {
                const dist = Phaser.Math.Distance.Between(checkX, checkY, e.x, e.y);
                return dist < 40;
            }).length;
            
            directions.push({ angle, count: enemyCount });
        }
        
        // 找敌人最少的方向
        directions.sort((a, b) => a.count - b.count);
        return directions[0].angle;
    }

    handleReforming(unit, nearest, dt, cellSize) {
        unit.reformTimer += dt;
        
        // 检查周围追击的敌人数量
        const pursuingEnemies = this.scene.units.filter(u => 
            u.team !== unit.team && 
            u.hp > 0 && 
            Phaser.Math.Distance.Between(unit.x, unit.y, u.x, u.y) < 80
        );
        
        // 如果敌人太多（>=4），不退了，就地转为被困住模式
        if (pursuingEnemies.length >= 4) {
            unit.isReforming = false;
            unit.isTrapped = true;
            return true;
        }
        
        // 根据追击敌人数量动态调整撤退距离
        // 敌人越多，退得越远
        const targetDist = 80 + pursuingEnemies.length * 20; // 80~140像素
        
        // 重新计算撤退目标（侧向撤退，不是直线）
        if (!unit.reformTargetCalculated || unit.reformTimer < 0.1) {
            unit.reformTargetCalculated = true;
            this.calculateFlexibleReformTarget(unit, pursuingEnemies, targetDist);
        }
        
        const distToReform = Phaser.Math.Distance.Between(
            unit.x, unit.y, unit.reformTargetX, unit.reformTargetY
        );
        
        if (distToReform > 15) {
            // 向撤退位置移动
            const angle = Phaser.Math.Angle.Between(
                unit.x, unit.y, unit.reformTargetX, unit.reformTargetY
            );
            // 敌人追击时撤退更快
            const retreatSpeed = unit.typeData.speed * (0.8 + pursuingEnemies.length * 0.05);
            
            unit.x += Math.cos(angle) * retreatSpeed * dt;
            unit.y += Math.sin(angle) * retreatSpeed * dt;
            
            // 边界限制
            unit.x = Phaser.Math.Clamp(unit.x, 20, WIDTH - 20);
            unit.y = Phaser.Math.Clamp(unit.y, 20, HEIGHT - 20);
            
            this.scene.smoothRotate(unit, angle + Math.PI/2, dt * 8);
        } else {
            // 到达位置，掉头朝向敌人
            const angleToEnemy = Phaser.Math.Angle.Between(
                unit.x, unit.y, nearest.x, nearest.y
            );
            const targetRotation = angleToEnemy + Math.PI/2;
            const angleDiff = this.scene.smoothRotate(unit, targetRotation, dt * 10);
            
            const isAligned = Math.abs(angleDiff) < 0.3;
            const timeout = unit.reformTimer > 1.0;
            
            if (isAligned || timeout) {
                unit.isReforming = false;
                unit.hasCharged = false;
                unit.chargeTime = 0;
                unit.currentSpeed = 0;
                unit.reformTargetCalculated = false;
            }
        }
        
        unit.container.x = unit.x;
        unit.container.y = unit.y;
        this.scene.applyCollisionRepulsion(unit, dt);
        return true;
    }
    
    // 【新增】灵活的回调整备目标计算（支持侧向撤退）
    calculateFlexibleReformTarget(unit, pursuingEnemies, targetDist) {
        // 找敌人的重心
        let centerX = unit.x, centerY = unit.y;
        if (pursuingEnemies.length > 0) {
            centerX = pursuingEnemies.reduce((sum, e) => sum + e.x, 0) / pursuingEnemies.length;
            centerY = pursuingEnemies.reduce((sum, e) => sum + e.y, 0) / pursuingEnemies.length;
        }
        
        // 计算远离敌人的基本方向
        const awayAngle = Phaser.Math.Angle.Between(centerX, centerY, unit.x, unit.y);
        
        // 添加侧向偏移（不是直线后退）
        // 随机选择左侧或右侧撤退
        const sideOffset = (Math.random() > 0.5 ? 1 : -1) * (0.3 + Math.random() * 0.4); // ±0.3~0.7弧度
        const finalAngle = awayAngle + sideOffset;
        
        unit.reformTargetX = unit.x + Math.cos(finalAngle) * targetDist;
        unit.reformTargetY = unit.y + Math.sin(finalAngle) * targetDist;
        
        // 边界限制
        unit.reformTargetX = Phaser.Math.Clamp(unit.reformTargetX, 30, WIDTH - 30);
        unit.reformTargetY = Phaser.Math.Clamp(unit.reformTargetY, 30, HEIGHT - 30);
    }

    handleCharging(unit, nearest, dt, maxSpeed) {
        unit.charging = true;
        unit.chargeTime += dt;
        
        const angle = Phaser.Math.Angle.Between(unit.x, unit.y, nearest.x, nearest.y);
        
        // 加速缓冲
        const accel = 2.0;
        unit.currentSpeed += (maxSpeed - unit.currentSpeed) * accel * dt;
        if (unit.currentSpeed < unit.typeData.speed * 0.5) {
            unit.currentSpeed = unit.typeData.speed * 0.5;
        }
        
        unit.vx = Math.cos(angle) * unit.currentSpeed;
        unit.vy = Math.sin(angle) * unit.currentSpeed;
        
        // 颠簸效果
        unit.bobPhase += dt * 15;
        
        unit.x += unit.vx * dt;
        unit.y += unit.vy * dt;
        
        // 边界限制
        unit.x = Phaser.Math.Clamp(unit.x, 20, WIDTH - 20);
        unit.y = Phaser.Math.Clamp(unit.y, 20, HEIGHT - 20);
        
        // 冲锋倾斜
        const speedRatio = unit.currentSpeed / maxSpeed;
        const tiltAngle = angle + Math.PI/2 + speedRatio * 0.25;
        unit.container.setRotation(tiltAngle);
        
        unit.container.x = unit.x;
        unit.container.y = unit.y + Math.sin(unit.bobPhase) * 0.2;
        
        this.scene.applyCollisionRepulsion(unit, dt);
        return true;
    }

    handleImpact(unit, nearest, now, maxSpeed) {
        if (now - unit.lastAttack > unit.typeData.atkSpeed) {
            unit.lastAttack = now;
            
            // 冲锋伤害 x2
            let damage = unit.typeData.atk * 2;
            damage = Math.max(1, damage - nearest.typeData.def);
            nearest.hp -= damage;
            
            // 【方案C】开始凿穿，设定目标穿越点（敌阵后方80像素）
            unit.passingThrough = true;
            unit.passTimer = 0;
            unit.charging = false;
            unit.currentSpeed = maxSpeed;  // 以最高速度开始凿穿
            
            const impactAngle = Phaser.Math.Angle.Between(
                unit.x, unit.y, nearest.x, nearest.y
            );
            unit.chargeAngle = impactAngle;
            
            // 计算穿越目标：当前方向再往前80像素
            unit.breakthroughTargetX = unit.x + Math.cos(impactAngle) * 80;
            unit.breakthroughTargetY = unit.y + Math.sin(impactAngle) * 80;
            
            // 边界限制
            unit.breakthroughTargetX = Phaser.Math.Clamp(unit.breakthroughTargetX, 30, WIDTH - 30);
            unit.breakthroughTargetY = Phaser.Math.Clamp(unit.breakthroughTargetY, 30, HEIGHT - 30);
        }
        return true;
    }

    updatePassingThrough(unit, dt, enemies, now) {
        unit.passTimer += dt;
        
        // 【方案C】检查是否成功冲出敌阵
        // 1. 检查是否到达目标穿越点
        const distToBreakthroughTarget = Phaser.Math.Distance.Between(
            unit.x, unit.y, unit.breakthroughTargetX, unit.breakthroughTargetY
        );
        
        // 2. 检查周围敌人密度（60像素范围内）
        const enemiesInFront = enemies.filter(e => {
            const dist = Phaser.Math.Distance.Between(unit.x, unit.y, e.x, e.y);
            // 只考虑前方的敌人
            const angleToEnemy = Phaser.Math.Angle.Between(unit.x, unit.y, e.x, e.y);
            const angleDiff = Math.abs(Phaser.Math.Angle.Wrap(angleToEnemy - unit.chargeAngle));
            return dist < 60 && angleDiff < Math.PI / 2; // 前方60像素内
        });
        
        // 【成功冲出】到达目标点或前方敌人<2个
        if (distToBreakthroughTarget < 15 || enemiesInFront.length < 2) {
            unit.passingThrough = false;
            unit.isReforming = true;
            unit.reformTimer = 0;
            unit.currentSpeed = 0;
            this.scene.calculateReformTarget(unit, enemies);
            return;
        }
        
        // 【方案C】速度衰减：从150%逐渐降到最低30%（不停下）
        const decel = 0.7;
        unit.currentSpeed *= Math.pow(decel, dt);
        if (unit.currentSpeed < unit.typeData.speed * 0.3) {
            unit.currentSpeed = unit.typeData.speed * 0.3; // 最低保持30%速度
        }
        
        // 【失败被困】速度降到最低且被3个以上敌人包围在30像素内
        const nearbyEnemies = enemies.filter(e => {
            const dist = Phaser.Math.Distance.Between(unit.x, unit.y, e.x, e.y);
            return dist < unit.collisionRadius + e.collisionRadius + 8;
        });
        
        if (unit.currentSpeed <= unit.typeData.speed * 0.35 && nearbyEnemies.length >= 3) {
            // 【被困住】进入 trapped 状态
            unit.isTrapped = true;
            unit.passingThrough = false;
            unit.trappedAtk = 20;
            unit.trappedSpeed = 40;
            unit.currentSpeed = 0;
            return;
        }
        
        // 【方案C】朝向目标穿越点移动（允许微调方向）
        const angleToTarget = Phaser.Math.Angle.Between(
            unit.x, unit.y, unit.breakthroughTargetX, unit.breakthroughTargetY
        );
        
        // 平滑调整朝向目标点（每帧最多转15度）
        let angleDiff = Phaser.Math.Angle.Wrap(angleToTarget - unit.chargeAngle);
        angleDiff = Phaser.Math.Clamp(angleDiff, -0.26, 0.26); // 限制转向速度
        unit.chargeAngle += angleDiff;
        
        // 摆动（再弱化60%，从0.48减到0.19）
        unit.swayPhase += dt * 6;
        const swayOffset = Math.sin(unit.swayPhase) * 0.19 *
            (unit.currentSpeed / (unit.typeData.speed * 1.5));
        
        const perpAngle = unit.chargeAngle + Math.PI/2;
        const swayX = Math.cos(perpAngle) * swayOffset * dt;
        const swayY = Math.sin(perpAngle) * swayOffset * dt;
        
        unit.x += Math.cos(unit.chargeAngle) * unit.currentSpeed * dt + swayX;
        unit.y += Math.sin(unit.chargeAngle) * unit.currentSpeed * dt + swayY;
        
        // 边界限制
        unit.x = Phaser.Math.Clamp(unit.x, 20, WIDTH - 20);
        unit.y = Phaser.Math.Clamp(unit.y, 20, HEIGHT - 20);
        
        // 凿穿过程中对路径上的敌人造成冲撞伤害
        if (now - unit.lastAttack > 300) { // 每0.3秒造成一次冲撞伤害
            unit.lastAttack = now;
            
            enemies.forEach(enemy => {
                const dist = Phaser.Math.Distance.Between(unit.x, unit.y, enemy.x, enemy.y);
                if (dist < unit.collisionRadius + enemy.collisionRadius + 2) {
                    // 冲撞伤害：基础攻击的0.5倍
                    let damage = Math.floor(unit.typeData.atk * 0.5);
                    damage = Math.max(1, damage - enemy.typeData.def);
                    enemy.hp -= damage;
                }
            });
        }
        
        unit.container.x = unit.x;
        unit.container.y = unit.y;
        this.scene.applyCollisionRepulsion(unit, dt);
    }
}

// ==================== 创建单位工厂函数 ====================
function createUnit(scene, team, typeKey, x, y, cellSize) {
    const type = UNIT_TYPES[typeKey];
    const container = scene.add.container(x, y);
    
    // 绘制单位形状
    const shape = scene.add.graphics();
    const color = team === 'red' ? 0xff4444 : 0x4444ff;
    
    shape.fillStyle(color, 1);
    
    if (type.shape === 'square') {
        // 步兵：正方形
        shape.fillRect(-type.size/2, -type.size/2, type.size, type.size);
    } else if (type.shape === 'rect') {
        // 长枪兵：长方形
        shape.fillRect(-type.size, -type.size/3, type.size*2, type.size/1.5);
    } else if (type.shape === 'circle') {
        // 弓箭手：圆形（大小与步兵相近）
        shape.fillCircle(0, 0, type.size * 0.9);  // 半径约4.5，与步兵5x5接近
        shape.fillStyle(0xffffff, 0.6);
        shape.fillCircle(type.size/3, -type.size/3, type.size/3);  // 高光点
    } else if (type.shape === 'triangle') {
        // 骑兵：三角形
        const s = type.size;
        shape.fillTriangle(0, -s, -s*0.6, s*0.5, s*0.6, s*0.5);
        container.setRotation(team === 'red' ? Math.PI/2 : -Math.PI/2);
    }
    
    container.add(shape);
    scene.unitContainer.add(container);
    
    return {
        team,
        type: typeKey,
        typeData: type,
        x, y,
        hp: type.hp,
        maxHp: type.hp,
        container,
        shape,
        lastAttack: 0,
        target: null,
        hasCharged: false,
        charging: false,
        passingThrough: false,
        stuckTimer: 0,
        vx: 0, vy: 0,
        collisionRadius: type.size + 6,
        // 骑兵动态效果
        currentSpeed: 0,
        chargeTime: 0,
        bobPhase: Math.random() * Math.PI * 2,
        swayPhase: Math.random() * Math.PI * 2,
        // 回冲状态
        isReforming: false,
        reformTimer: 0,
        reformTargetX: 0,
        reformTargetY: 0,
        // 被困住状态
        isTrapped: false,
        trappedAtk: 20,         // 被困住时的攻击力
        trappedSpeed: 40,       // 被困住时的移速
        trappedStrugglePhase: 0,// 挣扎动画相位
        breakoutCooldown: 0,    // 突围冷却时间
        // 【方向D】脱困逃跑状态
        isEscaping: false,
        escapeAngle: 0,
        escapeTimer: 0,
        // 【方案C】凿穿穿越目标点
        breakthroughTargetX: 0,
        breakthroughTargetY: 0,
        // 回冲优化
        reformTargetCalculated: false  // 是否已计算撤退目标
    };
}
