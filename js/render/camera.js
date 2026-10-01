// 相机装配：初始化/适配视口/锚点缩放（纯视图层，场景经 render.camera 调用）。
import { board } from '../board.js';
import { TH, OY, VIEW_W, VIEW_H } from './metrics.js';

// 点击/拖动门槛：与点选规则（inspection.js）严格同一边界——位移 > 6px 才算
// 拖动（点选同时按 dragged 取消）；恰好 6px 及以内是点击（点兵轻微抖手不挪
// 镜头），不会同时触发拖动与点选。
const DRAG_THRESHOLD_PX = 6;

export class CameraRig {
    constructor(scene) { this.scene = scene; }

    setupCamera() {
        const cam = this.scene.cameras.main;
        this.scene.userZoom = 1;
        this.scene.mapCenter = { x: VIEW_W / 2, y: OY + (board.W + board.H) * TH / 4 };

        // 相机铺满策略：以地图对角线为基准计算缩放，窗口比例不同则多露水面
        this.fitCamera();
        // 窗口尺寸变化：保留当前观察位置（视口中心的世界点），只允许边界夹取，
        // 不重新对准部队/重算镜头——fitCamera 只在开局、开战等显式时机调用。
        this.scene.events.on('prerender', this.onPrerender, this);
        this.scene.scale.on('resize', this.onResize, this);
        // 失焦即放弃一切未完成手势：窗口失焦/切走后指针状态不可信（如窗外
        // 释放后 Phaser 的 isDown 可能残留 true），拖动状态必须清空重来。
        this._onBlur = () => { this._pan = null; };
        this.scene.game?.events?.on('blur', this._onBlur);
        this.scene.events.once('shutdown', () => {
            this.scene.events.off('prerender', this.onPrerender, this);
            this.scene.scale.off('resize', this.onResize, this);
            this.scene.game?.events?.off('blur', this._onBlur);
        });

        // 拖拽平移：点击/拖动按 DRAG_THRESHOLD_PX 区分，越过门槛后按帧位移平移。
        // 手势归属由按下位置决定：小地图上按下的指针（scene._minimapGesture）
        // 不归战场平移；战场拖动拖进小地图也不会被小地图抢去跳镜头（见 overlay）。
        this._pan = null;
        this.scene.input.on('pointerdown', p => {
            this._pan = { id: p.id, x: p.x, y: p.y, active: false };
        });
        this.scene.input.on('pointermove', p => {
            const pan = this._pan;
            if (!pan || p.id !== pan.id || !p.isDown || this.scene._pinching) return;
            if (this.scene._minimapGesture === p.id) return;   // 小地图手势不归战场
            if ((p.event?.buttons ?? 1) === 0) {
                // 真实按钮已全部抬起（窗外释放/失焦后 isDown 残留）：手势作废
                this._pan = null;
                return;
            }
            if (!pan.active) {
                if (Math.hypot(p.x - pan.x, p.y - pan.y) <= DRAG_THRESHOLD_PX) return;
                pan.active = true;   // 严格超过门槛才确认拖动，从当前帧起平移
            }
            cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
            cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
        });
        // 抬起、区域外释放都收尾，避免残留拖动状态
        const endPan = p => { if (this._pan && p.id === this._pan.id) this._pan = null; };
        this.scene.input.on('pointerup', endPan);
        this.scene.input.on('pointerupoutside', endPan);
        // 滚轮缩放：以光标为锚点缩放（乘法步进，大范围下手感均匀）
        this.scene.input.on('wheel', (p, go, dx, dy) => {
            const anchor = cam.getWorldPoint(p.x, p.y);
            this.scene.userZoom = Phaser.Math.Clamp(this.scene.userZoom * (dy > 0 ? 0.88 : 1.14), 0.85, 6);
            this.applyZoom(anchor, p);
        });
    }

    // 每帧记住本帧将渲染的视口中心（世界坐标）：resize 以此为准恢复观察位置。
    // 不读 midPoint/worldView——centerOn（如小地图跳转）会把 midPoint 写成未夹取
    // 落点、worldView 又是上一帧的旧值；此处用 preRender 同款算法从当前 scroll
    // 推导（边界夹取 + scroll + size/2），与本帧即将渲染的视口一致、零帧滞后。
    onPrerender() {
        if (this._pendingResizeRestore) {
            // resize 事件先于相机尺寸更新的竞态：本帧尺寸已是新值，再校一次
            // 观察中心；本帧不捕获（保持 resize 前的观察中心）。
            this._pendingResizeRestore = false;
            this.restoreViewCenter();
            return;
        }
        const cam = this.scene.cameras.main;
        const sx = cam.useBounds ? cam.clampX(cam.scrollX) : cam.scrollX;
        const sy = cam.useBounds ? cam.clampY(cam.scrollY) : cam.scrollY;
        this._viewCenter = { x: sx + cam.width / 2, y: sy + cam.height / 2 };
    }

    restoreViewCenter() {
        if (this._viewCenter) this.scene.cameras.main.centerOn(this._viewCenter.x, this._viewCenter.y);
    }

    // 窗口尺寸变化：缩放与观察中心都保持不动；中心若越出边界，由相机
    // setBounds 后的预渲染夹取拉回——不重新追踪部队、不重算基准缩放。
    // resize 事件与相机尺寸更新的先后次序不保证：先立即恢复一次，再在
    // 下一帧（尺寸必已更新）兜底校正一次，两条路径都收敛到原观察中心。
    onResize() {
        this.restoreViewCenter();
        this._pendingResizeRestore = true;
        if (this.scene.ocean) this.scene.render.world.redrawOcean();
    }

    // 依据窗口尺寸计算铺满缩放（覆盖式：宁可多裁四角水面，不留黑边）

    // 依据窗口尺寸计算铺满缩放（覆盖式：宁可多裁四角水面，不留黑边）
    fitCamera() {
        const cam = this.scene.cameras.main;
        const w = this.scene.scale.gameSize.width;
        const h = this.scene.scale.gameSize.height;
        // 领土征服大地图：默认不整图铺满（千人单位会小到看不清）——舒适基准锚定
        // 固定世界窗口宽（≈旧 104×72 图的 55% 宽 ≈ 3100px）：地图放大后单位像素
        // 大小不变、多出的疆域靠平移/小地图探索，"变大"才看得见；若按当前图宽
        // 取 55%，放大只会等比缩小单位，屏幕上毫无变化。整图铺满项仍作下限。
        if (this.scene.battleOptions.territory) {
            const mw = VIEW_W + 260, mh = VIEW_H + 320;
            const comfortWindow = Math.min(VIEW_W * 0.55, 3100);
            this.scene.baseZoom = Math.max(Math.max(w / mw, h / mh) * 1.06, w / comfortWindow);
            cam.setBounds(0, 0, VIEW_W, VIEW_H);
            this.applyZoom();
            if (!this.scene._territoryCamInit && this.scene.units.length) {
                this.scene._territoryCamInit = true;
                const side = this.scene.netMySide || 'red';
                const home = this.scene.groundPoint(side === 'blue' ? board.W - 20 : 20, board.H / 2);
                cam.centerOn(home.x, home.y);
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
