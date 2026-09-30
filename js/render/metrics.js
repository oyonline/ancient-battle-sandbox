// 世界度量与几何工具：随棋盘尺寸走（setBoardSize 后由 refreshWorldMetrics 重算），渲染各层读当前值，不缓存旧尺寸。
import { board } from '../board.js';

export const TW = 64, TH = 32;                       // 菱形块宽高
// 世界度量随棋盘尺寸走（默认 70×70 时 VIEW_W=4480）；大地图模式经 setBoardSize
// 改尺寸后由 refreshWorldMetrics() 重算，渲染各层读当前值，不缓存旧尺寸。
export let OX = board.H * TW / 2, OY = 120;         // 屏幕原点偏移
export let VIEW_W = (board.W + board.H) * TW / 2;
export let VIEW_H = OY + (board.W + board.H) * TH / 2 + 60;
export function refreshWorldMetrics() {
    const m = board.MARGIN || 0;
    OX = board.H * TW / 2 + m * TW;             // 画外余量：整个世界画布外扩，陆地长到画面边缘外
    OY = 120 + m * TH;
    VIEW_W = (board.W + board.H) * TW / 2 + 2 * m * TW;
    VIEW_H = OY + (board.W + board.H) * TH / 2 + 60 + m * TH;
}
export function gridToScreen(gx, gy) {
    return { x: (gx - gy) * TW / 2 + OX, y: (gx + gy) * TH / 2 + OY };
}

// 地面圆的等距投影采样（等距视角下圆呈椭圆，不能直接 fillCircle）
export function sampleGroundRing(scene, gx, gy, radius, segments) {
    const points = [];
    for (let i = 0; i <= segments; i++) {
        const a = i / segments * Math.PI * 2;
        points.push(scene.groundPoint(gx + Math.cos(a) * radius, gy + Math.sin(a) * radius));
    }
    return points;
}

// 0xRRGGBB 颜色线性插值（渲染平滑过渡用，不影响模拟）
export function lerpColor(from, to, k) {
    const fr = from >> 16 & 255, fg = from >> 8 & 255, fb = from & 255;
    const tr = to >> 16 & 255, tg = to >> 8 & 255, tb = to & 255;
    return (Math.round(fr + (tr - fr) * k) << 16) |
        (Math.round(fg + (tg - fg) * k) << 8) | Math.round(fb + (tb - fb) * k);
}
export const TWO_PI = Math.PI * 2;
// 平滑值噪声：大尺度地形色带（肥沃绿 ↔ 干草黄）用
export function makeNoise(seed) {
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
