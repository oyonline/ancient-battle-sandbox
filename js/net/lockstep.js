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
// 2026-10-03 cavalry-corps：开局骑兵整编独立骑队、增援骑兵独立集结池（3骑成队/
// 超时单骑保底）——营 id 编号与营成员映射改变，营令网络命令在混版本下必然错位。
// 2026-10-03 cavalry-auto-charge：旗边敌情优先/回撤中断缠斗/驻守缰绳/接管转换清
// 冲锋动量——骑兵接敌与撤退轨迹整体改变，混版本必然漂移。
// 2026-10-03 cavalry-def10：骑兵防御 15→10（最小平衡方案）——所有对骑伤害数值
// 改变（剑士普通命中 1→6），混版本状态哈希必然分歧。
// 2026-10-03 rework-r2（用户复验返修轮终名，覆盖全轮）：F1 驻守缰绳滞回承诺
// 改变骑兵驻守行为；F3 状态投影纳入营队摘要（营令/池归属/corpsManaged/
// leashReturning/chargeDistance），投影格式本身变化；F4 回撤令抢占攻寨自动
// 接管。三者混版本必然分歧或误报，必须拒绝混入。
// 2026-10-03 rework-r2b（R2 复审附注 F8）：leashReturning 在驻点清空时显式
// 复位——实测存在可观测行为差异（改令后再设驻守点，旧承诺跨令压制接敌 vs
// 立即恢复接敌资格），按纪律递增。
// 2026-10-03 rework-r2c（用户复验 F13）：复位移至回撤早退之前，覆盖回撤/改旗
// 令/清令/集结全部非驻守路径——"驻守出界→回撤→新驻守"序列下旧承诺不再跨令
// 存活压制接敌（用户对照实测 3 秒敌 100 不动 vs 降到 60），行为差异实测成立。
// 2026-10-04 coop-black：引入第三阵营「黑方」与红蓝同盟（合作模式）——敌我判定
// 改走关系表、旗帜拉锯按同盟组合并、投影新增 K 阵营编码与经济/票数/征兵/池黑方分量。
// 即使既有两方对局行为逐位不变，模拟语义与投影结构已扩展，混版本必须拒绝。
// Free tower coordinates/IDs, axe combat and tower balance change simulation state.
export const SIM_VERSION = '2026-10-05-free-towers-axe';

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
// 阵营字符：R 红 / B 蓝 / K 黑——既有两方对局只出现 R/B，编码与旧版逐位一致。
const teamChar = team => team === 'red' ? 'R' : team === 'blue' ? 'B' : team === 'black' ? 'K' : String(team);
export function battleProjection(scene) {
    const parts = ['t' + Math.round(scene.simulationTime)];
    for (const unit of scene.units) {
        if (unit.dead || unit.withdrawn) continue;
        parts.push(unit.id, teamChar(unit.team), unit.type,
            Math.round(unit.gx * 1e4), Math.round(unit.gy * 1e4),
            Math.round(unit.hp * 1e3), unit.moraleState);
        // 骑兵接管/滞回标记与量化助跑距离（F3）：三项直接决定下一步是否交还冲锋
        // 状态机，分叉不一定立刻体现在坐标上（如驻点静置），必须直接入哈希。
        // chargeDistance 按 0.05 量子取整（与 units.js 镜像量化同纪律，防浮点尘）。
        if (unit.type === 'cavalry' && scene.battalions) {
            parts.push('cav', unit.corpsManaged ? 1 : 0, unit.leashReturning ? 1 : 0,
                Math.round((unit.chargeDistance || 0) * 20));
        }
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
        parts.push(flag.owner ? teamChar(flag.owner) : 'n', Math.round(flag.progress * 1e4));
    }
    // 营队状态入投影（F3）：营决定领土模式下所有单位的行为（集结/回撤/驻守/交还），
    // 此处分叉可能暂不改变坐标（用户探针：一侧单骑出发、一侧继续集结，哈希仍一致）
    // 却必然在后续漂移——直接纳入 2 秒哈希补上检测缺口。遍历序 = 营创建序（两端
    // 一致）；chargeDistance/时间戳取整、orderPoint 按坐标 1e4 取整，与既有投影同纪律。
    // 按参与阵营投影：既有两方对局仍只列 R/B，合作模式才追加黑方——
    // 投影格式随参战名单走，旧对局字符串不变。
    const roster = scene.activeTeams || ['red', 'blue'];
    if (scene.battalions) {
        parts.push('b', scene.battalions.battalions.length);
        for (const b of scene.battalions.battalions) {
            parts.push(b.id, teamChar(b.team), b.gathering ? 1 : 0, b.cavalry ? 1 : 0,
                b.orderFlag ?? '', b.orderPoint ? Math.round(b.orderPoint.gx * 1e4) + ':' + Math.round(b.orderPoint.gy * 1e4) : '',
                b.retreat ? 1 : 0, b.stance, Math.round(b.chargeUntil || 0), Math.round(b.createdAt || 0),
                b.members.map(u => u.id).join('.'));
        }
        parts.push('pool',
            ...roster.map(t => scene.battalions.pool[t]?.id ?? ''),
            ...roster.map(t => scene.battalions.cavPool[t]?.id ?? ''));
    }
    const territory = scene.territory;
    parts.push('e',
        ...roster.map(t => Math.round(territory.econ.treasury[t] * 1e3)),
        ...roster.map(t => Math.round(territory.tickets.tickets[t] * 1e3)),
        ...roster.map(t => territory.recruit.spawned[t]),
        ...roster.map(t => territory.recruit.queues[t].length));
    if (territory.camps) {
        parts.push('camps', JSON.stringify(territory.camps.projection()));
        parts.push('arrows', JSON.stringify(scene.arrows.map(a => [
            a.source?.id, a.team, a.buildingId || '', a.sx, a.sy, a.tx, a.ty,
            a.t, a.dur, a.dmg, a.firedAt, a.sourceHeight, a.targetHeight
        ])));
        for (const team of roster) {
            parts.push(team, JSON.stringify(territory.recruit.queues[team]),
                JSON.stringify(territory.rally?.[team] ?? null));
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
