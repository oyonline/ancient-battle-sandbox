// 营卡与主操作区回归（task U1）：兵种组成、真实快捷键、按营ID选中、移除手动冲锋按钮。
import test from 'node:test';
import assert from 'node:assert/strict';
import { UI } from '../js/ui.js';
import { makeScene, addUnit } from './battle-harness.js';

function element(tag = 'div') {
    const listeners = new Map();
    const node = {
        tagName: tag.toUpperCase(), className: '', id: '', title: '', hidden: false, disabled: false,
        dataset: {}, children: [], style: {}, onclick: null,
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        _text: '', _html: '',
        get textContent() { return node._text; },
        set textContent(value) { node._text = String(value); },
        get innerHTML() { return node._html; },
        set innerHTML(value) {
            node._html = String(value);
            // 极简解析 <b>/<span class="x">text</span>，让 querySelector 可用（仅测试桩）
            const parsed = [];
            for (const match of node._html.matchAll(/<(b|span|small)([^>]*)>([^<]*)<\/\1>/g)) {
                const child = element(match[1]);
                const cls = /class="([^"]*)"/.exec(match[2])?.[1];
                if (cls) child.className = cls;
                child.textContent = match[3];
                parsed.push(child);
            }
            node.children = parsed;
        },
        get childElementCount() { return node.children.length; },
        appendChild(child) { child.parentElement = node; node.children.push(child); return child; },
        replaceChildren() { node.children = []; },
        querySelector(selector) { return byClass(node, selector); },
        setAttribute() {}, addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener() {}
    };
    return node;
}

function byClass(node, selector) {
    if (typeof selector !== 'string') return null;
    const byTag = !selector.startsWith('.');
    const name = selector.replace(/^\./, '');
    for (const child of node.children) {
        const hit = byTag ? child.tagName === name.toUpperCase()
            : (child.className || '').split(/\s+/).includes(name);
        if (hit) return child;
        const nested = byClass(child, selector);
        if (nested) return nested;
    }
    return null;
}

function domFixture(t) {
    const previous = globalThis.document;
    const nodes = new Map(), created = [];
    const node = id => { if (!nodes.has(id)) { const el = element(); el.id = id; nodes.set(id, el); } return nodes.get(id); };
    const createdById = id => created.filter(el => el.id === id).at(-1);
    globalThis.document = {
        getElementById: id => createdById(id) ?? node(id),
        body: node('body'),
        createElement: tag => { const el = element(tag); created.push(el); return el; },
        querySelector: selector => createdById(selector.replace(/^#/, '')) ?? node(selector.replace(/^#/, '')),
        querySelectorAll: selector => selector.includes('.order-btn')
            ? created.filter(el => (el.className || '').includes('order-btn')) : []
    };
    t.after(() => { globalThis.document = previous; });
    return { node, created, createdById };
}

function uiFixture(t, red = { infantry: 6, cavalry: 3 }) {
    const dom = domFixture(t);
    const scene = makeScene();
    scene.deployUnits(red, { infantry: 6 }, 'custom', 'custom', {},
        { territory: true, territoryAI: false, terrain: 'flat' });
    scene.battleStarted = true;
    scene.render.camps.pick = () => null;
    scene.simulationTime = 1000;
    const ui = { ...UI, scene, phase: 'battle', mySide: 'red', countdown: false,
        battleOptions: { territory: true, net: false }, holdStops: [], _pendingBuys: [], _seenTerritoryTips: new Set(),
        campControls: { targeting: null, update() {}, reset() {}, cancel() {} }, showNetToast() {} };
    return { ui, scene, dom };
}

const chipLabel = chip => chip.querySelector('b')?.textContent ?? '';

test('营卡显示兵种组成与真实快捷键，组成名称来自 UNIT_TYPES 单一来源', () => {
    const battalion = {
        id: 5, team: 'red',
        aliveMembers: () => [
            { type: 'infantry' }, { type: 'infantry' }, { type: 'infantry' },
            { type: 'infantry' }, { type: 'infantry' },
            { type: 'pikeman' }, { type: 'pikeman' },
            { type: 'archer' }, { type: 'archer' }, { type: 'archer' }]
    };
    assert.equal(UI.battalionComposition(battalion), '剑士5／长枪兵2／弓箭手3');
    const cavalry = { id: 4, team: 'red', aliveMembers: () => [{ type: 'cavalry' }, { type: 'cavalry' }, { type: 'cavalry' }] };
    assert.equal(UI.battalionComposition(cavalry), '重骑士3');
    assert.equal(UI.battalionComposition({ id: 9, team: 'red', aliveMembers: () => [] }), '');
});

test('营卡按真实快捷键编号，数字键选中的就是卡片上标出的营', t => {
    const { ui, scene, dom } = uiFixture(t);
    ui.renderBattalionPicker();
    const row = dom.node('battalion-picker');
    assert.equal(row.children.length, scene.battalions.battalions.filter(b => b.team === 'red').length);
    for (let i = 0; i < row.children.length; i++) {
        assert.match(chipLabel(row.children[i]), new RegExp(`^\\[${i + 1}\\] ${row.children[i].dataset.bid}营$`),
            '卡片标注 [快捷键] 营ID，键号与显示一致');
    }
    assert.equal(ui.battalionSlots().get(1), 1);
    ui.selectBattalionSlot(2);
    assert.equal(scene.selectedBattalion.id, 2, '数字键 2 选中标着 [2] 的营');
});

test('数字键走真实键盘链路：keydown 2 选中 [2] 营', t => {
    const { ui, scene } = uiFixture(t);
    const previousWindow = globalThis.window;
    const handlers = new Map();
    globalThis.window = { addEventListener: (name, fn) => handlers.set(name, fn) };
    t.after(() => { globalThis.window = previousWindow; });
    ui.syncControls = () => {};
    ui.bindControls();
    handlers.get('keydown')({ key: '2' });
    assert.equal(scene.selectedBattalion.id, 2);
});

test('营卡点击按确定营ID选中：列表变化后不因索引漂移选错营', t => {
    const { ui, scene, dom } = uiFixture(t);
    ui.renderBattalionPicker();
    const row = dom.node('battalion-picker');
    const staleChip = row.children[1];    // [2] 2营
    // 营1 全灭解散且尚未重建卡片：旧实现按陈旧索引选错营，新实现按营ID命中
    scene.battalions.battalions = scene.battalions.battalions.filter(b => !(b.team === 'red' && b.id === 1));
    staleChip.onclick();
    assert.equal(scene.selectedBattalion.id, 2, '点击 [2] 2营 的卡片必须选中 2 营本身');
    // 重建后卡片仍按营ID工作
    ui.renderBattalionPicker();
    dom.node('battalion-picker').children[0].onclick();
    assert.equal(scene.selectedBattalion.id, 2);
});

test('营亡解散后快捷键槽位保持稳定，空槽回收给新营', t => {
    const { ui, scene } = uiFixture(t);
    ui.renderBattalionPicker();
    ui.selectBattalionSlot(3);
    assert.equal(scene.selectedBattalion.id, 3);
    scene.battalions.battalions = scene.battalions.battalions.filter(b => !(b.team === 'red' && b.id === 2));
    ui.renderBattalionPicker();
    assert.equal(ui.battalionSlots().get(3), 3, '幸存营的快捷键不因他人解散而漂移');
    ui.selectBattalionSlot(2);
    assert.equal(scene.selectedBattalion.id, 3, '空槽按键不改变当前选择');
    // 新集结营入列：回收最低空槽（2 里最小的是 2）
    const fresh = scene.battalions.createBattalion('red', 'gathering');
    const recruit = addUnit(scene, 'red', 'infantry', 12, 30);
    fresh.members.push(recruit);
    recruit.battalion = fresh;
    scene.battalions.battalions.push(fresh);
    ui.renderBattalionPicker();
    assert.equal(ui.battalionSlots().get(fresh.id), 2, '新营领取最低空闲槽位');
    ui.selectBattalionSlot(2);
    assert.equal(scene.selectedBattalion.id, fresh.id);
});

test('主操作区移除冲锋按钮：无 order-charge、无手动冲锋方法，其余营令按钮保留', t => {
    const { ui, dom } = uiFixture(t);
    ui.buildBattalionBar();
    assert.ok(!dom.created.some(el => el.id === 'order-charge'), '不再创建手动冲锋按钮');
    assert.equal('giveChargeOrder' in UI, false, '手动冲锋下令路径整体移除');
    for (const id of ['order-hold', 'order-stance', 'order-clear', 'order-next', 'order-locate', 'order-building', 'order-deselect']) {
        assert.ok(dom.created.some(el => el.id === id), `营令按钮 ${id} 保留`);
    }
});

test('冲锋显示改为自动冲锋真实读数：有骑营显示状态，无骑营不占位', t => {
    const { ui, scene, dom } = uiFixture(t);
    ui.buildBattalionBar();
    const battalions = scene.battalions.battalions.filter(b => b.team === 'red');
    const cavalry = battalions.find(b => b.aliveMembers().some(u => u.type === 'cavalry'));
    const foot = { id: 99, team: 'red', stance: 'steady', orderFlag: null, orderPoint: null, retreat: false,
        gathering: false, aliveMembers: () => [{ type: 'infantry' }] };
    assert.ok(cavalry, '开局应有含骑营');
    scene.selectedBattalion = cavalry;
    ui.updateBattalionBar();
    let note = dom.createdById('order-charge-note');
    assert.ok(note, '存在自动冲锋状态位');
    assert.match(note.textContent, /自动冲锋/);
    assert.doesNotMatch(note.textContent, /冷却/, '不再显示手动冷却');
    // 真实状态：有骑完成助跑（≥3 格）时显示冲击中
    cavalry.aliveMembers().find(u => u.type === 'cavalry').chargeDistance = 3.4;
    ui.updateBattalionBar();
    note = dom.createdById('order-charge-note');
    assert.match(note.textContent, /冲击中/);
    // 步营不显示
    scene.selectedBattalion = foot;
    ui.updateBattalionBar();
    assert.equal(dom.createdById('order-charge-note').textContent, '');
    // 营标签不再出现手动冲锋窗口文案（兼容路径仍可存在，但 UI 不再展示为玩家动作）
    cavalry.chargeUntil = scene.simulationTime + 5000;
    scene.selectedBattalion = cavalry;
    ui.updateBattalionBar();
    assert.doesNotMatch(dom.node('battalion-label').textContent, /冲锋中/);
    assert.match(dom.node('battalion-label').textContent, /自动冲锋|作战/);
});
