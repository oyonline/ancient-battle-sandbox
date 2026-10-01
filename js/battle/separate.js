// ==================== 碰撞排斥与推挤传导（纯模拟） ====================
// 从 game.js IsoBattleScene 抽出（第 0 批后续拆分：separate）。
// 排斥保证不重叠；传导让"有前进意图的一方"把对方顶向自己的方向。
// 铁律：不 import Phaser；scene 只作数据入口。

import { board } from '../board.js';
import { Terrain } from '../terrain.js';
import { CombatRules } from '../combat.js';
import { clamp } from '../units.js';

export function quantizePosition(value, extent) {
    const center = extent / 2, offset = value - center;
    // 以地图中心为原点，正负半格都向外舍入；1e-10格容差吸收浮点半格噪声。
    return center + Math.sign(offset) * Math.floor(Math.abs(offset) * 1e6 + 0.5001) / 1e6;
}

export function separate(scene, dt) {

        const units = scene._aliveArr;
        const R = CombatRules.maxContactDistance(units);
        const k = Math.min(0.35, dt * 14);        // 卡顿帧不再一次性大步推移
        const cap = 0.9 * dt;                     // 推挤传导每帧限幅（帧率无关，多人同挤也不瞬移）
        for (const unit of units) { unit.separateX = 0; unit.separateY = 0; unit.pshX = 0; unit.pshY = 0; unit.touchGuard = false; }
        // 守阵锚域：墙前 1.6 格内是刚体地带——人流压力到此为止，架好的墙顶不穿、缝里也灌不进人。
        for (const guard of units) {
            if (guard.garrisonTowerId || guard.tacticalRole !== 'guard') continue;
            scene.forEachNear(guard.gx, guard.gy, 1.6, o => { o.touchGuard = true; });
        }
        for (let i = 0; i < units.length; i++) {
            const a = units[i];
            if (a.dead || a.garrisonTowerId) continue;
            scene.forEachNear(a.gx, a.gy, R, b => {
                if (b.dead || b.id <= a.id) return;          // 每对只处理一次
                const dx = b.gx - a.gx, dy = b.gy - a.gy;
                const d2 = dx * dx + dy * dy;
                const contact = CombatRules.contactDistance(a, b);
                if (d2 < contact * contact && d2 > 0.0001) {
                    const d = Math.sqrt(d2);
                    const push = (contact - d) * k;
                    const aWeight = a.guardReady && a.moraleState !== 'routing' ? 0.25 : 1;
                    const bWeight = b.guardReady && b.moraleState !== 'routing' ? 0.25 : 1;
                    const totalWeight = aWeight + bWeight;
                    const nx = dx / d, ny = dy / d;
                    a.separateX -= nx * push * aWeight / totalWeight; a.separateY -= ny * push * aWeight / totalWeight;
                    b.separateX += nx * push * bWeight / totalWeight; b.separateY += ny * push * bWeight / totalWeight;
                    // 推挤传导是"动量放大器"：只对敌对接触对生效——
                    // 有前进意图的一方把挡路的敌人顶向自己前进的方向，接触线才会呼吸进退。
                    // 同队之间不传导（后排顶前排靠挡路规则自然收力，行军队列不压缩、贴墙人柱不挤入）；
                    // 被挡停的单位（moving=false）和守阵/锚域内单位都不受力，架好的墙顶不穿。
                    if ((a.pressX || a.pressY) && a.team !== b.team && b.tacticalRole !== 'guard' && b.moving) { b.pshX += a.pressX * push * 0.5; b.pshY += a.pressY * push * 0.5; }
                    if ((b.pressX || b.pressY) && b.team !== a.team && a.tacticalRole !== 'guard' && a.moving) { a.pshX += b.pressX * push * 0.5; a.pshY += b.pressY * push * 0.5; }
                }
            });
        }
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            if (u.garrisonTowerId) continue;
            // 推挤传导限幅后并入位移（cap 见上）；贴墙者被锚定，不吃传导位移
            const l = u.touchGuard ? 0 : Math.hypot(u.pshX, u.pshY);
            const px = l > 1e-6 ? u.pshX * (l > cap ? cap / l : 1) : 0;
            const py = l > 1e-6 ? u.pshY * (l > cap ? cap / l : 1) : 0;
            // 对称累计推开，并消除长时间镜像模拟中的浮点方向偏差。
            const beforeX = u.gx, beforeY = u.gy;
            const correction = Terrain.clipMotion(scene.battleOptions.terrain, u.gx, u.gy,
                u.separateX + px, u.separateY + py, CombatRules.bodyRadius(u));
            u.gx = quantizePosition(clamp(u.gx + correction.x, 0.6, board.W - 0.6), board.W);
            u.gy = quantizePosition(clamp(u.gy + correction.y, 0.6, board.H - 0.6), board.H);
            // 保存实际纠偏量（含边界截断），供下一步架枪判定扣除。
            u.separateX = u.gx - beforeX; u.separateY = u.gy - beforeY;
        }
    }
