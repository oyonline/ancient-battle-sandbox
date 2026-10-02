// 只读观察层：高度、坡向与高差效果直接取模拟规则，不参与战斗决策。
import { Terrain } from './terrain.js';
import { towerCrewOffset } from './render/camps.js';
import { CAMP_RULES } from './battle/camps.js';
import { shallowSpeedFor, DEFAULT_SHALLOW_SPEED } from './battle/site-traits.js';

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

export class UnitInspector {
    constructor(scene) {
        this.scene = scene;
        this.panel = document.getElementById('unit-inspector');
        this.selected = null;
        this.pointer = null;
        this.lastMarkup = '';
        this.lastUnit = null;
        this.nextTextAt = 0;
        this.ring = scene.add.graphics().setDepth(12100);
        this.onDown = p => {
            this.pointer = { id: p.id, x: p.x, y: p.y, dragged: false };
        };
        this.onMove = p => {
            if (this.pointer && (p.id !== this.pointer.id ||
                Math.hypot(p.x - this.pointer.x, p.y - this.pointer.y) > 6)) this.pointer.dragged = true;
        };
        this.onUp = p => {
            const start = this.pointer;
            this.pointer = null;
            if (!start || p.id !== start.id || isCanceledPointer(p) || start.dragged || scene._pinching ||
                Math.hypot(p.x - start.x, p.y - start.y) > 6) return;
            const picked = this.pick(p);
            // 选点命令先消费点击，不能先清空/换掉原营队或建设者。
            const consumed = scene.groundClick?.(scene.cameras.main.getWorldPoint(p.x, p.y), picked);
            if (consumed !== true) {
                this.selected = picked;
                scene.selectBattalionByUnit?.(picked);
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

    pick(pointer) {
        const camera = this.scene.cameras.main;
        const world = camera.getWorldPoint(pointer.x, pointer.y);
        let best = null, bestDistance = Infinity;
        for (const unit of this.scene.units) {
            if (unit.dead || unit.withdrawn) continue;
            const foot = this.scene.groundPoint(unit.gx, unit.gy);
            const crew = towerCrewOffset(unit, this.scene.territory?.camps);
            // 小比例下允许约 9 屏幕像素的点选；仍以最近的可见身体中心决胜。
            const radius = Math.max(18, 9 / camera.zoom);
            const dx = world.x - (foot.x + (crew?.x || 0));
            const dy = world.y - (foot.y + (crew?.y || 0) - (unit.type === 'cavalry' ? 24 : 18));
            const distance = Math.hypot(dx, dy * 0.8);
            if (distance <= radius && (distance < bestDistance - 1e-9 ||
                (Math.abs(distance - bestDistance) <= 1e-9 && unit.id < best.id))) {
                best = unit; bestDistance = distance;
            }
        }
        return best;
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
        this.lastMarkup = '';
        this.lastUnit = null;
        this.nextTextAt = 0;
        this.ring.clear();
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
    }
}
