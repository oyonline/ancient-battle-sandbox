// 局域网对战服务器：建房/入房分边/就绪开局/命令保序双发/掉线通知
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createArenaServer } from '../server/arena.mjs';

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

        host.ws.send(JSON.stringify({ t: 'create' }));
        const room = await host.wait(m => m.t === 'room');
        assert.equal(room.side, 'red', '房主为红方');
        assert.match(room.code, /^[A-Z2-9]{4}$/, '四位房间码');

        guest.ws.send(JSON.stringify({ t: 'join', code: room.code }));
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
