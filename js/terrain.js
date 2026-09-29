// 渲染、导航和战斗共用此处的确定性高度场与矩形地表。
// 棋盘尺寸经 board 读取（默认 70×70；领土征服大地图 104×72）。除 territory 地形
// 按棋盘比例布局外，其余地图是 70×70 时代设计、只在默认尺寸下运行，行为不变。
import { board } from './board.js';
export const Terrain = {
    HEIGHT_SCALE: 24,
    MAX_RANGE_MULTIPLIER: 1.2,
    FOREST_EDGE: 0.25,
    maps: {
        flat: { name: '平地', description: '原始平地规则，适合对照战斗结果' },
        red_hill: { name: '红方高地', defender: 'red', description: '红方一侧的缓坡山丘；上坡较慢，下坡冲锋更有力', cx: 19, cy: 35, rx: 23, ry: 26 },
        blue_hill: { name: '蓝方高地', defender: 'blue', description: '红方高地的镜像；双方换边可对照高地优势', cx: 51, cy: 35, rx: 23, ry: 26 },
        red_pass: { name: '红方自然坡地', defender: 'red', description: '连续草坡与宽正面守线；弓兵据山脊，骑兵沿侧坡绕行', cx: 19, cy: 35 },
        blue_pass: { name: '蓝方自然坡地', defender: 'blue', description: '步兵沿宽坡仰攻，弓兵据山脊俯射；骑兵可沿侧坡绕后', cx: 51, cy: 35 },
        forest: { name: '林间战场', description: '林内骑兵移速55%、其他兵种85%；入林打断冲锋，出林重新助跑，无隐身或箭矢遮挡' },
        river: { name: '三桥河谷', description: '河面不可通行；中央宽桥争正面，两侧桥可绕后，击退不会落水，弓箭可以跨河' },
        // 领土征服专用（104×72）：上翼横河+中央一道桥（两端可绕），中央高地缓坡，
        // 下翼双林带夹开阔走廊；几何按棋盘比例生成（见 geometry），镜像自对称。
        territory: { name: '山河领土', description: '上翼争桥、中央夺高地、下翼穿林——三条线三种打法', cx: 52, cy: 36, rx: 9, ry: 6.5 }
    },

    normalize(key) { return Object.hasOwn(this.maps, key) ? key : 'flat'; },
    isNaturalSlope(key) { return key === 'red_pass' || key === 'blue_pass'; },
    mirror(key) {
        key = this.normalize(key);
        return ({ red_hill: 'blue_hill', blue_hill: 'red_hill', red_pass: 'blue_pass', blue_pass: 'red_pass' })[key] || key;
    },
    height(key, gx, gy) {
        key = this.normalize(key);
        if (key === 'flat' || !Number.isFinite(gx) || !Number.isFinite(gy) ||
            gx <= 0 || gx >= board.W || gy <= 0 || gy >= board.H) return 0;
        if (key === 'territory') {
            // 中央高地：椭圆缓坡，坡顶 3 层；弓兵据顶俯射（rangedRange），
            // 仰攻减速 / 下坡加速共用 movementMultiplier 的通用坡度规则。
            const cx = board.W / 2, cy = board.H / 2;
            const q = Math.hypot((gx - cx) / 9, (gy - cy) / 6.5);
            if (q >= 1) return 0;
            const smooth = value => value * value * (3 - 2 * value);
            const slope = Math.max(0, (q - 0.35) / 0.65);
            const edgeDistance = Math.min(gx, board.W - gx, gy, board.H - gy);
            const edge = Math.max(0, Math.min(1, (edgeDistance - 3.5) / 8.5));
            return 3 * (1 - smooth(slope)) * smooth(edge);
        }
        if (key === 'forest' || key === 'river') return 0;
        if (this.isNaturalSlope(key)) {
            const x = key === 'red_pass' ? 70 - gx : gx;
            // 宽前坡接入略弯的山脊；轮廓、脚底和战斗均消费同一连续高度。
            const lateral = (gy - 35) / 24;
            const ridgeX = 51 + 1.4 * Math.sin(lateral * 2.4);
            const radius = Math.hypot((x - ridgeX) / (x < ridgeX ? 24 : 17), lateral);
            const t = Math.max(0, Math.min(1, (radius - 0.15) / 0.85));
            return 5 * (1 - t * t * (3 - 2 * t));
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
    _hash2(x, y) {
        let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    },
    _vnoise(x, y) {
        const xi = Math.floor(x), yi = Math.floor(y);
        const fx = x - xi, fy = y - yi;
        const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
        const a = this._hash2(xi, yi), b = this._hash2(xi + 1, yi);
        const c = this._hash2(xi, yi + 1), d = this._hash2(xi + 1, yi + 1);
        return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
    },
    // 林地占位场：上下双叶由腰桥连成一片，域扭曲噪声揉出犬牙边缘与豁口。
    // 坐标先折叠到左半（u），镜像重演天然逐位一致；窗口噪声保证林心不挖洞、林外不掉碎屑。
    forestField(gx, gy) {
        if (gx < 21 || gx > 49 || gy < 10 || gy > 60) return -1;
        const u = (gx <= 35 ? gx : 70 - gx) - 35;
        const wu = (this._vnoise(u * 0.19 + 7.7, gy * 0.19 - 3.1) - 0.5) * 5.8;
        const wv = (this._vnoise(u * 0.19 - 12.3, gy * 0.19 + 9.4) - 0.5) * 5.8;
        const cu = (this._vnoise(u * 0.6 + 31.7, gy * 0.6 + 3.1) - 0.5) * 1.2;
        const cv = (this._vnoise(u * 0.6 - 8.9, gy * 0.6 + 17.3) - 0.5) * 1.2;
        const eu = u + wu + cu, ev = gy + wv + cv;
        const lobe1 = 1 - (eu / 9.6) ** 2 - ((ev - 23.5) / 10) ** 2;
        const lobe2 = 1 - (eu / 9.6) ** 2 - ((ev - 46.5) / 10) ** 2;
        const waist = 1 - (eu / 5) ** 2 - ((ev - 35) / 7.2) ** 2;
        const shape = Math.max(lobe1, lobe2, waist);
        const band = Math.min(Math.max(0, Math.min(1, (shape + 0.15) / 0.35)), Math.max(0, Math.min(1, (0.75 - shape) / 0.35)));
        return shape + (this._vnoise(u * 0.24 + 51.3, gy * 0.24 - 21.9) - 0.5) * 0.5 * band;
    },
    geometry(key) {
        key = this.normalize(key);
        const boardKey = board.W + 'x' + board.H;
        if (!this._geometry || this._geometryBoard !== boardKey) {
            const rect = (x1, y1, x2, y2, kind) => ({ x1, y1, x2, y2, kind });
            const blue = { blockers: [], zones: [],
                defense: { team: 'blue', center: { gx: 51, gy: 35 },
                    frontLine: { gx: 44, y1: 25, y2: 45 },
                    archerRect: rect(49, 29, 58, 41, 'grass'), cavalryPosts: [{ gx: 52, gy: 23 }, { gx: 52, gy: 47 }] } };
            const mirrorRect = r => ({ ...r, x1: 70 - r.x2, x2: 70 - r.x1 });
            const mirrorPoint = p => ({ gx: 70 - p.gx, gy: p.gy });
            const W = board.W, H = board.H;
            // 领土征服山河图：上翼横河 y≈13-19，中央独桥 x=W/2±3，两端浅滩可绕行；
            // 下翼双林带（x 30%~44% / 56%~70%，y 70%~88%）夹中央开阔走廊。
            const riverY1 = Math.round(H * 0.18), riverY2 = riverY1 + 6;
            const riverX1 = Math.round(W * 0.17), riverX2 = W - Math.round(W * 0.17);
            this._geometry = {
                flat: { blockers: [], zones: [], defense: null },
                blue_pass: blue,
                red_pass: { blockers: blue.blockers.map(mirrorRect), zones: blue.zones.map(mirrorRect),
                    defense: { team: 'red', center: mirrorPoint(blue.defense.center),
                        frontLine: { ...blue.defense.frontLine, gx: 70 - blue.defense.frontLine.gx }, archerRect: mirrorRect(blue.defense.archerRect),
                        cavalryPosts: blue.defense.cavalryPosts.map(mirrorPoint) } },
                forest: { blockers: [], zones: [{ x1: 25, y1: 12, x2: 45, y2: 58, kind: 'forest', blob: true }], defense: null },
                river: { blockers: [[0, 13], [18, 32], [38, 52], [57, 70]].map(([a, b]) => rect(32, a, 38, b, 'water')),
                    zones: [[13, 18], [32, 38], [52, 57]].map(([a, b]) => rect(32, a, 38, b, 'bridge')), defense: null },
                territory: {
                    blockers: [
                        rect(riverX1, riverY1, W / 2 - 3, riverY2, 'water'),
                        rect(W / 2 + 3, riverY1, riverX2, riverY2, 'water')
                    ],
                    zones: [
                        rect(W / 2 - 3, riverY1, W / 2 + 3, riverY2, 'bridge'),
                        rect(Math.round(W * 0.31), Math.round(H * 0.70), Math.round(W * 0.44), Math.round(H * 0.88), 'forest'),
                        rect(Math.round(W * 0.56), Math.round(H * 0.70), Math.round(W * 0.69), Math.round(H * 0.88), 'forest')
                    ],
                    defense: null
                }
            };
            this._geometryBoard = boardKey;
        }
        return this._geometry[key] || this._geometry.flat;
    },
    hasBarriers(key) { return this.geometry(key).blockers.length > 0; },
    defenseLayout(key, team) {
        const layout = this.geometry(key).defense;
        return layout?.team === team ? layout : null;
    },
    contains(rect, x, y, radius = 0) {
        if (x > rect.x1 - radius && x < rect.x2 + radius && y > rect.y1 - radius && y < rect.y2 + radius) {
            return rect.blob ? this.forestField(x, y) > this.FOREST_EDGE : true;
        }
        return false;
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
        return Number.isFinite(gx) && Number.isFinite(gy) && gx >= radius && gx <= board.W - radius &&
            gy >= radius && gy <= board.H - radius && !this.geometry(key).blockers.some(r => this.contains(r, gx, gy, radius));
    },
    // Slab intersection against an expanded rectangle; endpoints on the boundary are legal.
    sweep(rect, ax, ay, bx, by, radius = 0) {
        if (rect.blob) {
            // 林斑没有解析交点，按 0.3 格步长采样；端点归属由调用方的 contains 判定。
            const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.3));
            for (let i = 1; i < steps; i++) {
                const t = i / steps;
                if (this.contains(rect, ax + (bx - ax) * t, ay + (by - ay) * t)) return { t, nx: 0, ny: 0 };
            }
            return null;
        }
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
        mx = Math.max(edge, Math.min(board.W - edge, gx + mx)) - gx;
        my = Math.max(edge, Math.min(board.H - edge, gy + my)) - gy;
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
        gx = Math.max(radius + 0.01, Math.min(board.W - radius - 0.01, gx));
        gy = Math.max(radius + 0.01, Math.min(board.H - radius - 0.01, gy));
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
