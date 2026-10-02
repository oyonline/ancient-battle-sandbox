// 局域网对战服务器：建房/入房分边/就绪开局/命令保序双发/掉线通知/版本准入
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createArenaServer } from '../server/arena.mjs';
import { SIM_VERSION } from '../js/net/lockstep.js';

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
