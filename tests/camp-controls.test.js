import test from 'node:test';
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
    camps.damageBuilding(camp, camp.hp, enemy);
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
    camps.damageBuilding(old, old.hp, enemy);
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
