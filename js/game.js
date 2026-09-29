// ==================== 等距视角战斗场景 ====================
// 帝国时代2 风格：斜45°菱形地块 + Kenney 兵种贴图 + y轴深度排序
// UI/Snd 是 ui.js 运行时挂到全局的（模块加载序 game→ui），此处只做运行时引用。
import { board, setBoardSize, resetBoardSize } from './board.js';
import { Terrain } from './terrain.js';
import { TerrainNavigation } from './navigation.js';
import {
    UNIT_TYPES, generateArmyPositions, updatePikeBrace, CavalryAI,
    dist, clamp, moveToward, unitRand,
    applyDamage, resolveAttack, calculateAttackDamage
} from './units.js';
import { CombatRules } from './combat.js';
import { MoraleSystem } from './morale.js';
import { TacticsSystem } from './tactics.js';
import { UnitInspector } from './inspection.js';
import { MANIFEST } from './manifest.js';
import { BattleSpatialIndex } from './battle/spatial.js';
import * as targeting from './battle/targeting.js';
import { BattleLedger } from './battle/report.js';
import * as core from './battle/core.js';
import { BraceQueue } from './battle/core.js';
import { TERRITORY, makeTerritoryFlags, TerritoryEconomy, TicketSystem } from './battle/economy.js';
import { RecruitSystem, TerritoryAI } from './battle/recruit.js';
import { BattalionSystem, BATTALION } from './battle/battalion.js';
import * as unitAi from './battle/unit-ai.js';
import * as battleUnits from './battle/separate.js';
import * as battleConvoy from './battle/convoy.js';
import * as battleWin from './battle/win.js';
import { NetBattle } from './net/lockstep.js';

const TW = 64, TH = 32;                       // 菱形块宽高
// 世界度量随棋盘尺寸走（默认 70×70 时 VIEW_W=4480）；大地图模式经 setBoardSize
// 改尺寸后由 refreshWorldMetrics() 重算，渲染各层读当前值，不缓存旧尺寸。
let OX = board.H * TW / 2, OY = 120;         // 屏幕原点偏移
let VIEW_W = (board.W + board.H) * TW / 2;
let VIEW_H = OY + (board.W + board.H) * TH / 2 + 60;
function refreshWorldMetrics() {
    const m = board.MARGIN || 0;
    OX = board.H * TW / 2 + m * TW;             // 画外余量：整个世界画布外扩，陆地长到画面边缘外
    OY = 120 + m * TH;
    VIEW_W = (board.W + board.H) * TW / 2 + 2 * m * TW;
    VIEW_H = OY + (board.W + board.H) * TH / 2 + 60 + m * TH;
}

// 空间哈希单元格移至 js/battle/spatial.js（SP_CELL = 3）
// 战斗核（定步长/编排/动作队列/迎击队列）移至 js/battle/core.js（SIMULATION_STEP_MS = 1000/60）


function gridToScreen(gx, gy) {
    return { x: (gx - gy) * TW / 2 + OX, y: (gx + gy) * TH / 2 + OY };
}

// 地面圆的等距投影采样（等距视角下圆呈椭圆，不能直接 fillCircle）
function sampleGroundRing(scene, gx, gy, radius, segments) {
    const points = [];
    for (let i = 0; i <= segments; i++) {
        const a = i / segments * Math.PI * 2;
        points.push(scene.groundPoint(gx + Math.cos(a) * radius, gy + Math.sin(a) * radius));
    }
    return points;
}

// 0xRRGGBB 颜色线性插值（渲染平滑过渡用，不影响模拟）
function lerpColor(from, to, k) {
    const fr = from >> 16 & 255, fg = from >> 8 & 255, fb = from & 255;
    const tr = to >> 16 & 255, tg = to >> 8 & 255, tb = to & 255;
    return (Math.round(fr + (tr - fr) * k) << 16) |
        (Math.round(fg + (tg - fg) * k) << 8) | Math.round(fb + (tb - fb) * k);
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
    wagon:    { pad:  6, dx:   0, w: 64, h: 30 },
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

export class IsoBattleScene extends Phaser.Scene {
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
            red: { x: board.W / 2, y: board.H / 2 },
            blue: { x: board.W / 2, y: board.H / 2 }
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
        if (typeof UnitInspector !== 'undefined') this.unitInspector = new UnitInspector(this);

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
    terrainHeight(gx, gy) {
        return Terrain.height(this.battleOptions.terrain, gx, gy);
    }

    groundPoint(gx, gy) {
        const point = gridToScreen(gx, gy);
        point.y -= this.terrainHeight(gx, gy) * Terrain.HEIGHT_SCALE;
        return point;
    }

    groundTile(gx, gy) {
        return [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]
            .map(([dx, dy]) => this.groundPoint(gx + dx, gy + dy));
    }

    groundColor(gx, gy, variation = 0.5) {
        const natural = Terrain.isNaturalSlope(this.battleOptions.terrain);
        const dry = this.terNoise(gx * 0.16, gy * 0.16) * 0.62;
        const dirt = Math.max(0, (this.terNoise(gx * 0.42 + 37, gy * 0.42 + 91) - 0.72) / 0.28) * 0.85;
        const elevation = this.terrainHeight(gx, gy);
        let r = 98 + 42 * dry, g = 150 - 6 * dry, b = 62 + 18 * dry;
        r += (152 - r) * dirt; g += (124 - g) * dirt; b += (84 - b) * dirt;
        const dx = this.terrainHeight(gx + 0.5, gy) - this.terrainHeight(gx - 0.5, gy);
        const dy = this.terrainHeight(gx, gy + 0.5) - this.terrainHeight(gx, gy - 0.5);
        const light = natural ? clamp(0.98 + (variation - 0.5) * 0.035 + dx * 0.8 + dy * 0.55, 0.62, 1.3)
            : clamp(0.9 + variation * 0.16 + dx * 0.4 + dy * 0.25, 0.72, 1.25);
        r += elevation * (natural ? 3 : 5); b += elevation * 2;
        if (natural) g += elevation * 2;
        if (this.battleOptions.terrain === 'territory') {
            // 山河图 2.0：按高度分层提亮偏暖——山头向阳、谷地沉绿
            const tier = Math.max(0, Math.min(1, elevation / 3.2));
            r += tier * 22; g += tier * 8; b -= tier * 6;
        }
        return [r, g, b].map(value => Math.round(value * light));
    }

    drawNaturalRelief(g) {
        // 半格细分坡面，消除整格明暗台阶；所有顶点仍从真实高度采样。
        const key = this.battleOptions.terrain;
        for (let x = 1; x < 69; x += 0.5) for (let y = 10; y < 60; y += 0.5) {
            if (Terrain.height(key, x + 0.25, y + 0.25) <= 0.005) continue;
            const rgb = this.groundColor(x + 0.25, y + 0.25);
            g.fillStyle(Phaser.Display.Color.GetColor(...rgb), 1);
            g.fillPoints([[x, y], [x + 0.5, y], [x + 0.5, y + 0.5], [x, y + 0.5]]
                .map(([gx, gy]) => this.groundPoint(gx, gy)), true);
        }
    }

    drawNaturalGroundTexture(g, hash) {
        // 最后铺纹理，避免被细分坡面盖掉；只烘焙一次，不参与高度或通行计算。
        for (let gy = 1; gy < board.H - 1; gy++) for (let gx = 1; gx < board.W - 1; gx++) {
            const growth = this.terNoise(gx * 0.37 + 13, gy * 0.37 + 41);
            for (let i = 0; i < 7; i++) {
                const seed = gx * 7 + i;
                const r = hash(seed, gy * 11);
                const cx = gx - 0.44 + hash(seed + 157, gy * 13) * 0.88;
                const cy = gy - 0.44 + hash(seed + 307, gy * 17) * 0.88;
                const p = this.groundPoint(cx, cy);
                // 碎叶和土粒提供细颗粒，草簇随大片疏密变化，不排成规则点阵。
                if (i < 5) {
                    g.fillStyle(r > 0.55 ? 0xc5bf86 : 0x354d28, 0.22 + r * 0.16);
                    g.fillRect(p.x, p.y, 1.5 + r * 2.5, 1 + r * 1.2);
                }
                if (r < 0.12 + growth * 0.7) {
                    const height = 3 + hash(seed + 509, gy) * 4;
                    const lean = (hash(seed, gy + 701) - 0.5) * 5;
                    g.lineStyle(1.4, 0x3b582b, 0.43);
                    g.lineBetween(p.x - 2, p.y, p.x - 3 + lean, p.y - height * 0.65);
                    g.lineBetween(p.x, p.y, p.x + lean, p.y - height);
                    g.lineStyle(1.2, 0xb5bd71, 0.38);
                    g.lineBetween(p.x + 1, p.y, p.x + 3 + lean, p.y - height * 0.8);
                } else if (i === 0 && growth < 0.48 && r > 0.72) {
                    const size = 0.14 + r * 0.15;
                    g.fillStyle(0x998052, 0.2);
                    g.fillPoints([[-size, 0], [-size * 0.4, -size], [size, -size * 0.3],
                        [size * 0.55, size * 0.8], [-size * 0.5, size * 0.55]]
                        .map(([dx, dy]) => this.groundPoint(cx + dx, cy + dy)), true);
                }
            }
        }
    }

    setTerrain(key) {
        this.battleOptions.terrain = Terrain.normalize(key);
        this.navigation?.reset(this.battleOptions.terrain, this.battleId);
        // 只有已创建的真实画布需要重烘焙；无绘图的战斗测试仍用同一高度数据。
        if (this.groundImage && this._groundTerrain !== this.battleOptions.terrain) this.drawGround();
    }

    // 棋盘尺寸变更（进入/退出领土征服大地图）：重算世界度量并重建依赖尺寸的渲染层。
    // 无真实画布的战斗测试（无 groundImage/scarRT）只刷新度量，跳过重建。
    applyBoardSize() {
        refreshWorldMetrics();
        this._boardW = board.W;
        this._boardH = board.H;
        this.mapCenter = { x: VIEW_W / 2, y: OY + (board.W + board.H) * TH / 4 };
        if (this.groundImage) this.drawGround();                 // 重烘焙地面大贴图（内含销毁重建）
        if (this.edgeProps?.length) {                            // 大本营箭塔/边缘树林按新尺寸重摆
            for (const { sprite } of this.edgeProps) {
                this.tweens.killTweensOf(sprite);
                sprite.destroy();
            }
            this.edgeProps = [];
            this.placeDecorations();
        }
        if (this.scarRT && this.add?.renderTexture) {            // 战场留痕层按新尺寸重建
            this.scarRT.destroy();
            this.scarRT = this.add.renderTexture(0, 0, VIEW_W, VIEW_H).setOrigin(0, 0).setDepth(6);
        }
        if (this._minimap) { this._minimap.gfx.destroy(); this._minimap.zone.destroy(); this._minimap = null; }
        if (this.ocean) this.redrawOcean();
    }

    ensureNavigation() {
        if (!this.navigation) this.navigation = new TerrainNavigation(this);
        if (this.navigation.key !== this.battleOptions.terrain || this.navigation.battleId !== this.battleId)
            this.navigation.reset(this.battleOptions.terrain, this.battleId);
        return this.navigation;
    }

    // 帝国风地形：杂色草地 + 立体倒角 + 水域环绕 + 海岸黄边
    // 70×70 = 4900 块、数万条图形指令：一次性烘焙成大贴图，之后每帧只画一张图
    drawGround() {
        const g = this.make.graphics({ add: false });
        const naturalSlope = Terrain.isNaturalSlope(this.battleOptions.terrain);
        this.terNoise = this.terNoise || makeNoise(7);
        // 领土图：向外扩一圈草地（不可进入的画外景深），海岸线带噪声犬牙——
        // 战场像一块更大的大陆的中部，而不是悬在方框海中央的完整菱形
        const margin = board.MARGIN || 0;
        const isWater = (gx, gy) => {
            if (!margin) return gx === 0 || gy === 0 || gx === board.W - 1 || gy === board.H - 1;
            const edge = Math.min(gx + margin, gy + margin, board.W + margin - 1 - gx, board.H + margin - 1 - gy);
            if (edge > 2.2) return false;                        // 大陆内部
            if (edge <= 0.2) return true;                        // 外海
            return hash(gx, gy) % 100 < edge / 2.2 * 100;        // 海岸带：犬牙交错
        };
        const hash = (a, b) => {
            let h = (a * 374761393 + b * 668265263) ^ 0x5bf03635;
            h = (h ^ (h >> 13)) * 1274126177;
            return ((h ^ (h >> 16)) >>> 0) / 4294967295;
        };
        const dia = (x, y, s) => [
            { x: x, y: y - TH / 2 * s }, { x: x + TW / 2 * s, y: y },
            { x: x, y: y + TH / 2 * s }, { x: x - TW / 2 * s, y: y }
        ];

        for (let gy = -margin; gy < board.H + margin; gy++) {
            for (let gx = -margin; gx < board.W + margin; gx++) {
                const { x, y } = this.groundPoint(gx, gy);
                const tile = this.groundTile(gx, gy);
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

                // 明暗随真实坡面法向变化；颜色计算共用，细分时不会出现材质接缝。
                const base = this.groundColor(gx, gy, r1);
                const col = Phaser.Display.Color.GetColor(base[0], base[1], base[2]);
                g.fillStyle(col, 1);
                g.fillPoints(tile, true);

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
                    g.fillStyle(pc, naturalSlope ? 0.16 : 0.45);
                    if (naturalSlope) {
                        // 草斑贴在弯曲地面上，不把平面的菱形贴片悬在坡上。
                        const cx = gx + (hash(gx + i * 17, gy) - 0.5) * 0.6;
                        const cy = gy + (hash(gx, gy + i * 17) - 0.5) * 0.6;
                        const size = 0.14 + pr * 0.13;
                        g.fillPoints([[-size, 0], [0, -size * 0.6], [size, 0], [0, size]]
                            .map(([dx, dy]) => this.groundPoint(cx + dx, cy + dy)), true);
                    } else g.fillPoints(dia(px, py, 0.28 + pr * 0.22), true);
                }

                // 草叶点簇
                g.fillStyle(0x4c7a34, naturalSlope ? 0.24 : 0.55);
                for (let i = 0; i < 3; i++) {
                    const sx = x + (hash(gx * 5 + i, gy * 11) - 0.5) * TW * 0.6;
                    const sy = y + (hash(gx * 11, gy * 5 + i) - 0.5) * TH * 0.6;
                    if (naturalSlope) {
                        const point = this.groundPoint(gx + (hash(gx * 5 + i, gy * 11) - 0.5) * 0.6,
                            gy + (hash(gx * 11, gy * 5 + i) - 0.5) * 0.6);
                        g.fillCircle(point.x, point.y, 1.2 + hash(i, gx + gy * 2) * 1.4);
                    } else g.fillCircle(sx, sy, 1.2 + hash(i, gx + gy * 2) * 1.4);
                }

                // 海岸：贴水的草地加黄沙边
                if (isWater(gx - 1, gy) || isWater(gx + 1, gy) || isWater(gx, gy - 1) || isWater(gx, gy + 1)) {
                    g.fillStyle(0xd8c48a, 0.22);
                    g.fillPoints(dia(x, y, 0.96), true);
                }

                // 自然坡面与山河图不描每格棋盘边线——地形连续不"方块"；
                // 旧地图（平地/红蓝高地）保持原有网格风格。
                if (naturalSlope || this.battleOptions.terrain === 'territory') continue;
                // 立体倒角：上左边缘亮，下右边缘暗
                g.lineStyle(2, 0xd7e8b0, 0.28);
                g.lineBetween(tile[3].x, tile[3].y, tile[0].x, tile[0].y);
                g.lineBetween(tile[0].x, tile[0].y, tile[1].x, tile[1].y);
                g.lineStyle(2, 0x1e3311, 0.3);
                g.lineBetween(tile[1].x, tile[1].y, tile[2].x, tile[2].y);
                g.lineBetween(tile[2].x, tile[2].y, tile[3].x, tile[3].y);
            }
        }

        if (naturalSlope) {
            this.drawNaturalRelief(g);
            this.drawNaturalGroundTexture(g, hash);
        }
        if (Terrain.maps[this.battleOptions.terrain].rx) {
            // 连续等高线勾出坡形，不用高台立墙冒充可通行的缓坡。
            const { cx, cy, rx, ry } = Terrain.maps[this.battleOptions.terrain];
            for (const radius of [0.35, 0.55, 0.75, 0.95]) {
                const points = [];
                for (let i = 0; i <= 100; i++) {
                    const a = i / 100 * TWO_PI;
                    const gx = cx + Math.cos(a) * rx * radius;
                    const gy = cy + Math.sin(a) * ry * radius;
                    if (gx >= 1 && gx <= board.W - 1) points.push(this.groundPoint(gx, gy));
                }
                g.lineStyle(radius === 0.35 ? 3 : 2, 0xe9ddac, radius === 0.35 ? 0.7 : 0.4);
                g.strokePoints(points, false);
            }
        }
        if (this.battleOptions.terrain === 'territory') this.bakeTerritoryDressing(g);
        this.drawTerrainFeatures(g);
        this.groundImage?.destroy();
        if (this.textures.exists('groundTex')) this.textures.remove('groundTex');
        g.generateTexture('groundTex', VIEW_W, VIEW_H);
        g.destroy();
        this.groundImage = this.add.image(0, 0, 'groundTex').setOrigin(0, 0).setDepth(0);
        this._groundTerrain = this.battleOptions.terrain;
        this.drawTerrainDecorations();
        this.terrainLabel?.destroy();
        this.terrainLabel = null;
        if (this.battleOptions.terrain !== 'flat' && !naturalSlope) {
            const map = Terrain.maps[this.battleOptions.terrain];
            // 领土山河图的标签放坡脚（默认 cy-17 会落在上翼河道上）
            const labelY = this.battleOptions.terrain === 'territory' ? map.cy - map.ry - 2.5 : (map.cy || 35) - 17;
            const labelPoint = this.groundPoint(map.cx || 35, labelY);
            this.terrainLabel = this.add.text(labelPoint.x, labelPoint.y - 42,
                map.name + (map.rx ? ' · 缓坡' : ''), {
                    fontFamily: 'sans-serif', fontSize: '30px', color: '#fff3c7',
                    stroke: '#394629', strokeThickness: 6
                }).setOrigin(0.5).setDepth(7);
        }

        // 水面高光闪点（缓慢呼吸）——领土图海岸在画外缘，跳过
        if (this.battleOptions.terrain === 'territory' || this.waterSparklesCreated) return;
        this.waterSparklesCreated = true;
        for (let i = 0; i < 14; i++) {
            const side = i % 4;
            const t = hash(i, 777);
            let wx, wy;
            if (side === 0) { const { x, y } = gridToScreen(1 + t * (board.W - 2), 0); wx = x; wy = y; }
            else if (side === 1) { const { x, y } = gridToScreen(1 + t * (board.W - 2), board.H - 1); wx = x; wy = y; }
            else if (side === 2) { const { x, y } = gridToScreen(0, 1 + t * (board.H - 2)); wx = x; wy = y; }
            else { const { x, y } = gridToScreen(board.W - 1, 1 + t * (board.H - 2)); wx = x; wy = y; }
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

    // 山河图 2.0 皮肤烘焙：土路 / 灌木花草 / 老家营寨（纯视觉，一次烘焙进地面贴图；
    // 噪声一律 |x-中心| 折叠采样，左右镜像一致——视觉公平且风格对称）
    bakeTerritoryDressing(g) {
        const W = board.W, H = board.H, cx = W / 2;
        const quad = (x, y, color, alpha) => {
            g.fillStyle(color, alpha);
            g.fillPoints(this.groundTile(x, y), true);
        };
        const openGround = (x, y) =>
            !['water', 'rock', 'bridge', 'shallow', 'forest'].includes(Terrain.surface('territory', x, y));
        // ---- 土路：老家 → 本方两旗 → 高地脚下（被踩出来的行军线）----
        const road = (x1, y1, x2, y2) => {
            const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 0.45);
            const nx = -(y2 - y1), ny = x2 - x1;
            const len = Math.hypot(nx, ny) || 1;
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
                const wob = (this.terNoise(Math.abs(x - cx) * 0.35 + 9, y * 0.35 - 6) - 0.5) * 1.4;
                for (const side of [-0.45, 0.45]) {
                    const px = x + nx / len * (side + wob * 0.3);
                    const py = y + ny / len * (side + wob * 0.3);
                    if (Terrain.surface('territory', px, py) === 'water') continue;
                    quad(Math.round(px), Math.round(py), 0xc9b07c, 0.5);
                }
            }
        };
        road(8, 36, 25, 24); road(8, 36, 34, 58);
        road(W - 8, 36, W - 25, 24); road(W - 8, 36, W - 34, 58);
        road(25, 24, 50, 34); road(34, 58, 49, 39);
        road(W - 25, 24, W - 50, 34); road(W - 34, 58, W - 49, 39);
        // ---- 灌木与花草：哈希散点 + 镜像，只落开阔地 ----
        for (let i = 0; i < 90; i++) {
            const ax = 4 + (i * 37.13) % (cx - 6);
            const y = 6 + (i * 53.7) % (H - 12);
            for (const x of [ax, W - ax]) {
                if (!openGround(x, y)) continue;
                const p = this.groundPoint(x, y);
                g.fillStyle(0x3f6b36, 0.85); g.fillEllipse(p.x, p.y, 9, 5);
                g.fillStyle(0x537f47, 0.9); g.fillEllipse(p.x - 1, p.y - 1, 5, 3);
            }
        }
        for (let i = 0; i < 70; i++) {
            const ax = 5 + (i * 29.7) % (cx - 7);
            const y = 8 + (i * 61.3) % (H - 14);
            for (const x of [ax, W - ax]) {
                if (!openGround(x, y)) continue;
                const p = this.groundPoint(x, y);
                g.fillStyle([0xfff3b0, 0xffffff, 0xffd1dc][i % 3], 0.95);
                g.fillCircle(p.x, p.y, 1.6);
            }
        }
        // ---- 老家营寨：栏栅（带门洞）+ 双帐篷 ----
        for (const home of [{ x: 15.5, side: 'red' }, { x: W - 15.5, side: 'blue' }]) {
            for (let y = 24; y <= 48; y += 1.1) {
                if (Math.abs(y - 36) < 2.6) continue;   // 门洞朝战场
                const x = home.x + (this.terNoise(Math.abs(home.x - cx) * 0.3 + y * 0.2, y) - 0.5) * 0.5;
                const p = this.groundPoint(x, y);
                g.fillStyle(0x6e4f2e, 1); g.fillRect(p.x - 2, p.y - 13, 4, 13);
                g.fillStyle(0x8a6a3f, 1); g.fillRect(p.x - 2, p.y - 13, 4, 3);
            }
            const tentX = home.side === 'red' ? 6.5 : W - 6.5;
            for (const ty of [27, 45]) {
                const p = this.groundPoint(tentX, ty);
                g.fillStyle(home.side === 'red' ? 0xb0524a : 0x4a6fb0, 0.95);
                g.fillTriangle(p.x - 14, p.y, p.x + 14, p.y, p.x, p.y - 22);
                g.fillStyle(0x2c2418, 0.9);
                g.fillTriangle(p.x - 3, p.y, p.x + 3, p.y, p.x, p.y - 8);
            }
        }
    }

    drawTerrainFeatures(g) {
        const key = this.battleOptions.terrain, geometry = Terrain.geometry(key);
        const polygon = (rect, lift = 0) => [[rect.x1, rect.y1], [rect.x2, rect.y1],
            [rect.x2, rect.y2], [rect.x1, rect.y2]].map(([x, y]) => {
                const p = this.groundPoint(x, y); return { x: p.x, y: p.y - lift };
            });
        // 一格一片，沿真实高度贴地；边缘完全来自通行矩形，不用视觉近似的半格边界。
        const paint = (rect, color, alpha = 1) => {
            g.fillStyle(color, alpha);
            for (let x = rect.x1; x < rect.x2; x++) for (let y = rect.y1; y < rect.y2; y++)
                g.fillPoints(polygon({ x1: x, y1: y, x2: Math.min(x + 1, rect.x2), y2: Math.min(y + 1, rect.y2) }), true);
        };
        for (const zone of geometry.zones) {
            if (zone.kind === 'shallow') {
                // 浅滩：浅蓝可通行水域 + 沙色描边 + 波纹点
                paint(zone, 0x7fc0dd, 0.9);
                for (let y = zone.y1 + 0.6; y < zone.y2; y += 1.4) for (let x = zone.x1 + 0.7; x < zone.x2; x += 1.8) {
                    const a = this.groundPoint(x, y);
                    g.lineStyle(2, 0xbfe4f7, 0.45); g.lineBetween(a.x - 4, a.y, a.x + 4, a.y);
                }
            } else if (zone.kind === 'path') {
                paint(zone, 0xd6bd80, 0.5);
                g.lineStyle(2, 0xeee0ad, 0.6); g.strokePoints(polygon(zone), true);
            } else if (zone.kind === 'forest') {
                if (zone.blob) {
                    // 连片噪声林斑（70 图 legacy / 领土 generic 共用此形态）：
                    // 半格采样贴地铺色，边缘与通行判定共用同一占位场；四档由草色渐入深绿。
                    const field = (x, y) => zone.blob === true ? Terrain.forestField(x, y) : Terrain.blobField(zone, x, y);
                    const ramp = [[0x537f47, 0.26], [0x47703d, 0.38], [0x3d6637, 0.52], [0x315c31, 0.64]];
                    for (let y = zone.y1; y < zone.y2; y += 0.5) for (let x = zone.x1; x < zone.x2; x += 0.5) {
                        const depth = field(x + 0.25, y + 0.25) - Terrain.FOREST_EDGE;
                        if (depth <= 0) continue;
                        const tier = depth > 0.55 ? 3 : depth > 0.32 ? 2 : depth > 0.16 ? 1 : 0;
                        g.fillStyle(ramp[tier][0], ramp[tier][1]);
                        g.fillPoints(polygon({ x1: x, y1: y, x2: x + 0.5, y2: y + 0.5 }), true);
                    }
                } else {
                    // 矩形林带（领土征服）：整片铺底色 + 噪声两档加深，边界即通行边界
                    paint(zone, 0x44703c, 0.40);
                    for (let y = zone.y1; y < zone.y2; y += 1) for (let x = zone.x1; x < zone.x2; x += 1) {
                        if (this.terNoise(x * 0.9 + 5, y * 0.9 + 11) < 0.45) continue;
                        g.fillStyle(0x356033, 0.30);
                        g.fillPoints(polygon({ x1: x, y1: y, x2: x + 1, y2: y + 1 }), true);
                    }
                    g.lineStyle(2.5, 0x2c4f2a, 0.5);
                    g.strokePoints(polygon(zone), true);
                }
            }
        }
        if (key === 'forest') {
            // 林隙小径：腰桥两侧的豁口撒浅色草斑，向玩家提示可穿插的路线；只落在空地上，不压林斑。
            for (const dir of [-1, 1]) for (let i = 0; i < 7; i++) {
                const px = 35 + dir * (5.5 + i * 1.05);
                const py = 35 + (this.terNoise(px * 0.9 + dir * 17, 5) - 0.5) * 4.2;
                if (this.terNoise(px * 1.3 + 3, py * 1.3) < 0.3) continue;
                if (Terrain.forestField(px, py) > Terrain.FOREST_EDGE - 0.06) continue;
                g.fillStyle(0x9db36a, 0.45);
                g.fillPoints(polygon({ x1: px - 0.55, y1: py - 0.55, x2: px + 0.55, y2: py + 0.55 }), true);
            }
        }
        for (const block of geometry.blockers) {
            if (block.kind === 'water') {
                // 三段渐变：贴边沙色 → 浅水 → 深水；波纹只画深水
                const DEEP = 0x377fac, LIGHT = 0x63a7d6, SAND = 0xd8c48a;
                for (let x = Math.floor(block.x1); x < block.x2; x++) {
                    for (let y = Math.floor(block.y1); y < block.y2; y++) {
                        const edge = Math.min(x + 1 - block.x1, block.x2 - x, y + 1 - block.y1, block.y2 - y);
                        if (edge <= 0) continue;
                        const color = edge < 0.6 ? SAND : edge < 1.6 ? LIGHT : DEEP;
                        g.fillStyle(color, edge < 0.6 ? 0.9 : 1);
                        g.fillPoints(polygon({ x1: x, y1: y, x2: x + 1, y2: y + 1 }), true);
                        if (edge >= 2 && (x + y) % 2 === 0) {
                            const a = this.groundPoint(x + 0.3, y + 0.5), b = this.groundPoint(x + 0.95, y + 0.5);
                            g.lineStyle(2, 0xa2d8e3, 0.5); g.lineBetween(a.x, a.y, b.x, b.y);
                        }
                    }
                }
                if (key !== 'territory') { g.lineStyle(4, 0xe2cf94, 0.85); g.strokePoints(polygon(block), true); }
            } else {
                paint(block, 0x626355);
                const base = polygon(block), top = polygon(block, 24);
                g.fillStyle(0x474e47, 1); g.fillPoints([top[1], top[2], base[2], base[1]], true);
                g.fillStyle(0x343f39, 1); g.fillPoints([top[2], top[3], base[3], base[2]], true);
                g.fillStyle(0x89917b, 1); g.fillPoints(top, true);
                g.lineStyle(3, 0xb9bea0, 0.8); g.strokePoints(top, true);
                for (let y = block.y1 + 1; y < block.y2; y += 1.7) {
                    const a = this.groundPoint(block.x1 + 0.2, y), b = this.groundPoint(block.x2 - 0.2, y + 0.5);
                    g.lineStyle(2, 0x535d51, 0.8); g.lineBetween(a.x, a.y - 23, b.x, b.y - 23);
                }
            }
        }
        for (const bridge of geometry.zones.filter(zone => zone.kind === 'bridge')) {
            paint(bridge, 0xb38c52);
            for (let x = bridge.x1; x <= bridge.x2; x += 0.5) {
                const a = this.groundPoint(x, bridge.y1), b = this.groundPoint(x, bridge.y2);
                g.lineStyle(2, 0x6e5133, 0.8); g.lineBetween(a.x, a.y, b.x, b.y);
            }
            for (const y of [bridge.y1, bridge.y2]) {
                const a = this.groundPoint(bridge.x1, y), b = this.groundPoint(bridge.x2, y);
                g.lineStyle(5, 0xe0c38e, 1); g.lineBetween(a.x, a.y - 8, b.x, b.y - 8);
                for (let x = bridge.x1; x <= bridge.x2; x += 1.5) {
                    const p = this.groundPoint(x, y);
                    g.lineStyle(4, 0x735233, 1); g.lineBetween(p.x, p.y, p.x, p.y - 12);
                }
            }
        }
        const defense = geometry.defense;
        if (defense && !Terrain.isNaturalSlope(key)) {
            g.lineStyle(3, 0xf4e4a4, 0.75); g.strokePoints(polygon(defense.archerRect), true);
        }
    }

    drawTerrainDecorations() {
        for (const prop of this.terrainProps || []) prop.destroy();
        this.terrainProps = [];
        for (const { sprite, gx, gy } of this.edgeProps || [])
            sprite.setVisible(!['water', 'rock'].includes(Terrain.surface(this.battleOptions.terrain, gx, gy)));
        for (const zone of Terrain.geometry(this.battleOptions.terrain).zones.filter(zone => zone.kind === 'forest')) {
            for (let x = zone.x1 + 1; x < zone.x2 - 0.5; x += 2.2) for (let y = zone.y1 + 1; y < zone.y2 - 0.5; y += 2.2) {
                // 林斑占位：legacy 噪声场 / 领土通用噪声场 / 矩形兜底三形态
                let density;
                if (zone.blob === true) density = Terrain.forestField(x, y);
                else if (zone.blob === 'generic') density = Terrain.blobField(zone, x, y);
                else density = this.terNoise(x * 0.7 + 3, y * 0.7 + 9) > 0.18 ? 0.28 + this.terNoise(x * 0.7 + 3, y * 0.7 + 9) * 0.55 : 0;
                if (density <= Terrain.FOREST_EDGE) continue;
                // 山河图 2.0：成丛生长——簇噪声不过阈值的点位留空，林子有了疏密
                if (zone.blob === 'generic' && this.terNoise(x * 0.33 + 7, y * 0.33 - 5) < 0.45) continue;
                // 深林成簇大树、林缘稀疏小树：树只是林区提示，不是逐棵实体障碍。
                const clump = this.terNoise(x * 0.55 + 9, y * 0.55 + 3);
                if (clump > 0.25 + (density - Terrain.FOREST_EDGE) * 0.9) continue;
                const p = this.groundPoint(x + (clump - 0.5) * 1.2, y + (this.terNoise(y * 0.9 + 17, x * 0.9) - 0.5) * 1.2);
                const big = density > 0.55 && clump > 0.45;
                const tree = this.add.image(p.x, p.y, big ? 'props/tree_big' : 'props/tree_small')
                    .setOrigin(0.5, 0.92).setScale((big ? 0.42 : 0.33) + clump * 0.1).setAlpha(0.85).setDepth(3);
                const shade = this.terNoise(x * 1.7 + 31, y * 1.7 + 7);
                tree.setTint(shade > 0.62 ? 0xf2f6e4 : shade < 0.34 ? 0xd4e0d0 : 0xe7eeda);
                this.terrainProps.push(tree);
            }
        }
        for (const block of Terrain.geometry(this.battleOptions.terrain).blockers.filter(block => block.kind === 'rock')) {
            for (let x = block.x1 + 0.6; x < block.x2; x += 1.6) for (let y = block.y1 + 0.6; y < block.y2; y += 1.7) {
                const p = this.groundPoint(x, y);
                const rock = this.add.image(p.x, p.y - 20, 'props/rock')
                    .setOrigin(0.5, 0.9).setScale(0.38 + this.terNoise(x, y) * 0.12).setDepth(3);
                this.terrainProps.push(rock);
            }
        }
        // 山河图 2.0：坡地散树——林带之外的疏林点缀（哈希折叠镜像，避开一切非草地）
        if (this.battleOptions.terrain === 'territory') {
            for (let i = 0; i < 60; i++) {
                const ax = 6 + (i * 41.3) % (board.W / 2 - 8);
                const y = 22 + (i * 47.9) % (board.H - 30);
                for (const x of [ax, board.W - ax]) {
                    if (['water', 'rock', 'bridge', 'shallow', 'forest'].includes(Terrain.surface('territory', x, y))) continue;
                    if (this.terNoise(x * 0.5 + 3, y * 0.5) < 0.52) continue;
                    const p = this.groundPoint(x, y);
                    const tree = this.add.image(p.x, p.y, 'props/tree_small')
                        .setOrigin(0.5, 0.92).setScale(0.28 + this.terNoise(x * 1.3, y * 1.7) * 0.1)
                        .setAlpha(0.92).setDepth(3);
                    tree.setTint(this.terNoise(x * 1.7 + 31, y * 2.3) > 0.6 ? 0xe7eeda : 0xd4e0d0);
                    this.terrainProps.push(tree);
                }
            }
        }
    }

    placeDecorations() {
        const deco = [];
        this.edgeProps = [];
        // 双方大本营：箭塔沿基地前沿一字排开（要塞感）
        [8, 20, 34, 48, 60].forEach(gy => {
            deco.push(['tower', 2.2, gy]);
            deco.push(['tower', board.W - 3.2, gy]);
        });
        // 上下边缘树林带 + 零散岩石（不挡主战场）
        const jit = (a, b) => a + Math.random() * (b - a);
        for (let gx = 4; gx < board.W - 5; gx += 3) {
            deco.push([Math.random() < 0.5 ? 'tree_big' : 'tree_small', jit(gx, gx + 2), jit(1.2, 2.6)]);
            deco.push([Math.random() < 0.5 ? 'tree_big' : 'tree_small', jit(gx, gx + 2), jit(board.H - 2.8, board.H - 1.4)]);
        }
        for (let i = 0; i < 8; i++) {
            deco.push(['rock', jit(6, board.W - 7), Math.random() < 0.5 ? jit(1.6, 2.4) : jit(board.H - 2.6, board.H - 1.8)]);
        }
        deco.forEach(([key, gx, gy]) => {
            const { x, y } = gridToScreen(gx, gy);
            const spr = this.add.image(x, y, 'props/' + key).setOrigin(0.5, 0.92);
            spr.setScale(key === 'tower' ? 0.48 : 0.5);   // 新像素素材原生更大，按显示高度折算
            spr.setDepth((gx + gy) * 100 + 10);
            spr.setVisible(!['water', 'rock'].includes(Terrain.surface(this.battleOptions.terrain, gx, gy)));
            this.edgeProps.push({ sprite: spr, gx, gy });
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
        if (Terrain.isNaturalSlope(this.battleOptions.terrain)) return;
        if (this.battleOptions.terrain === 'territory') {
            // 领土图：大本营领地光晕（三层椭圆渐隐），替代整块矩形出兵区
            for (const [x, color] of [[8, 0xff5555], [board.W - 8, 0x5599ff]]) {
                for (const [rx, ry, alpha] of [[9, 16, 0.30], [6, 11, 0.35], [3.4, 6.5, 0.42]]) {
                    g.fillStyle(color, alpha);
                    g.fillPoints(sampleGroundRing(this, x, board.H / 2, rx, ry, 26), true);
                }
            }
            return;
        }
        const zone = (x0, x1, color) => {
            for (let gy = 1; gy < board.H - 1; gy++)
                for (let gx = x0; gx < x1; gx++) {
                    g.fillStyle(color, 1);
                    g.fillPoints(this.groundTile(gx, gy), true);
                }
        };
        zone(2, 14, 0xff5555);
        zone(board.W - 14, board.W - 2, 0x5599ff);
    }

    setupCamera() {
        const cam = this.cameras.main;
        this.userZoom = 1;
        this.mapCenter = { x: VIEW_W / 2, y: OY + (board.W + board.H) * TH / 4 };

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
        // 领土征服大地图：默认不整图铺满（千人单位会小到看不清）——取整图缩放与
        // "约 55% 地图宽"两者的较大值作舒适基准；镜头初始对准红方大本营与中央
        // 高地之间，全局定位交给小地图（resize 只重设缩放，不抢已平移的镜头）。
        if (this.battleOptions.territory) {
            const mw = VIEW_W + 260, mh = VIEW_H + 320;
            this.baseZoom = Math.max(Math.max(w / mw, h / mh) * 1.06, w / (VIEW_W * 0.55));
            cam.setBounds(-320, -40, VIEW_W + 640, VIEW_H + 200);
            this.applyZoom();
            if (!this._territoryCamInit && this.units.length) {
                this._territoryCamInit = true;
                const home = this.groundPoint(board.W * 0.3, board.H / 2);
                cam.centerOn((home.x + this.mapCenter.x) / 2, (home.y + this.mapCenter.y) / 2);
            }
            if (this.ocean) this.redrawOcean();
            return;
        }
        // 地图的世界包围盒（含装饰余量）
        const mw = VIEW_W + 260, mh = VIEW_H + 320;
        this.baseZoom = Math.max(w / mw, h / mh) * 1.06;
        // 平移边界 = 地图菱形外扩一圈，缩多大都不会把地图拖出视野
        cam.setBounds(-320, -40, VIEW_W + 640, VIEW_H + 200);
        if ((this.tactics || this.battleOptions.terrain !== 'flat') && this.units.length) {
            const points = this.units.flatMap(unit => [this.groundPoint(unit.gx, unit.gy),
                ...(unit.route || []).map(point => this.groundPoint(point.gx, point.gy))]);
            const minX = Math.min(...points.map(p => p.x)) - 100, maxX = Math.max(...points.map(p => p.x)) + 100;
            const minY = Math.min(...points.map(p => p.y)) - 110, maxY = Math.max(...points.map(p => p.y)) + 100;
            this.baseZoom = Math.min((w - 40) / (maxX - minX), Math.max(220, h - 230) / (maxY - minY));
            this.applyZoom();
            cam.centerOn((minX + maxX) / 2, (minY + maxY) / 2 + 45 / cam.zoom);
            if (this.ocean) this.redrawOcean();
            return;
        }
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
        this.unitInspector?.reset();
        this.tactics = null;
        this.battleOptions = { deathmatch: false, control: false, convoy: false, territory: false,
            reserves: { red: 0, blue: 0 }, terrain: 'flat',
            cavalryOrders: { red: 'auto', blue: 'auto' } };
        this.territory = null;
        this.battalions = null;
        this.selectedBattalion = null;
        this.net = null;
        this.netMySide = 'red';
        this.selectionGfx?.clear();
        this._territoryCamInit = false;
        if (this.tacticsGfx) this.tacticsGfx.clear();
        this.battleId = (this.battleId || 0) + 1;
        this.navigation?.reset('flat', this.battleId);
        this.simulationTime = 0;
        this.simulationAccumulator = 0;
        this.battleQueue = [];
        this.battleImpacts = [];
        this.braceQueue = new BraceQueue();
        this.collectingImpacts = false;
        this.planningStep = false;
        // 战报台账移至 js/battle/report.js（第 0 批 4/4）；battleStats 保持同一对象，外部契约不变
        this.ledger = new BattleLedger(this.battleId);
        this.battleStats = this.ledger.stats;
        this.dyingUnits = new Set();
        this.morale = new MoraleSystem(this);
        this.collapseSince = { red: null, blue: null };
        this.moraleLastReason = { red: '', blue: '' };
        this.endReason = null;
        this.resolvingOutcome = false;
        this._rallyAnchors = [];
        this._rallyRefresh = -Infinity;
        this._lastMoraleUI = 0;
    }

    // 台账字段经 getter 暴露（ui.js/tests 直接读 scene.moraleCue / scene.firstContactMs）
    get firstContactMs() { return this.ledger.firstContactMs; }
    get moraleCue() { return this.ledger.moraleCue; }

    registerUnit(unit) {
        unit.battleId = this.battleId;
        this.ledger.register(unit);
    }

    recordDamage(target, damage, from, attackStartedAt = from?.lastAttack) {
        this.ledger.recordDamage(this.simulationTime, target, damage, from, attackStartedAt);
    }

    addBattleEvent(key, text, team) {
        this.ledger.addEvent(this.simulationTime, key, text, team);
    }

    recordDeath(unit, from) {
        const alive = this.ledger.recordDeath(this.simulationTime, unit, from, this.battleId);
        if (unit.team === 'red') this.redAlive = alive;
        else this.blueAlive = alive;
    }

    getBattleReport() {
        const teams = JSON.parse(JSON.stringify(this.battleStats));
        for (const team of ['red', 'blue']) {
            teams[team].routing = 0;
            for (const stats of Object.values(teams[team].byType)) stats.routing = 0;
        }
        for (const unit of this.units) {
            if (unit.dead || unit.withdrawn || unit.moraleState !== 'routing') continue;
            teams[unit.team].routing++;
            teams[unit.team].byType[unit.type].routing++;
        }
        return {
            red: this.battleStats.red.alive,
            blue: this.battleStats.blue.alive,
            durationMs: Math.round(this.simulationTime),
            terrain: this.battleOptions.terrain,
            orders: { red: this.tactics?.orders.red || 'advance', blue: this.tactics?.orders.blue || 'advance' },
            cavalryOrders: { ...this.battleOptions.cavalryOrders },
            firstContactMs: this.ledger.firstContactMs,
            teams,
            morale: this.getMoraleSummary(),
            deathmatch: this.battleOptions.deathmatch,
            territory: this.battleOptions.territory && this.territory ? {
                tickets: { red: Math.round(this.territory.tickets.tickets.red), blue: Math.round(this.territory.tickets.tickets.blue) },
                flags: this.flags.map(f => ({ name: f.name, owner: f.owner })),
                earned: { red: Math.round(this.territory.econ.earned.red), blue: Math.round(this.territory.econ.earned.blue) },
                spent: { red: Math.round(this.territory.econ.spent.red), blue: Math.round(this.territory.econ.spent.blue) },
                recruited: { red: this.territory.recruit.spawned.red, blue: this.territory.recruit.spawned.blue }
            } : null,
            tactics: this.getTacticsSummary(),
            endReason: this.endReason,
            events: this.ledger.events.map(event => ({ ...event }))
        };
    }

    getMoraleSummary() {
        const result = {};
        for (const team of ['red', 'blue']) {
            const stats = this.battleStats[team];
            result[team] = { steady: 0, wavering: 0, routing: 0, withdrawn: stats.withdrawn,
                rallied: stats.rallied, reengaged: stats.reengaged, postRallyDamage: stats.postRallyDamage,
                fallingBack: 0, escaping: 0, recovering: 0, forming: 0, returning: 0,
                average: 0, lastReason: this.moraleLastReason[team] };
        }
        for (const unit of this.units) {
            if (unit.dead || unit.withdrawn) continue;
            const stats = result[unit.team];
            stats[unit.moraleState || 'steady']++;
            stats.average += unit.morale ?? 100;
            if (unit.moraleState === 'routing') {
                if (unit.moralePhase === 'recovering') stats.recovering++;
                else stats.escaping++;
            } else if (unit.rallyWaiting) stats.forming++;
            else if (unit.moraleState === 'wavering' && unit.moraleFallBackUntil > this.simulationTime) stats.fallingBack++;
            else if (unit.moralePhase === 'returning') stats.returning++;
        }
        for (const stats of Object.values(result)) {
            const count = stats.steady + stats.wavering + stats.routing;
            stats.average = count ? Math.round(stats.average / count) : 0;
        }
        return result;
    }

    onMoraleStateChange(unit, previousState, reason) {
        const side = unit.team === 'red' ? '红方' : '蓝方';
        const state = unit.moraleState;
        const stats = this.battleStats[unit.team];
        if (state === 'routing') {
            unit.routStartedAt = this.simulationTime;
            unit.moralePhase = 'breaking';
            unit.moraleFallBackUntil = 0;
            unit.rallyWaiting = false; unit.rallyReadyAt = null;
            unit.tacticalRejoined = false;
            unit.guardReady = false; unit.guardStableTime = 0;
            unit.actionEpoch = (unit.actionEpoch || 0) + 1;
            unit.braceReady = false; unit.braceHold = false; unit.braceTime = 0;
            this.cavalryAI?.enterMelee(unit);
            unit.target = null;
            unit.animState = null; unit.animLock = 0;
            this.tweens.killTweensOf(unit.lunge);
            unit.lunge.x = 0; unit.lunge.y = 0;
            if (!unit.everRouted) {
                unit.everRouted = true;
                stats.routed++; stats.byType[unit.type].routed++;
            }
        } else if (previousState === 'routing') {
            unit.lastRalliedAt = this.simulationTime;
            unit.moralePhase = 'returning';
            this.tactics?.onRallied?.(unit);
            if (!unit.everRallied) {
                unit.everRallied = true;
                stats.rallied++; stats.byType[unit.type].rallied++;
            }
            if (unit.type === 'cavalry') this.cavalryAI?.beginCharge(unit);
        }
        const label = state === 'routing' ? '开始溃逃' : previousState === 'routing' ? '完成重整'
            : state === 'wavering' ? '出现动摇' : '稳住阵脚';
        const sector = this.moraleSector(unit);
        const text = `${side}${sector}${unit.typeData.name}${label}：${reason}`;
        this.moraleLastReason[unit.team] = `${sector}${label} · ${reason}`;
        this.addBattleEvent(`morale-${unit.team}-${sector}-${previousState === 'routing' ? 'rally' : state}`, text, unit.team);
        this._countsDirty = true;
    }

    moraleSector(unit) {
        const middle = this.tactics?.formations[unit.team]?.cy ?? board.H / 2;
        return unit.gy < middle - 3 ? '上翼' : unit.gy > middle + 3 ? '下翼' : '中路';
    }

    updateFallingBackUnit(unit, now, dt) {
        if (unit.moraleState !== 'wavering' || !(unit.moraleFallBackUntil > now) ||
            !['infantry', 'pikeman'].includes(unit.type)) return false;
        const slot = unit.formationSlot;
        if (unit.tacticalRole === 'guard' && this.tactics?.formations[unit.team] &&
            slot?.unit === unit && unit.guardSupport >= 2 && Math.hypot(unit.gx - slot.gx, unit.gy - slot.gy) <= 0.81) {
            // 有邻兵支援时由战阵统一转向、迎击与补位，不因同一处伤亡让整排自行后退。
            unit.moraleFallBackUntil = 0;
            return false;
        }
        const enemy = this.nearestEnemy(unit);
        if (!enemy || dist(unit, enemy) > 3) return false;
        const dx = enemy.gx - unit.gx, dy = enemy.gy - unit.gy, length = Math.hypot(dx, dy) || 1;
        unit.retreatFacingX = dx / length; unit.retreatFacingY = dy / length;
        moveToward(unit, unit.gx - dx / length, unit.gy - dy / length, unit.typeData.speed * 0.45, dt);
        if (unit.moving) {
            unit.guardReady = false; unit.guardStableTime = 0;
            unit.braceReady = false; unit.braceHold = false; unit.braceTime = 0;
        }
        // 有序后退仍能自卫；真正溃逃由 routing 分支接管并禁止攻击。
        CombatRules.attack(this, unit, enemy, now, unit.typeData.range);
        return true;
    }

    updateRoutedUnit(unit, dt) {
        // 在安全友军身边停下等待重整，不能边逃边自动回满士气。
        if (unit.moraleSheltered) return;
        const now = this.simulationTime;
        if (now - this._rallyRefresh >= 500) {
            this._rallyRefresh = now;
            this._rallyAnchors = this.units.filter(other => {
                if (other.dead || other.withdrawn || other.moraleState !== 'steady') return false;
                let support = 0, threatened = false;
                this.forEachNear(other.gx, other.gy, 6, neighbor => {
                    if (neighbor.dead || neighbor.withdrawn || neighbor.moraleState === 'routing') return;
                    const distance = dist(other, neighbor);
                    if (neighbor.team !== other.team && distance <= 6) threatened = true;
                    if (neighbor.team === other.team && neighbor.moraleState === 'steady' && distance <= 5) support++;
                });
                // 接应点可包含锚点自己：三名预备队足以接应，不能误要求第四人。
                return !threatened && support >= 3;
            });
        }
        if (!unit.rallyTarget || unit.rallyTarget.dead || unit.rallyTarget.withdrawn ||
            unit.rallyTarget.moraleState !== 'steady' || now >= (unit.nextRallySearch || 0)) {
            unit.nextRallySearch = now + 500;
            unit.rallyTarget = null;
            let best = 18 * 18;
            for (const other of this._rallyAnchors) {
                if (other.team !== unit.team || other.dead || other.withdrawn || other.moraleState !== 'steady') continue;
                const distance = (other.gx - unit.gx) ** 2 + (other.gy - unit.gy) ** 2;
                if (distance < best - 1e-9 || (unit.rallyTarget && Math.abs(distance - best) <= 1e-9 && other.id < unit.rallyTarget.id)) {
                    best = distance; unit.rallyTarget = other;
                }
            }
        }
        const anchor = this.tactics?.rallyPoint(unit) || unit.rallyTarget;
        let dx = (anchor ? anchor.gx : unit.team === 'red' ? 0 : board.W) - unit.gx;
        let dy = anchor ? anchor.gy - unit.gy : 0;
        const length = Math.hypot(dx, dy) || 1;
        dx /= length; dy /= length;
        // 邻近敌人使逃跑方向偏离危险处，仍保留回撤方向，防止原地左右振荡。
        this.forEachNear(unit.gx, unit.gy, 4, enemy => {
            if (enemy.team === unit.team || enemy.dead || enemy.withdrawn || enemy.moraleState === 'routing') return;
            const ex = unit.gx - enemy.gx, ey = unit.gy - enemy.gy, d = Math.hypot(ex, ey);
            if (d <= 0.001 || d > 4) return;
            const weight = (4 - d) / 4;
            dx += ex / d * weight; dy += ey / d * weight;
        });
        const direction = Math.hypot(dx, dy);
        if (direction < 0.001) { dx = unit.team === 'red' ? -1 : 1; dy = 0; }
        const normalize = Math.hypot(dx, dy);
        const closeEnemy = now - (unit.routStartedAt ?? -Infinity) < 900 ? this.nearestEnemy(unit) : null;
        const breaking = closeEnemy && dist(unit, closeEnemy) < 3;
        if (Terrain.hasBarriers(this.battleOptions.terrain)) {
            // 隔岸时保留全局接应点；三格的局部躲避点可能落水，不能用它取代回撤路线。
            moveToward(unit, anchor ? anchor.gx : unit.team === 'red' ? 0.6 : board.W - 0.6,
                anchor ? anchor.gy : unit.gy, unit.typeData.speed * (breaking ? 0.7 : 1), dt);
            return;
        }
        moveToward(unit, unit.gx + dx / normalize * 3, unit.gy + dy / normalize * 3,
            unit.typeData.speed * (breaking ? 0.7 : 1), dt);
    }

    withdrawUnit(unit) {
        if (this.battleOptions.deathmatch) return;
        if (unit.dead || unit.withdrawn || unit.battleId !== this.battleId) return;
        unit.withdrawn = true;
        unit.actionEpoch = (unit.actionEpoch || 0) + 1;
        const team = this.battleStats[unit.team];
        for (const stats of [team, team.byType[unit.type]]) { stats.alive--; stats.withdrawn++; }
        if (unit.team === 'red') this.redAlive = team.alive;
        else this.blueAlive = team.alive;
        this.tweens.killTweensOf(unit.spr); this.tweens.killTweensOf(unit.lunge);
        unit.spr.destroy(); unit.shadow.destroy();
        this._countsDirty = true;
        this.addBattleEvent(`withdraw-${unit.team}`, `${unit.team === 'red' ? '红方' : '蓝方'}溃兵开始撤离战场`, unit.team);
    }

    // ---------------- 战斗核编排（实现在 js/battle/core.js，场景只做委托与渲染钩子） ----------------
    scheduleBattleAction(delayMs, callback) {
        core.scheduleBattleAction(this, delayMs, callback);
    }

    flushBattleActions() {
        core.flushBattleActions(this);
    }

    flushBattleImpacts() {
        core.flushBattleImpacts(this);
    }

    queueBrace(guard, cavalry) {
        this.braceQueue.queue(guard, cavalry);
    }

    resolveBrace(guard, cavalry) {
        core.resolveBrace(this, guard, cavalry);
    }

    flushBraceCandidates() {
        this.braceQueue.flush((guard, cavalry) => this.resolveBrace(guard, cavalry));
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

    deployUnits(redConfig, blueConfig, redFormation, blueFormation, orders = {}, options = {}) {
        // 棋盘尺寸：领土征服用大地图，其余模式回默认；尺寸变化时重建依赖尺寸的渲染层。
        if (options.territory) setBoardSize(TERRITORY.W, TERRITORY.H, 5); else resetBoardSize();
        if (this._boardW !== board.W || this._boardH !== board.H) this.applyBoardSize();
        this.clearUnits(options.terrain);
        this.drawSpawnZones();
        const armies = [
            ['red', redConfig, redFormation],
            ['blue', blueConfig, blueFormation]
        ];
        armies.forEach(([team, cfg, formation]) => {
            generateArmyPositions(team, cfg, formation).forEach(p => this.spawnUnit(team, p.type, p.gx, p.gy));
        });
        this.battleOptions.deathmatch = options.deathmatch === true;
        this.battleOptions.control = options.control === true;
        this.battleOptions.convoy = options.convoy === true;
        this.battleOptions.territory = options.territory === true;
        this.battleOptions.net = options.net === true;
        this.netMySide = options.mySide === 'blue' ? 'blue' : 'red';   // 联机=本端阵营；单机恒红
        for (const [team] of armies) {
            const cavalryOrder = options.cavalryOrders?.[team];
            this.battleOptions.cavalryOrders[team] = ['direct', 'flank_archers'].includes(cavalryOrder) ? cavalryOrder : 'auto';
            const count = this.units.filter(unit => unit.team === team && unit.type === 'infantry').length;
            const requested = options.reserves?.[team];
            this.battleOptions.reserves[team] = Number.isFinite(requested)
                ? clamp(Math.floor(requested), 0, Math.max(0, count - 1)) : 0;
        }
        const effectiveOrders = {};
        for (const [team, config] of armies) {
            const order = orders[team];
            effectiveOrders[team] = order === 'hold_ground' && Object.values(config).some(count => count > 0) ? order :
                order === 'hold' && config.pikeman > 0 ? order :
                ['assault', 'flank'].includes(order) && config.infantry > 0 ? order : 'advance';
        }
        if (Object.values(effectiveOrders).some(order => order !== 'advance') ||
            Object.values(this.battleOptions.reserves).some(count => count > 0) ||
            Terrain.isNaturalSlope(this.battleOptions.terrain)) {
            this.tactics = new TacticsSystem(this, effectiveOrders);
        }
        this.redAlive = this.units.filter(u => u.team === 'red').length;
        this.blueAlive = this.units.filter(u => u.team === 'blue').length;
        this.deadCount = 0;
        this._view = null;      // 重新部署后先全量同步渲染
        this.battleStarted = false;
        this.battleOver = false;
        this.userZoom = 1;
        // 占点征服：三面旗立在中线 x=35（换座镜像 x→70-x 下自对称），
        // 上翼/中路/下翼纵向分布。旗归属以单位在场数判定，积分先到 60 者胜。
        this.flags = this.battleOptions.territory ? makeTerritoryFlags()
            : this.battleOptions.control ? [
                { gx: 35, gy: board.H * 0.24, name: '上翼' },
                { gx: 35, gy: board.H * 0.5, name: '中路' },
                { gx: 35, gy: board.H * 0.76, name: '下翼' }
            ].map(f => ({ ...f, owner: null, progress: 0, contested: false })) : null;
        this.controlScore = { red: 0, blue: 0 };
        // 领土征服运行态：经济 / 征兵队列 / 票数 / 战略 AI。五面旗布局见 battle/economy.js。
        // 蓝方默认自动征兵（红方玩家手动大按钮）；territoryAI:true 双方自动（观战/测试），
        // territoryAI:false 双方停手（隔离变量测经济/票数）；联机对战双方都是真人（AI 只调度无令营）。
        this.territory = this.battleOptions.territory ? {
            econ: new TerritoryEconomy(),
            recruit: new RecruitSystem(this),
            tickets: new TicketSystem(),
            rally: { red: null, blue: null },   // 玩家集结旗（null=老家集结）
            ai: { red: new TerritoryAI(this, 'red'), blue: new TerritoryAI(this, 'blue') },
            autoBuy: {
                red: options.territoryAI === true,
                blue: options.net ? false : options.territoryAI !== false
            }
        } : null;
        // 营队系统（仅领土征服）：开局常备军按纵向三等分为上/中/下营
        this.battalions = this.battleOptions.territory ? new BattalionSystem(this) : null;
        this.selectedBattalion = null;
        if (this.battalions) this.battalions.splitOpening(this.units);
        // 护送模式：红方 4 辆辎重车从出发区沿中线穿越战场，送抵 3 辆红胜、
        // 被毁 3 辆蓝胜；车附近有护送部队才前进（无保护停下等待）。
        this.convoy = null;
        if (this.battleOptions.convoy) {
            this.ensureWagonTextures();
            const wagons = [[13, board.H / 2 - 3], [12, board.H / 2], [13, board.H / 2 + 3], [10.5, board.H / 2]]
                .map(([x, y]) => {
                    const wagon = this.spawnUnit('red', 'wagon', x, y);
                    wagon.tacticalRole = 'convoy_wagon';
                    return wagon;
                });
            this.convoy = { team: 'red', goalX: board.W - 6, wagons, need: 3, delivered: 0, destroyed: 0 };
        }
        if (this.cameras.main.setZoom) this.fitCamera();
    }

    getTacticsSummary() { return this.tactics ? this.tactics.summary() : null; }

    drawTactics() {
        if (!this.tactics) return;
        if (!this.tacticsGfx) this.tacticsGfx = this.add.graphics().setDepth(12000);
        const g = this.tacticsGfx;
        g.clear();
        for (const ground of Object.values(this.tactics.groundGuards)) {
            if (!ground.members.some(unit => this.tactics.active(unit))) continue;
            if (Terrain.isNaturalSlope(this.battleOptions.terrain)) continue;
            // 一条低透明度守区边界；不为每位士兵叠加追击圈。
            const points = Array.from({ length: 25 }, (_, index) => {
                const angle = index / 24 * Math.PI * 2;
                return this.groundPoint(ground.cx + Math.cos(angle) * 8, ground.cy + Math.sin(angle) * 10);
            });
            g.lineStyle(2, ground.team === 'blue' ? 0x6abaff : 0xff8b77, 0.25);
            points.forEach((point, index) => {
                if (index) g.lineBetween(points[index - 1].x, points[index - 1].y, point.x, point.y);
            });
            const flag = this.groundPoint(ground.cx, ground.cy);
            g.lineStyle(2, ground.team === 'blue' ? 0x6abaff : 0xff8b77, 0.7);
            g.lineBetween(flag.x, flag.y, flag.x, flag.y - 35);
            g.lineBetween(flag.x, flag.y - 35, flag.x + 16, flag.y - 29);
            g.lineBetween(flag.x + 16, flag.y - 29, flag.x, flag.y - 23);
        }
        for (const formation of Object.values(this.tactics.formations)) {
            const h = formation.half + 0.42;
            const corners = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y]) => this.groundPoint(formation.cx + x, formation.cy + y));
            g.lineStyle(2, formation.team === 'blue' ? 0x6abaff : 0xff8b77, 0.45);
            corners.forEach((p, i) => g.lineBetween(p.x, p.y, corners[(i + 1) % 4].x, corners[(i + 1) % 4].y));
            for (const guard of formation.members) {
                if (!this.tactics.active(guard) || (guard.formationSlot.rank > 1 && !guard.guardEngaging)) continue;
                const a = this.groundPoint(guard.gx, guard.gy);
                const length = guard.guardReady ? 1.15 : 0.8;
                const b = this.groundPoint(guard.gx + guard.guardFacingX * length, guard.gy + guard.guardFacingY * length);
                g.lineStyle(2, guard.guardReady ? 0x9de3ef : 0xe2b65b, guard.guardReady ? 0.7 : 0.35);
                g.lineBetween(a.x, a.y - 7, b.x, b.y - 7);
            }
        }
        for (const group of Object.values(this.tactics.groups)) {
            // 青绿色脚圈标出仍在后方接应的预备队；投入前线后取消待命标记。
            for (const unit of group.reserve || []) {
                if (!this.tactics.active(unit) || unit.tacticalRole !== 'reserve' || unit.reserveCommitted) continue;
                const p = this.groundPoint(unit.gx, unit.gy);
                g.lineStyle(1.8, 0x72e0ad, 0.85);
                g.strokeEllipse(p.x, p.y, 23, 12);
            }
            const reserve = (group.safeReserve || []).filter(unit => this.tactics.active(unit) &&
                unit.moraleState === 'steady' && !unit.reserveCommitted && this.tactics.safeAt(unit.team, unit.gx, unit.gy));
            // 旗只落在真实安全接应者身旁，预备队离开后不保留虚假的恢复点。
            const anchors = [];
            for (const unit of reserve) {
                if (anchors.some(other => dist(unit, other) <= 8)) continue;
                if (reserve.filter(other => dist(unit, other) <= 4).length >= 3) anchors.push(unit);
            }
            for (const anchor of anchors) {
                const p = this.groundPoint(anchor.gx, anchor.gy);
                const pulse = 0.7 + Math.sin(this.simulationTime * 0.004) * 0.15;
                g.lineStyle(2, 0x72e0ad, pulse);
                g.strokeEllipse(p.x, p.y, 78, 38);
                g.lineBetween(p.x, p.y, p.x, p.y - 46);
                g.lineBetween(p.x, p.y - 46, p.x + 20, p.y - 40);
                g.lineBetween(p.x + 20, p.y - 40, p.x, p.y - 33);
            }
            const wing = group.flank.filter(unit => this.tactics.active(unit));
            if (!wing.length) continue;
            const leader = wing[Math.floor(wing.length / 2)];
            if (!group.launched) {
                const points = [{ gx: leader.gx, gy: leader.gy }, ...leader.route.slice(leader.routeIndex)].map(p => this.groundPoint(p.gx, p.gy));
                g.lineStyle(3, 0xf6cc68, 0.65);
                points.forEach((p, i) => {
                    if (i) g.lineBetween(points[i - 1].x, points[i - 1].y, p.x, p.y);
                    if (i === points.length - 1) g.strokeCircle(p.x, p.y, 5);
                });
            }
            for (const unit of wing) {
                const p = this.groundPoint(unit.gx, unit.gy);
                g.lineStyle(1.5, 0xf6cc68, 0.7);
                g.strokeEllipse(p.x, p.y, 21, 10);
            }
        }
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

    // 辎重车贴图运行时生成：木箱车体+双轮+篷顶+队旗（无外部素材依赖）
    ensureWagonTextures() {
        for (const team of ['red', 'blue']) {
            const key = `units/${team}_wagon`;
            if (this.textures.exists(key)) continue;
            const g = this.add.graphics();
            const W = 64, H = 46, accent = team === 'red' ? 0xff5b5b : 0x57a0ff;
            // 车轮（等距椭圆轮）
            g.fillStyle(0x3a2c1a, 1);
            g.fillEllipse(18, H - 10, 16, 9);
            g.fillEllipse(46, H - 10, 16, 9);
            g.lineStyle(2, 0x241a0e, 1);
            g.strokeEllipse(18, H - 10, 16, 9);
            g.strokeEllipse(46, H - 10, 16, 9);
            g.fillStyle(0xc9a35f, 1);
            g.fillEllipse(18, H - 10, 5, 3);
            g.fillEllipse(46, H - 10, 5, 3);
            // 车箱
            g.fillStyle(0x8a6a3e, 1);
            g.fillPoints([{ x: 8, y: H - 14 }, { x: 56, y: H - 14 }, { x: 58, y: H - 30 }, { x: 6, y: H - 30 }], true);
            g.lineStyle(2, 0x5d4322, 1);
            g.strokePoints([{ x: 8, y: H - 14 }, { x: 56, y: H - 14 }, { x: 58, y: H - 30 }, { x: 6, y: H - 30 }], true, true);
            // 篷顶弧
            g.fillStyle(0xd8cfb4, 1);
            g.fillTriangle(4, H - 30, 60, H - 30, 32, H - 44);
            g.lineStyle(2, 0x8f8468, 0.8);
            g.strokeTriangle(4, H - 30, 60, H - 30, 32, H - 44);
            // 队旗小杆
            g.lineStyle(2, 0x241a0e, 1);
            g.lineBetween(56, H - 30, 56, H - 44);
            g.fillStyle(accent, 1);
            g.fillTriangle(56, H - 44, 64, H - 41, 56, H - 38);
            g.generateTexture(key, W, H);
            g.destroy();
        }
    }

    spawnUnit(team, type, gx, gy) {
        const typeData = UNIT_TYPES[type];
        const key = `units/${team}_${type}`;
        const { x, y } = this.groundPoint(gx, gy);
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
            moving: false, dead: false, withdrawn: false, flashUntil: 0, actionEpoch: 0,
            pressX: 0, pressY: 0,                        // 通行意图方向（推挤传导用，每帧由 moveToward 刷新）
            strafeX: 0, strafeY: 0, strafeUntil: 0,     // 微走位：绕目标换角度的目的地与截止时间
            // 镜像不变种子（惰性播种，见 units.js unitRand）：换边对照的红蓝配对单位拿到同一随机序列，
            // 配合走位角度按阵营取反，微走位在换边镜像局里行为严格对称，且重放确定。
            randSeed: null,
            nextShift: null,                            // 下次走位时刻（首次命中后按种子错峰惰性初始化）
            bobPhase: Math.random() * Math.PI * 2,
            lastSX: x, lastSY: gridToScreen(gx, gy).y, scene: this,
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
        this.morale.initUnit(unit);
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
                if (i === 3) {
                    this.battleStarted = true;
                    this.spawnZoneGfx.clear();
                    // 联机对战：倒计时结束铺底开跑。NetBattle 在部署后即由 UI 创建
                    // （先到的对端包才能被接住——倒计时偏差曾导致铺底包被丢、全场冻住）。
                    if (this.battleOptions.net && this.netClient) {
                        if (!this.net) {
                            this.net = new NetBattle(this, this.netClient, {
                                onDesync: turn => {
                                    if (typeof UI !== 'undefined' && UI.onNetDesync) UI.onNetDesync(turn);
                                }
                            });
                        }
                        this.net.start();
                    }
                    if (onDone) onDone();
                }
            });
            this.countdownTimers.push(timer);
        });
    }

    clearUnits(terrain = 'flat') {
        this.cancelCountdown();
        // 模拟数组可能已压实，仍在倒地动画中的单位必须一起清理。
        const visualUnits = new Set([...this.units, ...(this.dyingUnits || [])]);
        visualUnits.forEach(u => {
            this.tweens.killTweensOf(u.spr);
            this.tweens.killTweensOf(u.lunge);
            u.deathVisual = null;
            if (!u.withdrawn) { u.spr.destroy(); u.shadow.destroy(); }
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
        this.setTerrain(terrain);
        this.syncAnimTimeScale();
    }

    // ---------------- 战斗主循环 ----------------
    update(time, delta) {
        // FPS 统计（500ms 滚动窗口）
        this._fpsN++;
        if (time - this._fpsT >= 500) {
            const fps = Math.round(this._fpsN * 1000 / (time - this._fpsT));
            if (this.fpsHud) {
                this.fpsHud.textContent = fps + ' FPS · 存活 ' + (this.redAlive + this.blueAlive) +
                    (this.net ? ` · 停等${this.net.stalls} 缓存${this.net.peerLead}` : '');
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
        // 领土征服小地图（常驻屏幕空间；退出该模式即销毁）
        if (this.battleOptions.territory) this.updateTerritoryOverlay();
        else if (this._minimap) this.destroyMinimap();
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
        if (this.net) this.advanceNet(delta);
        else core.advanceBattle(this, delta);
    }

    // 锁步推进（联机）：命令收齐才走下一回合；缺包短暂停等。
    // 累积上限 250ms：停等期间不丢时间（旧实现钳到 16ms 会越等越慢），
    // 包恢复后每帧最多追 15 步平滑赶上，避免一次爆发式连跳。
    advanceNet(delta) {
        this.simulationAccumulator = Math.min(250,
            this.simulationAccumulator + Math.max(0, Math.min(delta, 50)) * this.gameSpeed);
        let catchUp = 3;    // 追帧限速：等包后平滑追回（上限 15 步/帧会形成快进式顿挫）
        while (this.simulationAccumulator + 1e-7 >= core.SIMULATION_STEP_MS && !this.battleOver) {
            if (!this.net.lockstep.canStep()) {
                this.net.noteStall();
                return;
            }
            const commands = this.net.lockstep.takeCommands();
            for (const command of commands) this.applyNetCommand(command);
            this.simulationAccumulator = Math.max(0, this.simulationAccumulator - core.SIMULATION_STEP_MS);
            this.simulationTime += core.SIMULATION_STEP_MS;
            this.stepBattle(core.SIMULATION_STEP_MS / 1000);
            this.net.onTurnDone();
            this.net.noteBuffer();
            if (--catchUp <= 0) return;    // 本帧追步额度用完，下帧继续
        }
    }

    // 网络命令注入：两端各自按到达回合确定性执行（买兵 / 营令）。
    // 不触碰 selectedBattalion——选中态是各端本地视图，不随对方命令漂移。
    applyNetCommand(command) {
        if (!command || !this.territory) return;
        if (command.k === 'buy') {
            this.territory.recruit.enqueue(command.side, command.type);
        } else if (command.k === 'order' && this.battalions) {
            const battalion = this.battalions.battalions.find(b => b.id === command.id && b.team === command.side);
            if (battalion && this.battalions.orderBattalion(battalion, command.flag)) {
                this.orderFlash(command.flag === 'home' ? '🏠 回防' : '⚑ 出发', battalion, '#f6cc68');
            }
        } else if (command.k === 'hold' && this.battalions) {
            const battalion = this.battalions.battalions.find(b => b.id === command.id && b.team === command.side);
            if (battalion && this.battalions.orderHold(battalion, command.gx, command.gy)) {
                this.orderFlash('📍 驻守', battalion, '#9de3af');
            }
        } else if (command.k === 'charge' && this.battalions) {
            const battalion = this.battalions.battalions.find(b => b.id === command.id && b.team === command.side);
            if (battalion && this.battalions.orderCharge(battalion, this.simulationTime)) {
                this.orderFlash('⚡ 冲锋！', battalion, '#ff8b6b');
            }
        } else if (command.k === 'rally') {
            this.territory.rally[command.side] = { gx: command.gx, gy: command.gy };
            const point = this.groundPoint(command.gx, command.gy);
            this.spawnOrderText('📍 集结点', point.x, point.y - 30, command.side === 'red' ? '#ffb0a0' : '#a8ceff');
        } else if (command.k === 'stance' && this.battalions) {
            const battalion = this.battalions.battalions.find(b => b.id === command.id && b.team === command.side);
            if (battalion && this.battalions.orderStance(battalion, command.stance)) {
                this.orderFlash(command.stance === 'aggressive' ? '🔥 好战' : '🛡 稳健', battalion, '#ffd76e');
            }
        } else if (command.k === 'clear' && this.battalions) {
            const battalion = this.battalions.battalions.find(b => b.id === command.id && b.team === command.side);
            if (battalion && this.battalions.orderClear(battalion)) {
                this.orderFlash('⭕ 解除命令', battalion, '#c8c8c8');
            }
        }
    }

    // 下令浮字（纯视觉，不入模拟/哈希）：营中心或指定点上浮短文字后淡出
    orderFlash(text, battalion, color) {
        const center = battalion.center();
        if (!center) return;
        const point = this.groundPoint(center.gx, center.gy);
        this.spawnOrderText(text, point.x, point.y - 40, color);
    }

    spawnOrderText(text, x, y, color) {
        if (!this.add?.text || !this.tweens?.add) return;   // 无渲染环境（测试）跳过
        const label = this.add.text(x, y, text, {
            fontFamily: '"PingFang SC", sans-serif', fontSize: '26px', fontStyle: 'bold',
            color, stroke: '#000000', strokeThickness: 5
        }).setOrigin(0.5).setDepth(160000);
        this.tweens.add({
            targets: label, y: y - 46, alpha: 0,
            duration: 1100, ease: 'Cubic.Out',
            onComplete: () => label.destroy()
        });
    }

    stepBattle(dt) {
        core.stepBattle(this, dt);
    }

    // 空间索引惰性单例：布防/inspection 阶段先于首帧 rebuildSpatial 也会被索敌调用
    get spatial() {
        if (!this._spatial) this._spatial = new BattleSpatialIndex();
        return this._spatial;
    }

    // ---------------- 空间哈希（实现在 js/battle/spatial.js，场景只做委托） ----------------
    rebuildSpatial() {
        const spatial = this.spatial;
        spatial.rebuild(this.units);
        // 兼容旧字段：harness/测试直接读 sgrid/_aliveArr/redAlive/centroid
        this.sgrid = spatial.grid;
        this._aliveArr = spatial.alive;
        this.redAlive = spatial.redAlive;
        this.blueAlive = spatial.blueAlive;
        this.centroid = spatial.centroid;
    }

    forEachNear(gx, gy, r, fn) {
        this.spatial.forEachNear(gx, gy, r, fn);
    }

    // 最近敌人：实现在 js/battle/targeting.js（纯函数，场景薄委托）
    nearestEnemy(unit) {
        return targeting.nearestEnemy(this.spatial, unit);
    }

    // 目标粘滞：换目标需要新目标显著更优（近 20%+）或当前目标倒下，消除等距敌人间的来回抖动。
    stickyTarget(unit) {
        return targeting.stickyTarget(this.spatial, unit);
    }

    // 遇骑结阵的探测器：读帧首冲锋视图快照（chargeView*），保证换座对称。
    incomingCharge(unit, radius) {
        return targeting.incomingCharge(this.spatial, unit, radius);
    }

    // 攻击时朝向实际目标，出手期间锁定画面朝向。
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
        } else if (unit.tacticalRole === 'guard' && target) {
            this.faceGuardSprite(unit, target.gx - unit.gx, target.gy - unit.gy);
        }
        unit.animState = 'attack';
        unit.animLock = this.simulationTime + 320;
        unit.faceAcc = 0;
        unit.dirDX = 0;
        unit.dirDY = 0;
        unit.spr.play(this.unitAnimKey(unit, 'attack'), true);
    }

    faceGuardSprite(unit, dx, dy) {
        // 步兵素材只有左右两面；按等距投影中的枪头方向翻面，近竖直方向保留原面避免闪烁。
        const length = Math.hypot(dx, dy);
        if (!length || Math.abs(dx - dy) / length < 0.12) return;
        unit.faceDir = dx - dy > 0 ? 1 : -1;
        unit.spr.setFlipX(unit.faceDir < 0);
        unit.faceAcc = 0;
    }

    unitAnimKey(unit, clip) {
        const profile = unit.type === 'cavalry' ? cavalryProfile(unit.visualDir) : null;
        const direction = profile ? CAVALRY_PROFILE_SUFFIX[profile] : '';
        return 'assets/units/anim/' + unit.team + '_' + unit.type + direction + '_' + clip;
    }

    updateNormalUnit(unit, now, dt, guardAnchor = null) {
        return unitAi.updateNormalUnit(this, unit, now, dt, guardAnchor);
    }


    // 碰撞排斥 + 推挤传导（空间哈希：每人只查身边一格内的邻居）
    // 排斥保证不重叠；传导让"有前进意图的一方"把对方顶向自己的方向——
    // 后排顶前排、局部打赢得势就往前拱，战线才会呼吸进退。
    separate(dt) {
        return battleUnits.separate(this, dt);
    }

    // ---------------- 箭矢（全场景合批到一张 Graphics） ----------------
    fireArrow(from, target) {
        const d = dist(from, target);
        const flightT = clamp(d / 12, 0.3, 0.75);
        // 预判提前量：瞄目标飞行期间的预估位置
        const lead = (v) => v ? clamp(v * flightT, -1.5, 1.5) : 0;
        const tx = clamp(target.gx + lead(target.velX), 0.5, board.W - 0.5);
        const ty = clamp(target.gy + lead(target.velY), 0.5, board.H - 0.5);
        this.arrows.push({
            sx: from.gx, sy: from.gy,
            tx, ty,
            sourceHeight: this.terrainHeight(from.gx, from.gy),
            targetHeight: this.terrainHeight(tx, ty),
            t: 0, dur: flightT,
            dmg: from.typeData.atk, team: from.team, source: from, firedAt: this.simulationTime
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
            // 端点高度插值加抛物线，不让飞行中的箭贴着途经山坡起伏。
            s.y -= ((a.sourceHeight || 0) * (1 - p) + (a.targetHeight || 0) * p) * Terrain.HEIGHT_SCALE;
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
                    if (u.team === a.team || u.dead || u.withdrawn) return;
                    const d = Math.hypot(u.gx - a.tx, u.gy - a.ty);
                    if (d < hd - 1e-9 || (hit && Math.abs(d - hd) <= 1e-9 && u.id < hit.id)) { hd = d; hit = u; }
                });
                if (hit) {
                    resolveAttack(hit, a.source, { rawAttack: a.dmg, attackStartedAt: a.firedAt,
                        sourceHeight: a.sourceHeight });
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
        const sA = this.groundPoint(attacker.gx, attacker.gy);
        const s = this.groundPoint(target.gx, target.gy);
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
        if (this.bloods.length >= 72) return;  // 保留并发上限，增加单次喷溅的饱满度
        const kk = Math.max(0.5, k);
        const parts = [];
        const count = Math.ceil(n * 1.4);
        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            const sp = power * (0.45 + Math.random() * 0.75) * kk;
            parts.push({
                x: 0, y: 0,
                vx: Math.cos(a) * sp,
                vy: -Math.abs(Math.sin(a)) * sp * 0.85 - 26 * kk,
                s: (2.3 + Math.random() * 3.1) * kk,        // 像素方块边长
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
            const x = q[i], y = q[i + 1], s = q[i + 2] * 1.2;
            st.fillStyle(0x6e0f0f, 0.9);
            st.fillRect(x - s / 2, y - s * 0.3, s, s * 0.55);
            st.fillStyle(0x951919, 0.85);
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
        st.fillEllipse(0, 0, s, s * 0.62);
        st.fillEllipse(-s * 0.32, s * 0.08, s * 0.55, s * 0.36);
        st.fillEllipse(s * 0.3, -s * 0.06, s * 0.5, s * 0.34);
        st.fillStyle(0x7d1212, 0.85);
        st.fillEllipse(0, 0, s * 0.82, s * 0.46);
        st.fillStyle(0x991b1b, 0.85);
        st.fillEllipse(s * 0.04, s * 0.02, s * 0.5, s * 0.26);
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
            const s = this.groundPoint(unit.gx, unit.gy);
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
        const s = this.groundPoint(unit.gx, unit.gy);
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
            const x = death.x + death.slideX * drift;
            const slideGX = (death.slideX / TW + death.slideY / TH) * drift;
            const slideGY = (death.slideY / TH - death.slideX / TW) * drift;
            const heightDelta = this.terrainHeight(unit.gx + slideGX, unit.gy + slideGY) - this.terrainHeight(unit.gx, unit.gy);
            const y = death.y + death.slideY * drift - heightDelta * Terrain.HEIGHT_SCALE;
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
            this.addBloodPool(x, y, 21 * dk);
            if (!fading) this.stampCorpse(unit);
            unit.spr.destroy(); unit.shadow.destroy();
            unit.deathVisual = null;
            this.dyingUnits.delete(unit);
        }
    }

    // ---------------- 渲染同步 ----------------
    syncRender(time) {
        this.drawTactics();
        this.drawFlags();
        this.drawConvoy();
        this.unitInspector?.update();
        this.hpGfx.clear();
        const view = this._view;   // 战斗中每帧更新；部署阶段为空 = 全量同步
        const units = this.units;
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            if (u.dead || u.withdrawn) continue;
            this.syncOne(u, time, view);
        }
    }

    syncOne(unit, time, view) {
        if (unit.dead || unit.withdrawn) return;
        const { x, y } = this.groundPoint(unit.gx, unit.gy);
        // 朝向仍依据地面平面位移，爬坡的视觉抬升不能把马误转成朝北。
        const planar = gridToScreen(unit.gx, unit.gy);

        const prevX = unit.lastSX === undefined ? planar.x : unit.lastSX;
        const prevY = unit.lastSY === undefined ? planar.y : unit.lastSY;
        const sdx = planar.x - prevX, sdy = planar.y - prevY;

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
            unit.lastSX = planar.x; unit.lastSY = planar.y;
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
        // 辎重车是运行时生成的单帧贴图，无行走/攻击动画可切，跳过状态机
        if (unit.type !== 'wagon' && unit.animState !== 'attack') {
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
            if (unit.moraleState === 'wavering' && unit.moraleFallBackUntil > this.simulationTime) {
                this.faceGuardSprite(unit, unit.retreatFacingX ?? unit.moraleFacingX, unit.retreatFacingY ?? unit.moraleFacingY);
            } else if (unit.moraleState === 'routing' && this.simulationTime - (unit.routStartedAt ?? -Infinity) < 900) {
                this.faceGuardSprite(unit, unit.moraleFacingX, unit.moraleFacingY);
            } else if (unit.tacticalRole === 'guard' && unit.moraleState !== 'routing') {
                this.faceGuardSprite(unit, unit.guardFacingX, unit.guardFacingY);
            } else {
                unit.faceAcc += sdx;
                if (unit.faceAcc > 2)       { unit.spr.setFlipX(false); unit.faceDir = 1;  unit.faceAcc = 0; }
                else if (unit.faceAcc < -2) { unit.spr.setFlipX(true);  unit.faceDir = -1; unit.faceAcc = 0; }
                else if (Math.abs(unit.faceAcc) > 60) unit.faceAcc = 0;
            }
        }
        unit.lastSX = planar.x; unit.lastSY = planar.y;

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
        else if (unit.moraleBoostUntil > this.simulationTime) unit.spr.setTint(0xffe9a9);
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
        // 颜色和形状一起区分脱离、恢复与返场，所有进度跟随模拟时钟。
        const recovering = unit.moraleState === 'routing' && unit.moralePhase === 'recovering';
        const forming = unit.rallyWaiting && unit.moraleState !== 'routing';
        const fallingBack = unit.moraleState === 'wavering' && unit.moraleFallBackUntil > this.simulationTime;
        const returning = unit.moralePhase === 'returning' && unit.moraleState !== 'routing' && !fallingBack;
        if (unit.moraleState === 'wavering' || unit.moraleState === 'routing' || forming || returning) {
            const routing = unit.moraleState === 'routing';
            const width = Math.max(12, 28 * (unit.sizeK || 1));
            const my = y + unit.footDy - unit.spr.displayHeight * 0.82 - 13;
            this.hpGfx.fillStyle(0x201b15, 0.9);
            this.hpGfx.fillRect(x - width / 2 - 1, my - 1, width + 2, 5);
            const color = recovering || forming ? 0x72e0ad : returning ? 0x8cdaff : routing ? 0xff864f : 0xffce62;
            const progress = recovering ? unit.moraleRecoveryProgress || 0 : forming || returning ? 1 : unit.morale / 100;
            this.hpGfx.fillStyle(color, 1);
            this.hpGfx.fillRect(x - width / 2, my, width * Math.max(0.08, progress), 3);
            if (recovering || forming) {
                this.hpGfx.lineStyle(2, color, 1);
                this.hpGfx.lineBetween(x - 3, my - 9, x - 3, my - 4);
                this.hpGfx.lineBetween(x + 3, my - 9, x + 3, my - 4);
            } else if (returning) {
                this.hpGfx.lineStyle(2, color, 1);
                this.hpGfx.lineBetween(x - 4, my - 5, x, my - 9);
                this.hpGfx.lineBetween(x, my - 9, x + 4, my - 5);
            } else if (routing) {
                this.hpGfx.lineStyle(2, 0xff864f, 1);
                this.hpGfx.lineBetween(x - 3, my - 7, x - 6, my - 3);
                this.hpGfx.lineBetween(x + 3, my - 7, x, my - 3);
            }
        }
    }

    // ---------------- 占点征服 ----------------
    // 英雄连式兵力拔河：圈内双方单位的占领力互相抵消，净差拉进度条——
    // 人多的一方能从对方手里硬拔，兵力相当才是真僵持。占领力按兵种不同
    // （×10 取整做计数：求和顺序无关、零浮点噪声，换座镜像天然同步）。
    // progress ∈ [-1,+1]：+1 红完全占领、-1 蓝完全占领、0 中立；归属只在
    // 拉满端点时获得，被拉过中线才失去（防守惯性，同英雄连的中立化两段）；
    // 单位离开进度保持不清零。每面归属旗每秒 +1 分，先到 60 分胜。
    updateFlags(dt) {
        const RADIUS = 2.8, RATE = 0.1 / 10;           // 净占领力 10（约一队剑士）10 秒拉满
        const POWER = { infantry: 10, pikeman: 7, archer: 4, cavalry: 12 };
        for (const flag of this.flags) {
            let red = 0, blue = 0;
            this.forEachNear(flag.gx, flag.gy, RADIUS, u => {
                if (u.dead || u.withdrawn || u.moraleState === 'routing') return;
                if (Math.hypot(u.gx - flag.gx, u.gy - flag.gy) > RADIUS) return;
                if (u.team === 'red') red += POWER[u.type] ?? 5; else blue += POWER[u.type] ?? 5;
            });
            flag.contested = red > 0 && blue > 0;
            const net = red - blue;                     // 正=红方向拉，负=蓝方向拉
            if (net !== 0) flag.progress = Math.max(-1, Math.min(1, flag.progress + net * RATE * dt));
            const had = flag.owner;
            if (flag.progress >= 1) flag.owner = 'red';
            else if (flag.progress <= -1) flag.owner = 'blue';
            else if (had === 'red' && flag.progress < 0) flag.owner = null;   // 被拉过中线：失去归属
            else if (had === 'blue' && flag.progress > 0) flag.owner = null;
            if (flag.owner !== had) flag.pulseAt = this.simulationTime;       // 归属变化：扩散脉冲
            if (flag.owner !== had && flag.owner != null) {
                this.addBattleEvent(`flag-${flag.name}-${flag.owner}-${Math.floor(this.simulationTime)}`,
                    `${flag.owner === 'red' ? '红方' : '蓝方'}占领了${flag.name}旗帜`, flag.owner);
                this._countsDirty = true;
            }
        }
        for (const team of ['red', 'blue']) {
            this.controlScore[team] += dt * this.flags.filter(f => f.owner === team).length;
        }
    }

    // ---------------- 领土征服 ----------------
    // 每步推进：旗帜拔河（复用 updateFlags）→ 军费收入 → 征兵出兵 → 营队维护/AI → 战略 AI 采购 → 票数流失。
    updateTerritory(dt) {
        this.updateFlags(dt);
        const owned = { red: 0, blue: 0 };
        for (const flag of this.flags) if (flag.owner) owned[flag.owner]++;
        const state = this.territory;
        state.econ.tick(dt, owned);
        state.recruit.update();
        this.battalions.update(this.simulationTime);
        for (const team of ['red', 'blue']) {
            if (state.autoBuy[team]) state.ai[team].update(this.simulationTime);
        }
        const before = { red: state.tickets.tickets.red, blue: state.tickets.tickets.blue };
        state.tickets.tick(dt, owned);
        for (const team of ['red', 'blue']) {
            if (before[team] > TERRITORY.TICKETS / 2 && state.tickets.tickets[team] <= TERRITORY.TICKETS / 2) {
                this.addBattleEvent(`tickets-half-${team}`,
                    `${team === 'red' ? '红方' : '蓝方'}票数已流失过半，领土告急`, team);
            }
        }
    }

    aliveCount(team, type) {
        let count = 0;
        for (const unit of this._aliveArr) {
            if (unit.team === team && (!type || unit.type === type)) count++;
        }
        return count;
    }

    spotFree(x, y) {
        let free = true;
        this.forEachNear(x, y, 0.62, u => {
            if (!u.dead && !u.withdrawn && Math.hypot(u.gx - x, u.gy - y) < 0.62) free = false;
        });
        return free;
    }

    // 老家出兵：在己方出兵线（红 x≈5.5 / 蓝 x≈W-5.5）附近按确定性螺旋序列找空位，
    // 找到的第一格即为落点（不掷随机数，换座镜像/锁步重放一致）。
    spawnTerritoryUnit(team, type) {
        const cx = team === 'red' ? 5.5 : board.W - 5.5;
        const cy = board.H / 2;
        let gx = cx + (team === 'red' ? 1 : -1), gy = cy;
        outer:
        for (let ring = 0; ring < 8; ring++) {
            const radius = ring * 1.1;
            for (let i = 0; i < 10; i++) {
                const angle = i / 10 * Math.PI * 2 + (ring % 2) * Math.PI / 10;
                const x = Math.round((cx + Math.cos(angle) * radius) * 8) / 8;
                const y = Math.round((cy + Math.sin(angle) * radius * 0.8) * 8) / 8;
                if (x < 1.5 || x > board.W - 1.5 || y < 1.5 || y > board.H - 1.5) continue;
                if (this.spotFree(x, y)) { gx = x; gy = y; break outer; }
            }
        }
        const unit = this.spawnUnit(team, type, gx, gy);
        if (this.battalions) this.battalions.assignReinforcement(unit);
        return unit;
    }

    // 营队系统棋盘钩子（battle/battalion.js 经此读当前尺寸，不直接 import game.js）
    board_W() { return board.W; }
    board_H() { return board.H; }

    // 等距投影原点（UI 层逆变换用；随画外余量移动）
    worldOrigin() { return { ox: OX, oy: OY, tw: TW, th: TH }; }

    // 点兵选营：观察层（UnitInspector）点击士兵时联动选中整营；点空地清除。
    selectBattalionByUnit(unit) {
        if (!this.battleOptions.territory) { this.selectedBattalion = null; return; }
        this.selectedBattalion = unit && !unit.dead && !unit.withdrawn ? (unit.battalion || null) : null;
    }

    // 玩家下令：flagIndex 为旗序号，'home' 为回防集结，null 为取消选择。
    orderSelectedBattalion(flagIndex) {
        if (!this.battalions) return false;
        return this.battalions.orderSelected(flagIndex, this);
    }

    // 营队接管骑兵（仅领土征服）：集结跟集结点、回防跟老家、有令跟旗——骑兵与
    // 全营同目标行军，不再单骑冲阵，也不再来回"冲锋出去-缰绳拉回"造成贴图闪烁。
    // 贴脸有敌（≤6格）时交还冲锋状态机就近作战；守已占旗时贴旗游弋待命。
    battalionDirectCavalry(unit) {
        if (!this.battleOptions.territory || !this.battalions) return null;
        const battalion = unit.battalion;
        if (!battalion) return null;
        // 冲锋窗口：该营骑兵全部交还冲锋状态机自由出击（窗口结束自动归队护送）
        if (this.simulationTime < battalion.chargeUntil) return null;
        let target = null;
        if (battalion.gathering) target = battalion.gatherPoint;
        else if (battalion.retreat) target = this.battalions.homeRally(unit.team);
        else if (battalion.orderPoint) {
            target = battalion.orderPoint;
        }
        else if (battalion.orderFlag != null && this.flags[battalion.orderFlag]) {
            const flag = this.flags[battalion.orderFlag];
            if (Math.hypot(flag.gx - unit.gx, flag.gy - unit.gy) <= 4.5) {
                // 旗已在手：贴旗待命（按 id 定角度散开，确定性且不抖动）
                const angle = (unit.id % 12) / 12 * Math.PI * 2;
                return { gx: flag.gx + Math.cos(angle) * 2.2, gy: flag.gy + Math.sin(angle) * 1.6 };
            }
            // 护送点：营心→旗连线上、营心前方约 8 格——单一目标随大队同向推进，
            // 骑兵追上就缓行等队。旧版"超前就折回营心"会在阈值边界 180° 来回
            // 折返（方向反复翻转=不同贴图快速闪），同向护送点从根上消除折返。
            const center = battalion.center();
            if (center) {
                const dx = flag.gx - center.gx, dy = flag.gy - center.gy;
                const len = Math.hypot(dx, dy) || 1;
                const lead = Math.min(8, len * 0.6);
                target = { gx: center.gx + dx / len * lead, gy: center.gy + dy / len * lead };
            } else target = flag;
        } else return null;    // 无令无集结：自由作战
        let enemyNear = false;
        this.forEachNear(unit.gx, unit.gy, 6, u => {
            if (u.team !== unit.team && !u.dead && !u.withdrawn && u.moraleState !== 'routing' &&
                Math.hypot(u.gx - unit.gx, u.gy - unit.gy) <= 6) enemyNear = true;
        });
        return enemyNear ? null : target;
    }

    // ---------------- 领土小地图（屏幕空间，点击/拖动直接跳镜头） ----------------
    buildMinimap() {
        const cam = this.cameras.main;
        const h = 108, w = Math.round(h * board.W / board.H);
        const x = cam.width - w - 14, y = 74;
        const gfx = this.add.graphics().setScrollFactor(0).setDepth(150010);
        const zone = this.add.rectangle(x + w / 2, y + h / 2, w, h, 0x000000, 0.01)
            .setOrigin(0.5).setScrollFactor(0).setInteractive();
        const jump = pointer => {
            const gx = clamp((pointer.x - x) / w * board.W, 0, board.W);
            const gy = clamp((pointer.y - y) / h * board.H, 0, board.H);
            const world = gridToScreen(gx, gy);
            cam.centerOn(world.x, world.y);
        };
        zone.on('pointerdown', jump);
        zone.on('pointermove', pointer => { if (pointer.isDown) jump(pointer); });
        this._minimap = { gfx, zone, x, y, w, h };
    }

    destroyMinimap() {
        if (!this._minimap) return;
        this._minimap.gfx.destroy();
        this._minimap.zone.destroy();
        this._minimap = null;
    }

    updateTerritoryOverlay() {
        if (!this._minimap) this.buildMinimap();
        const now = this.time?.now || this.simulationTime;
        if (now - (this._minimapAt || 0) < 120) return;
        this._minimapAt = now;
        const { gfx: g, x, y, w, h } = this._minimap;
        const RED = 0xff5b5b, BLUE = 0x57a0ff, NEUTRAL = 0xd8d2c0;
        g.clear();
        // 底板与边框
        g.fillStyle(0x10202e, 0.82);
        g.fillRect(x - 4, y - 4, w + 8, h + 8);
        g.lineStyle(2, 0x2f4a5e, 0.95);
        g.strokeRect(x - 4, y - 4, w + 8, h + 8);
        // 双方出兵线提示带
        g.fillStyle(0xff5555, 0.10);
        g.fillRect(x, y, w * (12 / board.W), h);
        g.fillStyle(0x5599ff, 0.10);
        g.fillRect(x + w * (1 - 12 / board.W), y, w * (12 / board.W), h);
        // 单位点（超采样抽稀，保持小地图常 60fps）
        const step = this._aliveArr.length > 700 ? 2 : 1;
        for (let i = 0; i < this._aliveArr.length; i += step) {
            const u = this._aliveArr[i];
            g.fillStyle(u.team === 'red' ? RED : BLUE, 0.9);
            g.fillRect(x + u.gx / board.W * w - 0.8, y + u.gy / board.H * h - 0.8, 1.8, 1.8);
        }
        // 旗帜（争夺时呼吸闪烁）
        for (const flag of this.flags) {
            const color = flag.owner === 'red' ? RED : flag.owner === 'blue' ? BLUE : NEUTRAL;
            const fx = x + flag.gx / board.W * w, fy = y + flag.gy / board.H * h;
            g.fillStyle(color, flag.contested ? 0.6 + 0.4 * Math.sin(this.simulationTime * 0.02) : 1);
            g.fillCircle(fx, fy, 2.6);
            g.lineStyle(1, 0x0c141c, 0.8);
            g.strokeCircle(fx, fy, 2.6);
        }
        // 镜头视口（世界四角逆投影成网格四边形）
        const v = this.cameras.main.worldView;
        const inv = (sx, sy) => {
            const dx = (sx - OX) / (TW / 2), dy = (sy - OY) / (TH / 2);
            return { gx: (dx + dy) / 2, gy: (dy - dx) / 2 };
        };
        const corners = [inv(v.x, v.y), inv(v.right, v.y), inv(v.right, v.bottom), inv(v.x, v.bottom)];
        g.lineStyle(1.5, 0xf6e6b0, 0.9);
        g.beginPath();
        corners.forEach((c, i) => {
            const px = x + c.gx / board.W * w, py = y + c.gy / board.H * h;
            if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
        });
        g.closePath();
        g.strokePath();

        // 己方集结旗标记（敌方集结点属情报，不绘制）
        const myRally = this.territory.rally[this.netMySide || 'red'];
        if (myRally) {
            const base = this.groundPoint(myRally.gx, myRally.gy);
            const pulse = 0.7 + 0.3 * Math.sin(this.simulationTime * 0.004);
            g.fillStyle(0x1c1812, 0.8);
            g.fillEllipse(base.x, base.y + 2, 14, 7);
            g.lineStyle(3, 0x3a2f1b, 0.95);
            g.lineBetween(base.x, base.y, base.x, base.y - 38);
            g.fillStyle(this.netMySide === 'blue' ? 0x57a0ff : 0xff5b5b, pulse);
            g.fillTriangle(base.x, base.y - 38, base.x + 22, base.y - 31, base.x, base.y - 24);
        }
        // 营队选中态：成员金圈 + 营令指向线（世界空间层，随镜头缩放）
        if (!this.selectionGfx) this.selectionGfx = this.add.graphics().setDepth(12050);
        const sel = this.selectionGfx;
        sel.clear();
        const selected = this.selectedBattalion;
        if (selected && selected.members.length) {
            sel.lineStyle(2.5, 0xffe49a, 0.95);
            for (const u of selected.aliveMembers()) {
                const p = this.groundPoint(u.gx, u.gy);
                sel.strokeEllipse(p.x, p.y, 30, 15);
            }
            const center = selected.center();
            if (center) {
                const from = this.groundPoint(center.gx, center.gy);
                let toPoint = null, color = 0xffe49a;
                if (selected.retreat) { toPoint = this.battalions.homeRally(selected.team); color = 0x8cdaff; }
                else if (selected.orderPoint) { toPoint = selected.orderPoint; color = 0x9de3af; }
                else if (selected.orderFlag != null && this.flags[selected.orderFlag]) {
                    toPoint = this.flags[selected.orderFlag]; color = 0xf6cc68;
                }
                if (toPoint) {
                    const to = this.groundPoint(toPoint.gx, toPoint.gy);
                    sel.lineStyle(3, color, 0.8);
                    sel.lineBetween(from.x, from.y, to.x, to.y);
                    sel.strokeCircle(to.x, to.y, 6);
                }
            }
        }
    }

    drawFlags() {
        if (!this.flags) return;
        if (!this.flagGfx) this.flagGfx = this.add.graphics().setDepth(11990);
        const g = this.flagGfx;
        g.clear();
        const t = this.simulationTime;
        for (const flag of this.flags) {
            const base = this.groundPoint(flag.gx, flag.gy);
            const RED = 0xff5b5b, BLUE = 0x57a0ff, NEUTRAL = 0xd8d2c0;
            const targetColor = flag.owner === 'red' ? RED : flag.owner === 'blue' ? BLUE : NEUTRAL;
            // 旗面显示色向目标色平滑过渡（归属切换不再是瞬变）
            if (flag.displayColor == null) flag.displayColor = targetColor;
            flag.displayColor = lerpColor(flag.displayColor, targetColor, 0.10);
            const color = flag.displayColor;

            // ---- 地面争夺圈：等距椭圆（groundPoint 采样），归属染色，争夺时呼吸 ----
            const breathe = flag.contested ? 0.5 + 0.5 * Math.sin(t * 5) : 0;
            const ringPts = sampleGroundRing(this, flag.gx, flag.gy, 2.8, 26);
            g.fillStyle(color, flag.contested ? 0.10 + 0.08 * breathe : 0.13);
            g.fillPoints(ringPts, true);
            g.lineStyle(2, color, flag.contested ? 0.5 + 0.35 * breathe : 0.45);
            g.strokePoints(ringPts, true, true);

            // ---- 占领/易主的扩散脉冲（1.2 秒）----
            if (flag.pulseAt != null && t - flag.pulseAt < 1.2) {
                const k = (t - flag.pulseAt) / 1.2;
                const pulsePts = sampleGroundRing(this, flag.gx, flag.gy, 2.8 + k * 5, 26);
                g.lineStyle(4, color, 0.75 * (1 - k));
                g.strokePoints(pulsePts, true, true);
            }

            // ---- 旗杆底座 + 加高旗杆 + 杆顶色球 ----
            const POLE = 46;
            g.fillStyle(0x2c2418, 0.85);
            g.fillEllipse(base.x, base.y + 2, 15, 7);
            g.lineStyle(3, 0x3a2f1b, 0.95);
            g.lineBetween(base.x, base.y, base.x, base.y - POLE);
            g.fillStyle(color, 0.95);
            g.fillCircle(base.x, base.y - POLE - 3, 3.5);

            // ---- 旗面（加大）：波浪飘动 + 争夺高频抖动 + 描边 ----
            const wave = Math.sin(t * 3 + flag.gy) * 3;
            const jitter = flag.contested ? Math.sin(t * 22) * 1.6 : 0;
            const tipX = base.x + 27 + wave + jitter;
            const tipY = base.y - POLE - 1 + Math.sin(t * 3 + flag.gy + 1) * 1.2;
            const tailY = base.y - POLE + 18 + wave * 0.3;
            g.fillStyle(color, flag.contested ? 0.75 + 0.2 * breathe : 0.95);
            g.fillTriangle(base.x, base.y - POLE, tipX, tipY, base.x, tailY);
            g.lineStyle(2, 0x1c1812, 0.35);
            g.strokeTriangle(base.x, base.y - POLE, tipX, tipY, base.x, tailY);

            // ---- 拔河进度环（杆底，方向着色：红环向红涨、蓝环向蓝涨）----
            if (flag.progress > 0) {
                g.lineStyle(4, RED, 0.95);
                g.beginPath();
                g.arc(base.x, base.y, 11, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * flag.progress);
                g.strokePath();
            } else if (flag.progress < 0) {
                g.lineStyle(4, BLUE, 0.95);
                g.beginPath();
                g.arc(base.x, base.y, 11, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * -flag.progress);
                g.strokePath();
            }
        }
    }

    // ---------------- 护送模式 ----------------
    // 到站/劫持计数与事件；车本体的"有保护才前进"在 updateNormalUnit 的 wagon 特判里。
    updateConvoy(dt) {
        return battleConvoy.updateConvoy(this, dt);
    }

    convoyOutcome() {
        return battleConvoy.convoyOutcome(this);
    }

    drawConvoy() {
        if (!this.convoy) return;
        if (!this.convoyGfx) this.convoyGfx = this.add.graphics().setDepth(11980);
        const g = this.convoyGfx;
        g.clear();
        const c = this.convoy;
        // 路线虚线：出发区沿中线到安全区
        const from = this.groundPoint(9, board.H / 2), to = this.groundPoint(c.goalX + 1.5, board.H / 2);
        g.lineStyle(2.5, 0xf6e6b0, 0.35);
        for (let i = 0; i < 24; i++) {
            const a = i / 24, b = (i + 0.55) / 24;
            g.lineBetween(from.x + (to.x - from.x) * a, from.y + (to.y - from.y) * a,
                from.x + (to.x - from.x) * b, from.y + (to.y - from.y) * b);
        }
        // 终点安全区：绿色半透椭圆 + 框
        const zone = sampleGroundRing(this, c.goalX + 1.5, board.H / 2, 4.5, 26);
        g.fillStyle(0x6fdc7f, 0.14);
        g.fillPoints(zone, true);
        g.lineStyle(2.5, 0x6fdc7f, 0.65);
        g.strokePoints(zone, true, true);
        // 劫持进度环：蓝方占住车身时在车底拉起（拉满即被劫走）
        for (const wagon of c.wagons) {
            if (wagon.withdrawn || wagon.dead || !(wagon.hijack > 0.02)) continue;
            const base = this.groundPoint(wagon.gx, wagon.gy);
            const ring = sampleGroundRing(this, wagon.gx, wagon.gy, 2.3, 22);
            g.lineStyle(3.5, 0x57a0ff, 0.9);
            g.beginPath();
            g.arc(base.x, base.y + 4, 14 * 0.62, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * wagon.hijack);
            g.strokePath();
            g.lineStyle(1.5, 0xffffff, 0.25);
            g.strokePoints(ring, true, true);
        }
    }

    // ---------------- 胜负 ----------------
    checkWin() {
        return battleWin.checkWin(this);
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
