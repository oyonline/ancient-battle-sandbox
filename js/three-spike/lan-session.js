// 页面级联机生命周期；无 DOM/THREE，部署器、时钟和模拟步均可替换测试。
import { NetBattle } from '../net/lockstep.js';
import { configDigest, resolveArmies, validateField3dConfig } from '../net/field3d-config.js';

const BATTLE_PACKETS = new Set(['turn', 'hash', 'cfg-hash', 'result']);
const SERVER_HINT = '请用对战服务器地址打开（npm run arena）';
const CONFIG_CHANGED = '对方配置已变化，请双方退出重新建房';
// 不含 rev，但包括兵力、阵型、战术；不依赖对象键顺序。
const deploymentKey = configs => JSON.stringify([
    resolveArmies(configs),
    ...['red', 'blue'].map(side => [configs[side].preset, configs[side].formation, configs[side].tactic])
]);
const copy = value => JSON.parse(JSON.stringify(value));

export class LanSession {
    constructor({ client, deploy, stepBattle, stepMs, onChange = () => {},
        makeNet = (scene, transport, options) => new NetBattle(scene, transport, options),
        now = () => performance.now(), schedule = (fn, ms) => setTimeout(fn, ms),
        cancel = timer => clearTimeout(timer), warn = message => console.warn(message) }) {
        Object.assign(this, { client, deploy, stepBattle, stepMs, onChange, makeNet, now, schedule, cancel, warn });
        this.state = 'connecting';
        this.status = '正在连接对战服务器…';
        this.arena = false;
        this.room = null;
        this.pending = false;
        this.locked = false;
        this.peerPresent = false;
        this.configs = null;
        this.rev = null;
        this.readyRev = null;
        this.deployedKey = null;
        this.deploying = false;
        this.scene = null;
        this.net = null;
        this.packets = []; // 从 connect 起接收，部署/加载/倒计时不丢包。
        this.running = false;
        this.stopped = false;
        this.started = false;
        this.winner = null;
        this.resultReported = false;
        this.countdown = '';
        this.banner = '';
        this.desync = null;
        this.abort = new AbortController();
        this.timer = null;
        this.identityTimer = null;
        this.finalStats = {};
        this.client.onEvent = packet => this.handle(packet);
    }

    emit() { this.onChange(this); }

    connect() {
        this.emit();
        this.identityTimer = this.schedule(() => {
            if (!this.arena && !this.stopped) { this.status = SERVER_HINT; this.emit(); }
        }, 5000);
        return this.client.connect().catch(() => {
            if (!this.stopped) { this.status = SERVER_HINT; this.emit(); }
        });
    }

    requestRoom(code) {
        if (!this.arena || this.stopped || this.room || this.pending) return false;
        this.pending = true;
        this.status = code === undefined ? '正在创建房间…' : '正在加入房间…';
        this.emit();
        if (code === undefined) this.client.createRoom('field3d');
        else this.client.joinRoom(code.trim().toUpperCase(), 'field3d');
        return true;
    }

    confirm(config) {
        if (!this.room || this.locked || this.stopped) return false;
        const checked = validateField3dConfig(config);
        if (!checked.ok) { this.status = checked.error; this.emit(); return false; }
        this.locked = true; // 首版不能修改；广播值才是实际部署依据。
        this.status = '等待对方确定配置';
        this.emit();
        this.client.sendConfig(checked.value);
        return true;
    }

    handle(packet) {
        if (this.stopped || !packet) return;
        if (BATTLE_PACKETS.has(packet.t)) {
            if (this.net) {
                this.net.handle(packet);
                if (this.state === 'finished') this.emit();
            }
            else this.packets.push(packet);
            return;
        }
        switch (packet.t) {
            case 'welcome':
                this.cancel(this.identityTimer);
                this.arena = packet.arena === true;
                this.state = this.arena ? 'lobby' : 'connecting';
                this.status = this.arena ? '创建房间或输入房间码加入' : SERVER_HINT;
                break;
            case 'room':
                if (this.room || packet.mode !== 'field3d' || !['red', 'blue'].includes(packet.side)) {
                    this.stop('房间状态异常，请退出重新建房'); return;
                }
                this.room = { code: packet.code, side: packet.side };
                this.pending = false;
                this.peerPresent = packet.side === 'blue';
                this.state = 'configuring';
                this.status = this.peerPresent ? '等待对方确定配置' : '等待对手加入';
                break;
            case 'peer':
                this.peerPresent = true;
                this.status = '等待对方确定配置';
                break;
            case 'config':
                this.receiveConfig(packet);
                return;
            case 'start':
                this.start(packet.rev);
                return;
            case 'peer-left':
            case 'closed':
                if (this.state === 'finished') { this.peerDeparted = true; this.emit(); return; }
                this.stop(packet.t === 'peer-left' ? '对手已离开' : '与服务器断开',
                    packet.t === 'closed' && !this.arena ? SERVER_HINT : undefined, false);
                return;
            case 'error':
                this.pending = false;
                this.status = packet.text || '房间操作失败。';
                break;
            default: return;
        }
        this.emit();
    }

    receiveConfig({ rev, configs }) {
        if (!this.room || this.started || !Number.isSafeInteger(rev) || rev < 0 ||
            (this.rev !== null && rev < this.rev)) return;
        this.rev = rev;
        this.configs = copy(configs);
        this.readyRev = null; // 新广播使旧 ready 失效，包括加载中的旧 rev。
        if (!configs?.red || !configs?.blue) {
            if (this.deployedKey) this.stop(CONFIG_CHANGED);
            else { this.status = this.peerPresent ? '等待对方确定配置' : '等待对手加入'; this.emit(); }
            return;
        }
        let key;
        try { key = deploymentKey(this.configs); }
        catch (error) { this.stop(error.message); return; }
        if (this.deployedKey) {
            if (key !== this.deployedKey) this.stop(CONFIG_CHANGED);
            else if (!this.deploying) this.ready();
            return;
        }
        this.deployedKey = key;
        this.deploying = true;
        this.state = 'loading';
        this.status = '正在加载模型…';
        const deployment = copy(this.configs), deploymentRev = rev;
        this.emit();
        // 在部署期间继续收包；中途 rev 更新必须在完成时再次核对。
        Promise.resolve().then(() => {
            if (this.stopped) return null;
            return this.deploy(deployment, { rev: deploymentRev, mySide: this.room.side, signal: this.abort.signal });
        }).then(scene => {
            if (this.stopped) return;
            this.scene = scene;
            this.deploying = false;
            if (deploymentKey(this.configs) !== this.deployedKey) { this.stop(CONFIG_CHANGED); return; }
            this.ready();
        }).catch(error => { if (!this.stopped) this.stop(error.message); });
    }

    ready() {
        if (this.stopped || this.deploying || !this.scene || this.readyRev === this.rev) return;
        this.readyRev = this.rev;
        this.state = 'ready';
        this.status = '已就绪，等待对方';
        this.emit();
        this.client.sendReady(this.readyRev);
    }

    start(rev) {
        if (this.started || this.stopped) return;
        if (this.readyRev === null || rev !== this.readyRev || rev !== this.rev || !this.scene || this.deploying) {
            this.status = '开战修订号与已就绪配置不匹配，已忽略'; this.emit(); return;
        }
        this.started = true;
        const net = this.makeNet(this.scene, { send: packet => this.client.send(packet) }, {
            configDigest: configDigest(this.configs, rev),
            onDesync: (turn, mine, theirs) => {
                this.desync = { turn, mine, theirs };
                this.stop(turn === -1 ? '双方开局配置不一致' : `第 ${Math.round(turn / 60)} 秒两端战斗不同步`);
            }
        });
        this.net = net;
        for (const packet of this.packets.splice(0)) {
            net.handle(packet);
            if (this.stopped) return;
        }
        net.start(); // 每局只调用一次；先铺底收包，再开始真实时钟倒计时。
        if (this.stopped) return;
        this.state = 'countdown';
        const end = this.now() + 3000;
        const tick = () => {
            if (this.stopped) return;
            const left = end - this.now();
            this.countdown = left > 0 ? String(Math.ceil(left / 1000)) : '开战！';
            if (left <= 0) {
                this.running = true;
                this.scene.battleStarted = true;
                this.state = 'running';
                this.timer = this.schedule(() => { this.countdown = ''; this.emit(); }, 600);
            } else this.timer = this.schedule(tick, Math.min(left, 1000));
            this.emit();
        };
        tick();
    }

    recordWinner(winner) { this.winner = winner; }

    advance(delta) {
        const scene = this.scene, net = this.net;
        if (!this.running || this.stopped || !net || scene.battleOver) return;
        scene.simulationAccumulator = Math.min(250,
            scene.simulationAccumulator + Math.max(0, Math.min(delta, 50)));
        let steps = 0;
        while (scene.simulationAccumulator + 1e-7 >= this.stepMs && !scene.battleOver && !this.stopped && steps < 3) {
            try {
                if (!net.lockstep.canStep()) { net.noteStall(delta); break; }
                const commands = net.lockstep.takeCommands();
                for (const command of commands) {
                    if (!this.warnedCommand) { this.warn('[lan3d] 忽略未知战中命令：' + JSON.stringify(command)); this.warnedCommand = true; }
                }
                scene.simulationAccumulator = Math.max(0, scene.simulationAccumulator - this.stepMs);
                scene.simulationTime += this.stepMs;
                this.stepBattle(scene, this.stepMs / 1000);
                net.onTurnDone();
                net.noteProgress();
                net.noteBuffer();
                steps++;
                if (scene.battleOver && !this.resultReported) {
                    this.resultReported = true;
                    net.reportResult({ turn: net.lockstep.execTurn - 1, winner: this.winner });
                    this.running = false; // 保留接收器，等待对端 result。
                    if (!this.stopped) { this.state = 'finished'; this.emit(); }
                }
            } catch (error) {
                console.error('[lan3d] 本端模拟异常', error);
                this.stop('本端模拟异常：' + (error?.message || String(error)));
            }
        }
    }

    get finishMessage() {
        if (this.state !== 'finished') return '';
        const result = this.net?.myResult, peer = this.net?.peerResult;
        const agreed = result && peer && ['turn', 'winner', 'hash'].every(key => result[key] === peer[key]);
        return `本局结束：${this.winner === 'red' ? '红方胜' : '蓝方胜'} · ${agreed ? '双方结果一致' : '等待对方结果…'}${this.peerDeparted ? ' · 对手已离开' : ''}`;
    }

    leave() {
        if (this.byeSent) return;
        this.byeSent = true;
        this.client.bye();
    }

    diagnostics() {
        const net = this.net;
        return { ...this.finalStats, state: this.state, readyRev: this.readyRev, rev: this.rev,
            winner: this.winner, desync: this.desync, banner: this.banner,
            ...(net ? { execTurn: net.lockstep.execTurn, stallEvents: net.stallEvents, peerLead: net.peerLead,
                myResult: net.myResult, peerResult: net.peerResult } : {}) };
    }

    stop(message = '', status = message, notifyPeer = true) {
        if (this.stopped) return;
        this.finalStats = this.diagnostics();
        this.stopped = true;
        this.running = false;
        this.state = 'stopped';
        this.banner = message;
        this.status = status;
        this.countdown = '';
        this.cancel(this.timer);
        this.cancel(this.identityTimer);
        this.abort.abort();
        this.packets.length = 0;
        this.net = null;
        if (notifyPeer) this.leave();
        this.emit();
    }

    dispose() { this.stop(); this.leave(); }
}
