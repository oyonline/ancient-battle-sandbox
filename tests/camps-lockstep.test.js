import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit, Terrain } from './battle-harness.js';
import { CAMP_RULES } from '../js/battle/camps.js';
import { NetBattle, battleProjection, hashProjection, LOCKSTEP } from '../js/net/lockstep.js';

const STEP = 1000 / 60;

function sceneFor(side) {
    const scene = makeScene();
    scene.deployUnits({}, {}, 'custom', 'custom', {}, {
        territory: true, terrain: 'flat', territoryAI: false, net: true, mySide: side
    });
    scene.battleStarted = true;
    scene.territory.econ.treasury.red = 1000;
    scene.territory.econ.treasury.blue = 1000;
    return scene;
}

function hash(scene) { return hashProjection(battleProjection(scene)); }

function scenario(side) {
    const scene = sceneFor(side), camps = scene.territory.camps;
    const site = scene.flags.findIndex(flag => flag.owner === 'red');
    const campSpot = camps.placement('red', 'camp', site);
    const towerSpot = camps.placement('red', 'tower', site);
    const campWorker = addUnit(scene, 'red', 'worker', campSpot.gx, campSpot.gy);
    const towerWorker = addUnit(scene, 'red', 'worker', towerSpot.gx, towerSpot.gy);
    const homeTower = camps.getBuilding('tower:red:home');
    const archers = Array.from({ length: 4 }, (_, i) => addUnit(scene, 'red', 'archer',
        homeTower.gx - 0.6, homeTower.gy + (i - 1.5) * 0.4));
    // A real idle enemy worker stays in the tower's range. Extra HP permits the
    // construction clock to finish without eliminating the arrow target first.
    const arrowTarget = addUnit(scene, 'blue', 'worker', homeTower.gx + 12, homeTower.gy);
    arrowTarget.hp = arrowTarget.maxHp = 5000;
    const blueCamp = camps.getBuilding('camp:blue:home');
    const movingWorker = addUnit(scene, 'blue', 'worker', blueCamp.gx, blueCamp.gy + 10);
    const attacker = addUnit(scene, 'red', 'infantry', blueCamp.gx - 8, blueCamp.gy + 5);
    return { scene, site, campWorker, towerWorker, homeTower, archers, arrowTarget,
        movingWorker, attacker, targetTower: camps.getBuilding('tower:blue:home') };
}

test('营寨指令经真实双端命令泵执行，施工、驻守射击与攻塔全程逐位一致', () => {
    const a = scenario('red'), b = scenario('blue');
    const scenes = [a.scene, b.scene];
    const deliver = packet => { for (const scene of scenes) scene.net.handle(packet); };
    for (const scene of scenes) scene.net = new NetBattle(scene, { send: deliver });
    for (const scene of scenes) scene.net.start();
    const accepted = scenes.map(() => []);
    const exitTurn = 480, towerTurn = 1140;
    let checkpoints = 0, sawFourCrew = false, sawArrowDamage = false, sawExit = false;
    const workerStart = { gx: a.movingWorker.gx, gy: a.movingWorker.gy };
    const destination = { gx: workerStart.gx - 4, gy: workerStart.gy };
    for (let turn = 0; turn < 60 * 35; turn++) {
        if (turn === 0) {
            a.scene.net.lockstep.act({ k: 'build', side: 'red', worker: a.campWorker.id, kind: 'camp', site: a.site });
            a.scene.net.lockstep.act({ k: 'garrison', side: 'red', units: a.archers.map(u => u.id), building: a.homeTower.id });
            b.scene.net.lockstep.act({ k: 'worker-move', side: 'blue', worker: a.movingWorker.id, ...destination });
        }
        if (turn === 100) a.scene.net.lockstep.act({ k: 'attack-building', side: 'red',
            units: [a.attacker.id], building: a.targetTower.id });
        if (turn === exitTurn) a.scene.net.lockstep.act({ k: 'ungarrison', side: 'red', building: a.homeTower.id });
        if (turn === towerTurn) a.scene.net.lockstep.act({ k: 'build', side: 'red',
            worker: a.towerWorker.id, kind: 'tower', site: a.site });
        for (let index = 0; index < scenes.length; index++) {
            const scene = scenes[index];
            assert.equal(scene.battleOver, false, `第 ${turn} 回合不能提前终局`);
            assert.ok(scene.net.lockstep.canStep(), `第 ${turn} 回合缺少锁步包`);
            for (const command of scene.net.lockstep.takeCommands()) {
                accepted[index].push([command.k, scene.applyNetCommand(command)]);
            }
            scene.simulationTime += STEP;
            scene.stepBattle(STEP / 1000);
            scene.net.onTurnDone();
        }
        if (turn < exitTurn && a.homeTower.garrisonIds.length === CAMP_RULES.CAPACITY) sawFourCrew = true;
        if (turn < exitTurn && a.arrowTarget.hp < a.arrowTarget.maxHp) sawArrowDamage = true;
        if (turn === exitTurn + LOCKSTEP.LOOKAHEAD + 5) {
            sawExit = a.homeTower.garrisonIds.length === 0 && a.archers.every(u =>
                !u.garrisonTowerId && u.garrisonHeight === 0 && Terrain.walkable('flat', u.gx, u.gy));
        }
        if (turn > 0 && turn % LOCKSTEP.HASH_EVERY === 0) {
            checkpoints++;
            assert.equal(battleProjection(a.scene), battleProjection(b.scene), `第 ${turn} 回合投影必须逐位一致`);
        }
    }
    assert.deepEqual(accepted[0], accepted[1]);
    assert.equal(accepted[0].length, 6);
    assert.ok(accepted[0].every(([, result]) => result === true), '不能以两端都拒绝指令伪造一致');
    assert.ok(sawFourCrew && sawArrowDamage && sawExit, '四名真实射手应进塔、命中地面目标并安全出塔');
    assert.ok(a.targetTower.hp < CAMP_RULES.tower.hp, '指定敌方箭塔必须实际受损');
    assert.equal(a.attacker.orderBuildingId, a.targetTower.id);
    assert.ok(Math.hypot(a.movingWorker.gx - destination.gx, a.movingWorker.gy - destination.gy) <= 0.3,
        '蓝方民夫移动命令必须走到目标处');
    assert.equal(a.scene.territory.camps.getBuilding(`camp:red:${a.site}`).complete, true);
    assert.equal(a.scene.territory.camps.getBuilding(`tower:red:${a.site}`).complete, true);
    assert.equal(a.scene.territory.econ.spent.red, CAMP_RULES.camp.cost + CAMP_RULES.tower.cost,
        '两阶段施工各扣一次军费');
    assert.ok(checkpoints >= 16);
    assert.equal(a.scene.net.desynced, false);
    assert.equal(b.scene.net.desynced, false);
    assert.equal(hash(a.scene), hash(b.scene));
});

const mutations = {
    '建筑血量': scene => { scene.territory.camps.buildings[0].hp -= 1; },
    '建筑施工进度': scene => { scene.territory.camps.buildings[0].progress -= 0.01; },
    '箭塔驻军名单': scene => { scene.territory.camps.getBuilding('tower:red:home').garrisonIds.push(1); },
    '民夫施工任务': scene => { scene.units[0].workerTask = { kind: 'build', buildingId: 'camp:red:0' }; },
    '弓手驻塔命令': scene => { scene.units[0].garrisonOrderId = 'tower:red:home'; },
    '单位攻寨命令': scene => { scene.units[0].orderBuildingId = 'camp:blue:home'; },
    '训练队列内容': scene => { scene.territory.recruit.queues.red[0].type = 'archer'; },
    '集结旗位置': scene => { scene.territory.rally.red.gx += 1; },
    '在途箭矢目标建筑': scene => { scene.arrows[0].buildingId = 'tower:blue:home'; },
    '在途箭矢发射高度': scene => { scene.arrows[0].sourceHeight += 1; },
    '在途箭矢落点高度': scene => { scene.arrows[0].targetHeight += 1; }
};

for (const [name, mutate] of Object.entries(mutations)) {
    test(`营寨锁步哈希覆盖${name}变化`, () => {
        const scene = sceneFor('red');
        const worker = addUnit(scene, 'red', 'worker', 10, 90);
        scene.territory.recruit.queues.red.push({ type: 'worker', remaining: 1000 });
        scene.territory.rally.red = { gx: 20, gy: 90 };
        scene.arrows.push({ sx: 10, sy: 90, tx: 18, ty: 90, t: 0.1, dur: 0.75,
            dmg: 10, team: 'red', source: worker, firedAt: 0,
            buildingId: 'camp:blue:home', sourceHeight: 2, targetHeight: 0 });
        const before = hash(scene);
        mutate(scene);
        assert.notEqual(hash(scene), before);
    });
}

test('营寨锁步哈希不受本地渲染边界和箭矢屏幕偏移影响', () => {
    const scene = sceneFor('red');
    const source = addUnit(scene, 'red', 'archer', 10, 90);
    scene.arrows.push({ sx: 10, sy: 90, tx: 18, ty: 90, t: 0.1, dur: 0.75,
        dmg: 10, team: 'red', source, firedAt: 0, sourceHeight: 2, targetHeight: 0 });
    const before = hash(scene);
    scene.territory.camps.buildings[0].renderBounds = { x: 999, y: 123, width: 80, height: 100 };
    scene.units[0].stancePose = { frame: 3, offsetY: 99 };
    scene.arrows[0].sourceOffsetX = 100;
    scene.arrows[0].sourceOffsetY = 20;
    assert.equal(hash(scene), before);
});
