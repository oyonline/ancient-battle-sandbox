// 马场批次测试：骑兵征募门禁 / AI 三件套（停购·反制·夺场加权）/ 易主战报 / 布点镜像。
import test from 'node:test';
import assert from 'node:assert/strict';
import { territoryLayout } from '../js/territory-map.js';
import { RecruitSystem, TerritoryAI } from '../js/battle/recruit.js';
import { TerritoryEconomy, TicketSystem, TERRITORY } from '../js/battle/economy.js';
import { CampSystem } from '../js/battle/camps.js';
import { HealingSystem } from '../js/battle/healing.js';
import { BattalionSystem } from '../js/battle/battalion.js';
import { BattleSpatialIndex } from '../js/battle/spatial.js';
import { UNIT_TYPES } from '../js/units.js';
import { setBoardSize, resetBoardSize, board } from '../js/board.js';
import { updateFlags } from '../js/battle/territory-bridge.js';
import { makeTerritoryFlags } from '../js/battle/economy.js';

function fixture({ ai = false } = {}) {
    setBoardSize(TERRITORY.W, TERRITORY.H);
    const spatial = new BattleSpatialIndex();
    const scene = {
        units: [], _aliveArr: [], flags: makeTerritoryFlags(),
        battleOptions: { territory: true, terrain: 'flat' }, battleId: 1,
        simulationTime: 0, battleOver: false, planningStep: true,
        arrows: [], queue: [], events: [], controlScore: { red: 0, blue: 0 },
        _rallyAnchors: [], _rallyRefresh: -Infinity,
        territory: { econ: new TerritoryEconomy(), tickets: new TicketSystem(),
            rally: { red: null, blue: null }, autoBuy: { red: ai, blue: ai } },
        forEachNear(...args) { spatial.forEachNear(...args); },
        rebuildSpatial() { spatial.rebuild(this.units); this._aliveArr = spatial.alive; },
        aliveCount(team, type) { return this.units.filter(u => !u.dead && u.team === team && (!type || u.type === type)).length; },
        fireArrow(from, target) { this.arrows.push({ sourceId: from.id, target }); },
        playAttackAnim() {}, meleeImpact() {},
        scheduleBattleAction(delay, callback) { this.queue.push({ at: this.simulationTime + delay, callback }); },
        addBattleEvent(id, text, team) { this.events.push({ id, text, team }); },
        onMoraleStateChange() {}, recordDamage() {}, recordDeath() {}, killUnit() {},
        board_W() { return board.W - 8; }, board_H() { return board.H; }
    };
    scene.territory.recruit = new RecruitSystem(scene);
    scene.territory.camps = new CampSystem(scene);
    scene.territory.healing = new HealingSystem(scene);
    scene.spawnTerritoryUnit = (team, type) => add(scene, team, type, team === 'red' ? 7 : board.W - 7, board.H / 2);
    scene.battalions = new BattalionSystem(scene);
    return scene;
}

function add(s, team, type, gx, gy) {
    const u = { id: s.units.length + 1, team, type, typeData: UNIT_TYPES[type], gx, gy,
        hp: UNIT_TYPES[type].hp, maxHp: UNIT_TYPES[type].hp, scene: s, battleId: s.battleId,
        lastAttack: -UNIT_TYPES[type].atkSpeed, actionEpoch: 0, moving: false, moveX: 0, moveY: 0,
        pushX: 0, pushY: 0, moraleState: 'steady', morale: 100, moraleFacingX: team === 'red' ? 1 : -1 };
    s.units.push(u); s.rebuildSpatial();
    return u;
}

test('布点：两座马场对称中立，换座镜像成立', () => {
    const sites = territoryLayout(260, 180).sites;
    const ranches = sites.filter(s => s.role === 'ranch');
    assert.equal(ranches.length, 2);
    for (const ranch of ranches) {
        assert.equal(ranch.owner, null, '马场中立开局');
        assert.ok(ranch.name.includes('马场'));
    }
    const [west, east] = ranches;
    assert.ok(Math.abs(west.gx + east.gx - 260) < 1e-9, '东西马场 x 镜像');
    assert.equal(west.gy, east.gy, 'y 相同');
    resetBoardSize();
});

test('门禁：无马场不能征骑兵，占领即解锁，丢场不断已在队列', () => {
    const s = fixture(), recruit = s.territory.recruit;
    s.territory.econ.treasury.red = 1000;
    assert.equal(recruit.ownsRanch('red'), false);
    assert.equal(recruit.enqueue('red', 'cavalry'), false, '无马场拒绝');
    assert.equal(s.territory.econ.treasury.red, 1000, '拒绝不扣费');
    assert.equal(recruit.enqueue('red', 'infantry'), true, '其它兵种不受限');
    const ranch = s.flags.find(f => f.role === 'ranch');
    ranch.owner = 'red';
    assert.equal(recruit.enqueue('red', 'cavalry'), true, '占场解锁');
    ranch.owner = 'blue';
    assert.equal(recruit.enqueue('red', 'cavalry'), false, '丢场再关');
    assert.equal(recruit.queues.red.some(i => i.type === 'cavalry'), true, '已入队列不受影响');
    resetBoardSize();
});

test('AI 停购：无马场时战略 AI 永不买骑且不饿死其它兵种', () => {
    const s = fixture();
    s.territory.econ.treasury.red = 5000;
    const ai = new TerritoryAI(s, 'red');
    for (let i = 0; i < 10; i++) {
        s.simulationTime = i * 2000;
        ai.update(s.simulationTime);
        s.territory.recruit.update();
    }
    assert.ok(!s.territory.recruit.queues.red.some(i => i.type === 'cavalry'), '无马场不买骑');
    assert.ok(s.territory.recruit.spawned.red > 0, '其它兵种照常出（不饿死）');
    resetBoardSize();
});

test('AI 反制：敌方骑兵海触发枪兵主导配比', () => {
    const s = fixture();
    s.territory.econ.treasury.red = 5000;
    for (let i = 0; i < 14; i++) add(s, 'blue', 'cavalry', 200 + i, 60 + i);
    for (let i = 0; i < 8; i++) add(s, 'blue', 'infantry', 210, 70 + i);
    const ai = new TerritoryAI(s, 'red');
    ai.update(0);
    assert.equal(s.territory.recruit.queues.red[0].type, 'pikeman', '反骑阵首选枪兵');
    resetBoardSize();
});

test('AI 夺场：无马场的营优先争夺中立马场', () => {
    const s = fixture();
    const battalion = s.battalions.createBattalion('red', 'line');
    s.battalions.battalions.push(battalion);
    for (let i = 0; i < 10; i++) {
        const u = add(s, 'red', 'infantry', 40 + i * 0.5, 90);
        battalion.members.push(u); u.battalion = battalion;
    }
    battalion.refreshPace();
    s.battalions.aiAssign();
    const ranchIndex = s.flags.findIndex(f => f.role === 'ranch');
    assert.equal(battalion.orderFlag, ranchIndex, '没马场时营被派往马场（加分压过其它中立点）');
    resetBoardSize();
});

test('战报：马场易主播报骑兵开断源', () => {
    const s = fixture();
    const ranch = s.flags.find(f => f.role === 'ranch');
    ranch.progress = 1; ranch.owner = null;
    const squad = Array.from({ length: 12 }, (_, i) => add(s, 'red', 'infantry', ranch.gx - 1 + (i % 3) * 0.6, ranch.gy + Math.floor(i / 3) * 0.6));
    squad.forEach(u => { u.moraleState = 'steady'; });
    s.rebuildSpatial();
    for (let i = 0; i < 120; i++) { s.simulationTime += 1000 / 60; updateFlags(s, 1 / 60); }
    assert.equal(ranch.owner, 'red');
    assert.ok(s.events.some(e => e.text.includes('骑兵征募开启')), '马场易主弹骑源战报');
    resetBoardSize();
});
