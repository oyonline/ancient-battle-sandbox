// 单位层渲染：动画注册/攻击动画/守卫朝向/逐帧同步与倒地视觉（sim 钩子经场景单行委托，调用面不变）。
import { MANIFEST } from '../manifest.js';
import { TW, TH, gridToScreen } from './metrics.js';
import { Terrain } from '../terrain.js';
import { clamp } from '../units.js';
import { ANIM_ALIGN_K, CAVALRY_PROFILE_SUFFIX, CAVALRY_FLIPPED, cavalryProfile, cavalryRenderSign, cavalryHeadingFromMotion, footProfile, animAlignProfile, shadowTextureKey } from './sprites.js';

export class UnitRenderer {
    constructor(scene) { this.scene = scene; }

    // 注册各单位动画剪辑（重复开局幂等）
    buildUnitAnims() {
        Object.entries(MANIFEST.anims || {}).forEach(([unit, clips]) => {
            const isCav = unit.includes('cavalry');
            Object.entries(clips).forEach(([clip, c]) => {
                const key = 'assets/units/' + c.file.replace('.png', '');
                if (this.scene.anims.exists(key)) return;
                this.scene.anims.create({
                    key,
                    frames: this.scene.anims.generateFrameNumbers(key, { start: 0, end: c.frames - 1 }),
                    frameRate: clip === 'attack' ? 15 : (isCav ? 13 : 9),
                    repeat: clip === 'attack' ? 0 : -1
                });
            });
        });
        // 死亡阴影只保留接触暗部，不把活体的红蓝队伍圈盖进尸体层。
        if (!this.scene.textures.exists('death-contact-shadow')) {
            const g = this.scene.make.graphics({ add: false });
            g.fillStyle(0x0c1206, 0.18);
            g.fillEllipse(48, 24, 96, 48);
            g.fillStyle(0x0c1206, 0.22);
            g.fillEllipse(48, 24, 70, 32);
            g.generateTexture('death-contact-shadow', 96, 48);
            g.destroy();
        }
    }

    // 攻击时朝向实际目标，出手期间锁定画面朝向。
    // 伤害在挥砍帧上结算（见 updateNormalUnit）。
    // 骑兵按八向贴图转向；步兵素材只有左右两面，普通剑士/枪兵/弓手出手时
    // 与守卫同一口径：按目标方向翻面（近竖直方向保留原面避免闪烁）。
    // 攻击期间朝向锁定（syncOne 的非骑兵翻面分支跳过 attack 状态）。
    playAttackAnim(unit, target = null) {
        if (unit.type === 'cavalry' && target) {
            const from = gridToScreen(unit.gx, unit.gy);
            const to = gridToScreen(target.gx, target.gy);
            const dx = to.x - from.x, dy = to.y - from.y;
            if (Math.hypot(dx, dy) > 0.01) {
                unit.visualDir = cavalryHeadingFromMotion(dx, dy, unit.visualDir);
                unit.faceDir = cavalryRenderSign(unit.visualDir);
            }
        } else if (unit.type !== 'cavalry' && target) {
            this.faceGuardSprite(unit, target.gx - unit.gx, target.gy - unit.gy);
        }
        unit.animState = 'attack';
        unit.animLock = this.scene.simulationTime + 320;
        unit.faceAcc = 0;
        unit.dirDX = 0;
        unit.dirDY = 0;
        unit.spr.play(this.unitAnimKey(unit, 'attack'), true);
    }

    faceGuardSprite(unit, dx, dy) {
        // 步兵素材只有左右两面；按等距投影中的枪头方向翻面，近竖直方向保留原面避免闪烁。
        const length = Math.hypot(dx, dy);
        if (!length || Math.abs(dx - dy) / length < 0.12) return;
        unit.faceDir = dx - dy > 0 ? 1 : -1;
        unit.spr.setFlipX(unit.faceDir < 0);
        unit.faceAcc = 0;
    }

    unitAnimKey(unit, clip) {
        const profile = unit.type === 'cavalry' ? cavalryProfile(unit.visualDir) : null;
        const direction = profile ? CAVALRY_PROFILE_SUFFIX[profile] : '';
        return 'assets/units/anim/' + unit.team + '_' + unit.type + direction + '_' + clip;
    }

    updateDeathVisuals(delta) {
        const elapsed = this.scene.paused ? 0 : Math.max(0, Math.min(delta, 50)) * this.scene.gameSpeed;
        for (const unit of this.scene.dyingUnits) {
            const death = unit.deathVisual;
            if (!death || death.battleId !== this.scene.battleId) {
                unit.spr.destroy(); unit.shadow.destroy();
                unit.deathVisual = null;
                this.scene.dyingUnits.delete(unit);
                continue;
            }
            if (!elapsed) continue;
            death.elapsed = Math.min(death.duration, death.elapsed + elapsed);
            const progress = death.elapsed / death.duration;
            const settled = Math.min(1, progress * 6 / 5);
            const drift = 1 - Math.pow(1 - settled, 3);
            const x = death.x + death.slideX * drift;
            const slideGX = (death.slideX / TW + death.slideY / TH) * drift;
            const slideGY = (death.slideY / TH - death.slideX / TW) * drift;
            const heightDelta = this.scene.terrainHeight(unit.gx + slideGX, unit.gy + slideGY) - this.scene.terrainHeight(unit.gx, unit.gy);
            const y = death.y + death.slideY * drift - heightDelta * Terrain.HEIGHT_SCALE;
            const frame = Math.min(death.frames - 1, Math.floor(progress * death.frames));
            if (death.clip && frame !== death.frame) {
                unit.spr.setFrame(frame);
                death.frame = frame;
            }
            const fading = !death.clip && !death.hasCorpse;
            unit.spr.setPosition(x, y + (fading ? unit.footDy + progress * 4 : 0))
                .setDepth(death.depth + death.slideY * drift * 100 / (TH / 2));
            if (fading) unit.spr.setAlpha(1 - progress);
            unit.shadow.setPosition(x + death.shadowDX * (1 - settled), y)
                .setScale((death.shadowWidth + (death.endShadowWidth - death.shadowWidth) * settled) / 96,
                    (death.shadowHeight + (death.endShadowHeight - death.shadowHeight) * settled) / 48)
                .setDepth(unit.spr.depth - 2);
            if (fading) unit.shadow.setAlpha(1 - progress);
            if (progress < 1) continue;
            const dk = Math.max(0.6, unit.sizeK || 1);
            this.scene.addBloodPool(x, y, 21 * dk);
            if (!fading) this.scene.stampCorpse(unit);
            unit.spr.destroy(); unit.shadow.destroy();
            unit.deathVisual = null;
            this.scene.dyingUnits.delete(unit);
        }
    }

    // ---------------- 渲染同步 ----------------

    // ---------------- 渲染同步 ----------------
    syncRender(time) {
        this.scene.drawTactics();
        this.scene.drawFlags();
        this.scene.drawConvoy();
        this.scene.unitInspector?.update();
        this.scene.hpGfx.clear();
        const view = this.scene._view;   // 战斗中每帧更新；部署阶段为空 = 全量同步
        const units = this.scene.units;
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            if (u.dead || u.withdrawn) continue;
            this.syncOne(u, time, view);
        }
    }

    syncOne(unit, time, view) {
        if (unit.dead || unit.withdrawn) return;
        const { x, y } = this.scene.groundPoint(unit.gx, unit.gy);
        // 朝向仍依据地面平面位移，爬坡的视觉抬升不能把马误转成朝北。
        const planar = gridToScreen(unit.gx, unit.gy);

        const prevX = unit.lastSX === undefined ? planar.x : unit.lastSX;
        const prevY = unit.lastSY === undefined ? planar.y : unit.lastSY;
        const sdx = planar.x - prevX, sdy = planar.y - prevY;

        // 离屏单位也必须按时释放攻击锁，否则会永久冻结在旧方向。
        if (unit.animState === 'attack' && this.scene.simulationTime > unit.animLock) unit.animState = null;

        // 攻击动画期间冻结完整朝向；行走时将屏幕位移平滑后量化为 8 个方向。
        if (unit.type === 'cavalry' && unit.animState !== 'attack' && unit.moving) {
            unit.dirDX = unit.dirDX * 0.6 + sdx * 0.4;
            unit.dirDY = unit.dirDY * 0.6 + sdy * 0.4;
            if (Math.hypot(unit.dirDX, unit.dirDY) > 0.08) {
                const nextVisualDir = cavalryHeadingFromMotion(unit.dirDX, unit.dirDY, unit.visualDir);
                if (nextVisualDir !== unit.visualDir) {
                    unit.visualDir = nextVisualDir;
                    unit.faceDir = cavalryRenderSign(nextVisualDir);
                    unit.animState = null;
                }
            }
        } else if (unit.type === 'cavalry' && unit.animState !== 'attack') {
            unit.dirDX = 0;
            unit.dirDY = 0;
        }

        // 视口剔除：屏幕外只刷新快照，不碰显示对象（千人规模的主力 LOD）
        if (view && (x < view.x0 || x > view.x1 || y < view.y0 || y > view.y1)) {
            unit.lastSX = planar.x; unit.lastSY = planar.y;
            return;
        }

        if (unit.type === 'cavalry' && unit.visualDir !== unit.renderedVisualDir) {
            const nextShadowKey = shadowTextureKey(unit.team, unit.type, unit.visualDir);
            unit.shadow.setTexture(nextShadowKey);
            unit.shadowKey = nextShadowKey;
            const F = footProfile(unit.type, unit.visualDir);
            unit.footDy = F.pad * unit.baseScale;
            unit.renderedVisualDir = unit.visualDir;
            unit.spr.setFlipX(CAVALRY_FLIPPED.has(unit.visualDir));
        }

        // 行军入场偏移：逐帧衰减产生滑入动画
        let ox = 0;
        if (unit.slideOff) {
            ox = unit.slideOff;
            unit.slideOff *= 0.9;
            if (Math.abs(unit.slideOff) < 1) unit.slideOff = 0;
        }

        // ---- 动画状态机：攻击锁定 > 行走 > 待机 ----
        // 辎重车是运行时生成的单帧贴图，无行走/攻击动画可切，跳过状态机
        if (unit.type !== 'wagon' && unit.animState !== 'attack') {
            const want = unit.moving ? 'walk' : 'idle';
            if (want !== unit.animState) {
                unit.animState = want;
                if (want === 'walk') {
                    unit.spr.play(this.unitAnimKey(unit, 'walk'), true);
                } else {
                    unit.spr.anims.stop();
                    unit.spr.setTexture(this.unitAnimKey(unit, 'walk'), 0); // 当前方向的站姿
                }
            }
        }
        if (unit.moving && unit.type === 'cavalry') this.scene.chargeDust(unit);   // 奔跑扬尘（内部已节流）

        // ---- 朝向：累计位移过阈值才翻转（避免受击/挤开抖动导致来回闪脸）----
        // 放在应用位置之前，好让逐帧补正和影子镜像都用上本帧的朝向
        if (unit.type !== 'cavalry' && unit.animState !== 'attack') {
            if (unit.moraleState === 'wavering' && unit.moraleFallBackUntil > this.scene.simulationTime) {
                this.faceGuardSprite(unit, unit.retreatFacingX ?? unit.moraleFacingX, unit.retreatFacingY ?? unit.moraleFacingY);
            } else if (unit.moraleState === 'routing' && this.scene.simulationTime - (unit.routStartedAt ?? -Infinity) < 900) {
                this.faceGuardSprite(unit, unit.moraleFacingX, unit.moraleFacingY);
            } else if (unit.tacticalRole === 'guard' && unit.moraleState !== 'routing') {
                this.faceGuardSprite(unit, unit.guardFacingX, unit.guardFacingY);
            } else {
                unit.faceAcc += sdx;
                if (unit.faceAcc > 2)       { unit.spr.setFlipX(false); unit.faceDir = 1;  unit.faceAcc = 0; }
                else if (unit.faceAcc < -2) { unit.spr.setFlipX(true);  unit.faceDir = -1; unit.faceAcc = 0; }
                else if (Math.abs(unit.faceAcc) > 60) unit.faceAcc = 0;
            }
        }
        unit.lastSX = planar.x; unit.lastSY = planar.y;

        // 待机呼吸：以脚底为支点做极轻微缩放（不再整体上下平移，脚不离地）
        const breath = unit.animState === 'idle' ? Math.sin(time * 0.0035 + unit.bobPhase) : 0;
        const bs = unit.baseScale || 1;
        unit.spr.setScale(bs, bs * (1 + breath * 0.012));

        // ---- 逐帧对齐补正：抵消同一套动画里各帧站位不一致造成的左右抖 ----
        const alignProfile = animAlignProfile(unit.type, unit.visualDir);
        const alignRow = alignProfile && alignProfile[unit.animState === 'attack' ? 'attack' : 'walk'];
        let ajx = 0, ajy = 0;
        if (alignRow) {
            const cf = unit.spr.anims.currentFrame;
            const a = alignRow[cf ? Math.min(cf.index - 1, alignRow.length - 1) : 0] || [0, 0];
            const renderSign = unit.type === 'cavalry' ? cavalryRenderSign(unit.visualDir) : unit.faceDir;
            ajx = a[0] * bs * renderSign * ANIM_ALIGN_K;      // 横向补正随贴图镜像
            ajy = a[1] * bs * ANIM_ALIGN_K;
        }

        // 受击位移叠加（lunge 由 tween 驱动）；y 再补 footDy，让脚底落在阴影圆心上
        const L = unit.lunge;
        unit.spr.setPosition(x + ox + L.x + ajx, y + unit.footDy + L.y + ajy);
        unit.spr.setAngle(L.angle);

        const depth = (unit.gx + unit.gy) * 100 + 50;
        unit.spr.setDepth(depth);
        // 影子：贴图镜像随朝向翻转 —— 脚底偏移已烘进贴图，翻转后仍贴在脚掌下
        const shadowSign = unit.type === 'cavalry' ? cavalryRenderSign(unit.visualDir) : unit.faceDir;
        unit.shadow.setPosition(x + ox * 0.55, y).setScale(shadowSign, 1).setDepth(depth - 2);

        // 受击反馈：轻染红（乘法染色保留像素图案，不再全白填充闪白）
        if (this.scene.simulationTime < unit.flashUntil) unit.spr.setTint(0xff7d6e);
        else if (unit.moraleBoostUntil > this.scene.simulationTime) unit.spr.setTint(0xffe9a9);
        else unit.spr.clearTint();

        // 血条：画进共享 hpGfx（全场景一张，深度压在所有单位之上）。
        // 拉远观战时只有残血（<30%）才显示，避免千条血条糊成一片。
        if (unit.hp < unit.maxHp && (!this.scene.lowFX || unit.hp < unit.maxHp * 0.3)) {
            const w = Math.max(12, 28 * (unit.sizeK || 1)), ratio = clamp(unit.hp / unit.maxHp, 0, 1);
            const hy = -(unit.spr.displayHeight * 0.82 + 6);
            const px = x, py = y + unit.footDy;
            this.scene.hpGfx.fillStyle(0x000000, 0.55);
            this.scene.hpGfx.fillRect(px - w / 2 - 1, py + hy, w + 2, 6);
            this.scene.hpGfx.fillStyle(unit.team === 'red' ? 0xff4444 : 0x3d7be8, 1);
            this.scene.hpGfx.fillRect(px - w / 2, py + hy + 1, w * ratio, 4);
        }
        // 颜色和形状一起区分脱离、恢复与返场，所有进度跟随模拟时钟。
        const recovering = unit.moraleState === 'routing' && unit.moralePhase === 'recovering';
        const forming = unit.rallyWaiting && unit.moraleState !== 'routing';
        const fallingBack = unit.moraleState === 'wavering' && unit.moraleFallBackUntil > this.scene.simulationTime;
        const returning = unit.moralePhase === 'returning' && unit.moraleState !== 'routing' && !fallingBack;
        if (unit.moraleState === 'wavering' || unit.moraleState === 'routing' || forming || returning) {
            const routing = unit.moraleState === 'routing';
            const width = Math.max(12, 28 * (unit.sizeK || 1));
            const my = y + unit.footDy - unit.spr.displayHeight * 0.82 - 13;
            this.scene.hpGfx.fillStyle(0x201b15, 0.9);
            this.scene.hpGfx.fillRect(x - width / 2 - 1, my - 1, width + 2, 5);
            const color = recovering || forming ? 0x72e0ad : returning ? 0x8cdaff : routing ? 0xff864f : 0xffce62;
            const progress = recovering ? unit.moraleRecoveryProgress || 0 : forming || returning ? 1 : unit.morale / 100;
            this.scene.hpGfx.fillStyle(color, 1);
            this.scene.hpGfx.fillRect(x - width / 2, my, width * Math.max(0.08, progress), 3);
            if (recovering || forming) {
                this.scene.hpGfx.lineStyle(2, color, 1);
                this.scene.hpGfx.lineBetween(x - 3, my - 9, x - 3, my - 4);
                this.scene.hpGfx.lineBetween(x + 3, my - 9, x + 3, my - 4);
            } else if (returning) {
                this.scene.hpGfx.lineStyle(2, color, 1);
                this.scene.hpGfx.lineBetween(x - 4, my - 5, x, my - 9);
                this.scene.hpGfx.lineBetween(x, my - 9, x + 4, my - 5);
            } else if (routing) {
                this.scene.hpGfx.lineStyle(2, 0xff864f, 1);
                this.scene.hpGfx.lineBetween(x - 3, my - 7, x - 6, my - 3);
                this.scene.hpGfx.lineBetween(x + 3, my - 7, x, my - 3);
            }
        }
    }

    // ---------------- 占点征服 ----------------
    // 英雄连式兵力拔河：圈内双方单位的占领力互相抵消，净差拉进度条——
    // 人多的一方能从对方手里硬拔，兵力相当才是真僵持。占领力按兵种不同
    // （×10 取整做计数：求和顺序无关、零浮点噪声，换座镜像天然同步）。
    // progress ∈ [-1,+1]：+1 红完全占领、-1 蓝完全占领、0 中立；归属只在
    // 拉满端点时获得，被拉过中线才失去（防守惯性，同英雄连的中立化两段）；
    // 单位离开进度保持不清零。每面归属旗每秒 +1 分，先到 60 分胜。
}
