import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit } from './battle-harness.js';
import { TERRITORY } from '../js/battle/economy.js';
import { battleProjection, SIM_VERSION } from '../js/net/lockstep.js';

const STEP = 1000 / 60;
function territoryScene(options = {}, opening = {}) {
    const scene = makeScene();
    scene.deployUnits({ ...opening }, { ...opening }, 'custom', 'custom', {},
        { territory: true, territoryAI: false, terrain: 'territory', ...options });
    scene.battleStarted = true;
    return scene;
}
function advance(scene, seconds, inspect = () => {}) {
    for (let frame = 0; frame < Math.round(seconds * 60) && !scene.battleOver; frame++) {
        scene.advanceBattle(STEP);
        inspect();
    }
}

test('A1：双方开局60木，单林口60秒到300，易主下一拍改为每秒1/7', () => {
    const scene = territoryScene();
    const econ = scene.territory.econ;
    assert.equal(econ.wood.red, 60);
    assert.equal(econ.wood.blue, 60);
    assert.deepEqual(scene.territory.autoBuy, { red: false, blue: false });
    advance(scene, 60);
    for (const team of ['red', 'blue']) assert.ok(Math.abs(econ.wood[team] - 300) < 1e-7);
    const forest = scene.flags.find(f => f.role === 'forest' && f.owner === 'red');
    forest.owner = 'blue'; forest.progress = -1;
    const before = { ...econ.wood };
    advance(scene, 1 / 60);
    assert.ok(Math.abs(econ.wood.red - before.red - 1 / 60) < 1e-7);
    assert.ok(Math.abs(econ.wood.blue - before.blue - 7 / 60) < 1e-7);
});

test('A1：林口收入与军费一样按sameSide共享当前归属', () => {
    const scene = territoryScene();
    scene.relationGroups = [['red', 'blue'], ['black']];
    for (const flag of scene.flags) if (flag.owner) flag.progress = 1;
    const before = { ...scene.territory.econ.wood };
    advance(scene, 1 / 60);
    for (const team of ['red', 'blue']) {
        assert.ok(Math.abs(scene.territory.econ.wood[team] - before[team] - 7 / 60) < 1e-7);
    }
});

for (const [kind, price, field] of [['camp', 80, false], ['tower', 60, false], ['tent', 70, false], ['tower', 60, true]]) {
    test(`A2：${field ? '野外' : '据点'}${kind}扣${price}木，差1拒绝，续建免费且军费不变`, () => {
        const scene = territoryScene({ terrain: 'flat' });
        const camps = scene.territory.camps, econ = scene.territory.econ;
        const site = scene.flags.findIndex(f => f.owner === 'red');
        if (kind === 'tent') camps.createBuilding('red', 'camp', site, true);
        const point = field ? { gx: 35, gy: 25 } : camps.placement('red', kind, site);
        const worker = addUnit(scene, 'red', 'worker', point.gx, point.gy);
        const request = (id = null) => field
            ? camps.requestBuildAt('red', worker.id, kind, point.gx, point.gy, id)
            : camps.requestBuild('red', worker.id, kind, site);
        econ.wood.red = price - 1;
        const treasury = econ.treasury.red, spent = econ.spent.red;
        assert.equal(request(), false);
        assert.equal(econ.wood.red, price - 1);
        assert.equal(econ.treasury.red, treasury);
        econ.wood.red = price;
        assert.equal(request(), true);
        assert.equal(econ.wood.red, 0);
        assert.equal(econ.treasury.red, treasury);
        assert.equal(econ.spent.red, spent);
        const building = field ? camps.buildings.at(-1) : camps.getBuilding(camps.id('red', kind, site));
        assert.equal(building.complete, false);
        camps.releaseWorker(worker);
        assert.equal(request(building.id), true);
        assert.equal(econ.wood.red, 0);
        assert.equal(econ.treasury.red, treasury);
    });
}

test('A3：合作建筑仍扣160/120/140军费，无木料收入，木料不影响合作投影', () => {
    const scene = territoryScene({ coop: true, black: {}, terrain: 'flat' });
    scene.territory.autoBuy.black = false;
    const camps = scene.territory.camps, econ = scene.territory.econ;
    const site = scene.flags.findIndex(f => f.owner === 'red');
    const worker = addUnit(scene, 'red', 'worker', 65, 40);
    econ.treasury.red = 1000;
    econ.wood.red = 0;
    for (const [kind, cost] of [['camp', 160], ['tower', 120], ['tent', 140]]) {
        const before = econ.treasury.red;
        assert.equal(camps.requestBuild('red', worker.id, kind, site), true);
        assert.equal(econ.treasury.red, before - cost);
        assert.equal(econ.wood.red, 0);
        const building = camps.getBuilding(camps.id('red', kind, site));
        camps.releaseWorker(worker);
        building.complete = true; building.progress = 1;
    }
    const wood = { ...econ.wood };
    advance(scene, 1);
    assert.deepEqual(econ.wood, wood);
    const projection = battleProjection(scene);
    econ.wood.red += 50; econ.wood.blue += 50; econ.wood.black += 50;
    assert.equal(battleProjection(scene), projection);
});

test('A4a：真实双电脑领土局300秒内每方新建成建筑，全程木料非负且军费预留恒0', () => {
    const scene = territoryScene({ territoryAI: true }, TERRITORY.OPENING);
    const initial = new Set(scene.territory.camps.buildings.map(b => b.id));
    const completed = new Set();
    advance(scene, 300, () => {
        for (const team of ['red', 'blue']) {
            assert.ok(scene.territory.econ.wood[team] >= 0);
            assert.equal(scene.territory.camps.aiSavingsBudget(team), 0);
        }
        for (const b of scene.territory.camps.buildings) {
            if (!initial.has(b.id) && b.complete) completed.add(b.team);
        }
    });
    assert.ok(completed.has('red'), '红方应新建成至少1座建筑');
    assert.ok(completed.has('blue'), '蓝方应新建成至少1座建筑');
});

test('A4b：零木失林口仍征兵，每秒保底1木，120秒内电脑新开工', () => {
    const scene = territoryScene({ territoryAI: true }, { worker: 2 });
    scene.territory.autoBuy.blue = false;
    const econ = scene.territory.econ, camps = scene.territory.camps;
    const forest = scene.flags.find(f => f.role === 'forest' && f.owner === 'red');
    forest.owner = 'blue'; forest.progress = -1;
    econ.wood.red = 0;
    econ.treasury.red = 10000;
    assert.ok(scene.units.some(u => u.team === 'red' && u.type === 'worker' && !u.dead));
    assert.ok(scene.flags.some((f, i) => f.owner === 'red' && camps.placement('red', 'camp', i)));
    const spawned = scene.territory.recruit.spawned.red;
    const initial = new Set(camps.buildings.map(b => b.id));
    advance(scene, 60, () => assert.ok(econ.wood.red >= 0));
    assert.ok(scene.territory.recruit.spawned.red > spawned, '零木时仍照常征兵');
    assert.ok(Math.abs(econ.wood.red - 60) < 1e-7, `失林口60秒木料应为60，实为${econ.wood.red}`);
    advance(scene, 60, () => assert.ok(econ.wood.red >= 0));
    assert.ok(camps.buildings.some(b => b.team === 'red' && !initial.has(b.id)), '120秒内应新开工建筑');
});

test('A5：木料版本正确，非合作领土投影覆盖双方木料', () => {
    assert.equal(SIM_VERSION, '2026-11-15-wood');
    const scene = territoryScene();
    assert.match(battleProjection(scene), /,wood,60000,60000,/);
    for (const team of ['red', 'blue']) {
        const before = battleProjection(scene);
        scene.territory.econ.wood[team] += 1;
        assert.notEqual(battleProjection(scene), before, `${team}木料必须参与校验`);
    }
});
