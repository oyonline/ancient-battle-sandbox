// 相机装配：初始化/适配视口/锚点缩放（纯视图层，场景经 render.camera 调用）。
import { board } from '../board.js';
import { TH, OY, VIEW_W, VIEW_H } from './metrics.js';

export class CameraRig {
    constructor(scene) { this.scene = scene; }

    setupCamera() {
        const cam = this.scene.cameras.main;
        this.scene.userZoom = 1;
        this.scene.mapCenter = { x: VIEW_W / 2, y: OY + (board.W + board.H) * TH / 4 };

        // 相机铺满策略：以地图对角线为基准计算缩放，窗口比例不同则多露水面
        this.fitCamera();
        this.scene.scale.on('resize', () => this.fitCamera());

        // 拖拽平移
        this.scene.input.on('pointermove', p => {
            if (p.isDown && !this.scene._pinching) {
                cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
                cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
            }
        });
        // 滚轮缩放：以光标为锚点缩放（乘法步进，大范围下手感均匀）
        this.scene.input.on('wheel', (p, go, dx, dy) => {
            const anchor = cam.getWorldPoint(p.x, p.y);
            this.scene.userZoom = Phaser.Math.Clamp(this.scene.userZoom * (dy > 0 ? 0.88 : 1.14), 0.85, 6);
            this.applyZoom(anchor, p);
        });
    }

    // 依据窗口尺寸计算铺满缩放（覆盖式：宁可多裁四角水面，不留黑边）

    // 依据窗口尺寸计算铺满缩放（覆盖式：宁可多裁四角水面，不留黑边）
    fitCamera() {
        const cam = this.scene.cameras.main;
        const w = this.scene.scale.gameSize.width;
        const h = this.scene.scale.gameSize.height;
        // 领土征服大地图：默认不整图铺满（千人单位会小到看不清）——取整图缩放与
        // "约 55% 地图宽"两者的较大值作舒适基准；镜头初始对准红方大本营与中央
        // 高地之间，全局定位交给小地图（resize 只重设缩放，不抢已平移的镜头）。
        if (this.scene.battleOptions.territory) {
            const mw = VIEW_W + 260, mh = VIEW_H + 320;
            this.scene.baseZoom = Math.max(Math.max(w / mw, h / mh) * 1.06, w / (VIEW_W * 0.55));
            cam.setBounds(0, 0, VIEW_W, VIEW_H);
            this.applyZoom();
            if (!this.scene._territoryCamInit && this.scene.units.length) {
                this.scene._territoryCamInit = true;
                const home = this.scene.groundPoint(board.W * 0.3, board.H / 2);
                cam.centerOn((home.x + this.scene.mapCenter.x) / 2, (home.y + this.scene.mapCenter.y) / 2);
            }
            if (this.scene.ocean) this.scene.render.world.redrawOcean();
            return;
        }
        // 地图的世界包围盒（含装饰余量）
        const mw = VIEW_W + 260, mh = VIEW_H + 320;
        this.scene.baseZoom = Math.max(w / mw, h / mh) * 1.06;
        // 平移边界 = 地图菱形外扩一圈，缩多大都不会把地图拖出视野
        cam.setBounds(-320, -40, VIEW_W + 640, VIEW_H + 200);
        if ((this.scene.tactics || this.scene.battleOptions.terrain !== 'flat') && this.scene.units.length) {
            const points = this.scene.units.flatMap(unit => [this.scene.groundPoint(unit.gx, unit.gy),
                ...(unit.route || []).map(point => this.scene.groundPoint(point.gx, point.gy))]);
            const minX = Math.min(...points.map(p => p.x)) - 100, maxX = Math.max(...points.map(p => p.x)) + 100;
            const minY = Math.min(...points.map(p => p.y)) - 110, maxY = Math.max(...points.map(p => p.y)) + 100;
            this.scene.baseZoom = Math.min((w - 40) / (maxX - minX), Math.max(220, h - 230) / (maxY - minY));
            this.applyZoom();
            cam.centerOn((minX + maxX) / 2, (minY + maxY) / 2 + 45 / cam.zoom);
            if (this.scene.ocean) this.scene.render.world.redrawOcean();
            return;
        }
        this.applyZoom();
        cam.centerOn(this.scene.mapCenter.x, this.scene.mapCenter.y);
        if (this.scene.ocean) this.scene.render.world.redrawOcean();
    }

    // anchorWorld/anchorScreen：保持缩放锚点（光标）下的世界坐标不动

    // anchorWorld/anchorScreen：保持缩放锚点（光标）下的世界坐标不动
    applyZoom(anchorWorld, anchorScreen) {
        const cam = this.scene.cameras.main;
        cam.setZoom(this.scene.baseZoom * this.scene.userZoom);
        if (anchorWorld && anchorScreen) {
            const after = cam.getWorldPoint(anchorScreen.x, anchorScreen.y);
            cam.scrollX += anchorWorld.x - after.x;
            cam.scrollY += anchorWorld.y - after.y;
        }
    }

    // ---------------- 部署与开战 ----------------
}
