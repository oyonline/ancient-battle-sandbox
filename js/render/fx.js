// 特效层渲染：箭矢/近战打击/斩击弧光/血粒子与血渍/尸印/尘土/火花（sim 钩子经场景单行委托）。
import { board } from '../board.js';
import { Terrain } from '../terrain.js';
import { clamp, dist, resolveAttack } from '../units.js';
import { gridToScreen } from './metrics.js';
import { towerCrewOffset } from './camps.js';

export class EffectsRenderer {
    constructor(scene) {
        this.scene = scene;
        this.dust = [];
        this.dustPool = [];
        this.dustBattleId = null;
        scene.events?.once('shutdown', () => {
            this.dustGfx?.destroy();
            this.dustGfx = null;
            this.dust.length = 0;
            this.dustPool.length = 0;
        });
    }

    // ---------------- 箭矢（全场景合批到一张 Graphics） ----------------
    fireArrow(from, target, options = {}) {
        const d = dist(from, target);
        const flightT = clamp(d / 12, 0.3, 0.75);
        // 预判提前量：瞄目标飞行期间的预估位置
        const lead = (v) => v ? clamp(v * flightT, -1.5, 1.5) : 0;
        const tx = clamp(target.gx + lead(target.velX), 0.5, board.W - 0.5);
        const ty = clamp(target.gy + lead(target.velY), 0.5, board.H - 0.5);
        const crew = towerCrewOffset(from, this.scene.territory?.camps);
        this.scene.arrows.push({
            sx: from.gx, sy: from.gy,
            tx, ty,
            sourceHeight: this.scene.terrainHeight(from.gx, from.gy) + (from.garrisonHeight || 0) / Terrain.HEIGHT_SCALE,
            targetHeight: this.scene.terrainHeight(tx, ty) + (target.garrisonHeight || 0) / Terrain.HEIGHT_SCALE,
            sourceOffsetX: crew?.x || 0,
            sourceOffsetY: crew ? crew.y + (from.garrisonHeight || 0) : 0,
            sourceLift: 22, targetLift: target.isBuilding ? (target.type === 'tower' ? 64 : 36) : 17,
            buildingId: target.isBuilding ? target.id : null,
            t: 0, dur: flightT,
            dmg: options.rawAttack ?? from.typeData.atk, team: from.team, source: from, firedAt: this.scene.simulationTime
        });
        if (Snd) Snd.play('arrow');
    }

    updateArrows(dt, now) {
        for (let i = this.scene.arrows.length - 1; i >= 0; i--) {
            const a = this.scene.arrows[i];
            a.t += dt;
            const p = clamp(a.t / a.dur, 0, 1);
            if (p >= 1) {
                const s = this.arrowPoint(a, p);
                if (a.buildingId) {
                    const building = this.scene.territory?.camps?.getBuilding(a.buildingId);
                    if (building && !building.dead && building.team !== a.team) {
                        resolveAttack(building, a.source, { rawAttack: a.dmg, attackStartedAt: a.firedAt,
                            sourceHeight: a.sourceHeight });
                        if (!this.scene.lowFX) this.scene.impactPuff(s.x, s.y, 0xc4a177);
                    }
                    this.scene.arrows.splice(i, 1);
                    continue;
                }
                // 落点找最近的敌人判定命中（空间哈希只查落点周围）
                let hit = null, hd = 0.75;
                this.scene.forEachNear(a.tx, a.ty, hd, u => {
                    if (u.team === a.team || u.dead || u.withdrawn) return;
                    const d = Math.hypot(u.gx - a.tx, u.gy - a.ty);
                    if (d < hd - 1e-9 || (hit && Math.abs(d - hd) <= 1e-9 && u.id < hit.id)) { hd = d; hit = u; }
                });
                if (hit) {
                    resolveAttack(hit, a.source, { rawAttack: a.dmg, attackStartedAt: a.firedAt,
                        sourceHeight: a.sourceHeight });
                    this.scene.bloodBurst(s.x, s.y - 8, 6, 85, hit.sizeK || 1);
                } else if (!this.scene.lowFX) {
                    this.scene.impactPuff(s.x, s.y, 0xcfcfcf);
                }
                this.scene.arrows.splice(i, 1);
            }
        }
    }

    arrowPoint(a, p) {
        const s = gridToScreen(a.sx + (a.tx - a.sx) * p, a.sy + (a.ty - a.sy) * p);
        // Interpolate endpoint heights, not the terrain below the flight path.
        s.y -= ((a.sourceHeight || 0) * (1 - p) + (a.targetHeight || 0) * p) * Terrain.HEIGHT_SCALE;
        s.x += (a.sourceOffsetX || 0) * (1 - p);
        s.y += (a.sourceOffsetY || 0) * (1 - p) - ((a.sourceLift || 0) * (1 - p) + (a.targetLift || 0) * p);
        return s;
    }

    // Once per display frame; skipped drawing never skips flight or hit resolution.
    drawArrows() {
        const g = this.scene.arrowGfx;
        if (!g) return;
        g.clear();
        const view = this.scene._view;
        for (const a of this.scene.arrows) {
            const p = clamp(a.t / a.dur, 0, 1), s = this.arrowPoint(a, p);
            s.y -= Math.sin(p * Math.PI) * 46;
            if (view && (s.x < view.x0 || s.x > view.x1 || s.y < view.y0 || s.y > view.y1)) continue;
            const angle = Math.atan2(a.ty - a.sy, a.tx - a.sx);
            const dx = Math.cos(angle) * 7.5, dy = Math.sin(angle) * 7.5 * 0.5 - 3;
            g.lineStyle(1.5, 0x5b4632, 1);
            g.lineBetween(s.x - dx, s.y - dy, s.x + dx, s.y + dy);
            g.fillStyle(0xd9d9d9, 1);
            g.fillCircle(s.x + dx, s.y + dy, 1.4);
        }
    }

    // ---------------- 特效 ----------------

    // ---------------- 特效 ----------------
    // 兵种出手反馈分流（真实命中事件驱动，表现不反向触碰模拟）：
    //   slash  剑士挥砍——白色斩弧 + 暖色火花 + hit 音
    //   thrust 枪兵直刺——沿攻击方向的短直刺光 + 冷色火花 + stab 音
    //   charge 骑兵冲锋撞击——地面冲击波 + 大火花 + 更重的 charge 音
    // 贴身砍击的骑兵（melee 状态）走 slash，不再冒充冲锋。
    meleeImpact(attacker, target, kind = null) {
        if (!kind) kind = attacker.type === 'pikeman' ? 'thrust' : 'slash';
        // 屏幕空间攻击方向（y 加权贴合地面斜向）
        const sA = this.scene.groundPoint(attacker.gx, attacker.gy);
        const s = this.scene.groundPoint(target.gx, target.gy);
        const ang = Math.atan2((s.y - sA.y) * 2, s.x - sA.x);
        if (target.isBuilding) {
            // Timber receives splinters, never a unit knockback tween or blood.
            if (!this.scene.lowFX && this.scene._fxBudget > 0) {
                this.scene._fxBudget--;
                this.sparkBurst(s.x, s.y - (target.type === 'tower' ? 48 : 30), 0xd9b578);
                if (attacker.lunge) {
                    const L = attacker.lunge;
                    this.scene.tweens.add({ targets:L,x:Math.cos(ang)*6,y:Math.sin(ang)*3,duration:70,
                        onComplete:()=>this.scene.tweens.add({targets:L,x:0,y:0,duration:180}) });
                }
            }
            if (Snd) Snd.play('hit');
            return;
        }

        // 全局拉远观战时只保留伤害与血（lowFX），近景才放全套打击感
        if (!this.scene.lowFX && this.scene._fxBudget > 0) {
            this.scene._fxBudget--;
            // 攻击冲拳：动画已带挥砍，这里只补一小段冲击位移
            const L = attacker.lunge, reach = (kind === 'charge' ? 10 : attacker.type === 'cavalry' ? 8 : 6) * (attacker.sizeK || 1);
            this.scene.tweens.add({
                targets: L,
                x: Math.cos(ang) * reach, y: Math.sin(ang) * reach * 0.55,
                duration: 70, ease: 'Quad.Out',
                onComplete: () => this.scene.tweens.add({
                    targets: L, x: 0, y: 0, duration: 180, ease: 'Sine.InOut'
                })
            });

            // 受击后退：被顶开再弹回
            const kb = target.sizeK || 1;
            this.scene.tweens.add({
                targets: target.lunge,
                x: Math.cos(ang) * 5 * kb, y: Math.sin(ang) * 3 * kb,
                duration: 60, ease: 'Quad.Out',
                onComplete: () => this.scene.tweens.add({ targets: target.lunge, x: 0, y: 0, duration: 200, ease: 'Back.Out' })
            });

            // 出手光效按兵种武器形态分流：斩弧 / 直刺 / 冲撞大火花
            if (kind === 'thrust') this.thrustStreak(s.x, s.y - 14 * kb, ang, kb);
            else this.slashArc(s.x, s.y - 14 * kb, ang, kb);
            this.sparkBurst(s.x + Math.cos(ang) * 6, s.y - 16 * kb,
                kind === 'thrust' ? 0xd8ecff : 0xffe9a0, kind === 'charge');
        }

        if (kind === 'charge') {
            const kb = target.sizeK || 1;
            // 冲击波只做地面局部反馈；不再震镜头——百骑齐战时全屏抖动会持续不断
            if (!this.scene.lowFX && this.scene._fxBudget > 0) {
                this.scene._fxBudget--;
                const wave = this.scene.add.graphics();
                wave.lineStyle(3, 0xfff3c0, 0.85);
                wave.strokeEllipse(0, 0, 30, 15);
                wave.setPosition(s.x, s.y);
                this.scene.groundFX.add(wave);
                this.scene.tweens.add({
                    targets: wave, alpha: 0, scaleX: 2.6, scaleY: 2.2,
                    duration: 380, onComplete: () => wave.destroy()
                });
            }
            this.scene.bloodBurst(s.x, s.y - 14 * kb, 14, 150, kb);
        } else {
            this.scene.bloodBurst(s.x, s.y - 14 * (target.sizeK || 1), 9, 105, target.sizeK || 1);
        }
        if (Snd) Snd.play(kind === 'thrust' ? 'stab' : kind === 'charge' ? 'charge' : 'hit');
    }

    // 斩击弧光：一道白色弧线闪过斩击位置（尺寸随目标体型）

    // 斩击弧光：一道白色弧线闪过斩击位置（尺寸随目标体型）
    slashArc(x, y, ang, k = 1) {
        const g = this.scene.add.graphics();
        const kk = Math.max(0.45, k);
        g.lineStyle(3.5 * kk, 0xffffff, 0.95);
        g.beginPath();
        g.arc(0, 0, 15 * kk, -1.0, 1.0);
        g.strokePath();
        g.setPosition(x, y);
        g.setRotation(ang + (Math.random() - 0.5) * 0.9);
        this.scene.airFX.add(g);
        this.scene.tweens.add({
            targets: g, alpha: 0, scaleX: 1.55, scaleY: 1.25,
            duration: 150, ease: 'Quad.Out', onComplete: () => g.destroy()
        });
    }

    // 直刺光：枪兵出手的短直线反馈——沿攻击方向的细长光带 + 枪尖亮点，
    // 比斩弧更窄更快，读作"扎了一下"而不是"砍了一刀"（尺寸随目标体型）
    thrustStreak(x, y, ang, k = 1) {
        const g = this.scene.add.graphics();
        const kk = Math.max(0.45, k);
        const len = 24 * kk, half = 1.5 * kk;      // y 压半贴合地面斜向
        g.lineStyle(2.4 * kk, 0xf4fbff, 0.95);
        g.lineBetween(0, 0, Math.cos(ang) * len, Math.sin(ang) * len * 0.5);
        g.fillStyle(0xffffff, 0.95);
        g.fillCircle(Math.cos(ang) * len, Math.sin(ang) * len * 0.5, Math.max(1.2, half));
        g.setPosition(x, y);
        g.setRotation(0);   // 线段已按攻击方向画好，不再整体旋转
        this.scene.airFX.add(g);
        this.scene.tweens.add({
            // 线段本身带方向，不做整体缩放（斜向缩放会把线拉歪）；只前送一点再淡出
            targets: g, alpha: 0, x: x + Math.cos(ang) * 5, y: y + Math.sin(ang) * 2.5,
            duration: 130, ease: 'Quad.Out', onComplete: () => g.destroy()
        });
    }

    // ---------------- 血粒子：喷溅 → 抛物线 → 落地留血渍 ----------------
    // 千人规模下可能同时几十处在溅血：全部合批到一张 bloodGfx 每帧重画

    // ---------------- 血粒子：喷溅 → 抛物线 → 落地留血渍 ----------------
    // 千人规模下可能同时几十处在溅血：全部合批到一张 bloodGfx 每帧重画
    bloodBurst(x, y, n = 6, power = 95, k = 1) {
        if (this.scene.bloods.length >= 72) return;  // 保留并发上限，增加单次喷溅的饱满度
        const kk = Math.max(0.5, k);
        const parts = [];
        const count = Math.ceil(n * 1.4);
        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            const sp = power * (0.45 + Math.random() * 0.75) * kk;
            parts.push({
                x: 0, y: 0,
                vx: Math.cos(a) * sp,
                vy: -Math.abs(Math.sin(a)) * sp * 0.85 - 26 * kk,
                s: (2.3 + Math.random() * 3.1) * kk,        // 像素方块边长
                floor: (3 + Math.random() * 9) * kk,         // 相对喷点的落地深度
                landed: false, rest: 0
            });
        }
        this.scene.bloods.push({ bx: x, by: y, parts, t: 0 });
    }

    updateBloods(dt) {
        if (!this.scene.bloodGfx) return;
        const g = this.scene.bloodGfx;
        g.clear();
        for (let i = this.scene.bloods.length - 1; i >= 0; i--) {
            const b = this.scene.bloods[i];
            b.t += dt;
            let flying = 0;
            for (const p of b.parts) {
                if (p.landed) { p.rest += dt; continue; }
                p.vy += 540 * dt;                 // 重力
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                if (p.y >= p.floor) {              // 落地 → 地面血渍
                    this.addGroundBlood(b.bx + p.x, b.by + p.floor, p.s);
                    p.landed = true;
                    continue;
                }
                g.fillStyle(Math.random() < 0.25 ? 0xe23b2e : 0xb31818, 1);
                g.fillRect(b.bx + p.x - p.s / 2, b.by + p.y - p.s / 2, p.s, p.s);
                flying++;
            }
            // 全部落地且停留片刻后回收
            if (flying === 0 && b.t > 0.15 && b.parts.every(p => p.rest > 0.05)) {
                this.scene.bloods.splice(i, 1);
            }
        }
    }

    // 地面血渍：入队，帧内合并成 1 个 Graphics 一次性盖印进留痕层（千人混战下每秒上百处落点也只画一次）

    // 地面血渍：入队，帧内合并成 1 个 Graphics 一次性盖印进留痕层（千人混战下每秒上百处落点也只画一次）
    addGroundBlood(x, y, s) {
        this.scene.bloodQueue.push(x, y, s);
    }

    flushBloodQueue() {
        const q = this.scene.bloodQueue;
        if (!q.length || !this.scene.scarRT) return;
        const st = this.scene.add.graphics();
        const bounds = [];
        for (let i = 0; i < q.length; i += 3) {
            const x = q[i], y = q[i + 1], s = q[i + 2] * 1.2;
            bounds.push({ x:x-s/2,y:y-s*0.3,width:s,height:s*0.55 });
            st.fillStyle(0x6e0f0f, 0.9);
            st.fillRect(x - s / 2, y - s * 0.3, s, s * 0.55);
            st.fillStyle(0x951919, 0.85);
            st.fillRect(x - s * 0.3, y - s * 0.14, s * 0.55, s * 0.28);
        }
        this.scene.scarRT.draw(st,bounds);
        st.destroy();
        q.length = 0;
    }

    // 血泊：尸体下的大摊血，多层叠色，立即可见（保证盖在尸体之前）

    // 血泊：尸体下的大摊血，多层叠色，立即可见（保证盖在尸体之前）
    addBloodPool(x, y, s) {
        if (!this.scene.scarRT) return;
        const st = this.scene.add.graphics();
        st.fillStyle(0x5a0c0c, 0.9);
        st.fillEllipse(0, 0, s, s * 0.62);
        st.fillEllipse(-s * 0.32, s * 0.08, s * 0.55, s * 0.36);
        st.fillEllipse(s * 0.3, -s * 0.06, s * 0.5, s * 0.34);
        st.fillStyle(0x7d1212, 0.85);
        st.fillEllipse(0, 0, s * 0.82, s * 0.46);
        st.fillStyle(0x991b1b, 0.85);
        st.fillEllipse(s * 0.04, s * 0.02, s * 0.5, s * 0.26);
        st.setPosition(x, y);
        this.scene.scarRT.draw(st,{x:x-s*0.6,y:y-s*0.4,width:s*1.2,height:s*0.8});
        st.destroy();
    }

    chargeDust(unit) {
        if (!this.scene.battleStarted || this.scene.paused || this.scene.battleOver || unit.visualCulled) return;
        const now = this.scene.time?.now ?? this.scene.simulationTime;
        if (now - (unit.lastDust || 0) < 70) return;
        unit.lastDust = now;
        if (!this.scene._dustBudget || this.scene._dustBudget <= 0) return;
        if (this.scene.lowFX && Math.random() < 0.75) return;
        this.scene._dustBudget--;
        this.resetDustForBattle();
        if (this.dust.length >= 96 || Math.random() >= 0.65) return;
        const s = this.scene.groundPoint(unit.gx, unit.gy), view = this.scene._view;
        if (view && (s.x < view.x0 || s.x > view.x1 || s.y < view.y0 || s.y > view.y1)) return;
        const cloud = this.dustPool.pop() || {};
        cloud.x = s.x + (Math.random() - 0.5) * 16;
        cloud.y = s.y - 2;
        cloud.at = now;
        cloud.size = Math.max(0.45, unit.sizeK || 1);
        cloud.radius = 2.5 + Math.random() * 3.5;
        this.dust.push(cloud);
    }

    resetDustForBattle() {
        if (this.dustBattleId === this.scene.battleId) return;
        this.dustBattleId = this.scene.battleId;
        this.dustPool.push(...this.dust);
        this.dust.length = 0;
        this.dustGfx?.clear();
    }

    // Shared draw buffer and bounded reusable records replace per-cloud Graphics/tweens.
    drawDust(time) {
        this.resetDustForBattle();
        if (!this.dust.length && !this.dustGfx) return;
        if (!this.dustGfx) {
            this.dustGfx = this.scene.add.graphics();
            this.scene.groundFX?.add(this.dustGfx);
        }
        const g = this.dustGfx, now = this.scene.time?.now ?? time;
        g.clear();
        for (let i = this.dust.length - 1; i >= 0; i--) {
            const cloud = this.dust[i], p = Math.max(0, (now - cloud.at) / 520);
            if (p >= 1) {
                this.dustPool.push(cloud);
                this.dust.splice(i, 1);
                continue;
            }
            const radius = cloud.radius * cloud.size;
            g.fillStyle(0xcbb79a, 0.5 * (1 - p));
            g.fillEllipse(cloud.x, cloud.y - p * 8, radius * 2 * (1 + p * 0.9), radius * 2 * (1 + p * 0.4));
            g.fillEllipse(cloud.x - radius, cloud.y - p * 8 + 1, radius * 1.5 * (1 + p), radius * 1.3);
        }
    }

    impactPuff(x, y, color) {
        const p = this.scene.add.graphics();
        p.fillStyle(color, 0.85);
        p.fillCircle(0, 0, 4);
        p.setPosition(x, y - 10);
        this.scene.airFX.add(p);
        this.scene.tweens.add({
            targets: p, scale: 2.2, alpha: 0, duration: 260,
            onComplete: () => p.destroy()
        });
    }

    // 金属碰撞火花：放射短线 + 中心亮点

    // 金属碰撞火花：放射短线 + 中心亮点
    sparkBurst(x, y, color = 0xffe9a0, big = false) {
        const g = this.scene.add.graphics();
        const n = big ? 6 : 4;
        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2;
            const len = (big ? 10 : 6) + Math.random() * (big ? 10 : 6);
            g.lineStyle(2, color, 0.95);
            g.lineBetween(
                Math.cos(a) * 3, Math.sin(a) * 3 * 0.6,
                Math.cos(a) * (3 + len), Math.sin(a) * (3 + len) * 0.6);
        }
        g.fillStyle(0xffffff, 0.9);
        g.fillCircle(0, 0, big ? 4 : 2.5);
        g.setPosition(x, y);
        this.scene.airFX.add(g);
        this.scene.tweens.add({
            targets: g, alpha: 0, scale: big ? 1.8 : 1.3,
            duration: big ? 320 : 220, onComplete: () => g.destroy()
        });
    }

    // 原精灵末帧原位盖印：不再替换尺寸、原点或随机旋转，接触阴影一起保留。

    // 原精灵末帧原位盖印：不再替换尺寸、原点或随机旋转，接触阴影一起保留。
    stampCorpse(unit) {
        const death = unit.deathVisual;
        if (!death || death.battleId !== this.scene.battleId || !this.scene.scarRT) return false;
        this.scene.scarRT.draw(unit.shadow);
        this.scene.scarRT.draw(unit.spr);
        return true;
    }
}
