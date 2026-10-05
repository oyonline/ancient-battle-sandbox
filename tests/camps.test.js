import test from 'node:test';
import assert from 'node:assert/strict';
import { CampSystem, CAMP_RULES } from '../js/battle/camps.js';
import { TerritoryEconomy, TERRITORY, BATTALION_POWER } from '../js/battle/economy.js';
import { RecruitSystem, TerritoryAI } from '../js/battle/recruit.js';
import { BattleSpatialIndex } from '../js/battle/spatial.js';
import { BattalionSystem } from '../js/battle/battalion.js';
import { UNIT_TYPES, applyDamage, generateArmyPositions } from '../js/units.js';
import { Terrain } from '../js/terrain.js';
import { CombatRules } from '../js/combat.js';
import { setBoardSize, resetBoardSize, board } from '../js/board.js';
import { updateFlags } from '../js/battle/territory-bridge.js';

function fixture({ ai = false, terrain = 'flat' } = {}) {
    setBoardSize(TERRITORY.W, TERRITORY.H);
    const spatial = new BattleSpatialIndex();
    const scene = {
        units: [], _aliveArr: [], flags: [
            { gx: 55, gy: 60, owner: 'red', progress: 1, name: '西路' },
            { gx: 205, gy: 60, owner: 'blue', progress: -1, name: '东路' },
            { gx: 130, gy: 90, owner: null, progress: 0, name: '中央' }
        ],
        battleOptions: { territory: true, terrain }, battleId: 1,
        simulationTime: 0, battleOver: false, planningStep: true,
        arrows: [], queue: [], events: [], controlScore: { red: 0, blue: 0 },
        territory: { econ: new TerritoryEconomy(), autoBuy: { red: ai, blue: ai } },
        forEachNear(...args) { spatial.forEachNear(...args); },
        rebuildSpatial() { spatial.rebuild(this.units); this._aliveArr = spatial.alive; },
        aliveCount(team, type) { return this.units.filter(u => !u.dead && u.team === team && (!type || u.type === type)).length; },
        fireArrow(from, target) { this.arrows.push({ sourceId: from.id, target, sourceHeight: from.garrisonHeight ?? 0, at: this.simulationTime }); },
        playAttackAnim() {}, meleeImpact() {},
        scheduleBattleAction(delay, callback) { this.queue.push({ at: this.simulationTime + delay, callback }); },
        addBattleEvent(id, text, team) { this.events.push({ id, text, team }); },
        recordDamage() {}, recordDeath() {}, killUnit() {},
        board_W() { return board.W - 8; }, board_H() { return board.H; }
    };
    scene.territory.recruit = new RecruitSystem(scene);
    scene.territory.camps = new CampSystem(scene);
    scene.spawnTerritoryUnit = (team, type) => add(scene, team, type, team === 'red' ? 7 : board.W - 7, board.H / 2);
    scene.battalions = new BattalionSystem(scene);
    return scene;
}

function add(s, team, type, gx, gy) {
    const u = { id: s.units.length + 1, team, type, typeData: UNIT_TYPES[type], gx, gy,
        hp: UNIT_TYPES[type].hp, maxHp: UNIT_TYPES[type].hp, scene: s, battleId: s.battleId,
        lastAttack: -UNIT_TYPES[type].atkSpeed, actionEpoch: 0, moving: false, moveX: 0, moveY: 0,
        pushX: 0, pushY: 0, moraleState: 'steady', moraleFacingX: team === 'red' ? 1 : -1 };
    s.units.push(u); s.rebuildSpatial();
    return u;
}

function run(s, seconds) {
    const dt = 1 / 60;
    for (let step = 0; step < Math.round(seconds * 60); step++) {
        s.simulationTime += dt * 1000;
        s.rebuildSpatial();
        for (const u of s.units) { u.moveX = 0; u.moveY = 0; u.pushX = 0; u.pushY = 0; }
        for (const u of s.units) if (!u.dead) s.territory.camps.updateUnit(u, s.simulationTime, dt);
        for (const u of s.units) { u.gx += u.moveX; u.gy += u.moveY; }
        const ready = s.queue.filter(a => a.at <= s.simulationTime + 1e-7);
        s.queue = s.queue.filter(a => a.at > s.simulationTime + 1e-7);
        for (const a of ready) a.callback();
        s.rebuildSpatial(); s.territory.camps.update(dt);
    }
}

test('民夫：仅领土可训练，有限自卫但不计营队配比，不改变军阵部署', () => {
    const s = fixture(), worker = add(s, 'red', 'worker', 7, 90);
    // 本轮起民夫拥有有限近战自卫（只还手贴身的敌人，见 tests/worker-defense.test.js）
    assert.equal(UNIT_TYPES.worker.atk, 12);
    assert.equal(UNIT_TYPES.worker.range, 0.9);
    assert.equal(UNIT_TYPES.worker.atkSpeed, 1400);
    assert.equal(UNIT_TYPES.worker.hp, 45);
    assert.equal(UNIT_TYPES.worker.def, 0);
    assert.equal(BATTALION_POWER.worker, 0, '民夫占领力仍为 0：不能占旗');
    assert.equal(s.territory.recruit.enqueue('red', 'worker'), true);
    assert.equal(s.territory.econ.treasury.red, TERRITORY.START_TREASURY - 18);
    s.battleOptions.territory = false;
    assert.equal(s.territory.recruit.enqueue('red', 'worker'), false);
    s.battalions.splitOpening([worker]);
    s.battalions.assignReinforcement(worker);
    assert.equal(s.battalions.battalions.length, 0);
    assert.deepEqual(generateArmyPositions('red', { infantry: 14, worker: 12 }, 'custom'), generateArmyPositions('red', { infantry: 14 }, 'custom'));
    s.battleOptions.territory = true;
    s.territory.recruit.queues.red = [];
    s.territory.econ.treasury.red = 1000;
    const ai = new TerritoryAI(s, 'red'); ai.update(0);
    assert.equal(s.territory.recruit.queues.red[0].type, 'infantry');
    resetBoardSize();
});

test('开局营寨与箭塔成对预建，空塔从不自行射击', () => {
    const s = fixture(), camps = s.territory.camps;
    assert.equal(camps.buildings.length, 4);
    for (const team of ['red', 'blue']) {
        assert.equal(camps.getBuilding(`camp:${team}:home`).hp, CAMP_RULES.HOME_HP);
        assert.equal(camps.getBuilding(`tower:${team}:home`).complete, true);
    }
    add(s, 'blue', 'infantry', 15, 86);
    run(s, 4);
    assert.equal(s.arrows.length, 0);
    assert.equal(camps.winner(), null);
});

test('施工：先扣军费，到位才推进；营寨与塔重复和越权均拒绝', () => {
    const s = fixture(), c = s.territory.camps, w = add(s, 'red', 'worker', 45, 63.5);
    s.territory.econ.treasury.red = 1000;
    assert.equal(c.requestBuild('blue', w.id, 'camp', 1), false);
    assert.equal(c.requestBuild('red', w.id, 'camp', 2), false);
    assert.equal(c.requestBuild('red', w.id, 'camp', 'home'), false);
    assert.equal(c.requestBuild('red', w.id, 'constructor', 0), false);
    s.territory.econ.treasury.red = CAMP_RULES.camp.cost - 0.01;
    assert.equal(c.requestBuild('red', w.id, 'camp', 0), false, '不足造价时不透支军费');
    s.territory.econ.treasury.red = 1000;
    assert.equal(c.requestBuild('red', w.id, 'camp', 0), true);
    const camp = c.getBuilding('camp:red:0');
    assert.equal(s.territory.econ.treasury.red, 840);
    run(s, 1);
    assert.equal(camp.progress, 0, '未到施工圈不可远程盖房');
    run(s, 22);
    assert.equal(camp.complete, true);
    assert.equal(c.requestBuild('red', w.id, 'camp', 0), false);
    assert.equal(c.requestBuild('red', w.id, 'tower', 0), true);
    run(s, 19);
    assert.equal(c.getBuilding('tower:red:0').complete, true);
    assert.equal(s.territory.econ.spent.red, CAMP_RULES.camp.cost + CAMP_RULES.tower.cost);
});

test('施工暂停：民夫阵亡可接续，失旗暂停，夺回后续建不重复扣钱', () => {
    const s = fixture(), c = s.territory.camps, p = c.placement('red', 'camp', 0);
    const w = add(s, 'red', 'worker', p.gx, p.gy);
    s.territory.econ.treasury.red = 500;
    c.requestBuild('red', w.id, 'camp', 0); run(s, 4);
    const b = c.getBuilding('camp:red:0'), progress = b.progress;
    w.dead = true; run(s, 2);
    assert.equal(b.progress, progress);
    const replacement = add(s, 'red', 'worker', p.gx, p.gy);
    assert.equal(c.requestBuild('red', replacement.id, 'camp', 0), true);
    assert.equal(s.territory.econ.treasury.red, 340);
    s.flags[0].owner = 'blue'; run(s, 2);
    assert.equal(b.progress, progress);
    s.flags[0].owner = 'red'; run(s, 15);
    assert.equal(b.complete, true);
});

test('驻守：容量预留不超额，真实弓手步行入塔后离开地面桶，按自身冷却射击', () => {
    const s = fixture(), c = s.territory.camps, tower = c.getBuilding('tower:red:home');
    const archers = Array.from({ length: 6 }, (_, i) => add(s, 'red', 'archer', tower.gx - 2, tower.gy + i * 0.8));
    assert.equal(c.orderGarrison('blue', archers.map(a => a.id), tower.id), false);
    assert.equal(c.orderGarrison('red', archers.map(a => a.id), tower.id), true);
    assert.equal(archers.filter(a => a.garrisonOrderId).length, 4);
    run(s, 3);
    assert.equal(tower.garrisonIds.length, 4);
    s.rebuildSpatial();
    const nearby = []; s.forEachNear(tower.gx, tower.gy, 0.5, u => nearby.push(u.id));
    assert.ok(tower.garrisonIds.every(id => !nearby.includes(id)));
    const enemy = add(s, 'blue', 'infantry', tower.gx + 12, tower.gy);
    const start = s.arrows.length; run(s, 4.3);
    const shots = s.arrows.slice(start).filter(a => a.target === enemy);
    assert.equal(shots.length, 12, '四名真实弓手每人开火三次');
    assert.ok(shots.every(a => a.sourceHeight === 82));
    for (const id of tower.garrisonIds) {
        const times = shots.filter(a => a.sourceId === id).map(a => a.at);
        assert.ok(times[1] - times[0] >= UNIT_TYPES.archer.atkSpeed - 0.05);
    }
});

test('旗易主不转移原箭塔；敌方必须摧毁营寨后才能新建', () => {
    const s = fixture(), c = s.territory.camps, p = c.placement('red', 'camp', 0);
    const w = add(s, 'red', 'worker', p.gx, p.gy);
    s.territory.econ.treasury.red = 1000; s.territory.econ.treasury.blue = 1000;
    c.requestBuild('red', w.id, 'camp', 0); run(s, 19);
    const b = c.getBuilding('camp:red:0');
    s.flags[0].owner = 'blue';
    const enemyWorker = add(s, 'blue', 'worker', 55, 60);
    assert.equal(c.requestBuild('blue', enemyWorker.id, 'camp', 0), false);
    assert.equal(b.team, 'red');
    c.damageBuilding(b, b.hp, add(s, 'blue', 'infantry', 55, 64));
    assert.equal(c.requestBuild('blue', enemyWorker.id, 'camp', 0), true);
});

test('出塔与毁塔：驻军回到可行走地面，民夫与驻军不占旗', () => {
    const s = fixture({ terrain: 'river_valley' }), c = s.territory.camps, tower = c.getBuilding('tower:red:home');
    const a = add(s, 'red', 'archer', tower.gx, tower.gy);
    c.orderGarrison('red', [a.id], tower.id); run(s, 0.1);
    assert.equal(a.garrisonTowerId, tower.id);
    const flag = s.flags[2]; a.gx = flag.gx; a.gy = flag.gy;
    const w = add(s, 'red', 'worker', flag.gx, flag.gy);
    s.rebuildSpatial(); updateFlags(s, 10);
    assert.equal(flag.progress, 0);
    assert.equal(c.ungarrison('blue', tower.id), false);
    assert.equal(c.ungarrison('red', tower.id), true);
    assert.equal(a.garrisonTowerId, null);
    assert.ok(Terrain.walkable('river_valley', a.gx, a.gy));
    a.gx = tower.gx; a.gy = tower.gy;
    c.orderGarrison('red', [a.id], tower.id); run(s, 0.1);
    const enemy = add(s, 'blue', 'infantry', 9, 86);
    assert.equal(applyDamage(tower, 9999, enemy), 1200);
    assert.equal(tower.dead, true);
    assert.equal(a.garrisonTowerId, null);
    assert.equal(a.garrisonHeight, 0);
    assert.ok(Terrain.walkable('river_valley', a.gx, a.gy));
    assert.equal(w.hp, UNIT_TYPES.worker.hp);
});

test('攻寨指令：真实行军和延迟出手，显式令保持目标，取消后自动攻寨交回自卫', () => {
    const s = fixture(), c = s.territory.camps, b = c.getBuilding('camp:blue:home');
    const u = add(s, 'red', 'infantry', b.gx - 7, b.gy);
    assert.equal(c.orderAttackBuilding('blue', [u.id], b.id), false);
    assert.equal(c.orderAttackBuilding('red', [u.id], b.id), true);
    run(s, 1);
    assert.equal(b.hp, CAMP_RULES.HOME_HP);
    assert.ok(u.gx > b.gx - 7);
    run(s, 2);
    assert.ok(b.hp < CAMP_RULES.HOME_HP);
    const foe = add(s, 'blue', 'infantry', u.gx + 0.8, u.gy);
    assert.equal(c.updateUnit(u, s.simulationTime, 1 / 60), true, '显式目标不被近敌自动覆盖');
    assert.equal(u.target, b);
    c.cancelUnitOrders('red', [u.id]);
    assert.equal(u.orderBuildingId, null);
    assert.equal(c.updateUnit(u, s.simulationTime, 1 / 60), false, '解除显式令后近敌使自动攻寨交回自卫');
    foe.dead = true;
});

test('大本营胜负与双毁平局；建筑不接受友军或旧战场的伤害', () => {
    const s = fixture(), c = s.territory.camps;
    const red = c.getBuilding('camp:red:home'), blue = c.getBuilding('camp:blue:home');
    const r = add(s, 'red', 'infantry', 15, 90), b = add(s, 'blue', 'infantry', 245, 90);
    assert.equal(c.damageBuilding(red, 100, r), 0);
    assert.equal(c.damageBuilding(red, 100, { ...b, battleId: 0 }), 0);
    c.damageBuilding(blue, blue.hp, r);
    assert.equal(c.winner(), 'red');
    c.damageBuilding(red, red.hp, b);
    assert.equal(c.winner(), 'draw');
    assert.doesNotThrow(() => JSON.stringify(c.projection()));
});

test('单机 AI 补民夫、建野寨和箭塔，并派真实弓手驻守', () => {
    const s = fixture({ ai: true }), c = s.territory.camps;
    s.territory.econ.treasury.red = 2000; s.territory.econ.treasury.blue = 2000;
    const p = c.placement('red', 'camp', 0);
    add(s, 'red', 'worker', p.gx, p.gy);
    const tower = c.getBuilding('tower:red:home');
    add(s, 'red', 'archer', tower.gx - 2, tower.gy);
    c.update(0);
    assert.ok(s.territory.recruit.queues.red.some(i => i.type === 'worker'));
    assert.ok(c.getBuilding('camp:red:0'));
    run(s, 40);
    assert.equal(c.getBuilding('camp:red:0').complete, true);
    assert.equal(c.getBuilding('tower:red:0').complete, true);
    assert.equal(tower.garrisonIds.length, 1);
});

test('镜像：两方施工进度、扣费、民夫行军与入塔决定相同', () => {
    const s = fixture(), c = s.territory.camps;
    s.territory.econ.treasury.red = 1000; s.territory.econ.treasury.blue = 1000;
    const r = add(s, 'red', 'worker', 43, 63.5), b = add(s, 'blue', 'worker', board.W - 43, 63.5);
    c.requestBuild('red', r.id, 'camp', 0); c.requestBuild('blue', b.id, 'camp', 1);
    run(s, 25);
    assert.ok(Math.abs(r.gx + b.gx - board.W) < 1e-8);
    assert.equal(r.gy, b.gy);
    assert.equal(c.getBuilding('camp:red:0').progress, c.getBuilding('camp:blue:1').progress);
    assert.equal(s.territory.econ.treasury.red, s.territory.econ.treasury.blue);
    assert.deepEqual(c.buildInfo('tower'), { cost: 120, buildMs: 14000, maxHp: 1200, capacity: 4 });
});

test('低收入 AI 留出建寨军费，不会被持续征兵花费饿死', () => {
    const s = fixture({ ai: true }), c = s.territory.camps;
    const p = c.placement('red', 'camp', 0);
    add(s, 'red', 'worker', p.gx, p.gy);
    add(s, 'red', 'worker', p.gx - 2, p.gy);
    for (let i = 0; i < 14; i++) add(s, 'red', 'infantry', 10, 90 + i * 0.8);
    const ai = new TerritoryAI(s, 'red');
    for (let second = 0; second < 40; second++) {
        s.territory.econ.tick(1, { red: 2, blue: 2 });
        run(s, 1);
        ai.update(s.simulationTime);
    }
    assert.ok(c.getBuilding('camp:red:0')?.complete, '150开局军费+13/秒，AI应攒钱并完成野寨');
    assert.ok(s.territory.recruit.queues.red.some(item => item.type !== 'worker'), '建造期间也能留下军队训练机会');
});

test('多塔 AI：四名弓手给两座塔各预留两名，后塔不能抢前塔进驻令', () => {
    const s = fixture(), c = s.territory.camps;
    s.flags[0].gx = 31; s.flags[0].gy = 90;
    c.createBuilding('red', 'camp', 0, true);
    const field = c.createBuilding('red', 'tower', 0, true), home = c.getBuilding('tower:red:home');
    const archers = Array.from({ length: 4 }, (_, i) => add(s, 'red', 'archer', 20, 90.5 + i * 0.8));
    c.ai('red');
    assert.equal(c.reserved(home), 2);
    assert.equal(c.reserved(field), 2);
    assert.equal(archers.filter(u => u.garrisonOrderId === home.id).length, 2);
    assert.equal(archers.filter(u => u.garrisonOrderId === field.id).length, 2);
    run(s, 8);
    assert.equal(home.garrisonIds.length, 2);
    assert.equal(field.garrisonIds.length, 2);
});

test('近战攻寨：友军挡线不得隔人砍寨，受阻后真实绕到合法出手位', () => {
    const s = fixture(), c = s.territory.camps, home = c.getBuilding('camp:blue:home');
    const attacker = add(s, 'red', 'infantry', 250.2, 93.5);
    add(s, 'red', 'worker', 251.4, 93.5); // 固定挡线，民夫不自行攻击主寨
    assert.equal(CombatRules.clearLane(s, attacker, home), false);
    c.orderAttackBuilding('red', [attacker.id], home.id);
    let hits = 0;
    const damage = c.damageBuilding.bind(c);
    c.damageBuilding = (b, amount, from) => {
        if (from === attacker) {
            assert.equal(CombatRules.clearLane(s, attacker, b), true, '每次落地伤害都必须有合法剑线');
            hits++;
        }
        return damage(b, amount, from);
    };
    run(s, 0.12);
    assert.equal(home.hp, CAMP_RULES.HOME_HP, '原缺陷95ms会隔友军造成6点伤害');
    assert.ok(attacker.moving, '受阻需走位，不能永久罚站');
    run(s, 2);
    assert.ok(hits > 0);
    assert.ok(home.hp < CAMP_RULES.HOME_HP);
});

test('近战攻寨落地复验：出手后友军进入攻击线，95ms伤害取消', () => {
    const s = fixture(), c = s.territory.camps, home = c.getBuilding('camp:blue:home');
    const attacker = add(s, 'red', 'infantry', 250.2, 93.5);
    c.orderAttackBuilding('red', [attacker.id], home.id);
    s.simulationTime = 1000;
    c.updateUnit(attacker, s.simulationTime, 1 / 60);
    assert.equal(s.queue.length, 1, '敏感性对照：无挡线时正常出手');
    add(s, 'red', 'worker', 251.4, 93.5);
    assert.equal(CombatRules.clearLane(s, attacker, home), false);
    s.simulationTime = 1095;
    s.queue[0].callback();
    assert.equal(home.hp, CAMP_RULES.HOME_HP);
});
