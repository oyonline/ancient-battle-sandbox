// 只读观察层：高度、坡向与高差效果直接取模拟规则，不参与战斗决策。
import { Terrain } from './terrain.js';
import { towerCrewOffset } from './render/camps.js';
import { CAMP_RULES } from './battle/camps.js';
import { shallowSpeedFor, DEFAULT_SHALLOW_SPEED } from './battle/site-traits.js';
import { TW, TH, OX, OY } from './render/metrics.js';

// 地表文案单一处维护：数值与文字都对得上同一份地形规则。
const SURFACE_LABELS = { grass: '草地 / 道路', forest: '林地', water: '水域（不可通行）',
    bridge: '桥面', rock: '岩壁（不可通行）', shallow: '浅滩（蹚水减速）' };

// 触摸取消判定：Phaser 3.70 把 touchcancel 与 touchend 走同一条 processUpEvents
// （以普通 pointerup 送达，event.type 仍是 'touchcancel'）——取消不是点击，
// 不得触发选兵或地面命令（集结/驻守令）。
function isCanceledPointer(p) {
    const type = p?.event?.type;
    return type === 'touchcancel' || type === 'pointercancel';
}

// 悬停/点选共用参数：预览与最终选择必须出自同一条管线，保证"所见即所选"。
const HOVER_INTERVAL_MS = 90;     // 悬停拾取节流：指针移动事件远高于帧率也不反复扫描
const CREW_CACHE_MS = 500;        // 驻塔弓手不在空间桶里，用短周期缓存补进候选

// 候选覆盖界的抬升不确定全幅（px）＝全图高度域跨度 × HEIGHT_SCALE（当前地形域
// [-0.5, 5] 层 × 24 = 132px）。与地形规则耦合：高度域若扩大，必须同步改大此常数——
// tests/selection-fixes.test.js 的"高度域守卫"测试会先失败提醒（变更即断）。
export const LIFT_SPAN_PX = 132;

export class UnitInspector {
    constructor(scene) {
        this.scene = scene;
        this.panel = document.getElementById('unit-inspector');
        this.selected = null;
        this.pointer = null;
        this.hover = null;             // 悬停预览目标 { unit, battalion }｜null
        this._hoverAt = 0;
        this._hoverGfx = null;
        this._crewCache = null;
        this._crewAt = -Infinity;
        this.lastMarkup = '';
        this.lastUnit = null;
        this.nextTextAt = 0;
        this.ring = scene.add.graphics().setDepth(12100);
        this.onDown = p => {
            // 按下瞬间定靶：部队随后轻微移动、邻近部队滑到指针下，抬起仍选按压目标。
            this.pointer = { id: p.id, x: p.x, y: p.y, dragged: false, picked: this.pickWithMarker(p) };
            this.setHover(null);   // 按下即撤悬停预览，结果交由点击决定
        };
        this.onMove = p => {
            if (this.pointer && (p.id !== this.pointer.id ||
                Math.hypot(p.x - this.pointer.x, p.y - this.pointer.y) > 6)) this.pointer.dragged = true;
            this.updateHover(p);
        };
        this.onUp = p => {
            const start = this.pointer;
            this.pointer = null;
            if (!start || p.id !== start.id || isCanceledPointer(p) || start.dragged || scene._pinching ||
                Math.hypot(p.x - start.x, p.y - start.y) > 6) return;
            const picked = start.picked;
            // 选点命令先消费点击，不能先清空/换掉原营队或建设者。
            // 第三个参数透传营旗命中（marker 营），供 UI 区分普通态拾取与命令消费（F2）。
            const consumed = scene.groundClick?.(scene.cameras.main.getWorldPoint(p.x, p.y),
                picked?.unit ?? null, picked?.battalion ?? null);
            if (consumed !== true) {
                // 营旗入口与单兵入口同一落点：选中代表成员即选中整营。
                this.selected = picked?.unit ?? null;
                scene.selectBattalionByUnit?.(this.selected);
            }
            this.update(true);
        };
        this.onOutside = () => { this.pointer = null; };
        // 失焦即取消进行中的按压：回来后原地抬起不再选兵/下令（与镜头手势同口径）
        this.onBlur = () => { this.pointer = null; };
        scene.game?.events?.on('blur', this.onBlur);
        scene.input.on('pointerdown', this.onDown);
        scene.input.on('pointermove', this.onMove);
        scene.input.on('pointerup', this.onUp);
        scene.input.on('pointerupoutside', this.onOutside);
        scene.events.once('shutdown', () => this.destroy());
    }

    // 营旗优先的完整拾取：命中营旗 → 整营 + 代表成员；否则单兵拾取。
    // 供按下定靶与悬停预览共用（options.fallback 关闭战前全军兜底，悬停不扫全军）。
    pickWithMarker(pointer, options = {}) {
        const camera = this.scene.cameras.main;
        const world = camera.getWorldPoint(pointer.x, pointer.y);
        const marker = this.scene.render?.overlay?.battalionMarkerAt?.(world);
        if (marker) {
            const member = marker.battalion.aliveMembers?.()?.[0] ?? null;
            return member ? { unit: member, battalion: marker.battalion } : { unit: null, battalion: null };
        }
        return { unit: this.pickUnitAt(world, camera, options), battalion: null };
    }

    pick(pointer) {
        return this.pickUnitAt(this.scene.cameras.main.getWorldPoint(pointer.x, pointer.y), this.scene.cameras.main);
    }

    // 单兵拾取候选：空间桶优先（悬停/点击都不全军扫描）；驻塔弓手不在桶里，走短周期缓存。
    // 战前布防阶段索引未建（无存活索引）时，点击拾取仍允许一次全军兜底。
    pickCandidates(world, radius, fallback) {
        const scene = this.scene;
        if (typeof scene.forEachNear === 'function') {
            // 逆投影带两次地形抬升补偿（与 UI 下令选点同一套换算），只影响查询中心的精度。
            const key = scene.battleOptions?.terrain;
            let gx = 0, gy = 0;
            for (let pass = 0; pass < 2; pass++) {
                const lift = Terrain.height(key, gx, gy) * Terrain.HEIGHT_SCALE;
                const dx = (world.x - OX) / (TW / 2), dy = (world.y + lift - OY) / (TH / 2);
                gx = (dx + dy) / 2; gy = (dy - dx) / 2;
            }
            // 覆盖界（每轴格数）= 拾取半径的网格投影 0.055R + 身体中心上移 ≤24px
            // + 地形抬升不确定全幅 LIFT_SPAN_PX（见顶部常量与守卫测试）。
            // 高度迭代只是估锚点：坡缘/坡顶的锚点可能落在残差任意一侧，覆盖必须按全幅兜底。
            // 桶覆盖是方形的，宁可多查几个桶，不可漏掉候选（F2 高地漏选；测试全图扫描守护）。
            const gridRadius = radius * 0.055 + 24 / 32 + LIFT_SPAN_PX / 32 + 0.25;
            const found = [];
            scene.forEachNear(gx, gy, gridRadius, unit => found.push(unit));
            if (found.length || scene._aliveArr?.length) return [...found, ...this.garrisonCrew()];
        }
        return fallback === false ? [] : this.scene.units;
    }

    // 驻塔/驻帐成员缓存：只读模拟字段，短周期刷新，避免每次拾取都全军过滤。
    garrisonCrew() {
        const now = performance.now();
        if (!this._crewCache || now - this._crewAt > CREW_CACHE_MS) {
            this._crewCache = this.scene.units.filter(u => !u.dead && !u.withdrawn && u.garrisonTowerId);
            this._crewAt = now;
        }
        return this._crewCache;
    }

    pickUnitAt(world, camera, options = {}) {
        const scene = this.scene;
        // 领土模式普通指挥点选优先己方可控部队：混战中敌兵不再抢走己方选中；
        // 点击点附近没有己方部队时敌军仍可观察（观察入口保留）。
        const mine = scene.battleOptions?.territory ? (scene.netMySide || 'red') : null;
        // 小比例下允许约 9 屏幕像素的点选；仍以最近的可见身体中心决胜。
        const radius = Math.max(18, 9 / (camera.zoom ?? 1));
        let any = null, anyDistance = Infinity, own = null, ownDistance = Infinity;
        for (const unit of this.pickCandidates(world, radius, options.fallback)) {
            if (unit.dead || unit.withdrawn) continue;
            const foot = scene.groundPoint(unit.gx, unit.gy);
            const crew = towerCrewOffset(unit, scene.territory?.camps);
            const dx = world.x - (foot.x + (crew?.x || 0));
            const dy = world.y - (foot.y + (crew?.y || 0) - (unit.type === 'cavalry' ? 24 : 18));
            const distance = Math.hypot(dx, dy * 0.8);
            if (distance > radius) continue;
            const better = (best, bestDistance) => distance < bestDistance - 1e-9 ||
                (Math.abs(distance - bestDistance) <= 1e-9 && unit.id < best.id);
            if (better(any, anyDistance)) { any = unit; anyDistance = distance; }
            if (mine && unit.team === mine && better(own, ownDistance)) { own = unit; ownDistance = distance; }
        }
        return mine && own ? own : any;
    }

    // 悬停预览：与点击同一条拾取管线；节流 + 空间桶，不逐事件全军扫描。
    updateHover(pointer) {
        if (this.pointer || this.scene._pinching) { this.setHover(null); return; }
        const now = performance.now();
        if (now < this._hoverAt) return;
        this._hoverAt = now + HOVER_INTERVAL_MS;
        this.setHover(this.pickWithMarker(pointer, { fallback: false }));
    }

    setHover(target) {
        if (target && !target.unit && !target.battalion) target = null;
        const unit = target?.unit ?? null, battalion = target?.battalion ?? null;
        const current = this.hover;
        if (((current?.unit ?? null) === unit) && ((current?.battalion ?? null) === battalion)) return;
        this.hover = target;
        // 营旗高亮是纯本地表现：只改自己一端的标签颜色。
        this.scene.render?.overlay?.setBattalionMarkerHover?.(battalion?.id ?? null);
    }

    // 悬停环逐帧跟随（不重新拾取）：白色细环区别于金色选中环。
    drawHover() {
        const hover = this.hover;
        if (hover?.unit && (hover.unit.dead || hover.unit.withdrawn)) { this.setHover({ unit: null, battalion: hover.battalion }); }
        const target = this.hover;
        if (!target && !this._hoverGfx) return;
        if (!this._hoverGfx) this._hoverGfx = this.scene.add.graphics().setDepth(12060);
        const g = this._hoverGfx;
        g.clear();
        if (!target) return;
        const camera = this.scene.cameras.main;
        if (target.battalion) {
            const rect = this.scene.render?.overlay?.markerRects?.find(r => r.battalion === target.battalion);
            if (!rect) return;
            g.lineStyle(1.6 / Math.max(0.4, camera.zoom), 0xffffff, 0.55);
            g.strokeEllipse(rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w * 0.96, rect.h * 0.9);
            return;
        }
        const unit = target.unit;
        if (!unit) return;
        const foot = this.scene.groundPoint(unit.gx, unit.gy);
        const crew = towerCrewOffset(unit, this.scene.territory?.camps);
        g.lineStyle(1.6 / Math.max(0.4, camera.zoom), 0xffffff, 0.5);
        g.strokeEllipse(foot.x + (crew?.x || 0), foot.y + (crew?.y || 0) - (unit.type === 'cavalry' ? 24 : 18) + 6, 30, 15);
    }

    static describe(scene, unit) {
        const key = Terrain.normalize(scene.battleOptions.terrain);
        const groundHeight = Terrain.height(key, unit.gx, unit.gy);
        const platformHeight = unit.garrisonTowerId ? (unit.garrisonHeight || 0) / Terrain.HEIGHT_SCALE : 0;
        const height = groundHeight + platformHeight;
        const dx = unit.moveX || 0, dy = unit.moveY || 0;
        const walking = unit.moving && Math.hypot(dx, dy) > 1e-6;
        // 使用主动行军方向而非击退、身体分离的被动位移。
        const movement = walking ? (Number.isFinite(unit.terrainMoveMultiplier) ? unit.terrainMoveMultiplier :
            Terrain.movementMultiplier(key, unit.gx, unit.gy, unit.gx + dx, unit.gy + dy)) : null;
        const surface = Terrain.surface(key, unit.gx, unit.gy);
        // 渡口特色只改浅滩系数（0.70 → 0.85）：地表规则仍由 Terrain 决定，观察层只传系数。
        const shallowSpeed = shallowSpeedFor(scene, unit.team);
        const surfaceSpeed = Terrain.surfaceSpeed(key, unit.type, unit.gx, unit.gy, shallowSpeed);
        const surfaceLabel = surface === 'shallow' && shallowSpeed > DEFAULT_SHALLOW_SPEED
            ? `浅滩（渡口通行，移速 ${Math.round(shallowSpeed * 100)}%）` : SURFACE_LABELS[surface];
        const valid = enemy => enemy && enemy.team !== unit.team && !enemy.dead && !enemy.withdrawn;
        const current = !unit.typeData.ranged && valid(unit.groundGuardTarget) ? unit.groundGuardTarget :
            valid(unit.target) && unit.type === 'cavalry' ? unit.target : null;
        let enemy = current || scene.nearestEnemy(unit);
        // 准备阶段空间索引尚未建立；只在观察层回退查找，不重建模拟索引。
        if (!valid(enemy)) {
            let bestDistance = Infinity;
            for (const candidate of scene.units) {
                if (!valid(candidate)) continue;
                const distance = Math.hypot(candidate.gx - unit.gx, candidate.gy - unit.gy);
                if (distance < bestDistance - 1e-9 ||
                    (Math.abs(distance - bestDistance) <= 1e-9 && candidate.id < enemy.id)) {
                    enemy = candidate; bestDistance = distance;
                }
            }
        }
        const comparison = valid(enemy) ? {
            label: current ? '当前目标' : '最近敌人（高差对照）',
            name: enemy.typeData.name || (enemy.isBuilding ? enemy.type === 'tower' ? '箭塔' : enemy.siteId === 'home' ? '大本营' : '前线营寨' : enemy.type),
            difference: height - Terrain.height(key, enemy.gx, enemy.gy),
            attack: Terrain.attackMultiplier(key, unit, enemy, height),
            range: unit.typeData.ranged ? platformHeight ? CAMP_RULES.TOWER_RANGE : Terrain.rangedRange(key, unit, enemy) : null
        } : null;
        const commands = { auto: '自由突击', direct: '正面强冲', flank_archers: '侧翼袭弓' };
        const cavalryOrder = scene.battleOptions.cavalryOrders?.[unit.team] || 'auto';
        const guarded = unit.tacticalRole === 'ground_guard' &&
            (unit.type !== 'cavalry' || cavalryOrder === 'auto');
        const protectingArchers = guarded && unit.type === 'cavalry' && !!Terrain.defenseLayout(key, unit.team);
        return { height, platformHeight, movement, comparison, surface, surfaceSpeed,
            surfaceLabel,
            chargeRestricted: unit.type === 'cavalry' && surface === 'forest',
            ground: groundHeight < 0.01 ? '平地' : groundHeight >= 2.99 ? '坡顶' : '缓坡',
            slope: movement == null ? '站定 · 无行军坡向' : movement < 0.999 ? '上坡' : movement > 1.001 ? '下坡' : '平缓行军',
            order: (guarded ? '高地守位' : '') + (unit.type === 'cavalry' ?
                (guarded ? protectingArchers ? ' · 就近护弓反击' : ' · 就近反击' : commands[cavalryOrder]) : '')
        };
    }

    update(force = false) {
        this.drawHover();
        if (!this.panel) return;
        const unit = this.selected;
        this.ring.clear();
        if (!unit || unit.dead || unit.withdrawn) {
            this.selected = null;
            this.panel.hidden = true;
            if (this.lastMarkup) this.panel.innerHTML = '';
            this.lastMarkup = '';
            this.lastUnit = null;
            // 观察层每帧刷新；此处不能清 pointer，否则按下后跨一帧再抬起就选不中。
            return;
        }
        const p = this.scene.groundPoint(unit.gx, unit.gy);
        const crew = towerCrewOffset(unit, this.scene.territory?.camps);
        this.ring.lineStyle(2 / Math.max(0.4, this.scene.cameras.main.zoom), 0xffe49a, 0.95);
        this.ring.strokeEllipse(p.x + (crew?.x || 0), p.y + (crew?.y || 0), 36, 18);
        // 选择圈逐帧跟随；说明只需 8Hz，避免每帧索敌和重建 DOM。
        const now = performance.now();
        if (!force && unit === this.lastUnit && now < this.nextTextAt) return;
        this.lastUnit = unit;
        this.nextTextAt = now + 125;
        const info = UnitInspector.describe(this.scene, unit);
        const percent = multiplier => {
            const delta = Math.round((multiplier - 1) * 100);
            return (delta > 0 ? '+' : '') + delta + '%';
        };
        const comparison = info.comparison;
        const siteName = id => id === 'home' ? '大本营' : this.scene.flags?.[id]?.name || '己方据点';
        // 驻军目标按建筑类型说人话：箭塔 → 驻塔中，医帐 → 驻帐中；路上则是"正在前往"。
        const garrisonKind = id => this.scene.territory?.camps?.getBuilding?.(id)?.type
            ?? (unit.type === 'medic' ? 'tent' : 'tower');
        const garrisonWord = id => garrisonKind(id) === 'tent' ? '帐' : '塔';
        const battalion = unit.battalion;
        const status = unit.healingAt != null ? `在${siteName(unit.healingAt)}疗伤 · 生命恢复 ${Math.round(unit.hp / unit.maxHp * 100)}%`
            : unit.moraleState === 'routing' ? unit.healSiteId != null ? `撤往${siteName(unit.healSiteId)}疗伤` : '溃退中 · 寻找安全接应'
            : unit.moralePhase === 'returning' ? '伤愈 / 重整归队中'
            : unit.moralePhase === 'forming' ? '正在整队，准备返场'
            : unit.workerTask?.kind === 'build' ? '赶赴工地 / 建设施工'
            : unit.workerTask?.kind === 'move' ? '前往指定位置'
            : unit.wallGuardId ? (unit.target ? '寨墙守军 · 居高临下接敌' : '寨墙守军 · 站墙待敌')
            : unit.garrisonOrderId ? `正在前往${garrisonKind(unit.garrisonOrderId) === 'tent' ? '医帐' : '箭塔'}`
            : unit.garrisonTowerId ? (garrisonKind(unit.garrisonTowerId) === 'tent' ? '驻帐中 · 治疗伤兵' : '驻塔中')
            : battalion?.retreat ? '回防集结'
            : battalion?.gathering ? '营队集结中'
            : battalion?.orderPoint ? unit.moving ? '前往驻守位置' : '驻守指定位置'
            : battalion?.orderFlag != null ? `前往${siteName(battalion.orderFlag)}夺旗`
            : unit.moving ? '自主行军' : '自主作战';
        const detailsOpen = this.panel.querySelector?.('details')?.open;
        const markup = `<b>${unit.team === 'red' ? '🔴 红方' : '🔵 蓝方'} · ${unit.typeData.name}</b>` +
            `<span>生命 ${Math.max(0, Math.ceil(unit.hp))} / ${unit.maxHp}${info.order ? ' · ' + info.order : ''}</span>` +
            `<span class="inspection-task">${status}</span>` +
            `<span>士气 ${Math.round(unit.morale ?? 100)} · ${{ steady: '稳定', wavering: '动摇', routing: '溃退' }[unit.moraleState] || '稳定'}</span>` +
            `<details${detailsOpen ? ' open' : ''}><summary>地形与战斗详情</summary>` +
            `<span>${info.ground} · 高度 ${(info.height - info.platformHeight).toFixed(2)} 层${info.platformHeight ? ' · 塔平台 +' + info.platformHeight.toFixed(2) + ' 层' : ''}</span>` +
            `<span>地表：${info.surfaceLabel} · 地表移速 ${Math.round(info.surfaceSpeed * 100)}%</span>` +
            `<span>${info.slope}${info.movement == null ? '' : ' · 坡速系数 ' + Math.round(info.movement * 100) + '%'}</span>` +
            (info.chargeRestricted ? '<span class="inspection-warning">林中不能蓄力冲锋；出林后重新助跑。</span>' : '') +
            (comparison ? `<span>${comparison.label}：${comparison.name}</span>` +
                `<span>${comparison.difference > 0.01 ? '俯攻' : comparison.difference < -0.01 ? '仰攻' : '同高'} · 高差 ${comparison.difference.toFixed(2)} 层 · 地形攻击 ${percent(comparison.attack)}</span>` +
                (comparison.range == null ? '' : `<span>对该敌人射程 ${comparison.range.toFixed(1)} 格（基础 ${unit.typeData.range}）</span>`) :
                '<span>无可对照敌人</span>') +
            '<small>坡速与地表移速分开计算，并非最终速度；攻击为地形系数，未含护甲、克制、士气。</small></details><small>点击空地关闭 · 选点命令中保留当前选择</small>';
        if (markup !== this.lastMarkup) { this.panel.innerHTML = markup; this.lastMarkup = markup; }
        this.panel.hidden = false;
    }

    reset() {
        this.selected = null;
        this.pointer = null;
        this.hover = null;
        this._hoverAt = 0;
        this._crewCache = null;
        this._crewAt = -Infinity;
        this.lastMarkup = '';
        this.lastUnit = null;
        this.nextTextAt = 0;
        this.ring.clear();
        this._hoverGfx?.clear();
        if (this.panel) { this.panel.hidden = true; this.panel.innerHTML = ''; }
    }

    destroy() {
        this.reset();
        this.scene.input.off('pointerdown', this.onDown);
        this.scene.input.off('pointermove', this.onMove);
        this.scene.input.off('pointerup', this.onUp);
        this.scene.input.off('pointerupoutside', this.onOutside);
        this.scene.game?.events?.off('blur', this.onBlur);
        this.ring.destroy();
        this._hoverGfx?.destroy();
        this._hoverGfx = null;
    }
}
