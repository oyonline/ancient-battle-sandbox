// 地形是确定性的高度场；渲染、移动、冲锋与远射共用同一套高度。
// 首版只有可通行缓坡，不引入悬崖、阻挡格或寻路规则。
const Terrain = {
    HEIGHT_SCALE: 24,
    MAX_RANGE_MULTIPLIER: 1.2,
    maps: {
        flat: { name: '平地', description: '原始平地规则，适合对照战斗结果' },
        red_hill: { name: '红方高地', description: '红方一侧的缓坡山丘；上坡较慢，下坡冲锋更有力', cx: 19, cy: 35, rx: 23, ry: 26 },
        blue_hill: { name: '蓝方高地', description: '红方高地的镜像；双方换边可对照高地优势', cx: 51, cy: 35, rx: 23, ry: 26 }
    },

    normalize(key) { return Object.hasOwn(this.maps, key) ? key : 'flat'; },
    mirror(key) {
        key = this.normalize(key);
        return key === 'red_hill' ? 'blue_hill' : key === 'blue_hill' ? 'red_hill' : 'flat';
    },
    height(key, gx, gy) {
        key = this.normalize(key);
        if (key === 'flat' || !Number.isFinite(gx) || !Number.isFinite(gy) ||
            gx <= 0 || gx >= 70 || gy <= 0 || gy >= 70) return 0;
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
