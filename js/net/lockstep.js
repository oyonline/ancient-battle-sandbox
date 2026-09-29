// ==================== 锁步联机核心（纯逻辑，不碰 Phaser、不碰 DOM） ====================
// 原理：两端各自跑完全相同的确定性模拟，网络只传命令。命令带"执行回合号"，
// 落后 12 回合（≈200ms）调度；推进第 T 回合前必须收齐双方第 T 回合的包
// （空包也算），否则停等。服务器对每条消息保序双发，两端同回合内命令序一致
// （红方包在前、蓝方包在后，侧内按发出序）→ 与 docs/DETERMINISM.md 约定闭环。
//
// 视觉随机量（bobPhase/slideOff/彩带）只进渲染不入哈希；状态哈希只投影模拟字段。

export const LOCKSTEP = {
    LOOKAHEAD: 12,          // 命令前瞻回合数（60fps 下 ≈200ms；局域网 RTT 远小于此）
    HASH_EVERY: 120         // 每 120 回合（2 秒）交换一次状态哈希，检测不同步
};

export class Lockstep {
    constructor(side, lookahead = LOCKSTEP.LOOKAHEAD) {
        this.side = side;
        this.lookahead = lookahead;
        this.execTurn = 0;          // 下一个待执行回合
        this.pending = [];          // 本端尚未发出的命令（归入下一个调度包）
        this.inbox = new Map();     // exec -> { red?: cmd[], blue?: cmd[] }
        this.sentSlots = new Set(); // 已发出包的回合号（prime 与常规路径共用）
    }

    // 玩家操作：进下一个调度包（由 commitTurn/prime 决定具体回合号）
    act(command) {
        this.pending.push(command);
    }

    packetFor(exec) {
        const cmds = this.pending;
        this.pending = [];
        this.sentSlots.add(exec);
        return { t: 'turn', exec, side: this.side, cmds };
    }

    // 开战前铺底：为前 lookahead 个回合各发一个（可空）包，否则第 0 回合永远等不到对端
    prime() {
        const packets = [];
        for (let i = 0; i < this.lookahead; i++) packets.push(this.packetFor(i));
        return packets;
    }

    // 每执行完一回合调用：为 (已执行回合 + lookahead) 槽发包
    commitTurn() {
        return this.packetFor(this.execTurn - 1 + this.lookahead);
    }

    receive(packet) {
        if (!packet || packet.t !== 'turn' || typeof packet.exec !== 'number') return;
        let slot = this.inbox.get(packet.exec);
        if (!slot) { slot = {}; this.inbox.set(packet.exec, slot); }
        slot[packet.side] = (slot[packet.side] || []).concat(packet.cmds || []);
    }

    canStep() {
        const slot = this.inbox.get(this.execTurn);
        return !!(slot && slot.red && slot.blue);
    }

    // 取走当前回合命令（红前蓝后固定序）并前进一步
    takeCommands() {
        const slot = this.inbox.get(this.execTurn) || {};
        const commands = [...(slot.red || []), ...(slot.blue || [])];
        this.inbox.delete(this.execTurn);
        this.execTurn++;
        return commands;
    }
}

// ---------------- 状态投影与哈希 ----------------
// 只投影影响模拟的字段；单位数组序 = 生成序（两端一致），死亡周期压实保持相对序。
export function battleProjection(scene) {
    const parts = ['t' + Math.round(scene.simulationTime)];
    for (const unit of scene.units) {
        if (unit.dead || unit.withdrawn) continue;
        parts.push(unit.id, unit.team === 'red' ? 'R' : 'B', unit.type,
            Math.round(unit.gx * 1e4), Math.round(unit.gy * 1e4),
            Math.round(unit.hp * 1e3), unit.moraleState);
    }
    parts.push('f');
    for (const flag of scene.flags) {
        parts.push(flag.owner ? (flag.owner === 'red' ? 'R' : 'B') : 'n', Math.round(flag.progress * 1e4));
    }
    const territory = scene.territory;
    parts.push('e',
        Math.round(territory.econ.treasury.red * 1e3), Math.round(territory.econ.treasury.blue * 1e3),
        Math.round(territory.tickets.tickets.red * 1e3), Math.round(territory.tickets.tickets.blue * 1e3),
        territory.recruit.spawned.red, territory.recruit.spawned.blue,
        territory.recruit.queues.red.length, territory.recruit.queues.blue.length);
    return parts.join(',');
}

export function hashProjection(projection) {
    let hash = 5381;
    for (let i = 0; i < projection.length; i++) {
        hash = ((hash << 5) + hash + projection.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
}

// ---------------- 网络对局控制器：粘合 场景 ⇄ 锁步 ⇄ 房间客户端 ----------------
// 场景钩子：advanceNet 每执行完一回合调用 onTurnDone()；哈希不一致经 onDesync 上报。
export class NetBattle {
    constructor(scene, client, { onDesync } = {}) {
        this.scene = scene;
        this.client = client;                 // { send(packet) }（arena-client 或测试用命令泵）
        this.lockstep = new Lockstep(scene.netMySide);
        this.onDesync = onDesync || (() => {});
        this.lastHashTurn = -1;
        this.myHashes = new Map();            // turn -> hash
        this.peerHashes = new Map();          // turn -> hash
        this.desynced = false;
        this.primed = false;
    }

    // 铺底包（幂等）：必须在两端倒计时结束前完成创建并调用——包先到先存 inbox，
    // 不会因创建晚而丢弃（曾因此两端互等第 0 回合、全场冻住的死锁）。
    start() {
        if (this.primed) return;
        this.primed = true;
        for (const packet of this.lockstep.prime()) this.client.send(packet);
    }

    // 场景每执行完一个模拟回合调用：发常规包 + 周期性哈希
    onTurnDone() {
        this.client.send(this.lockstep.commitTurn());
        const turn = this.lockstep.execTurn - 1;
        if (turn > 0 && turn % LOCKSTEP.HASH_EVERY === 0) {
            const hash = hashProjection(battleProjection(this.scene));
            this.myHashes.set(turn, hash);
            this.client.send({ t: 'hash', turn, hash });
            this.checkHashes();
        }
    }

    handle(packet) {
        if (packet?.t === 'turn') this.lockstep.receive(packet);
        else if (packet?.t === 'hash') {
            this.peerHashes.set(packet.turn, String(packet.hash));
            this.checkHashes();
        }
    }

    checkHashes() {
        for (const [turn, mine] of this.myHashes) {
            const theirs = this.peerHashes.get(turn);
            if (theirs == null) continue;
            if (theirs !== mine && !this.desynced) {
                this.desynced = true;
                this.onDesync(turn, mine, theirs);
            }
            this.myHashes.delete(turn);
            this.peerHashes.delete(turn);
        }
    }
}
