// Run the actual battle simulation with drawing stubbed by the shared test harness.
// Usage: node tools/balance-report.js [--budgets=240,600] [--mixed]
const { performance } = require('node:perf_hooks');
const { makeScene, UNIT_TYPES } = require('../tests/battle-harness.js');

function runBattle(red, blue, redFormation = 'custom', blueFormation = 'custom', options = {}) {
    const scene = makeScene();
    scene.deployUnits(red, blue, redFormation, blueFormation, options.orders || {}, options);
    scene.battleStarted = true;
    const maxSteps = (options.seconds ?? 240) * 60;
    for (let step = 0; step < maxSteps && !scene.battleOver; step++) scene.advanceBattle(1000 / 60);
    const report = scene.getBattleReport();
    const remainingValue = team => scene.units.filter(unit => !unit.dead && !unit.withdrawn && unit.team === team)
        .reduce((sum, unit) => sum + unit.typeData.cost * unit.hp / unit.maxHp, 0);
    return {
        winner: scene.winner || 'timeout',
        seconds: report.durationMs / 1000,
        survivors: { red: report.red, blue: report.blue },
        remainingValue: { red: remainingValue('red'), blue: remainingValue('blue') },
        report
    };
}

function pureArmy(type, budget) {
    const count = budget / UNIT_TYPES[type].cost;
    if (!Number.isInteger(count) || count > UNIT_TYPES[type].maxCount) {
        throw new Error(`Budget ${budget} cannot buy a legal full-budget ${type} army`);
    }
    return { [type]: count };
}

function runPair(red, blue, redFormation = 'custom', blueFormation = 'custom', options = {}) {
    // 地图位置保持不变：比较军队换边后的攻守表现；镜像公平由独立测试覆盖。
    const swapped = { ...options, orders: { red: options.orders?.blue, blue: options.orders?.red },
        cavalryOrders: { red: options.cavalryOrders?.blue, blue: options.cavalryOrders?.red },
        reserves: { red: options.reserves?.blue, blue: options.reserves?.red } };
    return [runBattle(red, blue, redFormation, blueFormation, options),
        runBattle(blue, red, blueFormation, redFormation, swapped)];
}

if (require.main === module) {
    const budgets = (process.argv.find(arg => arg.startsWith('--budgets='))?.split('=')[1] || '240,600')
        .split(',').map(Number);
    const types = Object.keys(UNIT_TYPES);
    const started = performance.now();
    let battles = 0;
    function output(label, a, b, aFormation = 'custom', bFormation = 'custom') {
        const pair = runPair(a, b, aFormation, bFormation);
        battles += 2;
        console.log(JSON.stringify({ label, armies: [a, b], formations: [aFormation, bFormation],
            results: pair.map(({ winner, seconds, survivors, remainingValue }) => ({ winner, seconds, survivors, remainingValue })) }));
    }
    for (const budget of budgets) {
        for (let i = 0; i < types.length; i++) {
            for (let j = i + 1; j < types.length; j++) {
                output(`budget-${budget}`, pureArmy(types[i], budget), pureArmy(types[j], budget));
            }
        }
    }
    if (process.argv.includes('--mixed')) {
        const balanced = { infantry: 24, pikeman: 20, archer: 30, cavalry: 10 };
        for (const pikeman of [40, 60, 80]) {
            const guardedArchers = { pikeman, archer: (600 - pikeman * UNIT_TYPES.pikeman.cost) / UNIT_TYPES.archer.cost };
            output(`pike-screen-${pikeman}-vs-cavalry`, guardedArchers, { cavalry: 50 }, 'square', 'wedge');
        }
        output('mixed-mirror', balanced, balanced, 'custom', 'custom');
        output('mixed-formations', balanced, balanced, 'square', 'wedge');
    }
    console.log(JSON.stringify({ summary: { battles, wallSeconds: (performance.now() - started) / 1000 } }));
}

module.exports = { runBattle, runPair, pureArmy };
