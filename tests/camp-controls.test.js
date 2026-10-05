import test from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { CampControls } from '../js/camp-controls.js';
import { CAMP_RULES } from '../js/battle/camps.js';
import { makeScene, addUnit } from './battle-harness.js';

function fixture(t) {
    const previousDocument = globalThis.document;
    t.after(() => { globalThis.document = previousDocument; });
    const panel = { hidden: true, innerHTML: '', addEventListener() {}, replaceChildren() {} };
    globalThis.document = { getElementById: () => panel,
        body: { classList: { add() {}, remove() {} } } };
    const scene = makeScene();
    scene.deployUnits({}, {}, 'custom', 'custom', {}, { territory: true, territoryAI: false, terrain: 'flat' });
    scene.battleStarted = true;
    const camps = scene.territory.camps;
    const site = scene.flags.findIndex(flag => flag.owner === 'red');
    const position = camps.placement('red', 'camp', site);
    const worker = addUnit(scene, 'red', 'worker', position.gx, position.gy);
    scene.render.camps.pick = () => null; // Only drawing/picking is stubbed; construction stays real.
    const ui = { scene, mySide: 'red', phase: 'battle', countdown: false,
        battleOptions: { net: false }, cancelHoldTargeting() {}, cancelRallyTargeting() {},
        showNetToast() {}, applyGroundOrder(world, callback) { callback(world.x, world.y); } };
    const controls = new CampControls(ui);
    return { scene, camps, site, worker, controls, panel };
}

function actionDisabled(panel, action) {
    const tag = panel.innerHTML.match(new RegExp(`<button data-camp-action="${action}"[^>]*>`));
    assert.ok(tag, `应展示 ${action} 操作`);
    return /\bdisabled\b/.test(tag[0]);
}

test('军费不足且无可续建营寨时，民夫筑寨按钮不可用', t => {
    const { scene, worker, controls, panel } = fixture(t);
    scene.territory.econ.treasury.red = CAMP_RULES.camp.cost - 1;
    controls.selectWorker(worker.id);
    assert.equal(actionDisabled(panel, 'camp'), true);
});

test('原民夫阵亡后，零军费仍能通过选点界面免费续建未完工营寨', t => {
    const { scene, camps, site, worker, controls, panel } = fixture(t);
    scene.territory.econ.treasury.red = CAMP_RULES.camp.cost;
    assert.equal(camps.requestBuild('red', worker.id, 'camp', site), true);
    const unfinished = camps.getBuilding(`camp:red:${site}`);
    worker.dead = true;
    const replacement = addUnit(scene, 'red', 'worker', unfinished.gx, unfinished.gy);
    controls.selectWorker(replacement.id);
    assert.equal(actionDisabled(panel, 'camp'), false, '续建不能被新建造价封锁');
    controls.begin('camp');
    const flag = scene.flags[site];
    assert.equal(controls.handleGroundClick({ x: flag.gx, y: flag.gy }, null), true);
    assert.equal(controls.targeting, null, '成功续建应结束选点');
    assert.equal(unfinished.workerId, replacement.id);
    assert.equal(replacement.workerTask.buildingId, unfinished.id);
    assert.equal(scene.territory.econ.treasury.red, 0);
    assert.equal(scene.territory.econ.spent.red, CAMP_RULES.camp.cost);
});

test('已被摧毁的营寨不能当免费续建，零军费时重建按钮不可用', t => {
    const { scene, camps, site, worker, controls, panel } = fixture(t);
    scene.territory.econ.treasury.red = CAMP_RULES.camp.cost;
    camps.requestBuild('red', worker.id, 'camp', site);
    const camp = camps.getBuilding(`camp:red:${site}`);
    const enemy = addUnit(scene, 'blue', 'infantry', camp.gx + 1, camp.gy);
    // 该据点若带桥头工事（本点建筑 −10% 伤害），刚好打出 hp 伤害已不足以拆掉它；
    // 这里按"必须摧毁"给足伤害，专门验证被摧毁后不能免费续建。
    camps.damageBuilding(camp, camp.hp * 2, enemy);
    assert.equal(camp.dead, true);
    controls.selectWorker(worker.id);
    assert.equal(actionDisabled(panel, 'camp'), true);
});

test('原施工者溃逃后，替代民夫也能零军费免费接续', t => {
    const { scene, camps, site, worker, controls, panel } = fixture(t);
    scene.territory.econ.treasury.red = CAMP_RULES.camp.cost;
    camps.requestBuild('red', worker.id, 'camp', site);
    worker.moraleState = 'routing';
    const unfinished = camps.getBuilding(`camp:red:${site}`);
    const replacement = addUnit(scene, 'red', 'worker', unfinished.gx, unfinished.gy);
    controls.selectWorker(replacement.id);
    assert.equal(actionDisabled(panel, 'camp'), false);
    controls.begin('camp');
    controls.handleGroundClick({ x: scene.flags[site].gx, y: scene.flags[site].gy }, null);
    assert.equal(unfinished.workerId, replacement.id);
    assert.equal(scene.territory.econ.treasury.red, 0);
    assert.equal(scene.territory.econ.spent.red, CAMP_RULES.camp.cost);
});

test('军费补足后，通过选点界面重建废墟会再次扣除一次造价', t => {
    const { scene, camps, site, worker, controls, panel } = fixture(t);
    scene.territory.econ.treasury.red = CAMP_RULES.camp.cost;
    camps.requestBuild('red', worker.id, 'camp', site);
    const old = camps.getBuilding(`camp:red:${site}`);
    const enemy = addUnit(scene, 'blue', 'infantry', old.gx + 1, old.gy);
    camps.damageBuilding(old, old.hp * 2, enemy);   // 桥头工事减伤后需超额伤害才能拆除
    assert.equal(old.dead, true);
    scene.territory.econ.treasury.red = CAMP_RULES.camp.cost;
    controls.selectWorker(worker.id);
    assert.equal(actionDisabled(panel, 'camp'), false);
    controls.begin('camp');
    const flag = scene.flags[site];
    controls.handleGroundClick({ x: flag.gx, y: flag.gy }, null);
    const rebuilt = camps.getBuilding(old.id);
    assert.notEqual(rebuilt, old);
    assert.equal(rebuilt.dead, false);
    assert.equal(rebuilt.progress, 0);
    assert.equal(rebuilt.workerId, worker.id);
    assert.equal(scene.territory.econ.treasury.red, 0);
    assert.equal(scene.territory.econ.spent.red, CAMP_RULES.camp.cost * 2);
});

// Review P2-3 复现：特色/归属/生效状态刚追加进 details，就被后续 details = state 覆盖。
// 修复后面板必须同时展示建筑状态与据点特色，且受益说明按"建筑归属 × 据点归属"讲真话。
function buildingPanelFixture(t) {
    const previousDocument = globalThis.document;
    t.after(() => { globalThis.document = previousDocument; });
    const panel = { hidden: true, innerHTML: '', addEventListener() {}, replaceChildren() {} };
    globalThis.document = { getElementById: () => panel,
        body: { classList: { add() {}, remove() {}, toggle() {} } } };
    const scene = makeScene();
    scene.deployUnits({}, {}, 'custom', 'custom', {}, { territory: true, territoryAI: false, terrain: 'territory' });
    scene.battleStarted = true;
    scene.render.camps.pick = () => null;
    const ui = { scene, mySide: 'red', phase: 'battle', countdown: false,
        battleOptions: { net: false }, cancelHoldTargeting() {}, cancelRallyTargeting() {},
        showNetToast() {}, applyGroundOrder(world, callback) { callback(world.x, world.y); } };
    const controls = new CampControls(ui);
    const open = building => { controls.buildingId = building.id; controls.update(); return panel.innerHTML; };
    return { scene, camps: scene.territory.camps, controls, panel, open };
}

test('建筑面板：状态与据点特色同屏，不再被覆盖', t => {
    const { scene, camps, open } = buildingPanelFixture(t);
    const forest = scene.flags.findIndex(f => f.role === 'forest');
    scene.flags[forest].owner = 'red';
    const camp = camps.createBuilding('red', 'camp', forest, true);
    const markup = open(camp);
    assert.match(markup, /生命 \d+\/\d+/, '建筑状态（生命）在面板里');
    assert.match(markup, /🌲林口/, '据点特色仍在面板里（修复前被 details = state 覆盖）');
    assert.match(markup, /营建加速/, '特色奖励文案保留');
    assert.match(markup, /红方拥有该点，奖励对此建筑生效/, '己方建筑 + 己方据点：受益说明');
});

test('建筑面板受益说明覆盖全部归属组合：己方/敌方/中立/失守旧建筑/大本营/全局', t => {
    const { scene, camps, open } = buildingPanelFixture(t);
    const forest = scene.flags.findIndex(f => f.role === 'forest');
    const ford = scene.flags.findIndex(f => f.role === 'ford');
    const fords = scene.flags.filter(f => f.role === 'ford');

    // 己方据点上的己方建筑。
    scene.flags[forest].owner = 'red';
    const mine = camps.createBuilding('red', 'camp', forest, true);
    assert.match(open(mine), /红方拥有该点，奖励对此建筑生效/);

    // 失守据点上的旧建筑：据点归蓝，红方旧营寨不能再自称受益。
    scene.flags[forest].owner = 'blue';
    assert.match(open(mine), /生命 \d+\/\d+.*🌲林口/, '状态与特色仍同屏');
    assert.match(open(mine), /据点已归蓝方，此建筑不再受益/, '旧建筑留在失守据点：说明不再受益');

    // 中立据点上的建筑（建成后据点被拉回中立）。
    scene.flags[forest].owner = null;
    assert.match(open(mine), /该点中立，占领后生效/);

    // 敌方建筑 + 敌方据点：说明奖励对蓝方生效，不用 viewer 视角含糊其辞。
    scene.flags[forest].owner = 'blue';
    const theirs = camps.createBuilding('blue', 'camp', forest, true);
    assert.match(open(theirs), /蓝方拥有该点，奖励对此建筑生效/);
    assert.match(open(theirs), /敌方 · /, '标题仍是敌方建筑');

    // 全局奖励（渡口）：红方失去本点但仍持有另一座渡口 → 说明仍生效。
    fords[0].owner = 'red'; fords[1].owner = 'red';
    const fordCamp = camps.createBuilding('red', 'camp', ford, true);
    assert.match(open(fordCamp), /🌊渡口/, '渡口特色上屏');
    fords[0].owner = null;                        // 本点失守（被拉过中线）
    assert.match(open(fordCamp), /红方仍拥有渡口，全局奖励生效中/, '丢一座仍持另一座：说明仍生效');
    fords[1].owner = 'blue'; fords[0].owner = 'blue';   // 两座皆失
    assert.match(open(fordCamp), /该点已归蓝方，红方无任何渡口，奖励未生效/, '两座皆失：说明未生效');

    // 大本营：没有旗位，任何特色都不上屏。
    const home = camps.getBuilding('camp:red:home');
    const homeMarkup = open(home);
    assert.doesNotMatch(homeMarkup, /林口|渡口|马场|桥头|路口|高地/, '大本营不显示据点特色');
    assert.match(homeMarkup, /生命 \d+\/\d+/, '大本营仍显示自身状态');
});

// ==================== 复审剩余问题（第二轮）：高地面板的奖励对象和条件 ====================
// 复现：高地建筑面板说"奖励对此建筑生效"——错误。高地特色实际作用于
// "高地归属方的、有明确驻守令且位于旗点 8 格内的营队成员"（士气损失 −10%），
// 与建筑无关；面板不得据此宣称附近营队已经满足条件。
test('高地面板：奖励对象是营队而非建筑，写明必要条件且不宣称已满足', t => {
    const { scene, camps, open } = buildingPanelFixture(t);
    const hill = scene.flags.findIndex(f => f.role === 'hill');

    // 己方高地上有己方建筑：写明受益对象（营队）与两个必要条件，不作用于建筑。
    scene.flags[hill].owner = 'red';
    const mine = camps.createBuilding('red', 'camp', hill, true);
    const markup = open(mine);
    assert.match(markup, /⛰️中央高地/, '高地特色上屏');
    assert.match(markup, /营队/, '受益对象是营队');
    assert.match(markup, /驻守令/, '必要条件之一：明确驻守令');
    assert.match(markup, /8 格内/, '必要条件之二：旗点 8 格内');
    assert.match(markup, /士气损失 −10%/, '效果数值来自特色表');
    assert.doesNotMatch(markup, /此建筑生效/, '不得再说"奖励对此建筑生效"');
    assert.doesNotMatch(markup, /已满足|已经满足/, '不得宣称附近营队已满足条件');
    assert.match(markup, /生命 \d+\/\d+/, '建筑自身状态保留');

    // 据点失守但旧建筑仍存在：说明减损跟着高地新主人走，本建筑无关。
    scene.flags[hill].owner = 'blue';
    const lost = open(mine);
    assert.match(lost, /高地已归蓝方/, '失守后说明高地的当前归属');
    assert.match(lost, /营队/, '受益对象仍是营队');
    assert.doesNotMatch(lost, /此建筑生效|此建筑不再受益/, '高地奖励与建筑无关，不用建筑口径表述');

    // 中立高地。
    scene.flags[hill].owner = null;
    assert.match(open(mine), /该点中立/, '中立高地说占领后生效');
    assert.match(open(mine), /营队/);

    // 敌方高地上有敌方建筑：客观说明奖励归蓝方营队。
    scene.flags[hill].owner = 'blue';
    const theirs = camps.createBuilding('blue', 'camp', hill, true);
    assert.match(open(theirs), /蓝方.*营队/);
    assert.doesNotMatch(open(theirs), /此建筑生效/);
});

test('面板按特色区分受益类别：建筑（林口/桥头）、营队（高地）、据点收容（路口）', t => {
    const { scene, camps, open } = buildingPanelFixture(t);
    const forest = scene.flags.findIndex(f => f.role === 'forest');
    const bridge = scene.flags.findIndex(f => f.role === 'bridge');
    const crossroad = scene.flags.findIndex(f => f.role === 'crossroad');
    for (const index of [forest, bridge, crossroad]) scene.flags[index].owner = 'red';
    const forestCamp = camps.createBuilding('red', 'camp', forest, true);
    assert.match(open(forestCamp), /此建筑的施工生效|奖励对此建筑生效/, '林口：作用于建筑（施工速度）');
    const bridgeCamp = camps.createBuilding('red', 'camp', bridge, true);
    assert.match(open(bridgeCamp), /此建筑生效|本点建筑/, '桥头：作用于本点建筑（减伤）');
    const crossCamp = camps.createBuilding('red', 'camp', crossroad, true);
    const crossMarkup = open(crossCamp);
    assert.match(crossMarkup, /收容/, '路口：作用于据点收容容量');
    assert.match(crossMarkup, /非建筑/, '路口明确说不是建筑属性');
    assert.doesNotMatch(crossMarkup, /此建筑生效/, '路口不再套用建筑口径');
});

test('自由选址箭塔：选中自己的民夫，点击陆地下令一次并退出选点', t => {
    const { scene, worker, controls } = fixture(t);
    controls.selectWorker(worker.id);
    controls.begin('tower');
    assert.equal(controls.targeting.worker, worker.id);
    const before = scene.territory.econ.treasury.red;
    controls.handleGroundClick({ x: worker.gx + 5, y: worker.gy + 5 }, null);
    const field = scene.territory.camps.buildings.find(b => b.siteId === null);
    assert.ok(field);
    assert.equal(field.workerId, worker.id);
    assert.equal(scene.territory.econ.treasury.red, before - CAMP_RULES.tower.cost);
    assert.equal(controls.targeting, null);
});

test('非法塔选址保留选点与原民夫，展示统一拒绝理由且不扣费', t => {
    const { scene, worker, controls } = fixture(t);
    const messages = [];controls.ui.showNetToast = message => messages.push(message);
    controls.selectWorker(worker.id);controls.begin('tower');
    const before = scene.territory.econ.treasury.red;
    controls.handleGroundClick({ x: -5, y: -5 }, null);
    assert.ok(controls.targeting);
    assert.equal(controls.targeting.worker, worker.id);
    assert.match(messages.at(-1), /陆地/);
    assert.equal(scene.territory.econ.treasury.red, before);
    controls.cancel();assert.equal(controls.targeting, null);
});

test('自由塔续建按建筑ID受理，零军费且原工人阵亡时不重复扣费', t => {
    const { scene, worker, controls } = fixture(t);
    const camps = scene.territory.camps;
    assert.equal(camps.requestBuildAt('red', worker.id, 'tower', worker.gx + 5, worker.gy + 5), true);
    const tower = camps.buildings.find(b => b.siteId === null);
    worker.dead = true;
    const replacement = addUnit(scene,'red','worker',tower.gx,tower.gy);
    scene.territory.econ.treasury.red = 0;
    scene.render.camps.pick = () => tower;
    controls.selectWorker(replacement.id);controls.begin('tower');
    controls.handleGroundClick({x:tower.gx,y:tower.gy},null);
    assert.equal(tower.workerId,replacement.id);
    assert.equal(scene.territory.econ.treasury.red,0);
    assert.equal(controls.targeting,null);
});

test('盟友民夫不能成为自己的施工者，选址取消不改变模拟状态', t => {
    const { scene, worker, controls } = fixture(t);
    const ally = addUnit(scene,'blue','worker',worker.gx+1,worker.gy);
    controls.selectWorker(ally.id);assert.equal(controls.workerId,null);
    controls.selectWorker(worker.id);controls.begin('tower');
    const before = scene.territory.camps.buildings.length;
    controls.cancel();
    assert.equal(scene.territory.camps.buildings.length,before);
    assert.ok(worker.workerTask == null);
});

test('塔选址预览复用统一判定：可建绿框、不可建红框及取消清除', t => {
    const { scene, worker, controls } = fixture(t);
    const colors=[], footprint=[];
    let cleared=0;
    const graphics={setDepth(){return this;},clear(){cleared++;},fillStyle(color){colors.push(color);},lineStyle(){},fillPoints(points){footprint.push(points);},strokePoints(){}};
    scene.add={graphics:()=>graphics};scene.input={activePointer:{x:500,y:300}};
    scene.scale={width:1280,height:720};scene.cameras={main:{getWorldPoint:()=>({x:0,y:0})}};
    scene.groundPoint=(gx,gy)=>({x:gx,y:gy});
    let point={gx:worker.gx+5,gy:worker.gy+5};
    controls.ui.groundOrderPoint=()=>point;
    controls.selectWorker(worker.id);controls.begin('tower');
    controls.updatePlacementPreview();
    assert.equal(colors.at(-1),0x8ae58a);assert.match(controls.targeting.prompt,/可建/);
    assert.ok(Math.abs(footprint.at(-1)[0].x-point.gx-CAMP_RULES.tower.radius)<1e-9);
    point={gx:-5,gy:-5};controls.updatePlacementPreview();
    assert.equal(colors.at(-1),0xff6b62);assert.match(controls.targeting.prompt,/陆地/);
    const before=cleared;controls.cancel();assert.ok(cleared>before);
});


test('暂停期间每帧刷新选址；reset不重复订阅，场景关闭解除监听', t => {
    const { scene, controls: original } = fixture(t);
    scene.events = new EventEmitter();scene.paused = true;
    const controls = new CampControls(original.ui);
    let refreshes = 0;controls.updatePlacementPreview = () => { refreshes++; };
    scene.events.emit('prerender');assert.equal(refreshes,1);
    for(let i=0;i<3;i++) controls.reset();
    assert.equal(scene.events.listenerCount('prerender'),1);
    scene.events.emit('prerender');assert.equal(refreshes,2);
    scene.events.emit('shutdown');assert.equal(scene.events.listenerCount('prerender'),0);
});
