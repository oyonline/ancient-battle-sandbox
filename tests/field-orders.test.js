import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeScene, addUnit } from './battle-harness.js';
import { board } from '../js/board.js';
import { CombatRules } from '../js/combat.js';
import { dist } from '../js/units.js';
import { quantizeDecision as q } from '../js/battle/determinism.js';
import { applyFieldOrder, updateFieldOrder, FIELD_ORDER_RADIUS } from '../js/battle/field-orders.js';
import { battleProjection, hashProjection } from '../js/net/lockstep.js';

const STEP = 1000 / 60;
const command = (side, order) => ({ k: 'fieldOrder', side, order });
const hash = s => hashProjection(battleProjection(s));
const army = { infantry: 6, pikeman: 2, archer: 2, cavalry: 2 };
function scene(orders = { red: 'flank', blue: 'hold_ground' }, options = {}) {
    const s = makeScene();
    s.deployUnits(army, army, 'custom', 'custom', orders,
        { terrain: 'flat', net: true, mySide: 'red', seed: 731, ...options });
    return s;
}
function step(s) { s.simulationTime += STEP; s.stepBattle(STEP / 1000); }

// 在未修改的 c8e3dcd 现场采集，同一 fixture / 默认坐标播种；长度 + SHA256 锁完整投影。
test('a 无命令：0–720 步投影与 c8e3dcd 指纹逐字一致', () => {
    const golden = [
        [1450, '2dd1b86744d6401af8332f4d87e00c268831ca6a7e7ac8f7e34f107d74109ecb'],
        [1453, '926ef6e9a218f2c666270a7908ca01b23bb560beb75544f277e9024afa01344f'],
        [1453, '963ebcf3adf38578dcf1893e90dffbda7aa47231872789963c6a028ecd3c9023'],
        [1438, '09a3d447e0077754217c7a830acedf743ad51f3d95a0c67ef488d68b22e52dba'],
        [1383, '832a7017d2e0bbbc98ef8c99dd919a86fcb20339335ede212225e32134eea332'],
        [1382, '8045f162d30231918a2eb9f6cbe6d63ba37fff64835fce7e6f8e089f9c63091b'],
        [1322, '22118d63ac89ef1b8c27eb7bc60728aeda42fe4c84c34c5412d95d13f8f028d1']
    ];
    const s = scene();
    for (let turn = 0; turn <= 720; turn++) {
        if (turn % 120 === 0) {
            const p = battleProjection(s);
            assert.deepEqual([p.length, createHash('sha256').update(p).digest('hex')], golden[turn / 120], `turn ${turn}`);
            assert.equal(s.fieldOrders, undefined);
        }
        step(s);
    }
});

test('b hold：执行位置量化、重复不重拍、无敌回锚、圈外放弃、路由后恢复回锚', () => {
    const s = makeScene();
    const u = addUnit(s, 'red', 'infantry', 10.123456, 12.234567);
    const enemy = addUnit(s, 'blue', 'infantry', 60, 12);
    s.simulationTime = 500;
    assert.equal(applyFieldOrder(s, command('red', 'hold')), true);
    const anchor = { ...u.fieldOrderAnchor };
    assert.deepEqual(anchor, { gx: 10.1235, gy: 12.2346 });
    u.gx += 2;
    assert.equal(applyFieldOrder(s, command('red', 'hold')), false);
    assert.deepEqual(u.fieldOrderAnchor, anchor);
    for (let i = 0; i < 100; i++) updateFieldOrder(s, u, 500, 1 / 60);
    assert.ok(Math.hypot(u.gx - anchor.gx, u.gy - anchor.gy) <= 0.325);
    enemy.gx = anchor.gx + 2;
    enemy.gy = anchor.gy;
    u.gx = anchor.gx + 4;
    const before = u.gx;
    updateFieldOrder(s, u, 500, 1 / 60);
    assert.equal(u.target, null);
    assert.ok(u.gx < before);
    u.moraleState = 'routing';
    assert.equal(updateFieldOrder(s, u, 500, 1 / 60), false);
    let routed = 0;
    s.updateRoutedUnit = () => { routed++; };
    step(s);
    assert.equal(routed, 1, 'core 仍把溃兵交给士气通道');
    u.moraleState = 'steady'; enemy.gx = 60;
    const recovery = u.gx;
    step(s);
    assert.ok(u.gx < recovery, '恢复后回原锚点');
    assert.deepEqual(u.fieldOrderAnchor, anchor);
});

test('b hold：近敌按距离/id，所有兵种不越 R+1，弓手延时放箭', () => {
    const s = makeScene();
    const held = ['infantry', 'pikeman', 'archer', 'cavalry'].map((type, i) => addUnit(s, 'red', type, 15, 8 + i * 10));
    const foes = held.map(u => addUnit(s, 'blue', 'infantry', u.gx + 2.4, u.gy));
    const tie = addUnit(s, 'blue', 'infantry', 17.4, 8);
    applyFieldOrder(s, command('red', 'hold'));
    s.rebuildSpatial();
    updateFieldOrder(s, held[0], 0, 1 / 60);
    assert.equal(held[0].target, foes[0]);
    assert.ok(foes[0].id < tie.id);
    const archer = held[2], archerFoe = foes[2];
    archerFoe.gx = archer.gx + Math.min(5, archer.typeData.range - 0.1);
    let arrows = 0;
    const fire = s.fireArrow.bind(s);
    s.fireArrow = (...args) => { arrows++; return fire(...args); };
    // 把边缘单位放到圈内最外沿，分离推力也不得越界。
    held[3].gx += FIELD_ORDER_RADIUS + 0.99;
    for (let turn = 0; turn < 240; turn++) {
        step(s);
        for (const u of held) if (!u.dead && u.moraleState !== 'routing') {
            const radius = u.type === 'archer' ? Math.max(FIELD_ORDER_RADIUS, u.typeData.range) : FIELD_ORDER_RADIUS;
            assert.ok(Math.hypot(u.gx - u.fieldOrderAnchor.gx, u.gy - u.fieldOrderAnchor.gy) <= radius + 1 + 1e-9);
        }
    }
    assert.ok(arrows > 0, 'hold 弓手使用真实箭矢链');
});

test('c advance：守阵/迂回含预备队/高地/坡道释放，仅本方进入自由接敌，切换幂等', () => {
    for (const tactic of ['hold', 'flank', 'hold_ground', 'advance']) {
        const s = scene({ red: tactic, blue: 'hold_ground' }, { terrain: tactic === 'advance' ? 'red_pass' : 'flat', reserves: { red: tactic === 'flank' ? 2 : 0 } });
        const red = s.units.filter(u => u.team === 'red'), blue = s.units.filter(u => u.team === 'blue');
        const oldBlue = blue.map(u => [u.tacticalRole, u.guardAnchor, u.formationSlot]);
        assert.ok(red.some(u => u.tacticalRole || u.slopeApproach), tactic);
        assert.equal(applyFieldOrder(s, command('red', 'advance')), true);
        for (const u of red) {
            assert.equal(u.tacticalRole, undefined); assert.equal(u.slopeApproach, undefined);
            assert.equal(u.guardAnchor, undefined); assert.equal(u.rallyWaiting, false);
        }
        assert.equal(s.tactics.formations.red, undefined);
        assert.equal(s.tactics.groups.red, undefined);
        assert.equal(s.tactics.groundGuards.red, undefined);
        assert.deepEqual(blue.map(u => [u.tacticalRole, u.guardAnchor, u.formationSlot]), oldBlue);
        const baseline = hash(s);
        assert.equal(applyFieldOrder(s, command('red', 'advance')), false);
        assert.equal(hash(s), baseline);
        let normal = 0, cavalry = 0;
        const update = s.updateNormalUnit.bind(s), charge = s.cavalryAI.update.bind(s.cavalryAI);
        s.updateNormalUnit = (u, ...args) => { if (u.team === 'red') normal++; return update(u, ...args); };
        s.cavalryAI.update = (u, ...args) => { if (u.team === 'red') cavalry++; return charge(u, ...args); };
        step(s);
        assert.ok(normal > 0 && cavalry > 0, '进入默认普通接敌/骑兵分支');
        assert.ok(red.some(u => u.moving), '实际开始接敌移动');
        applyFieldOrder(s, command('red', 'hold'));
        assert.ok(red.every(u => u.fieldOrderAnchor));
        applyFieldOrder(s, command('red', 'advance'));
        assert.ok(red.every(u => !u.fieldOrderAnchor));
    }
});

test('r1 hold：双方首回合 hold，或开局守阵/高地与 fieldOrder hold，10 秒无伤后相持终局', () => {
    for (const tactic of ['advance', 'hold', 'hold_ground']) {
        // 枪阵守位只接管长枪兵；混编中的剑/弓/骑仍会主动接敌，不是无接触相持。
        const redArmy = tactic === 'hold' ? { pikeman: army.pikeman } : army;
        const s = makeScene();
        s.deployUnits(redArmy, army, 'custom', 'custom', { red: tactic, blue: 'advance' },
            { terrain: 'flat', net: true, mySide: 'red', seed: 731 });
        assert.ok(!s.battleOptions.deathmatch);
        if (tactic === 'advance') applyFieldOrder(s, command('red', 'hold'));
        applyFieldOrder(s, command('blue', 'hold'));
        let turn = 0;
        while (!s.battleOver && turn < 1800) { step(s); turn++; }
        assert.equal(s.battleOver, true, `${tactic}: 必须在 30 秒内终局`);
        assert.equal(s.endReason, 'stalemate', tactic);
        assert.equal(s.winner, 'draw');
        assert.ok(s.simulationTime >= 10000, '保留 10 秒宽限');
        assert.equal(s.battleStats.red.damage + s.battleStats.blue.damage, 0);
        assert.doesNotThrow(() => s.tactics.breakStalemate(), '死斗解除旧战术时容许 fieldOrder hold');
        console.log(`r1 stalemate ${tactic}: ${turn} steps, ${s.simulationTime.toFixed(2)}ms`);
    }
});

test('r2 hold：混编枪阵中的非长枪兵仍接敌，持续交战不得判相持', () => {
    const s = scene({ red: 'hold', blue: 'advance' });
    applyFieldOrder(s, command('blue', 'hold'));
    const free = s.units.filter(u => u.team === 'red' && u.type !== 'pikeman');
    assert.equal(free.length, 10);
    assert.ok(free.every(u => !u.tacticalRole && !u.fieldOrderAnchor));
    let moved = false, arrows = false, queued = false;
    let lastDamage = 0, lastDamageTurn = 0;
    for (let turn = 1; turn <= 1800 && !s.battleOver; turn++) {
        step(s);
        moved ||= free.some(u => u.moving);
        arrows ||= s.arrows.length > 0;
        queued ||= s.battleQueue.length > 0;
        const damage = s.battleStats.red.damage + s.battleStats.blue.damage;
        if (damage > lastDamage) lastDamageTurn = turn;
        lastDamage = damage;
    }
    assert.ok(moved && arrows && queued, '必须覆盖普通单位移动、真实箭矢与延时攻击');
    assert.ok(s.battleStats.red.damage > 0 && s.battleStats.blue.damage > 0);
    assert.ok(lastDamageTurn > 1200, '30 秒检查前的 10 秒内仍有伤害');
    assert.equal(s.battleOver, false);
    assert.equal(s.tactics.stalemateSince, null);
});

test('r1 hold：冲锋/穿透中改令沿用 enterMelee，若干步后无骑兵 charge/pierce', () => {
    const s = scene({ red: 'advance', blue: 'advance' });
    for (let i = 0; i < 120; i++) step(s);
    const riders = s.units.filter(u => u.team === 'red' && u.type === 'cavalry');
    assert.ok(riders.every(u => u.state === 'charge' && u.chargeDistance > 0), '真实助跑中');
    riders[1].state = 'pierce';
    riders[1].chargeMomentum = 1;
    let ended = 0;
    const enterMelee = s.cavalryAI.enterMelee.bind(s.cavalryAI);
    s.cavalryAI.enterMelee = u => { ended++; enterMelee(u); };
    applyFieldOrder(s, command('red', 'hold'));
    assert.equal(ended, riders.length);
    for (let i = 0; i < 180; i++) step(s);
    for (const u of riders) {
        assert.equal(u.state, 'melee');
        assert.equal(u.chargeDistance, 0);
        assert.equal(u.chargeMomentum, 0);
    }
});

// 评审前的全表选敌器：保留原量化阈值、严格距离比较和 id 平局规则。
function legacyHoldTarget(s, u) {
    const anchor = u.fieldOrderAnchor;
    const radius = u.type === 'archer' ? Math.max(FIELD_ORDER_RADIUS, u.typeData.range) : FIELD_ORDER_RADIUS;
    let target = null, nearest = Infinity;
    if (q(dist(u, anchor)) <= q(radius + 1)) for (const enemy of s.units) {
        if (enemy.team === u.team || !CombatRules.canBeHit(enemy) || q(dist(anchor, enemy)) > q(radius)) continue;
        const distance = q(dist(u, enemy));
        if (distance < nearest || (distance === nearest && enemy.id < target.id)) {
            target = enemy; nearest = distance;
        }
    }
    return target;
}

test('r1 hold：半量子圈边跨桶、严格距离与同距 id，不依赖候选遍历序', () => {
    for (const type of ['infantry', 'archer']) {
        const s = makeScene();
        const u = addUnit(s, 'red', type, type === 'archer' ? 2.46 : 9.46, 12);
        const radius = type === 'archer' ? u.typeData.range : FIELD_ORDER_RADIUS;
        const lowId = addUnit(s, 'blue', 'infantry', u.gx + radius + 0.024, u.gy);
        const highId = addUnit(s, 'blue', 'infantry', lowId.gx - 0.001, u.gy);
        const outside = addUnit(s, 'blue', 'infantry', u.gx + radius + 0.026, u.gy);
        applyFieldOrder(s, command('red', 'hold'));
        // 跨到下一空间桶，且同量化距离的较小 id 最后遍历。
        const near = s.forEachNear.bind(s);
        s.forEachNear = (x, y, r, visit) => {
            const candidates = [];
            near(x, y, r, e => candidates.push(e));
            candidates.sort((a, b) => b.id - a.id).forEach(visit);
        };
        s.rebuildSpatial();
        updateFieldOrder(s, u, 0, 0);
        assert.equal(u.target, lowId);
        assert.equal(u.target, legacyHoldTarget(s, u));
        highId.gx = u.gx + radius - 0.1;
        s.rebuildSpatial();
        updateFieldOrder(s, u, 0, 0);
        assert.equal(u.target, highId, '严格更近者优先于较小 id');
        lowId.dead = highId.withdrawn = true;
        s.rebuildSpatial();
        updateFieldOrder(s, u, 0, 0);
        assert.equal(u.target, null, `圈外 ${outside.id} 不可选`);
    }
});

test('r1 hold：同一对局 720 步每次选敌与旧全表实现一致，倒序桶候选不改投影', () => {
    const current = scene({ red: 'advance', blue: 'advance' });
    const legacy = scene({ red: 'advance', blue: 'advance' });
    // 一方原地 hold，另一方接近，随后双方 hold，覆盖回锚、交战和伤亡。
    for (const s of [current, legacy]) applyFieldOrder(s, command('red', 'hold'));
    for (let i = 0; i < 600; i++) { step(current); step(legacy); }
    for (const s of [current, legacy]) applyFieldOrder(s, command('blue', 'hold'));
    let comparisons = 0, engaged = 0;
    for (const [s, fullScan] of [[current, false], [legacy, true]]) {
        const pending = new Map();
        for (const u of s.units) {
            let target = u.target;
            Object.defineProperty(u, 'target', {
                configurable: true, enumerable: true,
                get: () => target,
                set(value) {
                    if (pending.has(u)) {
                        assert.equal(value, pending.get(u), `unit ${u.id} at ${s.simulationTime}`);
                        pending.delete(u);
                        comparisons++;
                        if (value) engaged++;
                    }
                    target = value;
                }
            });
        }
        const near = s.forEachNear.bind(s);
        s.forEachNear = (x, y, r, visit) => {
            const holdUnit = s.units.find(u => u.fieldOrderAnchor?.gx === x && u.fieldOrderAnchor?.gy === y &&
                r === (u.type === 'archer' ? Math.max(FIELD_ORDER_RADIUS, u.typeData.range) : FIELD_ORDER_RADIUS) + 0.025);
            if (!holdUnit) return near(x, y, r, visit);
            const expected = legacyHoldTarget(s, holdUnit);
            pending.set(holdUnit, expected);
            if (fullScan) s.units.forEach(visit);
            else {
                const candidates = [];
                near(x, y, r, e => candidates.push(e));
                candidates.reverse().forEach(visit);
            }
        };
    }
    for (let i = 0; i < 720; i++) {
        step(current); step(legacy);
        assert.equal(battleProjection(current), battleProjection(legacy), `step ${i}`);
    }
    assert.ok(comparisons > 1000 && engaged > 0, '必须覆盖实际近敌选择');
    console.log(`r1 target equivalence: ${comparisons} selections, ${engaged} engaged`);
});

test('d 独立两端：不同帧节奏，同回合 advance→hold→advance，每120步哈希及终局一致', () => {
    const orders = [[60, 'red', 'advance'], [120, 'red', 'hold'], [240, 'red', 'advance'], [300, 'blue', 'hold'], [900, 'blue', 'advance']];
    function run(pulses, side) {
        const s = scene({ red: 'flank', blue: 'hold_ground' }, { mySide: side });
        const hashes = [], applied = [];
        let turn = 0, frame = 0, accumulator = 0;
        while (!s.battleOver && turn < 36000) {
            accumulator += pulses[frame++ % pulses.length];
            while (accumulator + 1e-7 >= STEP && !s.battleOver) {
                accumulator -= STEP;
                for (const [at, team, order] of orders) if (turn === at) {
                    assert.equal(applyFieldOrder(s, command(team, order)), true);
                    applied.push(turn);
                }
                step(s); turn++;
                if (turn % 120 === 0) hashes.push([turn, hash(s)]);
            }
        }
        assert.equal(s.battleOver, true, '必须跑到真实终局');
        assert.deepEqual(applied, orders.map(o => o[0]));
        console.log(`d ${side}: ${turn} steps, ${s.endReason}, winner=${s.winner}`);
        return { hashes, turn, winner: s.winner, endReason: s.endReason, final: hash(s) };
    }
    assert.deepEqual(run([STEP], 'red'), run([7, 43, 11, 29], 'blue'));
});

for (const order of ['hold', 'advance']) test(`e 左右对称 field3d 换座镜像：${order}`, () => {
    function setup(side) {
        const s = scene({ red: side === 'red' ? 'hold_ground' : 'advance', blue: side === 'blue' ? 'hold_ground' : 'advance' });
        return s;
    }
    const a = setup('red'), b = setup('blue');
    const pairs = ['red', 'blue'].flatMap(team => {
        const us = a.units.filter(u => u.team === team), them = b.units.filter(u => u.team !== team);
        assert.equal(us.length, them.length);
        return us.map((u, i) => [u, them[i]]);
    });
    for (let turn = 0; turn < 1500; turn++) {
        if (turn === 60) {
            applyFieldOrder(a, command('red', order)); applyFieldOrder(b, command('blue', order));
        }
        step(a); step(b);
        for (const [x, y] of pairs) {
            assert.equal(x.type, y.type);
            for (const [left, right, label] of [[x.gx + y.gx, board.W, 'x'], [x.gy, y.gy, 'y'], [x.hp, y.hp, 'hp'], [x.morale, y.morale, 'morale']]) {
                assert.ok(Math.abs(left - right) <= 1e-9, `${order} turn ${turn} #${x.id} ${label}: ${left}/${right}`);
            }
            assert.equal(x.dead, y.dead); assert.equal(x.moraleState, y.moraleState);
        }
    }
});

test('f 白名单、territory/coop 忽略；新命令与锚点均可被投影检出', () => {
    const s = scene(), baseline = battleProjection(s);
    for (const bad of [null, {}, command('black', 'hold'), command('RED', 'hold'), command('red', 'retreat'), { side: 'red', order: 'hold' }]) {
        assert.equal(applyFieldOrder(s, bad), false);
        assert.equal(battleProjection(s), baseline);
        assert.equal(s.fieldOrders, undefined);
    }
    applyFieldOrder(s, command('red', 'hold'));
    const held = battleProjection(s);
    assert.notEqual(held, baseline);
    s.units[0].fieldOrderAnchor.gx += 0.1;
    assert.notEqual(battleProjection(s), held);
    s.units[0].fieldOrderAnchor.gx -= 0.1;
    s.fieldOrders.blue = 'advance';
    assert.notEqual(battleProjection(s), held);
    for (const coop of [false, true]) {
        const t = scene({}, { territory: true, coop, terrain: 'flat', territoryAI: false, ...(coop ? { black: { infantry: 1 } } : {}) });
        const before = battleProjection(t);
        assert.equal(applyFieldOrder(t, command('red', 'hold')), false);
        assert.equal(t.fieldOrders, undefined);
        assert.equal(battleProjection(t), before);
    }
});
