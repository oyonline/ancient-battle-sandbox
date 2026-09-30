// 世界层渲染：海面/地貌底图烘焙/地形要素/装饰/飞鸟/出生区/阴影与辎重贴图（原场景渲染方法，调用面经 scene.render.world）。
import { board } from '../board.js';
import { Terrain } from '../terrain.js';
import { clamp, UNIT_TYPES } from '../units.js';
import { TW, TH, VIEW_W, VIEW_H, gridToScreen, sampleGroundRing, makeNoise, TWO_PI } from './metrics.js';
import { unitVisualDirections, footProfile, shadowTextureKey } from './sprites.js';
import { TerrainMaterialsRenderer } from './terrain-materials.js';

export class WorldRenderer {
    constructor(scene) { this.scene = scene; this.materials = new TerrainMaterialsRenderer(scene); }

    // ---------------- 全屏海面（铺满菱形外的屏幕区域） ----------------
    createOceanBackdrop() {
        this.scene.ocean = this.scene.add.graphics().setDepth(-1).setScrollFactor(0);
        this.scene.oceanWaves = this.scene.add.graphics().setDepth(-1).setScrollFactor(0);
        this.redrawOcean();
        // 海面缓慢起伏
        this.scene.tweens.add({
            targets: this.scene.oceanWaves, y: 4, duration: 2600, yoyo: true,
            repeat: -1, ease: 'Sine.InOut'
        });
    }

    redrawOcean() {
        const w = this.scene.scale.gameSize.width, h = this.scene.scale.gameSize.height;
        const g = this.scene.ocean, gw = this.scene.oceanWaves;
        // 底色画 3 倍屏幕大，缩放/平移永远不露边
        g.clear();
        if (this.scene.battleOptions.terrain === 'territory' && this.materials.available()) {
            g.fillStyle(0x46502c, 1);
            g.fillRect(-w, -h, w * 3, h * 3);
            gw.clear();
            return;
        }
        g.fillStyle(0x1c3f5c, 1);
        g.fillRect(-w, -h, w * 3, h * 3);

        // 波纹：水平短划错位排布
        gw.clear();
        gw.lineStyle(2, 0x4a7da6, 0.32);
        let n = 0;
        for (let row = 0; row < Math.ceil(h / 34) + 2; row++) {
            const offset = (row % 3) * 23;
            for (let cx = -30; cx < w + 30; cx += 64) {
                const len = 10 + ((row * 7 + cx) % 3) * 7;
                gw.lineBetween(cx + offset, row * 34 - 10, cx + offset + len, row * 34 - 10);
                n++;
                if (n > 400) break;
            }
        }
        // 稀疏亮点
        gw.lineStyle(2, 0x7fb2d6, 0.25);
        for (let i = 0; i < 30; i++) {
            const x = (i * 173.7) % w, y = (i * 97.1) % h;
            gw.lineBetween(x, y, x + 8, y);
        }
    }

    // ---------------- 地面与装饰 ----------------

    groundColor(gx, gy, variation = 0.5) {
        const natural = Terrain.isNaturalSlope(this.scene.battleOptions.terrain);
        const dry = this.scene.terNoise(gx * 0.16, gy * 0.16) * 0.62;
        const dirt = Math.max(0, (this.scene.terNoise(gx * 0.42 + 37, gy * 0.42 + 91) - 0.72) / 0.28) * 0.85;
        const elevation = this.scene.terrainHeight(gx, gy);
        let r = 98 + 42 * dry, g = 150 - 6 * dry, b = 62 + 18 * dry;
        r += (152 - r) * dirt; g += (124 - g) * dirt; b += (84 - b) * dirt;
        const dx = this.scene.terrainHeight(gx + 0.5, gy) - this.scene.terrainHeight(gx - 0.5, gy);
        const dy = this.scene.terrainHeight(gx, gy + 0.5) - this.scene.terrainHeight(gx, gy - 0.5);
        const light = natural ? clamp(0.98 + (variation - 0.5) * 0.035 + dx * 0.8 + dy * 0.55, 0.62, 1.3)
            : clamp(0.9 + variation * 0.16 + dx * 0.4 + dy * 0.25, 0.72, 1.25);
        r += elevation * (natural ? 3 : 5); b += elevation * 2;
        if (natural) g += elevation * 2;
        if (this.scene.battleOptions.terrain === 'territory') {
            // 山河图 2.0：按高度分层提亮偏暖——山头向阳、谷地沉绿
            const tier = Math.max(0, Math.min(1, elevation / 3.2));
            r += tier * 22; g += tier * 8; b -= tier * 6;
        }
        return [r, g, b].map(value => Math.round(value * light));
    }

    drawNaturalRelief(g) {
        // 半格细分坡面，消除整格明暗台阶；所有顶点仍从真实高度采样。
        const key = this.scene.battleOptions.terrain;
        for (let x = 1; x < 69; x += 0.5) for (let y = 10; y < 60; y += 0.5) {
            if (Terrain.height(key, x + 0.25, y + 0.25) <= 0.005) continue;
            const rgb = this.groundColor(x + 0.25, y + 0.25);
            g.fillStyle(Phaser.Display.Color.GetColor(...rgb), 1);
            g.fillPoints([[x, y], [x + 0.5, y], [x + 0.5, y + 0.5], [x, y + 0.5]]
                .map(([gx, gy]) => this.scene.groundPoint(gx, gy)), true);
        }
    }

    drawNaturalGroundTexture(g, hash) {
        // 最后铺纹理，避免被细分坡面盖掉；只烘焙一次，不参与高度或通行计算。
        for (let gy = 1; gy < board.H - 1; gy++) for (let gx = 1; gx < board.W - 1; gx++) {
            const growth = this.scene.terNoise(gx * 0.37 + 13, gy * 0.37 + 41);
            for (let i = 0; i < 7; i++) {
                const seed = gx * 7 + i;
                const r = hash(seed, gy * 11);
                const cx = gx - 0.44 + hash(seed + 157, gy * 13) * 0.88;
                const cy = gy - 0.44 + hash(seed + 307, gy * 17) * 0.88;
                const p = this.scene.groundPoint(cx, cy);
                // 碎叶和土粒提供细颗粒，草簇随大片疏密变化，不排成规则点阵。
                if (i < 5) {
                    g.fillStyle(r > 0.55 ? 0xc5bf86 : 0x354d28, 0.22 + r * 0.16);
                    g.fillRect(p.x, p.y, 1.5 + r * 2.5, 1 + r * 1.2);
                }
                if (r < 0.12 + growth * 0.7) {
                    const height = 3 + hash(seed + 509, gy) * 4;
                    const lean = (hash(seed, gy + 701) - 0.5) * 5;
                    g.lineStyle(1.4, 0x3b582b, 0.43);
                    g.lineBetween(p.x - 2, p.y, p.x - 3 + lean, p.y - height * 0.65);
                    g.lineBetween(p.x, p.y, p.x + lean, p.y - height);
                    g.lineStyle(1.2, 0xb5bd71, 0.38);
                    g.lineBetween(p.x + 1, p.y, p.x + 3 + lean, p.y - height * 0.8);
                } else if (i === 0 && growth < 0.48 && r > 0.72) {
                    const size = 0.14 + r * 0.15;
                    g.fillStyle(0x998052, 0.2);
                    g.fillPoints([[-size, 0], [-size * 0.4, -size], [size, -size * 0.3],
                        [size * 0.55, size * 0.8], [-size * 0.5, size * 0.55]]
                        .map(([dx, dy]) => this.scene.groundPoint(cx + dx, cy + dy)), true);
                }
            }
        }
    }

    // 帝国风地形：杂色草地 + 立体倒角 + 水域环绕 + 海岸黄边
    // 70×70 = 4900 块、数万条图形指令：一次性烘焙成大贴图，之后每帧只画一张图
    drawGround() {
        if (this.scene.battleOptions.terrain === 'territory' && this.materials.available()) {
            this.materials.draw();
            for (const { sprite } of this.scene.edgeProps || []) sprite.setVisible(sprite.texture.key === 'props/tower');
            if (this.scene.ocean) this.redrawOcean();
            return;
        }
        this.materials.clearGround();
        const g = this.scene.make.graphics({ add: false });
        const naturalSlope = Terrain.isNaturalSlope(this.scene.battleOptions.terrain);
        this.scene.terNoise = this.scene.terNoise || makeNoise(7);
        // 领土图：向外扩一圈草地（不可进入的画外景深），海岸线带噪声犬牙——
        // 战场像一块更大的大陆的中部，而不是悬在方框海中央的完整菱形
        const margin = board.MARGIN || 0;
        const isWater = (gx, gy) => {
            if (!margin) return gx === 0 || gy === 0 || gx === board.W - 1 || gy === board.H - 1;
            const edge = Math.min(gx + margin, gy + margin, board.W + margin - 1 - gx, board.H + margin - 1 - gy);
            if (edge > 2.2) return false;                        // 大陆内部
            if (edge <= 0.2) return true;                        // 外海
            return hash(gx, gy) % 100 < edge / 2.2 * 100;        // 海岸带：犬牙交错
        };
        const hash = (a, b) => {
            let h = (a * 374761393 + b * 668265263) ^ 0x5bf03635;
            h = (h ^ (h >> 13)) * 1274126177;
            return ((h ^ (h >> 16)) >>> 0) / 4294967295;
        };
        const dia = (x, y, s) => [
            { x: x, y: y - TH / 2 * s }, { x: x + TW / 2 * s, y: y },
            { x: x, y: y + TH / 2 * s }, { x: x - TW / 2 * s, y: y }
        ];

        for (let gy = -margin; gy < board.H + margin; gy++) {
            for (let gx = -margin; gx < board.W + margin; gx++) {
                const { x, y } = this.scene.groundPoint(gx, gy);
                const tile = this.scene.groundTile(gx, gy);
                const r1 = hash(gx, gy), r2 = hash(gx + 97, gy + 31);

                if (isWater(gx, gy)) {
                    // 水面：两种蓝做棋盘变化 + 波纹
                    const w = r1 > 0.5 ? 0x3d84c6 : 0x4a94d4;
                    g.fillStyle(w, 1);
                    g.fillPoints(dia(x, y, 1.02), true);
                    g.lineStyle(1, 0x2c6da8, 0.6);
                    g.strokePoints(dia(x, y, 1.0), true);
                    // 波纹短线
                    g.lineStyle(2, 0xbfe4f7, 0.35);
                    for (let i = 0; i < 2; i++) {
                        const wx = x + (hash(gx * 3 + i, gy) - 0.5) * 24;
                        const wy = y + (hash(gx, gy * 3 + i) - 0.5) * 10;
                        g.lineBetween(wx - 7, wy, wx + 7, wy);
                    }
                    continue;
                }

                // 明暗随真实坡面法向变化；颜色计算共用，细分时不会出现材质接缝。
                const base = this.groundColor(gx, gy, r1);
                const col = Phaser.Display.Color.GetColor(base[0], base[1], base[2]);
                g.fillStyle(col, 1);
                g.fillPoints(tile, true);

                // 2~3 块不规则深浅草斑
                const patches = 2 + Math.floor(r2 * 2);
                for (let i = 0; i < patches; i++) {
                    const pr = hash(gx * 7 + i, gy * 13 + i);
                    const dark = pr > 0.5;
                    const pf = dark ? 0.82 + hash(i, gx + gy) * 0.08 : 1.12 + hash(i, gx * 2) * 0.1;
                    const pc = Phaser.Display.Color.GetColor(
                        Math.min(255, Math.round(base[0] * pf)),
                        Math.min(255, Math.round(base[1] * pf)),
                        Math.min(255, Math.round(base[2] * pf)));
                    const px = x + (hash(gx + i * 17, gy) - 0.5) * TW * 0.55;
                    const py = y + (hash(gx, gy + i * 17) - 0.5) * TH * 0.55;
                    g.fillStyle(pc, naturalSlope ? 0.16 : 0.45);
                    if (naturalSlope) {
                        // 草斑贴在弯曲地面上，不把平面的菱形贴片悬在坡上。
                        const cx = gx + (hash(gx + i * 17, gy) - 0.5) * 0.6;
                        const cy = gy + (hash(gx, gy + i * 17) - 0.5) * 0.6;
                        const size = 0.14 + pr * 0.13;
                        g.fillPoints([[-size, 0], [0, -size * 0.6], [size, 0], [0, size]]
                            .map(([dx, dy]) => this.scene.groundPoint(cx + dx, cy + dy)), true);
                    } else g.fillPoints(dia(px, py, 0.28 + pr * 0.22), true);
                }

                // 草叶点簇
                g.fillStyle(0x4c7a34, naturalSlope ? 0.24 : 0.55);
                for (let i = 0; i < 3; i++) {
                    const sx = x + (hash(gx * 5 + i, gy * 11) - 0.5) * TW * 0.6;
                    const sy = y + (hash(gx * 11, gy * 5 + i) - 0.5) * TH * 0.6;
                    if (naturalSlope) {
                        const point = this.scene.groundPoint(gx + (hash(gx * 5 + i, gy * 11) - 0.5) * 0.6,
                            gy + (hash(gx * 11, gy * 5 + i) - 0.5) * 0.6);
                        g.fillCircle(point.x, point.y, 1.2 + hash(i, gx + gy * 2) * 1.4);
                    } else g.fillCircle(sx, sy, 1.2 + hash(i, gx + gy * 2) * 1.4);
                }

                // 海岸：贴水的草地加黄沙边
                if (isWater(gx - 1, gy) || isWater(gx + 1, gy) || isWater(gx, gy - 1) || isWater(gx, gy + 1)) {
                    g.fillStyle(0xd8c48a, 0.22);
                    g.fillPoints(dia(x, y, 0.96), true);
                }

                // 自然坡面与山河图不描每格棋盘边线——地形连续不"方块"；
                // 旧地图（平地/红蓝高地）保持原有网格风格。
                if (naturalSlope || this.scene.battleOptions.terrain === 'territory') continue;
                // 立体倒角：上左边缘亮，下右边缘暗
                g.lineStyle(2, 0xd7e8b0, 0.28);
                g.lineBetween(tile[3].x, tile[3].y, tile[0].x, tile[0].y);
                g.lineBetween(tile[0].x, tile[0].y, tile[1].x, tile[1].y);
                g.lineStyle(2, 0x1e3311, 0.3);
                g.lineBetween(tile[1].x, tile[1].y, tile[2].x, tile[2].y);
                g.lineBetween(tile[2].x, tile[2].y, tile[3].x, tile[3].y);
            }
        }

        if (naturalSlope) {
            this.drawNaturalRelief(g);
            this.drawNaturalGroundTexture(g, hash);
        }
        if (Terrain.maps[this.scene.battleOptions.terrain].rx) {
            // 连续等高线勾出坡形，不用高台立墙冒充可通行的缓坡。
            const { cx, cy, rx, ry } = Terrain.maps[this.scene.battleOptions.terrain];
            for (const radius of [0.35, 0.55, 0.75, 0.95]) {
                const points = [];
                for (let i = 0; i <= 100; i++) {
                    const a = i / 100 * TWO_PI;
                    const gx = cx + Math.cos(a) * rx * radius;
                    const gy = cy + Math.sin(a) * ry * radius;
                    if (gx >= 1 && gx <= board.W - 1) points.push(this.scene.groundPoint(gx, gy));
                }
                g.lineStyle(radius === 0.35 ? 3 : 2, 0xe9ddac, radius === 0.35 ? 0.7 : 0.4);
                g.strokePoints(points, false);
            }
        }
        if (this.scene.battleOptions.terrain === 'territory') this.bakeTerritoryDressing(g);
        this.drawTerrainFeatures(g);
        this.scene.groundImage?.destroy();
        if (this.scene.textures.exists('groundTex')) this.scene.textures.remove('groundTex');
        g.generateTexture('groundTex', VIEW_W, VIEW_H);
        g.destroy();
        this.scene.groundImage = this.scene.add.image(0, 0, 'groundTex').setOrigin(0, 0).setDepth(0);
        this.scene._groundTerrain = this.scene.battleOptions.terrain;
        this.drawTerrainDecorations();
        this.scene.terrainLabel?.destroy();
        this.scene.terrainLabel = null;
        if (this.scene.battleOptions.terrain !== 'flat' && !naturalSlope) {
            const map = Terrain.maps[this.scene.battleOptions.terrain];
            // 领土山河图的标签放坡脚（默认 cy-17 会落在上翼河道上）
            const labelY = this.scene.battleOptions.terrain === 'territory' ? map.cy - map.ry - 2.5 : (map.cy || 35) - 17;
            const labelPoint = this.scene.groundPoint(map.cx || 35, labelY);
            this.scene.terrainLabel = this.scene.add.text(labelPoint.x, labelPoint.y - 42,
                map.name + (map.rx ? ' · 缓坡' : ''), {
                    fontFamily: 'sans-serif', fontSize: '30px', color: '#fff3c7',
                    stroke: '#394629', strokeThickness: 6
                }).setOrigin(0.5).setDepth(7);
        }

        // 水面高光闪点（缓慢呼吸）——领土图海岸在画外缘，跳过
        if (this.scene.battleOptions.terrain === 'territory' || this.scene.waterSparklesCreated) return;
        this.scene.waterSparklesCreated = true;
        for (let i = 0; i < 14; i++) {
            const side = i % 4;
            const t = hash(i, 777);
            let wx, wy;
            if (side === 0) { const { x, y } = gridToScreen(1 + t * (board.W - 2), 0); wx = x; wy = y; }
            else if (side === 1) { const { x, y } = gridToScreen(1 + t * (board.W - 2), board.H - 1); wx = x; wy = y; }
            else if (side === 2) { const { x, y } = gridToScreen(0, 1 + t * (board.H - 2)); wx = x; wy = y; }
            else { const { x, y } = gridToScreen(board.W - 1, 1 + t * (board.H - 2)); wx = x; wy = y; }
            const spark = this.scene.add.graphics().setDepth(2);
            spark.fillStyle(0xffffff, 0.5);
            spark.fillEllipse(wx, wy, 10, 3);
            this.scene.tweens.add({
                targets: spark, alpha: { from: 0.15, to: 0.75 },
                duration: 1400 + i * 230, yoyo: true, repeat: -1,
                delay: hash(i, 42) * 1200
            });
        }

    }

    // 山河图 2.0 皮肤烘焙：土路 / 灌木花草 / 老家营寨（纯视觉，一次烘焙进地面贴图；
    // 噪声一律 |x-中心| 折叠采样，左右镜像一致——视觉公平且风格对称）

    // 山河图 2.0 皮肤烘焙：土路 / 灌木花草 / 老家营寨（纯视觉，一次烘焙进地面贴图；
    // 噪声一律 |x-中心| 折叠采样，左右镜像一致——视觉公平且风格对称）

    bakeTerritoryDressing(g) {
        const W = board.W, H = board.H, cx = W / 2;
        const quad = (x, y, color, alpha) => {
            g.fillStyle(color, alpha);
            g.fillPoints(this.scene.groundTile(x, y), true);
        };
        const openGround = (x, y) =>
            !['water', 'rock', 'bridge', 'shallow', 'forest'].includes(Terrain.surface('territory', x, y));
        // ---- 土路：老家 → 本方两旗 → 高地脚下（被踩出来的行军线）----
        const road = (x1, y1, x2, y2) => {
            const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 0.45);
            const nx = -(y2 - y1), ny = x2 - x1;
            const len = Math.hypot(nx, ny) || 1;
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
                const wob = (this.scene.terNoise(Math.abs(x - cx) * 0.35 + 9, y * 0.35 - 6) - 0.5) * 1.4;
                for (const side of [-0.45, 0.45]) {
                    const px = x + nx / len * (side + wob * 0.3);
                    const py = y + ny / len * (side + wob * 0.3);
                    if (Terrain.surface('territory', px, py) === 'water') continue;
                    quad(Math.round(px), Math.round(py), 0xc9b07c, 0.5);
                }
            }
        };
        road(8, 36, 25, 24); road(8, 36, 34, 58);
        road(W - 8, 36, W - 25, 24); road(W - 8, 36, W - 34, 58);
        road(25, 24, 50, 34); road(34, 58, 49, 39);
        road(W - 25, 24, W - 50, 34); road(W - 34, 58, W - 49, 39);
        // ---- 灌木与花草：哈希散点 + 镜像，只落开阔地 ----
        for (let i = 0; i < 90; i++) {
            const ax = 4 + (i * 37.13) % (cx - 6);
            const y = 6 + (i * 53.7) % (H - 12);
            for (const x of [ax, W - ax]) {
                if (!openGround(x, y)) continue;
                const p = this.scene.groundPoint(x, y);
                g.fillStyle(0x3f6b36, 0.85); g.fillEllipse(p.x, p.y, 9, 5);
                g.fillStyle(0x537f47, 0.9); g.fillEllipse(p.x - 1, p.y - 1, 5, 3);
            }
        }
        for (let i = 0; i < 70; i++) {
            const ax = 5 + (i * 29.7) % (cx - 7);
            const y = 8 + (i * 61.3) % (H - 14);
            for (const x of [ax, W - ax]) {
                if (!openGround(x, y)) continue;
                const p = this.scene.groundPoint(x, y);
                g.fillStyle([0xfff3b0, 0xffffff, 0xffd1dc][i % 3], 0.95);
                g.fillCircle(p.x, p.y, 1.6);
            }
        }
        // ---- 老家营寨：栏栅（带门洞）+ 双帐篷 ----
        for (const home of [{ x: 15.5, side: 'red' }, { x: W - 15.5, side: 'blue' }]) {
            for (let y = 24; y <= 48; y += 1.1) {
                if (Math.abs(y - 36) < 2.6) continue;   // 门洞朝战场
                const x = home.x + (this.scene.terNoise(Math.abs(home.x - cx) * 0.3 + y * 0.2, y) - 0.5) * 0.5;
                const p = this.scene.groundPoint(x, y);
                g.fillStyle(0x6e4f2e, 1); g.fillRect(p.x - 2, p.y - 13, 4, 13);
                g.fillStyle(0x8a6a3f, 1); g.fillRect(p.x - 2, p.y - 13, 4, 3);
            }
            const tentX = home.side === 'red' ? 6.5 : W - 6.5;
            for (const ty of [27, 45]) {
                const p = this.scene.groundPoint(tentX, ty);
                g.fillStyle(home.side === 'red' ? 0xb0524a : 0x4a6fb0, 0.95);
                g.fillTriangle(p.x - 14, p.y, p.x + 14, p.y, p.x, p.y - 22);
                g.fillStyle(0x2c2418, 0.9);
                g.fillTriangle(p.x - 3, p.y, p.x + 3, p.y, p.x, p.y - 8);
            }
        }
    }

    drawTerrainFeatures(g) {
        const key = this.scene.battleOptions.terrain, geometry = Terrain.geometry(key);
        const polygon = (rect, lift = 0) => [[rect.x1, rect.y1], [rect.x2, rect.y1],
            [rect.x2, rect.y2], [rect.x1, rect.y2]].map(([x, y]) => {
                const p = this.scene.groundPoint(x, y); return { x: p.x, y: p.y - lift };
            });
        // 一格一片，沿真实高度贴地；边缘完全来自通行矩形，不用视觉近似的半格边界。
        const paint = (rect, color, alpha = 1) => {
            g.fillStyle(color, alpha);
            for (let x = rect.x1; x < rect.x2; x++) for (let y = rect.y1; y < rect.y2; y++)
                g.fillPoints(polygon({ x1: x, y1: y, x2: Math.min(x + 1, rect.x2), y2: Math.min(y + 1, rect.y2) }), true);
        };
        for (const zone of geometry.zones) {
            if (zone.kind === 'shallow') {
                // 浅滩：浅蓝可通行水域 + 沙色描边 + 波纹点
                paint(zone, 0x7fc0dd, 0.9);
                for (let y = zone.y1 + 0.6; y < zone.y2; y += 1.4) for (let x = zone.x1 + 0.7; x < zone.x2; x += 1.8) {
                    const a = this.scene.groundPoint(x, y);
                    g.lineStyle(2, 0xbfe4f7, 0.45); g.lineBetween(a.x - 4, a.y, a.x + 4, a.y);
                }
            } else if (zone.kind === 'path') {
                paint(zone, 0xd6bd80, 0.5);
                g.lineStyle(2, 0xeee0ad, 0.6); g.strokePoints(polygon(zone), true);
            } else if (zone.kind === 'forest') {
                if (zone.blob) {
                    // 连片噪声林斑（70 图 legacy / 领土 generic 共用此形态）：
                    // 半格采样贴地铺色，边缘与通行判定共用同一占位场；四档由草色渐入深绿。
                    const field = (x, y) => zone.blob === true ? Terrain.forestField(x, y) : Terrain.blobField(zone, x, y);
                    const ramp = [[0x537f47, 0.26], [0x47703d, 0.38], [0x3d6637, 0.52], [0x315c31, 0.64]];
                    for (let y = zone.y1; y < zone.y2; y += 0.5) for (let x = zone.x1; x < zone.x2; x += 0.5) {
                        const depth = field(x + 0.25, y + 0.25) - Terrain.FOREST_EDGE;
                        if (depth <= 0) continue;
                        const tier = depth > 0.55 ? 3 : depth > 0.32 ? 2 : depth > 0.16 ? 1 : 0;
                        g.fillStyle(ramp[tier][0], ramp[tier][1]);
                        g.fillPoints(polygon({ x1: x, y1: y, x2: x + 0.5, y2: y + 0.5 }), true);
                    }
                } else {
                    // 矩形林带（领土征服）：整片铺底色 + 噪声两档加深，边界即通行边界
                    paint(zone, 0x44703c, 0.40);
                    for (let y = zone.y1; y < zone.y2; y += 1) for (let x = zone.x1; x < zone.x2; x += 1) {
                        if (this.scene.terNoise(x * 0.9 + 5, y * 0.9 + 11) < 0.45) continue;
                        g.fillStyle(0x356033, 0.30);
                        g.fillPoints(polygon({ x1: x, y1: y, x2: x + 1, y2: y + 1 }), true);
                    }
                    g.lineStyle(2.5, 0x2c4f2a, 0.5);
                    g.strokePoints(polygon(zone), true);
                }
            }
        }
        if (key === 'forest') {
            // 林隙小径：腰桥两侧的豁口撒浅色草斑，向玩家提示可穿插的路线；只落在空地上，不压林斑。
            for (const dir of [-1, 1]) for (let i = 0; i < 7; i++) {
                const px = 35 + dir * (5.5 + i * 1.05);
                const py = 35 + (this.scene.terNoise(px * 0.9 + dir * 17, 5) - 0.5) * 4.2;
                if (this.scene.terNoise(px * 1.3 + 3, py * 1.3) < 0.3) continue;
                if (Terrain.forestField(px, py) > Terrain.FOREST_EDGE - 0.06) continue;
                g.fillStyle(0x9db36a, 0.45);
                g.fillPoints(polygon({ x1: px - 0.55, y1: py - 0.55, x2: px + 0.55, y2: py + 0.55 }), true);
            }
        }
        for (const block of geometry.blockers) {
            if (block.kind === 'water') {
                // 三段渐变：贴边沙色 → 浅水 → 深水；波纹只画深水
                const DEEP = 0x377fac, LIGHT = 0x63a7d6, SAND = 0xd8c48a;
                for (let x = Math.floor(block.x1); x < block.x2; x++) {
                    for (let y = Math.floor(block.y1); y < block.y2; y++) {
                        const edge = Math.min(x + 1 - block.x1, block.x2 - x, y + 1 - block.y1, block.y2 - y);
                        if (edge <= 0) continue;
                        const color = edge < 0.6 ? SAND : edge < 1.6 ? LIGHT : DEEP;
                        g.fillStyle(color, edge < 0.6 ? 0.9 : 1);
                        g.fillPoints(polygon({ x1: x, y1: y, x2: x + 1, y2: y + 1 }), true);
                        if (edge >= 2 && (x + y) % 2 === 0) {
                            const a = this.scene.groundPoint(x + 0.3, y + 0.5), b = this.scene.groundPoint(x + 0.95, y + 0.5);
                            g.lineStyle(2, 0xa2d8e3, 0.5); g.lineBetween(a.x, a.y, b.x, b.y);
                        }
                    }
                }
                if (key !== 'territory') { g.lineStyle(4, 0xe2cf94, 0.85); g.strokePoints(polygon(block), true); }
            } else {
                paint(block, 0x626355);
                const base = polygon(block), top = polygon(block, 24);
                g.fillStyle(0x474e47, 1); g.fillPoints([top[1], top[2], base[2], base[1]], true);
                g.fillStyle(0x343f39, 1); g.fillPoints([top[2], top[3], base[3], base[2]], true);
                g.fillStyle(0x89917b, 1); g.fillPoints(top, true);
                g.lineStyle(3, 0xb9bea0, 0.8); g.strokePoints(top, true);
                for (let y = block.y1 + 1; y < block.y2; y += 1.7) {
                    const a = this.scene.groundPoint(block.x1 + 0.2, y), b = this.scene.groundPoint(block.x2 - 0.2, y + 0.5);
                    g.lineStyle(2, 0x535d51, 0.8); g.lineBetween(a.x, a.y - 23, b.x, b.y - 23);
                }
            }
        }
        for (const bridge of geometry.zones.filter(zone => zone.kind === 'bridge')) {
            paint(bridge, 0xb38c52);
            for (let x = bridge.x1; x <= bridge.x2; x += 0.5) {
                const a = this.scene.groundPoint(x, bridge.y1), b = this.scene.groundPoint(x, bridge.y2);
                g.lineStyle(2, 0x6e5133, 0.8); g.lineBetween(a.x, a.y, b.x, b.y);
            }
            for (const y of [bridge.y1, bridge.y2]) {
                const a = this.scene.groundPoint(bridge.x1, y), b = this.scene.groundPoint(bridge.x2, y);
                g.lineStyle(5, 0xe0c38e, 1); g.lineBetween(a.x, a.y - 8, b.x, b.y - 8);
                for (let x = bridge.x1; x <= bridge.x2; x += 1.5) {
                    const p = this.scene.groundPoint(x, y);
                    g.lineStyle(4, 0x735233, 1); g.lineBetween(p.x, p.y, p.x, p.y - 12);
                }
            }
        }
        const defense = geometry.defense;
        if (defense && !Terrain.isNaturalSlope(key)) {
            g.lineStyle(3, 0xf4e4a4, 0.75); g.strokePoints(polygon(defense.archerRect), true);
        }
    }

    drawTerrainDecorations() {
        for (const prop of this.scene.terrainProps || []) prop.destroy();
        this.scene.terrainProps = [];
        for (const { sprite, gx, gy } of this.scene.edgeProps || [])
            sprite.setVisible(!['water', 'rock'].includes(Terrain.surface(this.scene.battleOptions.terrain, gx, gy)));
        for (const zone of Terrain.geometry(this.scene.battleOptions.terrain).zones.filter(zone => zone.kind === 'forest')) {
            for (let x = zone.x1 + 1; x < zone.x2 - 0.5; x += 2.2) for (let y = zone.y1 + 1; y < zone.y2 - 0.5; y += 2.2) {
                // 林斑占位：legacy 噪声场 / 领土通用噪声场 / 矩形兜底三形态
                let density;
                if (zone.blob === true) density = Terrain.forestField(x, y);
                else if (zone.blob === 'generic') density = Terrain.blobField(zone, x, y);
                else density = this.scene.terNoise(x * 0.7 + 3, y * 0.7 + 9) > 0.18 ? 0.28 + this.scene.terNoise(x * 0.7 + 3, y * 0.7 + 9) * 0.55 : 0;
                if (density <= Terrain.FOREST_EDGE) continue;
                // 山河图 2.0：成丛生长——簇噪声不过阈值的点位留空，林子有了疏密
                if (zone.blob === 'generic' && this.scene.terNoise(x * 0.33 + 7, y * 0.33 - 5) < 0.45) continue;
                // 深林成簇大树、林缘稀疏小树：树只是林区提示，不是逐棵实体障碍。
                const clump = this.scene.terNoise(x * 0.55 + 9, y * 0.55 + 3);
                if (clump > 0.25 + (density - Terrain.FOREST_EDGE) * 0.9) continue;
                const p = this.scene.groundPoint(x + (clump - 0.5) * 1.2, y + (this.scene.terNoise(y * 0.9 + 17, x * 0.9) - 0.5) * 1.2);
                const big = density > 0.55 && clump > 0.45;
                const tree = this.scene.add.image(p.x, p.y, big ? 'props/tree_big' : 'props/tree_small')
                    .setOrigin(0.5, 0.92).setScale((big ? 0.42 : 0.33) + clump * 0.1).setAlpha(0.85).setDepth(3);
                const shade = this.scene.terNoise(x * 1.7 + 31, y * 1.7 + 7);
                tree.setTint(shade > 0.62 ? 0xf2f6e4 : shade < 0.34 ? 0xd4e0d0 : 0xe7eeda);
                this.scene.terrainProps.push(tree);
            }
        }
        for (const block of Terrain.geometry(this.scene.battleOptions.terrain).blockers.filter(block => block.kind === 'rock')) {
            for (let x = block.x1 + 0.6; x < block.x2; x += 1.6) for (let y = block.y1 + 0.6; y < block.y2; y += 1.7) {
                const p = this.scene.groundPoint(x, y);
                const rock = this.scene.add.image(p.x, p.y - 20, 'props/rock')
                    .setOrigin(0.5, 0.9).setScale(0.38 + this.scene.terNoise(x, y) * 0.12).setDepth(3);
                this.scene.terrainProps.push(rock);
            }
        }
        // 山河图 2.0：坡地散树——林带之外的疏林点缀（哈希折叠镜像，避开一切非草地）
        if (this.scene.battleOptions.terrain === 'territory') {
            for (let i = 0; i < 60; i++) {
                const ax = 6 + (i * 41.3) % (board.W / 2 - 8);
                const y = 22 + (i * 47.9) % (board.H - 30);
                for (const x of [ax, board.W - ax]) {
                    if (['water', 'rock', 'bridge', 'shallow', 'forest'].includes(Terrain.surface('territory', x, y))) continue;
                    if (this.scene.terNoise(x * 0.5 + 3, y * 0.5) < 0.52) continue;
                    const p = this.scene.groundPoint(x, y);
                    const tree = this.scene.add.image(p.x, p.y, 'props/tree_small')
                        .setOrigin(0.5, 0.92).setScale(0.28 + this.scene.terNoise(x * 1.3, y * 1.7) * 0.1)
                        .setAlpha(0.92).setDepth(3);
                    tree.setTint(this.scene.terNoise(x * 1.7 + 31, y * 2.3) > 0.6 ? 0xe7eeda : 0xd4e0d0);
                    this.scene.terrainProps.push(tree);
                }
            }
        }
    }

    placeDecorations() {
        const deco = [];
        this.scene.edgeProps = [];
        if (this.scene.battleOptions.terrain === 'territory' && this.materials.available()) {
            // Keep the existing base towers; woodland is now placed by the material renderer.
            for (const gy of [8, 20, 34, 48, 60]) for (const gx of [2.2, board.W - 3.2]) {
                const p = this.scene.groundPoint(gx, gy);
                const sprite = this.scene.add.image(p.x, p.y, 'props/tower')
                    .setOrigin(0.5, 0.92).setScale(0.48).setDepth((gx + gy) * 100 + 10);
                this.scene.edgeProps.push({ sprite, gx, gy });
            }
            return;
        }
        // 双方大本营：箭塔沿基地前沿一字排开（要塞感）
        [8, 20, 34, 48, 60].forEach(gy => {
            deco.push(['tower', 2.2, gy]);
            deco.push(['tower', board.W - 3.2, gy]);
        });
        // 上下边缘树林带 + 零散岩石（不挡主战场）
        const jit = (a, b) => a + Math.random() * (b - a);
        for (let gx = 4; gx < board.W - 5; gx += 3) {
            deco.push([Math.random() < 0.5 ? 'tree_big' : 'tree_small', jit(gx, gx + 2), jit(1.2, 2.6)]);
            deco.push([Math.random() < 0.5 ? 'tree_big' : 'tree_small', jit(gx, gx + 2), jit(board.H - 2.8, board.H - 1.4)]);
        }
        for (let i = 0; i < 8; i++) {
            deco.push(['rock', jit(6, board.W - 7), Math.random() < 0.5 ? jit(1.6, 2.4) : jit(board.H - 2.6, board.H - 1.8)]);
        }
        deco.forEach(([key, gx, gy]) => {
            const { x, y } = gridToScreen(gx, gy);
            const spr = this.scene.add.image(x, y, 'props/' + key).setOrigin(0.5, 0.92);
            spr.setScale(key === 'tower' ? 0.48 : 0.5);   // 新像素素材原生更大，按显示高度折算
            spr.setDepth((gx + gy) * 100 + 10);
            spr.setVisible(!['water', 'rock'].includes(Terrain.surface(this.scene.battleOptions.terrain, gx, gy)));
            this.scene.edgeProps.push({ sprite: spr, gx, gy });
            // 树随风轻摆
            if (key.indexOf('tree') === 0) {
                this.scene.tweens.add({
                    targets: spr, angle: { from: -1.3, to: 1.3 },
                    duration: 2600 + Math.random() * 2000,
                    yoyo: true, repeat: -1, ease: 'Sine.InOut',
                    delay: Math.random() * 1600
                });
            }
        });
    }

    // ---------------- 氛围层：飞鸟 ----------------

    // ---------------- 氛围层：飞鸟 ----------------
    scheduleBirds() {
        this.spawnBirds();
        this.scene.time.addEvent({ delay: 9000 + Math.random() * 4000, loop: true, callback: () => this.spawnBirds() });
    }

    spawnBirds() {
        const n = 3 + Math.floor(Math.random() * 3);
        const fromLeft = Math.random() > 0.5;
        const y0 = 70 + Math.random() * 200;
        for (let i = 0; i < n; i++) {
            const bird = this.scene.add.graphics().setDepth(150000);
            bird.lineStyle(2, 0x1c1c1c, 0.7);
            bird.lineBetween(-6, 1, 0, -3);
            bird.lineBetween(0, -3, 6, 1);
            bird.setPosition(fromLeft ? -80 - i * 30 : VIEW_W + 80 + i * 30, y0 + i * 9);
            // 振翅（离场时随 killTweensOf 一并清理）
            this.scene.tweens.add({
                targets: bird, scaleY: { from: 1, to: 0.5 },
                duration: 170 + i * 25, yoyo: true, repeat: -1, ease: 'Sine.InOut'
            });
            this.scene.tweens.add({
                targets: bird, x: fromLeft ? VIEW_W + 140 : -140,
                duration: 13000 + Math.random() * 3000,
                onComplete: () => {
                    this.scene.tweens.killTweensOf(bird);
                    bird.destroy();
                }
            });
        }
    }

    drawSpawnZones() {
        const g = this.scene.spawnZoneGfx.setDepth(5).setAlpha(0.22);
        g.clear();
        if (Terrain.isNaturalSlope(this.scene.battleOptions.terrain)) return;
        if (this.scene.battleOptions.terrain === 'territory') {
            // 领土图：大本营领地光晕（三层椭圆渐隐），替代整块矩形出兵区
            for (const [x, color] of [[8, 0xff5555], [board.W - 8, 0x5599ff]]) {
                for (const [rx, ry, alpha] of [[9, 16, 0.30], [6, 11, 0.35], [3.4, 6.5, 0.42]]) {
                    g.fillStyle(color, alpha);
                    g.fillPoints(sampleGroundRing(this.scene, x, board.H / 2, rx, ry, 26), true);
                }
            }
            return;
        }
        const zone = (x0, x1, color) => {
            for (let gy = 1; gy < board.H - 1; gy++)
                for (let gx = x0; gx < x1; gx++) {
                    g.fillStyle(color, 1);
                    g.fillPoints(this.scene.groundTile(gx, gy), true);
                }
        };
        zone(2, 14, 0xff5555);
        zone(board.W - 14, board.W - 2, 0x5599ff);
    }

    // 阴影预烘焙：每个（阵营×兵种）的软椭圆+队伍圈烘成一张小贴图，
    // 千人同屏时阴影走普通精灵合批，而不是一千个 Graphics 各画一遍
    makeShadowTextures() {
        for (const team of ['red', 'blue']) {
            for (const type of Object.keys(UNIT_TYPES)) {
                for (const visualDir of unitVisualDirections(type)) {
                    const key = shadowTextureKey(team, type, visualDir);
                    if (this.scene.textures.exists(key)) continue;
                    const F = footProfile(type, visualDir);
                    const sizeK = type === 'cavalry' ? 0.37 : 0.30;
                    const sc = UNIT_TYPES[type].scale * sizeK;
                    const footDx = F.dx * sc;
                    const w = Math.ceil(F.w * sc + Math.abs(footDx) * 2) + 4;
                    const h = Math.ceil(F.h * sc) + 4;
                    const g = this.scene.make.graphics({ add: false });
                    const cx = w / 2, cy = h / 2;
                    g.fillStyle(0x0c1206, 0.30);
                    g.fillEllipse(cx + footDx, cy, F.w * sc, F.h * sc);
                    g.fillStyle(0x0c1206, 0.26);
                    g.fillEllipse(cx + footDx, cy, F.w * sc * 0.62, F.h * sc * 0.62);
                    g.lineStyle(2.2, team === 'red' ? 0xff3b30 : 0x2f7bff, 0.85);
                    g.strokeEllipse(cx + footDx, cy, F.w * sc * 0.78, F.h * sc * 0.78);
                    g.generateTexture(key, w, h);
                    g.destroy();
                }
            }
        }
    }

    // 辎重车贴图运行时生成：木箱车体+双轮+篷顶+队旗（无外部素材依赖）

    // 辎重车贴图运行时生成：木箱车体+双轮+篷顶+队旗（无外部素材依赖）
    ensureWagonTextures() {
        for (const team of ['red', 'blue']) {
            const key = `units/${team}_wagon`;
            if (this.scene.textures.exists(key)) continue;
            const g = this.scene.add.graphics();
            const W = 64, H = 46, accent = team === 'red' ? 0xff5b5b : 0x57a0ff;
            // 车轮（等距椭圆轮）
            g.fillStyle(0x3a2c1a, 1);
            g.fillEllipse(18, H - 10, 16, 9);
            g.fillEllipse(46, H - 10, 16, 9);
            g.lineStyle(2, 0x241a0e, 1);
            g.strokeEllipse(18, H - 10, 16, 9);
            g.strokeEllipse(46, H - 10, 16, 9);
            g.fillStyle(0xc9a35f, 1);
            g.fillEllipse(18, H - 10, 5, 3);
            g.fillEllipse(46, H - 10, 5, 3);
            // 车箱
            g.fillStyle(0x8a6a3e, 1);
            g.fillPoints([{ x: 8, y: H - 14 }, { x: 56, y: H - 14 }, { x: 58, y: H - 30 }, { x: 6, y: H - 30 }], true);
            g.lineStyle(2, 0x5d4322, 1);
            g.strokePoints([{ x: 8, y: H - 14 }, { x: 56, y: H - 14 }, { x: 58, y: H - 30 }, { x: 6, y: H - 30 }], true, true);
            // 篷顶弧
            g.fillStyle(0xd8cfb4, 1);
            g.fillTriangle(4, H - 30, 60, H - 30, 32, H - 44);
            g.lineStyle(2, 0x8f8468, 0.8);
            g.strokeTriangle(4, H - 30, 60, H - 30, 32, H - 44);
            // 队旗小杆
            g.lineStyle(2, 0x241a0e, 1);
            g.lineBetween(56, H - 30, 56, H - 44);
            g.fillStyle(accent, 1);
            g.fillTriangle(56, H - 44, 64, H - 41, 56, H - 38);
            g.generateTexture(key, W, H);
            g.destroy();
        }
    }
}
