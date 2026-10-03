// F12 有界排查：营卡点击映射在溢出+列表重排时序下的一致性（营亡/新营/选中切换/槽位重排），
// 以及重建路径的滚动位置保持。全部走真实 renderBattalionPicker/updateBattalionBar 链。
import test from 'node:test';
import assert from 'node:assert/strict';
import { UI } from '../js/ui.js';
import { makeScene, addUnit } from './battle-harness.js';

function element(tag = 'div') {
    const listeners = new Map();
    const node = {
        tagName: tag.toUpperCase(), className: '', id: '', title: '', hidden: false, disabled: false,
        dataset: {}, children: [], style: {}, onclick: null, scrollLeft: 0,
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        _text: '', _html: '',
        get textContent() { return node._text; },
        set textContent(value) { node._text = String(value); },
        get innerHTML() { return node._html; },
        set innerHTML(value) {
            node._html = String(value);
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
        // 浏览器语义建模：清空内容后滚动区域塌缩，scrollLeft 被夹回 0
        replaceChildren() { node.children = []; node.scrollLeft = 0; },
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

function chipFixture(t) {
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
    const scene = makeScene();
    scene.deployUnits({ infantry: 8 }, { infantry: 6 }, 'custom', 'custom', {},
        { territory: true, territoryAI: false, terrain: 'flat' });
    scene.battleStarted = true;
    scene.render.camps.pick = () => null;
    scene.simulationTime = 1000;
    const ui = { ...UI, scene, phase: 'battle', mySide: 'red', countdown: false,
        battleOptions: { territory: true, net: false }, holdStops: [], _pendingBuys: [], _seenTerritoryTips: new Set(),
        campControls: { targeting: null, update() {}, reset() {}, cancel() {} }, showNetToast() {} };
    return { ui, scene, dom: { node, created, createdById } };
}

// 每张卡的三方一致：dataset.bid === 卡面营号 === 点击选中的营
function assertChipsConsistent(ui, scene) {
    const row = document.getElementById('battalion-picker');
    assert.ok(row.children.length >= 1, '至少一张营卡');
    for (const chip of row.children) {
        const bid = Number(chip.dataset.bid);
        const label = chip.querySelector('b')?.textContent ?? '';
        assert.match(label, new RegExp(`(^|\\s)${bid}营$`), `卡面营号必须与 dataset.bid=${bid} 一致：${label}`);
        chip.onclick();
        assert.equal(scene.selectedBattalion?.id, bid, `点击 [${label}] 必须选中 ${bid} 营，而非 ${scene.selectedBattalion?.id}`);
    }
}

test('营卡映射时序矩阵：营亡/新营/选中切换/槽位重排下 显示A卡必点中A营', t => {
    const { ui, scene } = chipFixture(t);
    ui.updateBattalionBar();
    assertChipsConsistent(ui, scene);
    const before = [...document.getElementById('battalion-picker').children];

    // 时序 1：选中切换（等长、bid/slot 不变 → 增量刷新分支，节点不重建）
    scene.selectedBattalion = scene.battalions.battalions.filter(b => b.team === 'red')[1];
    ui.updateBattalionBar();
    const afterSelect = [...document.getElementById('battalion-picker').children];
    assert.deepEqual(afterSelect, before, '选中切换走增量刷新，卡片节点不重建（点击稳定）');
    assertChipsConsistent(ui, scene);

    // 时序 2：营亡解散（列表变短 → 重建分支）
    const reds = () => scene.battalions.battalions.filter(b => b.team === 'red');
    scene.battalions.battalions = scene.battalions.battalions.filter(b => !(b.team === 'red' && b.id === 1));
    ui.updateBattalionBar();
    assertChipsConsistent(ui, scene);
    assert.ok(document.getElementById('battalion-picker').children.every(c => Number(c.dataset.bid) !== 1), '亡营卡片消失');

    // 时序 3：新营加入（领取最低空槽 → 重建分支，槽位重排）
    const fresh = scene.battalions.createBattalion('red', 'gathering');
    const recruit = addUnit(scene, 'red', 'infantry', 12, 30);
    fresh.members.push(recruit);
    recruit.battalion = fresh;
    scene.battalions.battalions.push(fresh);
    ui.updateBattalionBar();
    assert.equal(ui.battalionSlots().get(fresh.id), 1, '新营领取亡营释放的最低空槽');
    assertChipsConsistent(ui, scene);
    const slotsNow = ui.battalionSlots();
    for (const chip of document.getElementById('battalion-picker').children) {
        assert.equal(chip.dataset.slot, String(slotsNow.get(Number(chip.dataset.bid))), '卡面槽位与真实槽位一致');
    }

    // 时序 4：选中切换后再营亡（交错）
    scene.selectedBattalion = scene.battalions.battalions.filter(b => b.team === 'red')[0];
    ui.updateBattalionBar();
    scene.battalions.battalions = scene.battalions.battalions.filter(b => !(b.team === 'red' && b.id === fresh.id));
    ui.updateBattalionBar();
    assertChipsConsistent(ui, scene);
});

test('营卡条重建保持横向滚动位置（用户滚到右侧看卡，重建不跳回左端）', t => {
    const { ui, scene } = chipFixture(t);
    ui.updateBattalionBar();
    const row = document.getElementById('battalion-picker');
    row.scrollLeft = 120;   // 用户已横向滚动（溢出布局）
    scene.battalions.battalions = scene.battalions.battalions.filter(b => !(b.team === 'red' && b.id === 1));
    ui.updateBattalionBar();   // 列表变化 → 重建分支
    assert.equal(row.scrollLeft, 120, '重建后滚动位置应保持（浏览器自动夹紧到新内容宽度内）');
    assertChipsConsistent(ui, scene);
});
