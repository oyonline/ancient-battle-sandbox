import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeScene, addUnit } from './battle-harness.js';
import { deployVariant, step } from '../tools/siege-balance.mjs';
import { createCampSiege, siegeDeployment } from '../js/siege3d/deployment.js';
import { CAMP_LAYOUT as L } from '../js/siege3d/layout.js';
import { campBounds, queueCampWalls } from '../js/siege3d/walls.js';
import { createLocalSiegeCommands } from '../js/siege3d/assault-commands.js';
import { stateSummary, digest } from './siege-assault-support.js';

const player = (options = {}) => deployVariant({ seed: 173, variant: 1,
    siegeOptions: { attackerControl: 'player', ...options } });
const release = (s, face) => s.applyNetCommand(face === 'ram' ? { k: 'siegeRam', side: 'red' }
    : { k: 'siegeAssault', side: 'red', face });
const living = u => !u.dead && !u.withdrawn && u.hp > 0;
const waiting = (s, face) => s.units.filter(u => living(u) && u.team === 'red' &&
    ['infantry', 'pikeman'].includes(u.type) && (!face || u.siegeWing === face) &&
    u.moraleState !== 'routing' && !(u.moraleState === 'wavering' && u.moraleFallBackUntil > s.simulationTime));
const error = u => Math.hypot(u.gx - u.siegeStaging.gx, u.gy - u.siegeStaging.gy);
function frozen(ladder) {
    assert.deepEqual(ladder.pos, ladder.start);
    assert.equal(ladder.state, 'carrying');
    assert.equal(ladder.crewMs, 0); assert.equal(ladder.crewInitialized, false);
    assert.equal(ladder.recruitMs, 0); assert.equal(ladder.initialized, false);
    assert.deepEqual(ladder.crew, [null, null]);
}
function small(options = {}) {
    const s = makeScene(), b = campBounds();
    s.siege = createCampSiege(b, { ladders: true, defense: false, attackerControl: 'player', ...options });
    const red = addUnit(s, 'red', 'infantry', 12, 12), blue = addUnit(s, 'blue', 'infantry', b.x2 - 2, b.y2 - 2);
    for (const u of [red, blue]) u.typeData = { ...u.typeData, speed: 0 };
    red.siegeWing = 'north'; red.siegeStaging = { gx: red.gx, gy: red.gy };
    queueCampWalls(s); s.rebuildSpatial();
    return { s, red, blue, b };
}

test('assault auto: variants 1/6 match HEAD 5dc24f0 every 60 frames through 600', () => {
    const golden = JSON.parse(readFileSync(new URL('./fixtures/siege-assault-auto-5dc24f0.json', import.meta.url)));
    assert.equal(golden.head, '5dc24f033766213ebb6eb1b931b50df6a53633fb');
    for (const variant of [1, 6]) {
        const s = deployVariant({ seed: golden.seed, variant });
        assert.ok(Object.values(s.siege.assault.released).every(Boolean));
        assert.equal(s.siege.assault.battleDeadlineSeconds, null);
        for (const row of golden.variants[variant]) {
            step(s, 60);
            assert.equal(digest(stateSummary(s)), row.sha256, `variant ${variant}, frame ${row.frame}`);
        }
    }
});

test('assault player: 60s waiting and north-only release use complete steps', t => {
    const s = player(), b = campBounds(), ramBefore = structuredClone(s.siege.ram);
    assert.equal(s.siege.assault.battleDeadlineSeconds, 360);
    // Each column keeps its original rank depth; the goal is a translation, not a projection.
    const placements = siegeDeployment(s.units, b, s.siege);
    for (const { unit, gx, gy } of placements.filter(p => p.unit.team === 'red')) {
        assert.ok(Math.abs(Math.hypot(gx - unit.siegeStaging.gx, gy - unit.siegeStaging.gy) - 7) < 1e-10);
    }
    step(s, 3600);
    assert.equal(s.battleOver, false); assert.equal(s.siege.rules.contactAt, null);
    const wallDistance = u => Math.hypot(Math.max(b.x1 - L.wallThickness - u.gx, 0, u.gx - b.x2 - L.wallThickness),
        Math.max(b.y1 - L.wallThickness - u.gy, 0, u.gy - b.y2 - L.wallThickness));
    assert.equal(s.units.filter(u => living(u) && u.team === 'red' && !u.typeData.ranged && wallDistance(u) <= 2).length, 0);
    const maxError = Math.max(...waiting(s).map(error));
    t.diagnostic(`60s maximum staging error = ${maxError}`);
    assert.ok(maxError <= 1);
    for (const ladder of s.siege.ladders) frozen(ladder);
    assert.deepEqual(s.siege.ram, ramBefore);
    const now = s.simulationTime;
    assert.equal(release(s, 'north'), true);
    assert.equal(s.siege.assault.releasedAt.north, now);
    const started = new Set(), northIds = new Set(s.units.filter(u => u.siegeWing === 'north').map(u => u.id));
    for (let i = 0; i < 600; i++) {
        step(s);
        for (const ladder of s.siege.ladders) {
            if (ladder.face !== 'north') { frozen(ladder); continue; }
            for (const id of ladder.crew.filter(id => id !== null)) assert.ok(northIds.has(id));
            for (const id of ladder.climbers.filter(id => id !== null)) assert.ok(northIds.has(id));
            if (ladder.pos.gy !== ladder.start.gy) started.add(ladder.id);
        }
    }
    assert.equal(started.size, 8); assert.ok(s.siege.rules.contactAt > now);
    assert.ok(s.units.some(u => u.siegeWing === 'north' && (u.siegeClimb || wallDistance(u) <= 2)));
    for (const face of ['east', 'south', 'west']) assert.ok(waiting(s, face).every(u => error(u) <= 1));
    assert.deepEqual(s.siege.ram, ramBefore);
});

test('assault commands: invalid team/face/kind, repeats and post-outcome reject without mutation', () => {
    const { s } = small({ battleDeadlineSeconds: .1 });
    const snapshot = () => digest([stateSummary(s), s.siege.assault]);
    for (const c of [null, { k: 'siegeAssault', side: 'blue', face: 'north' },
        { k: 'siegeRam', side: 'blue' }, { k: 'siegeAssault', side: 'red', face: 'up' },
        { k: 'siegeAssault', side: 'red', face: 'ram' }]) {
        const before = snapshot(); assert.equal(s.applyNetCommand(c) ?? false, false); assert.equal(snapshot(), before);
    }
    assert.equal(release(s, 'north'), true); assert.equal(release(s, 'ram'), true);
    for (const face of ['north', 'ram']) {
        const before = snapshot(); assert.equal(release(s, face), false); assert.equal(snapshot(), before);
    }
    step(s, 6); assert.equal(s.battleOver, true);
    const before = snapshot(); assert.equal(release(s, 'west'), false); assert.equal(snapshot(), before);
});

test('assault local commands: queued until step, old-clock timestamps, ordered replay at 1/2 steps per frame', () => {
    const commands = [{ step: 1, command: { k: 'siegeAssault', side: 'red', face: 'north' } },
        { step: 61, command: { k: 'siegeAssault', side: 'red', face: 'south' } },
        { step: 61, command: { k: 'siegeRam', side: 'red' } }];
    function run(perFrame) {
        const s = player(), local = createLocalSiegeCommands();
        for (let frame = 0; frame < 180 / perFrame; frame++) for (let sub = 0; sub < perFrame; sub++) {
            const next = frame * perFrame + sub + 1;
            const before = digest([stateSummary(s), s.siege.assault]);
            for (const row of commands.filter(c => c.step === next)) local.enqueue(row.command);
            assert.equal(digest([stateSummary(s), s.siege.assault]), before, 'enqueue has no simulation side effect');
            local.beforeStep(s); step(s);
        }
        assert.deepEqual(local.log, commands);
        assert.equal(s.siege.assault.releasedAt.north, 0);
        assert.ok(Math.abs(s.siege.assault.releasedAt.south - 1000) < 1e-8);
        return digest([stateSummary(s), s.siege.assault]);
    }
    assert.equal(run(1), run(2));
});

test('assault redeploy: pending queue, log, step count and released state clear', () => {
    const local = createLocalSiegeCommands();
    let { s } = small();
    local.enqueue({ k: 'siegeAssault', side: 'red', face: 'north' });
    local.beforeStep(s); step(s);
    local.enqueue({ k: 'siegeRam', side: 'red' });
    assert.equal(local.log.length, 1); assert.equal(local.pendingCount, 1);
    local.reset(); ({ s } = small());
    assert.equal(local.log.length, 0); assert.equal(local.pendingCount, 0);
    assert.ok(Object.values(s.siege.assault.released).every(v => !v));
    assert.ok(Object.values(s.siege.assault.releasedAt).every(v => v === null));
    local.beforeStep(s); step(s); assert.equal(s.siege.ram.initialized, false);
    local.enqueue({ k: 'siegeRam', side: 'red' }); local.beforeStep(s); step(s);
    assert.equal(local.log[0].step, 2);
});

test('assault deadline: full 360s ends with defender holding camp; auto ignores deadline', () => {
    const { s } = small();
    step(s, 21600);
    assert.equal(s.battleOver, true); assert.equal(s.winner, 'blue'); assert.equal(s.endReason, '守住营寨');
    const { s: auto } = small({ attackerControl: 'auto', battleDeadlineSeconds: .01 });
    step(auto, 2); assert.equal(auto.battleOver, false);
});

test('assault deadline: capture in the same step retains original outcome priority', () => {
    const { s, red, b } = small({ battleDeadlineSeconds: 2 / 60, rules: { captureSeconds: 1 / 60 } });
    red.gx = red.pgx = red.siegeStaging.gx = b.cx;
    red.gy = red.pgy = red.siegeStaging.gy = b.cy;
    step(s, 2);
    assert.equal(s.winner, 'red'); assert.equal(s.endReason, '攻方夺寨');
});

test('assault waiting melee: deterministic id tie, stationary delayed hits and cooldown', () => {
    const s = makeScene();
    s.siege = createCampSiege(campBounds(), { attackerControl: 'player', defense: false, rules: false });
    const red = addUnit(s, 'red', 'infantry', 15, 15);
    const first = addUnit(s, 'blue', 'infantry', 15 - .85, 15);
    const second = addUnit(s, 'blue', 'infantry', 15 + .85, 15);
    red.siegeWing = 'north'; red.siegeStaging = { gx: 10, gy: 10 };
    for (const u of [first, second]) u.siegeAnchor = { gx: u.gx, gy: u.gy };
    const attacked = []; s.playAttackAnim = u => { if (u === red) attacked.push(s.simulationTime); };
    const hp = first.hp;
    step(s); assert.equal(red.target, first); assert.equal(first.hp, hp);
    step(s, 6); assert.ok(first.hp < hp); assert.equal(second.hp, second.maxHp);
    assert.equal(red.gx, 15); assert.equal(red.gy, 15); assert.equal(attacked.length, 1);
});

test('assault configuration: player rejects non-carrying ladders and keeps staging independent of layout', () => {
    assert.throws(() => createCampSiege(campBounds(), { attackerControl: 'player', ladderCarry: false }), /ladderCarry/);
    const { s } = small({ stagingClearance: 9, battleDeadlineSeconds: null });
    assert.equal(s.siege.assault.stagingClearance, 9); assert.equal(s.siege.assault.battleDeadlineSeconds, null);
    assert.equal(L.attackerFrontClearance, 18);
    step(s); assert.equal(s.battleOver, false);
});

test('assault ram: south release followed 20s later by ram recruits four south-wing crew and advances', () => {
    const s = player(), initial = structuredClone(s.siege.ram);
    assert.equal(release(s, 'south'), true);
    step(s, 1200);
    assert.deepEqual(s.siege.ram, initial, 'unreleased ram must remain entirely frozen');
    assert.equal(release(s, 'ram'), true);
    step(s);
    assert.equal(s.siege.ram.initialized, true, 'release takes the original first-recruitment path');
    // The card does not require immediate recruitment. South-wing infantry can
    // return into radius 6 through their ordinary AI; never reserve or teleport them.
    for (let i = 0; i < 2400 && !s.battleOver && s.siege.ram.crew.some(id => id === null); i++) {
        step(s);
        for (const id of s.siege.ram.crew.filter(id => id !== null))
            assert.equal(s.units.find(u => u.id === id)?.siegeWing, 'south');
    }
    const crew = s.siege.ram.crew.filter(id => id !== null);
    assert.equal(crew.length, 4);
    assert.ok(crew.every(id => s.units.find(u => u.id === id)?.siegeWing === 'south'));
    assert.ok(s.siege.ram.gy < initial.gy);
});
