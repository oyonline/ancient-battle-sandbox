import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScene, addUnit } from './battle-harness.js';
import { deployVariant, step } from '../tools/siege-balance.mjs';
import { configureCampArmies, createCampSiege } from '../js/siege3d/deployment.js';
import { installPlayerAssault } from '../js/battle/siege-assault.js';
import { createLocalSiegeCommands } from '../js/siege3d/assault-commands.js';
import { campBounds } from '../js/siege3d/walls.js';
import { stateSummary, digest } from './siege-assault-support.js';

const player = () => deployVariant({ seed: 173, variant: 1, siegeOptions: { attackerControl: 'player' } });
const command = { k: 'siegeArchers', side: 'red' };
const north = { k: 'siegeAssault', side: 'red', face: 'north' };
const archers = s => s.units.filter(u => u.team === 'red' && u.type === 'archer');
const dist = (a, b) => Math.hypot(a.gx - b.gx, a.gy - b.gy);
const projection = s => digest({ legacy: stateSummary(s), time: s.simulationTime,
    arrows: s.arrows.map(({ source, ...arrow }) => ({ ...arrow, source: source.id })),
    units: s.units.map(u => [u.id, u.siegeArcherPost, u.siegeArcherLinePost, u.guardRadius,
        u.groundGuardReturning, u.groundGuardTarget?.id ?? null, u.siegeRamReserve]),
    released: s.siege.assault.released, releasedAt: s.siege.assault.releasedAt });
const enqueueStep = (s, commands) => {
    const queue = createLocalSiegeCommands();
    commands.forEach(c => queue.enqueue(c)); queue.beforeStep(s); step(s);
};

test('A3: hold clearance must be finite and strictly between line and staging', () => {
    for (const archerHoldClearance of [undefined, NaN, Infinity, -Infinity, 18.5, 18, 27, 28])
        assert.throws(() => installPlayerAssault({}, { attackerControl: 'player',
            archerLineClearance: 18.5, archerHoldClearance, stagingClearance: 27 }), /archerHoldClearance/);
    assert.doesNotThrow(() => installPlayerAssault({}, { attackerControl: 'auto', archerHoldClearance: NaN }));
});

test('A3: no orders for 60s means no archer exchange and no attacker wounds; all four rows hold', t => {
    const s = player(), initial = [...s.units], attack = archers(s);
    const defenders = initial.filter(u => u.team === 'blue' && u.type === 'archer');
    let minMargin = Infinity, redShots = 0, blueAtArchers = 0, samples = 0, maxError = 0;
    for (const a of attack) for (const d of defenders) {
        const range = d.typeData.range * s.siege.rules.rangeScale(d);
        // Worst permitted placement jitter moves an attacker diagonally towards a defender.
        const margin = dist(a.siegeArcherPost, d) - Math.SQRT2 * .3 - range;
        minMargin = Math.min(minMargin, margin);
        assert.ok(margin > 0, `hold post ${a.id} in range of ${d.id}`);
    }
    const fire = s.fireArrow;
    s.fireArrow = function (from, target, options) {
        if (from.team === 'red') redShots++;
        if (from.team === 'blue' && target.team === 'red' && target.type === 'archer') blueAtArchers++;
        return fire.call(this, from, target, options);
    };
    for (let frame = 1; frame <= 3600; frame++) {
        assert.equal(s.battleOver, false); step(s);
        for (const face of ['north', 'east', 'south', 'west']) {
            const duty = attack.filter(u => u.siegeWing === face && !u.dead && !u.withdrawn && u.moraleState !== 'routing');
            assert.ok(duty.length > 0);
            for (const u of duty) {
                const error = dist(u, u.siegeArcherPost); maxError = Math.max(maxError, error); samples++;
                assert.ok(error <= 1.75);
            }
        }
    }
    assert.equal(redShots, 0); assert.equal(blueAtArchers, 0);
    const attackers = initial.filter(u => u.team === 'red');
    assert.ok(attackers.every(u => !u.dead && u.hp === u.maxHp));
    t.diagnostic(JSON.stringify({ steps: 3600, redShots, blueAtArchers, attackerDead: 0, attackerWounded: 0,
        minMarginWithJitter: minMargin, maxError, samples }));
});

for (const orders of [[north, command], [command, north]]) {
    for (const sameStep of [false, true]) test(`A3: ${orders.map(c => c.k).join(' then ')} (${sameStep ? 'same step FIFO' : 'separate steps'})`, () => {
        const run = () => {
            const s = player(); step(s);
            const row = archers(s).filter(u => u.siegeWing === 'north');
            if (sameStep) enqueueStep(s, orders);
            else {
                enqueueStep(s, [orders[0]]);
                if (orders[0] === north) assert.ok(row.every(u => !u.siegeArcherPost && !u.siegeArcherLinePost));
                else assert.ok(row.every(u => dist(u.siegeArcherPost, u.siegeArcherLinePost) === 0));
                enqueueStep(s, [orders[1]]);
            }
            assert.ok(row.every(u => !u.siegeArcherPost && !u.siegeArcherLinePost && u.guardRadius === undefined));
            assert.ok(archers(s).filter(u => u.siegeWing !== 'north').every(u =>
                dist(u.siegeArcherPost, u.siegeArcherLinePost) === 0));
            assert.equal(s.siege.assault.released.ram, false);
            assert.equal(s.siege.assault.released.south, false);
            assert.ok(s.units.every(u => !u.siegeRamReserve));
            step(s, 60);
            assert.ok(row.every(u => !u.siegeArcherPost && !u.siegeArcherLinePost));
            return projection(s);
        };
        assert.equal(run(), run());
    });
}

test('A3: suppression changes only targets, preserves fixed slots and ram reservations', () => {
    const s = player(); step(s, 600);
    enqueueStep(s, [{ k: 'siegeAssault', side: 'red', face: 'south' }]);
    const reserves = s.units.filter(u => u.siegeRamReserve).map(u => u.id);
    const row = archers(s).filter(u => u.siegeWing === 'north');
    const slots = row.map(u => ({ ...u.siegeArcherLinePost }));
    row[0].dead = true; // A missing original slot must not recenter the surviving row.
    const positions = archers(s).map(u => [u.gx, u.gy]);
    const now = s.simulationTime;
    assert.equal(s.applyNetCommand(command), true);
    assert.equal(s.siege.assault.releasedAt.archers, now);
    assert.deepEqual(archers(s).map(u => [u.gx, u.gy]), positions);
    assert.deepEqual(row.map(u => u.siegeArcherPost), slots);
    assert.deepEqual(s.units.filter(u => u.siegeRamReserve).map(u => u.id), reserves);
    step(s);
    assert.ok(row.slice(1).some(u => dist(u, u.siegeArcherPost) > 1.75));
});

for (const mode of ['player', 'auto']) test(`A3: suppression then ${mode} redeploy resets posts, guard state and command state`, () => {
    const s = player(); step(s); enqueueStep(s, [command]);
    const old = archers(s).map(u => u.siegeArcherLinePost);
    configureCampArmies(s, { attackerControl: mode });
    for (const [i, u] of archers(s).entries()) {
        assert.notEqual(u.siegeArcherLinePost, old[i]);
        assert.equal(u.guardRadius, undefined);
        assert.equal(u.groundGuardReturning, false); assert.equal(u.groundGuardTarget, null);
        if (mode === 'auto') {
            assert.equal(u.siegeArcherPost, undefined); assert.equal(u.siegeArcherLinePost, undefined);
        } else assert.ok(dist(u, u.siegeArcherPost) === 0);
    }
    assert.equal(s.siege.assault.released.archers, mode === 'auto');
    assert.equal(s.siege.assault.releasedAt.archers, mode === 'auto' ? 0 : null);
    step(s);
});

test('A3: invalid, repeated, auto and finished commands immediately preserve the A3 projection', () => {
    const s = player(); step(s);
    const reject = c => { const before = projection(s); assert.equal(s.applyNetCommand(c) ?? false, false); assert.equal(projection(s), before); };
    reject({ ...command, side: 'blue' }); reject({ ...command, side: undefined });
    reject({ k: 'siegeArcherPost', side: 'red' });
    s.resolvingOutcome = true; reject(command); s.resolvingOutcome = false;
    s.battleOver = true; reject(command); s.battleOver = false;
    assert.equal(s.applyNetCommand(command), true); reject(command); step(s);
    configureCampArmies(s, { attackerControl: 'auto' }); reject(command); step(s);
});

test('A3: 1/2-step frames compare the full A3 projection every step and queue timestamps use the old clock', () => {
    const commands = [{ step: 61, command }, { step: 121, command: north },
        { step: 121, command: { k: 'siegeAssault', side: 'red', face: 'south' } },
        { step: 181, command: { k: 'siegeRam', side: 'red' } }];
    const run = perFrame => {
        const s = player(), queue = createLocalSiegeCommands(), frames = [];
        for (let frame = 0; frame < 600 / perFrame; frame++) for (let sub = 0; sub < perFrame; sub++) {
            const next = frame * perFrame + sub + 1, before = projection(s);
            for (const row of commands.filter(c => c.step === next)) queue.enqueue(row.command);
            assert.equal(projection(s), before);
            assert.equal(queue.pending('archers'), next === 61);
            queue.beforeStep(s); step(s); frames.push(projection(s));
        }
        assert.deepEqual(queue.log, commands);
        assert.ok(Math.abs(s.siege.assault.releasedAt.archers - 1000) < 1e-8);
        return frames;
    };
    assert.deepEqual(run(1), run(2));
});

for (const path of ['carry', 'climb']) test(`A3: ${path} recruitment cannot steal the original four ram reserves`, () => {
    const s = makeScene();
    s.siege = createCampSiege(campBounds(), { attackerControl: 'player', ladders: true, defense: false, rules: false });
    const ram = s.siege.ram, ladder = s.siege.ladders.find(l => l.face === 'south');
    // Put the competing ladder at the ram standby site; both recruit on a real step.
    ladder.start = { gx: ram.gx, gy: ram.gy }; ladder.pos = { ...ladder.start };
    ladder.foot = { gx: ram.gx, gy: ram.gy - .5 };
    ladder.top = { gx: ram.gx, gy: ram.gy - 1 };
    ladder.landing = { gx: ram.gx, gy: ram.gy - 2 };
    if (path === 'climb') ladder.state = 'placed';
    const soldiers = Array.from({ length: 6 }, (_, i) => {
        const u = addUnit(s, 'red', 'infantry', ram.gx + (i - 2.5) * .1, ram.gy + 1);
        u.siegeWing = 'south'; u.siegeStaging = { gx: u.gx, gy: u.gy };
        return u;
    });
    addUnit(s, 'blue', 'infantry', 10, 10);
    const queue = createLocalSiegeCommands(); queue.enqueue({ k: 'siegeAssault', side: 'red', face: 'south' }); queue.beforeStep(s);
    const reserves = soldiers.filter(u => u.siegeRamReserve).map(u => u.id).sort((a, b) => a - b);
    assert.equal(reserves.length, 4);
    step(s);
    const recruited = path === 'carry' ? ladder.crew : ladder.climbers;
    assert.ok(recruited.some(id => id !== null), 'competition actually recruited a non-reserve');
    assert.ok(recruited.filter(id => id !== null).every(id => !reserves.includes(id)));
    assert.ok(soldiers.filter(u => reserves.includes(u.id)).every(u => !u.siegeRole && u.siegeRamReserve));
    queue.enqueue({ k: 'siegeRam', side: 'red' }); queue.beforeStep(s); step(s);
    assert.deepEqual([...ram.crew].sort((a, b) => a - b), reserves);
});
