// 医疗批次测试：溃兵收容循环（v0）+ 医帐/医师（v1）。
// 风格沿用 camps.test.js：轻量 fixture 直接驱动模拟层；士气门闩用 morale-flow 的轻量士气夹具。
import test from 'node:test';
import assert from 'node:assert/strict';
import { HealingSystem, HEALING_RULES, updateMedic } from '../js/battle/healing.js';
import { CampSystem, CAMP_RULES } from '../js/battle/camps.js';
import { TerritoryEconomy, TicketSystem, TERRITORY } from '../js/battle/economy.js';
import { RecruitSystem, TerritoryAI } from '../js/battle/recruit.js';
import { BattleSpatialIndex } from '../js/battle/spatial.js';
import { BattalionSystem } from '../js/battle/battalion.js';
import { UNIT_TYPES } from '../js/units.js';
import { setBoardSize, resetBoardSize, board } from '../js/board.js';
import { updateRoutedUnit } from '../js/battle/morale-bridge.js';
import { updateFlags } from '../js/battle/territory-bridge.js';
import { battleProjection } from '../js/net/lockstep.js';
import * as targeting from '../js/battle/targeting.js';
import { MoraleSystem } from '../js/morale.js';

function fixture({ ai = false } = {}) {
    setBoardSize(TERRITORY.W, TERRITORY.H);
    const spatial = new BattleSpatialIndex();
    const scene = {
        units: [], _aliveArr: [], flags: [
            { gx: 55, gy: 60, owner: 'red', progress: 1, name: '西路' },
            { gx: 205, gy: 60, owner: 'blue', progress: -1, name: '东路' },
            { gx: 130, gy: 90, owner: null, progress: 0, name: '中央' }
        ],
        battleOptions: { territory: true, terrain: 'flat' }, battleId: 1,
        simulationTime: 0, battleOver: false, planningStep: true,
        arrows: [], queue: [], events: [], controlScore: { red: 0, blue: 0 },
        _rallyAnchors: [], _rallyRefresh: -Infinity,
        territory: { econ: new TerritoryEconomy(), tickets: new TicketSystem(),
            rally: { red: null, blue: null }, autoBuy: { red: ai, blue: ai } },
        forEachNear(...args) { spatial.forEachNear(...args); },
        nearestEnemy(unit) { return targeting.nearestEnemy(spatial, unit); },
        rebuildSpatial() { spatial.rebuild(this.units); this._aliveArr = spatial.alive; },
        aliveCount(team, type) { return this.units.filter(u => !u.dead && u.team === team && (!type || u.type === type)).length; },
        fireArrow(from, target) { this.arrows.push({ sourceId: from.id, target }); },
        playAttackAnim() {}, meleeImpact() {},
        scheduleBattleAction(delay, callback) { this.queue.push({ at: this.simulationTime + delay, callback }); },
        addBattleEvent(id, text, team) { this.events.push({ id, text, team }); },
        onMoraleStateChange(unit, previous) { this.events.push({ id: `morale-${unit.id}-${previous}`, text: unit.moraleReason }); },
        recordDamage() {}, recordDeath() {}, killUnit() {},
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

function rout(u, hp) {
    u.moraleState = 'routing'; u.morale = 15; u.routStartedAt = 0;
    if (hp != null) u.hp = hp;
    return u;
}

function run(s, seconds) {
    const dt = 1 / 60;
    for (let step = 0; step < Math.round(seconds * 60); step++) {
        s.simulationTime += dt * 1000;
        s.rebuildSpatial();
        for (const u of s.units) { u.moveX = 0; u.moveY = 0; u.pushX = 0; u.pushY = 0; }
        for (const u of s.units) {
            if (u.dead || u.withdrawn) continue;
            if (s.territory.camps.updateUnit(u, s.simulationTime, dt)) continue;
            if (u.moraleState === 'routing') updateRoutedUnit(s, u, dt);
        }
        for (const u of s.units) { u.gx += u.moveX; u.gy += u.moveY; }
        const ready = s.queue.filter(a => a.at <= s.simulationTime + 1e-7);
        s.queue = s.queue.filter(a => a.at > s.simulationTime + 1e-7);
        for (const a of ready) a.callback();
        s.rebuildSpatial(); s.territory.camps.update(dt); s.territory.healing.update(dt);
    }
}

test('溃兵收容全流程：奔最近己方据点→疗伤回满→伤愈归队', () => {
    const s = fixture(), u = rout(add(s, 'red', 'infantry', 56, 60.5), 30);
    run(s, 0.2);
    assert.equal(u.healSiteId, 0, '最近己方据点是西路旗');
    assert.equal(u.healingAt, 0, '到点入住开始疗伤');
    run(s, 5);
    assert.equal(u.moraleState, 'routing', '疗伤期间保持溃逃态：不战斗不占旗');
    assert.equal(u.healingAt, 0);
    assert.ok(u.hp > 30 && u.hp < 100, `按损血比例恢复中（5秒约${u.hp - 30}/70）`);
    run(s, 12);
    assert.equal(u.moraleState, 'steady', 'HP 回满转 steady 归队');
    assert.equal(u.hp, u.maxHp);
    assert.equal(u.morale, 100);
    assert.ok(s.events.some(e => e.text.includes('伤愈归队')), '战报记录伤愈归队');
    assert.ok(s.events.some(e => e.text.includes('疗伤')), '战报记录入点疗伤');
    resetBoardSize();
});

test('疗伤基准速度：满损约 20 秒回满（100 血损 70 ≈ 14 秒）', () => {
    const s = fixture(), u = rout(add(s, 'red', 'infantry', 56, 60.5), 30);
    run(s, 0.05);
    const before = u.hp;
    run(s, 1);
    assert.ok(Math.abs(u.hp - before - 5) < 0.2, `基速 5 HP/秒（实测 ${u.hp - before}）`);
    resetBoardSize();
});

test('容量基线 8：满员后改投次近己方据点', () => {
    const s = fixture();
    const squad = Array.from({ length: 9 }, (_, i) => rout(add(s, 'red', 'infantry', 55 + (i % 3) * 0.5, 60 + Math.floor(i / 3) * 0.5), 40));
    run(s, 1.2);
    assert.equal(s.territory.healing.healingCount('red', 0), 8, '西路旗满员 8 人');
    const bounced = squad.find(u => u.healingAt == null);
    assert.ok(bounced, '第九人未挤进满员据点');
    assert.equal(bounced.healSiteId, 'home', '改投大本营');
    resetBoardSize();
});

test('据点失守：疗伤立即中断，溃兵改投其它己方据点', () => {
    const s = fixture(), u = rout(add(s, 'red', 'infantry', 56, 60.5), 30);
    run(s, 0.2);
    assert.equal(u.healingAt, 0);
    s.flags[0].owner = 'blue';
    run(s, 0.8);
    assert.equal(u.healingAt, null, '失守据点不再提供疗伤');
    assert.equal(u.moraleState, 'routing', '重新溃逃（毁塔释放驻军同义）');
    assert.equal(u.healSiteId, 'home', '下一拍改投大本营');
    resetBoardSize();
});

test('医帐：需先有完工营寨，费率 140/15s，容量扩到 16、速度 2.2 倍', () => {
    const s = fixture(), c = s.territory.camps, h = s.territory.healing;
    const w = add(s, 'red', 'worker', 55, 63.5);
    s.territory.econ.treasury.red = 1000;
    assert.deepEqual(c.buildInfo('tent'), { cost: 140, buildMs: 15000, maxHp: 550, capacity: HEALING_RULES.TENT_MEDIC_SLOTS });
    assert.equal(c.requestBuild('red', w.id, 'tent', 0), false, '无营寨不可建医帐');
    c.createBuilding('red', 'camp', 0, true);
    assert.equal(c.requestBuild('red', w.id, 'tent', 0), true);
    assert.equal(s.territory.econ.treasury.red, 860, '扣 140 军费');
    assert.equal(h.capacity('red', 0), HEALING_RULES.BASE_CAPACITY, '未完工不生效');
    run(s, 22);
    const tent = c.getBuilding('tent:red:0');
    assert.equal(tent.complete, true);
    assert.equal(h.capacity('red', 0), HEALING_RULES.TENT_CAPACITY);
    assert.ok(Math.abs(h.speed('red', 0) - 2.2) < 1e-9);
    const u = rout(add(s, 'red', 'infantry', 56, 60.5), 30);
    run(s, 0.05);
    const before = u.hp;
    run(s, 1);
    assert.ok(Math.abs(u.hp - before - 11) < 0.5, `医帐提速后 11 HP/秒（实测 ${u.hp - before}）`);
    resetBoardSize();
});

test('医师入驻：医帐收医师不收弓手，箭塔收弓手不收医师；驻帐再提速', () => {
    const s = fixture(), c = s.territory.camps, h = s.territory.healing;
    c.createBuilding('red', 'camp', 0, true);
    const tent = c.createBuilding('red', 'tent', 0, true);
    const medic = add(s, 'red', 'medic', tent.gx - 2, tent.gy);
    const archer = add(s, 'red', 'archer', tent.gx - 2, tent.gy + 1);
    const tower = c.getBuilding('tower:red:home');
    assert.equal(c.orderGarrison('red', [archer.id], tent.id), false, '弓手进不了医帐');
    assert.equal(c.orderGarrison('red', [medic.id], tower.id), false, '医师进不了箭塔');
    assert.equal(c.orderGarrison('red', [medic.id], tent.id), true);
    run(s, 3);
    assert.equal(tent.garrisonIds.length, 1);
    assert.equal(medic.garrisonTowerId, tent.id);
    assert.ok(Math.abs(h.speed('red', 0) - (1 + HEALING_RULES.TENT_SPEED_BONUS + HEALING_RULES.TENT_MEDIC_SPEED_BONUS)) < 1e-9,
        '医帐+驻帐医师叠加提速');
    assert.equal(c.ungarrison('red', tent.id), true, '医师可出帐');
    assert.equal(medic.garrisonTowerId, null);
    resetBoardSize();
});

test('医师战地急救光环：优先最重伤员，同时至多两人，溃逃者不救', () => {
    const s = fixture();
    const medic = add(s, 'red', 'medic', 20, 90);
    const worst = add(s, 'red', 'infantry', 21, 90); worst.hp = 40;
    const middle = add(s, 'red', 'infantry', 22, 90); middle.hp = 50;
    const best = add(s, 'red', 'infantry', 19, 90); best.hp = 60;
    const routed = add(s, 'red', 'infantry', 20.5, 91); rout(routed, 20);
    run(s, 0.05); // 分配拍不作用（无溃逃选址对象），光环按步推进
    const w0 = worst.hp, m0 = middle.hp, b0 = best.hp, r0 = routed.hp;
    run(s, 1);
    assert.ok(Math.abs(worst.hp - w0 - HEALING_RULES.MEDIC_AURA_RATE) < 0.2, '最重伤员被救');
    assert.ok(Math.abs(middle.hp - m0 - HEALING_RULES.MEDIC_AURA_RATE) < 0.2, '次重伤员被救');
    assert.ok(Math.abs(best.hp - b0) < 1e-9, '同时只救两人');
    assert.ok(Math.abs(routed.hp - r0) < 1e-9, '溃逃者不吃光环（走据点疗伤）');
    medic.moraleState = 'routing';
    const stop = worst.hp;
    run(s, 1);
    assert.ok(Math.abs(worst.hp - stop) < 1e-9, '医师溃逃后光环停止');
    resetBoardSize();
});

test('医师无攻击不占旗；征兵 AI 按配比买医师；营寨 AI 建设链到医帐', () => {
    const s = fixture({ ai: true }), c = s.territory.camps;
    assert.equal(UNIT_TYPES.medic.atk, 0);
    // 占旗力为 0：医师站中立旗圈不拉进度
    const medic = add(s, 'red', 'medic', 130, 90);
    s.rebuildSpatial(); updateFlags(s, 1);
    assert.equal(s.flags[2].progress, 0);
    // 战略 AI：其它兵种接近满配时缺口最大的是医师
    for (let i = 0; i < 20; i++) add(s, 'red', 'infantry', 10 + (i % 5), 88 + Math.floor(i / 5));
    for (let i = 0; i < 11; i++) add(s, 'red', 'archer', 12, 88 + i);
    for (let i = 0; i < 9; i++) add(s, 'red', 'pikeman', 14, 88 + i);
    for (let i = 0; i < 5; i++) add(s, 'red', 'cavalry', 16, 88 + i);
    s.territory.econ.treasury.red = 1000;
    const ai = new TerritoryAI(s, 'red'); ai.update(0);
    assert.equal(s.territory.recruit.queues.red[0].type, 'medic');
    ai.update(1200);
    assert.equal(s.territory.recruit.queues.red[1].type, 'axe', '医师已在训练后恢复补充斧兵，不重复阻塞新增兵种');
    // 营寨 AI：营寨+箭塔完工后，空闲民夫接着建医帐
    c.createBuilding('red', 'camp', 0, true);
    c.createBuilding('red', 'tower', 0, true);
    add(s, 'red', 'worker', 55, 63.5);
    c.ai('red');
    assert.ok(c.getBuilding('tent:red:0'), '建设链推进到医帐');
    resetBoardSize();
});

test('医师随营行军：有驻守点令时向点归位，不参与攻击', () => {
    const s = fixture();
    const battalion = s.battalions.createBattalion('red', 'line');
    const medic = add(s, 'red', 'medic', 30, 90);
    battalion.members.push(medic); medic.battalion = battalion;
    battalion.orderPoint = { gx: 60, gy: 90 }; battalion.playerOrdered = true;
    updateMedic(s, medic, 0, 1 / 60);
    assert.ok(medic.moving && medic.moveX > 0, '向驻守点行军');
    resetBoardSize();
});

test('镜像对称：两侧溃兵同等战损下疗伤进度与结局一致', () => {
    const s = fixture();
    const r = rout(add(s, 'red', 'infantry', 56, 60.5), 30);
    const b = rout(add(s, 'blue', 'infantry', board.W - 56, 60.5), 30);
    run(s, 16);
    assert.equal(r.moraleState, b.moraleState);
    assert.equal(r.hp, b.hp);
    assert.ok(Math.abs(r.gx + b.gx - board.W) < 1e-6, '位置换座镜像');
    resetBoardSize();
});

test('P1-1 回归：双方大本营容量互不串用', () => {
    const s = fixture();
    // 红方本营 8 人占满
    for (let i = 0; i < 8; i++) rout(add(s, 'red', 'infantry', 7 + (i % 3) * 0.4, board.H / 2 + Math.floor(i / 3) * 0.4), 40);
    run(s, 0.6);
    assert.equal(s.territory.healing.healingCount('red', 'home'), 8, '红方本营满员');
    // 蓝方溃兵在本方大本营照常入住（不被红方占用堵死）
    const blue = rout(add(s, 'blue', 'infantry', board.W - 7.5, board.H / 2), 40);
    run(s, 0.8);
    assert.equal(blue.healingAt, 'home', '蓝方本营独立计数，照常入住');
    resetBoardSize();
});

test('P1-2 回归：入住半径量化，镜像浮点噪声不再分岔', () => {
    const s = fixture(), h = s.territory.healing;
    // 评审复现坐标：红 dist=2.200000000000003 / 蓝镜像 dist=2.1999999999999886，
    // 量化后同为 2.2（含边界）→ 两侧必须同判。只跑疗伤拍、不跑行军循环，
    // 单位停在原地，判定才只取决于量化半径。
    const r = rout(add(s, 'red', 'infantry', 57.2, 60), 40);
    const b = rout(add(s, 'blue', 'infantry', board.W - 57.2, 60), 40);
    s.simulationTime += 100; h.update(1 / 60);
    assert.equal(r.healingAt, 0, '红方边界噪声侧入住');
    assert.equal(b.healingAt, 1, '蓝方镜像噪声侧同判入住');
    // 明确超出（2.3）→ 两侧同判不入住（仍分配据点、原地未动）
    const r2 = rout(add(s, 'red', 'infantry', 57.3, 60), 40);
    const b2 = rout(add(s, 'blue', 'infantry', board.W - 57.3, 60), 40);
    s.simulationTime += 600; h.update(1 / 60);
    assert.ok(r2.healingAt == null, '红方超界不入住');
    assert.ok(b2.healingAt == null, '蓝方镜像超界同判不入住');
    resetBoardSize();
});

test('P1-3 回归：等距选址换座对称（镜像不变量决胜）', () => {
    const s = fixture();
    // 红方拥有 西桥头(55,65) 与 中央(130,65)；伤兵在两点等距处
    s.flags[0].gx = 55; s.flags[0].gy = 65; s.flags[0].owner = 'red';
    s.flags[1].owner = null;
    s.flags[2].gx = 130; s.flags[2].gy = 65; s.flags[2].owner = 'red';
    const r = rout(add(s, 'red', 'infantry', 92.5, 65), 40);
    run(s, 0.3);
    assert.equal(r.healSiteId, 0, '红方取西桥头');
    // 换座镜像局：蓝方拥有 东桥头(W-55,65) 与 中央(130,65)；伤兵镜像位
    s.flags[0].owner = null;
    s.flags[1].gx = board.W - 55; s.flags[1].gy = 65; s.flags[1].owner = 'blue';
    s.flags[2].owner = 'blue';
    const b = rout(add(s, 'blue', 'infantry', board.W - 92.5, 65), 40);
    run(s, 0.3);
    assert.equal(b.healSiteId, 1, '蓝方取东桥头（与红方同相对位，而非绝对序号小的中央旗）');
    resetBoardSize();
});

test('P1-4 回归：医师封顶后征兵 AI 不停购', () => {
    const s = fixture();
    for (let i = 0; i < 8; i++) add(s, 'red', 'medic', 10 + i * 0.8, 88);
    s.territory.econ.treasury.red = 1000;
    const ai = new TerritoryAI(s, 'red');
    ai.update(0);
    const bought = s.territory.recruit.queues.red[0]?.type;
    assert.ok(bought && bought !== 'medic', `封顶兵种不产生缺口，改买其它（实际 ${bought}）`);
    resetBoardSize();
});

test('P2 回归：锁步投影覆盖疗伤字段（分歧可被哈希检出）', () => {
    const s = fixture();
    rout(add(s, 'red', 'infantry', 56, 60.5), 40);
    run(s, 0.3);
    const before = battleProjection(s);
    const u = s.units[0];
    u.healSiteId = null; u.healingAt = 'home'; u.healingSince = 1234;
    assert.notEqual(battleProjection(s), before, '疗伤字段变化必须改变投影');
    u.healingAt = null;
    assert.notEqual(battleProjection(s), before);
    resetBoardSize();
});

test('P2 回归：毁帐降容——已入住者治完，新伤兵按新容量改投', () => {
    const s = fixture(), c = s.territory.camps;
    c.createBuilding('red', 'camp', 0, true);
    c.createBuilding('red', 'tent', 0, true);
    const squad = Array.from({ length: 16 }, (_, i) =>
        rout(add(s, 'red', 'infantry', 55 + (i % 4) * 0.5, 60 + Math.floor(i / 4) * 0.5), 50));
    run(s, 0.6);
    assert.equal(s.territory.healing.healingCount('red', 0), 16, '医帐扩容 16 人入住');
    const enemy = add(s, 'blue', 'infantry', 55, 63);
    c.damageBuilding(c.getBuilding('tent:red:0'), 9999, enemy);
    assert.equal(s.territory.healing.capacity('red', 0), 8, '毁帐后容量回落');
    run(s, 1.5);
    assert.equal(squad.filter(u => u.healingAt === 0).length, 16, '已入住者继续治完（不赶人）');
    assert.ok(squad.every(u => u.hp > 50), '在疗者仍在回血');
    const newcomer = rout(add(s, 'red', 'infantry', 56.5, 61), 60);
    run(s, 0.8);
    assert.equal(newcomer.healSiteId, 'home', '新伤兵不再挤入降容据点，改投大本营');
    resetBoardSize();
});

test('P2 回归：纯医师营不领旗令（零战力营不夺旗）', () => {
    const s = fixture();
    const battalion = s.battalions.createBattalion('red', 'gathering');
    s.battalions.battalions.push(battalion);   // 正式营一律入列（生产路径由 splitOpening/集结池推入）
    for (let i = 0; i < 5; i++) {
        const m = add(s, 'red', 'medic', 10 + i * 0.8, 90);
        battalion.members.push(m); m.battalion = battalion;
    }
    battalion.createdAt = -30000;
    s.battalions.update(0);
    assert.equal(battalion.gathering, false, '集结超时激活为成建制营');
    s.battalions.aiAssign();
    assert.equal(battalion.orderFlag, null, '零占领力营不领旗令，就地待命');
    resetBoardSize();
});

test('士气门闩：疗伤中的溃兵不被接应锚自动重整，HP 回满才由疗伤系统放行', () => {
    const scene = { units: [], simulationTime: 0, battleId: 1, battleOptions: {} };
    const morale = new MoraleSystem(scene);
    const add = (type, gx, gy, state = 'steady') => {
        const unit = { id: scene.units.length + 1, team: 'red', type, gx, gy, hp: 100, maxHp: 100,
            battleId: 1, dead: false, withdrawn: false, moving: false, velX: 0, velY: 0,
            moraleState: state };
        scene.units.push(unit); morale.initUnit(unit); return unit;
    };
    const wounded = add('infantry', 0, 0, 'routing');
    wounded.healingAt = 0; wounded.morale = 10;
    for (const [dx, dy] of [[0.8, 0], [-0.8, 0], [0, 0.8]]) add('infantry', dx, dy);
    const step = dt => { scene.simulationTime += dt * 1000; morale.beginStep(dt); morale.update(dt); };
    for (let i = 0; i < 160; i++) step(0.1);   // 16 秒：接应恢复（3/秒）早已越过重整阈值
    assert.ok(wounded.morale >= 45, `士气已恢复到 ${wounded.morale}`);
    assert.equal(wounded.moraleState, 'routing', '疗伤门闩挡住自动重整');
    wounded.healingAt = null;
    step(0.1);
    assert.notEqual(wounded.moraleState, 'routing', '门闩解除后正常重整');
});
