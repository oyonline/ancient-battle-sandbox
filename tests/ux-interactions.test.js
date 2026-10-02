import test from 'node:test';
import assert from 'node:assert/strict';
import { UI } from '../js/ui.js';
import { CampControls } from '../js/camp-controls.js';
import { UnitInspector } from '../js/inspection.js';
import { Lockstep } from '../js/net/lockstep.js';
import { UNIT_TYPES } from '../js/units.js';
import { TERRITORY } from '../js/battle/economy.js';
import { makeScene, addUnit } from './battle-harness.js';

function element() {
    const classes = new Set(), listeners = new Map();
    let html = '', writes = 0;
    return {
        hidden: true, disabled: false, textContent: '', dataset: {}, children: [], listeners,
        classList: { add: name => classes.add(name), remove: name => classes.delete(name),
            toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
        get innerHTML() { return html; }, set innerHTML(value) { html = value; writes++; },
        get writes() { return writes; },
        addEventListener(name, fn) { listeners.set(name, fn); },
        setAttribute() {}, setPointerCapture() {}, replaceChildren() { this.innerHTML = ''; this.children = []; },
        querySelector() { return null; }
    };
}

function fixture(t) {
    const previous = globalThis.document;
    const nodes = new Map();
    const node = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
    globalThis.document = { getElementById: node, body: node('body'), querySelectorAll: () => [] };
    t.after(() => { globalThis.document = previous; });
    const scene = makeScene();
    scene.deployUnits({ infantry: 4 }, { infantry: 4 }, 'custom', 'custom', {},
        { territory: true, territoryAI: false, terrain: 'flat' });
    scene.battleStarted = true;
    scene.render.camps.pick = () => null;
    const events = new Map();
    scene.input = { on: (name, fn) => events.set(name, fn), off: name => events.delete(name) };
    scene.events = { once() {} };
    scene.cameras.main.zoom = 1;
    scene.cameras.main.getWorldPoint = (x, y) => ({ x, y });
    const ui = { ...UI, scene, phase: 'battle', mySide: 'red', countdown: false,
        battleOptions: { territory: true, net: false }, holdStops: [], _pendingBuys: [], _seenTerritoryTips: new Set(),
        showNetToast() {}, updateBattalionBar() {} };
    ui.campControls = new CampControls(ui);
    scene.groundClick = (world, picked) => ui.onGroundClick(world, picked);
    const inspector = new UnitInspector(scene);
    scene.unitInspector = inspector;
    const click = point => {
        const pointer = { id: 1, x: point.x, y: point.y };
        events.get('pointerdown')(pointer);
        events.get('pointerup')(pointer);
    };
    const soldierPoint = unit => { const p = scene.groundPoint(unit.gx, unit.gy); return { x: p.x, y: p.y - 18 }; };
    return { scene, ui, inspector, click, soldierPoint, node, events };
}

test('real pointer chain selects a battalion, then sends hold on empty ground without clearing selection', t => {
    const { scene, ui, inspector, click, soldierPoint, node } = fixture(t);
    const soldier = scene.units.find(u => u.team === 'red');
    click(soldierPoint(soldier));
    const battalion = scene.selectedBattalion;
    assert.ok(battalion);
    ui.beginHoldTargeting();
    assert.equal(node('command-prompt').hidden, false);
    click(scene.groundPoint(36, 29));
    assert.equal(scene.selectedBattalion, battalion);
    assert.equal(inspector.selected, soldier);
    assert.deepEqual(battalion.orderPoint, { gx: 36, gy: 29 });
    assert.equal(ui.holdTargeting, null);
    assert.equal(node('command-prompt').hidden, true);
});

test('hold targeting on an enemy soldier still commands the original battalion', t => {
    const { scene, ui, inspector, click, soldierPoint } = fixture(t);
    const mine = scene.units.find(u => u.team === 'red');
    const enemy = scene.units.find(u => u.team === 'blue');
    click(soldierPoint(mine));
    const battalion = scene.selectedBattalion;
    ui.beginHoldTargeting();
    click(soldierPoint(enemy));
    assert.equal(scene.selectedBattalion, battalion);
    assert.equal(inspector.selected, mine);
    assert.ok(battalion.orderPoint);
    assert.equal(enemy.battalion.orderPoint, null);
});

test('hold, rally and construction targeting are exclusive and common cancellation clears prompt', t => {
    const { scene, ui, click, soldierPoint, node } = fixture(t);
    click(soldierPoint(scene.units.find(u => u.team === 'red')));
    ui.beginHoldTargeting();
    ui.beginRallyTargeting();
    assert.equal(ui.holdTargeting, null);
    assert.equal(ui.rallyTargeting, true);
    const worker = addUnit(scene, 'red', 'worker', 10, 30);
    ui.campControls.selectWorker(worker.id);
    ui.beginRallyTargeting();
    ui.campControls.begin('move');
    assert.equal(ui.rallyTargeting, false);
    assert.equal(ui.holdTargeting, null);
    assert.equal(ui.campControls.targeting.kind, 'move');
    ui.cancelTargeting();
    assert.equal(ui.campControls.targeting, null);
    assert.equal(node('command-prompt').hidden, true);
    assert.equal(node('body').classList.contains('targeting'), false);
    assert.equal(node('body').classList.contains('camp-targeting'), false);
});

test('closed construction panel stays closed for the same selection and skips expensive scans', t => {
    const { scene, ui, node } = fixture(t);
    const worker = addUnit(scene, 'red', 'worker', 10, 30);
    ui.campControls.selectWorker(worker.id);
    assert.equal(node('camp-control-bar').hidden, false);
    ui.campControls.close();
    const originalWorkers = ui.campControls.workers;
    ui.campControls.workers = () => { throw new Error('hidden panel must not scan workers'); };
    ui.campControls.selectedTroops = () => { throw new Error('hidden panel must not scan troops'); };
    for (let i = 0; i < 20; i++) ui.campControls.update();
    assert.equal(node('camp-control-bar').hidden, true);
    ui.campControls.workers = originalWorkers;
    ui.campControls.selectedTroops = () => [];
    ui.campControls.togglePin();
    assert.equal(node('camp-control-bar').hidden, false);
});

test('inspector updates its selection ring each frame but does not rewrite empty panel or compute text every frame', t => {
    const { scene, inspector, node } = fixture(t);
    const panel = node('unit-inspector');
    for (let i = 0; i < 60; i++) inspector.update();
    assert.equal(panel.writes, 0);
    inspector.selected = scene.units[0];
    let ringDraws = 0, searches = 0;
    inspector.ring.strokeEllipse = () => { ringDraws++; };
    const original = scene.nearestEnemy.bind(scene);
    scene.nearestEnemy = unit => { searches++; return original(unit); };
    for (let i = 0; i < 60; i++) inspector.update();
    assert.equal(ringDraws, 60);
    assert.equal(searches, 1);
    inspector.selected = null;
    inspector.update();
    const writes = panel.writes;
    for (let i = 0; i < 60; i++) inspector.update();
    assert.equal(panel.writes, writes);
});

test('long press batches accelerated purchases into one HUD refresh per repeat and stops immediately when disabled', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const button = element();
    let purchases = 0, refreshes = 0;
    const ui = { ...UI, holdStops: [] };
    ui.bindHold(button, () => { purchases++; return true; }, () => { refreshes++; });
    button.listeners.get('pointerdown')({ button: 0, pointerId: 1, preventDefault() {} });
    t.mock.timers.tick(380);
    for (let i = 0; i < 30; i++) t.mock.timers.tick(60);
    assert.equal(purchases, 1 + 9 + 20 * 8 + 25);
    assert.equal(refreshes, 31);
    button.disabled = true;
    t.mock.timers.tick(60);
    button.disabled = false;
    t.mock.timers.tick(600);
    assert.equal(refreshes, 31, 'disabled repeat cannot resume on its own');
    ui.stopHolds();
});

test('a rejected purchase stops the repeating timer, including rejection on first pointerdown', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const button = element();
    let calls = 0;
    const ui = { ...UI, holdStops: [] };
    ui.bindHold(button, () => { calls++; return false; });
    button.listeners.get('pointerdown')({ button: 0, pointerId: 1, preventDefault() {} });
    t.mock.timers.tick(2000);
    assert.equal(calls, 1);
    ui.stopHolds();
});

test('network purchase batching preserves command order and reserves pending costs without mutating simulation', t => {
    const { ui, scene } = fixture(t);
    ui.battleOptions.net = true;
    const lockstep = new Lockstep('red');
    scene.net = { lockstep };
    scene.territory.econ.treasury.red = 1000;
    const before = scene.territory.econ.treasury.red;
    const types = ['infantry', 'archer', 'infantry'];
    for (const type of types) assert.equal(ui.buyRecruit(type), true);
    assert.deepEqual(lockstep.pending.map(cmd => cmd.type), types);
    assert.equal(scene.territory.econ.treasury.red, before);
    assert.equal(scene.territory.recruit.queues.red.length, 0);
    scene.territory.econ.treasury.red = types.reduce((sum, type) => sum + UNIT_TYPES[type].cost * TERRITORY.COST_MULT, 0);
    assert.equal(ui.buyRecruit('infantry'), false, 'cannot enqueue repeated purchases against already reserved budget');
    assert.equal(lockstep.pending.length, 3);
    lockstep.execTurn = lockstep.lookahead + 1;
    assert.equal(ui.pendingRecruitOrders().length, 0);
});

test('changing from enemy selection to next friendly battalion remains available', t => {
    const { ui, scene } = fixture(t);
    scene.selectedBattalion = scene.units.find(u => u.team === 'blue').battalion;
    ui.selectNextBattalion();
    assert.equal(scene.selectedBattalion.team, 'red');
    assert.equal(scene.unitInspector.selected.team, 'red');
});

test('keyboard Escape cancels targeting and Space pauses only local battles, ignoring typing', t => {
    const { ui, scene, click, soldierPoint, node } = fixture(t);
    const originalWindow = globalThis.window;
    const handlers = new Map();
    globalThis.window = { addEventListener: (name, fn) => handlers.set(name, fn) };
    globalThis.document.querySelector = selector => node(selector);
    t.after(() => { globalThis.window = originalWindow; });
    let pauses = 0;
    scene.togglePause = () => { pauses++; };
    ui.syncControls = () => {};
    ui.bindControls();
    click(soldierPoint(scene.units.find(u => u.team === 'red')));
    ui.beginHoldTargeting();
    const key = handlers.get('keydown');
    key({ key: 'Escape' });
    assert.equal(ui.holdTargeting, null);
    assert.equal(node('command-prompt').hidden, true);
    const space = { key: ' ', code: 'Space', preventDefault() {} };
    key(space);
    assert.equal(pauses, 1);
    ui.battleOptions.net = true;
    key(space);
    assert.equal(pauses, 1, 'lockstep cannot pause from keyboard');
    ui.battleOptions.net = false;
    key({ ...space, target: { matches: () => true } });
    assert.equal(pauses, 1, 'typing into a form never triggers battle shortcuts');
});

test('paused battle can issue hold twice and immediately clears hold and rally button states', t => {
    const { ui, scene, click, soldierPoint, node } = fixture(t);
    const holdButton = node('order-hold');
    holdButton.id = 'order-hold';
    globalThis.document.querySelector = selector => selector === '#order-hold' ? holdButton : null;
    globalThis.document.querySelectorAll = () => [holdButton];
    ui.renderBattalionPicker = () => {};
    ui.updateBattalionBar = UI.updateBattalionBar;
    scene.paused = true;
    click(soldierPoint(scene.units.find(u => u.team === 'red')));
    const battalion = scene.selectedBattalion;
    for (const gx of [36, 39]) {
        assert.equal(holdButton.disabled, false, 'next hold command must be available without advancing simulation');
        ui.beginHoldTargeting();
        assert.equal(holdButton.disabled, true);
        click(scene.groundPoint(gx, 29));
        assert.deepEqual(battalion.orderPoint, { gx, gy: 29 });
        assert.equal(holdButton.disabled, false);
    }
    ui.beginRallyTargeting();
    assert.equal(node('btn-rally').classList.contains('active'), true);
    click(scene.groundPoint(20, 30));
    assert.equal(ui.rallyTargeting, false);
    assert.equal(node('btn-rally').classList.contains('active'), false);
    assert.equal(scene.paused, true);
});

test('Space on a focused recruit or command button retains native keyboard activation', t => {
    const { ui, scene, node } = fixture(t);
    const originalWindow = globalThis.window;
    const handlers = new Map();
    globalThis.window = { addEventListener: (name, fn) => handlers.set(name, fn) };
    globalThis.document.querySelector = selector => node(selector);
    t.after(() => { globalThis.window = originalWindow; });
    let pauses = 0, purchases = 0, prevented = 0;
    scene.togglePause = () => { pauses++; };
    ui.syncControls = () => {};
    ui.bindControls();
    const recruitButton = element();
    recruitButton.closest = selector => selector.includes('button') ? recruitButton : null;
    ui.bindHold(recruitButton, () => { purchases++; });
    handlers.get('keydown')({ key: ' ', code: 'Space', target: recruitButton,
        preventDefault() { prevented++; } });
    assert.equal(prevented, 0, 'the browser must be allowed to synthesize the keyboard click');
    recruitButton.listeners.get('click')({ detail: 0 });
    assert.equal(purchases, 1);
    assert.equal(pauses, 0);
    for (const tag of ['a', '[role="button"]', 'summary', '[contenteditable]']) {
        handlers.get('keydown')({ key: ' ', code: 'Space',
            target: { closest: selector => selector.includes(tag) ? {} : null },
            preventDefault() { prevented++; } });
    }
    assert.equal(prevented, 0);
    assert.equal(pauses, 0);
});

test('blue-side player sees actual team colors for both friendly and enemy battalion labels', t => {
    const { ui, scene, node } = fixture(t);
    ui.mySide = 'blue';
    ui.renderBattalionPicker = () => {};
    ui.updateBattalionBar = UI.updateBattalionBar;
    globalThis.document.querySelector = selector => selector === '#order-hold' ? node('order-hold') : null;
    scene.selectedBattalion = scene.units.find(u => u.team === 'blue').battalion;
    ui.updateBattalionBar();
    assert.match(node('battalion-label').textContent, /^🔵/);
    assert.doesNotMatch(node('battalion-label').textContent, /敌营/);
    scene.selectedBattalion = scene.units.find(u => u.team === 'red').battalion;
    ui.updateBattalionBar();
    assert.match(node('battalion-label').textContent, /^🔴/);
    assert.match(node('battalion-label').textContent, /敌营不可指挥/);
});
