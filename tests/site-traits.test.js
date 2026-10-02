// 六类据点特色：真实生效、按当前归属、同类不叠加、只作用于本点、
// 大本营不套用、易主即时失效、重新部署无残留。
// 风格：轻量 harness 场景直接驱动模拟层（同 camps.test.js / healing.test.js）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { makeScene, addUnit } from './battle-harness.js';
import { setBoardSize, resetBoardSize, board } from '../js/board.js';
import { moveToward, UNIT_TYPES } from '../js/units.js';
import { Terrain } from '../js/terrain.js';
import { TERRITORY } from '../js/battle/economy.js';
import { territoryLayout } from '../js/territory-map.js';
import { CAMP_RULES } from '../js/battle/camps.js';
import { HEALING_RULES } from '../js/battle/healing.js';
import { updateFlags } from '../js/battle/territory-bridge.js';
import {
    SITE_TRAITS, SITE_AI, DEFAULT_SHALLOW_SPEED, describeTrait, localTrait, ownsRole,
    buildSpeedScale, buildingDamageScale, healingCapacityBonus, shallowSpeedFor,
    moraleLossScale, traitState, buildSiteBonus
} from '../js/battle/site-traits.js';
import { MoraleSystem } from '../js/morale.js';

setBoardSize(TERRITORY.W, TERRITORY.H);
after(() => resetBoardSize());

const STEP_MS = 1000 / 60;

function campScene({ terrain = 'flat' } = {}) {
    const scene = makeScene();
    scene.deployUnits({}, {}, 'custom', 'custom', {},
        { territory: true, terrain, territoryAI: false });
    scene.battleStarted = true;
    return scene;
}

function siteIndexOf(scene, role, owner) {
    return scene.flags.findIndex(f => f.role === role && (owner === undefined || f.owner === owner));
}

function addWorker(scene, team, gx, gy) {
    return addUnit(scene, team, 'worker', gx, gy);
}

// ---------------- 参数表与镜像一致性 ----------------

test('六类据点参数集中在一张表，东西同类据点镜像同规则', () => {
    const sites = territoryLayout(TERRITORY.W, TERRITORY.H).sites;
    for (const site of sites) assert.ok(SITE_TRAITS[site.role], `${site.role} 必须有参数`);
    const byName = new Map(sites.map(s => [s.name, s]));
    for (const [west, east] of [['西桥头', '东桥头'], ['西林口', '东林口'], ['西马场', '东马场'],
        ['西渡口', '东渡口'], ['西南路口', '东南路口']]) {
        assert.equal(byName.get(west).role, byName.get(east).role, `${west}/${east} 同类`);
        // 镜像坐标：x 关于地图中线对称，y 相同，且据点序成对
        assert.equal(byName.get(west).gx + byName.get(east).gx, TERRITORY.W, `${west}/${east} x 镜像`);
        assert.equal(byName.get(west).gy, byName.get(east).gy, `${west}/${east} y 相同`);
        // 同一张参数表：两处角色的数值对象必须是同一份（不是各写一套）
        assert.equal(SITE_TRAITS[byName.get(west).role], SITE_TRAITS[byName.get(east).role]);
    }
    for (const [role, trait] of Object.entries(SITE_TRAITS)) {
        const text = describeTrait(role);
        assert.ok(text.terrain && text.reward && text.condition, `${role} 必须有地形/奖励/条件三段文案`);
        if (trait.scope === 'global') assert.ok(SITE_AI[role], `${role} 需要 AI 权重`);
    }
    // AI 权重克制：任何单点加成都不超过基础夺旗分（50）的一半强，避免所有营追同一奖励。
    for (const weight of Object.values(SITE_AI)) {
        assert.ok(weight.contest <= 28 && weight.hold <= 12, 'AI 权重保持克制');
    }
});

// ---------------- 林口：营建 ----------------

test('林口：本点施工速度 ×1.25（有效施工时间 −20%），只作用于该据点', () => {
    const scene = campScene();
    const camps = scene.territory.camps;
    scene.territory.econ.treasury.red = 5000;
    const forest = siteIndexOf(scene, 'forest');
    const bridge = siteIndexOf(scene, 'bridge');
    const workerA = addWorker(scene, 'red', scene.flags[forest].gx, scene.flags[forest].gy);
    const workerB = addWorker(scene, 'red', scene.flags[bridge].gx, scene.flags[bridge].gy);
    assert.equal(camps.requestBuild('red', workerA.id, 'camp', forest), true);
    assert.equal(camps.requestBuild('red', workerB.id, 'camp', bridge), true);
    const boosted = camps.getBuilding(`camp:red:${forest}`);
    const plain = camps.getBuilding(`camp:red:${bridge}`);
    workerA.gx = boosted.gx; workerA.gy = boosted.gy;
    workerB.gx = plain.gx; workerB.gy = plain.gy;
    camps.update(1);
    const expected = 1 / CAMP_RULES.camp.seconds;
    assert.ok(Math.abs(boosted.progress - expected * 1.25) < 1e-9, '林口 1 秒推进 = 1.25/18');
    assert.ok(Math.abs(plain.progress - expected) < 1e-9, '同时间的桥头营寨按原速施工');
    // 完工时间等价：林口 18 秒的工程只要 14.4 秒。
    assert.ok(Math.abs(CAMP_RULES.camp.seconds / 1.25 - 14.4) < 1e-9);
    assert.equal(camps.buildInfo('camp').cost, 160, '林口不降费用');
    assert.equal(boosted.maxHp, CAMP_RULES.camp.hp, '林口不提高建筑属性');
});

test('林口：易主即停、续建保留进度、重复派工不重复领加成', () => {
    const scene = campScene();
    const camps = scene.territory.camps;
    scene.territory.econ.treasury.red = 5000;
    const forest = siteIndexOf(scene, 'forest');
    const worker = addWorker(scene, 'red', scene.flags[forest].gx, scene.flags[forest].gy);
    assert.equal(camps.requestBuild('red', worker.id, 'camp', forest), true);
    const camp = camps.getBuilding(`camp:red:${forest}`);
    worker.gx = camp.gx; worker.gy = camp.gy;
    camps.update(1);
    const boostedProgress = camp.progress;
    // 重复派工（同一民夫再下一次施工令）不重置进度、也不叠加加成。
    assert.equal(camps.requestBuild('red', worker.id, 'camp', forest), true);
    assert.equal(camp.progress, boostedProgress, '续建保留已有进度');
    camps.update(1);
    assert.ok(Math.abs(camp.progress - boostedProgress * 2) < 1e-9, '速度仍是 ×1.25，不叠加');
    // 易主：施工暂停（沿用既有归属规则），奖励立即失效。
    scene.flags[forest].owner = 'blue';
    camps.update(1);
    assert.equal(camp.progress, boostedProgress * 2, '失去据点后施工暂停');
    assert.equal(buildSpeedScale(scene, camp), 1, '失去林口后不再加速');
});

// ---------------- 桥头：工事 ----------------

test('桥头：本点建筑受伤 −10%，统一取整且最低 1 点，不给全军加防御', () => {
    const scene = campScene();
    const camps = scene.territory.camps;
    const enemy = addUnit(scene, 'blue', 'infantry', 10, 10);
    const west = siteIndexOf(scene, 'bridge', 'red');
    const east = siteIndexOf(scene, 'bridge', 'blue');
    const guarded = camps.createBuilding('red', 'camp', west, true);
    const exposed = camps.createBuilding('blue', 'camp', west, true);   // 蓝方建筑站在红方桥头
    const home = camps.getBuilding('camp:red:home');
    let hp = guarded.hp;
    assert.equal(camps.damageBuilding(guarded, 100, enemy), 90, '100 → 90');
    assert.equal(hp - guarded.hp, 90);
    hp = exposed.hp;
    assert.equal(camps.damageBuilding(exposed, 100, addUnit(scene, 'red', 'infantry', 11, 11)), 100,
        '据点不归该建筑所属方时不享受减伤');
    assert.equal(localTrait(scene, 'blue', west), null, '归属方之外拿不到该点特色');
    assert.equal(localTrait(scene, 'red', west).name, '桥头');
    hp = home.hp;
    assert.equal(camps.damageBuilding(home, 100, enemy), 100, '大本营不套用旗点奖励');
    assert.equal(hp - home.hp, 100);
    assert.equal(camps.damageBuilding(guarded, 1, enemy), 1, '减伤后仍有最低 1 点伤害');
    resetBoardSize();
    setBoardSize(TERRITORY.W, TERRITORY.H);
});

test('桥头易主但旧建筑尚存：旧建筑立即失去减伤，且不转交新主人', () => {
    const scene = campScene();
    const camps = scene.territory.camps;
    const enemy = addUnit(scene, 'blue', 'infantry', 10, 10);
    const west = siteIndexOf(scene, 'bridge', 'red');
    const tower = camps.createBuilding('red', 'tower', west, true);
    assert.equal(buildingDamageScale(scene, tower), 0.9);
    scene.flags[west].owner = 'blue';
    traitState(scene).refresh();
    let hp = tower.hp;
    assert.equal(camps.damageBuilding(tower, 100, enemy), 100, '易主后按原伤害结算');
    assert.equal(hp - tower.hp, 100);
    assert.equal(tower.team, 'red', '旗帜易主不会把旧建筑转给新主人');
    assert.equal(camps.requestBuild('blue', addWorker(scene, 'blue', 12, 12).id, 'camp', west), false,
        '敌方残存建筑挡住建营');
});

// ---------------- 中央高地：稳固军心 ----------------

function moraleFixture() {
    const scene = {
        units: [], simulationTime: 0, battleId: 1, changes: [],
        flags: campSceneFlags(), battleOptions: { territory: true, terrain: 'flat' },
        onMoraleStateChange(unit, previous, reason) { this.changes.push({ id: unit.id, previous, reason }); }
    };
    const morale = new MoraleSystem(scene);
    const hill = scene.flags.findIndex(f => f.role === 'hill');
    const add = (team, gx, gy, battalion = null) => {
        const unit = { id: scene.units.length + 1, team, type: 'infantry', gx, gy,
            hp: 100, maxHp: 100, battleId: scene.battleId, dead: false, withdrawn: false,
            moving: false, velX: 0, velY: 0, battalion };
        scene.units.push(unit); morale.initUnit(unit);
        return unit;
    };
    const step = (dt = 0.1, events = () => {}) => {
        scene.simulationTime += dt * 1000;
        morale.beginStep(dt); events(); morale.update(dt);
    };
    return { scene, morale, add, step, hill: scene.flags[hill] };
}

// 复刻领土旗位（不改棋盘尺寸，避免与镜头/度量耦合）。
function campSceneFlags() {
    const scene = makeScene();
    scene.deployUnits({}, {}, 'custom', 'custom', {}, { territory: true, terrain: 'flat', territoryAI: false });
    return scene.flags;
}

test('中央高地：归属方 + 明确驻守令 + 8 格内，士气损失 −10%', () => {
    const a = moraleFixture();
    const plain = a.add('red', a.hill.gx, a.hill.gy, { orderPoint: { gx: a.hill.gx, gy: a.hill.gy } });
    a.hill.owner = 'blue';                     // 高地不在自己手里
    a.step(0.1, () => a.morale.queueDamage(plain, 30));
    const baseline = 100 - plain.morale;

    const b = moraleFixture();
    const guarded = b.add('red', b.hill.gx, b.hill.gy, { orderPoint: { gx: b.hill.gx, gy: b.hill.gy } });
    b.hill.owner = 'red';
    b.step(0.1, () => b.morale.queueDamage(guarded, 30));
    const reduced = 100 - guarded.morale;
    assert.ok(Math.abs(baseline - 7.2) < 1e-9, `无高地时损失 7.2（实际 ${baseline}）`);
    assert.ok(Math.abs(reduced - baseline * 0.9) < 1e-9, '有高地时损失 ×0.9');
});

test('中央高地：离开范围 / 解除驻守 / 失去高地立即失效，且只减损失不加恢复', () => {
    const hill = { gx: 0, gy: 0 };
    const cases = [
        ['超出 8 格', unit => { unit.gx = 20; }, null],
        ['没有驻守令', unit => { unit.gx = 0; unit.battalion.orderPoint = null; }, null],
        ['高地属敌方', () => {}, 'blue'],
        ['只有移动令不算驻守', unit => { unit.gx = 0; unit.battalion.orderPoint = null; unit.battalion.orderFlag = 0; }, null]
    ];
    for (const [name, mutate, owner] of cases) {
        const f = moraleFixture();
        const unit = f.add('red', 0, 0, { orderPoint: { gx: 0, gy: 0 } });
        f.hill.owner = owner ?? 'red';
        mutate(unit);
        if (unit.gx === 0 && unit.gy === 0) unit.gx = f.hill.gx, unit.gy = f.hill.gy;
        const scale = moraleLossScale(f.scene, unit);
        assert.equal(scale, 1, `${name}：不生效`);
    }
    const ok = moraleFixture();
    const unit = ok.add('red', ok.hill.gx, ok.hill.gy, { orderPoint: { gx: 0, gy: 0 } });
    ok.hill.owner = 'red';
    assert.equal(moraleLossScale(ok.scene, unit), 0.9);
    const trait = SITE_TRAITS.hill;
    assert.equal(trait.radius, 8);
    assert.ok(!('hp' in trait) && !('atk' in trait) && !('range' in trait), '高地不直接加生命/攻击/射程');
    assert.ok(hill.gx === 0 && hill.gy === 0);
});

// ---------------- 渡口：通行 ----------------

test('渡口：拥有任一渡口浅滩 0.70→0.85，两座不叠加，不改变陆地与水域', () => {
    const scene = campScene({ terrain: 'territory' });
    const fords = scene.flags.map((f, i) => ({ f, i })).filter(({ f }) => f.role === 'ford');
    assert.equal(fords.length, 2);
    assert.equal(shallowSpeedFor(scene, 'red'), DEFAULT_SHALLOW_SPEED);
    fords[0].f.owner = 'red';
    assert.equal(shallowSpeedFor(scene, 'red'), 0.85);
    assert.equal(shallowSpeedFor(scene, 'blue'), DEFAULT_SHALLOW_SPEED, '只对拥有方生效');
    fords[1].f.owner = 'red';
    assert.equal(shallowSpeedFor(scene, 'red'), 0.85, '两座渡口不叠加');
    fords[0].f.owner = 'blue';
    fords[1].f.owner = 'blue';
    assert.equal(shallowSpeedFor(scene, 'red'), DEFAULT_SHALLOW_SPEED, '丢光渡口恢复原规则');

    const fordY = Math.round(board.H * 0.378);
    assert.equal(Terrain.surfaceSpeed('territory', 'infantry', board.W / 2, fordY - 1, 0.85), 0.85);
    assert.equal(Terrain.surfaceSpeed('territory', 'infantry', board.W / 2, fordY - 1, 0.7), 0.7);
    assert.equal(Terrain.surfaceSpeed('territory', 'infantry', 20, board.H / 2, 0.85), 1, '陆地速度不变');
    // 不可通行水域照旧：渡口奖励不制造新通道，也不放宽碰撞与寻路边界。
    assert.equal(Terrain.walkable('territory', board.W / 2, 10, 0.36), false, '河面仍不可通行');
    assert.equal(Terrain.walkable('territory', board.W / 2, fordY - 1, 0.36), true, '浅滩本来就可通行');
    assert.ok(Terrain.clipMotion('territory', board.W / 2, fordY - 1, 0, -3, 0.36).blocked, '浅滩外推仍被水岸截住');
});

test('渡口：浅滩里真的走得更快，比例等于 0.85/0.70', () => {
    const fordY = Math.round(board.H * 0.378);
    const slopeAt = () => Terrain.movementMultiplier('territory', board.W / 2, fordY - 1, board.W / 2 + 1, fordY - 1);
    const run = ownsFord => {
        const scene = campScene({ terrain: 'territory' });
        const ford = siteIndexOf(scene, 'ford');
        if (ownsFord) scene.flags[ford].owner = 'red';
        const unit = addUnit(scene, 'red', 'infantry', board.W / 2, fordY - 1);
        assert.equal(Terrain.surface('territory', unit.gx, unit.gy), 'shallow');
        const start = unit.gx;
        moveToward(unit, unit.gx + 1, unit.gy, UNIT_TYPES.infantry.speed, 1 / 60);
        return unit.gx - start;
    };
    const slow = run(false), fast = run(true);
    assert.ok(slow > 0 && fast > slow, '拥有渡口后浅滩推进更快');
    assert.ok(Math.abs(fast / slow - 0.85 / 0.7) < 1e-9, `速度比 = 0.85/0.70（实际 ${fast / slow}）`);
    // 绝对位移同样锁定真实移动链（moveToward → movementSpeedMultiplier →
    // Terrain.surfaceSpeed(… shallowSpeedFor)）里的渡口系数本身：
    // 期望值 = 兵种速度 × 地形坡度系数 × 浅滩系数 / 60，坡度系数独立读取。
    const speed = UNIT_TYPES.infantry.speed, slope = slopeAt();
    assert.ok(Math.abs(slow - speed * slope * 0.7 / 60) < 1e-12,
        `无渡口：位移 = 速度×坡度×0.7/60（实际 ${slow}，期望 ${speed * slope * 0.7 / 60}）`);
    assert.ok(Math.abs(fast - speed * slope * 0.85 / 60) < 1e-12,
        `有渡口：位移 = 速度×坡度×0.85/60（实际 ${fast}，期望 ${speed * slope * 0.85 / 60}）`);
});

// ---------------- 路口：补给 ----------------

test('路口：本点伤兵收容 +4（8→12，医帐 16→20），大本营不受影响', () => {
    const scene = campScene();
    const healing = scene.territory.healing;
    const camps = scene.territory.camps;
    const crossroad = siteIndexOf(scene, 'crossroad');
    assert.equal(healing.capacity('red', crossroad), HEALING_RULES.BASE_CAPACITY);
    scene.flags[crossroad].owner = 'red';
    assert.equal(healing.capacity('red', crossroad), HEALING_RULES.BASE_CAPACITY + 4);
    assert.equal(healing.capacity('blue', crossroad), HEALING_RULES.BASE_CAPACITY, '非拥有方不加容量');
    camps.createBuilding('red', 'tent', crossroad, true);
    assert.equal(healing.capacity('red', crossroad), HEALING_RULES.TENT_CAPACITY + 4);
    assert.equal(healing.speed('red', crossroad), 1 + HEALING_RULES.TENT_SPEED_BONUS, '不额外乘算疗伤速度');
    scene.flags[crossroad].owner = 'blue';
    traitState(scene).refresh();
    assert.equal(healing.capacity('red', crossroad), HEALING_RULES.TENT_CAPACITY, '失去据点即失去容量');
    assert.equal(healingCapacityBonus(scene, 'red', 'home'), 0, '大本营没有旗点奖励');
    assert.equal(healing.capacity('red', 'home'), HEALING_RULES.BASE_CAPACITY);
});

test('路口：容量提高后按新容量收容，满员改投次近据点，不超额占位', () => {
    const scene = campScene();
    const healing = scene.territory.healing;
    const crossroad = siteIndexOf(scene, 'crossroad');
    scene.flags[crossroad].owner = 'red';
    const point = scene.flags[crossroad];
    for (let i = 0; i < HEALING_RULES.BASE_CAPACITY + 4; i++) {
        const unit = addUnit(scene, 'red', 'infantry', point.gx + (i % 4) * 0.2, point.gy);
        unit.moraleState = 'routing'; unit.morale = 15; unit.routStartedAt = 0; unit.hp = 40;
        unit.healSiteId = crossroad;
    }
    healing.update(0.1);
    assert.equal(healing.healingCount('red', crossroad), 12, '路口容纳 12 人');
    const overflow = addUnit(scene, 'red', 'infantry', point.gx, point.gy + 0.3);
    overflow.moraleState = 'routing'; overflow.morale = 15; overflow.routStartedAt = 0; overflow.hp = 40;
    overflow.healSiteId = crossroad;
    healing.update(0.1);
    assert.equal(healing.healingCount('red', crossroad), 12, '满员后不再超额入住');
    assert.notEqual(overflow.healingAt, crossroad);
});

// ---------------- 统一规则：归属 / 叠加 / 残留 ----------------

test('局部奖励不误作用于其他据点，全局奖励只看是否拥有', () => {
    const scene = campScene();
    const camps = scene.territory.camps;
    const bridgeSite = siteIndexOf(scene, 'bridge', 'red');
    const forestSite = siteIndexOf(scene, 'forest', 'red');
    const bridgeCamp = camps.createBuilding('red', 'camp', bridgeSite, true);
    const forestCamp = camps.createBuilding('red', 'camp', forestSite, true);
    assert.equal(buildingDamageScale(scene, bridgeCamp), 0.9);
    assert.equal(buildingDamageScale(scene, forestCamp), 1, '林口不提供建筑减伤');
    assert.equal(buildSpeedScale(scene, bridgeCamp), 1, '桥头不提供营建加速');
    assert.equal(buildSpeedScale(scene, forestCamp), 1.25);
    assert.equal(healingCapacityBonus(scene, 'red', bridgeSite), 0);
    assert.equal(ownsRole(scene, 'red', 'hill'), false);
    assert.equal(ownsRole(scene, 'red', 'forest'), true, '全局判定读当前归属');
    assert.ok(describeTrait('bridge').terrain.length > 0, '地形说明单独成段');
    assert.ok(describeTrait('bridge').reward.includes('−10%'), '奖励文案写明减伤数值');
});

test('重新部署 / 切模式后没有残留奖励', () => {
    const scene = campScene();
    for (const flag of scene.flags) if (flag.role === 'ford' || flag.role === 'forest') flag.owner = 'red';
    assert.equal(shallowSpeedFor(scene, 'red'), SITE_TRAITS.ford.shallowSpeed);
    // 重新部署（同一场景对象再开一局）：归属重建，派生缓存必须跟着重建。
    scene.deployUnits({}, {}, 'custom', 'custom', {}, { territory: true, terrain: 'flat', territoryAI: false });
    scene.battleStarted = true;
    assert.equal(shallowSpeedFor(scene, 'red'), DEFAULT_SHALLOW_SPEED, '新一局没有上一局的渡口');
    assert.equal(ownsRole(scene, 'red', 'forest'), true, '开局西林口仍归红方（地图规则）');
    // 切到非领土模式：不读旗点，也不提供任何加成。
    scene.deployUnits({}, {}, 'custom', 'custom', {}, { territory: false, terrain: 'flat', territoryAI: false });
    scene.battleStarted = true;
    assert.equal(scene.siteTraits, null, '非领土模式清掉派生缓存');
    assert.equal(shallowSpeedFor(scene, 'red'), DEFAULT_SHALLOW_SPEED);
    resetBoardSize();
    setBoardSize(TERRITORY.W, TERRITORY.H);
});

test('据点易主即时刷新派生状态，播报只发一次', () => {
    const scene = campScene();
    const events = [];
    scene.addBattleEvent = (key, text, team) => events.push({ key, text, team });
    const forest = siteIndexOf(scene, 'forest', 'blue');
    const flag = scene.flags[forest];
    flag.owner = null; flag.progress = 0.995;
    addUnit(scene, 'red', 'infantry', flag.gx, flag.gy);
    scene.rebuildSpatial();
    updateFlags(scene, 0.1);
    assert.equal(flag.owner, 'red');
    assert.equal(ownershipEvents(events, flag.name).length, 1, '占领只播报一次');
    const [brief, detail] = SITE_TRAITS.forest.reward.split('：');
    assert.ok(events.some(e => e.text.includes(brief) && e.text.includes(detail)), '播报含奖励文案');
    assert.ok(events.every(e => !e.text.includes('undefined')), '文案不含内部字段名');
    const count = events.length;
    for (let i = 0; i < 30; i++) updateFlags(scene, 0.1);
    assert.equal(events.length, count, '归属不变时不重复通知');
});

function ownershipEvents(events, name) {
    return events.filter(e => e.text.includes(name) && e.text.includes('占领'));
}

test('AI 需求系数读同一份参数：没马场看重马场，已有马场守场价值仍高', () => {
    const scene = campScene();
    scene.deployUnits({ infantry: 12 }, { infantry: 12 }, 'custom', 'custom', {},
        { territory: true, terrain: 'flat', territoryAI: false });
    scene.battleStarted = true;
    const battalions = scene.battalions;
    const needsBefore = battalions.siteNeeds('red');
    assert.equal(needsBefore.cavalry, 1, '没有马场时争夺权卡拉满');
    assert.equal(needsBefore.cavalryHold, 1, '只有一座马场时守场价值拉满');
    scene.flags[siteIndexOf(scene, 'ranch')].owner = 'red';
    const needsAfter = battalions.siteNeeds('red');
    assert.equal(needsAfter.cavalry, 0.35, '已有马场后争夺权重回落（克制）');
    assert.ok(needsAfter.build >= 0.3 && needsAfter.healing >= 0.35, '各需求系数都有下界，不会归零');
    for (const value of Object.values(needsAfter)) assert.ok(value > 0 && value <= 1);
    // 结构：AI 权重键必须能对上需求系数，杜绝写错名字静默失效。
    for (const weight of Object.values(SITE_AI)) {
        for (const key of [weight.need, weight.holdNeed, weight.contestNeed]) {
            if (key) assert.ok(key in needsAfter, `需求系数 ${key} 必须存在`);
        }
    }
});

test('AI 选点偏好：同等距离时把建筑放进有奖励的据点（林口/路口/桥头）', () => {
    const scene = campScene();
    const camps = scene.territory.camps;
    scene.territory.econ.treasury.red = 5000;
    // 合成两个等距己方据点：0=桥头（无营建奖励）、1=林口（施工加速）。
    scene.flags = [
        { gx: 100, gy: 100, name: '甲点', role: 'bridge', owner: 'red', progress: 1 },
        { gx: 106, gy: 100, name: '乙点', role: 'forest', owner: 'red', progress: 1 }
    ];
    assert.equal(buildSiteBonus(scene, 'red', 1, 'camp'), 5, '林口：所有施工都更快');
    assert.equal(buildSiteBonus(scene, 'red', 0, 'camp'), 0, '桥头不加快施工');
    const worker = addWorker(scene, 'red', 103, 100);   // 到两点等距
    camps.ai('red');
    assert.equal(worker.workerTask.buildingId, 'camp:red:1', '等距时优先林口');
    // 去掉角色后回到"等距取据点序"的既有口径，证明偏好来自特色表而非偶然。
    scene.flags[1].role = 'plain';
    traitState(scene).refresh();
    const second = addWorker(scene, 'red', 103, 100);
    camps.ai('red');
    assert.equal(second.workerTask.buildingId, 'camp:red:0');
});

test('AI 选点偏好参数克制：折扣不超过 6 格，不会舍近求远', () => {
    const scene = campScene();
    const camps = scene.territory.camps;
    scene.territory.econ.treasury.red = 5000;
    scene.flags = [
        { gx: 100, gy: 100, name: '近点', role: 'plain', owner: 'red', progress: 1 },
        { gx: 130, gy: 100, name: '远林口', role: 'forest', owner: 'red', progress: 1 }
    ];
    const worker = addWorker(scene, 'red', 100.5, 100);
    camps.ai('red');
    assert.equal(worker.workerTask.buildingId, 'camp:red:0', '30 格外的奖励点不会压过就近施工');
    assert.equal(buildSiteBonus(scene, 'red', 1, 'camp'), 5);
});

test('据点被拉过中线（易主到中立）也要有一次简短反馈，且不逐帧重复', () => {
    const scene = campScene();
    const events = [];
    scene.addBattleEvent = (key, text, team) => events.push({ key, text, team });
    const bridge = siteIndexOf(scene, 'bridge', 'red');
    const flag = scene.flags[bridge];
    // 用蓝方部队把进度拉过中线：归属 non-null → null。
    for (let i = 0; i < 6; i++) addUnit(scene, 'blue', 'infantry', flag.gx + (i % 3) * 0.3, flag.gy + Math.floor(i / 3) * 0.3);
    scene.rebuildSpatial();
    for (let i = 0; i < 300 && flag.owner !== null; i++) {
        scene.simulationTime += 1000 / 60;
        updateFlags(scene, 1 / 60);
    }
    assert.equal(flag.owner, null, '被拉过中线即失去归属');
    assert.ok(events.some(e => e.key === `flag-lost-西桥头-red-1` && e.text.includes('失去')),
        '失去据点有一次播报（键含归属变化序数 1）');
    assert.ok(events.some(e => e.key === `trait-lost-西桥头-red-1` && e.text.includes('失效')),
        '特色失效有一次播报');
    const total = events.length;
    for (let i = 0; i < 60; i++) updateFlags(scene, 1 / 60);
    assert.equal(events.length, total, '归属不变时不再重复播报');
    assert.equal(ownsRole(scene, 'red', 'bridge'), false, '失去后奖励即时失效');
    assert.equal(localTrait(scene, 'red', bridge), null);
});

test('驻军拒绝原因：已被摧毁的敌方建筑先说"已摧毁"', () => {
    const scene = campScene();
    const camps = scene.territory.camps;
    const enemyTower = camps.createBuilding('blue', 'tower', siteIndexOf(scene, 'bridge', 'blue'), true);
    camps.damageBuilding(enemyTower, enemyTower.hp * 2, addUnit(scene, 'red', 'infantry', 12, 12));
    assert.equal(enemyTower.dead, true);
    assert.match(camps.garrisonRejectReason('red', enemyTower.id), /已被摧毁/);
});

test('AI 选点折扣有明确边界：折后打平不抢近点，差价够大才多走路', () => {
    const scene = campScene();
    const camps = scene.territory.camps;
    scene.territory.econ.treasury.red = 5000;
    scene.flags = [
        { gx: 100, gy: 100, name: '近点', role: 'plain', owner: 'red', progress: 1 },
        { gx: 115, gy: 100, name: '远林口', role: 'forest', owner: 'red', progress: 1 }
    ];
    // 民夫在中点：近点 5 格（折后 5）对林口 10 格（折后 10-5=5）→ 打平，按据点序取近点。
    const tied = addWorker(scene, 'red', 105, 100);
    camps.ai('red');
    assert.equal(tied.workerTask.buildingId, 'camp:red:0', '折后打平不抢近点');
    assert.equal(buildSiteBonus(scene, 'red', 1, 'camp'), 5);
    // 民夫离近点 6 格、离林口 9 格：9-5=4 < 6 → 值得多走 3 格去吃营建加速。
    const worthIt = addWorker(scene, 'red', 106, 100);
    camps.ai('red');
    assert.equal(worthIt.workerTask.buildingId, 'camp:red:1', '差价够大才绕路');
});
