// 单位精灵轮廓工具：接地基准/逐帧对齐/骑兵朝向档位（纯数据与纯函数，不碰 Phaser）。
import { TWO_PI } from './metrics.js';

// ==================== 接地基准表（素材源图像素，源图高 156） ====================
// AI 出图的底部留白每张都不一样（10~34px），若直接以贴图底边当脚底，
// 角色就会悬在影子上面 → 飘。这里把每个兵种的脚底位置量出来，统一压到地面线。
// pad = 贴图底边 → 最低脚底的留白。注意骑兵是奔姿、四条腿只有一条落地，
//       所以取“最低的实质内容行”，不能取最宽的一行（那会落在另外三条抬起的腿上，差 16px）。
// dx  = 脚掌落地处相对图心的横向偏移（骑兵马头前伸，脚掌明显偏左，影心要跟着走）；
// w/h = 脚掌投影尺寸（等距视角固定 2:1）。跑 tools/measure_foot.py 可重新量。
export const FOOT = {
    infantry: { pad: 18, dx:   2, w: 72, h: 35 },
    pikeman:  { pad: 34, dx:  -7, w: 63, h: 31 },
    archer:   { pad: 11, dx:  -6, w: 67, h: 33 },
    wagon:    { pad:  6, dx:   0, w: 64, h: 30 },
    worker:   { pad: 14, dx:  -1, w: 58, h: 28 },
    medic:    { pad: 14, dx:  -1, w: 58, h: 28 },
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
export const ANIM_ALIGN = {
    infantry: { walk: [[1, 0], [-10, 4], [-9, 3], [-30, 4]], attack: [[5, 0], [10, 0], [-8, 0], [-14, 0]] },
    pikeman:  { walk: [[0, -1], [-1, -2], [-3, -3], [-7, -3]], attack: [[1, 0], [1, 0], [5, 0], [-8, 0]] },
    archer:   { walk: [[0, -3], [-13, 9], [-14, 0], [-19, 0]], attack: [[7, 0], [-11, 0], [-20, 0], [12, 0]] },
    worker:   { walk: [[0,0],[0,0],[0,0],[0,0]], attack: [[0,0],[0,0],[0,0],[0,0]] },
    medic:    { walk: [[0,0],[0,0],[0,0],[0,0]], attack: [[0,0],[0,0],[0,0],[0,0]] },
    cavalry: {
        east:      { walk: [[0, -1], [-9, 0], [-6, 0], [-14, 1]], attack: [[1, 0], [-6, 0], [2, 0], [-12, 0]] },
        southeast: { walk: [[0, 0], [-6, -1], [-16, -8], [-8, -2]], attack: [[-1, 0], [-3, 0], [-2, 0], [-10, 0]] },
        south:     { walk: [[0, 0], [-11, 1], [-5, 0], [-9, 0]], attack: [[16, 0], [2, 0], [-23, 0], [-11, 0]] },
        northeast: { walk: [[0, 0], [-10, 5], [-13, 5], [-14, -7]], attack: [[-2, 0], [-11, 0], [-6, 0], [-16, 0]] },
        north:     { walk: [[0, 0], [-17, 1], [-23, -2], [-30, 1]], attack: [[0, 0], [-19, 0], [-21, 0], [-31, 0]] }
    }
};
export const ANIM_ALIGN_K = 1;   // 对齐补正强度：1 = 全量纠正抖动，0 = 关闭（保留原始位移）

export const CAVALRY_HEADINGS = ['east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north', 'northeast'];
export const CAVALRY_HEADING_INDEX = {
    east: 0, southeast: 1, south: 2, southwest: 3,
    west: 4, northwest: 5, north: 6, northeast: 7
};
export const CAVALRY_PROFILE = {
    east: 'east', southeast: 'southeast', south: 'south', southwest: 'southeast',
    west: 'east', northwest: 'northeast', north: 'north', northeast: 'northeast'
};
export const CAVALRY_PROFILE_SUFFIX = {
    east: '', southeast: '_down', south: '_south', northeast: '_northeast', north: '_north'
};
export const CAVALRY_FLIPPED = new Set(['west', 'southwest', 'northwest']);
export const CAVALRY_DIR_STEP = Math.PI / 4;
export const CAVALRY_DIR_HYSTERESIS = Math.PI / 24; // 7.5°；当前方向保持到中心角 ±30°

export function cavalryProfile(heading) {
    return CAVALRY_PROFILE[heading] || 'east';
}

export function cavalryRenderSign(heading) {
    return CAVALRY_FLIPPED.has(heading) ? -1 : 1;
}

export function cavalryHeadingFromMotion(dx, dy, current = 'east') {
    let angle = Math.atan2(dy, dx);
    if (angle < 0) angle += TWO_PI;
    const currentIndex = CAVALRY_HEADING_INDEX[current] ?? 0;
    const currentAngle = currentIndex * CAVALRY_DIR_STEP;
    let distance = Math.abs(angle - currentAngle);
    if (distance > Math.PI) distance = TWO_PI - distance;
    if (distance <= CAVALRY_DIR_STEP / 2 + CAVALRY_DIR_HYSTERESIS) return current;
    return CAVALRY_HEADINGS[Math.round(angle / CAVALRY_DIR_STEP) & 7];
}

export function unitVisualDirections(type) {
    return type === 'cavalry' ? ['east', 'southeast', 'south', 'northeast', 'north'] : ['side'];
}

export function footProfile(type, visualDir = 'side') {
    return type === 'cavalry' ? FOOT.cavalry[cavalryProfile(visualDir)] : FOOT[type];
}

export function animAlignProfile(type, visualDir = 'side') {
    return type === 'cavalry' ? ANIM_ALIGN.cavalry[cavalryProfile(visualDir)] : ANIM_ALIGN[type];
}

export function shadowTextureKey(team, type, visualDir = 'side') {
    const direction = type === 'cavalry' ? `-${cavalryProfile(visualDir)}` : '';
    return `shadow-${team}-${type}${direction}`;
}
