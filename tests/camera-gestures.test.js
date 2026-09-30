// 镜头手势回归：点击/拖动区分、小地图手势归属、resize 保留观察位置。
// 用桩场景捕获 Phaser 事件处理器，断言行为契约而非渲染细节。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraRig } from '../js/render/camera.js';
import { OverlayRenderer } from '../js/render/overlay.js';
import { board } from '../js/board.js';
import { gridToScreen } from '../js/render/metrics.js';

function cameraScene() {
    const handlers = { input: {}, scale: {}, events: {}, game: {} };
    const cam = {
        width: 800, height: 600, zoom: 2, scrollX: 100, scrollY: 50, useBounds: false,
        clampX(v) { return v; }, clampY(v) { return v; },
        setZoom(z) { this.zoom = z; },
        setBounds() { this._boundsSet = true; },
        centerOn(x, y) { (this._centers ??= []).push({ x, y }); },
        getWorldPoint(x, y) { return { x: this.scrollX + x / this.zoom, y: this.scrollY + y / this.zoom }; }
    };
    const scene = {
        cameras: { main: cam },
        battleOptions: { territory: false, terrain: 'flat' },
        tactics: null, units: [], ocean: null,
        game: { events: { on(n, f) { handlers.game[n] = f; }, off() {} } },
        scale: { gameSize: { width: 800, height: 600 }, on(n, f) { handlers.scale[n] = f; }, off() {} },
        events: { on(n, f) { handlers.events[n] = f; }, once(n, f) { handlers.events[n] = f; }, off() {} },
        input: { on(n, f) { (handlers.input[n] ??= []).push(f); }, off(n, f) { handlers.input[n] = (handlers.input[n] || []).filter(g => g !== f); } },
        render: { world: {} },
    };
    const rig = new CameraRig(scene);
    rig.setupCamera();
    return { rig, scene, cam, handlers };
}

function pointer(id, x, y, prevX, prevY, isDown = true, buttons = 1) {
    return { id, x, y, isDown, buttons, event: { buttons }, prevPosition: { x: prevX ?? x, y: prevY ?? y } };
}

test('点兵轻微抖手不移镜头：6px 内（含恰好 6px）是点击不是拖动', () => {
    const { handlers, cam } = cameraScene();
    const beforeX = cam.scrollX, beforeY = cam.scrollY;
    handlers.input.pointerdown.forEach(f => f(pointer(1, 300, 200)));
    handlers.input.pointermove.forEach(f => f(pointer(1, 302, 201, 300, 200)));   // 累计 2.2px
    handlers.input.pointermove.forEach(f => f(pointer(1, 304, 202, 302, 201)));   // 累计 4.5px
    handlers.input.pointermove.forEach(f => f(pointer(1, 306, 200, 304, 202)));   // 恰好 6px：与点选同界，仍是点击
    assert.equal(cam.scrollX, beforeX, '点击抖手（含恰好 6px）不得平移镜头');
    assert.equal(cam.scrollY, beforeY);
    handlers.input.pointerup.forEach(f => f(pointer(1, 306, 200, 306, 200, false)));
    assert.equal(cam.scrollX, beforeX);
});

test('明确拖动正常平移：严格超过 6px 后按帧位移平移', () => {
    const { handlers, cam } = cameraScene();
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    handlers.input.pointerdown.forEach(f => f(pointer(1, 300, 200)));
    handlers.input.pointermove.forEach(f => f(pointer(1, 308, 200, 300, 200)));   // 8px：确认拖动，从本帧起平移
    assert.ok(near(cam.scrollX, 100 - 8 / cam.zoom), '越过门槛的首帧位移应生效');
    handlers.input.pointermove.forEach(f => f(pointer(1, 316, 205, 308, 200)));
    assert.ok(near(cam.scrollX, 100 - 16 / cam.zoom));
    assert.ok(near(cam.scrollY, 50 - 5 / cam.zoom));
    handlers.input.pointerup.forEach(f => f(pointer(1, 316, 205, 316, 205, false)));
    const settled = cam.scrollX;
    handlers.input.pointermove.forEach(f => f(pointer(1, 330, 205, 316, 205)));  // 抬起后不再拖
    assert.equal(cam.scrollX, settled, '抬起后移动不得继续平移');
});

test('真实按钮已抬起（buttons=0）的移动不拖镜头，且手势作废', () => {
    const { handlers, cam, rig } = cameraScene();
    handlers.input.pointerdown.forEach(f => f(pointer(1, 300, 200)));
    handlers.input.pointermove.forEach(f => f(pointer(1, 320, 200, 300, 200)));   // 正常拖动
    assert.ok(cam.scrollX < 100, '已进入拖动');
    // 窗外释放后 Phaser 的 isDown 残留 true，但 DOM 事件 buttons=0
    handlers.input.pointermove.forEach(f => f(pointer(1, 340, 200, 320, 200, true, 0)));
    const settled = cam.scrollX;
    assert.equal(rig._pan, null, 'buttons=0 的移动必须作废拖动手势');
    handlers.input.pointermove.forEach(f => f(pointer(1, 360, 200, 340, 200)));   // 后续移动不再平移
    assert.equal(cam.scrollX, settled, '手势作废后不得继续平移');
});

test('失焦清空拖动状态，不残留', () => {
    const { handlers, cam, rig } = cameraScene();
    assert.ok(handlers.game.blur, '应在 game.events 注册 blur 监听');
    handlers.input.pointerdown.forEach(f => f(pointer(1, 300, 200)));
    handlers.input.pointermove.forEach(f => f(pointer(1, 320, 200, 300, 200)));
    assert.ok(cam.scrollX < 100, '已进入拖动');
    handlers.game.blur();   // 窗口失焦
    assert.equal(rig._pan, null, '失焦必须清空拖动状态');
    const settled = cam.scrollX;
    handlers.input.pointermove.forEach(f => f(pointer(1, 340, 200, 320, 200)));
    assert.equal(cam.scrollX, settled, '失焦后移动不得继续平移');
});

test('小地图手势不归战场：按下属于小地图的指针不触发平移', () => {
    const { handlers, scene, cam } = cameraScene();
    scene._minimapGesture = 1;   // 该指针在小地图上按下
    const before = cam.scrollX;
    handlers.input.pointermove.forEach(f => f(pointer(1, 300, 200, 290, 200)));
    assert.equal(cam.scrollX, before, '小地图手势期间战场不得平移');
});

test('抬起/区域外释放清理拖动状态，不残留', () => {
    const { handlers, cam } = cameraScene();
    handlers.input.pointerdown.forEach(f => f(pointer(1, 300, 200)));
    handlers.input.pointermove.forEach(f => f(pointer(1, 320, 200, 300, 200)));
    assert.ok(cam.scrollX < 100, '已进入拖动');
    handlers.input.pointerupoutside.forEach(f => f(pointer(1, 340, 200, 320, 200, false)));
    const settled = cam.scrollX;
    handlers.input.pointermove.forEach(f => f(pointer(1, 360, 200, 340, 200)));
    assert.equal(cam.scrollX, settled, '区域外释放后拖动状态必须清空');
});

test('resize 保留观察位置：不重新对准部队、不重算缩放', () => {
    const { rig, handlers, cam } = cameraScene();
    handlers.events.prerender.call(rig);          // 记住当前视口中心（世界坐标）
    const viewCenter = { x: cam.scrollX + cam.width / 2, y: cam.scrollY + cam.height / 2 };
    const zoomBefore = cam.zoom;
    const fitCalls = [];
    const realFit = rig.fitCamera.bind(rig);
    rig.fitCamera = () => { fitCalls.push(1); realFit(); };
    // 路径一：resize 事件时相机尺寸已更新
    const centersBefore = cam._centers?.length ?? 0;
    cam.width = 1280; cam.height = 720;
    handlers.scale.resize.call(rig);
    // 路径二：相机尺寸在事件之后才更新（竞态）——下一帧 prerender 兜底再校一次
    cam.width = 1000; cam.height = 640;
    handlers.events.prerender.call(rig);
    assert.equal(fitCalls.length, 0, 'resize 不得调用 fitCamera 重新追踪部队');
    assert.equal(cam.zoom, zoomBefore, 'resize 不得重算缩放');
    const restores = cam._centers.slice(centersBefore);
    assert.equal(restores.length, 2, '立即恢复 + 下一帧兜底各一次');
    for (const c of restores) {
        assert.ok(Math.abs(c.x - viewCenter.x) < 1e-6 && Math.abs(c.y - viewCenter.y) < 1e-6,
            `观察中心应保持 (${viewCenter.x.toFixed(1)},${viewCenter.y.toFixed(1)})，实际 (${c.x.toFixed(1)},${c.y.toFixed(1)})`);
    }
});

// ---------------- 小地图 ----------------

function minimapScene() {
    const zoneHandlers = {};
    const sceneHandlers = { pointerup: [], pointerupoutside: [] };
    let blurHandler = null;
    const cam = { width: 800, height: 600, centerOn(x, y) { (this._centers ??= []).push({ x, y }); } };
    const makeStub = () => {
        const stub = {
            on(event, fn) { zoneHandlers[event] = fn; return proxy; },
            destroy() { stub.destroyed = true; },
        };
        const proxy = new Proxy(stub, {
            get(target, prop) {
                if (prop in target) return target[prop];
                return () => proxy;
            }
        });
        return proxy;
    };
    const gfx = makeStub(), zone = makeStub();
    const scene = {
        cameras: { main: cam },
        add: { graphics: () => gfx, rectangle: () => zone },
        input: {
            on(n, f) { sceneHandlers[n]?.push(f); },
            off(n, f) { if (sceneHandlers[n]) sceneHandlers[n] = sceneHandlers[n].filter(g => g !== f); }
        },
        game: { events: { on(n, f) { if (n === 'blur') blurHandler = f; }, off() {} } },
        _minimap: null, _minimapGesture: null,
    };
    const renderer = new OverlayRenderer(scene);
    renderer.buildMinimap();
    return { renderer, scene, cam, zoneHandlers, sceneHandlers, blurHandler: () => blurHandler?.() };
}

const stopped = () => { const s = { stopped: false }; s.event = { stopPropagation() { s.stopped = true; } }; return s; };

test('战场拖动经过小地图不被抢走：未在小地图按下时不跳镜头', () => {
    const { scene, zoneHandlers, cam } = minimapScene();
    scene._minimapGesture = null;
    const s = stopped();
    zoneHandlers.pointermove({ id: 1, isDown: true, x: scene._minimap.x + 10, y: scene._minimap.y + 10 }, 0, 0, s.event);
    assert.equal(cam._centers, undefined, '战场拖动经过小地图不得触发跳镜头');
    assert.equal(s.stopped, false, '不得吞掉战场拖动的事件');
});

test('小地图主动点击/拖动仍能定位：按下即跳，按住拖动持续定位', () => {
    const { scene, zoneHandlers, cam } = minimapScene();
    const { x, y, w, h } = scene._minimap;
    const s1 = stopped();
    zoneHandlers.pointerdown({ id: 2, isDown: true, x: x + w / 2, y: y + h / 2 }, 0, 0, s1.event);
    assert.equal(scene._minimapGesture, 2, '按下即登记手势归属');
    assert.equal(cam._centers.length, 1);
    const expect = gridToScreen(clampI((x + w / 2 - x) / w * board.W), clampI((y + h / 2 - y) / h * board.H));
    assert.ok(Math.abs(cam._centers[0].x - expect.x) < 1e-6, '点击位置应映射为世界坐标跳镜头');
    const s2 = stopped();
    zoneHandlers.pointermove({ id: 2, isDown: true, x: x + w * 0.25, y: y + h * 0.75 }, 0, 0, s2.event);
    assert.equal(cam._centers.length, 2, '按住拖动应持续定位');
    assert.equal(s2.stopped, true, '本手势内仍拦截事件传播');
    // 其他指针（多点触控的第二根手指）不触发
    const s3 = stopped();
    zoneHandlers.pointermove({ id: 3, isDown: true, x: x, y: y }, 0, 0, s3.event);
    assert.equal(cam._centers.length, 2);
});

function clampI(v) { return Math.max(0, Math.min(board.W, v)); }

test('小地图手势收尾：抬起/区域外释放/失焦/buttons=0 清理归属，销毁不残留监听', () => {
    const { renderer, scene, zoneHandlers, sceneHandlers, blurHandler } = minimapScene();
    const s = stopped();
    zoneHandlers.pointerdown({ id: 5, isDown: true, x: 0, y: 0 }, 0, 0, s.event);
    assert.equal(scene._minimapGesture, 5);
    const up = stopped();
    zoneHandlers.pointerup({ id: 5 }, 0, 0, up.event);          // 在小地图上抬起
    assert.equal(scene._minimapGesture, null, '抬起必须清理手势归属');
    zoneHandlers.pointerdown({ id: 6, isDown: true, x: 0, y: 0 }, 0, 0, stopped().event);
    sceneHandlers.pointerupoutside.forEach(f => f({ id: 6 }));   // 区域外释放兜底
    assert.equal(scene._minimapGesture, null, '区域外释放必须清理手势归属');
    // 窗外释放后 isDown 残留、buttons=0：小地图不得继续跳转
    zoneHandlers.pointerdown({ id: 8, isDown: true, x: 0, y: 0 }, 0, 0, stopped().event);
    const centersBefore = cam_centers(renderer);
    zoneHandlers.pointermove({ id: 8, isDown: true, event: { buttons: 0 }, x: 10, y: 10 }, 0, 0, stopped().event);
    assert.equal(scene._minimapGesture, null, 'buttons=0 的移动必须终止小地图手势');
    assert.equal(cam_centers(renderer), centersBefore, 'buttons=0 不得触发跳镜头');
    // 失焦清理
    zoneHandlers.pointerdown({ id: 9, isDown: true, x: 0, y: 0 }, 0, 0, stopped().event);
    blurHandler();   // 窗口失焦
    assert.equal(scene._minimapGesture, null, '失焦必须清理手势归属');
    zoneHandlers.pointerdown({ id: 7, isDown: true, x: 0, y: 0 }, 0, 0, stopped().event);
    const sceneListenerCount = sceneHandlers.pointerup.length;
    renderer.destroyMinimap();
    assert.equal(scene._minimap, null);
    assert.equal(scene._minimapGesture, null, '销毁小地图必须清掉手势归属');
    assert.equal(sceneHandlers.pointerup.length, sceneListenerCount - 1, '销毁必须摘掉场景级监听');
});

function cam_centers(renderer) {
    return renderer.scene.cameras.main._centers?.length ?? 0;
}
