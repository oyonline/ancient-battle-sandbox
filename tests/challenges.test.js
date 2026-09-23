const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { context, makeScene, UNIT_TYPES, snapshot } = require('./battle-harness.js');

vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js/challenges.js'), 'utf8') +
    '\nthis.challengeAPI = { CHALLENGES, fitArmyToBudget, armyCost };', context);
const { CHALLENGES, fitArmyToBudget, armyCost } = context.challengeAPI;
// Read the actual UI presets without initializing DOM handlers or audio.
const { presets } = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js/ui.js'), 'utf8') +
    '\n({ presets: PRESETS });');

function assertLegalArmy(army, budget) {
    for (const [key, type] of Object.entries(UNIT_TYPES)) {
        const count = army[key] ?? 0;
        assert.ok(Number.isInteger(count) && count >= 0 && count <= type.maxCount, `${key} count is legal`);
    }
    assert.ok(armyCost(army) <= budget, 'army stays within the budget');
}

test('every real UI preset fits every challenge budget without changing its saved composition', () => {
    for (const preset of Object.values(presets)) {
        const original = snapshot(preset.config);
        for (const budget of [0, ...CHALLENGES.map(challenge => challenge.budget), 4000]) {
            const fitted = fitArmyToBudget(preset.config, budget);
            assertLegalArmy(fitted, budget);
            if (armyCost(preset.config) <= budget) assert.deepEqual(snapshot(fitted), original);
        }
        assert.deepEqual(snapshot(preset.config), original);
    }
});

test('budget fitting enforces unit caps and normalizes fractional, negative, or invalid counts', () => {
    const capped = fitArmyToBudget({ infantry: 99999, pikeman: 99999, archer: 99999, cavalry: 99999 }, 100000);
    for (const [type, data] of Object.entries(UNIT_TYPES)) assert.equal(capped[type], data.maxCount);
    assert.deepEqual(snapshot(fitArmyToBudget({ infantry: 9.8, pikeman: -1, archer: Infinity, cavalry: NaN }, 100)), {
        infantry: 9, pikeman: 0, archer: 0, cavalry: 0
    });
    assertLegalArmy(fitArmyToBudget(capped, 300), 300);
});

test('challenge identities and fixed enemy armies are valid', () => {
    assert.equal(CHALLENGES.length, 5);
    assert.equal(new Set(CHALLENGES.map(challenge => challenge.id)).size, CHALLENGES.length);
    for (const challenge of CHALLENGES) {
        assert.ok(Number.isInteger(challenge.budget) && challenge.budget > 0);
        assertLegalArmy(challenge.enemy, Infinity);
        assert.ok(Object.values(challenge.enemy).reduce((sum, count) => sum + count, 0) > 0);
    }
});

// These are example solutions, not prescribed player answers. All use the actual
// deployment, spawnUnit, spatial search, cavalry AI, damage, arrows, and fixed steps.
const solutions = {
    'hold-the-charge': { pikeman: 45, infantry: 6 },
    'break-the-volley': { cavalry: 40 },
    'mixed-front': { infantry: 33, pikeman: 16, archer: 41, cavalry: 8 },
    // A small infantry screen keeps the archers firing while the enemy closes.
    outnumbered: { infantry: 24, archer: 85 },
    'commanders-trial': { pikeman: 40, archer: 100, cavalry: 30 }
};

for (const challenge of CHALLENGES) {
    test(`${challenge.title} has a winning legal army in the real battle engine`, t => {
        const army = solutions[challenge.id];
        assertLegalArmy(army, challenge.budget);
        const scene = makeScene();
        scene.deployUnits(army, challenge.enemy, 'custom', challenge.enemyFormation);
        scene.battleStarted = true;
        for (let step = 0; step < 18000 && !scene.battleOver; step++) scene.advanceBattle(1000 / 60);
        const report = scene.getBattleReport();
        assert.equal(scene.winner, 'red', `${challenge.id} must finish with a player victory within five simulated minutes`);
        assert.ok(report.red > 0);
        assert.equal(report.morale.blue.steady + report.morale.blue.wavering, 0,
            'the defeated army has no soldiers still willing to fight');
        for (const team of Object.values(report.teams)) {
            assert.equal(team.initial, team.alive + team.lost + team.withdrawn,
                'each deployed soldier is still on the field, dead, or withdrawn');
        }
        assert.ok(['rout', 'elimination'].includes(report.endReason));
        if (challenge.id === 'outnumbered') {
            assert.ok(report.teams.red.initial < report.teams.blue.initial, 'example genuinely uses fewer soldiers');
        }
        t.diagnostic(JSON.stringify({
            challenge: challenge.id, army, cost: armyCost(army), formation: 'custom',
            survivors: report.red, durationMs: report.durationMs
        }));
    });
}
