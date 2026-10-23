import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { makeScene, addUnit } from './battle-harness.js';
import { createSiegeLayer } from '../js/battle/siege.js';
import { CAMP_LAYOUT as L } from '../js/siege3d/layout.js';
import { createCampSiege, installSiegeArrows } from '../js/siege3d/deployment.js';
import { campBounds, queueCampWalls } from '../js/siege3d/walls.js';
import { deployVariant, step } from '../tools/siege-balance.mjs';
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const HP = 1e6;
function fixed(s, team, type, gx, gy) {
    const u = addUnit(s, team, type, gx, gy);
    u.typeData = { ...u.typeData, speed: 0 };
    u.hp = u.maxHp = HP; u.nextShift = Infinity;
    return u;
}
function setup(kind = 'ground', config = {}) {
    const s = makeScene(), b = campBounds();
    s.siege = createCampSiege(b, { defense: false, rules: config });
    installSiegeArrows(s); queueCampWalls(s);
    const p = s.siege.platforms.find(p => p.kind === kind);
    const x = p ? (p.x1 + p.x2) / 2 : b.cx + 5;
    const y = p ? (p.y1 + p.y2) / 2 : b.y1 + 2;
    const archer = fixed(s, 'blue', 'archer', x, y);
    archer.siegeAnchor = { gx: x, gy: y };
    const chosen = [], shots = [], hits = [];
    s.playAttackAnim = (from, to) => { if (from === archer) chosen.push(to.id); };
    const fire = s.fireArrow;
    s.fireArrow = function (from, to, options) {
        if (from === archer) shots.push(to.id);
        return fire.call(this, from, to, options);
    };
    const record = s.recordDamage;
    s.recordDamage = function (target, damage, from, at) {
        hits.push({ from: from.id, target: target.id, damage });
        return record.call(this, target, damage, from, at);
    };
    return { s, b, archer, chosen, shots, hits };
}
function outside(ctx, d, dx = 0, type = 'infantry') {
    return fixed(ctx.s, 'red', type, ctx.archer.gx + dx, ctx.b.y1 - L.wallThickness - d);
}

test('deadzone #1: ground archer never targets or releases at a wall-foot soldier, but fires outside', () => {
    const c = setup(), foot = outside(c, 1);
    step(c.s, 60);
    assert.equal(c.archer.target, null);
    assert.deepEqual(c.chosen, []); assert.deepEqual(c.shots, []);
    const far = outside(c, 2, 2);
    step(c.s, 60);
    assert.ok(c.chosen.length > 0 && c.chosen.every(id => id === far.id));
    assert.ok(c.shots.length > 0 && c.shots.every(id => id === far.id));
    assert.ok(!c.hits.some(h => h.from === c.archer.id && h.target === foot.id));
});

test('deadzone #2: actual walkway and tower archers select and hit the deadzone', () => {
    for (const kind of ['walkway', 'tower']) {
        const c = setup(kind), foot = outside(c, .7);
        step(c.s, 300);
        assert.ok(c.chosen.includes(foot.id)); assert.ok(c.shots.includes(foot.id));
        assert.ok(c.hits.some(h => h.from === c.archer.id && h.target === foot.id));
    }
});

test('deadzone: walkway melee strikes across the wall only within ordinary reach', () => {
    const c = setup('walkway');
    const guard = fixed(c.s, 'blue', 'pikeman', c.archer.gx + 4, c.b.y1 + .38);
    const foot = fixed(c.s, 'red', 'infantry', guard.gx, c.b.y1 - .68);
    step(c.s, 120);
    assert.ok(c.hits.some(h => h.from === guard.id && h.target === foot.id));
});

test('deadzone #3: elevated range selection and release share 9.5 x scale boundaries +/- .01', () => {
    for (const [kind, scale] of [['walkway', 1.1], ['tower', 1.2]]) for (const offset of [-.01, .01]) {
        const c = setup(kind);
        const enemy = fixed(c.s, 'red', 'infantry', c.archer.gx, c.archer.gy - 9.5 * scale - offset);
        assert.equal(c.archer.typeData.range, 9.5);
        step(c.s, 10);
        assert.equal(c.chosen.includes(enemy.id), offset < 0);
        assert.equal(c.shots.includes(enemy.id), offset < 0);
    }
});

test('deadzone: draw-time movement into deadzone or beyond elevated range cancels release', () => {
    for (const kind of ['ground', 'walkway', 'tower']) {
        const c = setup(kind), enemy = outside(c, 4);
        step(c.s); assert.deepEqual(c.chosen, [enemy.id]);
        c.s.scheduleBattleAction(0, () => {
            enemy.gy = kind === 'ground' ? c.b.y1 - 1 : c.archer.gy - 9.5 * (kind === 'tower' ? 1.2 : 1.1) - .01;
        });
        step(c.s, 10); assert.deepEqual(c.shots, []);
    }
});

test('deadzone #4/5: priorities, distance and id tie breaks through step', () => {
    for (const kind of ['ground', 'walkway', 'tower']) {
        const c = setup(kind);
        const waiting = outside(c, .5, 3); waiting.siegeClimb = { waiting: true };
        const foot = outside(c, 1, 1);
        const archer = outside(c, 3, 2, 'archer');
        const advancing = outside(c, 4, 1);
        const nearest = fixed(c.s, 'red', 'infantry', c.archer.gx, c.archer.gy + 1.5);
        const tied = fixed(c.s, 'red', 'infantry', nearest.gx, nearest.gy);
        const expected = kind === 'ground' ? [waiting, archer, advancing, nearest, tied] : [waiting, foot, archer, nearest, tied, advancing];
        for (const target of expected) {
            // Supply real prior-frame inward displacement; velocity is captured by step().
            advancing.pgy = advancing.gy - .01;
            c.archer.lastAttack = -Infinity;
            const count = c.chosen.length;
            step(c.s);
            assert.equal(c.chosen.length, count + 1);
            assert.equal(c.chosen.at(-1), target.id, `${kind}: wanted ${target.id}`);
            c.s.scheduleBattleAction(0, () => c.s.withdrawUnit(target));
        }
        if (kind === 'ground') {
            c.archer.lastAttack = -Infinity; step(c.s);
            assert.equal(c.chosen.at(-1), tied.id, 'remaining foot target is excluded');
        }
    }
});

test('deadzone: outer-edge 1.5 boundary, corners, climbers and ram exemptions', () => {
    for (const [d, exempt] of [[1.49, false], [1.5, false], [1.51, true]]) {
        const c = setup(); const u = outside(c, d);
        step(c.s, 10); assert.equal(c.shots.includes(u.id), exempt);
    }
    for (const role of ['climber', 'ram']) {
        const c = setup(), u = outside(c, .8);
        if (role === 'climber') u.siegeClimb = { waiting: false };
        else u.siegeRole = 'ram';
        step(c.s, 10); assert.ok(c.shots.includes(u.id), role);
    }
    for (const d of [1.49, 1.51]) {
        const c = setup();
        c.archer.gx = c.archer.siegeAnchor.gx = c.b.x1 + 2;
        const u = fixed(c.s, 'red', 'infantry', c.b.x1 - L.wallThickness - d / Math.SQRT2,
            c.b.y1 - L.wallThickness - d / Math.SQRT2);
        step(c.s, 10); assert.equal(c.shots.includes(u.id), d > 1.5);
    }
});

test('deadzone: advancing priority requires inward velocity, not facing, retreat or lateral movement', () => {
    for (const [vx, vy, advances] of [[0, .01, true], [0, -.01, false], [.01, 0, false], [0, 0, false]]) {
        const c = setup(), advancing = outside(c, 4);
        const near = fixed(c.s, 'red', 'infantry', c.archer.gx, c.archer.gy + 1.5);
        advancing.pgx = advancing.gx - vx; advancing.pgy = advancing.gy - vy;
        step(c.s);
        assert.deepEqual(c.chosen, [advances ? advancing.id : near.id]);
    }
});

test('deadzone #6: real crew arrow damage is exactly 0.3 of uncovered damage, multiplied by height', () => {
    function run(roof, elevated, melee = false) {
        const c = setup(elevated ? 'tower' : 'ground', { ramRoofCover: roof });
        const { ram } = c.s.siege;
        const crew = fixed(c.s, 'red', 'infantry', ram.gx, ram.gy);
        crew.typeData = { ...crew.typeData, def: 7 };
        const gx = ram.gx + 4, gy = ram.gy;
        Object.assign(c.archer, { gx, gy, pgx: gx, pgy: gy, siegeAnchor: { gx, gy } });
        if (elevated) c.s.siege.platforms.push({ kind: 'tower', height: 1.6,
            x1: gx - .5, x2: gx + .5, y1: gy - .5, y2: gy + .5 });
        step(c.s); assert.equal(crew.siegeRole, 'ram');
        c.archer.typeData = { ...c.archer.typeData, ranged: !melee, range: 0 };
        c.archer.meleeRoll = .5;
        c.s.scheduleBattleAction(0, () => c.s.fireArrow(c.archer, crew, { rawAttack: 100 }));
        step(c.s, 60);
        const damage = c.hits.filter(h => h.from === c.archer.id && h.target === crew.id);
        assert.equal(damage.length, 1);
        return damage[0].damage;
    }
    for (const high of [false, true]) {
        const plain = run(1, high), covered = run(.3, high);
        assert.equal(covered, plain * .3);
        assert.equal(run(.3, high, true), run(1, high, true), 'roof only modifies ranged sources');
    }
});

function legacyTrace(mode) {
    const s = makeScene();
    const b = { x1: 25, y1: 20, x2: 45, y2: 40, cx: 35, cy: 30 };
    const config = { ...L.rules };
    for (const key of ['deadZone', 'advanceRadius', 'walkwayRangeScale', 'towerRangeScale', 'ramRoofCover']) delete config[key];
    s.siege = mode === 0 ? createSiegeLayer() : createSiegeLayer(
        mode === 1 ? [] : [{ x1: 28, y1: 24, x2: 32, y2: 32, kind: 'tower', height: 1.6 }],
        { bounds: b, rules: config });
    for (const [team, type, x, y] of [['blue', 'archer', 30, 26], ['red', 'infantry', 24, 26],
        ['red', 'archer', 23, 29], ['blue', 'infantry', 31, 31], ['red', 'infantry', 33, 31]]) addUnit(s, team, type, x, y);
    const frames = [];
    for (let i = 0; i < 180; i++) {
        step(s);
        frames.push(hash([s.units.map(u => [u.id, u.gx, u.gy, u.hp, u.dead, u.withdrawn, u.morale, u.moraleState, u.lastAttack]),
            s.arrows.map(a => ({ ...a, source: a.source?.id })), s.battleOver, s.winner, s.endReason]));
    }
    return frames;
}
// 180 per-frame expectations: mode 0 retains the a2bffa8 golden. Modes 1/2 inherit L.rules,
// so rebaseline for interiorMeleeCover .8 and defenderMoraleBonus -.025; fixture/assertions unchanged.
const golden = JSON.parse(gunzipSync(Buffer.from(
    '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', 'base64')));

test('deadzone #7: three unconfigured siege traces deepEqual balance-adjusted legacy frames', () => {
    for (const mode of [0, 1, 2]) assert.deepEqual(legacyTrace(mode), golden[mode]);
});

test('deadzone #8: full siege3d deployment repeats all 1800 frames', t => {
    function run() {
        const s = deployVariant(), frames = [];
        for (let i = 0; i < 1800; i++) {
            assert.equal(s.battleOver, false, `full run reaches frame ${i}`);
            step(s);
            frames.push(hash([s.units.map(u => [u.id, u.gx, u.gy, u.hp, u.dead, u.withdrawn, u.morale, u.moraleState,
                u.siegeRole, u.siegeClimb?.progress, u.lastAttack]), s.siege.ram, s.siege.gate,
                s.arrows.map(a => ({ ...a, source: a.source?.id })),
                s.siege.rules.captureSeconds, s.siege.rules.attackerLossRate, s.siege.rules.lastProgressAt,
                s.siege.rules.attackerStallSeconds, [...s.siege.rules.everInside], s.winner, s.endReason]));
        }
        return frames;
    }
    const a = run(); assert.deepEqual(run(), a);
    t.diagnostic(`frames=${a.length}; trajectorySha256=${hash(a)}`);
});
