import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeScene, addUnit, applyDamage } from './battle-harness.js';
import { createSiegeLayer } from '../js/battle/siege.js';
import { CAMP_LAYOUT as L } from '../js/siege3d/layout.js';
import { createCampSiege } from '../js/siege3d/deployment.js';
import { campBounds, queueCampWalls } from '../js/siege3d/walls.js';
import { deployVariant, step } from '../tools/siege-balance.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function camp(config = {}) {
    const s = makeScene(), b = campBounds();
    s.siege = createSiegeLayer([], { bounds: b, rules: { ...L.rules, ...config } });
    return { s, b };
}
function fixed(s, team, x, y, type = 'infantry') {
    const u = addUnit(s, team, type, x, y);
    u.typeData = { ...u.typeData, speed: 0 }; u.nextShift = Infinity;
    return u;
}
function rout(u) { u.morale = 0; u.moraleState = 'routing'; u.moraleSheltered = false; }

test('P3 #1: 600 routed frames stay inside and never increase tent distance; tower anchor releases', () => {
    const { s, b } = camp();
    const u = addUnit(s, 'blue', 'infantry', b.x1 + .5, b.cy);
    u.siegeAnchor = { gx: u.gx, gy: u.gy }; rout(u);
    fixed(s, 'red', b.x2 + 8, b.cy);
    queueCampWalls(s);
    let previous = Math.hypot(u.gx - b.cx, u.gy - b.cy);
    for (let i = 0; i < 600; i++) {
        step(s);
        assert.equal(u.moraleState, 'routing');
        assert.ok(u.gx >= b.x1 && u.gx <= b.x2 && u.gy >= b.y1 && u.gy <= b.y2);
        const d = Math.hypot(u.gx - b.cx, u.gy - b.cy);
        assert.ok(d <= previous + 1e-10); previous = d;
    }
    assert.ok(previous <= L.rules.retreatRadius);
    assert.equal(u.siegeAnchor, undefined);
    step(s, 1800);
    assert.ok(['steady', 'wavering'].includes(u.moraleState), 'tent permits rally without three steady companions');
});

test('P3 #1b: a routed defender outside the broken gate returns inside', () => {
    const s = makeScene(), b = campBounds();
    s.siege = createCampSiege(b, { defense: false });
    queueCampWalls(s); s.dynamicBlockers.requestRemove('south-gate');
    s.siege.gate.broken = true;
    const u = addUnit(s, 'blue', 'infantry', b.cx, b.y2 + 3); rout(u);
    fixed(s, 'red', b.x1 - 8, b.y1 - 8);
    step(s, 600);
    assert.ok(u.gy < b.y2 && u.gy >= b.y1 && u.gx >= b.x1 && u.gx <= b.x2);
    assert.equal(u.withdrawn, false);
});

test('P3 #1b2: routed defender east of mid-wall navigates around it and returns within 600 frames', () => {
    const s = makeScene(), b = campBounds();
    s.siege = createCampSiege(b, { defense: false });
    queueCampWalls(s); s.dynamicBlockers.requestRemove('south-gate');
    s.siege.gate.broken = true;
    const u = addUnit(s, 'blue', 'infantry', b.x2 + 1, b.cy); rout(u);
    fixed(s, 'red', b.x1 - 8, b.y1 - 8);
    let moved = 0, routedFrames = 0;
    for (let i = 0; i < 600; i++) {
        const { gx, gy } = u;
        step(s);
        moved += Math.hypot(u.gx - gx, u.gy - gy);
        if (s.navigation.routes.has(u)) routedFrames++;
    }
    assert.ok(moved > 0, 'accumulate displacement every frame to detect a stuck rout');
    assert.ok(routedFrames > 0, 'dynamic walls require a navigation route');
    assert.ok(u.gx >= b.x1 && u.gx <= b.x2 && u.gy >= b.y1 && u.gy <= b.y2);
    assert.equal(u.withdrawn, false);
});

test('P3 #1c: defender bonus reduces morale loss and accelerates safe tent recovery', () => {
    const run = bonus => {
        const { s, b } = camp({ defenderMoraleBonus: bonus });
        const u = fixed(s, 'blue', b.cx, b.cy);
        fixed(s, 'red', b.x1 - 8, b.cy);
        s.scheduleBattleAction(0, () => applyDamage(u, 10));
        step(s); const afterDamage = u.morale;
        u.morale = 10; rout(u); step(s, 300);
        return { afterDamage, afterRecovery: u.morale };
    };
    const plain = run(0), bonus = run(.5);
    assert.ok(bonus.afterDamage > plain.afterDamage);
    assert.ok(bonus.afterRecovery > plain.afterRecovery);
});

test('P3 #2: tent rout surrender withdraws all defenders; queued arrows cannot damage them', () => {
    const { s, b } = camp();
    s.battleOptions.deathmatch = true;
    const blue = [fixed(s, 'blue', b.cx, b.cy), fixed(s, 'blue', b.cx + 1, b.cy)];
    const red = fixed(s, 'red', b.cx + 3.5, b.cy, 'archer');
    s.withdrawUnit(blue[0]);
    assert.equal(blue[0].withdrawn, false, 'ordinary withdrawal retains deathmatch behavior even with siege rules');
    blue.forEach(rout);
    s.scheduleBattleAction(0, () => s.fireArrow(red, blue[0], { rawAttack: 1000 }));
    step(s);
    assert.equal(s.winner, 'red'); assert.equal(s.endReason, '守军投降');
    assert.ok(blue.every(u => u.withdrawn));
    const hp = blue.map(u => u.hp);
    for (let i = 0; i < 120; i++) { s.simulationTime += 1000 / 60; s.stepBattle(1 / 60); }
    assert.deepEqual(blue.map(u => u.hp), hp);
});

test('P3 #2b: surviving ten percent also surrenders without a tent intruder', () => {
    const { s, b } = camp();
    const defenders = Array.from({ length: 10 }, (_, i) => fixed(s, 'blue', b.cx + i * .8, b.cy));
    fixed(s, 'red', b.x1 - 5, b.cy);
    s.scheduleBattleAction(0, () => defenders.slice(1).forEach(u => applyDamage(u, 10000)));
    step(s);
    assert.equal(s.endReason, '守军投降'); assert.equal(defenders[0].withdrawn, true);
});

test('P3 #3: deaths plus current routs reach 35%, but rally before 20 stalled seconds prevents retreat', () => {
    const { s, b } = camp();
    const red = Array.from({ length: 20 }, (_, i) => fixed(s, 'red', b.x1 - 7, b.y1 + i * .8));
    fixed(s, 'blue', b.cx, b.cy);
    red[7].gx = b.x1 - L.rules.wallFootRadius; red[7].gy = b.cy;
    red.slice(4, 7).forEach(rout);
    s.scheduleBattleAction(0, () => red.slice(0, 4).forEach(u => applyDamage(u, 10000)));
    step(s);
    assert.equal(s.siege.rules.attackerLossRate, .35);
    // Old immediate-retreat expectation becomes no retreat: these routs rally before 20s.
    assert.equal(s.battleOver, false);
    step(s, 1198);
    assert.equal(s.battleOver, false);
    step(s);
    assert.equal(s.battleOver, false);
    assert.ok(s.siege.rules.attackerLossRate < .35);
    assert.ok(red.slice(4, 7).every(u => u.moraleState !== 'routing'));
    assert.ok(red.every(u => !u.withdrawn));
});

function stalledCamp(losses = 7, contact = true) {
    const { s, b } = camp();
    const red = Array.from({ length: 20 }, (_, i) => fixed(s, 'red', b.x1 - 7, b.y1 + i * .8,
        i === 19 ? 'archer' : 'infantry'));
    fixed(s, 'blue', b.cx, b.cy);
    // Timer/progress regressions start with wall contact; pre-contact cases opt out.
    // An archer cannot be recruited by a ladder or ram before the measured event.
    if (contact) { red[19].gx = b.x1 - L.rules.wallFootRadius; red[19].gy = b.cy; }
    s.scheduleBattleAction(0, () => red.slice(0, losses).forEach(u => applyDamage(u, 10000)));
    return { s, b, red };
}

test('P3 #3a: a real new ladder landing above 35% losses resets the 20-second stall timer', t => {
    const { s, b, red } = stalledCamp();
    s.siege = createCampSiege(b, { ladders: true, defense: false, ladderCarry: false });
    queueCampWalls(s);
    step(s, 900);
    assert.equal(s.siege.rules.attackerLossRate, .35);
    assert.ok(s.siege.rules.attackerStallSeconds >= 14.9);
    const ladder = s.siege.ladders[0], climber = red[7];
    s.scheduleBattleAction(0, () => { climber.gx = ladder.foot.gx; climber.gy = ladder.foot.gy; });
    while (!s.siege.landedCount && !s.battleOver && s.simulationTime < 20000) step(s);
    assert.equal(s.siege.landedCount, 1);
    const progressAt = s.siege.rules.lastProgressAt;
    assert.equal(progressAt, s.simulationTime);
    assert.equal(s.siege.rules.attackerStallSeconds, 0);
    assert.equal(s.battleOver, false);
    step(s, 1199);
    assert.equal(s.battleOver, false);
    step(s);
    assert.equal(s.winner, 'blue'); assert.equal(s.endReason, '攻方受挫撤退');
    assert.ok(red.every(u => u.dead || u.withdrawn));
    assert.ok(Math.abs(s.simulationTime - progressAt - 20000) <= 1000 / 60);
    t.diagnostic(`landingAtMs=${progressAt}; retreatAtMs=${s.simulationTime}; elapsedFrames=${Math.round((s.simulationTime - progressAt) / (1000 / 60))}`);
});

test('P3 #3b: a new camp entrant resets the timer once; continued occupancy cannot postpone retreat', () => {
    const { s, b, red } = stalledCamp();
    step(s, 900);
    s.scheduleBattleAction(0, () => { red[7].gx = b.x1 + 2; red[7].gy = b.cy; });
    step(s);
    const progressAt = s.simulationTime;
    assert.equal(s.siege.rules.lastProgressAt, progressAt);
    assert.equal(s.siege.rules.attackerStallSeconds, 0);
    step(s, 1199); assert.equal(s.battleOver, false);
    step(s);
    assert.equal(s.winner, 'blue'); assert.equal(s.endReason, '攻方受挫撤退');
    assert.ok(Math.abs(s.simulationTime - progressAt - 20000) <= 1000 / 60);
});

test('P3 #3c: below 35% losses, even 60 seconds without progress cannot trigger retreat', () => {
    const { s } = stalledCamp(6);
    step(s, 3600);
    assert.equal(s.siege.rules.attackerLossRate, .3);
    assert.ok(s.siege.rules.attackerStallSeconds >= 59.9);
    assert.equal(s.battleOver, false);
});

test('P3 #3b2: leaving and entering the camp again never resets first-entry progress', () => {
    const { s, b, red } = stalledCamp();
    const entrant = red[7];
    step(s, 300);
    s.scheduleBattleAction(0, () => { entrant.gx = b.x1 + 2; entrant.gy = b.cy; });
    step(s);
    const firstEntryAt = s.siege.rules.lastProgressAt;
    step(s, 300);
    assert.equal(s.siege.rules.lastProgressAt, firstEntryAt);
    s.scheduleBattleAction(0, () => { entrant.gx = b.x1 - 2; });
    step(s);
    assert.equal(s.siege.rules.lastProgressAt, firstEntryAt);
    s.scheduleBattleAction(0, () => { entrant.gx = b.x1 + 2; });
    step(s);
    assert.equal(s.siege.rules.lastProgressAt, firstEntryAt);
    assert.ok(s.siege.rules.attackerStallSeconds > 5);
    assert.deepEqual([...s.siege.rules.everInside], [entrant.id]);
    assert.equal(s.battleOver, false);
    step(s, 897); assert.equal(s.battleOver, false);
    step(s);
    assert.equal(s.endReason, '攻方受挫撤退');
    assert.ok(Math.abs(s.simulationTime - firstEntryAt - 20000) <= 1000 / 60);
});

test('P3 #3d: capture gains keep resetting stall time above 35% losses until attacker victory', () => {
    const { s, b, red } = stalledCamp();
    const blue = s.units.find(u => u.team === 'blue');
    step(s, 1199);
    s.scheduleBattleAction(0, () => {
        red[7].gx = b.cx; red[7].gy = b.cy;
        blue.gx = b.cx + 6;
    });
    step(s);
    assert.equal(s.battleOver, false);
    for (let i = 0; i < 480; i++) {
        step(s);
        assert.equal(s.siege.rules.attackerStallSeconds, 0);
        assert.equal(s.siege.rules.lastProgressAt, s.simulationTime);
    }
    assert.equal(s.siege.rules.attackerLossRate, .35);
    assert.equal(s.winner, 'red'); assert.equal(s.endReason, '攻方夺寨');
});

test('P3 #3e: real ram impacts above 35% losses reset the timer until the gate breaks', () => {
    const { s, b, red } = stalledCamp();
    s.siege = createCampSiege(b, { defense: false, ramRestOffset: 3.2 });
    queueCampWalls(s);
    step(s, 600);
    const contactAt = s.siege.rules.contactAt;
    assert.notEqual(contactAt, null);
    const { ram, gate } = s.siege;
    s.scheduleBattleAction(0, () => red.slice(7, 11).forEach((u, i) => {
        u.gx = ram.gx + [-.5, .5, -1, 1][i]; u.gy = ram.gy;
    }));
    let hits = 0;
    while (!gate.broken && !s.battleOver && s.simulationTime < 45000) {
        step(s);
        if (ram.hits === hits) continue;
        assert.equal(ram.hits, ++hits);
        assert.equal(s.siege.rules.attackerLossRate, .35);
        assert.equal(s.siege.rules.lastProgressAt, s.simulationTime);
        assert.equal(s.siege.rules.attackerStallSeconds, 0);
        assert.equal(s.siege.rules.contactAt, contactAt, 'ram progress cannot replace first contact');
        assert.equal(s.battleOver, false);
    }
    assert.equal(hits, 12); assert.equal(gate.broken, true);
    const progressAt = s.siege.rules.lastProgressAt;
    step(s, 1199); assert.equal(s.battleOver, false);
    step(s);
    assert.equal(s.winner, 'blue'); assert.equal(s.endReason, '攻方受挫撤退');
    assert.ok(Math.abs(s.simulationTime - progressAt - 20000) <= 1000 / 60);
});

test('P3 #3f: long pre-contact time never starts stall or retreats, even at a nonzero simulation time', () => {
    const { s, b, red } = stalledCamp(7, false);
    s.simulationTime = 123000;
    assert.equal(s.siege.rules.contactAt, null);
    assert.equal(s.siege.rules.lastProgressAt, null);
    for (let i = 0; i < 3600; i++) {
        step(s);
        assert.equal(s.siege.rules.contactAt, null);
        assert.equal(s.siege.rules.lastProgressAt, null);
        assert.equal(s.siege.rules.attackerStallSeconds, 0);
        assert.equal(s.battleOver, false);
    }
    assert.equal(s.siege.rules.attackerLossRate, .35);
    s.scheduleBattleAction(0, () => { red[7].gx = b.x1 - L.rules.wallFootRadius; red[7].gy = b.cy; });
    step(s);
    const contactAt = s.simulationTime;
    assert.equal(s.siege.rules.contactAt, contactAt);
    assert.equal(s.siege.rules.lastProgressAt, contactAt);
    assert.equal(s.siege.rules.attackerStallSeconds, 0);
    step(s, 1199); assert.equal(s.battleOver, false);
    step(s);
    assert.equal(s.siege.rules.attackerLossRate, .35);
    assert.equal(s.siege.rules.contactAt, contactAt);
    assert.equal(s.siege.rules.lastProgressAt, contactAt);
    assert.equal(s.winner, 'blue'); assert.equal(s.endReason, '攻方受挫撤退');
    assert.ok(Math.abs(s.simulationTime - contactAt - 20000) < 1e-6);
    assert.ok(red.every(u => u.dead || u.withdrawn));
});

test('P3 #3f2: missing stall configuration defaults to 20 seconds and preserves contact at time zero', () => {
    const { s, red } = stalledCamp();
    s.siege.rules.config.attackerStallSeconds = undefined;
    s.simulationTime = -1000 / 60;
    step(s);
    assert.equal(s.siege.rules.contactAt, 0);
    assert.equal(s.siege.rules.lastProgressAt, 0);
    step(s, 1199); assert.equal(s.battleOver, false);
    step(s);
    assert.equal(s.siege.rules.lastProgressAt, 0);
    assert.equal(s.winner, 'blue'); assert.equal(s.endReason, '攻方受挫撤退');
    assert.ok(red.every(u => u.dead || u.withdrawn));
});

test('P3 #3g: deaths plus a current rout at the stall deadline trigger full withdrawal', () => {
    const { s, red } = stalledCamp(6);
    step(s, 1200); assert.equal(s.battleOver, false);
    // Prepare the rout before step() snapshots morale at the start of the frame.
    rout(red[6]);
    step(s);
    assert.equal(s.siege.rules.attackerLossRate, .35);
    assert.equal(s.siege.rules.routedAtOutcome.red, 1);
    assert.equal(s.winner, 'blue'); assert.equal(s.endReason, '攻方受挫撤退');
    assert.ok(red.every(u => u.dead || u.withdrawn));
});

test('P3 #3h: actual arrow casualties above 35% never count as wall contact or start retreat', () => {
    const { s, b } = camp();
    s.battleOptions.deathmatch = true;
    const red = Array.from({ length: 20 }, (_, i) => fixed(s, 'red', b.x1 - 7, b.y1 + i * .8));
    const archer = fixed(s, 'blue', b.cx, b.cy, 'archer');
    archer.lastAttack = Infinity;
    const hits = [], record = s.recordDamage;
    s.recordDamage = function (target, damage, from, at) {
        hits.push([target.id, from.id]);
        return record.call(this, target, damage, from, at);
    };
    s.scheduleBattleAction(0, () => red.slice(0, 7).forEach(u => s.fireArrow(archer, u, { rawAttack: 10000 })));
    for (let i = 0; i < 3600; i++) {
        step(s);
        assert.equal(s.siege.rules.contactAt, null);
        assert.equal(s.siege.rules.lastProgressAt, null);
        assert.equal(s.siege.rules.attackerStallSeconds, 0);
        assert.equal(s.battleOver, false);
    }
    assert.equal(s.battleStats.red.lost, 7);
    assert.ok(s.siege.rules.attackerLossRate >= .35);
    assert.deepEqual(hits.map(([id]) => id).sort((a, b) => a - b), red.slice(0, 7).map(u => u.id));
    assert.ok(hits.every(([, from]) => from === archer.id));
    assert.ok(red.every(u => !u.withdrawn));
});

test('P3 #3i: disengaging and returning never replace first wall contact or postpone the deadline', () => {
    const { s, b, red } = stalledCamp(7, false);
    step(s, 300);
    s.scheduleBattleAction(0, () => { red[7].gx = b.x1 - 2; red[7].gy = b.cy; });
    step(s);
    const contactAt = s.siege.rules.contactAt;
    assert.equal(contactAt, s.simulationTime);
    s.scheduleBattleAction(0, () => { red[7].gx = b.x1 - 7; });
    step(s, 600);
    assert.equal(s.siege.rules.contactAt, contactAt);
    assert.equal(s.siege.rules.lastProgressAt, contactAt);
    assert.ok(Math.abs(s.siege.rules.attackerStallSeconds - 10) < 1e-9);
    s.scheduleBattleAction(0, () => { red[7].gx = b.x1 - 2; });
    step(s, 599);
    assert.equal(s.siege.rules.contactAt, contactAt);
    assert.equal(s.siege.rules.lastProgressAt, contactAt);
    assert.equal(s.battleOver, false);
    step(s);
    assert.equal(s.siege.rules.contactAt, contactAt);
    assert.equal(s.endReason, '攻方受挫撤退');
    assert.ok(Math.abs(s.simulationTime - contactAt - 20000) < 1e-6);
});

test('P3 #3j: a real climb alone latches contact before landing or ram impact', () => {
    const s = makeScene(), b = campBounds();
    // Isolate the climb trigger from wall-foot proximity without changing production defaults.
    s.siege = createCampSiege(b, { ladders: true, defense: false, ladderCarry: false, rules: { wallFootRadius: 0 } });
    queueCampWalls(s);
    const ladder = s.siege.ladders[0];
    const climber = fixed(s, 'red', ladder.foot.gx, ladder.foot.gy);
    fixed(s, 'blue', b.cx, b.cy);
    assert.equal(s.siege.rules.contactAt, null);
    step(s);
    assert.ok(climber.siegeClimb?.progress > 0);
    assert.ok(climber.gx < b.x1 - L.wallThickness, 'climber is still beyond the wall outer edge');
    assert.equal(s.siege.landedCount, 0);
    assert.equal(s.siege.ram.hits, 0);
    assert.equal(s.siege.rules.contactAt, s.simulationTime);
    assert.equal(s.siege.rules.lastProgressAt, s.simulationTime);
    assert.equal(s.siege.rules.attackerStallSeconds, 0);
});

test('P3 #3k: the first real ram hit alone latches contact', () => {
    const s = makeScene(), b = campBounds();
    s.siege = createCampSiege(b, { defense: false, ramRestOffset: 3.2, rules: { wallFootRadius: 0 } });
    queueCampWalls(s);
    const { ram } = s.siege;
    for (const dx of [-.4, .4, -.8, .8]) fixed(s, 'red', ram.gx + dx, ram.gy);
    fixed(s, 'blue', b.cx, b.cy);
    for (let i = 0; i < 600 && ram.hits === 0; i++) {
        step(s);
        assert.ok(s.units.filter(u => u.team === 'red').every(u => u.gy > b.y2 + L.wallThickness && !u.siegeClimb));
        if (ram.hits === 0) {
            assert.equal(s.siege.rules.contactAt, null);
            assert.equal(s.siege.rules.lastProgressAt, null);
            assert.equal(s.siege.rules.attackerStallSeconds, 0);
        }
    }
    assert.equal(ram.hits, 1);
    assert.equal(s.siege.rules.contactAt, ram.lastHitAt);
    assert.equal(s.siege.rules.contactAt, s.simulationTime);
    assert.equal(s.siege.rules.lastProgressAt, s.simulationTime);
});

test('P3 #3l: contact uses the quantized outer-wall distance and excludes ineligible units', () => {
    for (const [offset, expected] of [[0, true], [.024999, true], [.025001, false]]) {
        const s = makeScene(), b = campBounds();
        s.siege = createCampSiege(b, { defense: false });
        fixed(s, 'red', b.x1 - L.wallThickness - L.rules.wallFootRadius - offset, b.cy, 'archer');
        fixed(s, 'blue', b.cx, b.cy);
        step(s);
        assert.equal(s.siege.rules.contactAt, expected ? s.simulationTime : null, `outer-wall offset=${offset}`);
    }
    const { s, b } = camp();
    fixed(s, 'red', b.cx - 6, b.cy); // Already inside, but too far from the tent to capture.
    const dead = fixed(s, 'red', b.x1 - 1, b.y1 + 2);
    const withdrawn = fixed(s, 'red', b.x1 - 1, b.y1 + 4);
    const routed = fixed(s, 'red', b.x1 - 1, b.y1 + 6); rout(routed);
    fixed(s, 'blue', b.cx, b.cy);
    s.scheduleBattleAction(0, () => { applyDamage(dead, 10000); s.withdrawUnit(withdrawn); });
    step(s);
    assert.equal(dead.dead, true);
    assert.equal(withdrawn.withdrawn, true);
    assert.equal(routed.moraleState, 'routing');
    assert.equal(s.siege.rules.contactAt, null);
    assert.equal(s.siege.rules.lastProgressAt, null);
    assert.equal(s.siege.rules.attackerStallSeconds, 0);
    assert.equal(s.battleOver, false);
});

test('P3 #3m: quantized contact, disengagement and retreat replay frame-for-frame after swapping teams and mirroring', () => {
    function run(swapped = false) {
        const s = makeScene(), b = campBounds(), frames = [];
        const attackerTeam = swapped ? 'blue' : 'red', defenderTeam = swapped ? 'red' : 'blue';
        const mirrorX = x => swapped ? 2 * b.cx - x : x;
        s.siege = createSiegeLayer([], { bounds: b, wallThickness: L.wallThickness,
            rules: { ...L.rules, attackerTeam, defenderTeam } });
        const attackers = Array.from({ length: 20 }, (_, i) => fixed(s, attackerTeam, mirrorX(b.x1 - 7), b.y1 + i * .8));
        fixed(s, defenderTeam, b.cx, b.cy);
        s.scheduleBattleAction(0, () => attackers.slice(0, 7).forEach(u => applyDamage(u, 10000)));
        const probe = attackers[7], rules = s.siege.rules;
        let contactAt = null;
        for (let frame = 1; frame <= 1500 && !s.battleOver; frame++) {
            if ([60, 120, 300, 600].includes(frame)) s.scheduleBattleAction(0, () => {
                const distance = frame === 60 ? L.rules.wallFootRadius + .025001 :
                    frame === 300 ? 7 : L.rules.wallFootRadius + .024999;
                probe.gx = mirrorX(b.x1 - L.wallThickness - distance); probe.gy = b.cy;
            });
            step(s);
            if (frame < 120) assert.equal(rules.contactAt, null);
            if (frame === 120) { contactAt = s.simulationTime; assert.equal(rules.contactAt, contactAt); }
            if (frame >= 120) {
                assert.equal(rules.contactAt, contactAt);
                assert.equal(rules.lastProgressAt, contactAt);
            }
            frames.push([s.units.map(u => [u.id, u.hp, u.dead, u.withdrawn, u.morale, u.moraleState]),
                rules.contactAt, rules.lastProgressAt, rules.attackerStallSeconds, rules.attackerLossRate,
                rules.captureSeconds, [...rules.everInside], rules.landedCount, rules.ramHits,
                s.battleOver, s.winner === undefined ? null : s.winner === attackerTeam ? 'attacker' : 'defender', s.endReason]);
        }
        assert.equal(s.endReason, '攻方受挫撤退');
        assert.ok(Math.abs(s.simulationTime - contactAt - 20000) < 1e-6);
        return frames;
    }
    const frames = run();
    assert.deepEqual(run(), frames);
    assert.deepEqual(run(true), frames);
});

test('P3 #4: eight uninterrupted seconds capture; a living defender resets the clock', () => {
    const { s, b } = camp();
    fixed(s, 'red', b.cx, b.cy);
    const blue = fixed(s, 'blue', b.cx + 6, b.cy);
    step(s, 240);
    assert.ok(s.siege.rules.captureSeconds > 3.9 && !s.battleOver);
    assert.equal(s.siege.rules.contactAt, null, 'starting inside alone is not siege contact');
    assert.equal(s.siege.rules.lastProgressAt, null);
    assert.equal(s.siege.rules.attackerStallSeconds, 0);
    s.scheduleBattleAction(0, () => { blue.gx = b.cx + 2.4; });
    step(s);
    assert.equal(s.siege.rules.captureSeconds, 0);
    s.scheduleBattleAction(0, () => { blue.gx = b.cx + 6; });
    step(s, 480);
    assert.equal(s.battleOver, false);
    step(s);
    assert.equal(s.winner, 'red'); assert.equal(s.endReason, '攻方夺寨');
});

test('P3 #5: tower and ground archers choose waiting climber, crew, wall foot, then nearest; ties use id', () => {
    for (const tower of [false, true]) {
        const { s, b } = camp();
        const archer = fixed(s, 'blue', b.cx, b.y1 + .4, 'archer');
        if (tower) archer.siegeAnchor = { gx: archer.gx, gy: archer.gy };
        const waiting = fixed(s, 'red', b.cx + 3, b.y1 - .4); waiting.siegeClimb = { waiting: true };
        const crew = fixed(s, 'red', b.cx + 2, b.y1 - 1); crew.siegeRole = 'ram';
        const foot = fixed(s, 'red', b.cx + 1, b.y1 - 1);
        const low = fixed(s, 'red', b.cx, b.y1 + 1.5); low.hp = 1;
        const tied = fixed(s, 'red', b.cx, b.y1 + 1.5); tied.hp = 100;
        let chosen;
        s.playAttackAnim = (from, to) => { if (from === archer) chosen = to; };
        for (const expected of [waiting, low, tied, crew, null]) {
            chosen = null; archer.lastAttack = -Infinity;
            step(s);
            assert.equal(chosen, expected);
            if (expected) s.scheduleBattleAction(0, () => s.withdrawUnit(expected));
        }
    }
});

test('P3 #6a: gate starts at 1800 and breaks on the twelfth 150 hp impact', () => {
    const s = makeScene(), b = campBounds();
    s.siege = createCampSiege(b, { defense: false, ramRestOffset: 3.2 }); queueCampWalls(s);
    const ram = s.siege.ram, gate = s.siege.gate;
    for (const dx of [-.5, .5, -1, 1]) fixed(s, 'red', ram.gx + dx, ram.gy);
    fixed(s, 'blue', b.cx, b.cy);
    assert.equal(gate.hp, 1800);
    let hits = 0;
    for (let i = 0; i < 2100 && !gate.broken; i++) {
        step(s);
        if (ram.hits !== hits) {
            hits++; assert.equal(ram.hits, hits); assert.equal(gate.hp, 1800 - 150 * hits);
            assert.equal(gate.broken, hits === 12);
            assert.equal(s.siege.rules.lastProgressAt, s.simulationTime);
            assert.equal(s.siege.rules.attackerStallSeconds, 0);
        }
    }
    assert.equal(hits, 12);
    step(s); assert.ok(!s.dynamicBlockers.list.some(r => r.id === gate.blockerId));
});

test('P3 #6a2: below 35% losses, real arrows stop the ram and replacement crew resumes impacts', () => {
    const s = makeScene(), b = campBounds();
    s.siege = createCampSiege(b, { defense: false, ramRestOffset: 3.2 }); queueCampWalls(s);
    const { ram, gate } = s.siege;
    const hits = [], record = s.recordDamage;
    s.recordDamage = function (target, damage, from, at) {
        hits.push({ from: from.id, target: target.id, damage });
        return record.call(this, target, damage, from, at);
    };
    const crew = [-.4, .4, -.8, .8].map(dx => fixed(s, 'red', ram.gx + dx, ram.gy));
    for (let i = 0; i < 6; i++) fixed(s, 'red', b.x1 - 8, b.y1 + i);
    fixed(s, 'blue', b.cx, b.cy);
    for (const u of s.units) u.hp = u.maxHp = 10000;
    while (ram.state !== 'hitting' && s.simulationTime < 5000) step(s);
    step(s);
    const archer = fixed(s, 'blue', ram.gx + 10, ram.gy, 'archer');
    archer.typeData = { ...archer.typeData, range: 0 };
    s.scheduleBattleAction(0, () => crew.slice(0, 3).forEach(u => s.fireArrow(archer, u, { rawAttack: 100000 })));
    step(s, 46);
    assert.equal(crew.filter(u => u.dead).length, 3);
    assert.equal(s.battleOver, false); assert.equal(s.siege.rules.attackerLossRate, .3);
    const stopped = [ram.gx, ram.gy, gate.hp, ram.hitMs];
    for (let i = 0; i < 150; i++) { step(s); assert.deepEqual([ram.gx, ram.gy, gate.hp, ram.hitMs], stopped); }
    const replacement = fixed(s, 'red', ram.gx + 3, ram.gy);
    const addedAt = Math.round(s.simulationTime / (1000 / 60));
    let recruitedAt = null;
    for (let i = 0; i < 252; i++) {
        step(s);
        if (replacement.siegeRole === 'ram' && recruitedAt === null) recruitedAt = Math.round(s.simulationTime / (1000 / 60));
    }
    assert.notEqual(recruitedAt, null);
    assert.ok(recruitedAt - addedAt <= 120);
    assert.ok(!hits.some(h => h.from === replacement.id), 'pinned replacement never deals damage');
    assert.equal(replacement.siegeRole, 'ram');
    assert.equal(ram.crew.filter(id => id !== null).length, 2);
    assert.ok(gate.hp < stopped[2]); assert.equal(s.battleOver, false);
});

test('P3 #6b: real ladder guard hits deal exactly 1.5 times final damage', () => {
    function run(multiplier) {
        const s = makeScene(), b = campBounds();
        s.siege = createCampSiege(b, { ladders: true, defense: false, ladderCarry: false, rules: { ladderGuardDamage: multiplier } });
        queueCampWalls(s);
        const ladder = s.siege.ladders[0];
        const attacker = fixed(s, 'red', ladder.foot.gx, ladder.foot.gy);
        const guard = fixed(s, 'blue', ladder.landing.gx, ladder.landing.gy);
        attacker.hp = attacker.maxHp = guard.hp = guard.maxHp = 10000;
        const hits = [], record = s.recordDamage;
        s.recordDamage = function (target, damage, from, at) {
            if (from === guard && target === attacker) { assert.equal(attacker.siegeClimb?.waiting, true); hits.push(damage); }
            return record.call(this, target, damage, from, at);
        };
        step(s, 600); assert.ok(hits.length >= 3);
        return hits;
    }
    const base = run(1), boosted = run(1.5);
    assert.deepEqual(boosted, base.map(d => d * 1.5));
});

test('P3 #6c: battle end freezes ram, recruitment and active ladder progress', () => {
    const s = makeScene(), b = campBounds();
    s.siege = createCampSiege(b, { ladders: true, defense: false, ladderCarry: false }); queueCampWalls(s);
    const { ram, ladders } = s.siege;
    for (const dx of [-.4, .4, -.8, .8]) fixed(s, 'red', ram.gx + dx, ram.gy);
    const climber = fixed(s, 'red', ladders[0].foot.gx, ladders[0].foot.gy);
    fixed(s, 'blue', b.cx, b.cy);
    step(s);
    assert.equal(ram.crew.filter(id => id !== null).length, 4);
    assert.equal(climber.siegeRole, 'ladder');
    assert.ok(climber.siegeClimb.progress > 0 && climber.siegeClimb.progress < 1);
    s.battleOver = true;
    const candidate = fixed(s, 'red', ladders[1].foot.gx, ladders[1].foot.gy);
    const snapshot = () => structuredClone({ ram, gate: s.siege.gate, ladders,
        landedCount: s.siege.landedCount,
        units: s.units.map(u => ({ id: u.id, gx: u.gx, gy: u.gy, role: u.siegeRole, anchor: u.siegeAnchor,
            progress: u.siegeClimb?.progress, height: u.siegeClimb?.height })) });
    const ended = snapshot();
    for (let i = 0; i < 252; i++) {
        s.simulationTime += 1000 / 60;
        s.siege.step(s, 1 / 60);
        assert.deepEqual(snapshot(), ended);
    }
    assert.equal(candidate.siegeRole, undefined);
});

test('P3 #6d: battle end freezes defense assignments and defender positions', () => {
    const s = makeScene(), b = campBounds();
    s.siege = createCampSiege(b, { ladders: true, defense: true }); queueCampWalls(s);
    for (let i = 0; i < 40; i++) addUnit(s, 'blue', 'infantry', b.cx + (i % 8) * .5, b.cy + Math.floor(i / 8) * .5);
    const attacker = fixed(s, 'red', b.x1 - 3, b.cy);
    step(s);
    assert.ok(s.siege.defense.assignments.size > 0);
    s.battleOver = true;
    // Shift the threat so an unfrozen defense would reallocate wall posts.
    attacker.gx = b.x2 + 3;
    const snapshot = () => ({
        assignments: [...s.siege.defense.assignments].map(([u, a]) => [u.id, a.post.id]),
        positions: s.units.filter(u => u.team === 'blue').map(u => [u.id, u.gx, u.gy])
    });
    const ended = snapshot();
    for (let i = 0; i < 240; i++) {
        s.simulationTime += 1000 / 60;
        s.siege.step(s, 1 / 60);
        assert.deepEqual(snapshot(), ended);
    }
});

function field(mode, layer) {
    const s = makeScene(); if (layer) s.siege = layer;
    for (let i = 0; i < 6; i++) { addUnit(s, 'red', 'infantry', 30, 27 + i); addUnit(s, 'blue', 'infantry', 36, 27 + i); }
    if (mode === 'rout') s.units.filter(u => u.team === 'blue').forEach(rout);
    if (mode === 'stalemate') s.tactics = { summary() {}, beginStep() {}, updateGroundGuard() {}, updateUnit() {}, reserveSupport: () => false, isStalemate: () => true };
    const frames = [];
    for (let i = 0; i < 600; i++) {
        s.simulationTime += 1000 / 60; s.stepBattle(1 / 60);
        frames.push([s.units.map(u => [u.id, u.gx, u.gy, u.hp, u.dead, u.withdrawn, u.morale, u.moraleState]), s.battleOver, s.winner, s.endReason]);
    }
    return frames;
}
test('P3 #7: siege ignores five-second collapse and stalemate; non-siege matches three pre-edit golden trajectories', () => {
    const { s, b } = camp();
    const blue = fixed(s, 'blue', b.cx, b.cy); rout(blue);
    fixed(s, 'red', b.x1 - 6, b.cy);
    s.tactics = { summary() {}, beginStep() {}, updateGroundGuard() {}, updateUnit() {}, reserveSupport: () => false, isStalemate: () => true };
    step(s, 360); assert.equal(s.battleOver, false);
    const golden = ['29b65e4b3cde9e30e532546a64531ca760fb505c9d2e0c247e3cae049cf13ea7',
        '14ed5a227a8fbfc0a5ae39e41936581a7b4ef28aa91cb252a31a4390a2397cbe',
        '29285129ec1cc8f9cd65d1c78e121d3ac6d715eefcb17334e69fa58d75328e29'];
    ['combat', 'rout', 'stalemate'].forEach((mode, i) => {
        const baseline = field(mode);
        assert.equal(hash(baseline.map(hash)), golden[i], 'captured at 1af1f2a before edits');
        assert.deepEqual(field(mode, createSiegeLayer([])), baseline);
        assert.deepEqual(field(mode, createSiegeLayer([], { bounds: b, rules: { ...L.rules, enabled: false } })), baseline);
    });
});

test('P3 #7b: siege still settles elimination with an explicit reason', () => {
    const { s, b } = camp();
    fixed(s, 'red', b.cx, b.cy);
    const blue = fixed(s, 'blue', b.cx + 7, b.cy);
    s.scheduleBattleAction(0, () => applyDamage(blue, 10000));
    step(s); assert.equal(s.winner, 'red'); assert.equal(s.endReason, '一方全灭');
});

test('P3 #8: same 300v100 variant repeats an entire battle frame-for-frame', t => {
    function run() {
        const s = deployVariant({ variant: 1 }), frames = [];
        for (let i = 0; i < 21600 && !s.battleOver; i++) {
            step(s);
            frames.push(hash([s.units.map(u => [u.id, u.gx, u.gy, u.hp, u.dead, u.withdrawn, u.morale, u.moraleState,
                u.siegeRole, u.siegeDefenseRole, u.siegeClimb?.progress]), s.siege.ram, s.siege.gate,
                s.siege.rules.captureSeconds, s.siege.rules.attackerLossRate,
                s.siege.rules.contactAt, s.siege.rules.lastProgressAt, s.siege.rules.attackerStallSeconds,
                [...s.siege.rules.everInside], s.siege.rules.landedCount, s.siege.rules.ramHits,
                s.arrows.map(a => ({ ...a, source: a.source?.id })), s.endReason, s.winner]));
        }
        assert.equal(s.battleOver, true); return frames;
    }
    const frames = run();
    assert.deepEqual(frames, run());
    t.diagnostic(`variant=1 frames=${frames.length} trajectorySha256=${hash(frames)}`);
});
