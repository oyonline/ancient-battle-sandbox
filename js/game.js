// ==================== 等距视角战斗场景 ====================
// 帝国时代2 风格：斜45°菱形地块 + Kenney 兵种贴图 + y轴深度排序

const GRID_W = 32, GRID_H = 16;
const TW = 64, TH = 32;                       // 菱形块宽高
const OX = GRID_H * TW / 2, OY = 120;         // 屏幕原点偏移
const VIEW_W = (GRID_W + GRID_H) * TW / 2;    // 1344
const VIEW_H = OY + (GRID_W + GRID_H) * TH / 2 + 60;

function gridToScreen(gx, gy) {
    return { x: (gx - gy) * TW / 2 + OX, y: (gx + gy) * TH / 2 + OY };
}

class IsoBattleScene extends Phaser.Scene {
    constructor() {
        super({ key: 'IsoBattleScene' });
    }

    preload() {
        Object.values(MANIFEST.units).forEach(u =>
            this.load.image(u.file.replace('.png', ''), 'assets/' + u.file));
        Object.values(MANIFEST.props).forEach(p =>
            this.load.image(p.file.replace('.png', ''), 'assets/' + p.file));
    }

    create() {
        this.units = [];
        this.arrows = [];
        this.battleStarted = false;
        this.battleOver = false;
        this.paused = false;
        this.gameSpeed = 1;
        this.cavalryAI = new CavalryAI();

        this.createOceanBackdrop();   // 全屏海面：填满菱形外的屏幕四角
        this.drawGround();
        this.placeDecorations();
        this.spawnZoneGfx = this.add.graphics();
        this.drawSpawnZones();

        this.groundFX = this.add.container(0, 0).setDepth(10);
        this.unitLayer = this.add.container(0, 0).setDepth(1000);
        this.airFX = this.add.container(0, 0).setDepth(100000);

        this.setupCamera();

        if (typeof UI !== 'undefined' && UI.onSceneReady) UI.onSceneReady(this);
    }

    // ---------------- 全屏海面（铺满菱形外的屏幕区域） ----------------
    createOceanBackdrop() {
        this.ocean = this.add.graphics().setDepth(-1).setScrollFactor(0);
        this.oceanWaves = this.add.graphics().setDepth(-1).setScrollFactor(0);
        this.redrawOcean();
        // 海面缓慢起伏
        this.tweens.add({
            targets: this.oceanWaves, y: 4, duration: 2600, yoyo: true,
            repeat: -1, ease: 'Sine.InOut'
        });
    }

    redrawOcean() {
        const w = this.scale.gameSize.width, h = this.scale.gameSize.height;
        const g = this.ocean, gw = this.oceanWaves;
        // 底色画 3 倍屏幕大，缩放/平移永远不露边
        g.clear();
        g.fillStyle(0x1c3f5c, 1);
        g.fillRect(-w, -h, w * 3, h * 3);
        // 中心区域稍亮（岛屿附近的浅海感）
        g.fillStyle(0x265a80, 0.5);
        g.fillRect(-w * 0.1, -h * 0.1, w * 1.2, h * 1.2);

        // 波纹：水平短划错位排布
        gw.clear();
        gw.lineStyle(2, 0x4a7da6, 0.32);
        let n = 0;
        for (let row = 0; row < Math.ceil(h / 34) + 2; row++) {
            const offset = (row % 3) * 23;
            for (let cx = -30; cx < w + 30; cx += 64) {
                const len = 10 + ((row * 7 + cx) % 3) * 7;
                gw.lineBetween(cx + offset, row * 34 - 10, cx + offset + len, row * 34 - 10);
                n++;
                if (n > 400) break;
            }
        }
        // 稀疏亮点
        gw.lineStyle(2, 0x7fb2d6, 0.25);
        for (let i = 0; i < 30; i++) {
            const x = (i * 173.7) % w, y = (i * 97.1) % h;
            gw.lineBetween(x, y, x + 8, y);
        }
    }

    // ---------------- 地面与装饰 ----------------
    // 帝国风地形：杂色草地 + 立体倒角 + 水域环绕 + 海岸黄边 + 暗角
    drawGround() {
        const g = this.add.graphics().setDepth(0);
        const isWater = (gx, gy) => gx === 0 || gy === 0 || gx === GRID_W - 1 || gy === GRID_H - 1;
        const hash = (a, b) => {
            let h = (a * 374761393 + b * 668265263) ^ 0x5bf03635;
            h = (h ^ (h >> 13)) * 1274126177;
            return ((h ^ (h >> 16)) >>> 0) / 4294967295;
        };
        const dia = (x, y, s) => [
            { x: x, y: y - TH / 2 * s }, { x: x + TW / 2 * s, y: y },
            { x: x, y: y + TH / 2 * s }, { x: x - TW / 2 * s, y: y }
        ];

        for (let gy = 0; gy < GRID_H; gy++) {
            for (let gx = 0; gx < GRID_W; gx++) {
                const { x, y } = gridToScreen(gx, gy);
                const r1 = hash(gx, gy), r2 = hash(gx + 97, gy + 31), r3 = hash(gx - 7, gy + 61);

                if (isWater(gx, gy)) {
                    // 水面：两种蓝做棋盘变化 + 波纹
                    const w = r1 > 0.5 ? 0x3d84c6 : 0x4a94d4;
                    g.fillStyle(w, 1);
                    g.fillPoints(dia(x, y, 1.02), true);
                    g.lineStyle(1, 0x2c6da8, 0.6);
                    g.strokePoints(dia(x, y, 1.0), true);
                    // 波纹短线
                    g.lineStyle(2, 0xbfe4f7, 0.35);
                    for (let i = 0; i < 2; i++) {
                        const wx = x + (hash(gx * 3 + i, gy) - 0.5) * 24;
                        const wy = y + (hash(gx, gy * 3 + i) - 0.5) * 10;
                        g.lineBetween(wx - 7, wy, wx + 7, wy);
                    }
                    continue;
                }

                // 草地：帝国风偏橄榄绿 + 明度噪点
                const lf = 0.88 + r1 * 0.2;                       // 整块明度
                const base = [Math.round(92 * lf), Math.round(142 * lf), Math.round(64 * lf)];
                const col = Phaser.Display.Color.GetColor(base[0], base[1], base[2]);
                g.fillStyle(col, 1);
                g.fillPoints(dia(x, y, 1.0), true);

                // 3~5 块不规则深浅草斑
                const patches = 3 + Math.floor(r2 * 3);
                for (let i = 0; i < patches; i++) {
                    const pr = hash(gx * 7 + i, gy * 13 + i);
                    const dark = pr > 0.5;
                    const pf = dark ? 0.82 + hash(i, gx + gy) * 0.08 : 1.12 + hash(i, gx * 2) * 0.1;
                    const pc = Phaser.Display.Color.GetColor(
                        Math.min(255, Math.round(base[0] * pf)),
                        Math.min(255, Math.round(base[1] * pf)),
                        Math.min(255, Math.round(base[2] * pf)));
                    const px = x + (hash(gx + i * 17, gy) - 0.5) * TW * 0.55;
                    const py = y + (hash(gx, gy + i * 17) - 0.5) * TH * 0.55;
                    g.fillStyle(pc, 0.45);
                    g.fillPoints(dia(px, py, 0.28 + pr * 0.22), true);
                }

                // 草叶点簇
                g.fillStyle(0x4c7a34, 0.55);
                for (let i = 0; i < 4; i++) {
                    const sx = x + (hash(gx * 5 + i, gy * 11) - 0.5) * TW * 0.6;
                    const sy = y + (hash(gx * 11, gy * 5 + i) - 0.5) * TH * 0.6;
                    g.fillCircle(sx, sy, 1.2 + hash(i, gx + gy * 2) * 1.4);
                }

                // 海岸：贴水的草地加黄沙边
                if (isWater(gx - 1, gy) || isWater(gx + 1, gy) || isWater(gx, gy - 1) || isWater(gx, gy + 1)) {
                    g.fillStyle(0xd8c48a, 0.22);
                    g.fillPoints(dia(x, y, 0.96), true);
                }

                // 立体倒角：上左边缘亮，下右边缘暗
                g.lineStyle(2, 0xd7e8b0, 0.28);
                g.lineBetween(x - TW / 2, y, x, y - TH / 2);
                g.lineBetween(x, y - TH / 2, x + TW / 2, y);
                g.lineStyle(2, 0x1e3311, 0.3);
                g.lineBetween(x + TW / 2, y, x, y + TH / 2);
                g.lineBetween(x, y + TH / 2, x - TW / 2, y);
            }
        }

        // 水面高光闪点（缓慢呼吸）
        for (let i = 0; i < 10; i++) {
            const side = i % 4;
            const t = hash(i, 777);
            let wx, wy;
            if (side === 0) { const { x, y } = gridToScreen(1 + t * (GRID_W - 2), 0); wx = x; wy = y; }
            else if (side === 1) { const { x, y } = gridToScreen(1 + t * (GRID_W - 2), GRID_H - 1); wx = x; wy = y; }
            else if (side === 2) { const { x, y } = gridToScreen(0, 1 + t * (GRID_H - 2)); wx = x; wy = y; }
            else { const { x, y } = gridToScreen(GRID_W - 1, 1 + t * (GRID_H - 2)); wx = x; wy = y; }
            const spark = this.add.graphics().setDepth(2);
            spark.fillStyle(0xffffff, 0.5);
            spark.fillEllipse(wx, wy, 10, 3);
            this.tweens.add({
                targets: spark, alpha: { from: 0.15, to: 0.75 },
                duration: 1400 + i * 230, yoyo: true, repeat: -1,
                delay: hash(i, 42) * 1200
            });
        }

        // 全图暗角（画面四角压暗，聚焦战场中心）——屏幕空间，随窗口自适应
        const vig = this.textures.createCanvas('vignette', 512, 320);
        const vctx = vig.getContext();
        const grad = vctx.createRadialGradient(256, 160, 90, 256, 160, 300);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, 'rgba(10,14,6,0.5)');
        vctx.fillStyle = grad;
        vctx.fillRect(0, 0, 512, 320);
        vig.refresh();
        this.vignette = this.add.image(0, 0, 'vignette').setDepth(90000).setScrollFactor(0);
    }

    placeDecorations() {
        const deco = [
            // 双方大本营：箭塔 + 石墙（要塞感）
            ['tower', 1.8, 2.0], ['tower', 1.8, 8.0], ['tower', 1.8, 14.0],
            ['tower', 30.2, 2.0], ['tower', 30.2, 8.0], ['tower', 30.2, 14.0],
            // 边界树林（上下缘，不挡主战场）
            ['tree_big', 5, 1.4], ['tree_small', 9, 1.0], ['tree_big', 13, 1.5], ['tree_small', 20, 1.1], ['tree_big', 24, 1.4], ['tree_small', 28, 1.0],
            ['tree_big', 6, 14.8], ['tree_small', 10, 15.1], ['tree_big', 15, 14.9], ['tree_small', 19, 15.2], ['tree_big', 24, 15.0], ['tree_small', 28, 14.8],
            // 零散岩石
            ['rock', 12.5, 1.6], ['rock', 22.5, 1.3], ['rock', 8, 14.7], ['rock', 26, 15.0]
        ];
        deco.forEach(([key, gx, gy]) => {
            const { x, y } = gridToScreen(gx, gy);
            const spr = this.add.image(x, y, 'props/' + key).setOrigin(0.5, 0.92);
            spr.setScale(key === 'tower' ? 1.05 : 0.9);
            spr.setDepth((gx + gy) * 100 + 10);
        });
    }

    drawSpawnZones() {
        const g = this.spawnZoneGfx.setDepth(5).setAlpha(0.22);
        const zone = (x0, x1, color) => {
            for (let gy = 1; gy < GRID_H - 1; gy++)
                for (let gx = x0; gx < x1; gx++) {
                    const { x, y } = gridToScreen(gx, gy);
                    g.fillStyle(color, 1);
                    g.fillPoints([
                        { x, y: y - TH / 2 }, { x: x + TW / 2, y },
                        { x, y: y + TH / 2 }, { x: x - TW / 2, y }
                    ], true);
                }
        };
        zone(1, 8, 0xff5555);
        zone(GRID_W - 7, GRID_W - 1, 0x5599ff);
    }

    setupCamera() {
        const cam = this.cameras.main;
        this.userZoom = 1;
        this.mapCenter = { x: VIEW_W / 2, y: OY + (GRID_W + GRID_H) * TH / 4 };

        // 相机铺满策略：以地图对角线为基准计算缩放，窗口比例不同则多露水面
        this.fitCamera();
        this.scale.on('resize', () => this.fitCamera());

        // 拖拽平移
        this.input.on('pointermove', p => {
            if (p.isDown && !this._pinching) {
                cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
                cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
            }
        });
        // 滚轮缩放（在铺满基准上叠加用户缩放）
        this.input.on('wheel', (p, go, dx, dy) => {
            this.userZoom = Phaser.Math.Clamp(this.userZoom - dy * 0.001, 0.6, 2.4);
            this.applyZoom();
        });
    }

    // 依据窗口尺寸计算铺满缩放（覆盖式：宁可多裁四角水面，不留黑边）
    fitCamera() {
        const cam = this.cameras.main;
        const w = this.scale.gameSize.width;
        const h = this.scale.gameSize.height;
        // 地图的世界包围盒（含装饰余量）
        const mw = VIEW_W + 260, mh = VIEW_H + 320;
        this.baseZoom = Math.max(w / mw, h / mh) * 1.06;
        cam.setBounds(-99999, -99999, 199998, 199998);  // 允许自由平移
        this.applyZoom();
        cam.centerOn(this.mapCenter.x, this.mapCenter.y);
        if (this.ocean) this.redrawOcean();
        if (this.vignette) {
            this.vignette.setPosition(w / 2, h / 2).setDisplaySize(w * 1.15, h * 1.25);
        }
    }

    applyZoom() {
        const cam = this.cameras.main;
        cam.setZoom(this.baseZoom * this.userZoom);
        // 用户缩放后保持地图居中
        if (this.mapCenter) cam.centerOn(this.mapCenter.x, this.mapCenter.y);
    }

    // ---------------- 部署与开战 ----------------
    deployUnits(redConfig, blueConfig, redFormation, blueFormation) {
        this.clearUnits();
        this.drawSpawnZones();
        const armies = [
            ['red', redConfig, redFormation],
            ['blue', blueConfig, blueFormation]
        ];
        armies.forEach(([team, cfg, formation]) => {
            generateArmyPositions(team, cfg, formation).forEach(p => this.spawnUnit(team, p.type, p.gx, p.gy));
        });
        this.battleStarted = false;
        this.battleOver = false;
    }

    spawnUnit(team, type, gx, gy) {
        const typeData = UNIT_TYPES[type];
        const key = `units/${team}_${type}`;
        const { x, y } = gridToScreen(gx, gy);
        const depth = (gx + gy) * 100;

        // 真实投影：脚下半透明暗椭圆 + 细队伍色圈
        const ring = this.add.graphics();
        ring.fillStyle(0x10160a, 0.32);
        ring.fillEllipse(0, 1, 26, 12);
        ring.lineStyle(2.5, team === 'red' ? 0xff3b30 : 0x2f7bff, 0.9);
        ring.strokeEllipse(0, 1, 17, 8.5);
        ring.setPosition(x, y);
        ring.setDepth(depth + 48);

        const spr = this.add.image(x, y, key).setOrigin(0.5, 1);
        spr.setScale(typeData.scale * 1.25);
        spr.setDepth(depth + 50);

        const hpBar = this.add.graphics().setVisible(false);
        hpBar.setDepth(depth + 55);

        const unit = {
            team, type, typeData, gx, gy,
            hp: typeData.hp, maxHp: typeData.hp,
            spr, ring, hpBar,
            lastAttack: 0, lastContact: 0,
            state: 'charge', stateTime: 0, reformX: null, target: null,
            moving: false, dead: false, flashUntil: 0,
            bobPhase: Math.random() * Math.PI * 2,
            lastSX: x, scene: this
        };
        this.units.push(unit);
        return unit;
    }

    startCountdown(onDone) {
        const steps = ['3', '2', '1', '开战！'];
        steps.forEach((txt, i) => {
            this.time.delayedCall(i * 800, () => {
                const t = this.add.text(VIEW_W / 2, OY + 140, txt, {
                    fontSize: txt === '开战！' ? '96px' : '120px',
                    fontStyle: 'bold', color: txt === '开战！' ? '#ffd24a' : '#ffffff',
                    stroke: '#000000', strokeThickness: 8,
                    fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif'
                }).setOrigin(0.5).setDepth(200000);
                this.tweens.add({ targets: t, scale: txt === '开战！' ? 1.15 : 1, alpha: 0, duration: 700, onComplete: () => t.destroy() });
                if (Snd) Snd.play(i === 3 ? 'go' : 'tick');
                if (i === 3) { this.battleStarted = true; this.spawnZoneGfx.clear(); if (onDone) onDone(); }
            });
        });
    }

    clearUnits() {
        this.units.forEach(u => { u.spr.destroy(); u.ring.destroy(); u.hpBar.destroy(); });
        this.units = [];
        this.arrows.forEach(a => a.gfx && a.gfx.destroy());
        this.arrows = [];
        if (this.winnerText) { this.winnerText.destroy(); this.winnerText = null; }
        this.battleOver = false;
        this.battleStarted = false;
    }

    // ---------------- 战斗主循环 ----------------
    update(time, delta) {
        if (!this.battleStarted || this.paused || this.battleOver) { this.syncRender(time); return; }
        const dt = Math.min(delta, 50) / 1000 * this.gameSpeed;
        const now = this.time.now;

        // 帧首：先用上一帧位移估计速度，再刷新快照（供箭矢预判）
        this.units.forEach(unit => {
            if (unit.pgx !== undefined) {
                unit.velX = (unit.gx - unit.pgx) / dt;
                unit.velY = (unit.gy - unit.pgy) / dt;
            }
            unit.pgx = unit.gx; unit.pgy = unit.gy;
        });

        this.units.forEach(unit => {
            if (unit.dead) return;
            unit.moving = false;
            const enemies = this.units.filter(u => u.team !== unit.team && !u.dead);
            if (enemies.length === 0) return;

            if (unit.type === 'cavalry' && unit.state !== 'melee') {
                if (this.cavalryAI.update(unit, enemies, now, dt)) { this.syncOne(unit, time); return; }
            }
            this.updateNormalUnit(unit, enemies, now, dt);
        });
        this.separate(dt);
        this.updateArrows(dt, now);
        this.syncRender(time);
        this.checkWin();
    }

    updateNormalUnit(unit, enemies, now, dt) {
        let nearest = null, minD = Infinity;
        enemies.forEach(e => { const d = dist(unit, e); if (d < minD) { minD = d; nearest = e; } });
        if (!nearest) return;
        const range = unit.typeData.range;

        if (unit.typeData.ranged) {
            // 弓箭手：全军集火同一残血目标，保持距离放风筝
            let shootTarget = null, bestScore = Infinity;
            enemies.forEach(e => {
                const d = dist(unit, e);
                if (d > range) return;
                const score = e.hp * 1000 + this.units.indexOf(e);   // 血量主导，序号保证全队同打一个
                if (score < bestScore) { bestScore = score; shootTarget = e; }
            });
            if (minD > range) {
                moveToward(unit, nearest.gx, nearest.gy, unit.typeData.speed * 0.55, dt);
            } else if (minD < 3.2) {
                // 敌人逼近：边退边让队友输出
                const a = Math.atan2(unit.gy - nearest.gy, unit.gx - nearest.gx);
                moveToward(unit, unit.gx + Math.cos(a) * 3, unit.gy + Math.sin(a) * 3, unit.typeData.speed * 0.92, dt);
            }
            if (shootTarget && now - unit.lastAttack > unit.typeData.atkSpeed) {
                unit.lastAttack = now;
                this.fireArrow(unit, shootTarget);
            }
        } else {
            if (minD > range) {
                moveToward(unit, nearest.gx, nearest.gy, unit.typeData.speed, dt);
            } else if (now - unit.lastAttack > unit.typeData.atkSpeed) {
                unit.lastAttack = now;
                const dmg = Math.max(1, unit.typeData.atk - nearest.typeData.def);
                applyDamage(nearest, dmg, unit);
                this.meleeImpact(unit, nearest);
            }
        }
    }

    // 简单碰撞排斥，避免单位重叠
    separate(dt) {
        const R = 0.52;
        for (let i = 0; i < this.units.length; i++) {
            const a = this.units[i];
            if (a.dead) continue;
            for (let j = i + 1; j < this.units.length; j++) {
                const b = this.units[j];
                if (b.dead) continue;
                const dx = b.gx - a.gx, dy = b.gy - a.gy;
                const d2 = dx * dx + dy * dy;
                if (d2 < R * R && d2 > 0.0001) {
                    const d = Math.sqrt(d2);
                    const push = (R - d) * 0.5 * Math.min(1, dt * 14);
                    const nx = dx / d, ny = dy / d;
                    a.gx -= nx * push; a.gy -= ny * push;
                    b.gx += nx * push; b.gy += ny * push;
                }
            }
        }
        this.units.forEach(u => {
            u.gx = clamp(u.gx, 0.6, GRID_W - 0.6);
            u.gy = clamp(u.gy, 0.6, GRID_H - 0.6);
        });
    }

    // ---------------- 箭矢 ----------------
    fireArrow(from, target) {
        const gfx = this.add.graphics();
        const d = dist(from, target);
        const flightT = clamp(d / 12, 0.3, 0.75);
        // 预判提前量：瞄目标飞行期间的预估位置
        const lead = (v) => v ? clamp(v * flightT, -1.5, 1.5) : 0;
        this.arrows.push({
            gfx,
            sx: from.gx, sy: from.gy,
            tx: clamp(target.gx + lead(target.velX), 0.5, GRID_W - 0.5),
            ty: clamp(target.gy + lead(target.velY), 0.5, GRID_H - 0.5),
            t: 0, dur: flightT,
            dmg: from.typeData.atk, team: from.team
        });
        this.airFX.add(gfx);
        if (Snd) Snd.play('arrow');
    }

    updateArrows(dt, now) {
        for (let i = this.arrows.length - 1; i >= 0; i--) {
            const a = this.arrows[i];
            a.t += dt;
            const p = clamp(a.t / a.dur, 0, 1);
            const gx = a.sx + (a.tx - a.sx) * p;
            const gy = a.sy + (a.ty - a.sy) * p;
            const s = gridToScreen(gx, gy);
            const arcH = Math.sin(p * Math.PI) * 46;

            a.gfx.clear();
            a.gfx.lineStyle(2.5, 0x5b4632, 1);
            const ang = Math.atan2(a.ty - a.sy, a.tx - a.sx);
            const dx = Math.cos(ang) * 9, dy = Math.sin(ang) * 9 * 0.5 - 3;
            a.gfx.lineBetween(s.x - dx, s.y - dy - arcH, s.x + dx, s.y + dy - arcH);
            a.gfx.fillStyle(0xd9d9d9, 1);
            a.gfx.fillCircle(s.x + dx, s.y + dy - arcH, 2);

            if (p >= 1) {
                // 落点找最近的敌人判定命中
                let hit = null, hd = 0.75;
                this.units.forEach(u => {
                    if (u.team !== a.team && !u.dead) {
                        const d = Math.hypot(u.gx - a.tx, u.gy - a.ty);
                        if (d < hd) { hd = d; hit = u; }
                    }
                });
                if (hit) {
                    applyDamage(hit, Math.max(1, a.dmg - hit.typeData.def), null);
                    this.impactPuff(s.x, s.y, 0xffe08a);
                } else {
                    this.impactPuff(s.x, s.y, 0xcfcfcf);
                }
                a.gfx.destroy();
                this.arrows.splice(i, 1);
            }
        }
    }

    // ---------------- 特效 ----------------
    meleeImpact(attacker, target) {
        // 攻击者前顶动画
        const a = Math.atan2(target.gy - attacker.gy, target.gx - attacker.gx);
        attacker.spr.x += Math.cos(a) * 5;
        this.time.delayedCall(90, () => { if (!attacker.dead) this.syncOne(attacker, this.time.now, true); });
        const s = gridToScreen(target.gx, target.gy);
        this.impactPuff(s.x, s.y - 12, 0xffffff);
        if (Snd) Snd.play('hit');
    }

    chargeDust(unit) {
        if (Math.random() < 0.4) {
            const s = gridToScreen(unit.gx, unit.gy);
            const dust = this.add.graphics();
            dust.fillStyle(0xd8cbb4, 0.55);
            dust.fillCircle(0, 0, 2 + Math.random() * 3);
            dust.setPosition(s.x + (Math.random() - 0.5) * 14, s.y - 2);
            this.groundFX.add(dust);
            this.tweens.add({ targets: dust, alpha: 0, y: dust.y - 6, duration: 450, onComplete: () => dust.destroy() });
        }
    }

    impactPuff(x, y, color) {
        const p = this.add.graphics();
        p.fillStyle(color, 0.85);
        p.fillCircle(0, 0, 4);
        p.setPosition(x, y - 10);
        this.airFX.add(p);
        this.tweens.add({
            targets: p, scale: 2.2, alpha: 0, duration: 260,
            onComplete: () => p.destroy()
        });
    }

    killUnit(unit) {
        // 亲子友好：变灰倒下 + 烟雾"消失"，无血腥
        const s = gridToScreen(unit.gx, unit.gy);
        const poof = this.add.graphics();
        for (let i = 0; i < 4; i++) {
            poof.fillStyle(0xe0e0e0, 0.8);
            poof.fillCircle((Math.random() - 0.5) * 22, -10 - Math.random() * 16, 5 + Math.random() * 5);
        }
        poof.setPosition(s.x, s.y);
        this.airFX.add(poof);
        this.tweens.add({ targets: poof, alpha: 0, y: poof.y - 14, duration: 600, onComplete: () => poof.destroy() });

        unit.ring.destroy();
        unit.hpBar.destroy();
        this.tweens.add({
            targets: unit.spr, alpha: 0, angle: (Math.random() > 0.5 ? 1 : -1) * 75,
            y: unit.spr.y + 4, duration: 450, onComplete: () => unit.spr.destroy()
        });
        if (Snd) Snd.play('die');
        UI.updateCounts();
    }

    // ---------------- 渲染同步 ----------------
    syncRender(time) {
        this.units.forEach(u => { if (!u.dead) this.syncOne(u, time); });
    }

    syncOne(unit, time, force = false) {
        if (unit.dead) return;
        const { x, y } = gridToScreen(unit.gx, unit.gy);
        const bob = unit.moving ? Math.abs(Math.sin(time * 0.012 + unit.bobPhase)) * 2.5 : 0;
        if (!force) unit.spr.setPosition(x, y - bob);
        else unit.spr.setPosition(x, y);

        const depth = (unit.gx + unit.gy) * 100 + 50;
        unit.spr.setDepth(depth);
        unit.ring.setPosition(x, y).setDepth(depth - 2);

        // 朝向：屏幕横向移动方向决定翻转
        if (x < unit.lastSX - 0.15) unit.spr.setFlipX(true);
        else if (x > unit.lastSX + 0.15) unit.spr.setFlipX(false);
        unit.lastSX = x;

        // 受击闪白
        if (this.time.now < unit.flashUntil) unit.spr.setTintFill(0xffffff);
        else unit.spr.clearTint();

        // 血条
        if (unit.hp < unit.maxHp) {
            unit.hpBar.setVisible(true).clear();
            const w = 28, ratio = clamp(unit.hp / unit.maxHp, 0, 1);
            unit.hpBar.fillStyle(0x000000, 0.55);
            unit.hpBar.fillRect(-w / 2 - 1, -70, w + 2, 6);
            unit.hpBar.fillStyle(unit.team === 'red' ? 0xff4444 : 0x3d7be8, 1);
            unit.hpBar.fillRect(-w / 2, -69, w * ratio, 4);
            unit.hpBar.setPosition(x, y).setDepth(depth + 4);
        }
    }

    // ---------------- 胜负 ----------------
    checkWin() {
        if (this.battleOver) return;
        const red = this.units.filter(u => u.team === 'red' && !u.dead).length;
        const blue = this.units.filter(u => u.team === 'blue' && !u.dead).length;
        if (red > 0 && blue > 0) return;
        this.battleOver = true;
        const winner = red > 0 ? 'red' : 'blue';
        this.showVictory(winner);
        UI.onBattleEnd(winner, { red, blue });
    }

    showVictory(winner) {
        const isRed = winner === 'red';
        this.winnerText = this.add.text(VIEW_W / 2, OY + 150,
            isRed ? '红方胜利！🎉' : '蓝方胜利！🎉', {
            fontSize: '84px', fontStyle: 'bold',
            color: isRed ? '#ff5b5b' : '#57a0ff',
            stroke: '#000000', strokeThickness: 10,
            fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif'
        }).setOrigin(0.5).setDepth(200001).setScale(0.3);
        this.tweens.add({ targets: this.winnerText, scale: 1, duration: 400, ease: 'Back.Out' });

        // 彩带
        for (let i = 0; i < 70; i++) {
            const hsv = Phaser.Display.Color.HSVToRGB(Math.random(), 0.75, 0.9);
            const rect = this.add.rectangle(
                Math.random() * VIEW_W, -20 - Math.random() * 200,
                6 + Math.random() * 5, 10 + Math.random() * 6, hsv.color).setDepth(200000);
            this.tweens.add({
                targets: rect, y: VIEW_H + 40, angle: Math.random() * 360 - 180,
                duration: 2200 + Math.random() * 1800, delay: Math.random() * 800,
                onComplete: () => rect.destroy()
            });
        }
        if (Snd) Snd.play('win');
    }

    setSpeed(s) { this.gameSpeed = s; }
    togglePause() { this.paused = !this.paused; }
}
