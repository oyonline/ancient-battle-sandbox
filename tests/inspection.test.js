const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeScene, addUnit, Terrain } = require('./battle-harness');

function fixture() {
    const panel = { hidden: true, innerHTML: '' };
    const events = new Map();
    const input = { on(name, fn) { events.set(name, fn); }, off(name) { events.delete(name); } };
    const context = vm.createContext({ Terrain, document: { getElementById: () => panel } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/inspection.js'), 'utf8') + '\nthis.UnitInspector = UnitInspector;', context);
    const scene = makeScene();
    let destroyed = false;
    const ring = { setDepth() { return this; }, clear() {}, lineStyle() {}, strokeEllipse() {}, destroy() { destroyed = true; } };
    scene.add.graphics = () => ring;
    scene.input = input;
    scene.events = { once(name, fn) { this.shutdown = fn; } };
    scene.cameras.main.zoom = 1;
    scene.cameras.main.getWorldPoint = (x, y) => ({ x, y });
    const inspector = new context.UnitInspector(scene);
    return { scene, inspector, panel, events, describe: context.UnitInspector.describe, isDestroyed: () => destroyed };
}

test('inspector uses real height, attack and range rules without changing battle state', () => {
    const { scene, describe } = fixture();
    scene.setTerrain('red_hill');
    const archer = addUnit(scene, 'red', 'archer', 30, 35);
    const enemy = addUnit(scene, 'blue', 'infantry', 40, 35);
    scene.rebuildSpatial();
    const before = JSON.stringify({ x: archer.gx, y: archer.gy, hp: archer.hp, target: archer.target });
    const info = describe(scene, archer);
    assert.equal(info.height, Terrain.height('red_hill', 30, 35));
    assert.equal(info.comparison.attack, Terrain.attackMultiplier('red_hill', archer, enemy));
    assert.equal(info.comparison.range, Terrain.rangedRange('red_hill', archer, enemy));
    assert.equal(info.comparison.label, '最近敌人（高差对照）');
    assert.equal(before, JSON.stringify({ x: archer.gx, y: archer.gy, hp: archer.hp, target: archer.target }));
});

test('slope readout uses voluntary movement and distinguishes uphill, downhill and stationary', () => {
    const { scene, describe } = fixture();
    scene.setTerrain('red_hill');
    const unit = addUnit(scene, 'red', 'infantry', 33, 35);
    Object.assign(unit, { moving: true, moveX: -0.04, moveY: 0 });
    assert.equal(describe(scene, unit).slope, '上坡');
    assert.ok(describe(scene, unit).movement < 1);
    unit.moveX = 0.04;
    assert.equal(describe(scene, unit).slope, '下坡');
    unit.terrainMoveMultiplier = 0.71234;
    assert.equal(describe(scene, unit).movement, 0.71234, 'read the exact multiplier used at the start of this movement step');
    unit.moving = false; unit.velX = 4; unit.pushX = 1;
    assert.equal(describe(scene, unit).movement, null, 'knockback is not active marching');
});

test('ready-phase inspection finds enemies before simulation builds the spatial index', () => {
    const { scene, describe } = fixture();
    const unit = addUnit(scene, 'red', 'infantry', 16, 35);
    addUnit(scene, 'blue', 'archer', 54, 35);
    assert.equal(describe(scene, unit).comparison.name, '弓箭手');
});

test('click selects elevated unit, dragging never selects, blank click dismisses', () => {
    const { scene, inspector, panel, events } = fixture();
    scene.setTerrain('blue_hill');
    const unit = addUnit(scene, 'blue', 'cavalry', 51, 35);
    scene.rebuildSpatial();
    const foot = scene.groundPoint(unit.gx, unit.gy);
    const pointer = { id: 1, x: foot.x, y: foot.y - 24 };
    events.get('pointerdown')(pointer);
    events.get('pointermove')({ ...pointer, x: pointer.x + 20 });
    events.get('pointerup')(pointer);
    assert.equal(inspector.selected, null, 'drag returning to original point remains a drag');
    events.get('pointerdown')(pointer);
    inspector.update(); // 普通点击跨过渲染帧，不能被空选择刷新吞掉。
    events.get('pointerup')(pointer);
    assert.equal(inspector.selected, unit);
    assert.equal(panel.hidden, false);
    assert.match(panel.innerHTML, /坡顶/);
    const blank = { id: 1, x: 0, y: 0 };
    events.get('pointerdown')(blank); events.get('pointerup')(blank);
    assert.equal(inspector.selected, null);
    assert.equal(panel.hidden, true);
});

test('dead or withdrawn targets cannot remain selected and teardown removes listeners', () => {
    const { scene, inspector, panel, events, isDestroyed } = fixture();
    const unit = addUnit(scene, 'red', 'infantry');
    inspector.selected = unit;
    inspector.update();
    assert.equal(panel.hidden, false);
    unit.withdrawn = true;
    inspector.update();
    assert.equal(panel.hidden, true);
    assert.equal(inspector.selected, null);
    scene.events.shutdown();
    assert.equal(events.size, 0);
    assert.equal(isDestroyed(), true);
});

test('explicit cavalry attack overrides guard label, and missing enemies show no comparison', () => {
    const { scene, describe } = fixture();
    const unit = addUnit(scene, 'red', 'cavalry');
    unit.tacticalRole = 'ground_guard';
    scene.battleOptions.cavalryOrders = { red: 'auto', blue: 'auto' };
    assert.match(describe(scene, unit).order, /就近反击/);
    scene.battleOptions.cavalryOrders.red = 'flank_archers';
    assert.equal(describe(scene, unit).order, '侧翼袭弓');
    assert.equal(describe(scene, unit).comparison, null);
});

test('forest readout separates surface slowdown from slope and explains interrupted cavalry charging', () => {
    const { scene, inspector, panel, describe } = fixture();
    scene.setTerrain('forest');
    const zone = Terrain.geometry('forest').zones.find(item => item.kind === 'forest');
    assert.ok(zone, 'test samples the actual shared geometry, not a duplicate forest map');
    const gx = (zone.x1 + zone.x2) / 2, gy = (zone.y1 + zone.y2) / 2;
    const cavalry = addUnit(scene, 'red', 'cavalry', gx, gy);
    Object.assign(cavalry, { moving: true, moveX: 0.04, moveY: 0, terrainMoveMultiplier: 1 });
    const info = describe(scene, cavalry);
    assert.equal(info.surface, 'forest');
    assert.equal(info.surfaceSpeed, 0.55);
    assert.equal(info.movement, 1);
    assert.equal(info.slope, '平缓行军', 'forest slowdown must never masquerade as uphill');
    assert.equal(info.chargeRestricted, true);
    inspector.selected = cavalry;
    inspector.update();
    assert.match(panel.innerHTML, /地表：林地.*地表移速 55%/);
    assert.match(panel.innerHTML, /坡速系数 100%/);
    assert.match(panel.innerHTML, /林中不能蓄力冲锋.*出林后重新助跑/);
    assert.doesNotMatch(panel.innerHTML, /上坡/);
    const infantry = addUnit(scene, 'red', 'infantry', gx + 1, gy);
    const footInfo = describe(scene, infantry);
    assert.equal(footInfo.surfaceSpeed, 0.85);
    assert.equal(footInfo.chargeRestricted, false);
    cavalry.moving = false;
    assert.equal(describe(scene, cavalry).movement, null);
    assert.equal(describe(scene, cavalry).surfaceSpeed, 0.55, 'stationary units still disclose their surface rule');
});

test('bridge surface and pass-only cavalry protection are reported without changing simulation', () => {
    const { scene, describe } = fixture();
    scene.setTerrain('river');
    const zone = Terrain.geometry('river').zones.find(item => item.kind === 'bridge');
    const unit = addUnit(scene, 'blue', 'cavalry', (zone.x1 + zone.x2) / 2, (zone.y1 + zone.y2) / 2);
    unit.tacticalRole = 'ground_guard';
    scene.battleOptions.cavalryOrders = { red: 'auto', blue: 'auto' };
    assert.equal(describe(scene, unit).surface, 'bridge');
    assert.equal(describe(scene, unit).surfaceLabel, '桥面');
    assert.equal(describe(scene, unit).surfaceSpeed, 1);
    assert.doesNotMatch(describe(scene, unit).order, /护弓/);
    scene.setTerrain('blue_pass');
    assert.match(describe(scene, unit).order, /护弓反击/);
    scene.setTerrain('red_pass');
    assert.doesNotMatch(describe(scene, unit).order, /护弓/);
    scene.setTerrain('blue_hill');
    assert.doesNotMatch(describe(scene, unit).order, /护弓/);
    scene.setTerrain('blue_pass');
    scene.battleOptions.cavalryOrders.blue = 'direct';
    assert.equal(describe(scene, unit).order, '正面强冲');
});
