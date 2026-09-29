// ==================== 局域网对战房间服务器（静态页 + WebSocket 中继） ====================
// 用法：npm run build && npm run arena
//   1) 房主在本机运行（打印局域网地址）；浏览器打开 http://本机IP:5300 创建房间（红方）
//   2) 对战另一人在同一局域网浏览器打开 http://房主IP:5300 输入房间码（蓝方）
//   3) 双方就绪 → 服务器广播 start → 各自倒计时开战；战斗中只中继命令（lockstep 见 js/net/）
//
// 服务器刻意保持"哑"：不做任何游戏逻辑，只做房间管理 + 消息保序双发
// （同一条命令按处理顺序转发给双方，保证两端同一回合内命令序一致 → 锁步确定性）。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 5300);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // 去掉易混字符（I/L/O/0/1）

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json'
};

// ---------------- 静态托管 dist ----------------
const server = http.createServer(async (req, res) => {
    try {
        const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        let file = path.join(ROOT, url === '/' ? 'index.html' : url);
        if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
        if (!existsSync(file) || !path.extname(file)) file = path.join(ROOT, 'index.html');   // SPA 兜底
        const data = await readFile(file);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
    } catch (_) {
        res.writeHead(404).end('not found');
    }
});

// ---------------- 房间与中继 ----------------
export function createArenaServer() {
const rooms = new Map();     // code -> { players: [ws|null, ws|null], ready: [bool, bool] }

const codeOf = ws => ws.__room ?? null;
const send = (ws, message) => { if (ws?.readyState === 1) ws.send(JSON.stringify(message)); };
const peerOf = ws => {
    const room = rooms.get(codeOf(ws));
    if (!room) return null;
    return room.players.find(p => p && p !== ws) ?? null;
};

function newCode() {
    while (true) {
        let code = '';
        for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
        if (!rooms.has(code)) return code;
    }
}

const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
    send(ws, { t: 'welcome', arena: true, time: Date.now() });   // 身份包：区分对战服务器与开发页
    ws.on('message', raw => {
        let message;
        try { message = JSON.parse(raw); } catch (_) { return; }
        switch (message.t) {
            case 'create': {
                const code = newCode();
                rooms.set(code, { players: [ws, null], ready: [false, false] });
                ws.__room = code;
                ws.__side = 0;
                send(ws, { t: 'room', code, side: 'red' });
                send(ws, { t: 'info', text: '房间已创建。对方在同一局域网浏览器打开本地址，输入房间码即可加入。' });
                break;
            }
            case 'join': {
                const room = rooms.get(String(message.code || '').toUpperCase().trim());
                const slot = room?.players.findIndex(p => !p || p.readyState > 1);
                if (!room || slot !== 1) { send(ws, { t: 'error', text: '房间不存在或已满，请核对房间码。' }); break; }
                room.players[1] = ws;
                room.ready = [false, false];
                ws.__room = String(message.code).toUpperCase().trim();
                ws.__side = 1;
                send(ws, { t: 'room', code: ws.__room, side: 'blue' });
                send(room.players[0], { t: 'peer', side: 'blue' });
                break;
            }
            case 'ready': {
                const room = rooms.get(codeOf(ws));
                if (!room) break;
                room.ready[ws.__side] = true;
                send(peerOf(ws), { t: 'peer-ready', side: ws.__side === 0 ? 'red' : 'blue' });
                if (room.ready.every(Boolean)) {
                    room.ready = [false, false];      // 消费掉，重开（rematch）可重新就绪
                    for (const player of room.players) send(player, { t: 'start' });
                }
                break;
            }
            case 'turn':
            case 'hash': {
                // 战斗消息双发（含发送方）：两端看到的同回合命令序 = 服务器处理序，锁步一致
                const room = rooms.get(codeOf(ws));
                if (!room) break;
                for (const player of room.players) send(player, message);
                break;
            }
            case 'bye': {
                send(peerOf(ws), { t: 'peer-left' });
                break;
            }
            default: break;
        }
    });

    ws.on('close', () => {
        const code = codeOf(ws);
        send(peerOf(ws), { t: 'peer-left' });
        if (code) {
            const room = rooms.get(code);
            if (room) room.players[ws.__side] = null;
            cleanupRoom(code);
        }
    });
});

function cleanupRoom(code) {
    const room = rooms.get(code);
    if (room && room.players.every(p => !p || p.readyState > 1)) rooms.delete(code);
}
return { server, wss };
}


// ---------------- 启动横幅（仅直接运行时；测试 import 不监听） ----------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    createArenaServer();   // 挂接 WebSocket（独立启动路径曾漏掉这一步：页面能开、房间按钮无响应的元凶）
    server.listen(PORT, () => {
        const nets = Object.values(os.networkInterfaces()).flat()
            .filter(n => n?.family === 'IPv4' && !n.internal).map(n => n.address);
        console.log('┌──────────────────────────────────────────────┐');
        console.log('│  🏰 帝国亲子沙盒 · 局域网对战服务器已启动        │');
        if (!existsSync(path.join(ROOT, 'index.html'))) {
            console.log('│  ⚠ 未发现 dist/ —— 请先运行 npm run build      │');
        }
        for (const ip of nets) console.log(`│  对战另一台电脑浏览器打开： http://${ip}:${PORT}  │`);
        console.log(`│  本机对战（自测双开标签页）： http://localhost:${PORT}   │`);
        console.log('└──────────────────────────────────────────────┘');
    });
}
