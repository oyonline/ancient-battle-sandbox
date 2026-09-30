import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWaterField, sampleWaterField } from '../js/render/terrain-boundaries.js';
import { Terrain } from '../js/terrain.js';
import { board } from '../js/board.js';

const rect = (x1, y1, x2, y2, kind = 'water') => ({ x1, y1, x2, y2, kind });

test('adjacent water rectangles share a continuous channel without an interior bank', () => {
    const field = buildWaterField({ blockers: [rect(0, 0, 4, 6), rect(4, 0, 8, 6)], zones: [] });
    const whole = buildWaterField({ blockers: [rect(0, 0, 8, 6)], zones: [] });
    assert.deepEqual(field.kinds, whole.kinds);
    assert.deepEqual(field.distance, whole.distance, 'rectangle subdivision must not affect shoreline distance');
    for (const x of [3.25, 3.75, 4, 4.25, 4.75]) {
        const sample = sampleWaterField(field, x, 3.25);
        assert.equal(sample.kind, 1);
        assert.equal(sample.distance, 2.75, 'channel centre stays deep across the former seam');
    }
    assert.equal(sampleWaterField(field, 4, 0.25).distance, 0.25, 'actual outer bank remains shallow');
});

test('bridge and shallow zones carry the channel through gaps and take classification priority', () => {
    const field = buildWaterField({
        blockers: [rect(0, 0, 4, 6), rect(6, 0, 10, 6)],
        zones: [rect(3, 0, 5, 6, 'shallow'), rect(4, 0, 7, 6, 'bridge')]
    });
    for (const [x, kind] of [[2.75, 1], [3.25, 2], [4.25, 3], [5.25, 3], [6.25, 3], [7.25, 1]]) {
        const sample = sampleWaterField(field, x, 3.25);
        assert.equal(sample.kind, kind, `classification at x=${x}`);
        assert.equal(sample.distance, 2.75, `no interior bank at x=${x}`);
    }
    const reverse = buildWaterField({
        blockers: [rect(0, 0, 4, 6), rect(6, 0, 10, 6)],
        zones: [rect(4, 0, 7, 6, 'bridge'), rect(3, 0, 5, 6, 'shallow')]
    });
    assert.deepEqual(field.kinds, reverse.kinds, 'bridge priority does not depend on input order');
});

test('disconnected channels keep their own banks and intervening land', () => {
    const field = buildWaterField({ blockers: [rect(0, 0, 3, 4), rect(5, 0, 8, 4)] });
    assert.equal(sampleWaterField(field, 2.75, 2.25).distance, 0.25);
    assert.equal(sampleWaterField(field, 5.25, 2.25).distance, 0.25);
    assert.deepEqual(sampleWaterField(field, 4, 2.25), { kind: 0, distance: 0 });
    assert.equal(sampleWaterField(field, 1.25, 2.25).distance, 1.25);
});

test('one-sample-wide water has a finite positive shore distance', () => {
    const field = buildWaterField({ blockers: [rect(0, 0, 0.5, 4)] });
    assert.deepEqual(sampleWaterField(field, 0.25, 2.25), { kind: 1, distance: 0.25 });
    assert.ok([...field.distance].every(Number.isFinite));
});

test('empty or non-water geometry returns an empty field', () => {
    for (const geometry of [{}, { blockers: [], zones: [] }, { blockers: [rect(0, 0, 2, 2, 'rock')], zones: [rect(0, 0, 2, 2, 'forest')] }]) {
        const field = buildWaterField(geometry);
        assert.equal(field.cols, 0);
        assert.equal(field.rows, 0);
        assert.ok(field.kinds instanceof Uint8Array);
        assert.ok(field.distance instanceof Float32Array);
        assert.equal(field.kinds.length, 0);
        assert.equal(field.distance.length, 0);
        assert.deepEqual(sampleWaterField(field, 0, 0), { kind: 0, distance: 0 });
    }
});

test('invalid sampling or channel coordinates are rejected', () => {
    for (const step of [0, -0.5, NaN, Infinity]) {
        assert.throws(() => buildWaterField({}, { step }), RangeError);
    }
    for (const channel of [rect(NaN, 0, 2, 2), rect(0, 0, Infinity, 2), rect(2, 0, 1, 2), rect(0, 0, 2, 0)]) {
        assert.throws(() => buildWaterField({ blockers: [channel] }), RangeError);
    }
});

test('territory channels agree with simulation surfaces, bridge passability and mirrored bank distances', () => {
    const previous = { ...board };
    board.W = 104; board.H = 72;
    try {
        const geometry = Terrain.geometry('territory');
        const before = JSON.stringify(geometry);
        const field = buildWaterField(geometry);
        let water = 0, shallow = 0, bridge = 0;
        for (let row = 0; row < field.rows; row++) {
            for (let col = 0; col < field.cols; col++) {
                const index = row * field.cols + col;
                const gx = field.x1 + (col + 0.5) * field.step;
                const gy = field.y1 + (row + 0.5) * field.step;
                const kind = field.kinds[index];
                const mirrored = sampleWaterField(field, board.W - gx, gy);
                assert.equal(mirrored.kind, kind, `mirrored classification at (${gx}, ${gy})`);
                assert.ok(Math.abs(mirrored.distance - field.distance[index]) <= field.step, `mirrored distance at (${gx}, ${gy})`);
                if (kind === 0) continue;
                assert.equal(Terrain.surface('territory', gx, gy), ['', 'water', 'shallow', 'bridge'][kind]);
                assert.ok(Number.isFinite(field.distance[index]) && field.distance[index] > 0);
                if (kind === 1) water++;
                if (kind === 2) shallow++;
                if (kind === 3) {
                    bridge++;
                    assert.equal(Terrain.walkable('territory', gx, gy, 0), true, 'rendered bridge remains walkable');
                }
            }
        }
        assert.ok(water > 0 && shallow > 0 && bridge > 0, 'all three channel kinds are present');
        assert.equal(sampleWaterField(field, 52, 16).kind, 3);
        assert.equal(Terrain.walkable('territory', 52, 16), true);
        assert.ok(sampleWaterField(field, 52, 16).distance >= 2.5, 'water under the bridge stays continuous');
        assert.equal(JSON.stringify(geometry), before, 'render sampling does not mutate simulation geometry');
    } finally {
        Object.assign(board, previous);
    }
});
