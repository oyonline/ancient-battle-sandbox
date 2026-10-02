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
import { CampSystem } from './battle/camps.js';
import { HealingSystem } from './battle/healing.js';
import { SiteTraitState } from './battle/site-traits.js';
import { CAMP_COMMANDS, applyCampCommand } from './battle/camp-commands.js';
import { BattalionSystem, BATTALION } from './battle/battalion.js';
import * as unitAi from './battle/unit-ai.js';
import * as battleUnits from './battle/separate.js';
import * as battleConvoy from './battle/convoy.js';
import * as battleWin from './battle/win.js';
import { NetBattle } from './net/lockstep.js';
import * as moraleBridge from './battle/morale-bridge.js';
import * as territoryBridge from './battle/territory-bridge.js';
import { BattleRenderer } from './render/renderer.js';
import { ScarLayer } from './render/scars.js';
import { FrameStats } from './frame-stats.js';
import { TW, TH, OX, OY, VIEW_W, VIEW_H, refreshWorldMetrics, gridToScreen, sampleGroundRing, lerpColor } from './render/metrics.js';
import { ANIM_ALIGN_K, CAVALRY_PROFILE_SUFFIX, CAVALRY_FLIPPED, cavalryProfile, cavalryRenderSign, cavalryHeadingFromMotion, footProfile, animAlignProfile, shadowTextureKey } from './render/sprites.js';


// 空间哈希单元格移至 js/battle/spatial.js（SP_CELL = 3）
// 战斗核（定步长/编排/动作队列/迎击队列）移至 js/battle/core.js（SIMULATION_STEP_MS = 1000/60）


export class IsoBattleScene extends Phaser.Scene {
    constructor() {
        super({ key: 'IsoBattleScene' });
        this.render = new BattleRenderer(this);
    }

    preload() {
        Object.values(MANIFEST.units).forEach(u =>
            this.load.image(u.file.replace('.png', ''), 'assets/' + u.file));
        Object.values(MANIFEST.props).forEach(p =>
            this.load.image(p.file.replace('.png', ''), 'assets/' + p.file));
        Object.values(MANIFEST.terrain).forEach(p =>
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

        this.render.world.createOceanBackdrop();   // 全屏海面：填满菱形外的屏幕四角
        this.render.world.drawGround();
        this.render.world.placeDecorations();
        this.render.world.scheduleBirds();         // 偶有飞鸟掠过
        this.spawnZoneGfx = this.add.graphics();
        this.render.world.drawSpawnZones();

        this.groundFX = this.add.container(0, 0).setDepth(10);
        this.unitLayer = this.add.container(0, 0).setDepth(1000);
        this.airFX = this.add.container(0, 0).setDepth(100000);

        // 战场留痕层：血渍与尸体增量盖印进一张全图纹理，整场只占 1 次绘制
        this.scarRT = new ScarLayer(this);

        this.render.units.buildUnitAnims();
        this.render.world.makeShadowTextures();    // 阴影预烘焙成贴图（千人合批，见 syncOne）

        // 共享绘制层：血条 / 箭矢 / 血粒子 各一张 Graphics，全场景合批
        this.hpGfx = this.add.graphics().setDepth(40000);
        this.arrowGfx = this.add.graphics();
        this.airFX.add(this.arrowGfx);
        this.bloodGfx = this.add.graphics();
        this.airFX.add(this.bloodGfx);

        this.render.camera.setupCamera();
        if (typeof UnitInspector !== 'undefined') this.unitInspector = new UnitInspector(this);

        // FPS 放在顶栏下方的 DOM 层，不受战场镜头的缩放和平移影响。
        this.fpsHud = document.getElementById('performance-hud');
        this._fpsN = 0; this._fpsT = 0;
        this.performanceStats = new FrameStats();

        if (typeof UI !== 'undefined' && UI.onSceneReady) UI.onSceneReady(this);
    }

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

    setTerrain(key) {
        this.battleOptions.terrain = Terrain.normalize(key);
        this.navigation?.reset(this.battleOptions.terrain, this.battleId);
        // 只有已创建的真实画布需要重烘焙；无绘图的战斗测试仍用同一高度数据。
        if ((this.groundImage || this.terrainLoading) && this._groundTerrain !== this.battleOptions.terrain) this.render.world.drawGround();
    }

    // 棋盘尺寸变更（进入/退出领土征服大地图）：重算世界度量并重建依赖尺寸的渲染层。
    // 无真实画布的战斗测试（无 groundImage/scarRT）只刷新度量，跳过重建。
    applyBoardSize() {
        refreshWorldMetrics();
        this._boardW = board.W;
        this._boardH = board.H;
        this.mapCenter = { x: VIEW_W / 2, y: OY + (board.W + board.H) * TH / 4 };
        if (this.groundImage || this.terrainLoading) this.render.world.drawGround(); // 也取消尚未生成首块的旧地图任务
        if (this.edgeProps?.length) {                            // 大本营箭塔/边缘树林按新尺寸重摆
            for (const { sprite } of this.edgeProps) {
                this.tweens.killTweensOf(sprite);
                sprite.destroy();
            }
            this.edgeProps = [];
            this.render.world.placeDecorations();
        }
        if (this.scarRT && this.add?.renderTexture) {            // 战场留痕层按新尺寸重建
            this.scarRT.destroy();
            this.scarRT = new ScarLayer(this);
        }
        if (this._minimap) { this._minimap.gfx.destroy(); this._minimap.zone.destroy(); this._minimap = null; }
        if (this.ocean) this.render.world.redrawOcean();
    }

    ensureNavigation() {
        if (!this.navigation) this.navigation = new TerrainNavigation(this);
        if (this.navigation.key !== this.battleOptions.terrain || this.navigation.battleId !== this.battleId)
            this.navigation.reset(this.battleOptions.terrain, this.battleId);
        return this.navigation;
    }


    resetBattleData() {
        this.unitInspector?.reset();
        this.render.camps?.reset();
        if (typeof UI !== 'undefined') UI.campControls?.reset();
        this.tactics = null;
        this.battleOptions = { deathmatch: false, control: false, convoy: false, territory: false,
            reserves: { red: 0, blue: 0 }, terrain: 'flat',
            cavalryOrders: { red: 'auto', blue: 'auto' } };
        this.territory = null;
        this.battalions = null;
        this.selectedBattalion = null;
        this.siteTraits = null;      // 据点特色派生缓存（每次部署重建，避免跨局残留）
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
        this.pendingCountdown = null;
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
        if (this._boardW !== board.W || this._boardH !== board.H) {
            // Bake the destination terrain once, rather than a huge temporary flat map.
            this.battleOptions.terrain = Terrain.normalize(options.terrain);
            this.applyBoardSize();
        }
        this.clearUnits(options.terrain);
        this.render.world.drawSpawnZones();
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
        // 领土征服运行态：经济 / 征兵队列 / 票数 / 建造与驻守 / 战略 AI。
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
        if (this.territory) {
            for (const [team, cfg] of armies) {
                const count = Math.min(12, Math.max(0, Math.floor(cfg.worker || 0)));
                for (let i = 0; i < count; i++) {
                    this.spawnUnit(team, 'worker', team === 'red' ? 9.5 : board.W - 9.5,
                        board.H / 2 + (i - (count - 1) / 2) * 1.2);
                }
            }
            this.territory.camps = new CampSystem(this);
            this.territory.healing = new HealingSystem(this);
            this.siteTraits = new SiteTraitState(this);   // 开局归属 → 派生状态（此后按归属变化刷新）
            this.siteTraits.refresh();
            this.rebuildSpatial();
        }
        // 营队系统（仅领土征服）：开局常备军按纵向三等分为上/中/下营
        this.battalions = this.battleOptions.territory ? new BattalionSystem(this) : null;
        this.selectedBattalion = null;
        if (this.battalions) this.battalions.splitOpening(this.units);
        this.render.camps?.update();
        // 护送模式：红方 4 辆辎重车从出发区沿中线穿越战场，送抵 3 辆红胜、
        // 被毁 3 辆蓝胜；车附近有护送部队才前进（无保护停下等待）。
        this.convoy = null;
        if (this.battleOptions.convoy) {
            this.render.world.ensureWagonTextures();
            const wagons = [[13, board.H / 2 - 3], [12, board.H / 2], [13, board.H / 2 + 3], [10.5, board.H / 2]]
                .map(([x, y]) => {
                    const wagon = this.spawnUnit('red', 'wagon', x, y);
                    wagon.tacticalRole = 'convoy_wagon';
                    return wagon;
                });
            this.convoy = { team: 'red', goalX: board.W - 6, wagons, need: 3, delivered: 0, destroyed: 0 };
        }
        if (this.cameras.main.setZoom) this.render.camera.fitCamera();
    }

    getTacticsSummary() { return this.tactics ? this.tactics.summary() : null; }

    spawnUnit(team, type, gx, gy) {
        if (type === 'worker') this.render.units.ensureWorkerTextures?.();
        if (type === 'medic') this.render.units.ensureMedicTextures?.();
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
        if (this.terrainLoading) {
            this.pendingCountdown = { battleId: this.battleId, onDone };
            return;
        }
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
        const frameStarted = performance.now();
        // Phaser smooths/clamps delta for gameplay. Diagnostics need the actual interval.
        const frameDelta = this.game?.loop?.rawDelta ?? delta;
        this.render.world.materials.updateBake();
        if (this.pendingCountdown && !this.terrainLoading) {
            const pending = this.pendingCountdown;
            this.pendingCountdown = null;
            if (pending.battleId === this.battleId) this.startCountdown(pending.onDone);
        }
        // FPS 统计（500ms 滚动窗口）
        this._fpsN++;
        if (time - this._fpsT >= 500) {
            const fps = Math.round(this._fpsN * 1000 / (time - this._fpsT));
            if (this.fpsHud) {
                this.fpsHud.textContent = fps + ' FPS · 存活 ' + (this.redAlive + this.blueAlive) +
                    (this.net?.waiting ? ' · 同步等待' : '');
                this.fpsHud.title = this.performanceStats?.describe(this.net) || '';
                this.fpsHud.style.color = fps >= 55 ? '#9cf5a0' : fps >= 30 ? '#ffd24a' : '#ff6b6b';
            }
            this._fpsN = 0; this._fpsT = time;
        }
        const dt = Math.min(delta, 50) / 1000 * this.gameSpeed;
        this.render.camps?.update();
        this.render.units.updateDeathVisuals(delta); // 暂停冻结；结局后仍让已开始的倒地完整落地。
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
        // 本帧视口（世界坐标）+ LOD 开关：拉远看全局时砍掉小特效
        const cam = this.cameras.main;
        const v = cam.worldView;
        this._view = v ? { x0: v.x - 160, y0: v.y - 220, x1: v.right + 160, y1: v.bottom + 280 } : null;
        this.lowFX = cam.zoom < 0.42;
        if (!this.battleStarted || this.paused || this.battleOver) {
            this.render.fx.drawArrows();
            this.render.units.syncRender(time);
            this.performanceStats?.record(frameDelta, performance.now() - frameStarted);
            return;
        }
        this._fxBudget = 46;
        this._dustBudget = 8;

        const simulationStarted = performance.now();
        this.advanceBattle(delta);
        const simulationMs = performance.now() - simulationStarted;
        this.render.fx.drawArrows();
        this.render.units.syncRender(time);
        this.performanceStats?.record(frameDelta, performance.now() - frameStarted, simulationMs);
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
                this.net.noteStall(delta);
                return;
            }
            const commands = this.net.lockstep.takeCommands();
            for (const command of commands) this.applyNetCommand(command);
            this.simulationAccumulator = Math.max(0, this.simulationAccumulator - core.SIMULATION_STEP_MS);
            this.simulationTime += core.SIMULATION_STEP_MS;
            this.stepBattle(core.SIMULATION_STEP_MS / 1000);
            this.net.onTurnDone();
            this.net.noteProgress();
            this.net.noteBuffer();
            if (--catchUp <= 0) return;    // 本帧追步额度用完，下帧继续
        }
    }

    // 网络命令注入：两端各自按到达回合确定性执行（买兵 / 营令）。
    // 不触碰 selectedBattalion——选中态是各端本地视图，不随对方命令漂移。
    applyNetCommand(command) {
        if (!command || !this.territory) return;
        if (CAMP_COMMANDS.has(command.k)) return applyCampCommand(this, command);
        if (!['red', 'blue'].includes(command.side)) return false;
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
            if (this.battalions?.orderRally(command.side, command.gx, command.gy)) {
                const point = this.groundPoint(command.gx, command.gy);
                this.spawnOrderText('📍 集结点', point.x, point.y - 30, command.side === 'red' ? '#ffb0a0' : '#a8ceff');
                return true;
            }
            return false;
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

    // ---- sim→render 视觉钩子（battle/ 与测试经场景调用，单行委托进渲染层） ----
    buildUnitAnims() { return this.render.units.buildUnitAnims(); }
    playAttackAnim(unit, target = null) { return this.render.units.playAttackAnim(unit, target); }
    syncOne(unit, time, view) { return this.render.units.syncOne(unit, time, view); }
    updateDeathVisuals(delta) { return this.render.units.updateDeathVisuals(delta); }

    updateNormalUnit(unit, now, dt, guardAnchor = null) {
        return unitAi.updateNormalUnit(this, unit, now, dt, guardAnchor);
    }


    // 碰撞排斥 + 推挤传导（空间哈希：每人只查身边一格内的邻居）
    // 排斥保证不重叠；传导让"有前进意图的一方"把对方顶向自己的方向——
    // 后排顶前排、局部打赢得势就往前拱，战线才会呼吸进退。
    separate(dt) {
        return battleUnits.separate(this, dt);
    }

    // ---- sim/渲染→render 视觉钩子（battle/、测试与其他渲染层经场景调用，单行委托） ----
    fireArrow(from, target) { return this.render.fx.fireArrow(from, target); }
    updateArrows(dt, now) { return this.render.fx.updateArrows(dt, now); }
    meleeImpact(attacker, target, kind) { return this.render.fx.meleeImpact(attacker, target, kind); }
    slashArc(x, y, ang, k = 1) { return this.render.fx.slashArc(x, y, ang, k); }
    bloodBurst(x, y, n = 6, power = 95, k = 1) { return this.render.fx.bloodBurst(x, y, n, power, k); }
    updateBloods(dt) { return this.render.fx.updateBloods(dt); }
    addGroundBlood(x, y, s) { return this.render.fx.addGroundBlood(x, y, s); }
    flushBloodQueue() { return this.render.fx.flushBloodQueue(); }
    addBloodPool(x, y, s) { return this.render.fx.addBloodPool(x, y, s); }
    chargeDust(unit) { return this.render.fx.chargeDust(unit); }
    impactPuff(x, y, color) { return this.render.fx.impactPuff(x, y, color); }
    sparkBurst(x, y, color = 0xffe9a0, big = false) { return this.render.fx.sparkBurst(x, y, color, big); }
    stampCorpse(unit) { return this.render.fx.stampCorpse(unit); }
    drawTactics() { return this.render.overlay.drawTactics(); }
    orderFlash(text, battalion, color) { return this.render.overlay.orderFlash(text, battalion, color); }
    spawnOrderText(text, x, y, color) { return this.render.overlay.spawnOrderText(text, x, y, color); }
    buildMinimap() { return this.render.overlay.buildMinimap(); }
    destroyMinimap() { return this.render.overlay.destroyMinimap(); }
    updateTerritoryOverlay() { return this.render.overlay.updateTerritoryOverlay(); }
    drawFlags() { return this.render.overlay.drawFlags(); }
    drawConvoy() { return this.render.overlay.drawConvoy(); }

    // ---- 士气桥钩子（morale.js/core.js/测试经场景调用，单行委托进 battle/morale-bridge） ----
    getMoraleSummary() { return moraleBridge.getMoraleSummary(this); }
    onMoraleStateChange(unit, previousState, reason) { return moraleBridge.onMoraleStateChange(this, unit, previousState, reason); }
    moraleSector(unit) { return moraleBridge.moraleSector(this, unit); }
    updateFallingBackUnit(unit, now, dt) { return moraleBridge.updateFallingBackUnit(this, unit, now, dt); }
    updateRoutedUnit(unit, dt) { return moraleBridge.updateRoutedUnit(this, unit, dt); }
    withdrawUnit(unit) { return moraleBridge.withdrawUnit(this, unit); }

    // ---- 领土节拍桥钩子（core.js/recruit.js/测试经场景调用，单行委托进 battle/territory-bridge） ----
    updateFlags(dt) { return territoryBridge.updateFlags(this, dt); }
    updateTerritory(dt) { return territoryBridge.updateTerritory(this, dt); }
    aliveCount(team, type) { return territoryBridge.aliveCount(this, team, type); }
    spotFree(x, y) { return territoryBridge.spotFree(this, x, y); }
    spawnTerritoryUnit(team, type) { return territoryBridge.spawnTerritoryUnit(this, team, type); }

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

    updateConvoy(dt) {
        return battleConvoy.updateConvoy(this, dt);
    }

    convoyOutcome() {
        return battleConvoy.convoyOutcome(this);
    }

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
