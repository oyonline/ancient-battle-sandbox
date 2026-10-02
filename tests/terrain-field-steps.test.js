import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildWaterField, buildWaterFieldSteps } from '../js/render/terrain-boundaries.js';
import { buildBankField, buildBankFieldSteps } from '../js/render/terrain-naturalness.js';
import { board, setBoardSize } from '../js/board.js';
import { Terrain } from '../js/terrain.js';

const rect = (x1, y1, x2, y2, kind = 'water') => ({ x1, y1, x2, y2, kind });
const fixtures = {
    overlap: () => ({ blockers: [rect(-2, -1, 4, 5), rect(2, 3, 7, 6)], zones: [rect(-1, 0, 2, 3, 'shallow'), rect(0, 1, 5, 2, 'bridge')] }),
    islands: () => ({ blockers: [rect(0, 0, 0.5, 8), rect(3, 2, 8, 5), rect(6, 7, 7, 9)], zones: [rect(4, 4, 7, 7, 'shallow')] }),
    fractional: () => ({ blockers: [rect(-1.125, 0.375, 2.625, 3.875)], zones: [rect(1.375, 0.125, 3.625, 4.625, 'shallow')] }),
    territory: () => Terrain.geometry('territory')
};

// Captured from the pre-incremental formulas, before changing either builder.
// Hash every typed-array byte, including Float32 rounding and signed zero.
const golden = {
    overlap: {
        water: [[-3, -2, 0.5, 22, 18], '93a2c61c97bf6ff0cc1a20920cc4528e1a114e1ace81380be57d717bb6cecea4', '9576d3a63dd71bba1850f8ac220ee36e438da8cf3f20449e94e035faeba7aa28'],
        bank: [[-4, -3, 0.25, 52, 44], 'fd9ee15e368641d2b6574df8b8fcd48c96ebdaeabbf58808e3a8fb8d44689c10', 'e15455c33c769f8a08dcc5fbb3c7c9c5f485de28761e6630129680402fc4faaa', 'c152f7611afd69291fffb7d7843f77e0cc02eb3d422a78ff40b494304a4a1596', '3c332482f2e98949baa760199985906ce4a3a07c39c37f96931ddb988bc7661c']
    },
    islands: {
        water: [[-1, -1, 0.5, 20, 22], 'adb85cb7432330f005367ef78ee088acea4573a6f34c69aa3484cb7e6ea44494', '9b2bcad58e920732f71628ac78d4a4b06e2ee729e12824fe272956112179865c'],
        bank: [[-2, -2, 0.25, 48, 52], '72a79fa11ad0ee8a36649175798998f20552c1dc33afbb40f2e3ad5b50240d1b', 'b39e6fa38ada62ee7707cd273a2d07c80de4a7a98a4489f919285133e1ee45b2', 'dfb9c75abbd283f4e6103d61431e5d8cfddca5d238530219ce971ff0dfa7028d', '12761467112c7458a12934cfdc4717421def5e672aefd6eeebf908a4dba0016d']
    },
    fractional: {
        water: [[-2.125, -0.875, 0.5, 14, 13], 'aa45994cc222cff708dd1a4bf091f521f81200a45360e2892469d5a45dd9208e', '82255828e764e28f193ec1f8043c79df89e69c4f6a029984e7c8e149a1be7450'],
        bank: [[-3.125, -1.875, 0.25, 35, 34], 'a1714cacc360f8c7e5216297cf0016f8e63cb5e6c3e36d6edf2bf6b4ddfc546e', '608bcd785623929fea6a3c03a5fc392215b089f4602dfd5972130539d42de389', '32c3443219570c0ee3daa2fae7a5a9390d402df231703921af5388190ea18455', '549a8aedd145ac2e0cfe63c5350439d0db3f7ec20de676c171ddfc0a685ba669']
    },
    territory: {
        water: [[123, -13.01, 0.5, 28, 172], '0bb0771a5a16b82b9b4c76f772ead73113673ce0b4d5b012a74b263a009eaf84', '3e6e8c9a847da640e9e07308f8fe7307fe20973b75a3811aa6679cb5bb70615f'],
        bank: [[122, -14.01, 0.25, 64, 351], '5c3dd293c49c3358a81e98b03988cc81f51e01f373654198b044e8b43a4eff5b', '9c17707f30ba5a410685e76a9f4139f26eab3cf91197ea11a25c0f097f42950c', 'bd9e1985f02b8c8206167f6d286772af3bb46b34dfe7358c0a6621e50a16fb9d', '167884b108385119cfc34a451d8fbceddc41f4e9708a52bb70a1721281655a57']
    }
};

function fingerprint(field) {
    const { x1, y1, step, cols, rows } = field;
    const arrays = [field.kinds, field.distance, field.signedDistance, field.shallowWeight].filter(Boolean);
    return [[x1, y1, step, cols, rows], ...arrays.map(values => {
        // Use little-endian serialization so the fixture is host-independent.
        const bytes = new Uint8Array(values.byteLength), view = new DataView(bytes.buffer);
        if (values instanceof Float32Array) values.forEach((value, index) => view.setFloat32(index * 4, value, true));
        else bytes.set(values);
        return createHash('sha256').update(bytes).digest('hex');
    })];
}

const builders = {
    water: { sync: buildWaterField, steps: buildWaterFieldSteps, options: { step: 0.5, padding: 1 }, passes: 4 },
    bank: { sync: buildBankField, steps: buildBankFieldSteps, options: { step: 0.25, padding: 2 }, passes: 9 }
};

for (const [name, geometry] of Object.entries(fixtures)) for (const [kind, builder] of Object.entries(builders)) {
    test(`${kind} row batches preserve original ${name} field bytes and yield every eight rows`, t => {
        const original = { ...board };
        t.after(() => setBoardSize(original.W, original.H, original.MARGIN));
        setBoardSize(260, 180);
        const iterator = builder.steps(geometry(), builder.options);
        let result, yields = 0;
        do {
            result = iterator.next();
            if (!result.done) {
                yields++;
                assert.equal(result.value, undefined, 'a partially computed field must not escape');
            }
        } while (!result.done);
        assert.equal(yields, Math.ceil(result.value.rows / 8) * builder.passes);
        assert.deepEqual(fingerprint(result.value), golden[name][kind]);
        assert.deepEqual(fingerprint(builder.sync(geometry(), builder.options)), golden[name][kind]);
    });
}

test('empty fields finish immediately and cancelled fields cannot resume', () => {
    for (const builder of Object.values(builders)) {
        const empty = builder.steps({}).next();
        assert.equal(empty.done, true);
        assert.equal(empty.value.kinds.length, 0);
        assert.equal(empty.value.distance.length, 0);
        const pending = builder.steps(fixtures.islands(), builder.options);
        assert.equal(pending.next().done, false);
        assert.deepEqual(pending.return(), { value: undefined, done: true });
        assert.deepEqual(pending.next(), { value: undefined, done: true });
    }
});

test('synchronous and incremental builders preserve input validation', () => {
    for (const builder of Object.values(builders)) for (const step of [0, -1, Infinity, NaN]) {
        assert.throws(() => builder.sync({}, { step }), RangeError);
        assert.throws(() => builder.steps({}, { step }).next(), RangeError);
    }
});
