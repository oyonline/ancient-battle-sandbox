// ==================== 弓箭手驻入箭塔：发现性与反馈 ====================
// 覆盖四件事：
//   1. 完工箭塔的驻军读数（塔内 N/4 + 还在路上的预约人数）；
//   2. 可驻军高亮的出现 / 消失 / 重画时机（深度带 + 未变化帧不重建）；
//   3. 驻军被拒的具体原因（已满 / 未完工 / 敌方 / 没有弓手）与"拒绝不结束选点"；
//   4. 观察层任务行（前往箭塔 / 医帐、驻塔中 / 驻帐中）与渡口浅滩移速文案。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CampControls } from '../js/camp-controls.js';
import { UnitInspector } from '../js/inspection.js';
import { makeScene, addUnit, Terrain } from './battle-harness.js';
import { TERRITORY } from '../js/battle/economy.js';
import { territoryLayout } from '../js/territory-map.js';
import { board, resetBoardSize } from '../js/board.js';

const RED_SITE = 0;                    // 开局红方据点（桥头），塔位/帐位都可用
const RED_ARCHER_BATTALION = 2;        // 真实营队：2 营含弓手
const BLUE_ARCHER_BATTALION = 5;       // 蓝方含弓手的营队（本端切到蓝方时用）

// 领土局真实模拟 + 真实渲染帧入口；board 尺寸是全局量，结束时必须复位。
function battleScene(t) {
    t.after(() => resetBoardSize());
    const scene = makeScene();
    scene.deployUnits({ ...TERRITORY.OPENING }, { ...TERRITORY.OPENING }, 'custom', 'custom', {},
        { territory: true, territoryAI: false, terrain: 'territory' });
    scene.battleStarted = true;
    return scene;
}

function stubPanel() {
    const listeners = new Map();
    let html = '';
    return {
        hidden: true, listeners, writes: 0,
        get innerHTML() { return html; },
        set innerHTML(value) { html = value; this.writes++; },
        addEventListener(name, fn) { listeners.set(name, fn); },
        replaceChildren() { this.innerHTML = ''; }
    };
}

function buttonTag(panel, action) {
    const tag = panel.innerHTML.match(new RegExp(`<button data-camp-action="${action}"[^>]*>`));
    assert.ok(tag, `面板应展示 ${action} 按钮`);
    return tag[0];
}
const disabled = (panel, action) => /\bdisabled\b/.test(buttonTag(panel, action));

// 与 camp-controls 的读取口径一致的选择桩：只用到 team 与 aliveMembers()。
function selectUnits(scene, units) {
    scene.selectedBattalion = units.length ? { id: 90, team: units[0].team, aliveMembers: () => units } : null;
    if (scene.unitInspector) scene.unitInspector.selected = null;
}

function pickBattalion(scene, id) {
    scene.selectedBattalion = scene.battalions.battalions.find(b => b.id === id);
    if (scene.unitInspector) scene.unitInspector.selected = null;
    return scene.selectedBattalion;
}

// 选了兵但没有弓手：真实营队都含弓手，这里用同口径的步兵选择桩。
function selectInfantryOnly(scene, count = 2) {
    selectUnits(scene, scene.units.filter(u => u.team === 'red' && u.type === 'infantry').slice(0, count));
    return scene.selectedBattalion;
}

function campControlsFixture(t) {
    const scene = battleScene(t);
    const previousDocument = globalThis.document;
    const panel = stubPanel();
    globalThis.document = { getElementById: id => id === 'camp-control-bar' ? panel : null,
        body: { classList: { add() {}, remove() {}, toggle() {} } } };
    t.after(() => { globalThis.document = previousDocument; });
    const picked = { building: null };
    const toasts = [];
    scene.render.camps.pick = () => picked.building;
    scene.unitInspector = { selected: null };
    const ui = { scene, mySide: 'red', phase: 'battle', countdown: false, battleOptions: { net: false },
        cancelHoldTargeting() {}, cancelRallyTargeting() {}, showNetToast(text) { toasts.push(text); },
        applyGroundOrder(world, callback) { callback(world.x, world.y); } };
    return { scene, camps: scene.territory.camps, controls: new CampControls(ui), panel, picked, toasts, ui };
}

// 观察层测试：只读观察层需要输入事件与镜头桩，其余全部走真实模拟。
function inspectorFixture(t) {
    const scene = battleScene(t);
    const previousDocument = globalThis.document;
    const panel = { hidden: true, innerHTML: '' };
    globalThis.document = { getElementById: () => panel };
    t.after(() => { globalThis.document = previousDocument; });
    const events = new Map();
    scene.input = { on: (name, fn) => events.set(name, fn), off: name => events.delete(name) };
    scene.game = { events: { on() {}, off() {} } };
    scene.events = { once() {} };
    scene.cameras.main.zoom = 1;
    scene.cameras.main.getWorldPoint = (x, y) => ({ x, y });
    return { scene, camps: scene.territory.camps, panel, events, inspector: new UnitInspector(scene) };
}

// 高亮重画计数：替换绘制方法，只数"本帧画了几笔"。
function spyDraws(g) {
    const calls = { clears: 0, shapes: 0 };
    g.clear = () => { calls.clears++; };
    for (const name of ['fillStyle', 'lineStyle', 'fillEllipse', 'strokeEllipse', 'fillRect']) {
        g[name] = () => { calls.shapes++; };
    }
    return calls;
}

test('完工箭塔标签显示弓手 N/4，在路上的弓手计入读数', t => {
    const scene = battleScene(t);
    const camps = scene.territory.camps, renderer = scene.render.camps;
    const tower = camps.getBuilding('tower:red:home');
    renderer.update();
    const view = renderer.views.get(tower.id);
    assert.equal(view.label.text, '箭塔 弓手 0/4', '空塔也要写清收的是弓手、容量 4');

    // 派两名弓手前往：塔内还是 0 人，但标签必须说明有两名在路上。
    const archers = [addUnit(scene, 'red', 'archer', tower.gx + 8, tower.gy + 4),
        addUnit(scene, 'red', 'archer', tower.gx + 8, tower.gy + 6)];
    assert.equal(camps.orderGarrison('red', archers.map(u => u.id), tower.id), true);
    assert.equal(camps.garrisonStatus(tower).reserved, 2, '预约人数由模拟统计，含在路上的');
    renderer.update();
    assert.equal(view.label.text, '箭塔 弓手 0/4（2 前往中）');

    // 一人到塔、一人还在路上：塔内 1 人 + 1 人前往中。
    tower.garrisonIds.push(archers[0].id);
    archers[0].garrisonTowerId = tower.id; archers[0].garrisonOrderId = null;
    renderer.update();
    assert.equal(view.label.text, '箭塔 弓手 1/4（1 前往中）');
});

test('可驻军高亮只出现在己方完工未满的箭塔，且只在状态变化时重画', t => {
    const scene = battleScene(t);
    const camps = scene.territory.camps, renderer = scene.render.camps;
    const tower = camps.getBuilding('tower:red:home');
    const enemyTower = camps.getBuilding('tower:blue:home');
    const unfinished = camps.createBuilding('red', 'tower', RED_SITE);
    assert.ok(unfinished && !unfinished.complete, '本测试需要一座未完工的己方箭塔');
    renderer.update();
    const view = renderer.views.get(tower.id);
    const enemyView = renderer.views.get(enemyTower.id);
    const unfinishedView = renderer.views.get(unfinished.id);
    for (const v of [view, enemyView, unfinishedView]) assert.ok(v.highlight, '每座建筑都有自己的高亮层');

    // HARD：高亮跟建筑自己的深度带走，不得钉在固定深度的世界覆盖层（11980–12125）上，
    // 否则在 260×180 大地图上会被任何 gx+gy 更大的建筑整体遮住。
    const OVERLAY_DEPTHS = [11980, 11990, 11995, 12000, 12050, 12100, 12120, 12125];
    assert.equal(view.highlight.depth, (tower.gx + tower.gy) * 100 + 20);
    assert.equal(enemyView.highlight.depth, (enemyTower.gx + enemyTower.gy) * 100 + 20);
    assert.notEqual(view.highlight.depth, enemyView.highlight.depth, '不同位置的建筑各用各的深度带');
    assert.ok(!OVERLAY_DEPTHS.includes(view.highlight.depth) && !OVERLAY_DEPTHS.includes(enemyView.highlight.depth));
    assert.ok(enemyView.highlight.depth > 12125, '远处箭塔的高亮高于覆盖层，才能压在它前面的建筑之下、后面的建筑之上');
    assert.ok(!view.parts.includes(view.highlight), '高亮不参与废墟显隐 / 施工透明处理');

    const mine = spyDraws(view.highlight), enemy = spyDraws(enemyView.highlight), flat = spyDraws(unfinishedView.highlight);
    const frame = spy => { const before = spy.shapes; renderer.update(); return spy.shapes - before; };

    assert.equal(frame(mine), 0, '没有选择时不提示');
    pickBattalion(scene, RED_ARCHER_BATTALION);
    assert.ok(frame(mine) > 0, '选中含弓手的己方营队后，己方完工箭塔提示可驻军');
    assert.equal(frame(enemy), 0, '敌方箭塔不提示');
    assert.equal(frame(flat), 0, '未完工箭塔不提示');

    const stable = { clears: mine.clears, shapes: mine.shapes };
    for (let i = 0; i < 10; i++) renderer.update();
    assert.deepEqual({ clears: mine.clears, shapes: mine.shapes }, stable, '未变化的帧不重画高亮');

    // 满员（含在路上）后不再提示：预约也占容量。
    const archers = scene.units.filter(u => u.team === 'red' && u.type === 'archer').slice(0, 4);
    assert.equal(archers.length, 4);
    assert.equal(camps.orderGarrison('red', archers.map(u => u.id), tower.id), true);
    assert.equal(camps.garrisonStatus(tower).full, true);
    assert.ok(frame(mine) === 0 && mine.clears > stable.clears, '满员时清掉高亮且不再画');
    assert.equal(mine.shapes, stable.shapes);

    // 选择换成没有弓手的营队：即使塔有空位也不再提示。
    unfinished.dead = true;
    camps.getBuilding('tower:red:home').garrisonIds.length = 0;
    for (const u of archers) { u.garrisonOrderId = null; }
    assert.equal(camps.garrisonStatus(tower).full, false, '清空预约后塔重新有空位');
    selectInfantryOnly(scene);
    assert.equal(frame(mine), 0, '选择里没有弓手时不提示');

    // 单体选择路径（unitInspector.selected）与营队选择同口径。
    selectUnits(scene, []);
    scene.unitInspector = { selected: scene.units.find(u => u.team === 'red' && u.type === 'archer') };
    assert.ok(frame(mine) > 0, '单选一名弓手同样提示可驻军');
    scene.unitInspector.selected = scene.units.find(u => u.team === 'red' && u.type === 'infantry');
    assert.equal(frame(mine), 0, '单选步兵不提示');

    // 换到本端蓝方：提示跟着"己方"走。
    scene.netMySide = 'blue';
    scene.unitInspector.selected = null;
    pickBattalion(scene, BLUE_ARCHER_BATTALION);
    assert.ok(frame(enemy) > 0, '本端换成蓝方后，蓝方完工箭塔才是"己方"');
    assert.equal(frame(mine), 0, '红方箭塔不再提示');
});

test('稳定状态下连续帧不重建视图，也不新建图形 / 文字对象', t => {
    const scene = battleScene(t);
    const camps = scene.territory.camps, renderer = scene.render.camps;
    const tower = camps.getBuilding('tower:red:home');
    pickBattalion(scene, RED_ARCHER_BATTALION);
    const archers = scene.units.filter(u => u.team === 'red' && u.type === 'archer').slice(0, 2);
    camps.orderGarrison('red', archers.map(u => u.id), tower.id);
    renderer.update();

    const created = { graphics: 0, image: 0, text: 0 };
    for (const kind of ['graphics', 'image', 'text']) {
        const original = scene.add[kind];
        scene.add[kind] = (...args) => { created[kind]++; return original(...args); };
    }
    const views = [...renderer.views.values()];
    for (let i = 0; i < 30; i++) renderer.update();
    assert.deepEqual(created, { graphics: 0, image: 0, text: 0 }, '未变化的帧不新建任何显示对象');
    assert.deepEqual([...renderer.views.values()], views, '视图对象被复用，不重建');
    assert.equal(renderer.views.get(tower.id).label.text, '箭塔 弓手 0/4（2 前往中）');
});

test('驻入箭塔的拒绝原因具体到玩家语言，且拒绝不结束选点', t => {
    const { scene, camps, controls, picked, toasts } = campControlsFixture(t);
    const tower = camps.getBuilding('tower:red:home');
    const enemyTower = camps.getBuilding('tower:blue:home');
    const unfinished = camps.createBuilding('red', 'tower', RED_SITE);
    const archers = [];
    for (let i = 0; i < 4; i++) archers.push(addUnit(scene, 'red', 'archer', tower.gx + 8, tower.gy + i));
    selectUnits(scene, archers);
    controls.begin('garrison');
    assert.equal(controls.targeting?.kind, 'garrison');

    picked.building = enemyTower;
    toasts.length = 0;
    assert.equal(controls.handleGroundClick({ x: 0, y: 0 }, null), true);
    assert.match(toasts.join('|'), /敌方箭塔/);
    assert.ok(controls.targeting, '被拒后保持选点，玩家可以直接改点另一座塔');

    picked.building = unfinished;
    toasts.length = 0;
    controls.handleGroundClick({ x: 0, y: 0 }, null);
    assert.match(toasts.join('|'), /尚未完工/);
    assert.ok(controls.targeting);

    assert.equal(camps.orderGarrison('red', archers.map(u => u.id), tower.id), true);
    assert.equal(camps.garrisonStatus(tower).full, true);
    picked.building = tower;
    toasts.length = 0;
    controls.handleGroundClick({ x: 0, y: 0 }, null);
    assert.match(toasts.join('|'), /已满（4\/4，含正在前往的）/);
    assert.ok(controls.targeting, '满员拒绝也不结束选点');

    // 选择里没有弓手：不进入选点，并给出具体原因（不是静默返回）。
    controls.cancel();
    selectInfantryOnly(scene);
    toasts.length = 0;
    controls.begin('garrison');
    assert.equal(controls.targeting, null, '没有弓手时不进入选点');
    assert.match(toasts.join('|'), /没有可入驻的弓箭手/);
});

test('驻军受理后给出"正在前往"反馈，预约计入容量、不会超额预订', t => {
    const { scene, camps, controls, picked, toasts } = campControlsFixture(t);
    const tower = camps.getBuilding('tower:red:home');
    const archers = [];
    for (let i = 0; i < 6; i++) archers.push(addUnit(scene, 'red', 'archer', tower.gx + 7 + i * 0.4, tower.gy + 6));
    picked.building = tower;

    selectUnits(scene, archers.slice(0, 4));
    controls.begin('garrison');
    toasts.length = 0;
    assert.equal(controls.handleGroundClick({ x: 0, y: 0 }, null), true);
    assert.equal(controls.targeting, null, '受理后结束选点');
    assert.match(toasts.at(-1), /🏹 4 名弓手正在前往箭塔/);
    assert.equal(camps.garrisonStatus(tower).reserved, 4);
    assert.equal(archers[0].garrisonOrderId, tower.id, '命令真的落到模拟里');

    // 第 5 名弓手：UI 与直接下令都不能超额预订。
    selectUnits(scene, [archers[4]]);
    controls.begin('garrison');
    toasts.length = 0;
    controls.handleGroundClick({ x: 0, y: 0 }, null);
    assert.match(toasts.at(-1), /已满/);
    assert.ok(controls.targeting, '满员时留在选点里等玩家换塔');
    assert.ok(!archers[4].garrisonOrderId, '第 5 名弓手没有被超额预订');
    assert.equal(camps.orderGarrison('red', [archers[4].id], tower.id), false);
    assert.equal(camps.garrisonStatus(tower).reserved, 4, '预约数没有被撑到 5');
});

// Review P2-6 复现：选中 4 名弓手、其中 3 名溃逃时，模拟只受理 1 名，
// 修复前提示仍说"4 名弓手正在前往箭塔"。修复后提示人数 = 模拟受理口径。
test('箭塔下令人数按模拟受理口径：溃逃者不被计入"正在前往"', t => {
    const { scene, camps, controls, picked, toasts } = campControlsFixture(t);
    const tower = camps.getBuilding('tower:red:home');
    const archers = [];
    for (let i = 0; i < 4; i++) archers.push(addUnit(scene, 'red', 'archer', tower.gx + 8, tower.gy + i));
    for (const routing of archers.slice(1)) {
        routing.moraleState = 'routing';
        routing.routStartedAt = 0;
    }
    picked.building = tower;

    selectUnits(scene, archers);
    controls.begin('garrison');
    toasts.length = 0;
    assert.equal(controls.handleGroundClick({ x: 0, y: 0 }, null), true);
    assert.equal(controls.targeting, null);
    assert.match(toasts.at(-1), /🏹 1 名弓手正在前往箭塔/);
    assert.equal(camps.garrisonStatus(tower).reserved, 1, '模拟实际只预约 1 人');
    assert.equal(archers[0].garrisonOrderId, tower.id, '唯一未溃逃者接到命令');
    for (const routing of archers.slice(1)) {
        assert.ok(!routing.garrisonOrderId, '溃逃者没有接到驻塔命令');
    }
});

test('受理口径覆盖：死亡/已驻塔/已预约同塔/重复 ID/容量不足都不虚报', t => {
    const { scene, camps, controls, picked, toasts } = campControlsFixture(t);
    const tower = camps.getBuilding('tower:red:home');
    const other = camps.createBuilding('red', 'tower', RED_SITE, true);
    const archers = [];
    for (let i = 0; i < 5; i++) archers.push(addUnit(scene, 'red', 'archer', tower.gx + 8, tower.gy + i));

    // 已驻别的塔 / 已预约本塔 / 死亡 各一人，加重复 ID。
    archers[1].garrisonTowerId = other.id;
    archers[2].garrisonOrderId = tower.id;      // 此人此前已预约本塔：占 1 个名额但不算"新前往"
    archers[3].dead = true;
    picked.building = tower;
    selectUnits(scene, [archers[0], archers[1], archers[2], archers[3], archers[4], archers[0]]);
    controls.begin('garrison');
    toasts.length = 0;
    assert.equal(controls.handleGroundClick({ x: 0, y: 0 }, null), true);
    assert.match(toasts.at(-1), /🏹 2 名弓手正在前往箭塔/, '只有 0 号与 4 号新受理（重复 ID 去重）');
    assert.equal(camps.garrisonStatus(tower).reserved, 3, '已有预约 1 人 + 新受理 2 人');

    // 剩余容量不足：再选 4 名可用弓手，只剩 1 个名额 → 提示 1 而不是 4。
    const more = [];
    for (let i = 0; i < 4; i++) more.push(addUnit(scene, 'red', 'archer', tower.gx + 9, tower.gy + i));
    selectUnits(scene, more);
    controls.begin('garrison');
    toasts.length = 0;
    controls.handleGroundClick({ x: 0, y: 0 }, null);
    assert.match(toasts.at(-1), /🏹 1 名弓手正在前往箭塔/, '容量 4 已占 3：只受理剩余 1 个名额');
    assert.equal(camps.garrisonStatus(tower).reserved, 4, '总预约正好等于容量');
    assert.equal(more[0].garrisonOrderId, tower.id);
    assert.ok(!more[1].garrisonOrderId && !more[2].garrisonOrderId && !more[3].garrisonOrderId, '超额者不被预约');
});

test('联机只承诺命令已发送，不承诺未来接受的人数', t => {
    const scene = battleScene(t);
    const previousDocument = globalThis.document;
    const panel = stubPanel();
    globalThis.document = { getElementById: id => id === 'camp-control-bar' ? panel : null,
        body: { classList: { add() {}, remove() {}, toggle() {} } } };
    t.after(() => { globalThis.document = previousDocument; });
    const picked = { building: null };
    const toasts = [];
    const sent = [];
    scene.render.camps.pick = () => picked.building;
    scene.unitInspector = { selected: null };
    const ui = { scene, mySide: 'red', phase: 'battle', countdown: false, battleOptions: { net: true },
        cancelHoldTargeting() {}, cancelRallyTargeting() {}, showNetToast(text) { toasts.push(text); },
        applyGroundOrder(world, callback) { callback(world.x, world.y); } };
    scene.net = { lockstep: { act(command) { sent.push(command); } } };
    const controls = new CampControls(ui);
    const camps = scene.territory.camps;
    const tower = camps.getBuilding('tower:red:home');

    const archers = [];
    for (let i = 0; i < 4; i++) archers.push(addUnit(scene, 'red', 'archer', tower.gx + 8, tower.gy + i));
    for (const routing of archers.slice(1)) routing.moraleState = 'routing';
    picked.building = tower;
    selectUnits(scene, archers);
    controls.begin('garrison');
    toasts.length = 0;
    assert.equal(controls.handleGroundClick({ x: 0, y: 0 }, null), true);
    assert.equal(sent.length, 1, '命令进入锁步队列');
    assert.equal(sent[0].k, 'garrison');
    assert.equal(camps.garrisonStatus(tower).reserved, 0, '入队不等于执行：本地模拟未被触碰');
    assert.match(toasts.at(-1), /命令已发送/);
    assert.doesNotMatch(toasts.at(-1), /名弓手正在前往箭塔/, '不能在入队时承诺未来接受的人数');
    assert.match(toasts.at(-1), /剩余容量/, '说明实际入驻取决于到达时的容量');
});

test('建筑面板给出驻军读数与在路上人数，选兵无弓手时入口置灰并说明原因', t => {
    const { scene, camps, controls, panel, picked } = campControlsFixture(t);
    const tower = camps.getBuilding('tower:red:home');
    picked.building = tower;
    controls.handleGroundClick({ x: 0, y: 0 }, null);            // 点选建筑 → 自动打开面板
    assert.match(panel.innerHTML, /驻军 弓手 0\/4/);

    const archers = [addUnit(scene, 'red', 'archer', tower.gx + 8, tower.gy),
        addUnit(scene, 'red', 'archer', tower.gx + 8, tower.gy + 2)];
    assert.equal(camps.orderGarrison('red', archers.map(u => u.id), tower.id), true);
    controls.update();
    assert.match(panel.innerHTML, /驻军 弓手 0\/4 · 弓手正在前往/, '塔还空着就要说清弓手在路上');

    tower.garrisonIds.push(archers[0].id);
    archers[0].garrisonTowerId = tower.id; archers[0].garrisonOrderId = null;
    controls.update();
    assert.match(panel.innerHTML, /驻军 弓手 1\/4（\+1 前往中）/, '塔内人数与在路上的预约一起显示');

    // 选兵但没有弓手：入口可见、置灰、title 说明原因；不能进入选点。
    selectInfantryOnly(scene);
    controls.update();
    assert.equal(disabled(panel, 'garrison'), true);
    assert.match(buttonTag(panel, 'garrison'), /title="[^"]*没有弓箭手[^"]*"/);
    panel.listeners.get('click')({ target: { closest: () => ({ disabled: true,
        dataset: { campAction: 'garrison' } }) } });
    assert.equal(controls.targeting, null, '置灰入口不触发选点');

    pickBattalion(scene, RED_ARCHER_BATTALION);
    controls.update();
    assert.equal(disabled(panel, 'garrison'), false, '有弓手时入口可点');

    selectUnits(scene, []);
    controls.update();
    assert.doesNotMatch(panel.innerHTML, /data-camp-action="garrison"/, '什么都没选时不出现该入口');

    const writes = panel.writes;
    for (let i = 0; i < 20; i++) controls.update();
    assert.equal(panel.writes, writes, '未变化的帧不重建面板');
});

test('观察层任务行区分"前往箭塔/医帐"与"驻塔中/驻帐中"', t => {
    const { scene, camps, inspector, panel } = inspectorFixture(t);
    const tower = camps.getBuilding('tower:red:home');
    const tent = camps.createBuilding('red', 'tent', RED_SITE);
    assert.ok(tent);
    const archer = addUnit(scene, 'red', 'archer', tower.gx + 3, tower.gy + 3);
    inspector.selected = archer;

    archer.garrisonOrderId = tower.id;
    inspector.update(true);
    assert.match(panel.innerHTML, /class="inspection-task">正在前往箭塔</);
    archer.garrisonOrderId = tent.id;
    inspector.update(true);
    assert.match(panel.innerHTML, /class="inspection-task">正在前往医帐</);

    archer.garrisonOrderId = null;
    archer.garrisonTowerId = tower.id; archer.garrisonHeight = tower.garrisonHeight;
    tower.garrisonIds.push(archer.id);
    inspector.update(true);
    assert.match(panel.innerHTML, /class="inspection-task">驻塔中</);
    assert.doesNotMatch(panel.innerHTML, /自主行军/, '在路上的弓手不再被写成自主行军');

    archer.garrisonTowerId = tent.id;
    tent.garrisonIds.push(archer.id);
    inspector.update(true);
    assert.match(panel.innerHTML, /class="inspection-task">驻帐中 · 治疗伤兵</);
});

test('浅滩移速按渡口特色显示 85%，没有渡口时仍是蹚水 70%', t => {
    const scene = battleScene(t);
    const fords = scene.flags.filter(flag => flag.role === 'ford');
    assert.equal(fords.length, 2, '山河图有两座镜像渡口');
    for (const flag of fords) flag.owner = null;
    const cx = board.W / 2, fordY = territoryLayout(board.W, board.H).fordY;
    assert.equal(Terrain.surface('territory', cx - 2, fordY - 1), 'shallow');
    const mine = addUnit(scene, 'red', 'archer', cx - 2, fordY - 1);
    const theirs = addUnit(scene, 'blue', 'archer', cx + 2, fordY - 1);

    const plain = UnitInspector.describe(scene, mine);
    assert.equal(plain.surface, 'shallow');
    assert.equal(plain.surfaceSpeed, 0.7);
    assert.equal(plain.surfaceLabel, '浅滩（蹚水减速）');

    for (const flag of fords) flag.owner = 'red';
    const perk = UnitInspector.describe(scene, mine);
    assert.equal(perk.surfaceSpeed, 0.85, '拥有渡口的一方浅滩 70% → 85%');
    assert.equal(perk.surfaceLabel, '浅滩（渡口通行，移速 85%）');
    assert.equal(UnitInspector.describe(scene, theirs).surfaceSpeed, 0.7, '渡口只帮拥有它的一方');
});
