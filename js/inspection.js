// 只读观察层：高度、坡向与高差效果直接取模拟规则，不参与战斗决策。
class UnitInspector {
    constructor(scene) {
        this.scene = scene;
        this.panel = document.getElementById('unit-inspector');
        this.selected = null;
        this.pointer = null;
        this.lastMarkup = '';
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
            if (!start || p.id !== start.id || start.dragged || scene._pinching ||
                Math.hypot(p.x - start.x, p.y - start.y) > 6) return;
            this.selected = this.pick(p);
            this.update();
        };
        this.onOutside = () => { this.pointer = null; };
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
            // 小比例下允许约 9 屏幕像素的点选；仍以最近的可见身体中心决胜。
            const radius = Math.max(18, 9 / camera.zoom);
            const dx = world.x - foot.x;
            const dy = world.y - (foot.y - (unit.type === 'cavalry' ? 24 : 18));
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
        const height = Terrain.height(key, unit.gx, unit.gy);
        const dx = unit.moveX || 0, dy = unit.moveY || 0;
        const walking = unit.moving && Math.hypot(dx, dy) > 1e-6;
        // 使用主动行军方向而非击退、身体分离的被动位移。
        const movement = walking ? (Number.isFinite(unit.terrainMoveMultiplier) ? unit.terrainMoveMultiplier :
            Terrain.movementMultiplier(key, unit.gx, unit.gy, unit.gx + dx, unit.gy + dy)) : null;
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
            name: enemy.typeData.name,
            difference: height - Terrain.height(key, enemy.gx, enemy.gy),
            attack: Terrain.attackMultiplier(key, unit, enemy),
            range: unit.typeData.ranged ? Terrain.rangedRange(key, unit, enemy) : null
        } : null;
        const commands = { auto: '自由突击', direct: '正面强冲', flank_archers: '侧翼袭弓' };
        const cavalryOrder = scene.battleOptions.cavalryOrders?.[unit.team] || 'auto';
        const guarded = unit.tacticalRole === 'ground_guard' &&
            (unit.type !== 'cavalry' || cavalryOrder === 'auto');
        return { height, movement, comparison,
            ground: height < 0.01 ? '平地' : height >= 2.99 ? '坡顶' : '缓坡',
            slope: movement == null ? '站定 · 无行军坡向' : movement < 0.999 ? '上坡' : movement > 1.001 ? '下坡' : '平缓行军',
            order: (guarded ? '高地守位' : '') + (unit.type === 'cavalry' ?
                (guarded ? ' · 就近反击' : commands[cavalryOrder]) : '')
        };
    }

    update() {
        if (!this.panel) return;
        const unit = this.selected;
        this.ring.clear();
        if (!unit || unit.dead || unit.withdrawn) {
            this.selected = null;
            this.lastMarkup = '';
            this.panel.hidden = true;
            this.panel.innerHTML = '';
            // 观察层每帧刷新；此处不能清 pointer，否则按下后跨一帧再抬起就选不中。
            return;
        }
        const info = UnitInspector.describe(this.scene, unit);
        const p = this.scene.groundPoint(unit.gx, unit.gy);
        this.ring.lineStyle(2 / Math.max(0.4, this.scene.cameras.main.zoom), 0xffe49a, 0.95);
        this.ring.strokeEllipse(p.x, p.y, 36, 18);
        const percent = multiplier => {
            const delta = Math.round((multiplier - 1) * 100);
            return (delta > 0 ? '+' : '') + delta + '%';
        };
        const comparison = info.comparison;
        const markup = `<b>${unit.team === 'red' ? '🔴 红方' : '🔵 蓝方'} · ${unit.typeData.name}</b>` +
            `<span>生命 ${Math.max(0, Math.ceil(unit.hp))} / ${unit.maxHp}${info.order ? ' · ' + info.order : ''}</span>` +
            `<span>${info.ground} · 高度 ${info.height.toFixed(2)} 层</span>` +
            `<span>${info.slope}${info.movement == null ? '' : ' · 地形移速 ' + Math.round(info.movement * 100) + '%'}</span>` +
            (comparison ? `<span>${comparison.label}：${comparison.name}</span>` +
                `<span>${comparison.difference > 0.01 ? '俯攻' : comparison.difference < -0.01 ? '仰攻' : '同高'} · 高差 ${comparison.difference.toFixed(2)} 层 · 地形攻击 ${percent(comparison.attack)}</span>` +
                (comparison.range == null ? '' : `<span>对该敌人射程 ${comparison.range.toFixed(1)} 格（基础 ${unit.typeData.range}）</span>`) :
                '<span>无可对照敌人</span>') +
            '<small>攻击为地形系数，非最终伤害；未含护甲、克制、士气。点击空地关闭。</small>';
        if (markup !== this.lastMarkup) { this.panel.innerHTML = markup; this.lastMarkup = markup; }
        this.panel.hidden = false;
    }

    reset() {
        this.selected = null;
        this.pointer = null;
        this.lastMarkup = '';
        this.ring.clear();
        if (this.panel) { this.panel.hidden = true; this.panel.innerHTML = ''; }
    }

    destroy() {
        this.reset();
        this.scene.input.off('pointerdown', this.onDown);
        this.scene.input.off('pointermove', this.onMove);
        this.scene.input.off('pointerup', this.onUp);
        this.scene.input.off('pointerupoutside', this.onOutside);
        this.ring.destroy();
    }
}
