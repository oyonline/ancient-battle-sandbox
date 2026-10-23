#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { makeScene } from '../tests/battle-harness.js';
import { CAMP_LAYOUT as L } from '../js/siege3d/layout.js';
import { createCampSiege, siegeDeployment, installSiegeArrows } from '../js/siege3d/deployment.js';
import { campBounds, queueCampWalls } from '../js/siege3d/walls.js';

export function step(scene, count = 1) {
    for (let i = 0; i < count && !scene.battleOver; i++) {
        scene.simulationTime += 1000 / 60;
        scene.stepBattle(1 / 60);
    }
}
export function deployVariant({ variant = 1, jitter = .3, bonus = L.rules.defenderMoraleBonus, seed = 173 } = {}) {
    const s = makeScene();
    installSiegeArrows(s);
    s.deployUnits(L.attackers, L.defenders, 'custom', 'custom', { red: 'advance', blue: 'advance' }, { terrain: 'flat' });
    const b = campBounds();
    s.siege = createCampSiege(b, { ladders: true, rules: { defenderMoraleBonus: bonus }, scatterSeed: (seed + variant) >>> 0 });
    let state = (seed + Math.imul(variant, 2654435761)) >>> 0;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    for (const { unit, gx, gy, siegeAnchor } of siegeDeployment(s.units, b, s.siege)) {
        const x = gx + (unit.team === 'red' ? (random() * 2 - 1) * jitter : 0);
        const y = gy + (unit.team === 'red' ? (random() * 2 - 1) * jitter : 0);
        Object.assign(unit, { gx: x, gy: y, pgx: x, pgy: y, siegeAnchor });
    }
    queueCampWalls(s); s.rebuildSpatial();
    return s;
}
export function resultOf(s, variant) {
    const casualties = team => ({ dead: s.battleStats[team].lost,
        routingAtOutcome: s.siege.rules.routedAtOutcome?.[team] ?? 0,
        routing: s.units.filter(u => !u.dead && !u.withdrawn && u.team === team && u.moraleState === 'routing').length,
        withdrawn: s.battleStats[team].withdrawn, alive: s.battleStats[team].alive });
    return { variant, winner: s.winner ?? null, reason: s.endReason ?? '超时未决', seconds: +(s.simulationTime / 1000).toFixed(3),
        red: casualties('red'), blue: casualties('blue'), attackerLossRate: s.siege.rules.attackerLossRate, gateHp: s.siege.gate.hp, landed: s.siege.landedCount };
}
export function summarize(results) {
    const wins = results.filter(r => r.winner === 'blue');
    const sum = (rows, f) => rows.reduce((total, r) => total + f(r), 0);
    const ratio = (numerator, denominator) => denominator ? numerator / denominator : numerator ? 'Infinity (zero defender losses)' : null;
    return { games: results.length, defenderWins: wins.length, defenderWinRate: wins.length / results.length,
        // Fatal casualties, excluding end-of-game surrender/withdrawal; also report the trigger metric separately.
        defenderWinDeathRatio: ratio(sum(wins, r => r.red.dead), sum(wins, r => r.blue.dead)),
        defenderWinCasualtyRatio: ratio(sum(wins, r => r.red.dead + r.red.routingAtOutcome), sum(wins, r => r.blue.dead + r.blue.routingAtOutcome)),
        defenderWinMeanAttackerLossRate: sum(wins, r => r.attackerLossRate) / (wins.length || 1),
        averageSeconds: sum(results, r => r.seconds) / results.length,
        reasons: Object.fromEntries([...new Set(results.map(r => r.reason))].map(reason => [reason, results.filter(r => r.reason === reason).length])) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2), get = (key, fallback) => args.includes(key) ? Number(args[args.indexOf(key) + 1]) : fallback;
    const games = get('--games', 20), start = get('--start', 1), maxSeconds = get('--max-seconds', 360);
    const options = { seed: get('--seed', 173), jitter: get('--jitter', .3), bonus: get('--bonus', L.rules.defenderMoraleBonus) };
    if (![games, start, maxSeconds, options.seed, options.jitter, options.bonus].every(Number.isFinite) ||
        !Number.isInteger(games) || games < 1 || options.jitter < 0 || options.jitter > .3 || options.bonus < 0 || maxSeconds <= 0) {
        throw new Error('Invalid arguments: --games N --start N --seed N --jitter 0..0.3 --bonus >=0 --max-seconds >0');
    }
    console.log(JSON.stringify({ options, games, start, maxSeconds }));
    const results = [];
    for (let variant = start; variant < start + games; variant++) {
        const s = deployVariant({ ...options, variant });
        step(s, Math.ceil(maxSeconds * 60));
        const result = resultOf(s, variant); results.push(result); console.log(JSON.stringify(result));
    }
    console.log(JSON.stringify({ summary: summarize(results) }));
}
