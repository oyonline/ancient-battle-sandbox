import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELD3D_PRESETS, validateField3dConfig, resolveArmies, assertField3dCapacity, configDigest } from '../js/net/field3d-config.js';
import { ArenaClient } from '../js/net/arena-client.js';
import { SIM_VERSION } from '../js/net/lockstep.js';

const config = (preset = 'standard') => ({ preset, formation: 'custom', tactic: 'advance' });

test('R5 实际容量计算：700/160/200/160 边界允许，各兵种超一被拒', () => {
    const cap = { infantry: 700, pikeman: 160, archer: 200, cavalry: 160 };
    const armies = { red: { infantry: 350, pikeman: 80, archer: 100, cavalry: 80 },
        blue: { infantry: 350, pikeman: 80, archer: 100, cavalry: 80 } };
    assert.doesNotThrow(() => assertField3dCapacity(armies));
    for (const [type, capacity] of Object.entries(cap)) {
        armies.blue[type]++;
        assert.equal(armies.red[type] + armies.blue[type], capacity + 1);
        assert.throws(() => assertField3dCapacity(armies),
            { message: `${type} 超过两队共用容量。` });
        armies.blue[type]--;
    }
});

test('field3d 受限预设：标准与 CLASSIC 一致；所有红蓝组合都在共享容量内', () => {
    assert.deepEqual(FIELD3D_PRESETS.standard, { infantry: 300, pikeman: 60, archer: 80, cavalry: 60 });
    assert.deepEqual(Object.values(FIELD3D_PRESETS).map(army => Object.values(army).reduce((a, b) => a + b)), [250, 500, 600]);
    const cap = { infantry: 700, pikeman: 160, archer: 200, cavalry: 160 };
    for (const red of Object.keys(FIELD3D_PRESETS)) for (const blue of Object.keys(FIELD3D_PRESETS)) {
        const armies = resolveArmies({ red: config(red), blue: config(blue) });
        for (const type of Object.keys(cap)) {
            assert.ok(Number.isSafeInteger(armies.red[type]) && armies.red[type] >= 0);
            assert.ok(armies.red[type] + armies.blue[type] <= cap[type]);
        }
    }
    const armies = resolveArmies({ red: config('large'), blue: config('large') });
    assert.equal(armies.red.infantry + armies.blue.infantry, cap.infantry, '容量上界允许');
    armies.red.infantry = 999;
    assert.equal(FIELD3D_PRESETS.large.infantry, 350, '返回副本');
    assert.throws(() => { FIELD3D_PRESETS.large.infantry = 999; }, TypeError);
});

test('field3d 白名单拒绝类型、未知枚举/字段/兵种以及任意配兵（含超容量/小数/负数）', () => {
    const invalid = [null, [], 'standard', {}, { ...config(), preset: 500 },
        { ...config(), preset: 'toString' }, { ...config(), preset: 'unknown' },
        { ...config(), formation: 'invented' }, { ...config(), tactic: 'invented' },
        { ...config(), formation: 1 }, { ...config(), tactic: null },
        { ...config(), extra: true }, { ...config(), axe: 1 },
        { ...config(), cavalry: 161 }, { ...config(), infantry: 0.5 }, { ...config(), archer: -1 },
        { ...config(), army: { infantry: 701 } }, { ...config(), preset: { infantry: 1.5 } }];
    for (const cfg of invalid) {
        assert.equal(validateField3dConfig(cfg).ok, false, JSON.stringify(cfg));
        assert.throws(() => resolveArmies({ red: cfg, blue: config() }));
    }
    assert.throws(() => resolveArmies({ red: config(), blue: null }));
    assert.throws(() => resolveArmies({ red: config(), blue: config(), black: config() }));
    for (const formation of ['custom', 'square', 'wedge', 'mixed', 'line']) {
        for (const tactic of ['advance', 'assault', 'flank', 'hold', 'hold_ground']) {
            assert.equal(validateField3dConfig({ ...config(), formation, tactic }).ok, true);
        }
    }
});

test('field3d 摘要与键顺序无关，覆盖修订号、座位及全部配置字段', () => {
    const configs = { red: config(), blue: config('small') };
    const digest = configDigest(configs, 3);
    assert.equal(digest, configDigest({ blue: configs.blue, red: { tactic: 'advance', formation: 'custom', preset: 'standard' } }, 3));
    assert.notEqual(digest, configDigest(configs, 4));
    assert.notEqual(digest, configDigest({ red: configs.blue, blue: configs.red }, 3));
    for (const patch of [{ preset: 'large' }, { formation: 'line' }, { tactic: 'hold' }]) {
        assert.notEqual(digest, configDigest({ ...configs, red: { ...configs.red, ...patch } }, 3));
    }
    assert.throws(() => configDigest(configs, -1));
    assert.throws(() => configDigest(configs, 1.5));
});

test('ArenaClient 新协议封装，旧 join/ready 包逐字段保留', () => {
    const sent = [], client = new ArenaClient();
    client.ws = { readyState: 1, send: raw => sent.push(JSON.parse(raw)) };
    client.createRoom('field3d');
    client.joinRoom('ABCD');
    client.joinRoom('ABCD', 'field3d');
    client.sendReady();
    client.sendReady(3);
    client.sendConfig(config());
    assert.deepEqual(sent, [
        { t: 'create', v: SIM_VERSION, mode: 'field3d' },
        { t: 'join', code: 'ABCD', v: SIM_VERSION },
        { t: 'join', code: 'ABCD', v: SIM_VERSION, mode: 'field3d' },
        { t: 'ready' }, { t: 'ready', rev: 3 }, { t: 'config', config: config() }
    ]);
});
