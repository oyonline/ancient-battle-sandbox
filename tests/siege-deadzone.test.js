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
// Captured from a2bffa8: 180 per-frame hashes per unconfigured layer. Modes 1/2 rebaselined for defenderMoraleBonus 0 -> .05; mode 0 unchanged.
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
