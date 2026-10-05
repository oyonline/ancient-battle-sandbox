// ==================== 房间客户端（浏览器侧 WebSocket 封装） ====================
// 页面由房间服务器托管（孩子输入房主 IP 打开），因此 WebSocket 永远连
// location.host——两端零配置。事件经 onEvent 回调上抛给 UI / NetBattle。

import { SIM_VERSION } from './lockstep.js';

export class ArenaClient {
    constructor(onEvent) {
        this.ws = null;
        this.isArena = false;      // 收到服务器 welcome 才为真（区分 vite 开发页等假端口）
        this.onEvent = onEvent || (() => {});
    }

    get connected() {
        return this.ws?.readyState === 1;
    }

    connect() {
        return new Promise((resolve, reject) => {
            try {
                const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
                this.ws = new WebSocket(`${protocol}://${location.host}`);
            } catch (error) {
                reject(error);
                return;
            }
            const failTimer = setTimeout(() => reject(new Error('连接超时')), 5000);
            this.ws.onopen = () => { clearTimeout(failTimer); resolve(); };
            this.ws.onerror = () => { clearTimeout(failTimer); reject(new Error('无法连接对战服务器')); };
            this.ws.onclose = () => this.onEvent({ t: 'closed' });
            this.ws.onmessage = event => {
                let message;
                try { message = JSON.parse(event.data); } catch (_) { return; }
                if (message.t === 'welcome') this.isArena = message.arena === true;
                this.onEvent(message);
            };
        });
    }

    send(message) {
        if (this.connected) this.ws.send(JSON.stringify(message));
    }

    // create/join 自带模拟版本：服务器开局前做两端版本准入（混版本必分歧）。
    // mode：房间玩法（'territory' 常规红蓝对战 / 'coop' 红蓝联军打黑方），服务器透传给两端。
    createRoom(mode = 'territory') { this.send({ t: 'create', v: SIM_VERSION, mode }); }
    joinRoom(code) { this.send({ t: 'join', code, v: SIM_VERSION }); }
    sendReady() { this.send({ t: 'ready' }); }
    bye() { this.send({ t: 'bye' }); this.ws?.close(); }
}
