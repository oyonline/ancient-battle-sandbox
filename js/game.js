// ==================== 游戏场景 ====================
class BattleScene extends Phaser.Scene {
    constructor() {
        super({ key: 'BattleScene' });
        this.units = [];
        this.arrows = [];
        this.gameSpeed = 1;
        this.isPaused = false;
        this.battleStarted = false;
        this.totalKills = 0;
        this.cavalryAI = null;
    }

    create() {
        this.cavalryAI = new CavalryAI(this);
        this.drawGrid();
        this.unitContainer = this.add.container(0, 0);
        this.arrowContainer = this.add.container(0, 0);
        this.effectContainer = this.add.container(0, 0);
        
        this.showWaitingText();
        
        this.time.addEvent({
            delay: 16,
            callback: this.updateBattle,
            callbackScope: this,
            loop: true
        });
    }

    drawGrid() {
        const graphics = this.add.graphics();
        graphics.lineStyle(1, 0x333355, 0.3);
        for (let x = 0; x <= WIDTH; x += CELL_SIZE) {
            graphics.moveTo(x, 0);
            graphics.lineTo(x, HEIGHT);
        }
        for (let y = 0; y <= HEIGHT; y += CELL_SIZE) {
            graphics.moveTo(0, y);
            graphics.lineTo(WIDTH, y);
        }
        graphics.strokePath();
    }

    showWaitingText() {
        // 提示已移除
    }

    deployUnits(redConfig, blueConfig, redFormation = 'custom', blueFormation = 'custom') {
        this.restart(null, null, false);
        
        if (this.waitingText) {
            this.waitingText.destroy();
            this.waitingText = null;
        }
        
        this.generateUnits(redConfig, blueConfig, redFormation, blueFormation);
        this.updateStats();
        
        // 布阵提示已移除
        
        return true;
    }

    startBattle() {
        if (this.battleStarted) return false;
        if (this.units.length === 0) return false;
        
        this.battleStarted = true;
        if (this.waitingText) {
            this.waitingText.destroy();
            this.waitingText = null;
        }
        
        this.totalKills = 0;
        this.updateStats();
        return true;
    }

    generateUnits(redConfig, blueConfig, redFormation = 'custom', blueFormation = 'custom') {
        this.units.forEach(u => {
            if (u.container) u.container.destroy();
        });
        this.units = [];
        this.arrows.forEach(a => a.graphics.destroy());
        this.arrows = [];
        
        // 生成红方
        this.generateTeamUnits('red', redConfig, redFormation, 2);
        
        // 生成蓝方
        this.generateTeamUnits('blue', blueConfig, blueFormation, GRID_W - 3);
    }
    
    generateTeamUnits(team, config, formationKey, startCol) {
        const formation = FORMATIONS[formationKey] || FORMATIONS.custom;
        
        if (formationKey === 'custom' || !formation.rows) {
            // 自定义模式：按兵种顺序排列（原逻辑）
            const UNITS_PER_COL = 10;
            const types = Object.entries(config).filter(([type, count]) => count > 0);
            const totalRows = types.reduce((sum, [type, count]) => 
                sum + Math.ceil(count / UNITS_PER_COL), 0);
            const startRow = (GRID_H - totalRows) / 2;
            let currentRow = startRow;
            
            types.forEach(([type, count]) => {
                const rows = Math.ceil(count / UNITS_PER_COL);
                for (let i = 0; i < count; i++) {
                    const colOffset = Math.floor(i / UNITS_PER_COL);
                    const yOffset = (i % UNITS_PER_COL);
                    const x = team === 'red' 
                        ? (startCol + colOffset) * CELL_SIZE + 16
                        : (startCol - colOffset) * CELL_SIZE + 16;
                    const unit = createUnit(this, team, type, x, 
                        (currentRow + yOffset) * CELL_SIZE + 16, CELL_SIZE);
                    this.units.push(unit);
                }
                currentRow += rows;
            });
        } else {
            // 阵型模式：按优先级和位置排列
            this.generateFormationUnits(team, config, formation, startCol);
        }
    }
    
    generateFormationUnits(team, config, formation, startCol) {
        // 复制配置，避免修改原始数据
        const remaining = { ...config };
        const UNITS_PER_ROW = 10; // 每行10个单位
        const MAX_ROWS = 8; // 最大8行
        
        // 计算居中起始行
        const startRow = (GRID_H - MAX_ROWS) / 2;
        
        // 按阵型优先级处理每个位置
        for (let row = 0; row < MAX_ROWS; row++) {
            for (let col = 0; col < UNITS_PER_ROW; col++) {
                // 确定这个位置应该放什么兵种
                let unitType = this.getFormationPositionType(row, col, formation, remaining);
                
                if (unitType && remaining[unitType] > 0) {
                    remaining[unitType]--;
                    
                    const x = team === 'red'
                        ? (startCol + col) * CELL_SIZE + 16
                        : (startCol - col) * CELL_SIZE + 16;
                    const y = (startRow + row) * CELL_SIZE + 16;
                    
                    const unit = createUnit(this, team, unitType, x, y, CELL_SIZE);
                    this.units.push(unit);
                }
            }
        }
        
        // 如果还有剩余兵种，在最后一行后面补充
        Object.entries(remaining).forEach(([type, count]) => {
            if (count > 0) {
                for (let i = 0; i < count; i++) {
                    const col = i % UNITS_PER_ROW;
                    const extraRow = MAX_ROWS + Math.floor(i / UNITS_PER_ROW);
                    
                    const x = team === 'red'
                        ? (startCol + col) * CELL_SIZE + 16
                        : (startCol - col) * CELL_SIZE + 16;
                    const y = (startRow + extraRow) * CELL_SIZE + 16;
                    
                    if (y < HEIGHT - 20) {
                        const unit = createUnit(this, team, type, x, y, CELL_SIZE);
                        this.units.push(unit);
                    }
                }
            }
        });
    }
    
    getFormationPositionType(row, col, formation, remaining) {
        const priority = formation.priority;
        const totalCols = 10;
        const centerCol = totalCols / 2;
        
        // 根据阵型决定位置类型
        switch (formation.name) {
            case '方阵':
                // 第0行(最前): 骑兵放两翼, 步兵放中间
                if (row === 0) {
                    if ((col === 0 || col === totalCols - 1) && remaining.cavalry > 0) return 'cavalry';
                    if (remaining.infantry > 0) return 'infantry';
                }
                // 第1行: 长枪放两翼, 弓箭放中间
                if (row === 1) {
                    if ((col === 0 || col === totalCols - 1) && remaining.pikeman > 0) return 'pikeman';
                    if (remaining.archer > 0) return 'archer';
                }
                // 后面几行: 步兵填满
                if (remaining.infantry > 0) return 'infantry';
                break;
                
            case '锋矢阵':
                // 第0行: 骑兵前锋
                if (row === 0 && remaining.cavalry > 0) return 'cavalry';
                // 第1-2行: 步兵跟进
                if (row >= 1 && row <= 2 && remaining.infantry > 0) return 'infantry';
                // 第3行: 长枪侧翼保护
                if (row === 3 && (col === 0 || col === totalCols - 1) && remaining.pikeman > 0) return 'pikeman';
                // 后面: 弓箭支援
                if (remaining.archer > 0) return 'archer';
                break;
                
            case '混合阵':
                // 交错排列，步兵中前，骑兵两翼，弓箭居中，长枪侧翼
                if (row === 0) {
                    if ((col === 0 || col === totalCols - 1) && remaining.cavalry > 0) return 'cavalry';
                }
                if (row <= 2) {
                    if ((col === 0 || col === totalCols - 1) && remaining.pikeman > 0) return 'pikeman';
                    if (col >= 3 && col <= 6 && remaining.archer > 0) return 'archer';
                    if (remaining.infantry > 0) return 'infantry';
                }
                if (remaining.infantry > 0) return 'infantry';
                break;
                
            case '长蛇阵':
                // 一字长蛇，层层递进
                if (row === 0 && remaining.infantry > 0) return 'infantry';
                if (row === 1 && remaining.pikeman > 0) return 'pikeman';
                if (row === 2 && remaining.cavalry > 0) return 'cavalry';
                if (remaining.archer > 0) return 'archer';
                break;
        }
        
        // 默认按优先级填充
        for (const type of priority) {
            if (remaining[type] > 0) return type;
        }
        
        return null;
    }

    updateBattle() {
        if (this.isPaused || !this.battleStarted) return;
        
        const dt = 0.016 * this.gameSpeed;
        const now = Date.now();
        
        this.units.forEach(unit => {
            if (unit.hp <= 0) return;
            
            const enemies = this.units.filter(u => u.team !== unit.team && u.hp > 0);
            if (enemies.length === 0) return;
            
            // 骑兵逻辑
            if (unit.type === 'cavalry') {
                // 凿穿中
                if (unit.passingThrough) {
                    this.cavalryAI.updatePassingThrough(unit, dt, enemies, now);
                    return;
                }
                // 冲锋/回调整备
                if (!unit.passingThrough) {
                    const result = this.cavalryAI.update(unit, enemies, now, dt, CELL_SIZE);
                    if (result) return;
                }
            }
            
            // 普通单位逻辑
            this.updateNormalUnit(unit, enemies, now, dt);
        });
        
        this.updateArrows(dt);
        this.cleanupDead();
        this.updateStats();
        
        const redAlive = this.units.filter(u => u.team === 'red' && u.hp > 0).length;
        const blueAlive = this.units.filter(u => u.team === 'blue' && u.hp > 0).length;
        
        if ((redAlive === 0 || blueAlive === 0) && !this.winnerText) {
            this.showWinner(redAlive > 0 ? '🔴 红方' : '🔵 蓝方');
        }
    }

    updateNormalUnit(unit, enemies, now, dt) {
        const attackRange = unit.typeData.range * CELL_SIZE;
        
        // 【优化】弓箭手特殊逻辑：找无遮挡的目标
        if (unit.typeData.ranged) {
            return this.updateArcher(unit, enemies, now, dt, attackRange);
        }
        
        // 近战单位逻辑（保持原有）
        let nearest = null;
        let minDist = Infinity;
        
        enemies.forEach(enemy => {
            const dist = Phaser.Math.Distance.Between(unit.x, unit.y, enemy.x, enemy.y);
            if (dist < minDist) {
                minDist = dist;
                nearest = enemy;
            }
        });
        
        if (!nearest) return;
        
        unit.target = nearest;
        
        if (minDist <= attackRange) {
            if (now - unit.lastAttack > unit.typeData.atkSpeed) {
                unit.lastAttack = now;
                this.performAttack(unit, nearest);
            }
            
            unit.stuckTimer += dt;
            if (unit.stuckTimer > 2) {
                unit.stuckTimer = 0;
                const jitter = (Math.random() - 0.5) * 20;
                unit.x += jitter;
                unit.y += (Math.random() - 0.5) * 20;
            }
        } else {
            unit.stuckTimer = 0;
            const angle = Phaser.Math.Angle.Between(unit.x, unit.y, nearest.x, nearest.y);
            const speed = unit.typeData.speed;
            
            unit.x += Math.cos(angle) * speed * dt;
            unit.y += Math.sin(angle) * speed * dt;
        }
        
        // 边界限制
        unit.x = Phaser.Math.Clamp(unit.x, 20, WIDTH - 20);
        unit.y = Phaser.Math.Clamp(unit.y, 20, HEIGHT - 20);
        
        unit.container.x = unit.x;
        unit.container.y = unit.y;
        
        this.applyCollisionRepulsion(unit, dt);
    }

    // 【方案D】弓箭手专用更新逻辑（二次检测避免误伤）
    updateArcher(unit, enemies, now, dt, attackRange) {
        // 按距离排序所有敌人
        const enemiesByDist = enemies.map(enemy => ({
            enemy,
            dist: Phaser.Math.Distance.Between(unit.x, unit.y, enemy.x, enemy.y)
        })).sort((a, b) => a.dist - b.dist);
        
        if (enemiesByDist.length === 0) return;
        
        // 【方案D】尝试找可安全射击的目标
        let target = null;
        let targetDist = Infinity;
        let canShoot = false;
        
        // 遍历敌人，找第一个能安全射击的
        for (const { enemy, dist } of enemiesByDist) {
            if (dist > attackRange) break; // 超出射程
            
            // 预检查能否射击（不实际执行）
            const shootable = this.canArcherShootSafely(unit, enemy, dist);
            
            if (shootable) {
                target = enemy;
                targetDist = dist;
                canShoot = true;
                break;
            }
        }
        
        // 如果有可安全射击的目标
        if (target && canShoot) {
            unit.target = target;
            if (now - unit.lastAttack > unit.typeData.atkSpeed) {
                unit.lastAttack = now;
                const shot = this.performAttack(unit, target);
                // 射击成功，轻微后坐力
                if (shot) {
                    const recoilAngle = Phaser.Math.Angle.Between(target.x, target.y, unit.x, unit.y);
                    unit.x += Math.cos(recoilAngle) * 2;
                    unit.y += Math.sin(recoilAngle) * 2;
                }
            }
            unit.stuckTimer = 0;
        } else {
            // 没有可射击目标（超出射程）
            const nearest = enemiesByDist[0].enemy;
            const nearestDist = enemiesByDist[0].dist;
            
            if (nearestDist <= attackRange * 0.8) {
                // 接近射程但还没进，微调位置
                unit.stuckTimer += dt;
                if (unit.stuckTimer > 0.5) {
                    unit.stuckTimer = 0;
                    const angleToEnemy = Phaser.Math.Angle.Between(unit.x, unit.y, nearest.x, nearest.y);
                    const sideAngle = angleToEnemy + (Math.random() > 0.5 ? Math.PI/2 : -Math.PI/2);
                    const moveDist = 3;
                    unit.x += Math.cos(sideAngle) * moveDist;
                    unit.y += Math.sin(sideAngle) * moveDist;
                }
            } else {
                // 超出射程，向前移动
                unit.stuckTimer = 0;
                const angle = Phaser.Math.Angle.Between(unit.x, unit.y, nearest.x, nearest.y);
                const speed = unit.typeData.speed;
                unit.x += Math.cos(angle) * speed * dt;
                unit.y += Math.sin(angle) * speed * dt;
            }
        }
        
        // 边界限制
        unit.x = Phaser.Math.Clamp(unit.x, 20, WIDTH - 20);
        unit.y = Phaser.Math.Clamp(unit.y, 20, HEIGHT - 20);
        
        unit.container.x = unit.x;
        unit.container.y = unit.y;
        this.applyCollisionRepulsion(unit, dt);
    }

    applyCollisionRepulsion(unit, dt) {
        const allUnits = this.units.filter(u => u.hp > 0 && u !== unit);
        
        let repelX = 0;
        let repelY = 0;
        
        allUnits.forEach(other => {
            const dx = unit.x - other.x;
            const dy = unit.y - other.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            
            if (dist < 0.1) return;
            
            const minDist = unit.collisionRadius + other.collisionRadius;
            
            if (dist < minDist) {
                const overlap = minDist - dist;
                const force = overlap / minDist;
                repelX += (dx / dist) * force * 30;
                repelY += (dy / dist) * force * 30;
            }
        });
        
        if (repelX !== 0 || repelY !== 0) {
            unit.x += repelX * dt;
            unit.y += repelY * dt;
        }
    }

    performAttack(attacker, target) {
        if (attacker.typeData.ranged) {
            // 【方案D】二次检测避免误伤
            const dist = Phaser.Math.Distance.Between(attacker.x, attacker.y, target.x, target.y);
            const meleeRange = 25; // 平射距离（约1.5格，与近战类似）
            
            if (dist < meleeRange) {
                // 距离很近，使用平射（精准）
                this.fireArrow(attacker, target);
                return true;
            } else {
                // 距离远，先检测是否需要抛射
                const hasFriendlyBlock = this.hasFriendlyInLine(attacker, target);
                
                if (hasFriendlyBlock) {
                    // 【二次检测】计算抛射落点，检查友军密度
                    const arcTarget = this.calculateArcLandingPoint(attacker, target);
                    const friendlyDensity = this.getFriendlyDensityAtPoint(
                        attacker, arcTarget.x, arcTarget.y, 25 // 25像素检测范围
                    );
                    
                    // 落点友军密度太高（>=2个友军），不射！
                    if (friendlyDensity >= 2) {
                        return false; // 让上层逻辑换目标或等待
                    }
                    
                    // 友军密度低，可以抛射
                    this.fireArcArrow(attacker, target);
                    return true;
                } else {
                    // 无友军阻挡，平射
                    this.fireArrow(attacker, target);
                    return true;
                }
            }
        } else {
            this.showAttackEffect(attacker, target);
            
            let damage = attacker.typeData.atk;
            
            if (attacker.type === 'pikeman' && target.type === 'cavalry') {
                damage *= attacker.typeData.antiCav;
            }
            
            damage = Math.max(1, damage - target.typeData.def);
            target.hp -= damage;
            return true;
        }
    }

    // 【新增】检查射击路径上是否有友军
    hasFriendlyInLine(attacker, target) {
        const angle = Phaser.Math.Angle.Between(attacker.x, attacker.y, target.x, target.y);
        const distToTarget = Phaser.Math.Distance.Between(attacker.x, attacker.y, target.x, target.y);
        
        // 检查路径上的所有友军
        const friendlies = this.units.filter(u => 
            u.hp > 0 && 
            u.team === attacker.team && 
            u !== attacker
        );
        
        for (const friendly of friendlies) {
            const distToFriendly = Phaser.Math.Distance.Between(
                attacker.x, attacker.y, friendly.x, friendly.y
            );
            
            // 只检查目标前方的友军（距离比目标近）
            if (distToFriendly >= distToTarget) continue;
            
            // 计算友军是否在射线上（垂直距离小于碰撞半径）
            const angleToFriendly = Phaser.Math.Angle.Between(
                attacker.x, attacker.y, friendly.x, friendly.y
            );
            const angleDiff = Math.abs(Phaser.Math.Angle.Wrap(angleToFriendly - angle));
            
            // 如果在射线上（角度差小于15度）且距离合适
            if (angleDiff < 0.26) { // 0.26弧度 ≈ 15度
                const perpendicularDist = distToFriendly * Math.sin(angleDiff);
                if (perpendicularDist < friendly.collisionRadius + 4) {
                    return true; // 有友军阻挡
                }
            }
        }
        
        return false;
    }

    // 【方案D】计算抛射落点位置
    calculateArcLandingPoint(attacker, target) {
        // 抛射落点就是目标位置（简化计算）
        // 实际抛物线会有微小偏移，但用目标位置作为落点估计足够
        return { x: target.x, y: target.y };
    }

    // 【方案D】检测某点周围友军密度
    getFriendlyDensityAtPoint(attacker, x, y, checkRadius = 25) {
        const friendlies = this.units.filter(u => 
            u.hp > 0 && 
            u.team === attacker.team && 
            u !== attacker
        );
        
        let count = 0;
        for (const friendly of friendlies) {
            const dist = Phaser.Math.Distance.Between(x, y, friendly.x, friendly.y);
            if (dist < checkRadius) {
                count++;
            }
        }
        
        return count;
    }

    // 【方案D】预检查弓箭手能否安全射击（不实际执行）
    canArcherShootSafely(archer, target, dist) {
        const meleeRange = 25; // 约1.5格，与近战范围接近
        
        // 近战距离直接可以射（平射）
        if (dist < meleeRange) {
            return true;
        }
        
        // 远距离需要检测
        const hasFriendlyBlock = this.hasFriendlyInLine(archer, target);
        
        if (hasFriendlyBlock) {
            // 有友军阻挡，需要抛射，检测落点密度
            const arcTarget = this.calculateArcLandingPoint(archer, target);
            const friendlyDensity = this.getFriendlyDensityAtPoint(archer, arcTarget.x, arcTarget.y, 25);
            
            // 落点友军 >= 2，不安全
            if (friendlyDensity >= 2) {
                return false;
            }
        }
        
        // 其他情况都可以射
        return true;
    }

    showAttackEffect(attacker, target) {
        attacker.shape.setAlpha(0.5);
        this.time.delayedCall(100, () => attacker.shape.setAlpha(1));
        
        const angle = Phaser.Math.Angle.Between(attacker.x, attacker.y, target.x, target.y);
        const lungeDist = 8;
        attacker.container.x += Math.cos(angle) * lungeDist;
        attacker.container.y += Math.sin(angle) * lungeDist;
        
        this.time.delayedCall(100, () => {
            attacker.container.x = attacker.x;
            attacker.container.y = attacker.y;
        });
    }

    showImpactEffect(x, y) {
        const gfx = this.add.graphics();
        gfx.lineStyle(2, 0xffaa44, 0.5);
        gfx.strokeCircle(x, y, 8);
        this.effectContainer.add(gfx);
        
        this.tweens.add({
            targets: gfx,
            scale: 1.5,
            alpha: 0,
            duration: 250,
            onComplete: () => gfx.destroy()
        });
    }

    fireArrow(from, to) {
        const arrow = this.add.graphics();
        arrow.fillStyle(from.team === 'red' ? 0xff8888 : 0x8888ff, 1);
        
        // 平射：9像素高（放大50%），1.5像素宽
        const points = [
            {x: 0, y: -4.5},
            {x: 0.75, y: 0},
            {x: 0, y: 4.5},
            {x: -0.75, y: 0}
        ];
        arrow.fillPoints(points, true);
        
        arrow.x = from.x;
        arrow.y = from.y;
        
        const angle = Phaser.Math.Angle.Between(from.x, from.y, to.x, to.y);
        const speed = 400;
        
        arrow.setRotation(angle - Math.PI/2);
        this.arrowContainer.add(arrow);
        
        this.arrows.push({
            graphics: arrow,
            team: from.team,
            damage: from.typeData.atk,
            x: from.x,
            y: from.y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            startX: from.x,
            startY: from.y,
            angle: angle,
            maxRange: from.typeData.range * CELL_SIZE * 1.2,
            arc: false  // 平射标记
        });
    }

    // 【新增】抛射（越过友军，落地AOE）
    fireArcArrow(from, to) {
        const arrow = this.add.graphics();
        // 抛射用白色/亮色区分
        arrow.fillStyle(from.team === 'red' ? 0xffaaaa : 0xaaaaff, 1);
        
        // 抛射：起点/落地9像素（放大50%），中间6像素，1.5像素宽
        const points = [
            {x: 0, y: -4.5},
            {x: 0.75, y: 0},
            {x: 0, y: 4.5},
            {x: -0.75, y: 0}
        ];
        arrow.fillPoints(points, true);
        
        arrow.x = from.x;
        arrow.y = from.y;
        
        const angle = Phaser.Math.Angle.Between(from.x, from.y, to.x, to.y);
        
        arrow.setRotation(angle - Math.PI/2);
        this.arrowContainer.add(arrow);
        
        this.arrows.push({
            graphics: arrow,
            team: from.team,
            damage: from.typeData.atk,
            x: from.x,
            y: from.y,
            startX: from.x,
            startY: from.y,
            targetX: to.x,  // 目标位置（用于计算落地）
            targetY: to.y,
            angle: angle,
            progress: 0,    // 飞行进度 0~1
            arcSpeed: 0.8,  // 【减慢】抛射飞行速度（每秒0.8个全程，约1.25秒）
            arc: true,      // 抛射标记
            arcHeight: 80   // 【加高】抛物线高度
        });
    }

    updateArrows(dt) {
        for (let i = this.arrows.length - 1; i >= 0; i--) {
            const arrow = this.arrows[i];
            
            // 【抛射逻辑】
            if (arrow.arc) {
                arrow.progress += arrow.arcSpeed * dt;
                
                if (arrow.progress >= 1) {
                    // 落地，造成AOE伤害
                    this.arrowArcLanded(arrow);
                    arrow.graphics.destroy();
                    this.arrows.splice(i, 1);
                    continue;
                }
                
                // 计算抛物线位置
                const curX = arrow.startX + (arrow.targetX - arrow.startX) * arrow.progress;
                const curY = arrow.startY + (arrow.targetY - arrow.startY) * arrow.progress;
                
                // 视觉偏移（模拟高度）
                const heightOffset = Math.sin(arrow.progress * Math.PI) * arrow.arcHeight;
                // 大小变化：起点1.0（6px）-> 中间0.67（4px）-> 终点1.0（6px）
                const heightFactor = Math.sin(arrow.progress * Math.PI);
                const scale = 1.0 - heightFactor * 0.33;  // 1.0 -> 0.67 -> 1.0
                
                arrow.graphics.x = curX;
                arrow.graphics.y = curY - heightOffset;
                arrow.graphics.setScale(scale);
                
                continue; // 抛射不检测途中碰撞
            }
            
            // 【平射逻辑】
            arrow.x += arrow.vx * dt;
            arrow.y += arrow.vy * dt;
            
            arrow.graphics.x = arrow.x;
            arrow.graphics.y = arrow.y;
            
            const travelDist = Phaser.Math.Distance.Between(
                arrow.startX, arrow.startY, arrow.x, arrow.y
            );
            
            if (travelDist > arrow.maxRange) {
                arrow.graphics.destroy();
                this.arrows.splice(i, 1);
                continue;
            }
            
            const hitUnit = this.checkArrowHit(arrow);
            if (hitUnit) {
                const damage = Math.max(1, arrow.damage - hitUnit.typeData.def);
                hitUnit.hp -= damage;
                
                if (hitUnit.team === arrow.team) {
                    this.showFriendlyFire(hitUnit.x, hitUnit.y);
                }
                
                arrow.graphics.destroy();
                this.arrows.splice(i, 1);
                continue;
            }
            
            if (arrow.x < 0 || arrow.x > WIDTH || arrow.y > HEIGHT) {
                arrow.graphics.destroy();
                this.arrows.splice(i, 1);
            }
        }
    }

    checkArrowHit(arrow) {
        const allAliveUnits = this.units.filter(u => u.hp > 0);
        
        for (const unit of allAliveUnits) {
            const distToUnit = Phaser.Math.Distance.Between(
                arrow.x, arrow.y, unit.x, unit.y
            );
            
            if (distToUnit < unit.collisionRadius + 6) {
                const angleToUnit = Phaser.Math.Angle.Between(
                    arrow.startX, arrow.startY, unit.x, unit.y
                );
                const angleDiff = Math.abs(Phaser.Math.Angle.Wrap(
                    angleToUnit - arrow.angle
                ));
                
                if (angleDiff < Math.PI / 2) {
                    return unit;
                }
            }
        }
        return null;
    }

    showFriendlyFire(x, y) {
        const text = this.add.text(x, y - 30, '误伤!', {
            fontSize: '12px',
            color: '#ff6666',
            fontWeight: 'bold',
            stroke: '#000000',
            strokeThickness: 2
        }).setOrigin(0.5);
        
        this.effectContainer.add(text);
        
        this.tweens.add({
            targets: text,
            y: y - 50,
            alpha: 0,
            duration: 600,
            onComplete: () => text.destroy()
        });
    }

    // 【新增】抛射落地AOE伤害
    arrowArcLanded(arrow) {
        const hitRadius = 20; // 【方案A】AOE范围缩小到20px（与检测对齐）
        const allAliveUnits = this.units.filter(u => u.hp > 0);
        
        for (const unit of allAliveUnits) {
            const dist = Phaser.Math.Distance.Between(arrow.targetX, arrow.targetY, unit.x, unit.y);
            if (dist < hitRadius) {
                // 距离衰减：中心100%，边缘50%
                const damageMult = 1 - (dist / hitRadius) * 0.5;
                const damage = Math.max(1, Math.floor((arrow.damage - unit.typeData.def) * damageMult));
                unit.hp -= damage;
                
                // 抛射可误伤
                if (unit.team === arrow.team && damage > 0) {
                    this.showFriendlyFire(unit.x, unit.y);
                }
            }
        }
    }

    cleanupDead() {
        this.units.forEach(unit => {
            if (unit.hp <= 0 && !unit.dead) {
                unit.dead = true;
                this.totalKills++;
                
                unit.shape.clear();
                unit.shape.lineStyle(2, unit.team === 'red' ? 0x664444 : 0x444466);
                const s = unit.typeData.size * 0.6;
                unit.shape.moveTo(-s, -s);
                unit.shape.lineTo(s, s);
                unit.shape.moveTo(s, -s);
                unit.shape.lineTo(-s, s);
                unit.shape.strokePath();
                unit.shape.setAlpha(0.4);
            }
        });
    }

    updateStats() {
        const redAlive = this.units.filter(u => u.team === 'red' && u.hp > 0).length;
        const blueAlive = this.units.filter(u => u.team === 'blue' && u.hp > 0).length;
        
        document.getElementById('red-count').textContent = redAlive;
        document.getElementById('blue-count').textContent = blueAlive;
        document.getElementById('kills').textContent = this.totalKills;
    }

    showWinner(winner) {
        this.winnerText = this.add.text(WIDTH/2, HEIGHT/2 - 50, `${winner} 胜利!`, {
            fontSize: '48px',
            fontWeight: 'bold',
            stroke: '#000000',
            strokeThickness: 6
        }).setOrigin(0.5);
        
        this.winnerText.setColor(winner.includes('红') ? '#ff6b6b' : '#4ecdc4');
    }

    setSpeed(speed) {
        this.gameSpeed = speed;
    }

    togglePause() {
        this.isPaused = !this.isPaused;
    }

    restart(redConfig, blueConfig, clearOnly = false) {
        if (this.winnerText) {
            this.winnerText.destroy();
            this.winnerText = null;
        }
        
        if (this.deployText) {
            this.deployText.destroy();
            this.deployText = null;
        }
        
        this.arrows.forEach(a => a.graphics.destroy());
        this.arrows = [];
        
        this.units.forEach(u => {
            if (u.container) u.container.destroy();
        });
        this.units = [];
        
        this.totalKills = 0;
        this.battleStarted = false;
        
        if (clearOnly) return;
        
        if (redConfig && blueConfig) {
            this.startBattle(redConfig, blueConfig);
        } else {
            this.showWaitingText();
        }
    }

    // ==================== 骑兵辅助函数 ====================
    smoothRotate(unit, targetRotation, speed) {
        if (!unit || !unit.container) return 0;
        
        let current = unit.container.rotation;
        current = Phaser.Math.Angle.Wrap(current);
        targetRotation = Phaser.Math.Angle.Wrap(targetRotation);
        
        let diff = targetRotation - current;
        diff = Phaser.Math.Angle.Wrap(diff);
        
        if (Math.abs(diff) < 0.05) {
            unit.container.setRotation(targetRotation);
            return 0;
        }
        
        const newRotation = current + diff * Math.min(speed, 1);
        unit.container.setRotation(newRotation);
        
        return diff;
    }

    calculateReformTarget(unit, enemies) {
        if (!enemies || enemies.length === 0) {
            unit.isReforming = false;
            unit.hasCharged = false;
            return;
        }
        
        let centerX = 0, centerY = 0;
        enemies.forEach(e => {
            centerX += e.x;
            centerY += e.y;
        });
        centerX /= enemies.length;
        centerY /= enemies.length;
        
        const angleFromCenter = Phaser.Math.Angle.Between(centerX, centerY, unit.x, unit.y);
        const reformDist = 80 + Math.random() * 40;
        
        unit.reformTargetX = unit.x + Math.cos(angleFromCenter) * reformDist;
        unit.reformTargetY = unit.y + Math.sin(angleFromCenter) * reformDist;
        
        unit.reformTargetX = Phaser.Math.Clamp(unit.reformTargetX, 20, WIDTH - 20);
        unit.reformTargetY = Phaser.Math.Clamp(unit.reformTargetY, 20, HEIGHT - 20);
    }
}
