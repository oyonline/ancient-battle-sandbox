// 营寨守军（近战上寨墙）：受理口径、上墙站位、居高临下的攻防加成、可被击杀、沿墙跑位、AI 派兵。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CampSystem, CAMP_RULES, wallRadius, wallSlots, wallPointAt, wallParamToward, wallSlotParam
} from '../js/battle/camps.js';
import { TerritoryEconomy, TERRITORY } from '../js/battle/economy.js';
import { RecruitSystem } from '../js/battle/recruit.js';
import { BattleSpatialIndex } from '../js/battle/spatial.js';
import { BattalionSystem } from '../js/battle/battalion.js';
import { UNIT_TYPES, applyDamage, calculateAttackDamage } from '../js/units.js';
import { setBoardSize, board } from '../js/board.js';

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
        territory: { econ: new TerritoryEconomy(), autoBuy: { red: ai, blue: ai } },
        forEachNear(...args) { spatial.forEachNear(...args); },
        rebuildSpatial() { spatial.rebuild(this.units); this._aliveArr = spatial.alive; },
        aliveCount(team, type) { return this.units.filter(u => !u.dead && u.team === team && (!type || u.type === type)).length; },
        fireArrow(from, target) { this.arrows.push({ sourceId: from.id, target, at: this.simulationTime }); },
        playAttackAnim() {}, meleeImpact() {},
        scheduleBattleAction(delay, callback) { this.queue.push({ at: this.simulationTime + delay, callback }); },
        addBattleEvent(id, text, team) { this.events.push({ id, text, team }); },
        recordDamage() {}, recordDeath() {}, killUnit() {},
        board_W() { return board.W - 8; }, board_H() { return board.H; }
    };
    scene.territory.recruit = new RecruitSystem(scene);
    scene.territory.camps = new CampSystem(scene);
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

const homeCamp = s => s.territory.camps.getBuilding(s.territory.camps.id('red', 'camp', 'home'));
const homeTower = s => s.territory.camps.getBuilding(s.territory.camps.id('red', 'tower', 'home'));
const chebyshev = (u, b) => Math.max(Math.abs(u.gx - b.gx), Math.abs(u.gy - b.gy));

test('垛口数按寨墙推：前线营寨 6 个，大本营 10 个', () => {
    assert.equal(wallSlots({ siteId: 'home' }), CAMP_RULES.HOME_WALL_SLOTS);
    assert.equal(wallSlots({ siteId: 0 }), CAMP_RULES.WALL_SLOTS);
    assert.equal(wallRadius({ siteId: 'home' }), CAMP_RULES.HOME_WALL_RADIUS);
    assert.equal(wallRadius({ siteId: 0 }), CAMP_RULES.WALL_RADIUS);
    const s = fixture();
    assert.equal(homeCamp(s).capacity, CAMP_RULES.HOME_WALL_SLOTS);
    assert.equal(s.territory.camps.createBuilding('red', 'camp', 0, true).capacity, CAMP_RULES.WALL_SLOTS);
});

test('营寨上墙只收近战；箭塔仍然只收弓手', () => {
    const s = fixture(), camp = homeCamp(s), tower = homeTower(s);
    const inf = add(s, 'red', 'infantry', 10, 90);
    const axe = add(s, 'red', 'axe', 10, 92);
    const pik = add(s, 'red', 'pikeman', 10, 94);
    const cav = add(s, 'red', 'cavalry', 10, 96);
    const arc = add(s, 'red', 'archer', 10, 98);
    const medic = add(s, 'red', 'medic', 10, 100);
    const accepted = ids => s.territory.camps.garrisonAcceptList('red', ids, camp.id).map(u => u.id).sort((a, b) => a - b);
    assert.deepEqual(accepted([inf.id, arc.id, medic.id]), [inf.id], '营寨拒收弓手与医师');
    assert.deepEqual(accepted([axe.id, pik.id, cav.id]), [axe.id, pik.id, cav.id]);
    assert.deepEqual(s.territory.camps.garrisonAcceptList('red', [inf.id, arc.id], tower.id).map(u => u.id), [arc.id]);
});

test('近战上墙：站到寨墙环上，取得居高临下的攻防加成', () => {
    const s = fixture(), camp = homeCamp(s);
    const u = add(s, 'red', 'infantry', camp.gx + 3, camp.gy + 3);
    assert.equal(s.territory.camps.orderGarrison('red', [u.id], camp.id), true);
    run(s, 6);
    assert.equal(u.wallGuardId, camp.id, '已在墙上值守');
    assert.ok(!u.garrisonTowerId, '守军不是藏在建筑里的单位：必须能被选中与攻击');
    assert.equal(u.guardCoverScale, CAMP_RULES.WALL_GUARD_COVER);
    assert.equal(u.garrisonHeight, CAMP_RULES.WALL_GUARD_LIFT_PX, '抬到墙顶，而不是箭塔 82px 高台');
    assert.equal(camp.garrisonIds.includes(u.id), true);
    assert.ok(Math.abs(chebyshev(u, camp) - wallRadius(camp)) < 0.06, `应站在寨墙环上，实际离环 ${chebyshev(u, camp) - wallRadius(camp)}`);
});

// 跑到敌人第一次掉血为止，返回这一次的伤害量（单次口径，避开连击累计的歧义）
function firstHit(s, foe, maxSeconds = 5) {
    const before = foe.hp;
    for (let i = 0; i < Math.round(maxSeconds * 60); i++) {
        run(s, 1 / 60);
        if (foe.hp !== before) return before - foe.hp;
    }
    return 0;
}

test('居高临下：守军造成伤害 ×1.25，受到伤害 ×0.7', () => {
    const s = fixture(), camp = homeCamp(s);
    const u = add(s, 'red', 'infantry', camp.gx + 3, camp.gy + 3);
    s.territory.camps.orderGarrison('red', [u.id], camp.id);
    run(s, 6);
    assert.equal(u.wallGuardId, camp.id);
    const foe = add(s, 'blue', 'infantry', u.gx + 0.9, u.gy);
    foe.hp = foe.maxHp = 99999;                       // 只测单次伤害，不让战斗推进
    const elevated = calculateAttackDamage(u, foe, { multiplier: CAMP_RULES.WALL_GUARD_ATTACK });
    const plain = calculateAttackDamage(u, foe);
    assert.equal(plain, UNIT_TYPES.infantry.atk - UNIT_TYPES.infantry.def, '平地口径');
    assert.equal(elevated, Math.max(1, Math.floor(UNIT_TYPES.infantry.atk * 1.25 - UNIT_TYPES.infantry.def)), '居高临下口径');
    assert.equal(firstHit(s, foe), elevated, `守军单次出手应是 ${elevated}（平地只有 ${plain}）`);
    // 守军挨打：墙上 ×0.7
    const beforeHp = u.hp;
    assert.equal(applyDamage(u, 20, foe), 14, '20 点伤害在墙上按 ×0.7 结算为 14');
    assert.equal(u.hp, beforeHp - 14);
    // 下墙后回到 1 倍
    s.territory.camps.exitUnit(camp, u, 0);
    assert.equal(u.wallGuardId, null);
    assert.equal(u.guardCoverScale, 1);
    assert.equal(applyDamage(u, 20, foe), 20);
});

test('守军可被击杀：死了就空出垛口，寨子重新变成空壳', () => {
    const s = fixture(), camp = homeCamp(s);
    const u = add(s, 'red', 'infantry', camp.gx + 3, camp.gy + 3);
    s.territory.camps.orderGarrison('red', [u.id], camp.id);
    run(s, 6);
    assert.equal(u.wallGuardId, camp.id);
    const foe = add(s, 'blue', 'infantry', u.gx + 0.9, u.gy);
    applyDamage(u, u.hp * 2, foe);                    // 墙上减伤也算在内，确保打穿
    run(s, 1);
    assert.equal(u.dead, true);
    assert.equal(camp.garrisonIds.includes(u.id), false, '阵亡守军要释放垛口');
    assert.equal(u.wallGuardId, null);
    assert.equal(u.guardCoverScale, 1);
    // 空出来的垛口可以被新守军补上（先把敌人挪远，否则新守军会就地接敌、不上墙）
    foe.gx = camp.gx + 40; foe.gy = camp.gy + 40;
    const next = add(s, 'red', 'pikeman', camp.gx - 3, camp.gy - 3);
    s.territory.camps.orderGarrison('red', [next.id], camp.id);
    run(s, 6);
    assert.equal(next.wallGuardId, camp.id);
});

test('沿墙跑位：敌人换到另一侧，守军沿寨墙赶过去，而不是穿寨而过', () => {
    const s = fixture();
    const camp = s.territory.camps.createBuilding('red', 'camp', 0, true);
    const u = add(s, 'red', 'infantry', camp.gx + 1, camp.gy + 1);
    s.territory.camps.orderGarrison('red', [u.id], camp.id);
    run(s, 6);
    assert.equal(u.wallGuardId, camp.id);
    const r = wallRadius(camp);
    // 敌人出现在沿墙 3 格外的位置（在接敌半径内）：守军应当朝那一段墙移动
    const startParam = wallParamToward(camp, u.gx, u.gy);
    const spot = wallPointAt(camp, startParam + 3);
    const out = { x: (spot.gx - camp.gx) / r, y: (spot.gy - camp.gy) / r };
    const foe = add(s, 'blue', 'infantry', spot.gx + out.x * 1.2, spot.gy + out.y * 1.2);
    foe.hp = foe.maxHp = 99999;
    run(s, 6);
    const nowParam = wallParamToward(camp, u.gx, u.gy);
    const wantParam = wallParamToward(camp, foe.gx, foe.gy);
    assert.notEqual(nowParam, startParam, '应当离开原垛口去迎敌');
    assert.ok(Math.abs(nowParam - wantParam) < 0.8, `应停在离敌人最近的一段墙：${nowParam} vs ${wantParam}`);
    assert.ok(Math.abs(chebyshev(u, camp) - r) < 0.06, '全程都在墙环上，不会走进寨子');
});

test('垛口参数：沿墙环均匀分布且落在环上', () => {
    const camp = { gx: 55, gy: 60, siteId: 0 };
    const per = 8 * wallRadius(camp);
    for (let i = 0; i < wallSlots(camp); i++) {
        const p = wallPointAt(camp, wallSlotParam(camp, i));
        assert.ok(Math.abs(chebyshev(p, camp) - wallRadius(camp)) < 0.06);
    }
    // 环绕一圈后回到起点，参数不会溢出
    const a = wallPointAt(camp, 0.3), b = wallPointAt(camp, per + 0.3);
    assert.deepEqual(a, b);
    assert.equal(wallParamToward(camp, camp.gx + 10, camp.gy), wallParamToward(camp, camp.gx + 1, camp.gy));
});

test('AI：给前线营寨派 2 名近战守军，大本营营寨不驻', () => {
    const s = fixture({ ai: true });
    const field = s.territory.camps.createBuilding('red', 'camp', 0, true);
    const home = homeCamp(s);
    const troops = [
        add(s, 'red', 'infantry', field.gx + 2, field.gy + 2),
        add(s, 'red', 'infantry', field.gx + 3, field.gy + 2),
        add(s, 'red', 'pikeman', field.gx + 2, field.gy + 3),
        add(s, 'red', 'archer', field.gx + 3, field.gy + 3)
    ];
    s.territory.camps.ai('red');
    const ordered = s.units.filter(u => u.garrisonOrderId === field.id).map(u => u.id);
    assert.equal(ordered.length, 2, '前线营寨只派 2 人');
    assert.ok(ordered.every(id => UNIT_TYPES[s.units.find(u => u.id === id).type].name !== '弓箭手'), '只派近战');
    assert.equal(s.units.some(u => u.garrisonOrderId === home.id), false, '大本营营寨不驻军：AI 主力留在野战');
    void troops;
});
