import test from 'node:test';
import assert from 'node:assert/strict';
import { runBattle, runPair, pureArmy } from '../tools/balance-report.js';
import { makeScene, addUnit, UNIT_TYPES, calculateAttackDamage } from './battle-harness.js';

// Test the stated counters at equal cost, in both player seats and two army sizes.
// These are behavioral bounds, not snapshots of exact casualties or tuning values.
for (const budget of [240, 600]) {
    for (const [counter, target] of [['pikeman', 'cavalry'], ['cavalry', 'archer'], ['cavalry', 'infantry']]) {
        test(`${budget} gold: ${counter} counters ${target} in either player seat`, () => {
            const [forward, reversed] = runPair(pureArmy(counter, budget), pureArmy(target, budget));
            assert.equal(forward.winner, 'red');
            assert.equal(reversed.winner, 'blue');
            assert.ok(forward.survivors.red > 0 && reversed.survivors.blue > 0);
        });
    }
}

test('cavalry tuning: defense 10 lets swords deal real attrition; charge identity untouched', () => {
    const scene = makeScene();
    const sword = addUnit(scene, 'red', 'infantry');
    const cavalry = addUnit(scene, 'blue', 'cavalry');
    // 最小平衡方案（2026-10-03）：只降骑兵防御 15→10——剑士普通命中从 1（磨不动）
    // 升到 6（真实战损）；其余身份参数（生命/速度/攻击/攻速/造价/冲锋速度）钉住不动。
    assert.equal(calculateAttackDamage(sword, cavalry), 6, '剑士普通命中 16-10=6（旧 15 甲下仅 1）');
    assert.equal(calculateAttackDamage(cavalry, sword), 20, '骑兵普通命中 30-10 不变');
    const data = UNIT_TYPES.cavalry;
    assert.deepEqual(
        { hp: data.hp, atk: data.atk, def: data.def, speed: data.speed, atkSpeed: data.atkSpeed, cost: data.cost, chargeSpeed: data.chargeSpeed },
        { hp: 160, atk: 30, def: 10, speed: 4.0, atkSpeed: 1500, cost: 12, chargeSpeed: 6.0 },
        '首轮只动防御：其余骑兵参数不得漂移');
});

test('mirrored identical mixed armies finish with comparable remaining strength', () => {
    const army = { infantry: 12, pikeman: 10, archer: 15, cavalry: 5 };
    const result = runBattle(army, army);
    assert.notEqual(result.winner, 'timeout');
    // A tiny residual from spatial ties is acceptable; a surviving fighting force is not.
    assert.ok(Math.abs(result.remainingValue.red - result.remainingValue.blue) <= 15,
        `mirrored armies retain unequal fighting strength: ${JSON.stringify(result.remainingValue)}`);
});

test('a pike-heavy mixed square defeats equal-cost cavalry in either player seat', () => {
    // The actual square interleaves archers among spears; it is not an all-pikes
    // front screen and should not promise a fixed number of surviving archers.
    const [forward, reversed] = runPair({ pikeman: 80, archer: 15 }, { cavalry: 50 }, 'square', 'wedge');
    assert.equal(forward.winner, 'red');
    assert.equal(reversed.winner, 'blue');
    assert.equal(forward.survivors.red, reversed.survivors.blue);
});

function protectionBattle(frontType, mirror) {
    const scene = makeScene();
    const screen = { pikeman: 80, archer: 15 }, cavalry = { cavalry: 50 };
    const team = mirror ? 'blue' : 'red';
    scene.deployUnits(mirror ? cavalry : screen, mirror ? screen : cavalry,
        mirror ? 'wedge' : 'square', mirror ? 'square' : 'wedge');
    // Swap only who occupies the existing formation slots: same army, budget,
    // ground, density and opponent. This isolates protection from army strength.
    const units = scene.units.filter(unit => unit.team === team);
    const slots = units.map(({ gx, gy }) => ({ gx, gy }));
    units.sort((a, b) => Number(b.type === frontType) - Number(a.type === frontType) || a.id - b.id);
    units.forEach((unit, i) => Object.assign(unit, slots[i], { pgx: slots[i].gx, pgy: slots[i].gy }));
    let firstHit = Infinity;
    const recordDamage = scene.recordDamage.bind(scene);
    scene.recordDamage = (target, damage, from) => {
        if (target.type === 'archer' && from?.type === 'cavalry') firstHit = Math.min(firstHit, scene.simulationTime);
        recordDamage(target, damage, from);
    };
    scene.battleStarted = true;
    for (let i = 0; i < 14400 && !scene.battleOver; i++) scene.advanceBattle(1000 / 60);
    assert.ok(scene.battleOver, 'the protection comparison must finish, not time out');
    const report = scene.getBattleReport();
    return { winner: scene.winner, team, firstHit, alive: report.teams[team].alive,
        archerDamage: report.teams[team].byType.archer.damage };
}

test('spears in front delay cavalry reaching archers and improve the same army’s outcome', () => {
    const results = [];
    for (const mirror of [false, true]) {
        const protectedArmy = protectionBattle('pikeman', mirror);
        const exposedArmy = protectionBattle('archer', mirror);
        assert.equal(protectedArmy.winner, protectedArmy.team);
        // 骑兵防御 15→10 后不再能磨穿枪基军队：弓手裸布的同军也常惨胜——判据从
        // "裸布必败"改为"胜也惨胜"（存活不及受保护布阵的一半），且时间/输出/存活
        // 三项保护收益仍各有硬断言。
        assert.ok(exposedArmy.alive <= Math.floor(protectedArmy.alive / 2),
            `archers exposed to the charge cost the army over half its survivors (exposed ${exposedArmy.alive} vs protected ${protectedArmy.alive})`);
        assert.ok(protectedArmy.firstHit >= exposedArmy.firstHit + 2000, 'a real screen buys time to shoot');
        assert.ok(protectedArmy.archerDamage > exposedArmy.archerDamage,
            'the screen buys real ranged output even if later morale collapse exposes the archers');
        assert.ok(protectedArmy.alive > exposedArmy.alive);
        results.push({ protectedArmy, exposedArmy });
    }
    for (const field of ['firstHit', 'alive', 'archerDamage']) {
        assert.equal(results[0].protectedArmy[field], results[1].protectedArmy[field]);
        assert.equal(results[0].exposedArmy[field], results[1].exposedArmy[field]);
    }
});
