// 覆盖层渲染：战术路线图/下令浮字/小地图/领土覆盖/旗帜/辎重车（场景与渲染层经单行委托调用）。
import { board } from '../board.js';
import { Terrain } from '../terrain.js';
import { clamp, dist } from '../units.js';
import { TW, TH, OX, OY, gridToScreen, sampleGroundRing, lerpColor } from './metrics.js';

export class OverlayRenderer {
    constructor(scene) { this.scene = scene; }

    drawTactics() {
        if (!this.scene.tactics) return;
        if (!this.scene.tacticsGfx) this.scene.tacticsGfx = this.scene.add.graphics().setDepth(12000);
        const g = this.scene.tacticsGfx;
        g.clear();
        for (const ground of Object.values(this.scene.tactics.groundGuards)) {
            if (!ground.members.some(unit => this.scene.tactics.active(unit))) continue;
            if (Terrain.isNaturalSlope(this.scene.battleOptions.terrain)) continue;
            // 一条低透明度守区边界；不为每位士兵叠加追击圈。
            const points = Array.from({ length: 25 }, (_, index) => {
                const angle = index / 24 * Math.PI * 2;
                return this.scene.groundPoint(ground.cx + Math.cos(angle) * 8, ground.cy + Math.sin(angle) * 10);
            });
            g.lineStyle(2, ground.team === 'blue' ? 0x6abaff : 0xff8b77, 0.25);
            points.forEach((point, index) => {
                if (index) g.lineBetween(points[index - 1].x, points[index - 1].y, point.x, point.y);
            });
            const flag = this.scene.groundPoint(ground.cx, ground.cy);
            g.lineStyle(2, ground.team === 'blue' ? 0x6abaff : 0xff8b77, 0.7);
            g.lineBetween(flag.x, flag.y, flag.x, flag.y - 35);
            g.lineBetween(flag.x, flag.y - 35, flag.x + 16, flag.y - 29);
            g.lineBetween(flag.x + 16, flag.y - 29, flag.x, flag.y - 23);
        }
        for (const formation of Object.values(this.scene.tactics.formations)) {
            const h = formation.half + 0.42;
            const corners = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y]) => this.scene.groundPoint(formation.cx + x, formation.cy + y));
            g.lineStyle(2, formation.team === 'blue' ? 0x6abaff : 0xff8b77, 0.45);
            corners.forEach((p, i) => g.lineBetween(p.x, p.y, corners[(i + 1) % 4].x, corners[(i + 1) % 4].y));
            for (const guard of formation.members) {
                if (!this.scene.tactics.active(guard) || (guard.formationSlot.rank > 1 && !guard.guardEngaging)) continue;
                const a = this.scene.groundPoint(guard.gx, guard.gy);
                const length = guard.guardReady ? 1.15 : 0.8;
                const b = this.scene.groundPoint(guard.gx + guard.guardFacingX * length, guard.gy + guard.guardFacingY * length);
                g.lineStyle(2, guard.guardReady ? 0x9de3ef : 0xe2b65b, guard.guardReady ? 0.7 : 0.35);
                g.lineBetween(a.x, a.y - 7, b.x, b.y - 7);
            }
        }
        for (const group of Object.values(this.scene.tactics.groups)) {
            // 青绿色脚圈标出仍在后方接应的预备队；投入前线后取消待命标记。
            for (const unit of group.reserve || []) {
                if (!this.scene.tactics.active(unit) || unit.tacticalRole !== 'reserve' || unit.reserveCommitted) continue;
                const p = this.scene.groundPoint(unit.gx, unit.gy);
                g.lineStyle(1.8, 0x72e0ad, 0.85);
                g.strokeEllipse(p.x, p.y, 23, 12);
            }
            const reserve = (group.safeReserve || []).filter(unit => this.scene.tactics.active(unit) &&
                unit.moraleState === 'steady' && !unit.reserveCommitted && this.scene.tactics.safeAt(unit.team, unit.gx, unit.gy));
            // 旗只落在真实安全接应者身旁，预备队离开后不保留虚假的恢复点。
            const anchors = [];
            for (const unit of reserve) {
                if (anchors.some(other => dist(unit, other) <= 8)) continue;
                if (reserve.filter(other => dist(unit, other) <= 4).length >= 3) anchors.push(unit);
            }
            for (const anchor of anchors) {
                const p = this.scene.groundPoint(anchor.gx, anchor.gy);
                const pulse = 0.7 + Math.sin(this.scene.simulationTime * 0.004) * 0.15;
                g.lineStyle(2, 0x72e0ad, pulse);
                g.strokeEllipse(p.x, p.y, 78, 38);
                g.lineBetween(p.x, p.y, p.x, p.y - 46);
                g.lineBetween(p.x, p.y - 46, p.x + 20, p.y - 40);
                g.lineBetween(p.x + 20, p.y - 40, p.x, p.y - 33);
            }
            const wing = group.flank.filter(unit => this.scene.tactics.active(unit));
            if (!wing.length) continue;
            const leader = wing[Math.floor(wing.length / 2)];
            if (!group.launched) {
                const points = [{ gx: leader.gx, gy: leader.gy }, ...leader.route.slice(leader.routeIndex)].map(p => this.scene.groundPoint(p.gx, p.gy));
                g.lineStyle(3, 0xf6cc68, 0.65);
                points.forEach((p, i) => {
                    if (i) g.lineBetween(points[i - 1].x, points[i - 1].y, p.x, p.y);
                    if (i === points.length - 1) g.strokeCircle(p.x, p.y, 5);
                });
            }
            for (const unit of wing) {
                const p = this.scene.groundPoint(unit.gx, unit.gy);
                g.lineStyle(1.5, 0xf6cc68, 0.7);
                g.strokeEllipse(p.x, p.y, 21, 10);
            }
        }
    }

    // 下令浮字（纯视觉，不入模拟/哈希）：营中心或指定点上浮短文字后淡出
    orderFlash(text, battalion, color) {
        const center = battalion.center();
        if (!center) return;
        const point = this.scene.groundPoint(center.gx, center.gy);
        this.spawnOrderText(text, point.x, point.y - 40, color);
    }

    spawnOrderText(text, x, y, color) {
        if (!this.scene.add?.text || !this.scene.tweens?.add) return;   // 无渲染环境（测试）跳过
        const label = this.scene.add.text(x, y, text, {
            fontFamily: '"PingFang SC", sans-serif', fontSize: '26px', fontStyle: 'bold',
            color, stroke: '#000000', strokeThickness: 5
        }).setOrigin(0.5).setDepth(160000);
        this.scene.tweens.add({
            targets: label, y: y - 46, alpha: 0,
            duration: 1100, ease: 'Cubic.Out',
            onComplete: () => label.destroy()
        });
    }

    // ---------------- 领土小地图（屏幕空间，点击/拖动直接跳镜头） ----------------
    buildMinimap() {
        const cam = this.scene.cameras.main;
        const h = 108, w = Math.round(h * board.W / board.H);
        const x = cam.width - w - 14, y = 74;
        const gfx = this.scene.add.graphics().setScrollFactor(0).setDepth(150010);
        const zone = this.scene.add.rectangle(x + w / 2, y + h / 2, w, h, 0x000000, 0.01)
            .setOrigin(0.5).setScrollFactor(0).setDepth(150011).setInteractive();
        const jump = pointer => {
            const { x, y } = this.scene._minimap;
            const gx = clamp((pointer.x - x) / w * board.W, 0, board.W);
            const gy = clamp((pointer.y - y) / h * board.H, 0, board.H);
            const world = gridToScreen(gx, gy);
            cam.centerOn(world.x, world.y);
        };
        zone.on('pointerdown', (pointer, _x, _y, event) => { event.stopPropagation(); jump(pointer); });
        zone.on('pointermove', (pointer, _x, _y, event) => {
            if (pointer.isDown) { event.stopPropagation(); jump(pointer); }
        });
        zone.on('pointerup', (_pointer, _x, _y, event) => event.stopPropagation());
        this.scene._minimap = { gfx, zone, x, y, w, h };
    }

    destroyMinimap() {
        if (!this.scene._minimap) return;
        this.scene._minimap.gfx.destroy();
        this.scene._minimap.zone.destroy();
        this.scene._minimap = null;
    }

    updateTerritoryOverlay() {
        if (!this.scene._minimap) this.buildMinimap();
        // scrollFactor=0 cancels panning, but Phaser still zooms about the camera
        // origin. Invert BOTH the zoom and its origin shift for a fixed-size HUD.
        const cam = this.scene.cameras.main, mini = this.scene._minimap;
        const scale = 1 / cam.zoom;
        const ox = cam.width * cam.originX * (1 - scale), oy = cam.height * cam.originY * (1 - scale);
        mini.x = cam.width - mini.w - 14;
        mini.gfx.setScale(scale).setPosition(ox, oy);
        mini.zone.setScale(scale).setPosition(ox + (mini.x + mini.w / 2) * scale, oy + (mini.y + mini.h / 2) * scale);
        const now = this.scene.time?.now || this.scene.simulationTime;
        if (now - (this.scene._minimapAt || 0) < 120) return;
        this.scene._minimapAt = now;
        const { gfx: g, x, y, w, h } = this.scene._minimap;
        const RED = 0xff5b5b, BLUE = 0x57a0ff, NEUTRAL = 0xd8d2c0;
        g.clear();
        // 底板与边框
        g.fillStyle(0x343724, 0.94);
        g.fillRect(x - 4, y - 4, w + 8, h + 8);
        g.lineStyle(2, 0xa68c56, 0.95);
        g.strokeRect(x - 4, y - 4, w + 8, h + 8);
        g.fillStyle(0x697343, 1); g.fillRect(x, y, w, h);
        const geometry = Terrain.geometry(this.scene.battleOptions.terrain);
        for (const rect of [...geometry.blockers, ...geometry.zones]) {
            const colors = { water: 0x3b7581, shallow: 0x83a194, bridge: 0xb79962, forest: 0x314d2b, rock: 0x8a8878 };
            if (!colors[rect.kind]) continue;
            g.fillStyle(colors[rect.kind], 0.95);
            g.fillRect(x + rect.x1 / board.W * w, y + rect.y1 / board.H * h,
                (rect.x2 - rect.x1) / board.W * w, (rect.y2 - rect.y1) / board.H * h);
        }
        // 双方出兵线提示带
        g.fillStyle(0xff5555, 0.10);
        g.fillRect(x, y, w * (12 / board.W), h);
        g.fillStyle(0x5599ff, 0.10);
        g.fillRect(x + w * (1 - 12 / board.W), y, w * (12 / board.W), h);
        // 单位点（超采样抽稀，保持小地图常 60fps）
        const step = this.scene._aliveArr.length > 700 ? 2 : 1;
        for (let i = 0; i < this.scene._aliveArr.length; i += step) {
            const u = this.scene._aliveArr[i];
            g.fillStyle(u.team === 'red' ? RED : BLUE, 0.9);
            g.fillRect(x + u.gx / board.W * w - 0.8, y + u.gy / board.H * h - 0.8, 1.8, 1.8);
        }
        // 旗帜（争夺时呼吸闪烁）
        for (const flag of this.scene.flags) {
            const color = flag.owner === 'red' ? RED : flag.owner === 'blue' ? BLUE : NEUTRAL;
            const fx = x + flag.gx / board.W * w, fy = y + flag.gy / board.H * h;
            g.fillStyle(color, flag.contested ? 0.6 + 0.4 * Math.sin(this.scene.simulationTime * 0.02) : 1);
            g.fillCircle(fx, fy, 2.6);
            g.lineStyle(1, 0x0c141c, 0.8);
            g.strokeCircle(fx, fy, 2.6);
        }
        // 镜头视口（世界四角逆投影成网格四边形）
        const v = this.scene.cameras.main.worldView;
        const inv = (sx, sy) => {
            const dx = (sx - OX) / (TW / 2), dy = (sy - OY) / (TH / 2);
            return { gx: (dx + dy) / 2, gy: (dy - dx) / 2 };
        };
        const corners = [inv(v.x, v.y), inv(v.right, v.y), inv(v.right, v.bottom), inv(v.x, v.bottom)];
        g.lineStyle(1.5, 0xf6e6b0, 0.9);
        g.beginPath();
        corners.forEach((c, i) => {
            const px = x + clamp(c.gx / board.W, 0, 1) * w, py = y + clamp(c.gy / board.H, 0, 1) * h;
            if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
        });
        g.closePath();
        g.strokePath();

        // 营队选中态与集结旗使用世界空间层，不能画进屏幕空间小地图。
        if (!this.scene.selectionGfx) this.scene.selectionGfx = this.scene.add.graphics().setDepth(12050);
        const sel = this.scene.selectionGfx;
        sel.clear();
        // 己方集结旗标记（敌方集结点属情报，不绘制）
        const myRally = this.scene.territory.rally[this.scene.netMySide || 'red'];
        if (myRally) {
            const base = this.scene.groundPoint(myRally.gx, myRally.gy);
            const pulse = 0.7 + 0.3 * Math.sin(this.scene.simulationTime * 0.004);
            sel.fillStyle(0x1c1812, 0.8);
            sel.fillEllipse(base.x, base.y + 2, 14, 7);
            sel.lineStyle(3, 0x3a2f1b, 0.95);
            sel.lineBetween(base.x, base.y, base.x, base.y - 38);
            sel.fillStyle(this.scene.netMySide === 'blue' ? 0x57a0ff : 0xff5b5b, pulse);
            sel.fillTriangle(base.x, base.y - 38, base.x + 22, base.y - 31, base.x, base.y - 24);
        }
        // 营队选中态：成员金圈 + 营令指向线（世界空间层，随镜头缩放）
        const selected = this.scene.selectedBattalion;
        if (selected && selected.members.length) {
            sel.lineStyle(2.5, 0xffe49a, 0.95);
            for (const u of selected.aliveMembers()) {
                const p = this.scene.groundPoint(u.gx, u.gy);
                sel.strokeEllipse(p.x, p.y, 30, 15);
            }
            const center = selected.center();
            if (center) {
                const from = this.scene.groundPoint(center.gx, center.gy);
                let toPoint = null, color = 0xffe49a;
                if (selected.retreat) { toPoint = this.scene.battalions.homeRally(selected.team); color = 0x8cdaff; }
                else if (selected.orderPoint) { toPoint = selected.orderPoint; color = 0x9de3af; }
                else if (selected.orderFlag != null && this.scene.flags[selected.orderFlag]) {
                    toPoint = this.scene.flags[selected.orderFlag]; color = 0xf6cc68;
                }
                if (toPoint) {
                    const to = this.scene.groundPoint(toPoint.gx, toPoint.gy);
                    sel.lineStyle(3, color, 0.8);
                    sel.lineBetween(from.x, from.y, to.x, to.y);
                    sel.strokeCircle(to.x, to.y, 6);
                }
            }
        }
    }

    drawFlags() {
        if (!this.scene.flags) return;
        if (!this.scene.flagGfx) this.scene.flagGfx = this.scene.add.graphics().setDepth(11990);
        const g = this.scene.flagGfx;
        g.clear();
        const t = this.scene.simulationTime;
        for (const flag of this.scene.flags) {
            const base = this.scene.groundPoint(flag.gx, flag.gy);
            const RED = 0xff5b5b, BLUE = 0x57a0ff, NEUTRAL = 0xd8d2c0;
            const targetColor = flag.owner === 'red' ? RED : flag.owner === 'blue' ? BLUE : NEUTRAL;
            // 旗面显示色向目标色平滑过渡（归属切换不再是瞬变）
            if (flag.displayColor == null) flag.displayColor = targetColor;
            flag.displayColor = lerpColor(flag.displayColor, targetColor, 0.10);
            const color = flag.displayColor;

            // ---- 地面争夺圈：等距椭圆（groundPoint 采样），归属染色，争夺时呼吸 ----
            const breathe = flag.contested ? 0.5 + 0.5 * Math.sin(t * 5) : 0;
            const ringPts = sampleGroundRing(this.scene, flag.gx, flag.gy, 2.8, 26);
            g.fillStyle(color, flag.contested ? 0.10 + 0.08 * breathe : 0.13);
            g.fillPoints(ringPts, true);
            g.lineStyle(2, color, flag.contested ? 0.5 + 0.35 * breathe : 0.45);
            g.strokePoints(ringPts, true, true);

            // ---- 占领/易主的扩散脉冲（1.2 秒）----
            if (flag.pulseAt != null && t - flag.pulseAt < 1.2) {
                const k = (t - flag.pulseAt) / 1.2;
                const pulsePts = sampleGroundRing(this.scene, flag.gx, flag.gy, 2.8 + k * 5, 26);
                g.lineStyle(4, color, 0.75 * (1 - k));
                g.strokePoints(pulsePts, true, true);
            }

            // ---- 旗杆底座 + 加高旗杆 + 杆顶色球 ----
            const POLE = 46;
            g.fillStyle(0x2c2418, 0.85);
            g.fillEllipse(base.x, base.y + 2, 15, 7);
            g.lineStyle(3, 0x3a2f1b, 0.95);
            g.lineBetween(base.x, base.y, base.x, base.y - POLE);
            g.fillStyle(color, 0.95);
            g.fillCircle(base.x, base.y - POLE - 3, 3.5);

            // ---- 旗面（加大）：波浪飘动 + 争夺高频抖动 + 描边 ----
            const wave = Math.sin(t * 3 + flag.gy) * 3;
            const jitter = flag.contested ? Math.sin(t * 22) * 1.6 : 0;
            const tipX = base.x + 27 + wave + jitter;
            const tipY = base.y - POLE - 1 + Math.sin(t * 3 + flag.gy + 1) * 1.2;
            const tailY = base.y - POLE + 18 + wave * 0.3;
            g.fillStyle(color, flag.contested ? 0.75 + 0.2 * breathe : 0.95);
            g.fillTriangle(base.x, base.y - POLE, tipX, tipY, base.x, tailY);
            g.lineStyle(2, 0x1c1812, 0.35);
            g.strokeTriangle(base.x, base.y - POLE, tipX, tipY, base.x, tailY);

            // ---- 拔河进度环（杆底，方向着色：红环向红涨、蓝环向蓝涨）----
            if (flag.progress > 0) {
                g.lineStyle(4, RED, 0.95);
                g.beginPath();
                g.arc(base.x, base.y, 11, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * flag.progress);
                g.strokePath();
            } else if (flag.progress < 0) {
                g.lineStyle(4, BLUE, 0.95);
                g.beginPath();
                g.arc(base.x, base.y, 11, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * -flag.progress);
                g.strokePath();
            }
        }
    }

    // ---------------- 护送模式 ----------------
    // 到站/劫持计数与事件；车本体的"有保护才前进"在 updateNormalUnit 的 wagon 特判里。

    drawConvoy() {
        if (!this.scene.convoy) return;
        if (!this.scene.convoyGfx) this.scene.convoyGfx = this.scene.add.graphics().setDepth(11980);
        const g = this.scene.convoyGfx;
        g.clear();
        const c = this.scene.convoy;
        // 路线虚线：出发区沿中线到安全区
        const from = this.scene.groundPoint(9, board.H / 2), to = this.scene.groundPoint(c.goalX + 1.5, board.H / 2);
        g.lineStyle(2.5, 0xf6e6b0, 0.35);
        for (let i = 0; i < 24; i++) {
            const a = i / 24, b = (i + 0.55) / 24;
            g.lineBetween(from.x + (to.x - from.x) * a, from.y + (to.y - from.y) * a,
                from.x + (to.x - from.x) * b, from.y + (to.y - from.y) * b);
        }
        // 终点安全区：绿色半透椭圆 + 框
        const zone = sampleGroundRing(this.scene, c.goalX + 1.5, board.H / 2, 4.5, 26);
        g.fillStyle(0x6fdc7f, 0.14);
        g.fillPoints(zone, true);
        g.lineStyle(2.5, 0x6fdc7f, 0.65);
        g.strokePoints(zone, true, true);
        // 劫持进度环：蓝方占住车身时在车底拉起（拉满即被劫走）
        for (const wagon of c.wagons) {
            if (wagon.withdrawn || wagon.dead || !(wagon.hijack > 0.02)) continue;
            const base = this.scene.groundPoint(wagon.gx, wagon.gy);
            const ring = sampleGroundRing(this.scene, wagon.gx, wagon.gy, 2.3, 22);
            g.lineStyle(3.5, 0x57a0ff, 0.9);
            g.beginPath();
            g.arc(base.x, base.y + 4, 14 * 0.62, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * wagon.hijack);
            g.strokePath();
            g.lineStyle(1.5, 0xffffff, 0.25);
            g.strokePoints(ring, true, true);
        }
    }

    // ---------------- 胜负 ----------------
}
