// ==================== 锁步联机核心（纯逻辑，不碰 Phaser、不碰 DOM） ====================
// 原理：两端各自跑完全相同的确定性模拟，网络只传命令。命令带"执行回合号"，
// 按 LOOKAHEAD 回合前瞻调度；推进第 T 回合前必须收齐双方第 T 回合的包
// （空包也算），否则停等。服务器对每条消息保序双发，两端同回合内命令序一致
// （红方包在前、蓝方包在后，侧内按发出序）→ 与 docs/DETERMINISM.md 约定闭环。
//
// 视觉随机量（bobPhase/slideOff/彩带）只进渲染不入哈希；状态哈希只投影模拟字段。

export const LOCKSTEP = {
    LOOKAHEAD: 48,          // 命令前瞻回合数（60fps 下 ≈800ms；吸收 WiFi 抖动/省电缓冲的到达尖峰）
    HASH_EVERY: 120         // 每 120 回合（2 秒）交换一次状态哈希，检测不同步
};

// 模拟版本：任何改变锁步命令语义/模拟结果的批次提交时递增（日期-批次名）。
// 房间服务器用它做开局准入——两端版本不一致（或旧标签页缺版本）时拒绝开战，
// 否则同一命令在两端产生分歧结果（如本批的 build tent），锁步必然漂移。
// server/arena.mjs 与 js/net/arena-client.js 共同引用本常量（本模块纯逻辑，node 可直接 import）。
// 2026-10-02 review-fixes：投影纳入 workerEngageAt（历史交战时刻影响施工暂停），
// 且民夫出手边界口径统一（量化半量子容差）——两者都会改变状态哈希，混版本必须拒绝。
// 2026-10-02 review-fixes-r2：量化决策半量子边界统一归属（epsilon 商偏置）+
// 民夫候选查询覆盖完整接受带——噪声带内的离散决策结果改变，同样需拒绝混版本。
export const SIM_VERSION = '2026-10-02-review-fixes-r2';

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
        if (scene.territory?.camps) {
            parts.push('camp-unit', unit.garrisonTowerId || '', unit.garrisonOrderId || '',
                unit.orderBuildingId || '', Math.round((unit.garrisonHeight || 0) * 1e3),
                Math.round(unit.lastAttack * 1e3), JSON.stringify(unit.workerTask || null),
                // 民夫历史交战时刻：不是派生/展示字段——它单独决定之后 300ms 的施工暂停
                // （同模拟时刻下 800 与 600 的施工状态不同）。空串 = 从未交战；
                // 真实的 0ms 是有效值，不能与"未交战"混同。
                unit.workerEngageAt == null ? '' : Math.round(unit.workerEngageAt * 1e3),
                // 疗伤字段入哈希：撤退目标/在疗状态/入住时刻任一分歧都能被 2 秒哈希检出
                unit.healSiteId ?? '', unit.healingAt ?? '', Math.round(unit.healingSince || 0));
        }
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
    if (territory.camps) {
        parts.push('camps', JSON.stringify(territory.camps.projection()));
        parts.push('arrows', JSON.stringify(scene.arrows.map(a => [
            a.source?.id, a.team, a.buildingId || '', a.sx, a.sy, a.tx, a.ty,
            a.t, a.dur, a.dmg, a.firedAt, a.sourceHeight, a.targetHeight
        ])));
        for (const team of ['red', 'blue']) {
            parts.push(team, JSON.stringify(territory.recruit.queues[team]),
                JSON.stringify(territory.rally[team]));
        }
        if (territory.healing) parts.push('healing', String(Math.round(territory.healing.nextAssign || 0)));
    }
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
        this.stalls = 0;          // 停等次数（诊断：持续增长=网络抖动超余量）
        this.peerLead = 0;        // 对端包领先的本端执行回合数（缓冲深度）
        this.waiting = false;
        this.waitMs = 0;
        this.currentWaitMs = 0;
        this.longestWaitMs = 0;
        this.stallEvents = 0;
    }

    noteStall(delta = 0) {
        this.stalls++;
        if (!this.waiting) this.stallEvents++;
        this.waiting = true;
        const elapsed = Math.max(0, Number.isFinite(delta) ? delta : 0);
        this.waitMs += elapsed;
        this.currentWaitMs += elapsed;
        this.longestWaitMs = Math.max(this.longestWaitMs, this.currentWaitMs);
        this.noteBuffer();
    }

    noteProgress() { this.waiting = false; this.currentWaitMs = 0; }

    noteBuffer() {
        let lead = 0;
        while (true) {
            const slot = this.lockstep.inbox.get(this.lockstep.execTurn + lead);
            if (!slot?.red || !slot?.blue) break;
            lead++;
        }
        this.peerLead = lead;
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
