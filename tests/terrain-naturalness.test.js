import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBankField, bankDistance, bankAppearance, sampleBankWeight, slopeAppearance, rockPlacements } from '../js/render/terrain-naturalness.js';
import { sampleWaterField } from '../js/render/terrain-boundaries.js';
import { Terrain } from '../js/terrain.js';
import { board } from '../js/board.js';

const rect = (x1, y1, x2, y2, kind = 'water') => ({ x1, y1, x2, y2, kind });

test('soft banks follow the channel union and interpolate at sample centres', () => {
    const split = buildBankField({ blockers: [rect(0, 0, 4, 6), rect(4, 0, 8, 6)] });
    const whole = buildBankField({ blockers: [rect(0, 0, 8, 6)] });
    assert.deepEqual(split.signedDistance, whole.signedDistance, 'no invented bank at a source rectangle seam');
    assert.equal(bankDistance(split, 4, 3), 2.875);
    assert.equal(bankDistance(split, 3, 0), 0, 'zero crossing lies at the real bank');
    assert.equal(bankDistance(split, 3, -0.75), -0.75, 'land retains its signed bank distance');
    assert.ok(Math.abs(bankDistance(split, 3.99, 3) - bankDistance(split, 4.01, 3)) < 0.01);
});

test('shallow sediment changes continuously without changing classification', () => {
    const field = buildBankField({ blockers: [rect(0, 0, 4, 6)], zones: [rect(4, 0, 8, 6, 'shallow')] });
    const left = sampleBankWeight(field, field.shallowWeight, 3.99, 3);
    const right = sampleBankWeight(field, field.shallowWeight, 4.01, 3);
    assert.ok(left > 0.4 && right < 0.6 && Math.abs(left - right) < 0.04);
    assert.equal(sampleWaterField(field, 3.99, 3).kind, 1);
    assert.equal(sampleWaterField(field, 4.01, 3).kind, 2);
    assert.ok([...field.shallowWeight].every(value => Number.isFinite(value) && value >= 0 && value <= 1));
});

test('feathered shores leave land crossings dry and real water visible', () => {
    const field = buildBankField({ blockers: [rect(0, 0, 3, 6), rect(4, 0, 7, 6)] });
    for (const x of [3.125, 3.5, 3.875]) {
        const kind = sampleWaterField(field, x, 3).kind;
        assert.equal(kind, 0);
        assert.equal(bankAppearance(kind, bankDistance(field, x, 3), 0.7).water, 0);
    }
    assert.ok(bankAppearance(1, 0.01, 0.7).water >= 0.58, 'blocked water cannot be disguised as a walkable bank');
    assert.equal(bankAppearance(0, -Infinity, 0.5).shore, 0);
    assert.equal(buildBankField({}).signedDistance.length, 0);
});

test('terrain visual sampling leaves bridge, geometry and height rules intact', () => {
    const previous = { ...board };
    board.W = 104; board.H = 72;
    try {
        const geometry = Terrain.geometry('territory'), before = JSON.stringify(geometry);
        const heights = [Terrain.height('territory', 52, 36), Terrain.height('territory', 57, 39)];
        const field = buildBankField(geometry);
        assert.equal(sampleWaterField(field, 52, 16).kind, 3);
        assert.ok(bankDistance(field, 52, 16) > 2, 'bridge has no internal shoreline');
        assert.equal(Terrain.walkable('territory', 52, 16), true);
        for (let y = 30; y <= 42; y += 0.5) for (let x = 44; x <= 60; x += 0.5) slopeAppearance('territory', x, y, 0.6);
        rockPlacements(geometry);
        assert.equal(JSON.stringify(geometry), before);
        assert.deepEqual([Terrain.height('territory', 52, 36), Terrain.height('territory', 57, 39)], heights);
    } finally { Object.assign(board, previous); }
});

test('relief distinguishes opposing slopes and leaves flat ground untreated', () => {
    assert.deepEqual(slopeAppearance('flat', 30, 30, 0.7), { light: 0, earth: 0, stone: 0, dry: 0 });
    const previous = { ...board };
    board.W = 104; board.H = 72;
    try {
        const up = slopeAppearance('territory', 46, 36, 0.7), down = slopeAppearance('territory', 58, 36, 0.7);
        assert.ok(up.light > 0.15 && down.light < -0.15, 'real slope direction drives relief light');
        assert.ok(up.earth > 0.15 && down.earth > 0.15, 'steep slopes expose soil');
        assert.ok(up.stone > 0 && down.stone > 0);
    } finally { Object.assign(board, previous); }
});

test('rock clusters stay within blockers, vary in silhouette and survive subdivision', () => {
    const geometry = { blockers: [rect(10, 20, 20, 26, 'rock')] };
    const positions = rockPlacements(geometry);
    const subdivided = rockPlacements({ blockers: [rect(10, 20, 16, 26, 'rock'), rect(15, 20, 20, 26, 'rock')] });
    assert.deepEqual(subdivided, positions, 'overlapping rock rectangles must not duplicate modules');
    assert.deepEqual(rockPlacements(geometry), positions, 'render arrangement is reproducible');
    assert.ok(positions.length > 20);
    assert.equal(new Set(positions.map(p => p.frame)).size, 6);
    assert.ok(new Set(positions.filter(p => p.frame < 3).map(p => p.height)).size > 3);
    for (const p of positions) assert.ok(p.x >= 10 && p.x < 20 && p.y >= 20 && p.y < 26);
    assert.equal(new Set(positions.map(p => `${p.x},${p.y}`)).size, positions.length);
    assert.deepEqual(rockPlacements({ blockers: [] }), []);
});
