import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit } from './battle-harness.js';
import { siteWeight } from '../js/battle/site-traits.js';
import { BATTALION } from '../js/battle/battalion.js';
import { applyCampCommand } from '../js/battle/camp-commands.js';
import { battleProjection } from '../js/net/lockstep.js';

function fixture(team = 'red') {
    const scene = makeScene();
    scene.deployUnits({ infantry: 9, archer: 3 }, { infantry: 9, archer: 3 }, 'custom', 'custom', {},
        { territory: true, territoryAI: false });
    scene.battleStarted = true;
    setScore(scene, team, 12);
    return scene;
}

function setScore(scene, team, score) {
    const flags = [...scene.flags].sort((a, b) => (team === 'red' ? a.gx - b.gx : b.gx - a.gx) || a.gy - b.gy);
    for (const flag of flags) {
        const weight = siteWeight(flag.role);
        flag.owner = weight <= score ? team : null;
        if (flag.owner) score -= weight;
        flag.progress = flag.owner === 'red' ? 1 : flag.owner === 'blue' ? -1 : 0;
    }
    assert.equal(score, 0);
    scene.siteTraits.refresh();
}

function assault(scene, team = 'red') {
    scene.battalions.aiAssign();
    assert.equal(scene.battalions.army[team].homeAssault, true);
    assert.equal(scene.battalions.army[team].target, null);
    scene.simulationTime += BATTALION.ARMY_STAGE_TIMEOUT_MS;
    scene.battalions.aiAssign();
    assert.equal(scene.battalions.army[team].phase, 'assault');
}

test('死斗：双方有兵且大本营健在，长期旗分占优不判胜', () => {
    const scene = fixture();
    for (let second = 0; second < 2400; second++) {
        scene.simulationTime += 1000;
        scene.updateTerritory(1);
        scene.checkWin();
    }
    assert.ok(scene.redAlive > 0 && scene.blueAlive > 0);
    assert.ok(['red', 'blue'].every(t => !scene.territory.camps.getBuilding(`camp:${t}:home`).dead));
    assert.equal(scene.battleOver, false);
});

test('死斗：双方仍有兵时攻破大本营即以 camp 结算', () => {
    const scene = fixture();
    const home = scene.territory.camps.getBuilding('camp:blue:home');
    const attacker = scene.units.find(u => u.team === 'red');
    scene.territory.camps.damageBuilding(home, home.hp, attacker);
    scene.checkWin();
    assert.ok(scene.redAlive > 0 && scene.blueAlive > 0);
    assert.equal(scene.battleOver, true);
    assert.equal(scene.winner, 'red');
    assert.equal(scene.endReason, 'camp');
});

test('死斗：12 分进入攻城，突击补发，9 分保持，低于 9 分或敌营已毁仅撤电脑令', () => {
    const scene = fixture();
    const sys = scene.battalions;
    assault(scene);
    const mine = scene.units.filter(u => u.team === 'red');
    assert.ok(mine.every(u => u.aiHomeOrder && u.orderBuildingId === 'camp:blue:home'));
    const projection = battleProjection(scene);
    mine[0].aiHomeOrder = false;
    assert.notEqual(battleProjection(scene), projection);
    mine[0].aiHomeOrder = true;
    sys.army.red.homeAssault = false;
    assert.notEqual(battleProjection(scene), projection);
    sys.army.red.homeAssault = true;
    const fresh = [];
    for (let i = 0; i < BATTALION.WAVE_SIZE; i++) {
        const u = addUnit(scene, 'red', 'infantry', 10, 60 + i);
        fresh.push(u); sys.assignReinforcement(u);
    }
    scene.simulationTime += BATTALION.AI_INTERVAL_MS;
    sys.update(scene.simulationTime);
    assert.ok(fresh.every(u => u.aiHomeOrder && u.orderBuildingId === 'camp:blue:home'));
    setScore(scene, 'red', 9);
    sys.aiAssign();
    assert.equal(sys.army.red.homeAssault, true);
    const player = mine[0];
    assert.equal(applyCampCommand(scene, { k: 'attack-building', side: 'red', units: [player.id], building: 'camp:blue:home' }), true);
    assert.equal(player.aiHomeOrder, false);
    setScore(scene, 'red', 8);
    sys.aiAssign();
    assert.equal(sys.army.red.homeAssault, false);
    assert.equal(player.orderBuildingId, 'camp:blue:home');
    assert.ok([...mine.slice(1), ...fresh].every(u => !u.aiHomeOrder && !u.orderBuildingId));
    setScore(scene, 'red', 12);
    assault(scene);
    scene.territory.camps.getBuilding('camp:blue:home').dead = true;
    sys.aiAssign();
    assert.equal(sys.army.red.homeAssault, false);
    assert.equal(player.orderBuildingId, 'camp:blue:home');
    assert.ok(mine.slice(1).every(u => !u.aiHomeOrder && !u.orderBuildingId));
});

test('死斗：保护玩家驻军与攻建筑令，回援撤电脑令，回池补发，接管撤电脑令', () => {
    const scene = fixture();
    const sys = scene.battalions, camps = scene.territory.camps;
    const archer = scene.units.find(u => u.team === 'red' && u.type === 'archer');
    const sword = scene.units.find(u => u.team === 'red' && u.type === 'infantry');
    assert.equal(applyCampCommand(scene, { k: 'garrison', side: 'red', units: [archer.id], building: 'tower:red:home' }), true);
    assert.equal(applyCampCommand(scene, { k: 'attack-building', side: 'red', units: [sword.id], building: 'tower:blue:home' }), true);
    assault(scene);
    assert.equal(archer.garrisonOrderId, 'tower:red:home');
    assert.equal(sword.orderBuildingId, 'tower:blue:home');
    assert.equal(archer.aiHomeOrder, false);
    assert.equal(sword.aiHomeOrder, false);
    const flag = scene.flags.find(f => f.owner === 'red');
    const enemy = scene.units.filter(u => u.team === 'blue' && u.type === 'infantry');
    enemy.forEach(u => { u.gx = flag.gx; u.gy = flag.gy; });
    scene.rebuildSpatial();
    sys.aiAssign();
    const responder = sys.battalions.find(b => b.team === 'red' && b.orderFlag === scene.flags.indexOf(flag));
    assert.ok(responder);
    assert.ok(responder.members.every(u => !u.aiHomeOrder));
    enemy.forEach(u => { u.gx = 245; u.gy = 150; });
    scene.rebuildSpatial();
    sys.aiAssign();
    assert.ok(responder.members.filter(u => !u.garrisonOrderId && u !== sword).every(u => u.aiHomeOrder));
    responder.playerOrdered = true;
    sys.aiAssign();
    assert.ok(responder.members.every(u => !u.aiHomeOrder));
    assert.ok(responder.members.every(u => u.orderBuildingId !== 'camp:blue:home'));
    assert.equal(sword.orderBuildingId, 'tower:blue:home');
    const marked = scene.units.find(u => u.aiHomeOrder && u.type === 'archer');
    assert.ok(marked);
    assert.equal(camps.orderGarrison('red', [marked.id], 'tower:red:home'), true);
    assert.equal(marked.aiHomeOrder, false);
});

test('死斗：寨墙守军不领电脑攻城令，攻城单位入驻后下一节拍撤令', () => {
    const scene = fixture();
    const sys = scene.battalions;
    const guard = scene.units.find(u => u.team === 'red' && u.type === 'infantry');
    guard.wallGuardId = 'camp:red:home';
    assault(scene);
    assert.ok(!guard.aiHomeOrder);
    assert.notEqual(guard.orderBuildingId, 'camp:blue:home');
    const attacker = scene.units.find(u => u.team === 'red' && u.aiHomeOrder);
    assert.ok(attacker);
    assert.equal(attacker.orderBuildingId, 'camp:blue:home');
    attacker.wallGuardId = 'camp:red:home';
    scene.simulationTime += BATTALION.AI_INTERVAL_MS;
    sys.update(scene.simulationTime);
    assert.equal(attacker.aiHomeOrder, false);
    assert.equal(attacker.orderBuildingId, null);
});

test('死斗：攻城进入、集合点、命令及退出在换座后东西镜像一致', () => {
    const play = team => {
        const scene = fixture(team), sys = scene.battalions;
        // 使用精确镜像的单位位置，隔离开局编队本身的布阵差异。
        const units = scene.units.filter(u => u.team === team);
        units.forEach((u, i) => { u.gx = team === 'red' ? 20 : 240; u.gy = 40 + i; });
        scene.rebuildSpatial();
        sys.aiAssign();
        const stage = sys.battalions.find(b => b.team === team).stagePoint;
        const normalizedStage = [Math.round((team === 'red' ? stage.gx : 260 - stage.gx) * 1e6), Math.round(stage.gy * 1e6)];
        assault(scene, team);
        const orders = units.map(u => [!!u.aiHomeOrder, u.orderBuildingId === `camp:${team === 'red' ? 'blue' : 'red'}:home`]);
        setScore(scene, team, 8);
        sys.aiAssign();
        return { normalizedStage, orders, target: sys.army[team].target == null ? null : scene.flags[sys.army[team].target].role,
            homeAssault: sys.army[team].homeAssault, cleared: units.every(u => !u.aiHomeOrder && !u.orderBuildingId) };
    };
    assert.deepEqual(play('red'), play('blue'));
});
