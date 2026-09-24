// 渲染、导航和战斗共用此处的确定性高度场与矩形地表。
const Terrain = {
    HEIGHT_SCALE: 24,
    MAX_RANGE_MULTIPLIER: 1.2,
    maps: {
        flat: { name: '平地', description: '原始平地规则，适合对照战斗结果' },
        red_hill: { name: '红方高地', defender: 'red', description: '红方一侧的缓坡山丘；上坡较慢，下坡冲锋更有力', cx: 19, cy: 35, rx: 23, ry: 26 },
        blue_hill: { name: '蓝方高地', defender: 'blue', description: '红方高地的镜像；双方换边可对照高地优势', cx: 51, cy: 35, rx: 23, ry: 26 },
        red_pass: { name: '红方坡口', defender: 'red', description: '弓守平台，剑枪守三处入口；中央窄坡与两翼缓坡可通行，岩壁不可穿越', cx: 19, cy: 35 },
        blue_pass: { name: '蓝方坡口', defender: 'blue', description: '正面争夺中央坡口，骑兵可绕两翼袭弓；守位自由骑兵会护弓反击', cx: 51, cy: 35 },
        forest: { name: '林间战场', description: '林内骑兵移速55%、其他兵种85%；入林打断冲锋，出林重新助跑，无隐身或箭矢遮挡' },
        river: { name: '三桥河谷', description: '河面不可通行；中央宽桥争正面，两侧桥可绕后，击退不会落水，弓箭可以跨河' }
    },

    normalize(key) { return Object.hasOwn(this.maps, key) ? key : 'flat'; },
    mirror(key) {
        key = this.normalize(key);
        return ({ red_hill: 'blue_hill', blue_hill: 'red_hill', red_pass: 'blue_pass', blue_pass: 'red_pass' })[key] || key;
    },
    height(key, gx, gy) {
        key = this.normalize(key);
        if (['flat', 'forest', 'river'].includes(key) || !Number.isFinite(gx) || !Number.isFinite(gy) ||
            gx <= 0 || gx >= 70 || gy <= 0 || gy >= 70) return 0;
        if (key.endsWith('_pass')) {
            const x = key === 'red_pass' ? 70 - gx : gx;
            const smooth = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
            return 3 * smooth((x - 36) / 11) * smooth((67 - x) / 7) *
                smooth((gy - 16) / 11) * smooth((54 - gy) / 11);
        }
        const x = key === 'blue_hill' ? 70 - gx : gx;
        const q = Math.hypot((x - 19) / 23, (gy - 35) / 26);
        if (q >= 1) return 0;
        const smooth = value => value * value * (3 - 2 * value);
        const slope = Math.max(0, (q - 0.35) / 0.65);
        // 椭圆延伸至左边界之外；在边界内平滑落地，周边装饰与地图边缘不抬高。
        const edgeDistance = Math.min(x, 70 - x, gy, 70 - gy);
        const edge = Math.max(0, Math.min(1, (edgeDistance - 3.5) / 8.5));
        return 3 * (1 - smooth(slope)) * smooth(edge);
    },
    geometry(key) {
        key = this.normalize(key);
        if (!this._geometry) {
            const rect = (x1, y1, x2, y2, kind) => ({ x1, y1, x2, y2, kind });
            const blue = { blockers: [rect(40, 24, 45, 32, 'rock'), rect(40, 38, 45, 46, 'rock')],
                zones: [rect(36, 32, 49, 38, 'path'), rect(36, 18, 49, 24, 'path'), rect(36, 46, 49, 52, 'path')],
                defense: { team: 'blue', center: { gx: 51, gy: 35 },
                    frontPosts: [{ gx: 46, gy: 35 }, { gx: 46, gy: 22 }, { gx: 46, gy: 48 }],
                    archerRect: rect(49, 27, 60, 43, 'grass'), cavalryPosts: [{ gx: 52, gy: 25 }, { gx: 52, gy: 45 }] } };
            const mirrorRect = r => ({ ...r, x1: 70 - r.x2, x2: 70 - r.x1 });
            const mirrorPoint = p => ({ gx: 70 - p.gx, gy: p.gy });
            this._geometry = {
                flat: { blockers: [], zones: [], defense: null },
                blue_pass: blue,
                red_pass: { blockers: blue.blockers.map(mirrorRect), zones: blue.zones.map(mirrorRect),
                    defense: { team: 'red', center: mirrorPoint(blue.defense.center),
                        frontPosts: blue.defense.frontPosts.map(mirrorPoint), archerRect: mirrorRect(blue.defense.archerRect),
                        cavalryPosts: blue.defense.cavalryPosts.map(mirrorPoint) } },
                forest: { blockers: [], zones: [rect(25, 17, 45, 31, 'forest'), rect(25, 39, 45, 53, 'forest')], defense: null },
                river: { blockers: [[0, 13], [18, 32], [38, 52], [57, 70]].map(([a, b]) => rect(32, a, 38, b, 'water')),
                    zones: [[13, 18], [32, 38], [52, 57]].map(([a, b]) => rect(32, a, 38, b, 'bridge')), defense: null }
            };
        }
        return this._geometry[key] || this._geometry.flat;
    },
    hasBarriers(key) { return this.geometry(key).blockers.length > 0; },
    defenseLayout(key, team) {
        const layout = this.geometry(key).defense;
        return layout?.team === team ? layout : null;
    },
    contains(rect, x, y, radius = 0) {
        return x > rect.x1 - radius && x < rect.x2 + radius && y > rect.y1 - radius && y < rect.y2 + radius;
    },
    surface(key, gx, gy) {
        const geometry = this.geometry(key);
        const blocker = geometry.blockers.find(r => this.contains(r, gx, gy));
        if (blocker) return blocker.kind;
        return geometry.zones.find(r => r.kind !== 'path' && this.contains(r, gx, gy))?.kind || 'grass';
    },
    surfaceSpeed(key, type, gx, gy) {
        return this.surface(key, gx, gy) === 'forest' ? (type === 'cavalry' ? 0.55 : 0.85) : 1;
    },
    walkable(key, gx, gy, radius = 0.36) {
        return Number.isFinite(gx) && Number.isFinite(gy) && gx >= radius && gx <= 70 - radius &&
            gy >= radius && gy <= 70 - radius && !this.geometry(key).blockers.some(r => this.contains(r, gx, gy, radius));
    },
    // Slab intersection against an expanded rectangle; endpoints on the boundary are legal.
    sweep(rect, ax, ay, bx, by, radius = 0) {
        let enter = -Infinity, leave = Infinity, nx = 0, ny = 0;
        for (const [start, delta, lo, hi, axis] of [
            [ax, bx - ax, rect.x1 - radius, rect.x2 + radius, 'x'],
            [ay, by - ay, rect.y1 - radius, rect.y2 + radius, 'y']]) {
            if (Math.abs(delta) < 1e-12) { if (start <= lo || start >= hi) return null; continue; }
            let a = (lo - start) / delta, b = (hi - start) / delta;
            if (a > b) [a, b] = [b, a];
            if (a > enter) { enter = a; nx = axis === 'x' ? -Math.sign(delta) : 0; ny = axis === 'y' ? -Math.sign(delta) : 0; }
            leave = Math.min(leave, b);
        }
        if (enter >= leave - 1e-12 || leave <= 1e-12 || enter >= 1 - 1e-12) return null;
        return { t: Math.max(0, enter), nx, ny };
    },
    segmentClear(key, ax, ay, bx, by, radius = 0) {
        return !this.geometry(key).blockers.some(r => this.sweep(r, ax, ay, bx, by, radius));
    },
    clipMotion(key, gx, gy, mx, my, radius = 0.36) {
        if (!this.hasBarriers(key)) return { x: mx, y: my, blocked: false };
        // 先截世界边界再扫掠；否则长击退可先绕出图外，再被 clamp 拉回另一岸。
        const edge = Math.max(0.6, radius);
        mx = Math.max(edge, Math.min(70 - edge, gx + mx)) - gx;
        my = Math.max(edge, Math.min(70 - edge, gy + my)) - gy;
        let x = gx, y = gy, dx = mx, dy = my, blocked = false;
        for (let pass = 0; pass < 3; pass++) {
            let hit = null;
            for (const rect of this.geometry(key).blockers) {
                const candidate = this.sweep(rect, x, y, x + dx, y + dy, radius);
                if (candidate && (!hit || candidate.t < hit.t)) hit = candidate;
            }
            if (!hit) { x += dx; y += dy; break; }
            blocked = true;
            const t = Math.max(0, hit.t - 0.000002 / Math.max(0.000002, Math.hypot(dx, dy)));
            x += dx * t; y += dy * t;
            dx *= 1 - t; dy *= 1 - t;
            if (hit.nx) dx = 0;
            if (hit.ny) dy = 0;
        }
        // 返回的是合并位移而非折线路径；多次滑移不能让这条直线切穿另一个角。
        if (!this.segmentClear(key, gx, gy, x, y, radius)) {
            let fraction = 1;
            for (const rect of this.geometry(key).blockers) {
                const hit = this.sweep(rect, gx, gy, gx + mx, gy + my, radius);
                if (hit) fraction = Math.min(fraction, Math.max(0, hit.t - 0.000002 / Math.max(0.000002, Math.hypot(mx, my))));
            }
            x = gx + mx * fraction; y = gy + my * fraction; blocked = true;
        }
        return { x: x - gx, y: y - gy, blocked };
    },
    projectPoint(key, gx, gy, radius = 0.36, preferredSide = 0) {
        gx = Math.max(radius + 0.01, Math.min(70 - radius - 0.01, gx));
        gy = Math.max(radius + 0.01, Math.min(70 - radius - 0.01, gy));
        if (this.walkable(key, gx, gy, radius)) return { gx, gy };
        const candidates = [];
        for (const r of this.geometry(key).blockers) {
            const pad = radius + 0.01;
            candidates.push({ gx: r.x1 - pad, gy }, { gx: r.x2 + pad, gy },
                { gx, gy: r.y1 - pad }, { gx, gy: r.y2 + pad });
        }
        return candidates.filter(p => this.walkable(key, p.gx, p.gy, radius)).sort((a, b) =>
            Math.hypot(a.gx - gx, a.gy - gy) - Math.hypot(b.gx - gx, b.gy - gy) ||
            preferredSide * (b.gx - a.gx) || a.gy - b.gy)[0] || { gx, gy };
    },
    chargeAllowed(key, ax, ay, bx, by) {
        return this.segmentClear(key, ax, ay, bx, by, 0.36) &&
            !this.geometry(key).zones.some(r => r.kind === 'forest' &&
                (this.contains(r, ax, ay) || this.contains(r, bx, by) || this.sweep(r, ax, ay, bx, by)));
    },
    movementMultiplier(key, gx, gy, tx, ty) {
        if (this.normalize(key) === 'flat') return 1;
        const dx = tx - gx, dy = ty - gy, distance = Math.hypot(dx, dy);
        if (distance < 0.001) return 1;
        // 只看脚下往前一格的坡度，不能因远处目标在山顶而在平地提前减速。
        const sample = Math.min(1, distance);
        const rise = (this.height(key, gx + dx / distance * sample, gy + dy / distance * sample) -
            this.height(key, gx, gy)) / sample;
        const grade = Math.max(-1, Math.min(1, rise / 0.3));
        return grade >= 0 ? 1 - grade * 0.3 : 1 - grade * 0.1;
    },
    attackMultiplier(key, from, target, sourceHeight) {
        if (this.normalize(key) === 'flat') return 1;
        const launchHeight = Number.isFinite(sourceHeight) ? sourceHeight : this.height(key, from.gx, from.gy);
        const difference = launchHeight - this.height(key, target.gx, target.gy);
        return 1 + Math.max(-0.18, Math.min(0.18, difference * 0.12));
    },
    rangedRange(key, from, target) {
        const range = from.typeData.range;
        if (this.normalize(key) === 'flat') return range;
        const difference = this.height(key, from.gx, from.gy) - this.height(key, target.gx, target.gy);
        return range * (1 + Math.max(-0.2, Math.min(0.2, difference * 0.2 / 3)));
    }
};
