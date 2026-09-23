const test = require('node:test');
const assert = require('node:assert/strict');
const { runBattle, runPair, pureArmy } = require('../tools/balance-report.js');
const { makeScene } = require('./battle-harness.js');

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
        assert.notEqual(exposedArmy.winner, exposedArmy.team);
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
