// 局域网对战服务器：建房/入房分边/就绪开局/命令保序双发/掉线通知/版本准入
import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { createArenaServer } from '../server/arena.mjs';
import { SIM_VERSION } from '../js/net/lockstep.js';

// 直接驱动同一 connection/message/close 处理器，补充真实 ws 测试；不申请监听端口。
// 沙箱禁止 listen 时，这些协议状态断言仍可执行，真实传输覆盖仍由上面的 ws 工具提供。
function protocolHarness(t) {
    const { wss } = createArenaServer();
    t.after(() => wss.close(() => {}));
    return () => {
        const ws = new EventEmitter();
        ws.readyState = 1;
        const received = [];
        ws.send = raw => received.push(JSON.parse(raw));
        wss.emit('connection', ws);
        return {
            ws,
            received,
            send(message) { ws.emit('message', JSON.stringify(message)); },
            close() { ws.readyState = 3; ws.emit('close'); },
            last(type) { return received.filter(m => m.t === type).at(-1); },
            count(type) { return received.filter(m => m.t === type).length; }
        };
    };
}

const fieldConfig = (preset = 'standard') => ({ preset, formation: 'custom', tactic: 'advance' });

test('R1 同 rev 不同配置：换建 field3d 房后旧房不得向双方发送 start', t => {
    const connect = protocolHarness(t), a = connect(), b = connect(), c = connect();
    a.send({ t: 'create', mode: 'field3d', v: SIM_VERSION });
    const oldCode = a.last('room').code;
    b.send({ t: 'join', code: oldCode, mode: 'field3d', v: SIM_VERSION });
    a.send({ t: 'config', config: fieldConfig('small') });
    b.send({ t: 'config', config: fieldConfig('small') });
    a.send({ t: 'ready', rev: 3 });
    a.send({ t: 'create', mode: 'field3d', v: SIM_VERSION });
    c.send({ t: 'join', code: a.last('room').code, mode: 'field3d', v: SIM_VERSION });
    a.send({ t: 'config', config: fieldConfig('large') });
    c.send({ t: 'config', config: fieldConfig('large') });
    assert.equal(a.last('config').rev, 3);
    assert.equal(a.last('config').configs.red.preset, 'large');
    b.send({ t: 'ready', rev: 3 });
    assert.equal(a.count('start'), 0, '已换房的 A 不得收到旧房 start');
    assert.equal(b.count('start'), 0, '缺 A 的旧房不得开局');
    assert.equal(b.last('config').rev, 4);
    assert.equal(b.count('peer-left'), 1);
});

test('R1 field3d 加入 territory 后不得接收旧房 start，close 不影响新补座', t => {
    const connect = protocolHarness(t), a = connect(), b = connect(), c = connect(), fresh = connect();
    a.send({ t: 'create', mode: 'field3d', v: SIM_VERSION });
    const code = a.last('room').code;
    b.send({ t: 'join', code, mode: 'field3d', v: SIM_VERSION });
    a.send({ t: 'config', config: fieldConfig() });
    b.send({ t: 'config', config: fieldConfig() });
    a.send({ t: 'ready', rev: 3 });
    c.send({ t: 'create', mode: 'territory', v: SIM_VERSION });
    a.send({ t: 'join', code: c.last('room').code, v: SIM_VERSION });
    assert.equal(a.last('room').mode, 'territory');
    b.send({ t: 'ready', rev: 3 });
    assert.equal(a.count('start'), 0);
    assert.equal(b.count('start'), 0);
    fresh.send({ t: 'join', code, mode: 'field3d', v: SIM_VERSION });
    assert.equal(fresh.last('room').side, 'red');
    a.close();
    assert.equal(b.last('config').rev, 5);
    fresh.send({ t: 'ready', rev: 5 });
    b.send({ t: 'ready', rev: 5 });
    assert.equal(fresh.count('start'), 1);
});

test('R1 同连接重复 join 自己房间不占两座；2D 换房释放旧座与清空房', t => {
    const connect = protocolHarness(t);
    for (const mode of ['field3d', 'territory', 'coop']) {
        const host = connect(), guest = connect(), fresh = connect();
        host.send({ t: 'create', mode, v: SIM_VERSION });
        const code = host.last('room').code;
        guest.send({ t: 'join', code, mode, v: SIM_VERSION });
        guest.send({ t: 'join', code, mode, v: SIM_VERSION });
        assert.equal(guest.ws.__side, 1);
        assert.equal(host.count('peer-left'), 1, '重复 join 先离场');
        guest.send({ t: 'create', mode: 'territory', v: SIM_VERSION });
        fresh.send({ t: 'join', code, mode, v: SIM_VERSION });
        assert.equal(fresh.last('room').side, 'blue', '原座位可补入');
        const solo = connect(), probe = connect();
        solo.send({ t: 'create', mode, v: SIM_VERSION });
        const emptyCode = solo.last('room').code;
        solo.send({ t: 'join', code: 'INVALID', mode, v: SIM_VERSION });
        assert.equal(solo.ws.__room, undefined, '失败的新请求也先离开旧房');
        probe.send({ t: 'join', code: emptyCode, mode, v: SIM_VERSION });
        assert.equal(probe.count('room'), 0, '空旧房已 cleanup');
    }
    const solo = connect(), peer = connect();
    solo.send({ t: 'create', mode: 'field3d', v: SIM_VERSION });
    const code = solo.last('room').code;
    solo.send({ t: 'join', code, mode: 'field3d', v: SIM_VERSION });
    assert.equal(solo.ws.__room, undefined, '独占房先清空再重入，不能复制自身到蓝座');
    peer.send({ t: 'join', code, mode: 'field3d', v: SIM_VERSION });
    assert.equal(peer.count('room'), 0);
});

test('R1 开局逐座核验 room/side 归属', t => {
    const connect = protocolHarness(t);
    for (const mode of ['field3d', 'territory', 'coop']) for (const key of ['__room', '__side']) {
        const host = connect(), guest = connect();
        host.send({ t: 'create', mode, v: SIM_VERSION });
        const code = host.last('room').code;
        guest.send({ t: 'join', code, mode, v: SIM_VERSION });
        if (mode === 'field3d') {
            host.send({ t: 'config', config: fieldConfig() });
            guest.send({ t: 'config', config: fieldConfig() });
        }
        host.send({ t: 'ready', rev: 3 });
        host.ws[key] = key === '__room' ? 'OTHER' : 1;
        guest.send({ t: 'ready', rev: 3 });
        assert.equal(guest.count('start'), 0, `${mode} ${key} 不符视为缺座`);
    }
});

test('R7 JSON null 与非对象消息忽略，连接仍可正常建房', t => {
    const client = protocolHarness(t)();
    for (const message of [null, 1, 'text', false]) assert.doesNotThrow(() => client.send(message));
    client.send({ t: 'create', v: SIM_VERSION });
    assert.equal(client.last('room').side, 'red');
});

test('模式隔离：field3d 双向混入/旧无 mode 拒绝且不分座；未知 create 回落 territory', t => {
    const connect = protocolHarness(t);
    for (const [mode, expected] of [['field3d', 'territory'], ['territory', 'field3d'], ['coop', 'field3d']]) {
        const host = connect(), bad = connect(), guest = connect();
        host.send({ t: 'create', mode, v: SIM_VERSION });
        const { code } = host.last('room');
        bad.send({ t: 'join', code, mode: expected, v: SIM_VERSION });
        assert.equal(bad.count('room'), 0);
        assert.equal(bad.count('error'), 1);
        assert.equal(host.count('peer'), 0, '拒入不分座');
        if (mode === 'field3d') {
            bad.send({ t: 'join', code, v: SIM_VERSION });
            assert.equal(bad.count('error'), 2, '无 mode 也拒入 field3d');
            assert.equal(bad.count('room'), 0);
        }
        guest.send({ t: 'join', code, mode, v: SIM_VERSION });
        assert.deepEqual(guest.last('room'), { t: 'room', code, mode, side: 'blue' });
        assert.equal(host.count('peer'), 1, '拒入后座位仍可用');
    }
    const host = connect();
    host.send({ t: 'create', mode: 'unknown', v: SIM_VERSION });
    assert.equal(host.last('room').mode, 'territory');
});

test('旧 territory/coop 完整流程消息逐字段保留：无 mode 入房、无 rev ready/start、turn/hash 双发', t => {
    const connect = protocolHarness(t);
    for (const mode of ['territory', 'coop']) {
        const host = connect(), guest = connect();
        host.send({ t: 'create', mode, v: SIM_VERSION });
        const { code } = host.last('room');
        guest.send({ t: 'join', code, v: SIM_VERSION });
        assert.deepEqual(host.last('room'), { t: 'room', code, side: 'red', mode });
        assert.deepEqual(guest.last('room'), { t: 'room', code, side: 'blue', mode });
        assert.deepEqual(host.last('peer'), { t: 'peer', side: 'blue' });
        host.send({ t: 'ready' });
        assert.equal(host.count('start'), 0);
        assert.deepEqual(guest.last('peer-ready'), { t: 'peer-ready', side: 'red' });
        guest.send({ t: 'ready' });
        for (const player of [host, guest]) {
            assert.deepEqual(player.last('start'), { t: 'start' });
            assert.equal(player.count('config'), 0);
        }
        const packets = [{ t: 'turn', exec: 0, side: 'red', cmds: [] }, { t: 'hash', turn: 120, hash: 'abc' }];
        for (const packet of packets) host.send(packet);
        for (const player of [host, guest]) {
            assert.deepEqual(player.received.filter(m => ['turn', 'hash'].includes(m.t)), packets);
        }
        guest.close();
        assert.deepEqual(host.last('peer-left'), { t: 'peer-left' });
    }
});

test('field3d 配置修订：无效提交不改状态、缺配置与旧 rev 拒绝、改配置清双方 ready', t => {
    const connect = protocolHarness(t), host = connect(), guest = connect();
    host.send({ t: 'create', mode: 'field3d', v: SIM_VERSION });
    const { code } = host.last('room');
    guest.send({ t: 'join', code, mode: 'field3d', v: SIM_VERSION });
    assert.deepEqual(host.last('config'), { t: 'config', rev: 1, configs: { red: null, blue: null } });
    host.send({ t: 'ready', rev: 1 });
    assert.equal(host.count('error'), 1);
    assert.equal(guest.count('peer-ready'), 0);
    host.send({ t: 'config', config: fieldConfig() });
    assert.deepEqual(guest.last('config'), { t: 'config', rev: 2, configs: { red: fieldConfig(), blue: null } });
    const snapshot = host.last('config'), count = guest.count('config');
    host.send({ t: 'config', config: { ...fieldConfig(), axe: 10 } });
    assert.equal(host.count('error'), 2);
    assert.deepEqual(host.last('config'), snapshot);
    assert.equal(guest.count('config'), count);
    assert.equal(guest.count('error'), 0, '失败仅通知提交方');
    guest.send({ t: 'config', config: fieldConfig('small') });
    assert.deepEqual(host.last('config'), { t: 'config', rev: 3,
        configs: { red: fieldConfig(), blue: fieldConfig('small') } });
    host.send({ t: 'ready', rev: 2 });
    guest.send({ t: 'ready' });
    assert.equal(host.count('error'), 3);
    assert.equal(guest.count('error'), 1);
    host.send({ t: 'ready', rev: 3 });
    guest.send({ t: 'config', config: fieldConfig('large') });
    assert.equal(host.last('config').rev, 4);
    guest.send({ t: 'ready', rev: 4 });
    assert.equal(host.count('start'), 0, '改配置使先前红 ready 失效');
    host.send({ t: 'ready', rev: 3 });
    assert.equal(host.count('start'), 0, '旧 rev 不开局');
    host.send({ t: 'ready', rev: 4 });
    for (const player of [host, guest]) assert.deepEqual(player.last('start'), { t: 'start', rev: 4 });
    host.send({ t: 'config', config: fieldConfig('small') });
    assert.equal(host.last('config').rev, 4, '开局配置冻结');
});

test('field3d 离开/重进：配置按座位保留，rev 递增，双方 ready 均需重发（含 bye 与房主离开）', t => {
    for (const leaveSide of ['red', 'blue']) for (const viaBye of [false, true]) {
        const connect = protocolHarness(t), host = connect(), guest = connect();
        host.send({ t: 'create', mode: 'field3d', v: SIM_VERSION });
        const { code } = host.last('room');
        guest.send({ t: 'join', code, mode: 'field3d', v: SIM_VERSION });
        host.send({ t: 'config', config: fieldConfig() });
        guest.send({ t: 'config', config: fieldConfig('small') });
        const leaving = leaveSide === 'red' ? host : guest;
        const remaining = leaveSide === 'red' ? guest : host;
        remaining.send({ t: 'ready', rev: 3 });
        if (viaBye) leaving.send({ t: 'bye' }); else leaving.close();
        assert.equal(remaining.last('config').rev, 4);
        assert.deepEqual(remaining.last('config').configs, { red: fieldConfig(), blue: fieldConfig('small') });
        remaining.send({ t: 'ready', rev: 4 });
        assert.equal(remaining.count('start'), 0, '缺座不开局');
        const fresh = connect();
        fresh.send({ t: 'join', code, mode: 'field3d', v: SIM_VERSION });
        assert.equal(fresh.last('room').side, leaveSide);
        assert.equal(fresh.last('config').rev, 5);
        fresh.send({ t: 'ready', rev: 5 });
        assert.equal(fresh.count('start'), 0, '离开前 ready 不可复用');
        remaining.send({ t: 'ready', rev: 5 });
        assert.deepEqual(fresh.last('start'), { t: 'start', rev: 5 });
        if (viaBye) {
            leaving.close();
            assert.equal(remaining.last('config').rev, 5, 'bye 后 close 不重复增修订');
        }
    }
});

test('field3d cfg-hash/result 与 turn/hash 同通道保序双发；版本闸门仍拒绝旧端', t => {
    const connect = protocolHarness(t), host = connect(), guest = connect();
    host.send({ t: 'create', mode: 'field3d', v: SIM_VERSION });
    guest.send({ t: 'join', code: host.last('room').code, mode: 'field3d', v: 'old' });
    host.send({ t: 'config', config: fieldConfig() });
    guest.send({ t: 'config', config: fieldConfig() });
    host.send({ t: 'ready', rev: 3 });
    guest.send({ t: 'ready', rev: 3 });
    assert.equal(host.count('start'), 0);
    assert.match(host.last('error').text, /版本/);
    assert.match(guest.last('error').text, /版本/);
    const packets = [
        { t: 'cfg-hash', side: 'red', hash: 'cfg' },
        { t: 'turn', side: 'blue', exec: 0, cmds: [] },
        { t: 'hash', turn: 120, hash: 'periodic' },
        { t: 'result', side: 'red', turn: 601, winner: 'blue', hash: 'final' }
    ];
    packets.forEach((packet, index) => (index % 2 ? guest : host).send(packet));
    for (const player of [host, guest]) {
        assert.deepEqual(player.received.filter(m => packets.some(p => p.t === m.t)), packets);
    }
});

async function openClient(port) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(ws, 'open');
    const received = [];
    ws.on('message', data => received.push(JSON.parse(data.toString())));
    const wait = async (predicate, timeout = 1500) => {
        const start = Date.now();
        while (!received.some(predicate)) {
            if (Date.now() - start > timeout) throw new Error('等待服务器消息超时: ' + received.map(m => m.t).join(','));
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        return received.find(predicate);
    };
    return { ws, received, wait };
}

test('房间服务器：创建/加入分边/命令与哈希保序双发/双方就绪开局/掉线通知', async () => {
    const { server } = createArenaServer();
    server.listen(0);
    await once(server, 'listening');
    const port = server.address().port;
    try {
        const host = await openClient(port);
        const guest = await openClient(port);

        host.ws.send(JSON.stringify({ t: 'create', v: SIM_VERSION }));
        const room = await host.wait(m => m.t === 'room');
        assert.equal(room.side, 'red', '房主为红方');
        assert.match(room.code, /^[A-Z2-9]{4}$/, '四位房间码');

        guest.ws.send(JSON.stringify({ t: 'join', code: room.code, v: SIM_VERSION }));
        const joined = await guest.wait(m => m.t === 'room');
        assert.equal(joined.side, 'blue', '加入者为蓝方');
        await host.wait(m => m.t === 'peer');

        // 错误房间码被拒
        const stranger = await openClient(port);
        stranger.ws.send(JSON.stringify({ t: 'join', code: 'ZZZZ' }));
        await stranger.wait(m => m.t === 'error');

        // 战斗消息：双发（含发送方）保序
        host.ws.send(JSON.stringify({ t: 'turn', exec: 5, side: 'red', cmds: [{ k: 'buy' }] }));
        await host.wait(m => m.t === 'turn');
        await guest.wait(m => m.t === 'turn');
        guest.ws.send(JSON.stringify({ t: 'hash', turn: 120, hash: 'abc' }));
        await host.wait(m => m.t === 'hash');
        await guest.wait(m => m.t === 'hash');

        // 双方就绪 → 双端收 start（顺序：先就绪方收到 peer-ready）
        host.ws.send(JSON.stringify({ t: 'ready' }));
        await guest.wait(m => m.t === 'peer-ready');
        guest.ws.send(JSON.stringify({ t: 'ready' }));
        await host.wait(m => m.t === 'start');
        await guest.wait(m => m.t === 'start');

        // 掉线通知
        guest.ws.close();
        await host.wait(m => m.t === 'peer-left');

        host.ws.close();
        stranger.ws.close();
    } finally {
        server.close();
    }
});

// 版本准入（评审 P1-5）：混版本（旧标签页缺版本号）双就绪不得开战，
// 双方收到明确错误提示；同版本才发 start。
test('版本准入：混版本拒绝开战，同版本正常开局', async () => {
    const { server } = createArenaServer();
    server.listen(0);
    await once(server, 'listening');
    const port = server.address().port;
    try {
        // 混版本：房主带版本，旧端加入不带版本
        const host = await openClient(port);
        const stale = await openClient(port);
        host.ws.send(JSON.stringify({ t: 'create', v: SIM_VERSION }));
        const room = await host.wait(m => m.t === 'room');
        stale.ws.send(JSON.stringify({ t: 'join', code: room.code }));   // 旧客户端：无 v 字段
        await stale.wait(m => m.t === 'room');
        host.ws.send(JSON.stringify({ t: 'ready' }));
        stale.ws.send(JSON.stringify({ t: 'ready' }));
        await host.wait(m => m.t === 'error');
        await stale.wait(m => m.t === 'error');
        assert.ok(!host.received.some(m => m.t === 'start'), '混版本不开战（房主）');
        assert.ok(!stale.received.some(m => m.t === 'start'), '混版本不开战（旧端）');

        // 显式旧版本号同样被拒：本轮投影/模拟口径变化（workerEngageAt 入哈希）后，
        // 上一批版本 '2026-10-02-site-traits' 与本服务器不再是同一模拟。
        // 先让旧端离场腾出座位，旧版本客户端才能真正进房走到"双就绪"的版本闸门
        // （否则会被"房间已满"先行挡下，断言就空转了）。
        stale.ws.close();
        await host.wait(m => m.t === 'peer-left');
        const older = await openClient(port);
        older.ws.send(JSON.stringify({ t: 'join', code: room.code, v: '2026-10-02-site-traits' }));
        await older.wait(m => m.t === 'room');        // 真正入房：座位已空出
        host.ws.send(JSON.stringify({ t: 'ready' }));
        older.ws.send(JSON.stringify({ t: 'ready' }));
        await host.wait(m => m.t === 'error');        // 版本闸门：双就绪拒绝开战
        await older.wait(m => m.t === 'error');
        assert.ok(!host.received.some(m => m.t === 'start'), '显式旧版本同样拒绝开局（房主）');
        assert.ok(!older.received.some(m => m.t === 'start'), '显式旧版本同样拒绝开局（旧版本端）');
        older.ws.close();
        await host.wait(m => m.t === 'peer-left');

        // 同版本重试可正常开局（ready 被消费，重新就绪）
        const fresh = await openClient(port);
        fresh.ws.send(JSON.stringify({ t: 'join', code: room.code, v: SIM_VERSION }));
        await fresh.wait(m => m.t === 'room');
        host.ws.send(JSON.stringify({ t: 'ready' }));
        fresh.ws.send(JSON.stringify({ t: 'ready' }));
        await host.wait(m => m.t === 'start');
        await fresh.wait(m => m.t === 'start');

        host.ws.close();
        fresh.ws.close();
    } finally {
        server.close();
    }
});
