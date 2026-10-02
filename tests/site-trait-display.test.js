// 据点特色的上屏口径：旗标三行（地形 / 占领奖励分列）、Text 对象复用、夺旗列表行、
// 占领播报一次性（按事件条数推进）、大本营永不显示特色。
import test from 'node:test';
import assert from 'node:assert/strict';
import { TERRITORY } from '../js/battle/economy.js';
import { SITE_TRAITS, traitOf } from '../js/battle/site-traits.js';
import { OverlayRenderer, flagLabelText, traitSiteRow } from '../js/render/overlay.js';
import { UI } from '../js/ui.js';
import { makeScene } from './battle-harness.js';

// ---------- 渲染层：旗标 Text 对象 ----------

function fakeText(objects) {
    const label = {
        text: '', textWrites: 0, destroyed: false, scale: 1,
        setOrigin() { return label; }, setDepth() { return label; },
        setScale(scale) { label.scale = scale; return label; },
        setText(text) { label.text = String(text); label.textWrites++; return label; },
        destroy() { label.destroyed = true; }
    };
    objects.push(label);
    return label;
}

function labelScene(flags) {
    const objects = [];
    let textCalls = 0;
    const scene = {
        simulationTime: 1000, battleId: 1, battleOptions: { territory: true, terrain: 'territory' },
        cameras: { main: { zoom: 0.5 } }, flags,
        add: { text: (_x, _y, text) => { textCalls++; const label = fakeText(objects); label.text = String(text ?? ''); return label; } },
        groundPoint: (gx, gy) => ({ x: gx * 10, y: gy * 10 })
    };
    return { scene, renderer: new OverlayRenderer(scene), objects, textCalls: () => textCalls };
}

test('旗标三行：归属+军费 / 占领奖励 / 地形本有效果，奖励与地形不混在一行', () => {
    const flag = { gx: 30, gy: 20, name: '西桥头', role: 'bridge', owner: 'red', benefit: '上翼过河通道' };
    const { renderer, objects } = labelScene([flag]);
    renderer.updateFlagLabels();
    const lines = objects[0].text.split('\n');
    assert.equal(lines.length, 3, '三行：归属 / 占领奖励 / 地形');
    assert.equal(lines[0], `🔴 西桥头 · 军费 +${TERRITORY.FLAG_INCOME}/秒`);
    assert.match(lines[1], /^占领：红方/);
    assert.match(lines[1], /工事/, '占领奖励取自特色表');
    assert.match(lines[1], /本点建筑受到伤害 −10%/);
    assert.doesNotMatch(lines[1], /跨河通道/, '地形不写进攻占奖励');
    assert.equal(lines[2], `地形：${SITE_TRAITS.bridge.terrain}`);
    assert.doesNotMatch(lines[2], /工事|−10%/, '地形行不重复占领奖励');
});

test('旗标按归属换标记：中立显示 ⚪ 并提示占领归属，长奖励只标中立不追加解释', () => {
    const bridge = { gx: 30, gy: 20, name: '西桥头', role: 'bridge', owner: null };
    const crossroad = { gx: 12, gy: 60, name: '西南路口', role: 'crossroad', owner: 'blue' };
    const neutralCrossroad = { gx: 60, gy: 12, name: '东南路口', role: 'crossroad', owner: null };
    const { renderer, objects } = labelScene([bridge, crossroad, neutralCrossroad]);
    renderer.updateFlagLabels();
    const neutral = objects[0].text.split('\n');
    assert.match(neutral[0], /^⚪ 西桥头 · 军费 \+4\/秒$/);
    assert.match(neutral[1], /^占领：工事/);
    assert.match(neutral[1], /中立，占领后归占领方/);
    const blue = objects[1].text.split('\n');
    assert.match(blue[0], /^🔵 西南路口/);
    assert.match(blue[1], /^占领：蓝方补给/, '归属方的奖励写清给谁生效');
    assert.match(blue[1], /伤兵收容 \+4 人/, '数字仍来自特色表');
    const long = objects[2].text.split('\n');
    assert.match(long[1], /（中立）$/, '长奖励仍标明中立');
    assert.doesNotMatch(long[1], /占领后归占领方/, '放不下就不再追加解释，旗标不被撑宽');
});

test('归属/角色变化只重写文字：复用同一批 Text 对象，归属不变不重写', () => {
    const flag = { gx: 30, gy: 20, name: '西桥头', role: 'bridge', owner: 'red' };
    const { renderer, objects, textCalls } = labelScene([flag]);
    renderer.updateFlagLabels();
    const label = objects[0], created = textCalls();
    assert.equal(created, 1);
    for (let i = 0; i < 5; i++) renderer.updateFlagLabels();
    assert.equal(textCalls(), created, '重复刷新不新建 Text 对象');
    assert.equal(label.textWrites, 0, '归属没变就不重写文字');
    flag.owner = 'blue';
    renderer.updateFlagLabels();
    assert.equal(textCalls(), created, '易主也复用同一个 Text 对象');
    assert.equal(label.textWrites, 1);
    assert.match(label.text, /^🔵 西桥头 · 军费 \+4\/秒/);
    assert.match(label.text, /占领：蓝方工事/);
    const afterOwner = label.textWrites;
    renderer.updateFlagLabels();
    assert.equal(label.textWrites, afterOwner, '同一次易主只重写一次');
    flag.role = 'forest';                     // 角色变化同样要刷新
    renderer.updateFlagLabels();
    assert.equal(label.textWrites, afterOwner + 1);
    assert.match(label.text, new RegExp(SITE_TRAITS.forest.terrain, 'u'));
});

test('重新部署换新旗数组时销毁旧标签并重建，草原/控制模式不建标签', () => {
    const { scene, renderer, objects } = labelScene([{ gx: 1, gy: 1, name: '西桥头', role: 'bridge', owner: 'red' }]);
    renderer.updateFlagLabels();
    const first = objects[0];
    scene.flags = [{ gx: 2, gy: 2, name: '西林口', role: 'forest', owner: 'blue' }];
    renderer.updateFlagLabels();
    assert.equal(first.destroyed, true);
    assert.equal(objects.filter(l => !l.destroyed).length, 1);
    assert.match(objects[1].text, /^🔵 西林口/);
    scene.battleOptions = { control: true };
    renderer.updateFlagLabels();
    assert.equal(objects.filter(l => !l.destroyed).length, 0, '非领土模式不显示据点标签');
});

// ---------- UI 层：DOM 桩 ----------

function element(tag = 'div') {
    const listeners = new Map();
    let text = '', writes = 0;
    const node = {
        tagName: tag.toUpperCase(), className: '', id: '', title: '', hidden: false, disabled: false,
        dataset: {}, children: [], style: {}, parentElement: null,
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        get textContent() { return text; },
        set textContent(value) { text = String(value); writes++; },
        get writes() { return writes; },
        appendChild(child) { child.parentElement = node; node.children.push(child); return child; },
        replaceChildren() { node.children = []; },
        querySelector(selector) { return byClass(node, selector); },
        setAttribute() {}, addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener() {}
    };
    return node;
}

function byClass(node, selector) {
    if (typeof selector !== 'string' || !selector.startsWith('.')) return null;
    const name = selector.slice(1);
    for (const child of node.children) {
        if ((child.className || '').split(/\s+/).includes(name)) return child;
        const nested = byClass(child, selector);
        if (nested) return nested;
    }
    return null;
}

function domFixture(t) {
    const previous = globalThis.document;
    const nodes = new Map(), created = [];
    const node = id => { if (!nodes.has(id)) { const el = element(); el.id = id; nodes.set(id, el); } return nodes.get(id); };
    globalThis.document = {
        getElementById: node, body: node('body'),
        createElement: tag => { const el = element(tag); created.push(el); return el; },
        querySelector: selector => selector === '#order-hold' ? node('order-hold') : null,
        querySelectorAll: selector => selector.includes('.order-btn')
            ? created.filter(el => (el.className || '').includes('order-btn')) : []
    };
    t.after(() => { globalThis.document = previous; });
    return { node, created, written: selector => created.filter(el => (el.className || '').includes(selector)) };
}

function uiFixture(t, flags, selected = null) {
    const dom = domFixture(t);
    const toasts = [];
    const scene = { flags, simulationTime: 0, selectedBattalion: selected, battleId: 1 };
    const ui = {
        ...UI, scene, phase: 'battle', mySide: 'red', countdown: false, holdStops: [],
        battleOptions: { territory: true, net: false }, _pendingBuys: [], _seenTerritoryTips: new Set(),
        campControls: { targeting: null, update() {}, reset() {} },
        showNetToast(text) { toasts.push(text); },
        updateBattalionBar: UI.updateBattalionBar, buildBattalionBar: UI.buildBattalionBar,
        updateTerritoryHUD: UI.updateTerritoryHUD, maybeShowTerritoryTips: UI.maybeShowTerritoryTips,
        showSiteTraitTip: UI.showSiteTraitTip, showTerritoryTip: UI.showTerritoryTip,
        pollSiteTraitEvents: UI.pollSiteTraitEvents
    };
    return { ui, dom, toasts, scene };
}

test('夺旗列表行显示归属与占领奖励，悬停说明给全生效条件与地形', t => {
    const flags = [
        { gx: 30, gy: 20, name: '西桥头', role: 'bridge', owner: 'red' },
        { gx: 12, gy: 60, name: '西南路口', role: 'crossroad', owner: null }
    ];
    const { ui, dom } = uiFixture(t, flags);
    ui.buildBattalionBar();
    const row = dom.node('battalion-flags');
    assert.equal(row.children.length, flags.length);
    const bridge = row.children[0];
    assert.equal(bridge.dataset.flagOrder, 0);
    const text = bridge.querySelector('.of-text').textContent;
    assert.match(text, /⚑ 西桥头 · 🔴红方 · 工事 · 本点建筑受到伤害 −10%/);
    assert.ok(bridge.querySelector('.ob-dot'), '归属圆点保留');
    assert.match(bridge.title, /占领奖励：工事：本点建筑受到伤害 −10%/);
    assert.match(bridge.title, /生效条件：该据点当前归属己方时，本点己方建筑生效/);
    assert.match(bridge.title, /地形：跨河通道与桥面地形/);
    const crossroad = row.children[1];
    assert.match(crossroad.querySelector('.of-text').textContent, /⚑ 西南路口 · ⚪中立 · /);
    assert.match(crossroad.querySelector('.of-text').textContent, /伤兵收容 \+4 人/);
});

test('据点行只在归属或角色变化时改一次 DOM，其余刷新不动节点', t => {
    const flags = [{ gx: 30, gy: 20, name: '西桥头', role: 'bridge', owner: 'red' }];
    const battalion = { id: 1, team: 'red', stance: 'hold', orderFlag: null, aliveMembers: () => [{ type: 'infantry' }] };
    const { ui, dom } = uiFixture(t, flags, battalion);
    ui.buildBattalionBar();
    const btn = dom.node('battalion-flags').children[0], text = btn.querySelector('.of-text');
    ui.updateBattalionBar();
    for (let i = 0; i < 4; i++) ui.updateBattalionBar();
    assert.equal(text.writes, 1, '建行时只写一次，归属未变不再改文字');
    flags[0].owner = 'blue';
    ui.updateBattalionBar();
    assert.equal(dom.node('battalion-flags').children[0], btn, '刷新不重建行');
    assert.equal(text.writes, 2);
    assert.match(text.textContent, /⚑ 西桥头 · 🔵蓝方 · /);
    assert.match(btn.title, /占领奖励/);
    ui.updateBattalionBar();
    assert.equal(text.writes, 2, '同一次易主只刷新一次');
});

test('大本营不显示任何据点特色：行文案、旗标与回防按钮都只讲集结', t => {
    const home = { siteId: 'home', name: '大本营', role: 'bridge', owner: 'red' };
    const row = traitSiteRow(home);
    assert.equal(row.text, '⚑ 大本营 · 🔴红方');
    assert.doesNotMatch(row.text, /工事|占领|−10%/);
    assert.equal(row.title, '大本营 · 🔴红方');
    const label = flagLabelText(home);
    assert.equal(label.split('\n').length, 1);
    assert.doesNotMatch(label, /占领：|地形：/);
    const { ui, dom } = uiFixture(t, [{ gx: 30, gy: 20, name: '西桥头', role: 'bridge', owner: 'red' }]);
    ui.buildBattalionBar();
    const button = dom.node('battalion-orders').children.find(child => child.dataset.orderHome !== undefined);
    assert.ok(button);
    assert.equal(button.textContent, '🏠 回防集结');
    assert.match(button.title, /大本营/);
    assert.doesNotMatch(button.title, /占领|工事|征募|浅滩|士气|收容|施工|移速|伤害/);
});

// ---------- 占领播报：按事件条数只播一次 ----------

function battleFixture(t) {
    const flags = [
        { gx: 30, gy: 20, name: '西桥头', role: 'bridge', owner: 'red', contested: false },
        { gx: 130, gy: 90, name: '中央高地', role: 'hill', owner: null, contested: false }
    ];
    const { ui, dom, toasts } = uiFixture(t, flags);
    const scene = makeScene();
    scene.deployUnits({ infantry: 4 }, { infantry: 4 }, 'custom', 'custom', {},
        { territory: true, territoryAI: false, terrain: 'terrain' });
    scene.battleStarted = true;
    scene.simulationTime = 30000;
    scene.render.camps.pick = () => null;
    ui.scene = scene;
    return { ui, dom, toasts, scene, flags };
}

test('据点特色播报：每条占领事件只播一次，非特色事件与重复刷新都不打扰', t => {
    const { ui, toasts, scene } = battleFixture(t);
    scene.addBattleEvent('flag-西桥头-red-28', '红方占领了西桥头旗帜', 'red');
    scene.addBattleEvent('trait-西桥头-red-30', '红方西桥头工事：本点建筑受到伤害 −10%生效', 'red');
    ui.updateTerritoryHUD();
    assert.equal(toasts.length, 1, '旗帜事件不播报，只有据点特色事件播报');
    assert.match(toasts[0], /工事：本点建筑受到伤害 −10%/);
    ui.updateTerritoryHUD();
    ui.updateTerritoryHUD();
    assert.equal(toasts.length, 1, '同一条占领事件不重复播报');
    scene.simulationTime = 40000;
    scene.addBattleEvent('ranch-西马场-blue-40', '蓝方掌控西马场，骑兵征募开启；红方骑源被断', 'blue');
    ui.updateTerritoryHUD();
    assert.equal(toasts.length, 2, '易主（失去特色）同样播报一次');
    assert.match(toasts[1], /掌控西马场/);
    ui.updateTerritoryHUD();
    assert.equal(toasts.length, 2);
});

test('非战斗阶段不弹据点播报，游标照常推进（回战斗也不补播旧消息）', t => {
    const { ui, toasts, scene } = battleFixture(t);
    scene.addBattleEvent('trait-中央高地-red-30', '红方中央高地稳固军心：驻守营队士气损失 −10%生效', 'red');
    ui.phase = 'ready';
    ui.pollSiteTraitEvents();
    assert.equal(toasts.length, 0, '非战斗阶段不打扰玩家');
    ui.phase = 'battle';
    ui.updateTerritoryHUD();
    assert.equal(toasts.length, 0, '已经过去的占领消息不补播');
    scene.addBattleEvent('trait-中央高地-blue-50', '蓝方中央高地稳固军心：驻守营队士气损失 −10%生效', 'blue');
    ui.updateTerritoryHUD();
    assert.equal(toasts.length, 1);
    assert.match(toasts[0], /蓝方中央高地/);
    scene.ledger.events.length = 0;             // 新一局：账本清空后重新计数
    ui.updateTerritoryHUD();
    scene.addBattleEvent('trait-中央高地-red-10', '红方中央高地稳固军心：驻守营队士气损失 −10%生效', 'red');
    ui.updateTerritoryHUD();
    assert.equal(toasts.length, 2, '新局里第一次占领照样播报');
});

test('真打一次夺旗：模拟写出的据点特色战报正好播报一次（键名契约不靠文案前缀）', t => {
    const scene = makeScene();
    scene.deployUnits({ infantry: 2 }, { infantry: 2 }, 'custom', 'custom', {},
        { territory: true, territoryAI: false });
    scene.battleStarted = true;
    scene.render.camps.pick = () => null;
    const hill = scene.flags.findIndex(flag => flag.role === 'hill');
    assert.ok(hill >= 0, '领土图有中央高地旗点');
    const target = scene.flags[hill];
    for (let i = 0; i < 11; i++) scene.spawnUnit('red', 'infantry', target.gx, target.gy);
    scene.selectedBattalion = null;
    const { ui, toasts } = uiFixture(t, scene.flags);
    ui.scene = scene;
    for (let i = 0; i < 60 * 20 && target.owner !== 'red'; i++) scene.advanceBattle(1000 / 60);
    assert.equal(target.owner, 'red', '红方站在旗点上能把高地拉成自己的');
    const event = scene.ledger.events.find(entry => entry.key.startsWith('trait-'));
    assert.ok(event, '占领特色据点写入 trait- 战报');
    assert.match(event.key, /^trait-中央高地-red-\d+$/);
    assert.match(event.text, /稳固军心/);
    ui.updateTerritoryHUD();
    assert.deepEqual(toasts, [event.text], '界面按事件播报一次');
    ui.updateTerritoryHUD();
    assert.equal(toasts.length, 1, '同一次夺旗不会因为刷新而重复播报');
});

// ---------- 一次性提示：新规则可发现 ----------
test('据点特色提示一次性：高地讲清驻守与生效条件，重复调用不再写 DOM', t => {
    const { ui, dom } = uiFixture(t, []);
    assert.equal(ui.showTerritoryTip('hill'), true);
    const text = dom.node('territory-tip-text');
    assert.match(text.textContent, /中央高地/);
    assert.match(text.textContent, /移动并驻守/);
    assert.match(text.textContent, new RegExp(traitOf('hill').reward.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
    assert.match(text.textContent, /生效条件：高地归属己方 \+ 该营有明确驻守令 \+ 在旗点 8 格内/);
    assert.equal(dom.node('territory-tip').hidden, false);
    const writes = text.writes;
    assert.equal(ui.showTerritoryTip('hill'), false, '同一种提示只讲一次');
    assert.equal(text.writes, writes);
});

test('选中营的夺旗目标是特色据点时，讲一次对应规则；被争夺的己方据点同样触发', t => {
    const flags = [
        { gx: 30, gy: 20, name: '西桥头', role: 'bridge', owner: null, contested: false },
        { gx: 130, gy: 90, name: '西林口', role: 'forest', owner: 'red', contested: true }
    ];
    const battalion = { id: 1, team: 'red', orderFlag: 0, aliveMembers: () => [{ type: 'infantry' }] };
    const { ui, dom } = uiFixture(t, flags, battalion);
    ui._seenTerritoryTips.add('command');       // 基础操作提示已经讲过
    ui.maybeShowTerritoryTips();
    assert.match(dom.node('territory-tip-text').textContent, /桥头/);
    const writes = dom.node('territory-tip-text').writes;
    ui.maybeShowTerritoryTips();
    assert.equal(dom.node('territory-tip-text').writes, writes, '同样的选择不再重复写提示');
    battalion.orderFlag = null;                 // 转而防守被争夺的林口
    ui.maybeShowTerritoryTips();
    assert.match(dom.node('territory-tip-text').textContent, /林口/);
    assert.match(dom.node('territory-tip-text').textContent, /施工时间 −20%/);
});
