// 选择交互回归（task U1）：营旗点选、按下定靶、己方优先、悬停节流与点击一致。
// 全部走真实指针事件链（pointerdown/move/up），不直接调用选择函数代替操作。
import test from 'node:test';
import assert from 'node:assert/strict';
import { UnitInspector } from '../js/inspection.js';
import { makeScene, addUnit } from './battle-harness.js';

function selectionFixture(t, options = {}) {
    const previousDocument = globalThis.document;
    const panel = { hidden: true, innerHTML: '' };
    globalThis.document = { getElementById: () => panel };
    t.after(() => { globalThis.document = previousDocument; });
    const scene = makeScene();
    scene.deployUnits(options.red ?? { infantry: 6 }, options.blue ?? { infantry: 6 },
        'custom', 'custom', {}, { territory: true, territoryAI: false, terrain: 'flat' });
    scene.battleStarted = true;
    scene.render.camps.pick = () => null;
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
    scene.groundClick = (world, picked) => {
        groundClicks.push({ world, picked });
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
    return { scene, inspector, events, click, move, bodyPoint, groundClicks };
}

test('领土模式普通点选优先己方可控部队：混战中敌兵不再抢走选中', t => {
    const { scene, inspector, click } = selectionFixture(t);
    const mine = addUnit(scene, 'red', 'infantry', 40, 40);
    const enemy = addUnit(scene, 'blue', 'infantry', 40.4, 40);   // 比己方更靠近点击点
    scene.rebuildSpatial();
    const base = scene.groundPoint(mine.gx, mine.gy);
    const toward = scene.groundPoint(enemy.gx, enemy.gy);
    // 点击点越过中点、按最近单兵规则属于敌兵（复现旧缺陷），新规则应选己方
    const x = base.x + (toward.x - base.x) * 0.7, y = base.y - 18 + (toward.y - base.y) * 0.7;
    click(x, y);
    assert.equal(inspector.selected, mine, '点击点即使在敌兵一侧，也应优先选中己方可控部队');
});

test('敌军观察入口保留：点击点附近没有己方部队时仍可选中敌兵', t => {
    const { scene, inspector, click } = selectionFixture(t);
    addUnit(scene, 'red', 'infantry', 20, 20);
    const enemy = addUnit(scene, 'blue', 'infantry', 50, 50);
    scene.rebuildSpatial();
    const p = scene.groundPoint(enemy.gx, enemy.gy);
    click(p.x, p.y - 18);
    assert.equal(inspector.selected, enemy);
});

test('按下即定靶：部队在按压期间移动，抬起不选成邻近部队也不点空补选', t => {
    const { scene, inspector, events, bodyPoint } = selectionFixture(t);
    const pressed = addUnit(scene, 'red', 'infantry', 40, 40);
    const neighbor = addUnit(scene, 'red', 'infantry', 44, 40);
    scene.rebuildSpatial();
    const point = bodyPoint(pressed);
    events.get('pointerdown')({ id: 1, x: point.x, y: point.y });
    pressed.gx += 0.4;                                  // 按下后原目标轻微移动
    neighbor.gx = pressed.gx - 0.4; neighbor.gy = pressed.gy;   // 邻近部队滑到按压点下方
    scene.rebuildSpatial();
    events.get('pointerup')({ id: 1, x: point.x, y: point.y });
    assert.equal(inspector.selected, pressed, '抬起时按按压瞬间定下的目标，不改选滑进来的邻近部队');
    // 反向：按在空地上，按压期间有部队移动到指针下，抬起不得补选
    inspector.selected = null;
    scene.selectedBattalion = null;
    const empty = scene.groundPoint(50, 20);
    events.get('pointerdown')({ id: 2, x: empty.x, y: empty.y });
    neighbor.gx = 50; neighbor.gy = 20;
    scene.rebuildSpatial();
    events.get('pointerup')({ id: 2, x: empty.x, y: empty.y });
    assert.equal(inspector.selected, null, '按压点当时没有目标，抬起不得选中后到的部队');
});

test('远景营旗是可靠点击入口：悬停预览与点击选中同一营', t => {
    const { scene, inspector, click, move, groundClicks } = selectionFixture(t, { zoom: 0.4 });
    const overlay = scene.render.overlay;
    overlay.updateBattalionMarkers();
    const rects = overlay.markerRects;
    assert.ok(rects?.length >= 1, '战略缩放下应登记营旗命中矩形');
    const rect = rects.find(r => r.battalion.team === 'red');
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    // 开局营旗可能互相重叠：该点的预期命中 = 包含该点、绘制序靠后（显示在上层）的旗
    const contains = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    const topmost = rects.filter(r => contains(r, cx, cy)).at(-1);
    assert.ok(topmost, '点击点应落在营旗命中矩形内');
    move(cx, cy);
    assert.equal(inspector.hover?.battalion, topmost.battalion, '悬停应预览即将选中的营（显示在上层的旗）');
    assert.equal(overlay._markerHoverId, topmost.battalion.id, '悬停的营旗应有高亮标记');
    click(cx, cy);
    assert.equal(scene.selectedBattalion, topmost.battalion, '点击营旗选中整营');
    assert.ok(inspector.selected, '点击营旗后观察面板显示该营代表成员');
    assert.equal(inspector.selected.battalion, topmost.battalion);
    assert.equal(groundClicks.length, 1);
    assert.ok(groundClicks[0].picked == null || groundClicks[0].picked.type,
        '传给选点命令的拾取参数仍是单兵口径');
});

test('选点命令优先消费营旗点击：驻守/集结目标模式下点旗不换选择', t => {
    const { scene, inspector, click, groundClicks } = selectionFixture(t, { zoom: 0.4, groundClickResult: true });
    const overlay = scene.render.overlay;
    overlay.updateBattalionMarkers();
    const rect = overlay.markerRects.find(r => r.battalion.team === 'red');
    click(rect.x + rect.w / 2, rect.y + rect.h / 2);
    assert.equal(groundClicks.length, 1, '选点命令先消费点击');
    assert.equal(scene.selectedBattalion, null, '命令消费后不得改选营队');
    assert.equal(inspector.selected, null);
});

test('拖动经过营旗不误选：抬起前位移超过点击阈值即纯拖动', t => {
    const { scene, inspector, events } = selectionFixture(t, { zoom: 0.4 });
    const overlay = scene.render.overlay;
    overlay.updateBattalionMarkers();
    const rect = overlay.markerRects.find(r => r.battalion.team === 'red');
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    events.get('pointerdown')({ id: 1, x: cx, y: cy });
    events.get('pointermove')({ id: 1, x: cx + 20, y: cy });
    events.get('pointerup')({ id: 1, x: cx + 20, y: cy });
    assert.equal(scene.selectedBattalion, null, '拖动不是点击，不得经营旗误选');
    assert.equal(inspector.selected, null);
});

test('悬停命中走空间索引并节流：60 次移动不反复全军扫描，且与点击结果一致', t => {
    const { scene, inspector, click, move, bodyPoint } = selectionFixture(t);
    const mine = addUnit(scene, 'red', 'infantry', 40, 40);
    scene.rebuildSpatial();
    let nearCalls = 0, unitReads = 0;
    const realNear = scene.forEachNear.bind(scene);
    scene.forEachNear = (gx, gy, r, fn) => { nearCalls++; return realNear(gx, gy, r, fn); };
    const units = scene.units;
    Object.defineProperty(scene, 'units', {
        get() { unitReads++; return units; },
        configurable: true
    });
    const point = bodyPoint(mine);
    for (let i = 0; i < 60; i++) move(point.x + (i % 3), point.y);
    assert.equal(inspector.hover?.unit, mine, '悬停预览指向即将选中的单位');
    assert.ok(nearCalls <= 2, `悬停拾取应节流（60 次移动至多 2 次索引查询，实际 ${nearCalls}）`);
    assert.ok(unitReads <= 2, `驻军缓存最多刷新一次（实际 ${unitReads}），不得逐事件全军扫描`);
    // 悬停预览与点击结果一致（同一条拾取管线）
    click(point.x, point.y);
    assert.equal(inspector.selected, mine, '悬停预览的单位和点击选中的单位一致');
});

test('按压进行中不更新悬停预览：拖动镜头期间悬停态清空且零拾取', t => {
    const { scene, inspector, events, move, bodyPoint } = selectionFixture(t);
    const mine = addUnit(scene, 'red', 'infantry', 40, 40);
    scene.rebuildSpatial();
    let nearCalls = 0;
    const realNear = scene.forEachNear.bind(scene);
    scene.forEachNear = (gx, gy, r, fn) => { nearCalls++; return realNear(gx, gy, r, fn); };
    const point = bodyPoint(mine);
    move(point.x, point.y);    // 先建立悬停
    assert.equal(inspector.hover?.unit, mine);
    events.get('pointerdown')({ id: 1, x: point.x, y: point.y });
    const before = nearCalls;
    for (let i = 0; i < 30; i++) events.get('pointermove')({ id: 1, x: point.x + i, y: point.y });
    assert.equal(nearCalls, before, '按压/拖动期间不得执行悬停拾取');
    assert.equal(inspector.hover, null, '按下即取消悬停预览');
    events.get('pointerup')({ id: 1, x: point.x + 29, y: point.y });
    assert.equal(inspector.selected, null, '超过阈值的位移是拖动，不选兵');
});

test('悬停目标阵亡后预览自动失效，悬停环只在有预览时绘制', t => {
    const { scene, inspector, move, bodyPoint } = selectionFixture(t);
    const mine = addUnit(scene, 'red', 'infantry', 40, 40);
    scene.rebuildSpatial();
    const point = bodyPoint(mine);
    move(point.x, point.y);
    assert.ok(inspector.hover, '先建立悬停预览');
    inspector.update();
    assert.ok(inspector._hoverGfx, '悬停预览存在时绘制悬停环');
    mine.dead = true;
    inspector.update();
    assert.equal(inspector.hover, null, '阵亡单位的悬停预览必须失效');
});
