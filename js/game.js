// ==================== 等距视角战斗场景 ====================
// 帝国时代2 风格：斜45°菱形地块 + Kenney 兵种贴图 + y轴深度排序

const GRID_W = 70, GRID_H = 70;              // 千人对战大棋盘
const TW = 64, TH = 32;                       // 菱形块宽高
const OX = GRID_H * TW / 2, OY = 120;         // 屏幕原点偏移
const VIEW_W = (GRID_W + GRID_H) * TW / 2;    // 4480
const VIEW_H = OY + (GRID_W + GRID_H) * TH / 2 + 60;

// 空间哈希：每 3×3 格一个桶，索敌/碰撞只查附近桶，千人规模避免 O(n²)
const SP_CELL = 3;
const SIMULATION_STEP_MS = 1000 / 60;

function quantizePosition(value, extent) {
    const center = extent / 2, offset = value - center;
    // 以地图中心为原点，正负半格都向外舍入；1e-10格容差吸收浮点半格噪声。
    return center + Math.sign(offset) * Math.floor(Math.abs(offset) * 1e6 + 0.5001) / 1e6;
}

function gridToScreen(gx, gy) {
    return { x: (gx - gy) * TW / 2 + OX, y: (gx + gy) * TH / 2 + OY };
}

// ==================== 接地基准表（素材源图像素，源图高 156） ====================
// AI 出图的底部留白每张都不一样（10~34px），若直接以贴图底边当脚底，
// 角色就会悬在影子上面 → 飘。这里把每个兵种的脚底位置量出来，统一压到地面线。
// pad = 贴图底边 → 最低脚底的留白。注意骑兵是奔姿、四条腿只有一条落地，
//       所以取“最低的实质内容行”，不能取最宽的一行（那会落在另外三条抬起的腿上，差 16px）。
// dx  = 脚掌落地处相对图心的横向偏移（骑兵马头前伸，脚掌明显偏左，影心要跟着走）；
// w/h = 脚掌投影尺寸（等距视角固定 2:1）。跑 tools/measure_foot.py 可重新量。
const FOOT = {
    infantry: { pad: 18, dx:   2, w: 72, h: 35 },
    pikeman:  { pad: 34, dx:  -7, w: 63, h: 31 },
    archer:   { pad: 11, dx:  -6, w: 67, h: 33 },
    cavalry: {
        east:      { pad:  4, dx: -10, w: 83, h: 41 },
        southeast: { pad: 10, dx: -16, w: 74, h: 36 },
        south:     { pad:  5, dx:   0, w: 24, h: 12 },
        northeast: { pad: 12, dx: -20, w: 62, h: 30 },
        north:     { pad:  3, dx: -26, w: 24, h: 12 }
    }
};

// ==================== 逐帧对齐补正（素材源图像素，[dx, dy]，站姿为 0） ====================
// 同一套动画的 4 帧，角色在画布里的站位互相差最多 30px（骑兵 16px），直接播就会左右抖。
// 每帧的补正值 = 与站姿做投影相关求出的最佳位移；兵种为准，红蓝通用。
// 攻击帧只给横向：挥砍会让重心大幅上下移动，纵向相关不可靠（帧间重合度仅 0.6~0.8），
// 而攻击是一次性动作，纵向的小跳不易察觉。跑 tools/measure_foot.py 可重新量。
const ANIM_ALIGN = {
    infantry: { walk: [[1, 0], [-10, 4], [-9, 3], [-30, 4]], attack: [[5, 0], [10, 0], [-8, 0], [-14, 0]] },
    pikeman:  { walk: [[0, -1], [-1, -2], [-3, -3], [-7, -3]], attack: [[1, 0], [1, 0], [5, 0], [-8, 0]] },
    archer:   { walk: [[0, -3], [-13, 9], [-14, 0], [-19, 0]], attack: [[7, 0], [-11, 0], [-20, 0], [12, 0]] },
    cavalry: {
        east:      { walk: [[0, -1], [-9, 0], [-6, 0], [-14, 1]], attack: [[1, 0], [-6, 0], [2, 0], [-12, 0]] },
        southeast: { walk: [[0, 0], [-6, -1], [-16, -8], [-8, -2]], attack: [[-1, 0], [-3, 0], [-2, 0], [-10, 0]] },
        south:     { walk: [[0, 0], [-11, 1], [-5, 0], [-9, 0]], attack: [[16, 0], [2, 0], [-23, 0], [-11, 0]] },
        northeast: { walk: [[0, 0], [-10, 5], [-13, 5], [-14, -7]], attack: [[-2, 0], [-11, 0], [-6, 0], [-16, 0]] },
        north:     { walk: [[0, 0], [-17, 1], [-23, -2], [-30, 1]], attack: [[0, 0], [-19, 0], [-21, 0], [-31, 0]] }
    }
};
const ANIM_ALIGN_K = 1;   // 对齐补正强度：1 = 全量纠正抖动，0 = 关闭（保留原始位移）

const CAVALRY_HEADINGS = ['east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north', 'northeast'];
const CAVALRY_HEADING_INDEX = {
    east: 0, southeast: 1, south: 2, southwest: 3,
    west: 4, northwest: 5, north: 6, northeast: 7
};
const CAVALRY_PROFILE = {
    east: 'east', southeast: 'southeast', south: 'south', southwest: 'southeast',
    west: 'east', northwest: 'northeast', north: 'north', northeast: 'northeast'
};
const CAVALRY_PROFILE_SUFFIX = {
    east: '', southeast: '_down', south: '_south', northeast: '_northeast', north: '_north'
};
const CAVALRY_FLIPPED = new Set(['west', 'southwest', 'northwest']);
const CAVALRY_DIR_STEP = Math.PI / 4;
const CAVALRY_DIR_HYSTERESIS = Math.PI / 24; // 7.5°；当前方向保持到中心角 ±30°
const TWO_PI = Math.PI * 2;

function cavalryProfile(heading) {
    return CAVALRY_PROFILE[heading] || 'east';
}

function cavalryRenderSign(heading) {
    return CAVALRY_FLIPPED.has(heading) ? -1 : 1;
}

function cavalryHeadingFromMotion(dx, dy, current = 'east') {
    let angle = Math.atan2(dy, dx);
    if (angle < 0) angle += TWO_PI;
    const currentIndex = CAVALRY_HEADING_INDEX[current] ?? 0;
    const currentAngle = currentIndex * CAVALRY_DIR_STEP;
    let distance = Math.abs(angle - currentAngle);
    if (distance > Math.PI) distance = TWO_PI - distance;
    if (distance <= CAVALRY_DIR_STEP / 2 + CAVALRY_DIR_HYSTERESIS) return current;
    return CAVALRY_HEADINGS[Math.round(angle / CAVALRY_DIR_STEP) & 7];
}

function unitVisualDirections(type) {
    return type === 'cavalry' ? ['east', 'southeast', 'south', 'northeast', 'north'] : ['side'];
}

function footProfile(type, visualDir = 'side') {
    return type === 'cavalry' ? FOOT.cavalry[cavalryProfile(visualDir)] : FOOT[type];
}

function animAlignProfile(type, visualDir = 'side') {
    return type === 'cavalry' ? ANIM_ALIGN.cavalry[cavalryProfile(visualDir)] : ANIM_ALIGN[type];
}

function shadowTextureKey(team, type, visualDir = 'side') {
    const direction = type === 'cavalry' ? `-${cavalryProfile(visualDir)}` : '';
    return `shadow-${team}-${type}${direction}`;
}

// 平滑值噪声：大尺度地形色带（肥沃绿 ↔ 干草黄）用
function makeNoise(seed) {
    const hash2 = (x, y) => {
        let h = (x * 374761393 + y * 668265263) ^ seed;
        h = (h ^ (h >> 13)) * 1274126177;
        return ((h ^ (h >> 16)) >>> 0) / 4294967295;
    };
    return (x, y) => {
        const xi = Math.floor(x), yi = Math.floor(y);
        const xf = x - xi, yf = y - yi;
        const sm = t => t * t * (3 - 2 * t);
        const a = hash2(xi, yi), b = hash2(xi + 1, yi);
        const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
        const u = sm(xf), v = sm(yf);
        return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
    };
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
        Object.values(MANIFEST.corpses || {}).forEach(c =>
            this.load.image(c.file.replace('.png', ''), 'assets/' + c.file));
        Object.values(MANIFEST.deaths || {}).forEach(c =>
            this.load.spritesheet(c.file.replace('.png', ''), 'assets/' + c.file,
                { frameWidth: c.fw, frameHeight: c.fh }));
        // 动画帧条（walk/attack spritesheet）
        Object.values(MANIFEST.anims || {}).forEach(clips => {
            Object.values(clips).forEach(c => {
                this.load.spritesheet(
                    'assets/units/' + c.file.replace('.png', ''),
                    'assets/units/' + c.file,
                    { frameWidth: c.fw, frameHeight: c.fh });
            });
        });
    }

    // 注册各单位动画剪辑（重复开局幂等）
    buildUnitAnims() {
        Object.entries(MANIFEST.anims || {}).forEach(([unit, clips]) => {
            const isCav = unit.includes('cavalry');
            Object.entries(clips).forEach(([clip, c]) => {
                const key = 'assets/units/' + c.file.replace('.png', '');
                if (this.anims.exists(key)) return;
                this.anims.create({
                    key,
                    frames: this.anims.generateFrameNumbers(key, { start: 0, end: c.frames - 1 }),
                    frameRate: clip === 'attack' ? 15 : (isCav ? 13 : 9),
                    repeat: clip === 'attack' ? 0 : -1
                });
            });
        });
        // 死亡阴影只保留接触暗部，不把活体的红蓝队伍圈盖进尸体层。
        if (!this.textures.exists('death-contact-shadow')) {
            const g = this.make.graphics({ add: false });
            g.fillStyle(0x0c1206, 0.18);
            g.fillEllipse(48, 24, 96, 48);
            g.fillStyle(0x0c1206, 0.22);
            g.fillEllipse(48, 24, 70, 32);
            g.generateTexture('death-contact-shadow', 96, 48);
            g.destroy();
        }
    }

    create() {
        this.units = [];
        this.arrows = [];
        this.bloods = [];
        this.bloodQueue = [];
        this.battleStarted = false;
        this.battleOver = false;
        this.paused = false;
        this.gameSpeed = 1;
        this.battleId = 0;
        this.countdownTimers = [];
        this.countdownTexts = [];
        this.resetBattleData();
        this.cavalryAI = new CavalryAI();

        // 空间哈希与聚合量（每帧重建，桶数组复用避免 GC）
        this.sgrid = new Map();
        this._aliveArr = [];
        this.nextId = 1;
        this.redAlive = 0;
        this.blueAlive = 0;
        this.centroid = {
            red: { x: GRID_W / 2, y: GRID_H / 2 },
            blue: { x: GRID_W / 2, y: GRID_H / 2 }
        };
        this.deadCount = 0;
        this._countsDirty = false;
        this._fxBudget = 46;   // 每帧小特效配额（斩击弧光/火花等）
        this._dustBudget = 8;  // 每帧尘土配额

        this.createOceanBackdrop();   // 全屏海面：填满菱形外的屏幕四角
        this.drawGround();
        this.placeDecorations();
        this.scheduleBirds();         // 偶有飞鸟掠过
        this.spawnZoneGfx = this.add.graphics();
        this.drawSpawnZones();

        this.groundFX = this.add.container(0, 0).setDepth(10);
        this.unitLayer = this.add.container(0, 0).setDepth(1000);
        this.airFX = this.add.container(0, 0).setDepth(100000);

        // 战场留痕层：血渍与尸体增量盖印进一张全图纹理，整场只占 1 次绘制
        this.scarRT = this.add.renderTexture(0, 0, VIEW_W, VIEW_H).setOrigin(0, 0).setDepth(6);

        this.buildUnitAnims();
        this.makeShadowTextures();    // 阴影预烘焙成贴图（千人合批，见 syncOne）

        // 共享绘制层：血条 / 箭矢 / 血粒子 各一张 Graphics，全场景合批
        this.hpGfx = this.add.graphics().setDepth(40000);
        this.arrowGfx = this.add.graphics();
        this.airFX.add(this.arrowGfx);
        this.bloodGfx = this.add.graphics();
        this.airFX.add(this.bloodGfx);

        this.setupCamera();

        // FPS 放在顶栏下方的 DOM 层，不受战场镜头的缩放和平移影响。
        this.fpsHud = document.getElementById('performance-hud');
        this._fpsN = 0; this._fpsT = 0;

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
    // 帝国风地形：杂色草地 + 立体倒角 + 水域环绕 + 海岸黄边
    // 70×70 = 4900 块、数万条图形指令：一次性烘焙成大贴图，之后每帧只画一张图
    drawGround() {
        const g = this.make.graphics({ add: false });
        this.terNoise = this.terNoise || makeNoise(7);
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
                const r1 = hash(gx, gy), r2 = hash(gx + 97, gy + 31);

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

                // 草地：AOE2 式大尺度干湿色带（肥沃绿↔干草黄）+ 泥地块 + 明度噪点
                const n1 = this.terNoise(gx * 0.16, gy * 0.16);           // 宏观：整片草地深浅
                const n2 = this.terNoise(gx * 0.42 + 37, gy * 0.42 + 91); // 细节：散布泥地
                const dryMix = n1 * 0.62;
                let cr = 98 + (140 - 98) * dryMix;
                let cg = 150 + (144 - 150) * dryMix;
                let cb = 62 + (80 - 62) * dryMix;
                const dirt = n2 > 0.72 ? (n2 - 0.72) / 0.28 : 0;
                if (dirt > 0) {
                    const k = dirt * 0.85;
                    cr += (152 - cr) * k; cg += (124 - cg) * k; cb += (84 - cb) * k;
                }
                const lf = 0.9 + r1 * 0.16;                         // 整块明度
                const base = [Math.round(cr * lf), Math.round(cg * lf), Math.round(cb * lf)];
                const col = Phaser.Display.Color.GetColor(base[0], base[1], base[2]);
                g.fillStyle(col, 1);
                g.fillPoints(dia(x, y, 1.0), true);

                // 2~3 块不规则深浅草斑
                const patches = 2 + Math.floor(r2 * 2);
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
                for (let i = 0; i < 3; i++) {
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

        g.generateTexture('groundTex', VIEW_W, VIEW_H);
        g.destroy();
        this.add.image(0, 0, 'groundTex').setOrigin(0, 0).setDepth(0);

        // 水面高光闪点（缓慢呼吸）
        for (let i = 0; i < 14; i++) {
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

    }

    placeDecorations() {
        const deco = [];
        // 双方大本营：箭塔沿基地前沿一字排开（要塞感）
        [8, 20, 34, 48, 60].forEach(gy => {
            deco.push(['tower', 2.2, gy]);
            deco.push(['tower', GRID_W - 3.2, gy]);
        });
        // 上下边缘树林带 + 零散岩石（不挡主战场）
        const jit = (a, b) => a + Math.random() * (b - a);
        for (let gx = 4; gx < GRID_W - 5; gx += 3) {
            deco.push([Math.random() < 0.5 ? 'tree_big' : 'tree_small', jit(gx, gx + 2), jit(1.2, 2.6)]);
            deco.push([Math.random() < 0.5 ? 'tree_big' : 'tree_small', jit(gx, gx + 2), jit(GRID_H - 2.8, GRID_H - 1.4)]);
        }
        for (let i = 0; i < 8; i++) {
            deco.push(['rock', jit(6, GRID_W - 7), Math.random() < 0.5 ? jit(1.6, 2.4) : jit(GRID_H - 2.6, GRID_H - 1.8)]);
        }
        deco.forEach(([key, gx, gy]) => {
            const { x, y } = gridToScreen(gx, gy);
            const spr = this.add.image(x, y, 'props/' + key).setOrigin(0.5, 0.92);
            spr.setScale(key === 'tower' ? 0.48 : 0.5);   // 新像素素材原生更大，按显示高度折算
            spr.setDepth((gx + gy) * 100 + 10);
            // 树随风轻摆
            if (key.indexOf('tree') === 0) {
                this.tweens.add({
                    targets: spr, angle: { from: -1.3, to: 1.3 },
                    duration: 2600 + Math.random() * 2000,
                    yoyo: true, repeat: -1, ease: 'Sine.InOut',
                    delay: Math.random() * 1600
                });
            }
        });
    }

    // ---------------- 氛围层：飞鸟 ----------------
    scheduleBirds() {
        this.spawnBirds();
        this.time.addEvent({ delay: 9000 + Math.random() * 4000, loop: true, callback: () => this.spawnBirds() });
    }

    spawnBirds() {
        const n = 3 + Math.floor(Math.random() * 3);
        const fromLeft = Math.random() > 0.5;
        const y0 = 70 + Math.random() * 200;
        for (let i = 0; i < n; i++) {
            const bird = this.add.graphics().setDepth(150000);
            bird.lineStyle(2, 0x1c1c1c, 0.7);
            bird.lineBetween(-6, 1, 0, -3);
            bird.lineBetween(0, -3, 6, 1);
            bird.setPosition(fromLeft ? -80 - i * 30 : VIEW_W + 80 + i * 30, y0 + i * 9);
            // 振翅（离场时随 killTweensOf 一并清理）
            this.tweens.add({
                targets: bird, scaleY: { from: 1, to: 0.5 },
                duration: 170 + i * 25, yoyo: true, repeat: -1, ease: 'Sine.InOut'
            });
            this.tweens.add({
                targets: bird, x: fromLeft ? VIEW_W + 140 : -140,
                duration: 13000 + Math.random() * 3000,
                onComplete: () => {
                    this.tweens.killTweensOf(bird);
                    bird.destroy();
                }
            });
        }
    }

    drawSpawnZones() {
        const g = this.spawnZoneGfx.setDepth(5).setAlpha(0.22);
        g.clear();
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
        zone(2, 14, 0xff5555);
        zone(GRID_W - 14, GRID_W - 2, 0x5599ff);
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
        // 滚轮缩放：以光标为锚点缩放（乘法步进，大范围下手感均匀）
        this.input.on('wheel', (p, go, dx, dy) => {
            const anchor = cam.getWorldPoint(p.x, p.y);
            this.userZoom = Phaser.Math.Clamp(this.userZoom * (dy > 0 ? 0.88 : 1.14), 0.85, 6);
            this.applyZoom(anchor, p);
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
        // 平移边界 = 地图菱形外扩一圈，缩多大都不会把地图拖出视野
        cam.setBounds(-320, -40, VIEW_W + 640, VIEW_H + 200);
        this.applyZoom();
        cam.centerOn(this.mapCenter.x, this.mapCenter.y);
        if (this.ocean) this.redrawOcean();
    }

    // anchorWorld/anchorScreen：保持缩放锚点（光标）下的世界坐标不动
    applyZoom(anchorWorld, anchorScreen) {
        const cam = this.cameras.main;
        cam.setZoom(this.baseZoom * this.userZoom);
        if (anchorWorld && anchorScreen) {
            const after = cam.getWorldPoint(anchorScreen.x, anchorScreen.y);
            cam.scrollX += anchorWorld.x - after.x;
            cam.scrollY += anchorWorld.y - after.y;
        }
    }

    // ---------------- 部署与开战 ----------------
    resetBattleData() {
        this.battleId = (this.battleId || 0) + 1;
        this.simulationTime = 0;
        this.simulationAccumulator = 0;
        this.battleQueue = [];
        this.battleImpacts = [];
        this.braceCandidates = new Map();
        this.collectingImpacts = false;
        this.planningStep = false;
        this.battleEvents = [];
        this.battleMilestones = new Set();
        this.dyingUnits = new Set();
        const emptyStats = () => ({ initial: 0, alive: 0, lost: 0, kills: 0, damage: 0 });
        this.battleStats = {};
        for (const team of ['red', 'blue']) {
            this.battleStats[team] = {
                ...emptyStats(),
                byType: Object.fromEntries(Object.keys(UNIT_TYPES).map(type => [type, emptyStats()]))
            };
        }
    }

    registerUnit(unit) {
        unit.battleId = this.battleId;
        const team = this.battleStats[unit.team];
        for (const stats of [team, team.byType[unit.type]]) {
            stats.initial++;
            stats.alive++;
        }
    }

    recordDamage(target, damage, from) {
        if (!from || from.battleId !== this.battleId || from.team === target.team) return;
        const team = this.battleStats[from.team];
        team.damage += damage;
        team.byType[from.type].damage += damage;
    }

    addBattleEvent(key, text, team) {
        if (this.battleMilestones.has(key)) return;
        this.battleMilestones.add(key);
        this.battleEvents.push({ atMs: Math.round(this.simulationTime), text, team });
    }

    recordDeath(unit, from) {
        const team = this.battleStats[unit.team];
        for (const stats of [team, team.byType[unit.type]]) {
            stats.alive--;
            stats.lost++;
        }
        if (unit.team === 'red') this.redAlive = team.alive;
        else this.blueAlive = team.alive;
        if (from && from.battleId === this.battleId && from.team !== unit.team) {
            const attacker = this.battleStats[from.team];
            attacker.kills++;
            attacker.byType[from.type].kills++;
            const side = from.team === 'red' ? '红方' : '蓝方';
            this.addBattleEvent('first-kill', `${side}${UNIT_TYPES[from.type].name}取得首杀`, from.team);
            if (from.type === 'cavalry' && unit.type === 'archer') {
                this.addBattleEvent('cavalry-archer', `${side}骑兵首次击杀弓箭手`, from.team);
            }
        }
        if (team.initial > 0 && team.lost * 2 >= team.initial) {
            this.addBattleEvent(`half-${unit.team}`, `${unit.team === 'red' ? '红方' : '蓝方'}损失达到初始兵力的一半`, unit.team);
        }
    }

    getBattleReport() {
        return {
            red: this.battleStats.red.alive,
            blue: this.battleStats.blue.alive,
            durationMs: Math.round(this.simulationTime),
            teams: JSON.parse(JSON.stringify(this.battleStats)),
            events: this.battleEvents.map(event => ({ ...event }))
        };
    }

    scheduleBattleAction(delayMs, callback) {
        this.battleQueue.push({ atMs: this.simulationTime + delayMs, battleId: this.battleId, callback });
    }

    flushBattleActions() {
        const ready = [], pending = [];
        for (const action of this.battleQueue) {
            (action.atMs <= this.simulationTime + 1e-7 ? ready : pending).push(action);
        }
        this.battleQueue = pending;
        ready.sort((a, b) => a.atMs - b.atMs);
        for (const action of ready) {
            if (action.battleId === this.battleId) action.callback();
        }
    }

    flushBattleImpacts() {
        this.collectingImpacts = false;
        const impacts = this.battleImpacts;
        this.battleImpacts = [];
        // 同一步已成立的命中全部生效，攻击者在此批中阵亡也不会抹掉其攻击。
        for (const { target, damage, from } of impacts) applyDamage(target, damage, from);
    }

    queueBrace(guard, cavalry) {
        const distance = Math.hypot(guard.gx - cavalry.gx, guard.gy - cavalry.gy);
        const current = this.braceCandidates.get(guard);
        if (!current || distance < current.distance - 1e-9 ||
            (Math.abs(distance - current.distance) <= 1e-9 && cavalry.id < current.cavalry.id)) {
            this.braceCandidates.set(guard, { cavalry, distance });
        }
    }

    resolveBrace(guard, cavalry) {
        // 迎击倍率与反骑倍率各一次；在整批伤害之前登记，同刻将阵亡的枪兵仍能迎击。
        resolveAttack(cavalry, guard, { multiplier: 1.5 });
        guard.lastBrace = this.simulationTime;
        this.playAttackAnim(guard, cavalry);
        this.meleeImpact(guard, cavalry);
        this.addBattleEvent(`brace-${guard.team}`, `${guard.team === 'red' ? '红方' : '蓝方'}正面枪阵迎击骑兵冲锋`, guard.team);
    }

    flushBraceCandidates() {
        for (const [guard, { cavalry }] of this.braceCandidates) this.resolveBrace(guard, cavalry);
        this.braceCandidates.clear();
    }

    cancelCountdown() {
        for (const timer of this.countdownTimers || []) timer.remove(false);
        for (const text of this.countdownTexts || []) {
            this.tweens.killTweensOf(text);
            text.destroy();
        }
        this.countdownTimers = [];
        this.countdownTexts = [];
    }

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
        this.redAlive = this.units.filter(u => u.team === 'red').length;
        this.blueAlive = this.units.filter(u => u.team === 'blue').length;
        this.deadCount = 0;
        this._view = null;      // 重新部署后先全量同步渲染
        this.battleStarted = false;
        this.battleOver = false;
    }

    // 阴影预烘焙：每个（阵营×兵种）的软椭圆+队伍圈烘成一张小贴图，
    // 千人同屏时阴影走普通精灵合批，而不是一千个 Graphics 各画一遍
    makeShadowTextures() {
        for (const team of ['red', 'blue']) {
            for (const type of Object.keys(UNIT_TYPES)) {
                for (const visualDir of unitVisualDirections(type)) {
                    const key = shadowTextureKey(team, type, visualDir);
                    if (this.textures.exists(key)) continue;
                    const F = footProfile(type, visualDir);
                    const sizeK = type === 'cavalry' ? 0.37 : 0.30;
                    const sc = UNIT_TYPES[type].scale * sizeK;
                    const footDx = F.dx * sc;
                    const w = Math.ceil(F.w * sc + Math.abs(footDx) * 2) + 4;
                    const h = Math.ceil(F.h * sc) + 4;
                    const g = this.make.graphics({ add: false });
                    const cx = w / 2, cy = h / 2;
                    g.fillStyle(0x0c1206, 0.30);
                    g.fillEllipse(cx + footDx, cy, F.w * sc, F.h * sc);
                    g.fillStyle(0x0c1206, 0.26);
                    g.fillEllipse(cx + footDx, cy, F.w * sc * 0.62, F.h * sc * 0.62);
                    g.lineStyle(2.2, team === 'red' ? 0xff3b30 : 0x2f7bff, 0.85);
                    g.strokeEllipse(cx + footDx, cy, F.w * sc * 0.78, F.h * sc * 0.78);
                    g.generateTexture(key, w, h);
                    g.destroy();
                }
            }
        }
    }

    spawnUnit(team, type, gx, gy) {
        const typeData = UNIT_TYPES[type];
        const key = `units/${team}_${type}`;
        const { x, y } = gridToScreen(gx, gy);
        const depth = (gx + gy) * 100;

        // 人物清晰优先：步兵约 47px，骑兵约 58px；仍保持在单格可读范围内
        const sizeK = type === 'cavalry' ? 0.37 : 0.30;
        const fx = sizeK / 0.55;   // 特效幅度基准：1 = 原体型
        const sc = typeData.scale * sizeK;      // 贴图最终显示缩放
        const visualDir = type === 'cavalry' ? (team === 'red' ? 'east' : 'west') : 'side';

        // 接地基准：把角色“踩”到地面线上，阴影圆心与脚底重合
        // pad = 素材底边到脚底的像素距离（AI 出图底部留白 4~34px 不等，不补偿就会悬浮）
        const F = footProfile(type, visualDir);
        const footDy = F.pad * sc;              // 贴图底边 → 脚底 的显示距离

        // 烘焙阴影贴图（椭圆脚底偏移已烘进贴图，翻转即镜像，见 syncOne）
        const shadowKey = shadowTextureKey(team, type, visualDir);
        const shadow = this.add.image(x, y, shadowKey);
        shadow.setDepth(depth + 48);

        const spr = this.add.sprite(x, y + footDy, key).setOrigin(0.5, 1);
        spr.setScale(sc);
        spr.setFlipX(type === 'cavalry' ? CAVALRY_FLIPPED.has(visualDir) : team === 'blue');
        spr.setDepth(depth + 50);

        const unit = {
            id: this.nextId++,
            team, type, typeData, gx, gy,
            hp: typeData.hp, maxHp: typeData.hp,
            spr, shadow,
            lastAttack: -typeData.atkSpeed, lastContact: 0,
            state: 'charge', stateTime: 0, reformX: null, target: null,
            chargeDistance: 0, chargeLastX: null, lastRetarget: -Infinity, lastBrace: -Infinity,
            chargeMomentum: 0, chargeImpactId: null,
            braceTime: 0, braceReady: false, braceHold: false, braceSupport: 0, braceDepth: 0,
            braceFacingX: team === 'red' ? 1 : -1, braceFacingY: 0,
            moving: false, dead: false, flashUntil: 0,
            bobPhase: Math.random() * Math.PI * 2,
            lastSX: x, lastSY: y, scene: this,
            sizeK: fx,                                  // 特效幅度系数（1 = 原体型）
            baseScale: sc,                              // 贴图显示缩放（待机呼吸在其上做微缩放）
            footDy,                                     // 贴图底边 → 脚底 的下压距离（对齐地面线）
            faceDir: team === 'red' ? 1 : -1,           // 当前贴图镜像符号：1=原图 / -1=水平镜像
            faceAcc: 0,                                  // 朝向判定的累计位移
            dirDX: 0, dirDY: 0,                         // 骑兵方向判定的平滑屏幕位移
            visualDir,                                  // 骑兵八向 heading；普通兵种固定为 side
            renderedVisualDir: visualDir,
            shadowKey,
            animState: 'idle',                           // 当前动画：idle/walk/attack
            animLock: 0,                                 // 攻击动画锁（期间不被行走覆盖）
            lunge: { x: 0, y: 0, angle: 0 },            // 受击位移（tween 驱动，渲染帧叠加）
            // 行军入场：从己方一侧滑进阵地
            slideOff: (team === 'red' ? -1 : 1) * (80 + Math.random() * 70)
        };
        this.registerUnit(unit);
        this.units.push(unit);
        return unit;
    }

    startCountdown(onDone) {
        this.cancelCountdown();
        const battleId = this.battleId;
        const cam = this.cameras.main;
        const steps = ['3', '2', '1', '开战！'];
        steps.forEach((txt, i) => {
            const timer = this.time.delayedCall(i * 800, () => {
                if (battleId !== this.battleId) return;
                const t = this.add.text(cam.width / 2, cam.height * 0.32, txt, {
                    fontSize: txt === '开战！' ? '96px' : '120px',
                    fontStyle: 'bold', color: txt === '开战！' ? '#ffd24a' : '#ffffff',
                    stroke: '#000000', strokeThickness: 8,
                    fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif'
                }).setOrigin(0.5).setScrollFactor(0).setDepth(200000);
                this.countdownTexts.push(t);
                this.tweens.add({ targets: t, scale: txt === '开战！' ? 1.15 : 1, alpha: 0, duration: 700, onComplete: () => {
                    this.countdownTexts = this.countdownTexts.filter(text => text !== t);
                    t.destroy();
                } });
                if (Snd) Snd.play(i === 3 ? 'go' : 'tick');
                if (i === 3) { this.battleStarted = true; this.spawnZoneGfx.clear(); if (onDone) onDone(); }
            });
            this.countdownTimers.push(timer);
        });
    }

    clearUnits() {
        this.cancelCountdown();
        // 模拟数组可能已压实，仍在倒地动画中的单位必须一起清理。
        const visualUnits = new Set([...this.units, ...(this.dyingUnits || [])]);
        visualUnits.forEach(u => {
            this.tweens.killTweensOf(u.spr);
            this.tweens.killTweensOf(u.lunge);
            u.deathVisual = null;
            u.spr.destroy(); u.shadow.destroy();
        });
        this.units = [];
        this.arrows = [];
        this.bloods = [];
        this.bloodQueue = [];
        if (this.scarRT) this.scarRT.clear();   // 清空尸体与血渍
        if (this.arrowGfx) this.arrowGfx.clear();
        if (this.bloodGfx) this.bloodGfx.clear();
        if (this.hpGfx) this.hpGfx.clear();
        this.redAlive = 0;
        this.blueAlive = 0;
        this.deadCount = 0;
        if (this.winnerText) { this.winnerText.destroy(); this.winnerText = null; }
        this.battleOver = false;
        this.battleStarted = false;
        this.paused = false;
        this.gameSpeed = 1;
        this._countsDirty = false;
        this._lastCountUI = 0;
        this.resetBattleData();
        this.syncAnimTimeScale();
    }

    // ---------------- 战斗主循环 ----------------
    update(time, delta) {
        // FPS 统计（500ms 滚动窗口）
        this._fpsN++;
        if (time - this._fpsT >= 500) {
            const fps = Math.round(this._fpsN * 1000 / (time - this._fpsT));
            if (this.fpsHud) {
                this.fpsHud.textContent = fps + ' FPS · 存活 ' + (this.redAlive + this.blueAlive);
                this.fpsHud.style.color = fps >= 55 ? '#9cf5a0' : fps >= 30 ? '#ffd24a' : '#ff6b6b';
            }
            this._fpsN = 0; this._fpsT = time;
        }
        const dt = Math.min(delta, 50) / 1000 * this.gameSpeed;
        this.updateDeathVisuals(delta); // 暂停冻结；结局后仍让已开始的倒地完整落地。
        this.updateBloods(dt);
        this.flushBloodQueue();
        // 阵亡计数 DOM 刷新限频（千人大战每帧几十个阵亡，不能每杀都写 DOM）
        if (this._countsDirty && this.time.now - (this._lastCountUI || 0) > 250) {
            this._lastCountUI = this.time.now;
            this._countsDirty = false;
            if (typeof UI !== 'undefined') UI.updateCounts();
        }
        if (!this.battleStarted || this.paused || this.battleOver) { this.syncRender(time); return; }
        // 本帧视口（世界坐标）+ LOD 开关：拉远看全局时砍掉小特效
        const cam = this.cameras.main;
        const v = cam.worldView;
        this._view = { x0: v.x - 160, y0: v.y - 220, x1: v.right + 160, y1: v.bottom + 280 };
        this.lowFX = cam.zoom < 0.42;
        this._fxBudget = 46;
        this._dustBudget = 8;

        this.advanceBattle(delta);
        this.syncRender(time);
    }

    advanceBattle(delta) {
        if (!this.battleStarted || this.paused || this.battleOver) return;
        // 固定步长使相同阵容在 1x/2x 下执行相同的战斗步骤。
        this.simulationAccumulator += Math.max(0, Math.min(delta, 50)) * this.gameSpeed;
        while (this.simulationAccumulator + 1e-7 >= SIMULATION_STEP_MS && !this.battleOver) {
            this.simulationAccumulator = Math.max(0, this.simulationAccumulator - SIMULATION_STEP_MS);
            this.simulationTime += SIMULATION_STEP_MS;
            this.stepBattle(SIMULATION_STEP_MS / 1000);
        }
    }

    stepBattle(dt) {
        const now = this.simulationTime;
        this.braceCandidates.clear();
        // 所有人先读取同一份位置和生命状态；先选行动，再统一移动、结算命中。
        this.rebuildSpatial();
        const units = this._aliveArr;

        // 帧首：先用上一帧位移估计速度，再刷新快照（供箭矢预判）
        for (let i = 0; i < units.length; i++) {
            const unit = units[i];
            if (unit.pgx !== undefined) {
                unit.velX = (unit.gx - unit.pgx) / dt;
                unit.velY = (unit.gy - unit.pgy) / dt;
            }
            unit.pgx = unit.gx; unit.pgy = unit.gy;
            unit.moveX = 0; unit.moveY = 0;
            unit.pushX = 0; unit.pushY = 0;
        }
        for (const unit of units) if (unit.type === 'pikeman') updatePikeBrace(unit, dt);
        this.collectingImpacts = true;
        this.planningStep = true;
        this.flushBattleActions();

        for (let i = 0; i < units.length; i++) {
            const unit = units[i];
            if (unit.dead) continue;
            unit.moving = false;
            if (unit.type === 'cavalry') {
                if (this.cavalryAI.update(unit, now, dt)) continue;
            }
            this.updateNormalUnit(unit, now, dt);
        }
        this.planningStep = false;
        for (const unit of units) {
            unit.gx += unit.moveX + unit.pushX;
            unit.gy += unit.moveY + unit.pushY;
        }
        this.rebuildSpatial();
        this.separate(dt);
        this.rebuildSpatial();
        this.updateArrows(dt, now);
        this.flushBraceCandidates();
        this.flushBattleImpacts();
        this.checkWin();

        // 阵亡单位周期压实，数组不无限膨胀
        this._compactTick = (this._compactTick || 0) + 1;
        if (this._compactTick % 240 === 0 && this.deadCount > 0) {
            this.units = this.units.filter(u => !u.dead);
        }
    }

    // ---------------- 空间哈希 ----------------
    // 桶数组复用（length=0 清空），每帧零分配；顺带聚合存活数与双方重心
    rebuildSpatial() {
        for (const arr of this.sgrid.values()) arr.length = 0;
        const alive = this._aliveArr;
        alive.length = 0;
        let rN = 0, bN = 0, rX = 0, rY = 0, bX = 0, bY = 0;
        const units = this.units;
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            if (u.dead) continue;
            alive.push(u);
            const k = ((u.gx / SP_CELL) | 0) * 512 + ((u.gy / SP_CELL) | 0);
            let bucket = this.sgrid.get(k);
            if (!bucket) { bucket = []; this.sgrid.set(k, bucket); }
            bucket.push(u);
            if (u.team === 'red') { rN++; rX += u.gx; rY += u.gy; }
            else { bN++; bX += u.gx; bY += u.gy; }
        }
        this.redAlive = rN;
        this.blueAlive = bN;
        this.centroid.red.x = rN ? rX / rN : GRID_W / 2;
        this.centroid.red.y = rN ? rY / rN : GRID_H / 2;
        this.centroid.blue.x = bN ? bX / bN : GRID_W / 2;
        this.centroid.blue.y = bN ? bY / bN : GRID_H / 2;
    }

    // 遍历 (gx,gy) 半径 r 覆盖的所有桶内单位（方形覆盖 ⊇ 圆形，距离由调用方判定）
    forEachNear(gx, gy, r, fn) {
        const c0x = ((gx - r) / SP_CELL) | 0, c1x = ((gx + r) / SP_CELL) | 0;
        const c0y = ((gy - r) / SP_CELL) | 0, c1y = ((gy + r) / SP_CELL) | 0;
        for (let cx = c0x; cx <= c1x; cx++) {
            for (let cy = c0y; cy <= c1y; cy++) {
                const bucket = this.sgrid.get(cx * 512 + cy);
                if (!bucket) continue;
                for (let i = 0; i < bucket.length; i++) fn(bucket[i]);
            }
        }
    }

    // 最近敌人：环形扩张搜索；查到半径 r 内的最佳解即全局最近（圆内 ⊆ 查询方形）
    nearestEnemy(unit) {
        let best = null, bestD2 = Infinity, r = 6;
        const maxR = GRID_W + GRID_H;
        while (true) {
            this.forEachNear(unit.gx, unit.gy, r, e => {
                if (e.team === unit.team || e.dead) return;
                const dx = e.gx - unit.gx, dy = e.gy - unit.gy;
                const d2 = dx * dx + dy * dy;
                if (d2 < bestD2 - 1e-9 || (Math.abs(d2 - bestD2) <= 1e-9 && e.id < best.id)) { bestD2 = d2; best = e; }
            });
            if (best && bestD2 <= r * r) return best;
            if (r >= maxR) return best;
            r *= 2;
        }
    }

    // 播放攻击动画：骑兵先朝向当前目标，然后在挥砍期间锁定完整朝向。
    // 伤害在挥砍帧上结算（见 updateNormalUnit）。
    playAttackAnim(unit, target = null) {
        if (unit.type === 'cavalry' && target) {
            const from = gridToScreen(unit.gx, unit.gy);
            const to = gridToScreen(target.gx, target.gy);
            const dx = to.x - from.x, dy = to.y - from.y;
            if (Math.hypot(dx, dy) > 0.01) {
                unit.visualDir = cavalryHeadingFromMotion(dx, dy, unit.visualDir);
                unit.faceDir = cavalryRenderSign(unit.visualDir);
            }
        }
        unit.animState = 'attack';
        unit.animLock = this.simulationTime + 320;
        unit.faceAcc = 0;
        unit.dirDX = 0;
        unit.dirDY = 0;
        unit.spr.play(this.unitAnimKey(unit, 'attack'), true);
    }

    unitAnimKey(unit, clip) {
        const profile = unit.type === 'cavalry' ? cavalryProfile(unit.visualDir) : null;
        const direction = profile ? CAVALRY_PROFILE_SUFFIX[profile] : '';
        return 'assets/units/anim/' + unit.team + '_' + unit.type + direction + '_' + clip;
    }

    updateNormalUnit(unit, now, dt) {
        const nearest = this.nearestEnemy(unit);
        if (!nearest) return;
        const range = unit.typeData.range;
        const minD = dist(unit, nearest);

        if (unit.typeData.ranged) {
            // 弓箭手：射程内集火同一残血目标（血量主导、id 决胜），保持距离放风筝
            if (minD > range) {
                moveToward(unit, nearest.gx, nearest.gy, unit.typeData.speed * 0.55, dt);
            } else if (minD < 3.2) {
                // 敌人逼近：边退边让队友输出
                const a = Math.atan2(unit.gy - nearest.gy, unit.gx - nearest.gx);
                moveToward(unit, unit.gx + Math.cos(a) * 3, unit.gy + Math.sin(a) * 3, unit.typeData.speed * 0.92, dt);
            }
            if (now - unit.lastAttack > unit.typeData.atkSpeed) {
                let shootTarget = null, bestScore = Infinity;
                this.forEachNear(unit.gx, unit.gy, range, e => {
                    if (e.team === unit.team || e.dead) return;
                    if (dist(unit, e) > range) return;
                    const score = e.hp * 1000 + e.id;
                    if (score < bestScore) { bestScore = score; shootTarget = e; }
                });
                if (shootTarget) {
                    unit.lastAttack = now;
                    this.playAttackAnim(unit, shootTarget);
                    const victim = shootTarget;
                    // 拉弓 → 松弦放箭（与动画同步）
                    this.scheduleBattleAction(110, () => {
                        if (unit.dead || victim.dead || this.battleOver) return;
                        this.fireArrow(unit, victim);
                    });
                }
            }
        } else {
            if (minD > range) {
                if (unit.type !== 'pikeman' || !unit.braceHold) moveToward(unit, nearest.gx, nearest.gy, unit.typeData.speed, dt);
            } else if (now - unit.lastAttack > unit.typeData.atkSpeed) {
                unit.lastAttack = now;
                this.playAttackAnim(unit, nearest);
                const victim = nearest;
                // 蓄力 → 劈砍帧上结算伤害（目标脱离则挥空）
                this.scheduleBattleAction(95, () => {
                    if (unit.dead || victim.dead || this.battleOver) return;
                    if (dist(unit, victim) > range + 0.7) return;
                    resolveAttack(victim, unit);
                    this.meleeImpact(unit, victim);
                });
            }
        }
    }

    // 简单碰撞排斥，避免单位重叠（空间哈希：每人只查身边一格内的邻居）
    separate(dt) {
        const R = 0.52, R2 = R * R;
        const units = this._aliveArr;
        for (const unit of units) { unit.separateX = 0; unit.separateY = 0; }
        for (let i = 0; i < units.length; i++) {
            const a = units[i];
            if (a.dead) continue;
            this.forEachNear(a.gx, a.gy, R, b => {
                if (b.dead || b.id <= a.id) return;          // 每对只处理一次
                const dx = b.gx - a.gx, dy = b.gy - a.gy;
                const d2 = dx * dx + dy * dy;
                if (d2 < R2 && d2 > 0.0001) {
                    const d = Math.sqrt(d2);
                    const push = (R - d) * 0.5 * Math.min(1, dt * 14);
                    const nx = dx / d, ny = dy / d;
                    a.separateX -= nx * push; a.separateY -= ny * push;
                    b.separateX += nx * push; b.separateY += ny * push;
                }
            });
        }
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            // 对称累计推开，并消除长时间镜像模拟中的浮点方向偏差。
            u.gx = quantizePosition(clamp(u.gx + u.separateX, 0.6, GRID_W - 0.6), GRID_W);
            u.gy = quantizePosition(clamp(u.gy + u.separateY, 0.6, GRID_H - 0.6), GRID_H);
        }
    }

    // ---------------- 箭矢（全场景合批到一张 Graphics） ----------------
    fireArrow(from, target) {
        const d = dist(from, target);
        const flightT = clamp(d / 12, 0.3, 0.75);
        // 预判提前量：瞄目标飞行期间的预估位置
        const lead = (v) => v ? clamp(v * flightT, -1.5, 1.5) : 0;
        this.arrows.push({
            sx: from.gx, sy: from.gy,
            tx: clamp(target.gx + lead(target.velX), 0.5, GRID_W - 0.5),
            ty: clamp(target.gy + lead(target.velY), 0.5, GRID_H - 0.5),
            t: 0, dur: flightT,
            dmg: from.typeData.atk, team: from.team, source: from
        });
        if (Snd) Snd.play('arrow');
    }

    updateArrows(dt, now) {
        const g = this.arrowGfx;
        g.clear();
        for (let i = this.arrows.length - 1; i >= 0; i--) {
            const a = this.arrows[i];
            a.t += dt;
            const p = clamp(a.t / a.dur, 0, 1);
            const gx = a.sx + (a.tx - a.sx) * p;
            const gy = a.sy + (a.ty - a.sy) * p;
            const s = gridToScreen(gx, gy);
            const arcH = Math.sin(p * Math.PI) * 46;

            g.lineStyle(1.5, 0x5b4632, 1);
            const ang = Math.atan2(a.ty - a.sy, a.tx - a.sx);
            const dx = Math.cos(ang) * 7.5, dy = Math.sin(ang) * 7.5 * 0.5 - 3;
            g.lineBetween(s.x - dx, s.y - dy - arcH, s.x + dx, s.y + dy - arcH);
            g.fillStyle(0xd9d9d9, 1);
            g.fillCircle(s.x + dx, s.y + dy - arcH, 1.4);

            if (p >= 1) {
                // 落点找最近的敌人判定命中（空间哈希只查落点周围）
                let hit = null, hd = 0.75;
                this.forEachNear(a.tx, a.ty, hd, u => {
                    if (u.team === a.team || u.dead) return;
                    const d = Math.hypot(u.gx - a.tx, u.gy - a.ty);
                    if (d < hd - 1e-9 || (hit && Math.abs(d - hd) <= 1e-9 && u.id < hit.id)) { hd = d; hit = u; }
                });
                if (hit) {
                    resolveAttack(hit, a.source, { rawAttack: a.dmg });
                    this.bloodBurst(s.x, s.y - 8, 6, 85, hit.sizeK || 1);
                } else if (!this.lowFX) {
                    this.impactPuff(s.x, s.y, 0xcfcfcf);
                }
                this.arrows.splice(i, 1);
            }
        }
    }

    // ---------------- 特效 ----------------
    meleeImpact(attacker, target) {
        // 屏幕空间攻击方向（y 加权贴合地面斜向）
        const sA = gridToScreen(attacker.gx, attacker.gy);
        const s = gridToScreen(target.gx, target.gy);
        const ang = Math.atan2((s.y - sA.y) * 2, s.x - sA.x);

        // 全局拉远观战时只保留伤害与血（lowFX），近景才放全套打击感
        if (!this.lowFX && this._fxBudget > 0) {
            this._fxBudget--;
            // 攻击冲拳：动画已带挥砍，这里只补一小段冲击位移
            const L = attacker.lunge, reach = (attacker.type === 'cavalry' ? 10 : 6) * (attacker.sizeK || 1);
            this.tweens.add({
                targets: L,
                x: Math.cos(ang) * reach, y: Math.sin(ang) * reach * 0.55,
                duration: 70, ease: 'Quad.Out',
                onComplete: () => this.tweens.add({
                    targets: L, x: 0, y: 0, duration: 180, ease: 'Sine.InOut'
                })
            });

            // 受击后退：被顶开再弹回
            const kb = target.sizeK || 1;
            this.tweens.add({
                targets: target.lunge,
                x: Math.cos(ang) * 5 * kb, y: Math.sin(ang) * 3 * kb,
                duration: 60, ease: 'Quad.Out',
                onComplete: () => this.tweens.add({ targets: target.lunge, x: 0, y: 0, duration: 200, ease: 'Back.Out' })
            });

            // 斩击弧光 + 兵刃碰撞火花
            this.slashArc(s.x, s.y - 14 * kb, ang, kb);
            this.sparkBurst(s.x + Math.cos(ang) * 6, s.y - 16 * kb, 0xffe9a0, attacker.type === 'cavalry');
        }

        if (attacker.type === 'cavalry') {
            const kb = target.sizeK || 1;
            // 冲击波只做地面局部反馈；不再震镜头——百骑齐战时全屏抖动会持续不断
            if (!this.lowFX && this._fxBudget > 0) {
                this._fxBudget--;
                const wave = this.add.graphics();
                wave.lineStyle(3, 0xfff3c0, 0.85);
                wave.strokeEllipse(0, 0, 30, 15);
                wave.setPosition(s.x, s.y);
                this.groundFX.add(wave);
                this.tweens.add({
                    targets: wave, alpha: 0, scaleX: 2.6, scaleY: 2.2,
                    duration: 380, onComplete: () => wave.destroy()
                });
            }
            this.bloodBurst(s.x, s.y - 14 * kb, 14, 150, kb);
        } else {
            this.bloodBurst(s.x, s.y - 14 * (target.sizeK || 1), 9, 105, target.sizeK || 1);
        }
        if (Snd) Snd.play('hit');
    }

    // 斩击弧光：一道白色弧线闪过斩击位置（尺寸随目标体型）
    slashArc(x, y, ang, k = 1) {
        const g = this.add.graphics();
        const kk = Math.max(0.45, k);
        g.lineStyle(3.5 * kk, 0xffffff, 0.95);
        g.beginPath();
        g.arc(0, 0, 15 * kk, -1.0, 1.0);
        g.strokePath();
        g.setPosition(x, y);
        g.setRotation(ang + (Math.random() - 0.5) * 0.9);
        this.airFX.add(g);
        this.tweens.add({
            targets: g, alpha: 0, scaleX: 1.55, scaleY: 1.25,
            duration: 150, ease: 'Quad.Out', onComplete: () => g.destroy()
        });
    }

    // ---------------- 血粒子：喷溅 → 抛物线 → 落地留血渍 ----------------
    // 千人规模下可能同时几十处在溅血：全部合批到一张 bloodGfx 每帧重画
    bloodBurst(x, y, n = 6, power = 95, k = 1) {
        if (this.bloods.length > 72) return;   // 上限防爆屏（血渍已走帧内合批，不再怕量）
        const kk = Math.max(0.5, k);
        const parts = [];
        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2;
            const sp = power * (0.45 + Math.random() * 0.75) * kk;
            parts.push({
                x: 0, y: 0,
                vx: Math.cos(a) * sp,
                vy: -Math.abs(Math.sin(a)) * sp * 0.85 - 26 * kk,
                s: (2.0 + Math.random() * 2.8) * kk,        // 像素方块边长
                floor: (3 + Math.random() * 9) * kk,         // 相对喷点的落地深度
                landed: false, rest: 0
            });
        }
        this.bloods.push({ bx: x, by: y, parts, t: 0 });
    }

    updateBloods(dt) {
        if (!this.bloodGfx) return;
        const g = this.bloodGfx;
        g.clear();
        for (let i = this.bloods.length - 1; i >= 0; i--) {
            const b = this.bloods[i];
            b.t += dt;
            let flying = 0;
            for (const p of b.parts) {
                if (p.landed) { p.rest += dt; continue; }
                p.vy += 540 * dt;                 // 重力
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                if (p.y >= p.floor) {              // 落地 → 地面血渍
                    this.addGroundBlood(b.bx + p.x, b.by + p.floor, p.s);
                    p.landed = true;
                    continue;
                }
                g.fillStyle(Math.random() < 0.25 ? 0xe23b2e : 0xb31818, 1);
                g.fillRect(b.bx + p.x - p.s / 2, b.by + p.y - p.s / 2, p.s, p.s);
                flying++;
            }
            // 全部落地且停留片刻后回收
            if (flying === 0 && b.t > 0.15 && b.parts.every(p => p.rest > 0.05)) {
                this.bloods.splice(i, 1);
            }
        }
    }

    // 地面血渍：入队，帧内合并成 1 个 Graphics 一次性盖印进留痕层（千人混战下每秒上百处落点也只画一次）
    addGroundBlood(x, y, s) {
        this.bloodQueue.push(x, y, s);
    }

    flushBloodQueue() {
        const q = this.bloodQueue;
        if (!q.length || !this.scarRT) return;
        const st = this.add.graphics();
        for (let i = 0; i < q.length; i += 3) {
            const x = q[i], y = q[i + 1], s = q[i + 2];
            st.fillStyle(0x6e0f0f, 0.85);
            st.fillRect(x - s / 2, y - s * 0.3, s, s * 0.55);
            st.fillStyle(0x8c1616, 0.8);
            st.fillRect(x - s * 0.3, y - s * 0.14, s * 0.55, s * 0.28);
        }
        this.scarRT.draw(st);
        st.destroy();
        q.length = 0;
    }

    // 血泊：尸体下的大摊血，多层叠色，立即可见（保证盖在尸体之前）
    addBloodPool(x, y, s) {
        if (!this.scarRT) return;
        const st = this.add.graphics();
        st.fillStyle(0x5a0c0c, 0.9);
        st.fillRect(-s * 0.5, -s * 0.3, s, s * 0.62);
        st.fillStyle(0x7d1212, 0.85);
        st.fillRect(-s * 0.42, -s * 0.22, s * 0.82, s * 0.46);
        st.fillStyle(0x931818, 0.8);
        st.fillRect(-s * 0.28, -s * 0.12, s * 0.5, s * 0.26);
        st.setPosition(x, y);
        this.scarRT.draw(st);
        st.destroy();
    }

    chargeDust(unit) {
        // 三重节流：单位 70ms 一次 + 每帧全局配额 + 拉远观战随机丢弃
        if (this.time.now - (unit.lastDust || 0) < 70) return;
        unit.lastDust = this.time.now;
        if (!this._dustBudget || this._dustBudget <= 0) return;
        if (this.lowFX && Math.random() < 0.75) return;
        this._dustBudget--;
        if (Math.random() < 0.65) {
            const s = gridToScreen(unit.gx, unit.gy);
            const dust = this.add.graphics();
            const ds = Math.max(0.45, unit.sizeK || 1);   // 尘团大小随体型
            for (let i = 0; i < 2; i++) {
                dust.fillStyle(0xcbb79a, 0.5);
                dust.fillCircle((Math.random() - 0.5) * 10 * ds, (Math.random() - 0.5) * 4 * ds, (2.5 + Math.random() * 3.5) * ds);
            }
            dust.setPosition(s.x + (Math.random() - 0.5) * 16, s.y - 2);
            this.groundFX.add(dust);
            this.tweens.add({
                targets: dust, alpha: 0, scaleX: 1.9, scaleY: 1.4, y: dust.y - 8,
                duration: 520, onComplete: () => dust.destroy()
            });
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

    // 金属碰撞火花：放射短线 + 中心亮点
    sparkBurst(x, y, color = 0xffe9a0, big = false) {
        const g = this.add.graphics();
        const n = big ? 6 : 4;
        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2;
            const len = (big ? 10 : 6) + Math.random() * (big ? 10 : 6);
            g.lineStyle(2, color, 0.95);
            g.lineBetween(
                Math.cos(a) * 3, Math.sin(a) * 3 * 0.6,
                Math.cos(a) * (3 + len), Math.sin(a) * (3 + len) * 0.6);
        }
        g.fillStyle(0xffffff, 0.9);
        g.fillCircle(0, 0, big ? 4 : 2.5);
        g.setPosition(x, y);
        this.airFX.add(g);
        this.tweens.add({
            targets: g, alpha: 0, scale: big ? 1.8 : 1.3,
            duration: big ? 320 : 220, onComplete: () => g.destroy()
        });
    }

    // 原精灵末帧原位盖印：不再替换尺寸、原点或随机旋转，接触阴影一起保留。
    stampCorpse(unit) {
        const death = unit.deathVisual;
        if (!death || death.battleId !== this.battleId || !this.scarRT) return false;
        this.scarRT.draw(unit.shadow);
        this.scarRT.draw(unit.spr);
        return true;
    }

    killUnit(unit, from) {
        const s = gridToScreen(unit.gx, unit.gy);
        const isCav = unit.type === 'cavalry';
        const dk = Math.max(0.6, unit.sizeK || 1);
        const def = typeof MANIFEST !== 'undefined' && MANIFEST.deaths?.[`${unit.team}_${unit.type}`];
        const key = def && def.file.replace('.png', '');
        const clip = key && this.textures.exists(key) ? def : null;
        const corpseKey = `units/corpse_${unit.team}_${unit.type}`;
        const hasCorpse = !clip && this.textures.exists(corpseKey);
        const spr = unit.spr;
        const flipX = (unit.faceDir || 1) < 0;
        const sc = clip ? clip.scale : unit.baseScale;
        const foot = footProfile(unit.type, unit.visualDir);
        // 骑兵沿生前世界速度滑移，最后一帧之前落稳；不随机改变倒向。
        const vx = isCav ? ((unit.velX || 0) - (unit.velY || 0)) * TW / 2 : 0;
        const vy = isCav ? ((unit.velX || 0) + (unit.velY || 0)) * TH / 2 : 0;
        const speed = Math.hypot(vx, vy);
        const slide = Math.min(14, speed * 0.07);
        const shadowWidth = foot.w * unit.baseScale;
        const corpseWidth = clip ? clip.fw * sc : shadowWidth * 1.4;

        this.tweens.killTweensOf(spr);
        this.tweens.killTweensOf(unit.lunge);
        spr.anims.stop();
        spr.clearTint();
        spr.setAngle(0).setAlpha(1).setFlipX(flipX).setScale(sc);
        if (clip) {
            spr.setTexture(key, 0).setOrigin(clip.anchorX, clip.anchorY).setPosition(s.x, s.y);
        } else if (hasCorpse) {
            spr.setTexture(corpseKey).setOrigin(0.5, 0.92).setPosition(s.x, s.y);
        } else {
            // 缺素材时短暂下沉淡出；不把直立角色旋转成纸板尸体。
            spr.setPosition(s.x, s.y + unit.footDy);
        }
        const depth = (unit.gx + unit.gy) * 100 + 50;
        spr.setDepth(depth);
        unit.shadow.setTexture('death-contact-shadow').setOrigin(0.5, 0.5)
            .setAngle(0).setAlpha(1).setFlipX(false)
            .setPosition(s.x + foot.dx * unit.baseScale * (flipX ? -1 : 1), s.y)
            .setScale(shadowWidth / 96, foot.h * unit.baseScale / 48).setDepth(depth - 2);
        unit.deathVisual = {
            battleId: this.battleId, elapsed: 0, duration: clip ? (isCav ? 760 : 600) : 240,
            frames: clip ? clip.frames : 1, frame: 0, clip: !!clip, hasCorpse,
            x: s.x, y: s.y, depth,
            slideX: speed ? vx / speed * slide : 0, slideY: speed ? vy / speed * slide : 0,
            shadowDX: foot.dx * unit.baseScale * (flipX ? -1 : 1),
            shadowWidth, shadowHeight: foot.h * unit.baseScale,
            endShadowWidth: Math.max(shadowWidth, corpseWidth * 0.7),
            endShadowHeight: Math.max(foot.h * unit.baseScale, corpseWidth * 0.18)
        };
        this.dyingUnits.add(unit);
        this.bloodBurst(s.x, s.y - 12 * dk, isCav ? 18 : 14, 120, dk);
        this.deadCount++;
        this._countsDirty = true;
        if (Snd) Snd.play('die');
    }

    updateDeathVisuals(delta) {
        const elapsed = this.paused ? 0 : Math.max(0, Math.min(delta, 50)) * this.gameSpeed;
        for (const unit of this.dyingUnits) {
            const death = unit.deathVisual;
            if (!death || death.battleId !== this.battleId) {
                unit.spr.destroy(); unit.shadow.destroy();
                unit.deathVisual = null;
                this.dyingUnits.delete(unit);
                continue;
            }
            if (!elapsed) continue;
            death.elapsed = Math.min(death.duration, death.elapsed + elapsed);
            const progress = death.elapsed / death.duration;
            const settled = Math.min(1, progress * 6 / 5);
            const drift = 1 - Math.pow(1 - settled, 3);
            const x = death.x + death.slideX * drift, y = death.y + death.slideY * drift;
            const frame = Math.min(death.frames - 1, Math.floor(progress * death.frames));
            if (death.clip && frame !== death.frame) {
                unit.spr.setFrame(frame);
                death.frame = frame;
            }
            const fading = !death.clip && !death.hasCorpse;
            unit.spr.setPosition(x, y + (fading ? unit.footDy + progress * 4 : 0))
                .setDepth(death.depth + death.slideY * drift * 100 / (TH / 2));
            if (fading) unit.spr.setAlpha(1 - progress);
            unit.shadow.setPosition(x + death.shadowDX * (1 - settled), y)
                .setScale((death.shadowWidth + (death.endShadowWidth - death.shadowWidth) * settled) / 96,
                    (death.shadowHeight + (death.endShadowHeight - death.shadowHeight) * settled) / 48)
                .setDepth(unit.spr.depth - 2);
            if (fading) unit.shadow.setAlpha(1 - progress);
            if (progress < 1) continue;
            const dk = Math.max(0.6, unit.sizeK || 1);
            this.addBloodPool(x, y, 15 * dk);
            if (!fading) this.stampCorpse(unit);
            unit.spr.destroy(); unit.shadow.destroy();
            unit.deathVisual = null;
            this.dyingUnits.delete(unit);
        }
    }

    // ---------------- 渲染同步 ----------------
    syncRender(time) {
        this.hpGfx.clear();
        const view = this._view;   // 战斗中每帧更新；部署阶段为空 = 全量同步
        const units = this.units;
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            if (u.dead) continue;
            this.syncOne(u, time, view);
        }
    }

    syncOne(unit, time, view) {
        if (unit.dead) return;
        const { x, y } = gridToScreen(unit.gx, unit.gy);

        const prevX = unit.lastSX === undefined ? x : unit.lastSX;
        const prevY = unit.lastSY === undefined ? y : unit.lastSY;
        const sdx = x - prevX, sdy = y - prevY;

        // 离屏单位也必须按时释放攻击锁，否则会永久冻结在旧方向。
        if (unit.animState === 'attack' && this.simulationTime > unit.animLock) unit.animState = null;

        // 攻击动画期间冻结完整朝向；行走时将屏幕位移平滑后量化为 8 个方向。
        if (unit.type === 'cavalry' && unit.animState !== 'attack' && unit.moving) {
            unit.dirDX = unit.dirDX * 0.6 + sdx * 0.4;
            unit.dirDY = unit.dirDY * 0.6 + sdy * 0.4;
            if (Math.hypot(unit.dirDX, unit.dirDY) > 0.08) {
                const nextVisualDir = cavalryHeadingFromMotion(unit.dirDX, unit.dirDY, unit.visualDir);
                if (nextVisualDir !== unit.visualDir) {
                    unit.visualDir = nextVisualDir;
                    unit.faceDir = cavalryRenderSign(nextVisualDir);
                    unit.animState = null;
                }
            }
        } else if (unit.type === 'cavalry' && unit.animState !== 'attack') {
            unit.dirDX = 0;
            unit.dirDY = 0;
        }

        // 视口剔除：屏幕外只刷新快照，不碰显示对象（千人规模的主力 LOD）
        if (view && (x < view.x0 || x > view.x1 || y < view.y0 || y > view.y1)) {
            unit.lastSX = x; unit.lastSY = y;
            return;
        }

        if (unit.type === 'cavalry' && unit.visualDir !== unit.renderedVisualDir) {
            const nextShadowKey = shadowTextureKey(unit.team, unit.type, unit.visualDir);
            unit.shadow.setTexture(nextShadowKey);
            unit.shadowKey = nextShadowKey;
            const F = footProfile(unit.type, unit.visualDir);
            unit.footDy = F.pad * unit.baseScale;
            unit.renderedVisualDir = unit.visualDir;
            unit.spr.setFlipX(CAVALRY_FLIPPED.has(unit.visualDir));
        }

        // 行军入场偏移：逐帧衰减产生滑入动画
        let ox = 0;
        if (unit.slideOff) {
            ox = unit.slideOff;
            unit.slideOff *= 0.9;
            if (Math.abs(unit.slideOff) < 1) unit.slideOff = 0;
        }

        // ---- 动画状态机：攻击锁定 > 行走 > 待机 ----
        if (unit.animState !== 'attack') {
            const want = unit.moving ? 'walk' : 'idle';
            if (want !== unit.animState) {
                unit.animState = want;
                if (want === 'walk') {
                    unit.spr.play(this.unitAnimKey(unit, 'walk'), true);
                } else {
                    unit.spr.anims.stop();
                    unit.spr.setTexture(this.unitAnimKey(unit, 'walk'), 0); // 当前方向的站姿
                }
            }
        }
        if (unit.moving && unit.type === 'cavalry') this.chargeDust(unit);   // 奔跑扬尘（内部已节流）

        // ---- 朝向：累计位移过阈值才翻转（避免受击/挤开抖动导致来回闪脸）----
        // 放在应用位置之前，好让逐帧补正和影子镜像都用上本帧的朝向
        if (unit.type !== 'cavalry' && unit.animState !== 'attack') {
            unit.faceAcc += sdx;
            if (unit.faceAcc > 2)       { unit.spr.setFlipX(false); unit.faceDir = 1;  unit.faceAcc = 0; }
            else if (unit.faceAcc < -2) { unit.spr.setFlipX(true);  unit.faceDir = -1; unit.faceAcc = 0; }
            else if (Math.abs(unit.faceAcc) > 60) unit.faceAcc = 0;
        }
        unit.lastSX = x; unit.lastSY = y;

        // 待机呼吸：以脚底为支点做极轻微缩放（不再整体上下平移，脚不离地）
        const breath = unit.animState === 'idle' ? Math.sin(time * 0.0035 + unit.bobPhase) : 0;
        const bs = unit.baseScale || 1;
        unit.spr.setScale(bs, bs * (1 + breath * 0.012));

        // ---- 逐帧对齐补正：抵消同一套动画里各帧站位不一致造成的左右抖 ----
        const alignProfile = animAlignProfile(unit.type, unit.visualDir);
        const alignRow = alignProfile && alignProfile[unit.animState === 'attack' ? 'attack' : 'walk'];
        let ajx = 0, ajy = 0;
        if (alignRow) {
            const cf = unit.spr.anims.currentFrame;
            const a = alignRow[cf ? Math.min(cf.index - 1, alignRow.length - 1) : 0] || [0, 0];
            const renderSign = unit.type === 'cavalry' ? cavalryRenderSign(unit.visualDir) : unit.faceDir;
            ajx = a[0] * bs * renderSign * ANIM_ALIGN_K;      // 横向补正随贴图镜像
            ajy = a[1] * bs * ANIM_ALIGN_K;
        }

        // 受击位移叠加（lunge 由 tween 驱动）；y 再补 footDy，让脚底落在阴影圆心上
        const L = unit.lunge;
        unit.spr.setPosition(x + ox + L.x + ajx, y + unit.footDy + L.y + ajy);
        unit.spr.setAngle(L.angle);

        const depth = (unit.gx + unit.gy) * 100 + 50;
        unit.spr.setDepth(depth);
        // 影子：贴图镜像随朝向翻转 —— 脚底偏移已烘进贴图，翻转后仍贴在脚掌下
        const shadowSign = unit.type === 'cavalry' ? cavalryRenderSign(unit.visualDir) : unit.faceDir;
        unit.shadow.setPosition(x + ox * 0.55, y).setScale(shadowSign, 1).setDepth(depth - 2);

        // 受击反馈：轻染红（乘法染色保留像素图案，不再全白填充闪白）
        if (this.simulationTime < unit.flashUntil) unit.spr.setTint(0xff7d6e);
        else unit.spr.clearTint();

        // 血条：画进共享 hpGfx（全场景一张，深度压在所有单位之上）。
        // 拉远观战时只有残血（<30%）才显示，避免千条血条糊成一片。
        if (unit.hp < unit.maxHp && (!this.lowFX || unit.hp < unit.maxHp * 0.3)) {
            const w = Math.max(12, 28 * (unit.sizeK || 1)), ratio = clamp(unit.hp / unit.maxHp, 0, 1);
            const hy = -(unit.spr.displayHeight * 0.82 + 6);
            const px = x, py = y + unit.footDy;
            this.hpGfx.fillStyle(0x000000, 0.55);
            this.hpGfx.fillRect(px - w / 2 - 1, py + hy, w + 2, 6);
            this.hpGfx.fillStyle(unit.team === 'red' ? 0xff4444 : 0x3d7be8, 1);
            this.hpGfx.fillRect(px - w / 2, py + hy + 1, w * ratio, 4);
        }
    }

    // ---------------- 胜负 ----------------
    checkWin() {
        if (this.battleOver) return;
        const red = this.redAlive, blue = this.blueAlive;
        if (red > 0 && blue > 0) return;
        // 已发出的箭继续落地：最后一名射手阵亡后仍可能双方同归于尽。
        if (this.arrows.length > 0) return;
        this.battleOver = true;
        this.battleQueue = [];
        const winner = red > 0 ? 'red' : blue > 0 ? 'blue' : 'draw';
        this.showVictory(winner);
        UI.onBattleEnd(winner, this.getBattleReport());
    }

    showVictory(winner) {
        const isRed = winner === 'red';
        const isDraw = winner === 'draw';
        const cam = this.cameras.main;
        this.winnerText = this.add.text(cam.width / 2, cam.height * 0.38,
            isDraw ? '双方平局！' : isRed ? '红方胜利！🎉' : '蓝方胜利！🎉', {
            fontSize: '84px', fontStyle: 'bold',
            color: isDraw ? '#ffd24a' : isRed ? '#ff5b5b' : '#57a0ff',
            stroke: '#000000', strokeThickness: 10,
            fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif'
        }).setOrigin(0.5).setScrollFactor(0).setDepth(200001).setScale(0.3);
        this.tweens.add({ targets: this.winnerText, scale: 1, duration: 400, ease: 'Back.Out' });

        // 彩带（屏幕空间）
        for (let i = 0; i < 70; i++) {
            const hsv = Phaser.Display.Color.HSVToRGB(Math.random(), 0.75, 0.9);
            const rect = this.add.rectangle(
                Math.random() * cam.width, -20 - Math.random() * 200,
                6 + Math.random() * 5, 10 + Math.random() * 6, hsv.color)
                .setDepth(200000).setScrollFactor(0);
            this.tweens.add({
                targets: rect, y: cam.height + 40, angle: Math.random() * 360 - 180,
                duration: 2200 + Math.random() * 1800, delay: Math.random() * 800,
                onComplete: () => rect.destroy()
            });
        }
        if (Snd) Snd.play('win');
    }

    setSpeed(s) { this.gameSpeed = s; this.syncAnimTimeScale(); }
    togglePause() { this.paused = !this.paused; this.syncAnimTimeScale(); }
    // 动画时轴跟随暂停/倍速（否则 2x 时动作与伤害错拍）
    syncAnimTimeScale() { this.anims.globalTimeScale = this.paused ? 0 : this.gameSpeed; }
}
