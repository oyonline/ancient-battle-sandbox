// 覆盖层渲染：战术路线图/下令浮字/小地图/领土覆盖/旗帜/辎重车（场景与渲染层经单行委托调用）。
import { board } from '../board.js';
import { Terrain } from '../terrain.js';
import { clamp, dist } from '../units.js';
import { TW, TH, OX, OY, gridToScreen, sampleGroundRing, lerpColor } from './metrics.js';
import { TERRITORY } from '../battle/economy.js';
import { traitOf } from '../battle/site-traits.js';
import { ownerMark, ownerDisplayColor, sideLabel, teamColor, canonicalOf, RELATIONS_MUTUAL } from '../factions.js';

// Match the compact economic strip without measuring DOM layout every frame.
const minimapTop = width => width <= 600 ? 212 : width <= 900 ? 162 : 74;

// ---------------- 据点特色文案（参数与措辞的唯一来源：js/battle/site-traits.js） ----------------
// 玩家语言把两件事分开讲：占领后能拿到什么 / 地形本来就有但双方都吃到的效果。
// 大本营（siteId === 'home'）没有旗位，任何地方都不显示据点特色。
// 归属标记/称呼按战场关系表取：多人同盟显示联军标记与「红蓝联军」，单阵营显示队标队名。
// 需要 scene 才能判断同盟，故这些函数都接收 scene。
function siteOwnerMark(scene, owner) { return owner == null ? '⚪' : (ownerMark(scene, owner) ?? '⚪'); }
function siteOwnerName(scene, owner) { return owner == null ? '中立' : sideLabel(scene, owner); }
const NEUTRAL_CUE = '（中立）';
const NEUTRAL_CUE_FULL = '（中立，占领后归占领方）';
// 奖励本身就长（路口）的据点只标"中立"，不再追加解释，避免旗标被撑得过宽。
const NEUTRAL_CUE_MAX = 36;

// 只有有旗位、有角色的据点才有特色；大本营恒为 null。
function siteTraitOf(flag) {
    return flag && flag.siteId !== 'home' ? traitOf(flag.role) : null;
}

// "工事：本点建筑受到伤害 −10%" → "工事 · 本点建筑受到伤害 −10%"（只换标点，不改措辞）。
function traitRewardBrief(role) {
    const trait = traitOf(role);
    if (!trait) return '';
    const at = trait.reward.indexOf('：');
    return at < 0 ? trait.reward : `${trait.reward.slice(0, at)} · ${trait.reward.slice(at + 1)}`;
}

// 旗标/据点行只在归属或角色变化时需要重写文字，签名比对代替每帧重建。
export function flagSiteSignature(flag) {
    return flag ? `${flag.name}|${flag.role ?? ''}|${flag.owner ?? 'none'}` : '';
}

// 旗标三行：①归属 + 军费 ②占领后归谁、拿到什么 ③地形原本就有的效果。
export function flagLabelText(scene, flag) {
    if (!flag) return '';
    const lines = [`${siteOwnerMark(scene, flag.owner)} ${flag.name} · 军费 +${TERRITORY.FLAG_INCOME}/秒`];
    const trait = siteTraitOf(flag);
    if (!trait) return lines[0];
    const owned = flag.owner ?? null;
    let capture = `占领：${owned ? siteOwnerName(scene, owned) : ''}${traitRewardBrief(flag.role)}`;
    if (!owned) capture += capture.length + NEUTRAL_CUE_FULL.length <= NEUTRAL_CUE_MAX ? NEUTRAL_CUE_FULL : NEUTRAL_CUE;
    lines.push(capture, `地形：${trait.terrain}`);
    return lines.join('\n');
}

// 据点列表一行（营队夺旗按钮）：归属 + 占领奖励；悬停说明给全奖励、生效条件与地形。
export function traitSiteRow(scene, flag) {
    const sig = flagSiteSignature(flag);
    if (!flag) return { sig, text: '', title: '' };
    const owner = `${siteOwnerMark(scene, flag.owner)}${siteOwnerName(scene, flag.owner)}`;
    const trait = siteTraitOf(flag);
    const text = `⚑ ${flag.name} · ${owner}${trait ? ` · ${traitRewardBrief(flag.role)}` : ''}`;
    const title = [`${flag.name} · ${owner}`];
    if (trait) title.push(`占领奖励：${trait.reward}`, `生效条件：${trait.condition}`, `地形：${trait.terrain}`);
    return { sig, text, title: title.join('\n') };
}

export class OverlayRenderer {
    constructor(scene) {
        this.scene = scene;
        this.flagGeometry = new WeakMap();
        this.battalionMarkers = new Map();
        this.markerRects = [];          // 营旗世界空间命中矩形（营旗可见时维护）
        this._markerHoverId = null;     // 悬停预览的营（仅本地高亮）
        this._markerPaintSeq = 0;       // 营旗绘制序：与 label 的 display list 插入序一致
        this.previewBattleId = scene.battleId;
        scene.events?.once('shutdown', () => {
            this.clearFlagLabels();
            this.clearBattalionMarkers();
            this.previewGfx?.destroy();
            this.previewGfx = null;
        });
    }

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
        const x = cam.width - w - 14, y = minimapTop(cam.width);
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
        // 手势归属由按下位置决定：只有在小地图上按下的指针才能驱动跳镜头——
        // 战场拖动经过小地图（isDown 但未在此按下）不被抢走。抬起、区域外释放、
        // 失焦、真实按钮已全部抬起（buttons=0，如窗外释放后 isDown 残留）都
        // 终止手势，避免残留拖动状态（下一次手势误判归属或持续跳镜头）。
        const release = pointer => {
            if (this.scene._minimapGesture === pointer.id) this.scene._minimapGesture = null;
        };
        zone.on('pointerdown', (pointer, _x, _y, event) => {
            event.stopPropagation();
            this.scene._minimapGesture = pointer.id;
            jump(pointer);
        });
        zone.on('pointermove', (pointer, _x, _y, event) => {
            if (this.scene._minimapGesture !== pointer.id) return;   // 非本手势不抢
            if ((pointer.event?.buttons ?? 1) === 0) { release(pointer); return; }
            event.stopPropagation();
            jump(pointer);
        });
        zone.on('pointerup', (pointer, _x, _y, event) => { release(pointer); event.stopPropagation(); });
        this._minimapRelease = release;
        this.scene.input.on('pointerup', release);
        this.scene.input.on('pointerupoutside', release);
        this._minimapBlur = () => { this.scene._minimapGesture = null; };
        this.scene.game?.events?.on('blur', this._minimapBlur);
        this.scene._minimap = { gfx, zone, x, y, w, h };
    }

    destroyMinimap() {
        this.clearFlagLabels();
        this.clearBattalionMarkers();
        if (this._minimapRelease) {
            this.scene.input.off('pointerup', this._minimapRelease);
            this.scene.input.off('pointerupoutside', this._minimapRelease);
            this._minimapRelease = null;
        }
        if (this._minimapBlur) {
            this.scene.game?.events?.off('blur', this._minimapBlur);
            this._minimapBlur = null;
        }
        this.scene._minimapGesture = null;
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
        mini.y = minimapTop(cam.width);
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
        // 双方出兵线提示带（合作模式再加一条黑方南侧出兵带）
        g.fillStyle(0xff5555, 0.10);
        g.fillRect(x, y, w * (12 / board.W), h);
        g.fillStyle(0x5599ff, 0.10);
        g.fillRect(x + w * (1 - 12 / board.W), y, w * (12 / board.W), h);
        if ((this.scene.activeTeams || []).includes('black')) {
            g.fillStyle(0x8a8a96, 0.12);
            g.fillRect(x, y + h * (1 - 12 / board.H), w, h * (12 / board.H));
        }
        // 单位点（超采样抽稀，保持小地图常 60fps）
        const step = this.scene._aliveArr.length > 700 ? 2 : 1;
        for (let i = 0; i < this.scene._aliveArr.length; i += step) {
            const u = this.scene._aliveArr[i];
            g.fillStyle(teamColor(u.team), 0.9);
            g.fillRect(x + u.gx / board.W * w - 0.8, y + u.gy / board.H * h - 0.8, 1.8, 1.8);
        }
        // 旗帜（争夺时呼吸闪烁）
        for (const flag of this.scene.flags) {
            const color = flag.owner == null ? NEUTRAL : (ownerDisplayColor(this.scene, flag.owner) ?? NEUTRAL);
            const fx = x + flag.gx / board.W * w, fy = y + flag.gy / board.H * h;
            g.fillStyle(color, flag.contested ? 0.6 + 0.4 * Math.sin(this.scene.simulationTime * 0.02) : 1);
            g.fillCircle(fx, fy, 2.6);
            g.lineStyle(1, 0x0c141c, 0.8);
            g.strokeCircle(fx, fy, 2.6);
            // 小地图马场：金圈标记
            if (flag.role === 'ranch') {
                g.lineStyle(1.2, 0xe8c766, 0.95);
                g.strokeCircle(fx, fy, 4.4);
            }
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
        this.drawCommandPreview();
        if (!this.scene.flags) { this.clearFlagLabels(); return; }
        this.scene.render?.world?.materials?.updateRiverFlow?.(this.scene.time?.now ?? this.scene.simulationTime);
        this.updateFlagLabels();
        if (!this.scene.flagGfx) this.scene.flagGfx = this.scene.add.graphics().setDepth(11990);
        const g = this.scene.flagGfx;
        g.clear();
        const now = this.scene.simulationTime, t = now / 1000;
        // 拔河进度环方向色：正方向=组 A（二元=红 / 合作=红蓝联军），负方向=组 B（二元=蓝 / 合作=黑）。
        const grabGroups = this.scene.relationGroups || RELATIONS_MUTUAL;
        const pullColorA = ownerDisplayColor(this.scene, canonicalOf(grabGroups[0])) ?? 0xff5b5b;
        const pullColorB = grabGroups[1] ? (ownerDisplayColor(this.scene, canonicalOf(grabGroups[1])) ?? 0x57a0ff) : 0x57a0ff;
        for (const flag of this.scene.flags) {
            const geometry = this.getFlagGeometry(flag);
            const base = geometry.base;
            const RED = 0xff5b5b, BLUE = 0x57a0ff, NEUTRAL = 0xd8d2c0;
            const targetColor = flag.owner == null ? NEUTRAL : (ownerDisplayColor(this.scene, flag.owner) ?? NEUTRAL);
            // 旗面显示色向目标色平滑过渡（归属切换不再是瞬变）
            if (flag.displayColor == null) flag.displayColor = targetColor;
            flag.displayColor = lerpColor(flag.displayColor, targetColor, 0.10);
            const color = flag.displayColor;

            // ---- 地面争夺圈：等距椭圆（groundPoint 采样），归属染色，争夺时呼吸 ----
            const breathe = flag.contested ? 0.5 + 0.5 * Math.sin(t * 5) : 0;
            const ringPts = geometry.ring;
            g.fillStyle(color, flag.contested ? 0.10 + 0.08 * breathe : 0.13);
            g.fillPoints(ringPts, true);
            g.lineStyle(2, color, flag.contested ? 0.5 + 0.35 * breathe : 0.45);
            g.strokePoints(ringPts, true, true);
            // 马场：金色外圈标记骑兵来源点，与普通据点一眼区分
            if (flag.role === 'ranch') {
                g.lineStyle(2, 0xe8c766, 0.6);
                g.strokePoints(geometry.ranchRing, true, true);
            }

            // ---- 占领/易主的扩散脉冲（1.2 秒）----
            if (flag.pulseAt != null && now >= flag.pulseAt && now - flag.pulseAt < 1200) {
                const k = (now - flag.pulseAt) / 1200;
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
                g.lineStyle(4, pullColorA, 0.95);
                g.beginPath();
                g.arc(base.x, base.y, 11, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * flag.progress);
                g.strokePath();
            } else if (flag.progress < 0) {
                g.lineStyle(4, pullColorB, 0.95);
                g.beginPath();
                g.arc(base.x, base.y, 11, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * -flag.progress);
                g.strokePath();
            }
        }
    }

    // Local input acknowledgement only. Its clock is deliberately independent of
    // lockstep/simulation time, so an awaiting network turn cannot freeze the cue.
    drawCommandPreview(now = performance.now()) {
        const scene = this.scene;
        if (this.previewBattleId !== scene.battleId) {
            this.previewBattleId = scene.battleId;
            scene.commandPreview = null;
        }
        const preview = scene.commandPreview;
        const duration = preview?.durationMs ?? 900;
        const age = preview ? now - preview.at : Infinity;
        const valid = scene.battleOptions?.territory && preview && duration > 0 && age >= 0 && age < duration &&
            Number.isFinite(preview.gx) && Number.isFinite(preview.gy) && ['hold', 'rally'].includes(preview.kind);
        if (!valid) {
            if (this.previewDrawn) this.previewGfx?.clear();
            this.previewDrawn = false;
            return;
        }
        if (!this.previewGfx) this.previewGfx = scene.add.graphics().setDepth(12125);
        const g = this.previewGfx, p = age / duration;
        const point = scene.groundPoint(preview.gx, preview.gy);
        const scale = 1 / Math.max(0.15, scene.cameras?.main?.zoom ?? 1);
        const radius = (14 + p * 10) * scale, alpha = 0.95 * (1 - p);
        const rally = preview.kind === 'rally', color = rally ? 0xf6cc68 : 0x9de3af;
        g.clear();
        g.lineStyle(2 * scale, color, alpha);
        g.strokeEllipse(point.x, point.y, radius * 2, radius);
        if (rally) {
            g.lineBetween(point.x, point.y, point.x, point.y - 21 * scale);
            g.fillStyle(color, alpha);
            g.fillTriangle(point.x, point.y - 21 * scale, point.x + 11 * scale,
                point.y - 17 * scale, point.x, point.y - 12 * scale);
        } else {
            g.lineBetween(point.x - 5 * scale, point.y, point.x + 5 * scale, point.y);
            g.lineBetween(point.x, point.y - 3 * scale, point.x, point.y + 3 * scale);
        }
        this.previewDrawn = true;
    }

    getFlagGeometry(flag) {
        const key = `${this.scene.battleOptions?.terrain}:${board.W}:${board.H}:${OX}:${OY}:${flag.gx}:${flag.gy}:${flag.role}`;
        let geometry = this.flagGeometry.get(flag);
        if (!geometry || geometry.key !== key) {
            geometry = { key, base: this.scene.groundPoint(flag.gx, flag.gy),
                ring: sampleGroundRing(this.scene, flag.gx, flag.gy, 2.8, 26),
                ranchRing: flag.role === 'ranch' ? sampleGroundRing(this.scene, flag.gx, flag.gy, 3.6, 26) : null };
            this.flagGeometry.set(flag, geometry);
        }
        return geometry;
    }

    clearBattalionMarkers() {
        for (const marker of this.battalionMarkers.values()) marker.label.destroy();
        this.battalionMarkers.clear();
        this.markerAt = -Infinity;
        this.markerRects = [];       // 营旗命中矩形随旗一并清空
        this._markerHoverId = null;
        this._markerPaintSeq = 0;    // 全部 label 将重建：绘制序与 display list 一并从头计数
    }

    // Strategic zoom shows at most 24 friendly formations, not hundreds of unit
    // labels. Enemy orders and rally destinations are never part of these markers.
    updateBattalionMarkers() {
        const scene = this.scene, zoom = scene.cameras?.main?.zoom ?? 1;
        if (!scene.battleOptions?.territory || !scene.battalions) {
            if (this.battalionMarkers.size) this.clearBattalionMarkers();
            else this.markerRects = [];
            return;
        }
        if (this.markerBattleId !== scene.battleId) {
            this.clearBattalionMarkers();
            this.markerBattleId = scene.battleId;
        }
        if (zoom > 0.55) {
            for (const marker of this.battalionMarkers.values()) marker.label.setVisible(false);
            this.markerAt = -Infinity;
            this.markerRects = [];   // 旗不可见时不是点击入口，避免近景误食点击
            return;
        }
        const now = scene.time?.now ?? scene.simulationTime;
        const selected = scene.selectedBattalion;
        if (now - (this.markerAt ?? -Infinity) < 160 && this.markerZoom === zoom && this.markerSelected === selected) return;
        this.markerAt = now; this.markerZoom = zoom; this.markerSelected = selected;
        const side = scene.netMySide || 'red', active = new Set(), view = scene._view;
        const rects = this.markerRects = [];
        // Keep the selected battalion first when the display cap is reached.
        const battalions = selected ? [selected, ...scene.battalions.battalions.filter(b => b !== selected)] : scene.battalions.battalions;
        for (const battalion of battalions) {
            if (battalion.team !== side || active.size >= 24) continue;
            let count = 0, gx = 0, gy = 0;
            for (const u of battalion.members) {
                if (u.dead || u.withdrawn || u.garrisonTowerId) continue;
                count++; gx += u.gx; gy += u.gy;
            }
            if (!count) continue;
            const p = scene.groundPoint(gx / count, gy / count);
            if (view && (p.x < view.x0 || p.x > view.x1 || p.y < view.y0 || p.y > view.y1)) continue;
            active.add(battalion.id);
            let marker = this.battalionMarkers.get(battalion.id);
            if (!marker) {
                const label = scene.add.text(0, 0, '', { fontFamily: '"PingFang SC", sans-serif', fontSize: '14px',
                    align: 'center', color: '#fff0c7', stroke: '#211d15', strokeThickness: 3,
                    backgroundColor: '#211d15c9', padding: { x: 5, y: 3 } }).setOrigin(0.5, 1).setDepth(12120);
                // 绘制序 = label 创建/重建时的 display list 插入序（同 depth 后插者在上）。
                // 选中重排只改本函数的遍历序，不改显示序——命中决胜必须用 paint（F7/R2）。
                marker = { label, text: null, paint: ++this._markerPaintSeq };
                this.battalionMarkers.set(battalion.id, marker);
            }
            const state = battalion.gathering ? '集结' : battalion.retreat ? '回防' : battalion.orderPoint ? '驻守'
                : battalion.orderFlag != null ? '进军' : '自主作战';
            const text = `⚑ ${battalion.id}营 · ${count}人\n${state}`;
            if (marker.text !== text) { marker.label.setText(text); marker.text = text; }
            marker.label.setPosition(p.x, p.y - 28 / zoom).setScale(1 / zoom).setVisible(true);
            const color = battalion === selected ? '#ffe49a' : battalion.id === this._markerHoverId ? '#fff3cf'
                : side === 'blue' ? '#b9dcff' : '#ffd2c6';
            if (marker.color !== color) { marker.label.setColor(color); marker.color = color; }
            // 世界空间命中矩形（origin 0.5/1、scale 1/zoom）：远景营旗是可靠的大点击入口，
            // 由观察层在抬起时查询，不依赖 Phaser 对象事件顺序。无渲染尺寸时给足默认宽度。
            const w = ((marker.label.width ?? 96) + 12) / zoom, h = ((marker.label.height ?? 40) + 10) / zoom;
            rects.push({ battalion, x: p.x - w / 2, y: p.y - 28 / zoom - h, w, h, paint: marker.paint });
        }
        for (const [id, marker] of this.battalionMarkers) {
            if (active.has(id)) continue;
            marker.label.destroy();
            this.battalionMarkers.delete(id);
        }
    }

    // 营旗命中查询：返回包含该世界坐标的矩形，重叠时取绘制序（paint）最大——即
    // label 在 display list 中插入最晚、显示叠在最上层的旗。命中必须与玩家看见的
    // 层级一致：选中重排与懒重建都只改 paint 对应的显示序，不改本判定（F7/R2）。
    // 只读本地渲染状态，不触碰模拟，也不产生任何网络命令。
    battalionMarkerAt(world) {
        const rects = this.markerRects;
        if (!rects?.length || !Number.isFinite(world?.x) || !Number.isFinite(world?.y)) return null;
        let best = null;
        for (const rect of rects) {
            if (world.x < rect.x || world.x > rect.x + rect.w || world.y < rect.y || world.y > rect.y + rect.h) continue;
            if (!best || (rect.paint ?? -Infinity) > (best.paint ?? -Infinity)) best = rect;
        }
        return best ? { battalion: best.battalion, rect: best } : null;
    }

    // 悬停预览高亮（观察层调用）：只改本地标签颜色，下一轮 160ms 刷新自然复位。
    setBattalionMarkerHover(id) {
        const next = id ?? null;
        if (this._markerHoverId === next) return;
        this._markerHoverId = next;
        const marker = this.battalionMarkers.get(next);
        if (marker) { marker.label.setColor('#fff3cf'); marker.color = '#fff3cf'; }
    }

    clearFlagLabels() {
        for (const label of this.flagLabels || []) label.destroy();
        this.flagLabels = null;
        this.labelFlags = null;
    }

    updateFlagLabels() {
        if (!this.scene.battleOptions?.territory) { this.clearFlagLabels(); return; }
        if (!this.scene.add?.text) return;
        const flags = this.scene.flags;
        if (!flags?.length) { if (this.flagLabels) this.clearFlagLabels(); return; }
        if (this.labelFlags !== flags || this.flagLabels?.length !== flags.length) {
            this.clearFlagLabels();
            this.labelFlags = flags;
            this.flagLabels = flags.map(flag => {
                const p = this.scene.groundPoint(flag.gx, flag.gy);
                const label = this.scene.add.text(p.x, p.y - 76, flagLabelText(this.scene, flag), {
                    fontFamily: '"PingFang SC", sans-serif', fontSize: '22px', align: 'center',
                    color: '#fff0c7', stroke: '#29291f', strokeThickness: 4,
                    backgroundColor: '#303222b8', padding: { x: 7, y: 4 }
                }).setOrigin(0.5, 1).setDepth(11995);
                label.siteSig = flagSiteSignature(flag);   // 只在归属/角色变化时重写文字
                return label;
            });
        }
        // Zoom compensation keeps strategic names readable in the overview.
        const scale = Math.min(2.4, Math.max(0.8, 0.62 / this.scene.cameras.main.zoom));
        for (let i = 0; i < this.flagLabels.length; i++) {
            const label = this.flagLabels[i], flag = flags[i];
            const sig = flagSiteSignature(flag);
            if (label.siteSig !== sig) {
                label.siteSig = sig;
                label.setText(flagLabelText(this.scene, flag));
            }
            label.setScale(scale);
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
