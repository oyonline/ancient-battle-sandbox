import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeScene, addUnit } from './battle-harness.js';
import { NetBattle, battleProjection, hashProjection, LOCKSTEP } from '../js/net/lockstep.js';

function fieldScene(side = 'red') {
    const scene = makeScene();
    scene.deployUnits({ infantry: 2, archer: 1 }, { infantry: 2, cavalry: 1 }, 'custom', 'custom', {},
        { terrain: 'flat', net: true, mySide: side });
    return scene;
}

test('非领土投影不要求 flags/territory；覆盖模拟字段，排除箭矢表现字段', () => {
    const scene = fieldScene();
    assert.equal(scene.flags, null);
    assert.equal(scene.territory, null);
    const baseline = battleProjection(scene);
    assert.ok(!baseline.includes(',e,') && !baseline.includes(',f,'));
    for (const [object, key, value] of [
        [scene.units[0], 'hp', 1], [scene.units[0], 'gx', 1], [scene.units[0], 'gy', 1],
        [scene.units[0], 'morale', 1], [scene.units[0], 'moraleState', 'routing'],
        [scene.units[0], 'id', 99], [scene.units[0], 'type', 'pikeman'], [scene.units[0], 'team', 'blue'],
        [scene, 'simulationTime', 100], [scene, 'battleOver', true], [scene, 'endReason', 'elimination'],
        [scene, 'redAlive', 0], [scene.aliveByTeam, 'red', 0], [scene.battleStats.red, 'lost', 3]
    ]) {
        const old = object[key]; object[key] = value;
        assert.notEqual(battleProjection(scene), baseline, key);
        object[key] = old;
    }
    const arrow = { source: scene.units[2], team: 'red', sx: 1, sy: 2, tx: 3, ty: 4,
        t: 0.1, dur: 0.5, dmg: 10, firedAt: 100, sourceHeight: 0, targetHeight: 0 };
    scene.arrows.push(arrow);
    const withArrow = battleProjection(scene);
    assert.notEqual(withArrow, baseline);
    for (const key of ['sx', 'sy', 'tx', 'ty', 't', 'dur', 'dmg', 'firedAt', 'sourceHeight']) {
        arrow[key] += 0.1;
        assert.notEqual(battleProjection(scene), withArrow, key);
        arrow[key] -= 0.1;
    }
    Object.assign(arrow, { sourceOffsetX: 99, sourceOffsetY: 10, sourceLift: 99, targetLift: 99, targetHeight: 99 });
    assert.equal(battleProjection(scene), withArrow);
    delete scene.flags; delete scene.territory; delete scene.arrows;
    assert.doesNotThrow(() => battleProjection(scene));
});

test('R4 非模拟字段 scene.winner 不改变非领土投影', () => {
    const scene = fieldScene(), baseline = battleProjection(scene);
    scene.winner = 'blue';
    assert.equal(battleProjection(scene), baseline);
});

test('R2 turn=120 红→蓝双发：不同哈希双方均报 desync，相同均不报（所有玩法）', () => {
    for (const mode of ['field3d', 'territory', 'coop']) for (const mismatch of [true, false]) {
        const sent = [], errors = { red: [], blue: [] };
        const nets = ['red', 'blue'].map(side => {
            const scene = mode === 'field3d' ? fieldScene(side) : makeScene();
            if (mode !== 'field3d') scene.deployUnits({ infantry: 2 }, { infantry: 2 }, 'custom', 'custom', {},
                { territory: true, terrain: 'flat', territoryAI: false, net: true, mySide: side,
                    ...(mode === 'coop' ? { coop: true, black: { infantry: 1 } } : {}) });
            if (side === 'blue' && mismatch) scene.units[0].hp -= 1;
            const net = new NetBattle(scene, { send: p => sent.push(p) },
                { onDesync: (...args) => errors[side].push(args) });
            net.lockstep.execTurn = 121;
            net.onTurnDone();
            return net;
        });
        const hashes = sent.filter(p => p.t === 'hash');
        assert.equal(hashes.length, 2);
        // 按服务器红→蓝顺序给双方回放，包含各自回环。
        for (const packet of hashes) for (const net of nets) net.handle(packet);
        for (const side of ['red', 'blue']) {
            assert.equal(errors[side].length, mismatch ? 1 : 0, `${mode} ${side} mismatch=${mismatch}`);
            if (mismatch) assert.equal(errors[side][0][0], 120);
        }
        assert.deepEqual(hashes.map(p => p.side), ['red', 'blue']);
        for (const net of nets) assert.equal(net.myHashes.size, 0);
    }
});

test('R6 configDigest 仅字符串启用，null/undefined/其他类型不发不比', () => {
    for (const digest of [null, undefined, 0, false, {}, '', 'same']) {
        const sent = [], errors = [];
        const net = new NetBattle(fieldScene(), { send: p => sent.push(p) },
            { configDigest: digest, onDesync: (...args) => errors.push(args) });
        net.handle({ t: 'cfg-hash', side: 'blue', hash: 'different' });
        net.start();
        assert.equal(sent.filter(p => p.t === 'cfg-hash').length, typeof digest === 'string' ? 1 : 0);
        assert.equal(errors.length, typeof digest === 'string' ? 1 : 0);
        if (typeof digest !== 'string') assert.equal(net.peerConfigDigest, null);
    }
});

// 在改动前 HEAD 1b7b619 上从同一 fixture 采集；长度 + SHA256 锁住整个字符串。
test('territory / 营队池 / coop 营寨投影与旧版逐字一致', () => {
    const golden = {
        territory: [2122, '1e3975c7bd7f052387602a3908d76b70da9422e59634c2bfb8bd220430a0ed5b'],
        battalion: [2247, '168c886e04486429ece0829e16e4bfad5636009e8d497c89fd6f43ea3b492bbb'],
        coop: [2806, '4d9368cb2475cb1bc1f5546576ba3483d6ab994e31c1ba1e3829af2c3f4552a5']
    };
    for (const kind of Object.keys(golden)) {
        const s = makeScene();
        s.deployUnits({ infantry: 2, pikeman: 1, archer: 1, cavalry: 1 },
            { infantry: 1, pikeman: 2, archer: 1, cavalry: 1 }, 'custom', 'custom', {},
            { territory: true, terrain: 'flat', territoryAI: false, net: true, mySide: 'red',
                ...(kind === 'coop' ? { coop: true, black: { infantry: 1, archer: 1 } } : {}) });
        s.simulationTime = 1234.5;
        if (kind === 'battalion') {
            const u = addUnit(s, 'red', 'cavalry', 10, 90);
            s.battalions.assignReinforcement(u);
        }
        const projection = battleProjection(s);
        assert.deepEqual([projection.length, createHash('sha256').update(projection).digest('hex')], golden[kind], kind);
    }
});

test('start 前 turn/hash 都保留，start 幂等且不会清空收包缓存', () => {
    for (const mismatch of [false, true]) {
        const scene = fieldScene(), sent = [], errors = [];
        const net = new NetBattle(scene, { send: p => sent.push(p) }, { onDesync: (...args) => errors.push(args) });
        net.handle({ t: 'turn', exec: 0, side: 'blue', cmds: [{ k: 'early' }] });
        const hash = mismatch ? 'bad' : hashProjection(battleProjection(scene));
        net.handle({ t: 'hash', turn: 120, hash });
        net.start(); net.start();
        assert.equal(sent.length, LOCKSTEP.LOOKAHEAD);
        assert.deepEqual(net.lockstep.inbox.get(0).blue, [{ k: 'early' }]);
        assert.equal(net.peerHashes.get(120), hash);
        net.lockstep.execTurn = 121;
        net.onTurnDone();
        assert.equal(errors.length, mismatch ? 1 : 0);
        assert.equal(net.peerHashes.has(120), false);
    }
});

test('cfg-hash 独立交换：早到缓存、自身回环忽略、相等通过、分歧只报一次', () => {
    for (const theirs of ['same', 'different']) {
        const sent = [], errors = [];
        const net = new NetBattle(fieldScene(), { send: p => sent.push(p) },
            { configDigest: 'same', onDesync: (...args) => errors.push(args) });
        net.handle({ t: 'cfg-hash', side: 'red', hash: 'self-echo' });
        assert.equal(errors.length, 0);
        net.handle({ t: 'cfg-hash', side: 'blue', hash: theirs });
        net.start(); net.start();
        assert.deepEqual(sent[0], { t: 'cfg-hash', side: 'red', hash: 'same' });
        assert.equal(sent.filter(p => p.t === 'cfg-hash').length, 1);
        assert.equal(errors.length, theirs === 'same' ? 0 : 1);
        if (errors.length) assert.equal(errors[0][0], -1);
    }
});

test('终局核对：turn/winner/hash 各自分歧均上报；提前结果保留、自回环忽略、相同通过', () => {
    for (const patch of [{}, { turn: 601 }, { winner: 'blue' }, { hash: 'different' }]) {
        const scene = fieldScene(), sent = [], errors = [];
        scene.battleOver = true;
        const net = new NetBattle(scene, { send: p => sent.push(p) }, { onDesync: (...args) => errors.push(args) });
        const result = { t: 'result', turn: 600, winner: 'red', hash: hashProjection(battleProjection(scene)) };
        net.handle({ ...result, side: 'red', hash: 'own-echo' });
        net.handle({ ...result, side: 'blue', ...patch });
        assert.equal(errors.length, 0, '等本端报告后再核对');
        net.reportResult({ turn: 600, winner: 'red' });
        net.reportResult({ turn: 600, winner: 'red' });
        assert.deepEqual(sent, [{ ...result, side: 'red' }]);
        assert.equal(errors.length, Object.keys(patch).length ? 1 : 0);
        net.handle({ ...result, side: 'blue', ...patch });
        assert.equal(errors.length, Object.keys(patch).length ? 1 : 0, '最多报告一次');
    }
});
