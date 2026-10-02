// View-only fields: continuous material weights never change the discrete surface.
import { buildWaterFieldSteps } from './terrain-boundaries.js';
import { Terrain } from '../terrain.js';

const ROWS_PER_STEP = 8;
const clamp = value => Math.max(0, Math.min(1, value));
const smooth = (low, high, value) => {
    const t = clamp((value - low) / (high - low));
    return t * t * (3 - 2 * t);
};

export function buildBankField(geometry, options) {
    const steps = buildBankFieldSteps(geometry, options);
    let result;
    do { result = steps.next(); } while (!result.done);
    return result.value;
}

export function* buildBankFieldSteps(geometry, { step = 0.25, padding = 2 } = {}) {
    const field = yield* buildWaterFieldSteps(geometry, { step, padding });
    const { cols, rows, kinds, distance } = field;
    const outside = new Float32Array(kinds.length);
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const i = row * cols + col;
            outside[i] = kinds[i] ? 0 : Infinity;
        }
        if ((row + 1) % ROWS_PER_STEP === 0 || row + 1 === rows) yield;
    }
    const diagonal = step * Math.SQRT2;
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const i = row * cols + col;
            if (kinds[i]) continue;
            if (col > 0) outside[i] = Math.min(outside[i], outside[i - 1] + step);
            if (row > 0) {
                outside[i] = Math.min(outside[i], outside[i - cols] + step);
                if (col > 0) outside[i] = Math.min(outside[i], outside[i - cols - 1] + diagonal);
                if (col + 1 < cols) outside[i] = Math.min(outside[i], outside[i - cols + 1] + diagonal);
            }
        }
        if ((row + 1) % ROWS_PER_STEP === 0 || row + 1 === rows) yield;
    }
    for (let row = rows - 1; row >= 0; row--) {
        for (let col = cols - 1; col >= 0; col--) {
            const i = row * cols + col;
            if (kinds[i]) continue;
            if (col + 1 < cols) outside[i] = Math.min(outside[i], outside[i + 1] + step);
            if (row + 1 < rows) {
                outside[i] = Math.min(outside[i], outside[i + cols] + step);
                if (col > 0) outside[i] = Math.min(outside[i], outside[i + cols - 1] + diagonal);
                if (col + 1 < cols) outside[i] = Math.min(outside[i], outside[i + cols + 1] + diagonal);
            }
        }
        if ((rows - row) % ROWS_PER_STEP === 0 || row === 0) yield;
    }
    field.signedDistance = new Float32Array(kinds.length);
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const i = row * cols + col;
            field.signedDistance[i] = kinds[i] ? distance[i] : -Math.max(step / 2, outside[i] - step / 2);
        }
        if ((row + 1) % ROWS_PER_STEP === 0 || row + 1 === rows) yield;
    }
    // Blur material weight inside the channel only; a shallow/water boundary is
    // a sediment transition, not another shoreline or a new terrain category.
    const kernel = [1, 4, 6, 4, 1];
    field.shallowWeight = new Float32Array(kinds.length);
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const i = row * cols + col;
            if (!kinds[i]) continue;
            let total = 0, shallow = 0;
            for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
                const x = col + ox, y = row + oy;
                if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
                const kind = kinds[y * cols + x], weight = kernel[ox + 2] * kernel[oy + 2];
                if (!kind) continue;
                total += weight;
                if (kind === 2) shallow += weight;
            }
            field.shallowWeight[i] = shallow / total;
        }
        if ((row + 1) % ROWS_PER_STEP === 0 || row + 1 === rows) yield;
    }
    return field;
}

export function sampleBankWeight(field, values, gx, gy, fallback = 0) {
    // Samples live at cell centres; interpolating enums would invent water on land.
    const x = (gx - field.x1) / field.step - 0.5, y = (gy - field.y1) / field.step - 0.5;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= field.cols - 1 || y >= field.rows - 1) return fallback;
    const col = Math.floor(x), row = Math.floor(y), u = x - col, v = y - row;
    const i = row * field.cols + col, d = values;
    return (d[i] * (1 - u) + d[i + 1] * u) * (1 - v) +
        (d[i + field.cols] * (1 - u) + d[i + field.cols + 1] * u) * v;
}

export function bankDistance(field, gx, gy) {
    return sampleBankWeight(field, field.signedDistance, gx, gy, -Infinity);
}

export function bankAppearance(kind, distance, variation, shallowWeight = kind === 2 ? 1 : 0) {
    const n = clamp(variation);
    const fringe = 0.18 + n * 0.16;
    // Only real channel cells get water. Mud and gravel round the visual shore
    // within a narrow band without widening a blocker or hiding a land crossing.
    const water = kind ? 0.58 + smooth(0, fringe, Math.max(0, distance)) * 0.42 : 0;
    const depth = smooth(0.12, 2.5 + n * 0.6, Math.max(0, distance));
    const shore = 1 - smooth(0.05, 1.1 + n * 0.65, Math.abs(distance));
    return { water, depth, shore, shallow: clamp(shallowWeight) * 0.34 };
}

export function slopeAppearance(key, gx, gy, variation) {
    const height = Terrain.height(key, gx, gy);
    const dx = Terrain.height(key, gx + 0.25, gy) - Terrain.height(key, gx - 0.25, gy);
    const dy = Terrain.height(key, gx, gy + 0.25) - Terrain.height(key, gx, gy - 0.25);
    const slope = Math.hypot(dx, dy) * 2;
    const n = clamp(variation);
    return {
        light: Math.max(-0.46, Math.min(0.4, dx * 1.35 + dy * 0.95)),
        earth: smooth(0.12, 0.7, slope) * (0.2 + n * 0.32),
        stone: smooth(0.46, 0.95, slope) * smooth(0.3, 0.75, n) * 0.4,
        dry: smooth(0.6, 2.8, height) * (0.2 + n * 0.2)
    };
}

export function rockPlacements(geometry) {
    const blocks = geometry.blockers.filter(block => block.kind === 'rock');
    const inside = (x, y) => blocks.some(b => x >= b.x1 && x < b.x2 && y >= b.y1 && y < b.y2);
    const placed = [];
    if (!blocks.length) return placed;
    const x1 = Math.min(...blocks.map(b => b.x1)), x2 = Math.max(...blocks.map(b => b.x2));
    const y1 = Math.min(...blocks.map(b => b.y1)), y2 = Math.max(...blocks.map(b => b.y2));
    // Two staggered rows fill the blocker footprint. Peaks vary along and across
    // the ridge, so overlapping source rectangles cannot duplicate a wall module.
    for (let row = 0, y = y1 + 0.6; y < y2; row++, y += 1.8) {
        for (let col = 0, x = x1 + 0.55 + (row % 2) * 0.9; x < x2; col++, x += 1.9) {
            const n = Terrain._hash2(col + 37, row + 11);
            const px = x + (n - 0.5) * 0.55;
            const py = y + (Terrain._hash2(row + 43, col + 71) - 0.5) * 0.5;
            if (!inside(px, py)) continue;
            const silhouette = Terrain._hash2(col + 17, row + 6);
            placed.push({ x: px, y: py, frame: Math.floor(silhouette * 3), height: 58 + n * 44 + (row % 3 === 1 ? 16 : 0) });
        }
    }
    for (let y = y1 + 0.3; y < y2; y += 1.15) for (let x = x1 + 0.3; x < x2; x += 1.25) {
        const n = Terrain._hash2(Math.round(x * 83), Math.round(y * 79));
        const px = x + (n - 0.5) * 0.65, py = y + (n - 0.5) * 0.4;
        if (!inside(px, py) || n < 0.35) continue;
        placed.push({ x: px, y: py, frame: n > 0.75 ? 3 : n > 0.55 ? 4 : 5, height: 22 + n * 24 });
    }
    return placed;
}
