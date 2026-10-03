// F2 选择三修回归（用户复验否决项）：
// 1) 高地/坡缘漏选（逆投影桶覆盖不足） 2) 重叠营旗选到下层（与显示层级不一致）
// 3) 普通态建筑吞掉营旗点击（groundClick 消费优先级）。全部真实指针事件链复现。
// F7（R2 复审）：选中重排/懒重建路径下重叠旗绘制序真修 + 高度域覆盖界守卫。
import test from 'node:test';
import assert from 'node:assert/strict';
import { UnitInspector, LIFT_SPAN_PX } from '../js/inspection.js';
import { CampControls } from '../js/camp-controls.js';
import { UI } from '../js/ui.js';
import { makeScene, addUnit } from './battle-harness.js';
import { Terrain } from '../js/terrain.js';
import { board, setBoardSize, resetBoardSize } from '../js/board.js';

function baseFixture(t, options = {}) {
    const previousDocument = globalThis.document;
    const panel = { hidden: true, innerHTML: '' };
    globalThis.document = { getElementById: () => panel };
    t.after(() => { globalThis.document = previousDocument; });
    const scene = makeScene();
    if (options.terrain) scene.setTerrain(options.terrain);
    if (options.deploy !== false) {
        scene.deployUnits(options.red ?? { infantry: 6 }, options.blue ?? { infantry: 6 },
            'custom', 'custom', {}, { territory: true, territoryAI: false,
                terrain: options.terrain ?? 'flat' });
    }
    scene.battleStarted = true;
    scene.render.camps.pick = options.campsPick ?? (() => null);
    const events = new Map();
    scene.input = { on: (name, fn) => events.set(name, fn), off: name => events.delete(name) };
    scene.game = { events: { on() {}, off() {} } };
    scene.events = { once() {} };
    scene.cameras.main.zoom = options.zoom ?? 1;
    scene.cameras.main.getWorldPoint = (x, y) => ({ x, y });
    const inspector = new UnitInspector(scene);
    scene.unitInspector = inspector;
    scene.rebuildSpatial();
    const groundClicks = [];
    scene.groundClick = (world, picked, markerBattalion) => {
        groundClicks.push({ world, picked, markerBattalion });
        return options.groundClickResult;
    };
    const click = (x, y) => {
        const pointer = { id: 1, x, y };
        events.get('pointerdown')(pointer);
        events.get('pointerup')(pointer);
    };
    const move = (x, y) => events.get('pointermove')({ id: 9, x, y });
    const bodyPoint = unit => {
        const p = scene.groundPoint(unit.gx, unit.gy);
        return { x: p.x, y: p.y - (unit.type === 'cavalry' ? 24 : 18) };
    };
    return { scene, inspector, events, click, move, bodyPoint, groundClicks, panel };
}

// ---------------- 1) 高地/坡缘/领土图逐格扫描：点骑兵身体必选中 ----------------

test('高地点骑兵身体选不中（复现）：坡缘/坡顶逐格扫描拾取零漏选', t => {
    const misses = [];
    let checked = 0;
    for (const terrain of ['red_hill', 'blue_hill', 'red_pass', 'blue_pass', 'territory']) {
        const { scene, inspector, click } = baseFixture(t, { deploy: false, terrain });
        scene.battleOptions.territory = true;
        const cavalry = addUnit(scene, 'red', 'cavalry', 20, 35);
        for (let gx = 6; gx < 64; gx += 1) {
            for (let gy = 8; gy < 62; gy += 2) {
                cavalry.gx = gx; cavalry.gy = gy;
                scene.rebuildSpatial();
                const point = scene.groundPoint(gx, gy);
                click(point.x, point.y - 24);   // 点击骑兵身体中心（原全量几何必命中区域）
                checked++;
                if (inspector.selected !== cavalry) misses.push(`${terrain}@(${gx},${gy}) h=${(scene.terrainHeight?.(gx, gy) ?? 0).toFixed(2)}`);
                inspector.selected = null;
                scene.selectedBattalion = null;
            }
        }
    }
    assert.ok(checked > 3000, `扫描覆盖要足量（实际 ${checked}）`);
    assert.deepEqual(misses.slice(0, 12), [], `高地/坡缘身体点击不得漏选：${misses.length}/${checked} 处漏选，如 ${misses[0]}`);
    assert.equal(misses.length, 0, `全部地形扫描零漏选（漏选 ${misses.length} 处）`);
});

test('高地点悬停预览与点击一致：坡缘先悬停后点击选同一骑兵', t => {
    // red_pass 山脊东坡（全图扫描的实漏点位之一，高度 ~4.6 层）
    const { scene, inspector, click, move, bodyPoint } = baseFixture(t, { deploy: false, terrain: 'red_pass' });
    scene.battleOptions.territory = true;
    const cavalry = addUnit(scene, 'red', 'cavalry', 14, 36);
    scene.rebuildSpatial();
    const point = bodyPoint(cavalry);
    move(point.x, point.y);
    assert.equal(inspector.hover?.unit, cavalry, '悬停预览指向该骑兵');
    click(point.x, point.y);
    assert.equal(inspector.selected, cavalry, '点击与悬停预览选同一目标');
});

// ---------------- 2) 重叠营旗：显示在上层者优先 ----------------

test('重叠营旗选到下面那面（复现）：点击与显示层级一致，选后绘制的营', t => {
    const { scene, inspector, click, move } = baseFixture(t, { zoom: 0.4 });
    const overlay = scene.render.overlay;
    const reds = scene.battalions.battalions.filter(b => b.team === 'red');
    assert.ok(reds.length >= 2, '需要至少两个己方营');
    const [first, second] = reds;
    // 2 营成员搬到与 1 营完全同位：两面同尺寸旗完全重叠，绘制序 1→2，2 营显示在上
    second.members.forEach((u, i) => {
        u.gx = first.members[i % first.members.length].gx;
        u.gy = first.members[i % first.members.length].gy;
    });
    scene.rebuildSpatial();
    overlay.updateBattalionMarkers();
    const rects = overlay.markerRects.filter(r => r.battalion === first || r.battalion === second);
    assert.equal(rects.length, 2, '两面旗都在场');
    const cx = (rects[0].x + rects[0].w / 2 + rects[1].x + rects[1].w / 2) / 2;
    const cy = (rects[0].y + rects[0].h / 2 + rects[1].y + rects[1].h / 2) / 2;
    move(cx, cy);
    assert.equal(inspector.hover?.battalion, second, '悬停预览指向显示在上层的营');
    click(cx, cy);
    assert.equal(scene.selectedBattalion, second, '点击必须选中显示在上层（后绘制）的营');
});

// ---------------- 3) 普通态建筑不吞营旗/部队点击 ----------------

function buildingFixture(t, options = {}) {
    const previousDocument = globalThis.document;
    const panel = { hidden: true, innerHTML: '', addEventListener() {}, replaceChildren() {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false } };
    globalThis.document = { getElementById: () => panel,
        body: { classList: { add() {}, remove() {}, toggle() {} } } };
    t.after(() => { globalThis.document = previousDocument; });
    const building = { id: 'camp:red:home', type: 'camp', team: 'red', siteId: 'home', complete: true, dead: false,
        garrisonIds: [], gx: 30, gy: 30, hp: 100 };
    const scene = makeScene();
    scene.deployUnits({ infantry: 6 }, { infantry: 6 }, 'custom', 'custom', {},
        { territory: true, territoryAI: false, terrain: 'flat' });
    scene.battleStarted = true;
    scene.render.camps.pick = () => building;    // 旗下方就是大本营建筑
    const events = new Map();
    scene.input = { on: (name, fn) => events.set(name, fn), off: name => events.delete(name) };
    scene.game = { events: { on() {}, off() {} } };
    scene.events = { once() {} };
    scene.cameras.main.zoom = options.zoom ?? 1;
    scene.cameras.main.getWorldPoint = (x, y) => ({ x, y });
    const ui = { ...UI, scene, phase: 'battle', mySide: 'red', countdown: false,
        battleOptions: { territory: true, net: false }, holdStops: [], _pendingBuys: [], _seenTerritoryTips: new Set(),
        showNetToast() {} };
    ui.campControls = new CampControls(ui);
    const inspector = new UnitInspector(scene);
    scene.unitInspector = inspector;
    scene.groundClick = (world, picked, markerBattalion) => ui.onGroundClick(world, picked, markerBattalion);
    scene.rebuildSpatial();
    const click = (x, y) => {
        const pointer = { id: 1, x, y };
        events.get('pointerdown')(pointer);
        events.get('pointerup')(pointer);
    };
    return { scene, ui, inspector, click, building, controls: ui.campControls };
}

test('普通态点大本营上方营旗（复现）：选营不弹建筑面板、不清空选择', t => {
    const { scene, ui, inspector, click, controls, building } = buildingFixture(t, { zoom: 0.4 });
    const overlay = scene.render.overlay;
    overlay.updateBattalionMarkers();
    const rect = overlay.markerRects.find(r => r.battalion.team === 'red');
    assert.ok(rect, '营旗在场');
    click(rect.x + rect.w / 2, rect.y + rect.h / 2);
    assert.equal(controls.buildingId, null, '普通态点营旗不得打开建筑面板');
    assert.equal(controls.workerId, null);
    assert.ok(scene.selectedBattalion, '普通态点营旗必须选中营');
    assert.equal(inspector.selected?.battalion, scene.selectedBattalion);
    void building; void ui;
});

test('普通态点站在建筑上的己方部队：选中部队不开面板；点纯建筑仍开面板', t => {
    const { scene, inspector, click, controls, building } = buildingFixture(t);
    const soldier = scene.units.find(u => u.team === 'red' && u.type === 'infantry');
    const point = scene.groundPoint(soldier.gx, soldier.gy);
    click(point.x, point.y - 18);
    assert.equal(inspector.selected, soldier, '部队命中优先于建筑面板');
    assert.equal(controls.buildingId, null, '不得弹出建筑面板');
    assert.ok(scene.selectedBattalion);
    // 对照：无营旗/部队命中的位置（点空地旁的建筑判定点）仍走建筑逻辑
    const empty = scene.groundPoint(12, 12);
    click(empty.x, empty.y);
    assert.equal(controls.buildingId, building.id, '无拾取命中时建筑面板照常打开');
    assert.equal(scene.selectedBattalion, null, '建筑选择清空营选择（原行为保留）');
    assert.equal(inspector.selected, null);
});

test('普通态点站在建筑上的己方民夫：仍交建设面板选择（不因部队优先而丢）', t => {
    const { scene, click, controls } = buildingFixture(t);
    const worker = addUnit(scene, 'red', 'worker', 20, 30);
    scene.rebuildSpatial();
    const point = scene.groundPoint(worker.gx, worker.gy);
    click(point.x, point.y - 18);
    assert.equal(controls.workerId, worker.id, '己方民夫点击仍进建设面板');
});

test('驻守选点模式的优先消费保留：点旗上下令不选营', t => {
    const { scene, ui, click } = buildingFixture(t, { zoom: 0.4 });
    const overlay = scene.render.overlay;
    overlay.updateBattalionMarkers();
    const rect = overlay.markerRects.find(r => r.battalion.team === 'red');
    const holdOrders = [];
    scene.selectedBattalion = null;
    // 驻守态挂在 controls 所见的同一个 ui 上（与真实 beginHoldTargeting 一致）
    ui.holdTargeting = rect.battalion;
    ui.applyGroundOrder = (world, apply) => apply(30, 30);
    ui.giveHoldOrder = (gx, gy) => holdOrders.push({ k: 'hold', gx, gy });
    ui.cancelHoldTargeting = () => { ui.holdTargeting = null; };
    ui.updateBattalionBar = () => {};
    click(rect.x + rect.w / 2, rect.y + rect.h / 2);
    assert.ok(holdOrders.some(o => o.k === 'hold'), '驻守模式下点旗先下驻守令');
    assert.equal(scene.selectedBattalion, null, '命令消费后不改选营队');
});

// ---------------- F7（R2 复审）：选中重排/懒重建下的重叠旗绘制序 ----------------

// markerRects 生成序在 selected 时被重排为 [selected, ...others]，但 label 的 Phaser
// 显示序由 add.text 插入序决定——"取最后命中"只在 selected===null 时等于显示序。
// 选中"后创建（显示在上层）"的营时，点重叠区会选到下层营（R2 复现，当前应失败）。
test('选中后创建营+旗重叠（R2 复现）：命中必须是视觉上层的营', t => {
    const { scene, inspector, click, move } = baseFixture(t, { zoom: 0.4 });
    const overlay = scene.render.overlay;
    const reds = scene.battalions.battalions.filter(b => b.team === 'red');
    const [first, second] = reds;
    second.members.forEach((u, i) => {
        u.gx = first.members[i % first.members.length].gx;
        u.gy = first.members[i % first.members.length].gy;
    });
    scene.rebuildSpatial();
    // 用户路径：旗已按自然创建序渲染（label 1→2，second 显示在上层），之后才选中 second
    overlay.updateBattalionMarkers();
    scene.selectedBattalion = second;   // 走 updateBattalionMarkers 的 [selected, ...others] 重排路径
    overlay.markerAt = -Infinity;       // 绕过 160ms 节流强制重算（rects 按重排序重建）
    overlay.updateBattalionMarkers();
    const rects = overlay.markerRects.filter(r => r.battalion === first || r.battalion === second);
    assert.equal(rects.length, 2, '两面旗都在场');
    const cx = (rects[0].x + rects[0].w / 2 + rects[1].x + rects[1].w / 2) / 2;
    const cy = (rects[0].y + rects[0].h / 2 + rects[1].y + rects[1].h / 2) / 2;
    move(cx, cy);
    assert.equal(inspector.hover?.battalion, second, '悬停预览指向视觉上层的营（后创建的 label）');
    click(cx, cy);
    assert.equal(scene.selectedBattalion, second, '点击必须选中视觉上层的营，不因选中重排漂移');
});

// view 裁剪/24 面上限会销毁再重建 label：重建的 label 追加到 display list 末尾（显示最上），
// 绘制序必须跟随重赋。partial 重叠 + 视野裁剪单侧营，验证重建后命中翻转到重建旗。
test('营旗懒重建路径（R2 复现）：重建的旗显示在上层，点击选它', t => {
    const { scene, inspector, click, move } = baseFixture(t, { zoom: 0.4 });
    const overlay = scene.render.overlay;
    const reds = scene.battalions.battalions.filter(b => b.team === 'red');
    const [first, second] = reds;
    // 部分重叠：second 在 first 东侧 +2.8 格（世界 x ≈ +90px），两矩形仍有大片重叠区
    second.members.forEach((u, i) => {
        u.gx = first.members[i % first.members.length].gx + 2.8;
        u.gy = first.members[i % first.members.length].gy;
    });
    scene.rebuildSpatial();
    const centroid = battalion => {
        const alive = battalion.members;
        let gx = 0, gy = 0;
        for (const u of alive) { gx += u.gx; gy += u.gy; }
        return scene.groundPoint(gx / alive.length, gy / alive.length);
    };
    scene._view = null;
    overlay.markerAt = -Infinity;
    overlay.updateBattalionMarkers();     // 创建序 first→second：second 在上
    // 视野裁掉 first（只含 second 质心）：first 的 label 被 destroy
    const keep = centroid(second);
    scene._view = { x0: keep.x - 40, y0: keep.y - 40, x1: keep.x + 40, y1: keep.y + 40 };
    overlay.markerAt = -Infinity;
    overlay.updateBattalionMarkers();
    assert.equal(overlay.battalionMarkers.has(first.id), false, '出视野的营旗 label 应被销毁');
    // 放开视野：first 的 label 重建，追加到 display list 末尾 → 显示在 second 之上
    scene._view = null;
    overlay.markerAt = -Infinity;
    overlay.updateBattalionMarkers();
    const rebuilt = overlay.battalionMarkers.get(first.id);
    const kept = overlay.battalionMarkers.get(second.id);
    assert.ok(rebuilt && kept, '两面旗都在场');
    assert.ok(rebuilt.paint > kept.paint, '重建的旗绘制序必须重新赋号且最大（与显示序一致）');
    const rects = overlay.markerRects.filter(r => r.battalion === first || r.battalion === second);
    const overlapX = Math.max(rects[0].x, rects[1].x) + 20;   // 重叠区内部一点
    const overlapY = (rects[0].y + rects[1].y) / 2 + rects[0].h / 2;
    move(overlapX, overlapY);
    assert.equal(inspector.hover?.battalion, first, '悬停预览指向重建后显示上层的旗');
    click(overlapX, overlapY);
    assert.equal(scene.selectedBattalion, first, '点击选中重建后显示上层的旗');
});

// ---------------- P2-2：覆盖界高度域守卫（变更即断） ----------------

test('高度域守卫：全部地形（含大图领土）高度跨度不超过覆盖界常数 LIFT_SPAN_PX', () => {
    const spans = [];
    const scan = key => {
        let min = Infinity, max = -Infinity;
        for (let gx = 1; gx < board.W; gx++) {
            for (let gy = 1; gy < board.H; gy++) {
                const h = Terrain.height(key, gx, gy);
                if (h < min) min = h;
                if (h > max) max = h;
            }
        }
        spans.push({ key, board: `${board.W}x${board.H}`, span: max - min });
    };
    try {
        for (const key of Object.keys(Terrain.maps)) scan(key);
        setBoardSize(260, 180, 5);       // 领土生产口径的大图
        scan('territory');
    } finally {
        resetBoardSize();
    }
    assert.ok(spans.length >= Object.keys(Terrain.maps).length, '扫描覆盖全部地形');
    for (const s of spans) {
        assert.ok(s.span * Terrain.HEIGHT_SCALE <= LIFT_SPAN_PX,
            `${s.key}@${s.board} 高度域跨度 ${s.span.toFixed(2)} 层 × ${Terrain.HEIGHT_SCALE} = ` +
            `${(s.span * Terrain.HEIGHT_SCALE).toFixed(1)}px 超过 LIFT_SPAN_PX=${LIFT_SPAN_PX}：` +
            '请同步扩大 js/inspection.js 的覆盖界常数并更新本守卫');
    }
});
