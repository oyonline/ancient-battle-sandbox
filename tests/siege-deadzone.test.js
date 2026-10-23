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
// Captured from a2bffa8 before edits: 180 per-frame hashes for each of three unconfigured layers.
const golden = JSON.parse(gunzipSync(Buffer.from(
    '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', 'base64')));

test('deadzone #7: three unconfigured siege traces deepEqual pre-edit frames', () => {
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
