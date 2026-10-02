// Render-only water union. Bridges and shallows belong to the same channel, so
// adjacent terrain rectangles never create an artificial bank inside the river.
const CHANNEL_KIND = { water: 1, shallow: 2, bridge: 3 };
const ROWS_PER_STEP = 8;

export function buildWaterField(geometry, options) {
    const steps = buildWaterFieldSteps(geometry, options);
    let result;
    do { result = steps.next(); } while (!result.done);
    return result.value;
}

// Yield between row batches without changing the scan order or Float32 writes.
// The completed field is returned only after all distance passes finish.
export function* buildWaterFieldSteps(geometry, { step = 0.5, padding = step } = {}) {
    if (!Number.isFinite(step) || step <= 0) throw new RangeError('Water field step must be finite and positive');
    if (!Number.isFinite(padding) || padding < step) throw new RangeError('Water field padding must cover at least one sample');
    const channel = [
        ...(geometry.blockers || []).filter(rect => rect.kind === 'water'),
        ...(geometry.zones || []).filter(rect => rect.kind === 'shallow' || rect.kind === 'bridge')
    ];
    if (channel.length === 0) {
        return { x1: 0, y1: 0, step, cols: 0, rows: 0, kinds: new Uint8Array(0), distance: new Float32Array(0) };
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const rect of channel) {
        if (![rect.x1, rect.y1, rect.x2, rect.y2].every(Number.isFinite) || rect.x1 >= rect.x2 || rect.y1 >= rect.y2) {
            throw new RangeError('Water channel rectangles must have finite coordinates and positive area');
        }
        minX = Math.min(minX, rect.x1); minY = Math.min(minY, rect.y1);
        maxX = Math.max(maxX, rect.x2); maxY = Math.max(maxY, rect.y2);
    }
    const pad = Math.ceil(padding / step);
    const x1 = minX - pad * step, y1 = minY - pad * step;
    const cols = Math.ceil((maxX - minX) / step) + pad * 2;
    const rows = Math.ceil((maxY - minY) / step) + pad * 2;
    const kinds = new Uint8Array(cols * rows);
    const distance = new Float32Array(cols * rows);
    for (let row = 0; row < rows; row++) {
        const gy = y1 + (row + 0.5) * step;
        for (let col = 0; col < cols; col++) {
            const gx = x1 + (col + 0.5) * step, index = row * cols + col;
            for (const rect of channel) {
                if (gx >= rect.x1 && gx < rect.x2 && gy >= rect.y1 && gy < rect.y2) {
                    kinds[index] = Math.max(kinds[index], CHANNEL_KIND[rect.kind]);
                }
            }
            distance[index] = kinds[index] ? Infinity : 0;
        }
        if ((row + 1) % ROWS_PER_STEP === 0 || row + 1 === rows) yield;
    }

    // Two-pass eight-neighbour chamfer distance to land cell centres. Padding
    // supplies land around every component, including a one-cell-wide stream.
    const diagonal = step * Math.SQRT2;
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const index = row * cols + col;
            if (!kinds[index]) continue;
            let d = distance[index];
            if (col > 0) d = Math.min(d, distance[index - 1] + step);
            if (row > 0) {
                d = Math.min(d, distance[index - cols] + step);
                if (col > 0) d = Math.min(d, distance[index - cols - 1] + diagonal);
                if (col + 1 < cols) d = Math.min(d, distance[index - cols + 1] + diagonal);
            }
            distance[index] = d;
        }
        if ((row + 1) % ROWS_PER_STEP === 0 || row + 1 === rows) yield;
    }
    for (let row = rows - 1; row >= 0; row--) {
        for (let col = cols - 1; col >= 0; col--) {
            const index = row * cols + col;
            if (!kinds[index]) continue;
            let d = distance[index];
            if (col + 1 < cols) d = Math.min(d, distance[index + 1] + step);
            if (row + 1 < rows) {
                d = Math.min(d, distance[index + cols] + step);
                if (col > 0) d = Math.min(d, distance[index + cols - 1] + diagonal);
                if (col + 1 < cols) d = Math.min(d, distance[index + cols + 1] + diagonal);
            }
            distance[index] = d;
        }
        if ((rows - row) % ROWS_PER_STEP === 0 || row === 0) yield;
    }
    // The shore lies between water and land centres, half a sample step closer.
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const index = row * cols + col;
            if (kinds[index]) distance[index] = Math.max(step / 2, distance[index] - step / 2);
        }
        if ((row + 1) % ROWS_PER_STEP === 0 || row + 1 === rows) yield;
    }
    return { x1, y1, step, cols, rows, kinds, distance };
}

// Nearest cell lookup for material selection; coordinates outside the field are
// land. Distance is an approximation in board cells, independent of projection.
export function sampleWaterField(field, gx, gy) {
    const col = Math.floor((gx - field.x1) / field.step);
    const row = Math.floor((gy - field.y1) / field.step);
    if (!Number.isFinite(col) || !Number.isFinite(row) || col < 0 || col >= field.cols || row < 0 || row >= field.rows) {
        return { kind: 0, distance: 0 };
    }
    const index = row * field.cols + col;
    return { kind: field.kinds[index], distance: field.distance[index] };
}
