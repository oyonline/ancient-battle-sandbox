import { homePosition } from '../territory-map.js';
// ==================== 营队系统（纯模拟，不碰渲染；仅领土征服模式启用） ====================
// 军队按营组织：开局常备军确定性分编——骑兵整编独立骑队（营心=自身，行军不被
// 步战营拖住），其余步战兵三等分为上/中/下营；新兵入集结营（骑兵与步战分池），
// 攒满一波整营激活推进（消灭单兵逐个溜达）；营级 AI 全军合成一个军团，按据点
// 价值选一个主攻旗，先到集合点收拢再一起压上（家旗被犯仍一旗一营最近营回援）；
// 行军步速取营内最慢兵种同步。玩家令优先于 AI 令：选营点旗，夺旗后交还 AI。
//
// 确定性铁律：无 Math.random；遍历序固定（team 序、营创建序、旗序、id 决胜），
// 与 docs/DETERMINISM.md 的换座镜像 / 锁步约定兼容。

import { BATTALION_POWER } from './economy.js';
import { UNIT_TYPES } from '../units.js';
import { board } from '../board.js';
import { SITE_AI, traitState, siteWeight } from './site-traits.js';
import { quantizeDecision } from './determinism.js';
import { TEAMS, activeTeams, isHostile, sameSide, enemiesOf, groupOf, canonicalOf } from '../factions.js';

export const BATTALION = {
    OPENING_LANES: 3,          // 开局步战营分营数（按纵向位置三等分）
    WAVE_SIZE: 8,              // 步战集结营满员激活阈值
    WAVE_MIN_AGE_MS: 25000,    // 集结超时也激活的门槛（低收入的慢战线不至于永远蹲家）
    WAVE_MIN_SIZE: 5,          // 步战超时激活的最低人数
    CAV_WAVE_SIZE: 3,          // 骑队满员激活阈值：3骑成队（骑兵贵而少，不沿用攒8人）
    CAV_WAVE_MIN_SIZE: 1,      // 骑队超时激活的最低人数：单骑保底出发（马场断续出骑时不永远蹲家）
    AI_INTERVAL_MS: 2000,      // 营级 AI 评估间隔
    ASSESS_RADIUS: 9,          // 旗附近敌我实力评估半径（格）
    GATHER_HOLD_RADIUS: 3,     // 集结营成员围绕集结点的驻留半径
    PACE_SLACK: 1.08,          // 行军步速同步的宽容系数（略高于最慢兵种）
    ARMY_STAGE_DIST: 10,       // 军团集合点距主攻旗约 10 格（取本方一侧，先集合再压上）
    ARMY_STAGE_RADIUS: 6,      // 集合点判定半径：半径内战力够比例即转突击
    ARMY_ASSAULT_SHARE: 0.7,   // 转突击所需集合战力占军团总战力的比例
    ARMY_STAGE_TIMEOUT_MS: 20000, // 集合超时（模拟时钟）：未集齐也按时压上，不 endless 蹲点
    ARMY_WEIGHT_BONUS: 18,     // 主攻目标按据点分量加分：每多 1 分量 +18（只用于主攻打分）
    TIE_EPS: 1e-6              // 主攻目标平局决胜键的容差：原始浮点差 > 1e-6 才分胜负，
                               // 以内视为同一距离/偏移（只吸收 ~1e-14 级浮点表示噪声）
};

let battalionSeq = 1000;   // 仅兜底（测试手工建营）；正式营一律由 BattalionSystem 编号

export class Battalion {
    constructor(team, kind, id) {
        this.id = id ?? battalionSeq++;
        this.team = team;
        this.kind = kind;                 // 'line'（成建制作战营）| 'gathering'（集结中）
        this.gathering = kind === 'gathering';
        this.cavalry = false;             // 纯骑队营：独立集结池与激活阈值，步速取骑兵自身
        this.createdAt = 0;               // 场景模拟时钟（集结超时判定用）
        this.members = [];
        this.orderFlag = null;            // 目标旗 index；null = 无令
        this.orderPoint = null;           // 驻守点令 {gx,gy}（与 orderFlag 互斥；玩家长期令）
        this.playerOrdered = false;       // 玩家令（AI 不覆盖；点令恒真）
        this.retreat = false;             // 玩家回防令
        this.chargeUntil = 0;             // 冲锋窗口截止（模拟时钟 ms；窗口内骑兵交还冲锋状态机）
        this.chargeReadyAt = 0;           // 冲锋冷却截止
        this.stance = 'steady';           // 营姿态：稳健=驻守缰绳7格 | 好战=追击缰绳14格
        this.gatherPoint = null;
        this.stagePoint = null;           // 军团集合点 {gx,gy}（AI 令；与玩家旗令/点令互斥）
        this.pace = 2.2;                  // 营行军步速（最慢兵种）
    }

    aliveMembers() {
        return this.members.filter(u => !u.dead && !u.withdrawn && !u.garrisonTowerId);
    }

    center() {
        const alive = this.aliveMembers();
        if (!alive.length) return null;
        let gx = 0, gy = 0;
        for (const u of alive) { gx += u.gx; gy += u.gy; }
        return { gx: gx / alive.length, gy: gy / alive.length };
    }

    power() {
        let total = 0;
        for (const u of this.aliveMembers()) total += BATTALION_POWER[u.type] ?? 5;
        return total;
    }

    refreshPace() {
        let pace = Infinity;
        for (const u of this.aliveMembers()) {
            if (u.type === 'cavalry') continue;      // 骑兵不拴步速（缰绳另行约束）
            pace = Math.min(pace, u.typeData.speed);
        }
        // 纯骑队营心=骑兵自身：步速回落到骑兵速度，而不是步战兜底 2.2
        this.pace = Number.isFinite(pace) ? pace : (this.cavalry ? UNIT_TYPES.cavalry.speed : 2.2);
    }
}

export class BattalionSystem {
    constructor(scene) {
        this.scene = scene;                 // 场景钩子：flags / forEachNear / simulationTime
        this.battalions = [];               // 营创建序（确定性）
        this.pool = { red: null, blue: null, black: null };       // 各方现役步战集结营
        this.cavPool = { red: null, blue: null, black: null };    // 各方现役骑队集结营（骑兵独立分池，不与步战混编）
        this.nextThink = 0;
        this.seq = 1;                       // 营号从每场战斗重新计数——联机两端 id 逐一对齐（网络令按 id 寻址）
        // 每方一个军团：全军合成一路，先集合再突击一个主攻旗。
        // target = 主攻旗 index（null = 无可攻目标）；phase = 集合/突击；stageSince = 进入集合的模拟时刻。
        this.army = {
            red: { target: null, phase: 'stage', stageSince: 0 },
            blue: { target: null, phase: 'stage', stageSince: 0 },
            black: { target: null, phase: 'stage', stageSince: 0 }
        };
    }

    // 军团重心 = 指定营全部存活成员的位置均值（确定性：营创建序 + 成员序）。
    armyCenter(battalions) {
        let gx = 0, gy = 0, n = 0;
        for (const battalion of battalions) {
            for (const unit of battalion.aliveMembers()) { gx += unit.gx; gy += unit.gy; n++; }
        }
        return n ? { gx: gx / n, gy: gy / n } : null;
    }

    // 集合点：军团重心→目标旗连线上、距目标旗 ARMY_STAGE_DIST 格的本方一侧点；
    // 重心已不足该距离时直接取重心。几何量全部相对本方重心，换座镜像成立。
    stagePointFor(center, flag) {
        if (!center || !flag) return null;
        const dx = center.gx - flag.gx, dy = center.gy - flag.gy;
        const len = Math.hypot(dx, dy);
        if (quantizeDecision(len) <= BATTALION.ARMY_STAGE_DIST) return { gx: center.gx, gy: center.gy };
        const k = BATTALION.ARMY_STAGE_DIST / len;
        return { gx: flag.gx + dx * k, gy: flag.gy + dy * k };
    }

    // 主攻目标平局决胜键：仅当量化后的主分数相差 ≤1e-9 时使用。全部取原始浮点，
    // 不量化、不平方——把距离先量化到 0.05 会制造 0.05 宽的人为平局区，再平方
    // 只会把桶边界的浮点噪声放大成胜负。原始距离对镜像局两侧严格同向：军团重心
    // 偏西则西旗距离更小，红蓝换座、黑方南侧压中均成立。顺序：
    //   ① 军团重心→旗 原始距离（小者胜：重心偏哪侧就选哪侧）；
    //   ② 旗→本方大本营 homeRally(team) 原始距离（小者胜：天然偏向本方一侧）；
    //   ③ |旗.gy − 本方大本营.gy|（小者胜；换座 y 不变）；
    //   ④ 三键都在 TIE_EPS 内相等时落回固定旗序（旗 index 序）。
    // ④ 只发生在重心偏移 < TIE_EPS 级（几乎正中轴）的完全对称局面：这是镜像
    // 不动点——两侧的几何输入镜像成同一组数，任何确定性规则都无法同时满足两侧
    // （要求红选西、蓝选东，就必然要求同一组输入产生两个答案），与 HEAD 的
    // score > bestScore + 1e-9 容差同性质，不是未修复的缺陷。
    targetTieKey(team, flag, center) {
        const home = this.homeRally(team);
        return [
            center ? Math.hypot(flag.gx - center.gx, flag.gy - center.gy) : 0,
            Math.hypot(flag.gx - home.gx, flag.gy - home.gy),
            Math.abs(flag.gy - home.gy)
        ];
    }

    // 决胜键字典序比较：原始浮点键用 TIE_EPS 容差，|a-b| > TIE_EPS 才分胜负，
    // 容差内视为相等进入下一键；三键全等返回 0，由固定旗序（先到先得）决胜。
    compareTieKeys(a, b) {
        for (let i = 0; i < a.length; i++) {
            if (a[i] < b[i] - BATTALION.TIE_EPS) return -1;
            if (a[i] > b[i] + BATTALION.TIE_EPS) return 1;
        }
        return 0;
    }

    createBattalion(team, kind) {
        return new Battalion(team, kind, this.seq++);
    }

    homeRally(team) {
        if (this.scene.battleOptions?.coop) return homePosition(team, this.scene.board_W(), this.scene.board_H(), true);
        // 黑方自南侧压中：老家集结点在正南中央；红西蓝东不变。
        if (team === 'black') return { gx: this.scene.board_W() / 2, gy: this.scene.board_H() - 8 };
        return { gx: team === 'red' ? 8 : this.scene.board_W(), gy: this.scene.board_H() / 2 };
    }

    // 集结点：玩家自定义集结旗优先，否则老家（新兵/集结营在此聚兵）
    gatherRally(team) {
        const rally = this.scene.territory?.rally?.[team];
        return rally ? { gx: rally.gx, gy: rally.gy } : this.homeRally(team);
    }

    // 开局分编：骑兵整编独立骑队（按 gy 稳定排序后按 CAV_WAVE_SIZE 均分，
    // 默认 3 骑成一队；营心=骑兵自身，行军与接敌不再被步战营心拖住）；
    // 其余步战兵按 gy 稳定排序后三等分（id 决胜），保留上/中/下三个成建制营。
    // 无骑兵不建空骑队；纯骑兵开局不建空步战营。
    splitOpening(units) {
        for (const team of activeTeams(this.scene)) {
            const mine = units.filter(u => u.team === team && !u.dead && !u.withdrawn && u.type !== 'worker');
            if (!mine.length) continue;
            const foot = mine.filter(u => u.type !== 'cavalry');
            const horses = mine.filter(u => u.type === 'cavalry');
            foot.sort((a, b) => a.gy - b.gy || a.id - b.id);
            horses.sort((a, b) => a.gy - b.gy || a.id - b.id);
            const lanes = Math.min(BATTALION.OPENING_LANES, foot.length);
            for (let lane = 0; lane < lanes; lane++) {
                const battalion = this.createBattalion(team, 'line');
                const from = Math.floor(lane * foot.length / lanes);
                const to = Math.floor((lane + 1) * foot.length / lanes);
                for (let i = from; i < to; i++) {
                    battalion.members.push(foot[i]);
                    foot[i].battalion = battalion;
                }
                battalion.refreshPace();
                this.battalions.push(battalion);
            }
            // 独立骑队：每队约 CAV_WAVE_SIZE 骑（与增援骑队池同一成队口径），
            // 上限 OPENING_LANES 队——大编制也不拆成单骑营。
            const troops = Math.min(BATTALION.OPENING_LANES, Math.ceil(horses.length / BATTALION.CAV_WAVE_SIZE));
            for (let t = 0; t < troops; t++) {
                const battalion = this.createBattalion(team, 'line');
                battalion.cavalry = true;
                const from = Math.floor(t * horses.length / troops);
                const to = Math.floor((t + 1) * horses.length / troops);
                for (let i = from; i < to; i++) {
                    battalion.members.push(horses[i]);
                    horses[i].battalion = battalion;
                }
                battalion.refreshPace();
                this.battalions.push(battalion);
            }
        }
    }

    // 新兵入集结营：骑兵进独立骑队池（3骑成队 / 25秒超时单骑保底），其余进
    // 步战集结池（满8人一波 / 超时5人保底）；满员或超时整营激活并另开新池。
    assignReinforcement(unit) {
        if (unit.type === 'worker' || unit.garrisonTowerId) return;
        const team = unit.team;
        const cavalry = unit.type === 'cavalry';
        const pools = cavalry ? this.cavPool : this.pool;
        if (!pools[team]) {
            pools[team] = this.createBattalion(team, 'gathering');
            pools[team].cavalry = cavalry;
            pools[team].gatherPoint = this.gatherRally(team);
            pools[team].createdAt = this.scene.simulationTime;
            this.battalions.push(pools[team]);
        }
        const pool = pools[team];
        pool.members.push(unit);
        unit.battalion = pool;
        pool.refreshPace();
    }

    // 每步推进：剪除阵亡 → 营维护（步速/空营解散/集结激活/夺旗交还）→ 周期性 AI 派营。
    update(now) {
        for (const battalion of this.battalions) {
            if (battalion.members.length !== battalion.aliveMembers().length) {
                battalion.members = battalion.aliveMembers();
            }
            battalion.refreshPace();
            if (battalion.gathering) battalion.gatherPoint = this.gatherRally(battalion.team);   // 集结点改令实时生效
        }
        this.battalions = this.battalions.filter(b => b.members.length > 0);
        for (const team of TEAMS) {
            if (this.pool[team] && this.pool[team].members.length === 0) this.pool[team] = null;
            if (this.cavPool[team] && this.cavPool[team].members.length === 0) this.cavPool[team] = null;
        }
        // 集结激活：满员或超时（骑队与步战池各自阈值）
        for (const team of TEAMS) {
            if (this.pool[team] && !this.pool[team].gathering) this.pool[team] = null;       // 已激活的营不再是集结池
            if (this.cavPool[team] && !this.cavPool[team].gathering) this.cavPool[team] = null;
        }
        const flags = this.scene.flags || [];
        for (const battalion of this.battalions) {
            if (!battalion.gathering) continue;
            const size = battalion.members.length;
            const age = now - battalion.createdAt;
            const waveSize = battalion.cavalry ? BATTALION.CAV_WAVE_SIZE : BATTALION.WAVE_SIZE;
            const minSize = battalion.cavalry ? BATTALION.CAV_WAVE_MIN_SIZE : BATTALION.WAVE_MIN_SIZE;
            if (size >= waveSize || (age >= BATTALION.WAVE_MIN_AGE_MS && size >= minSize)) {
                battalion.gathering = false;
                battalion.kind = 'line';
                if (this.pool[battalion.team] === battalion) this.pool[battalion.team] = null;
                if (this.cavPool[battalion.team] === battalion) this.cavPool[battalion.team] = null;
                // 增援并入：军团已选主攻旗时，新营先去当前军团重心（集合/突击都先跟上），
                // 不单独直扑前线；并入判定在下一拍 aiAssign（距重心 ≤6 格才领主攻旗令）。
                const army = this.army[battalion.team];
                const flag = army?.target != null ? flags[army.target] : null;
                if (!battalion.playerOrdered && flag && !(flag.owner != null && sameSide(this.scene, flag.owner, battalion.team))) {
                    // 集合阶段以已领集合点的营为军团；突击阶段只以主力（旗令）为重心，
                    // 正在追赶的增援营不把重心拖回后方。
                    const mates = this.battalions.filter(b => b !== battalion && b.team === battalion.team &&
                        !b.gathering && !b.playerOrdered && b.power() > 0 &&
                        (army.phase === 'stage' ? !!b.stagePoint : b.orderFlag === army.target));
                    const center = this.armyCenter(mates);
                    if (center) {
                        const stage = army.phase === 'assault' ? center : this.stagePointFor(center, flag);
                        if (stage) { battalion.stagePoint = { gx: stage.gx, gy: stage.gy }; battalion.orderFlag = null; }
                    }
                }
            }
        }
        // 夺旗交还：目标旗已被本方占领 → 指令完成，营回归 AI（玩家令解除）
        for (const battalion of this.battalions) {
            if (battalion.orderFlag == null || !flags[battalion.orderFlag]) continue;
            if (flags[battalion.orderFlag].owner != null && sameSide(this.scene, flags[battalion.orderFlag].owner, battalion.team)) {
                battalion.orderFlag = null;
                battalion.playerOrdered = false;
                battalion.retreat = false;
            }
        }
        if (now >= this.nextThink) {
            this.nextThink = now + BATTALION.AI_INTERVAL_MS;
            this.aiAssign();
        }
    }

    // 据点特色的 AI 需求系数（在既有 2 秒战略节拍里每方算一次；不逐兵、不逐帧扫描）。
    // 全部取自 site-traits 的参数表，AI 与模拟 / UI 不各写一套数值。
    siteNeeds(team) {
        const scene = this.scene, flags = scene.flags || [], camps = scene.territory?.camps;
        const state = traitState(scene);
        const needs = {};
        // 骑兵：没有马场就是刚需（夺场开门）；只有一座时守住它就是整条骑兵线。
        const ranches = state.ownsRoleCount(team, 'ranch');
        needs.cavalry = ranches === 0 ? 1 : 0.35;
        needs.cavalryHold = ranches <= 1 ? 1 : 0.4;
        // 营建：己方据点还有营寨 / 箭塔 / 医帐没建完时，林口加速的价值更高。
        let building = 0;
        if (camps) {
            for (let i = 0; i < flags.length; i++) {
                if (!camps.ownsSite(team, i) || camps.buildings.some(b => !b.dead && b.siteId === i && !sameSide(scene, b.team, team))) continue;
                const camp = camps.getBuilding(camps.id(team, 'camp', i));
                if (!camp || camp.dead || !camp.complete) { building++; continue; }
                const tower = camps.getBuilding(camps.id(team, 'tower', i));
                if (!tower || tower.dead || !tower.complete) { building++; continue; }
                const tent = camps.getBuilding(camps.id(team, 'tent', i));
                if (!tent || tent.dead || !tent.complete) building++;
            }
        }
        needs.build = building > 0 ? 1 : 0.3;
        // 防线：桥头不在自己手里（或正在被拉锯）时更需要夺桥固守。
        let bridgeLost = 0;
        for (const flag of flags) if (flag.role === 'bridge' && (flag.owner == null || !sameSide(scene, flag.owner, team))) bridgeLost++;
        needs.defense = bridgeLost > 0 ? 1 : 0.4;
        // 驻守：有富余成建营才值得专门派人驻高地（数值在 aiAssign 里给）。
        needs.hold = 0.5;
        // 通行：没有渡口才值得为浅滩过河去抢。
        needs.crossing = state.owns(team, 'ford') ? 0.3 : 1;
        // 收容：溃兵成堆时路口的补给容量才有价值。
        let routing = 0;
        for (const unit of scene._aliveArr || []) if (unit.team === team && unit.moraleState === 'routing') routing++;
        needs.healing = routing >= 6 ? 1 : 0.35;
        return needs;
    }

    // 营级 AI：全军一个军团，按据点价值选一个主攻旗，先集合再一起压上。
    // 无随机数；遍历序 = team 序 / 营创建序 / 旗序，比较用量化打分。
    aiAssign() {
        const scene = this.scene;
        const flags = scene.flags;
        if (!flags || !flags.length) return;
        const state = traitState(scene);      // 派生归属只在归属变化时重建（见 site-traits.js）
        const now = scene.simulationTime;
        // 实力图：每旗评估半径内双方占领力（与占旗拔河同权）
        const strength = flags.map(flag => {
            const power = {};
            for (const t of TEAMS) power[t] = 0;
            scene.forEachNear(flag.gx, flag.gy, BATTALION.ASSESS_RADIUS, u => {
                if (u.dead || u.withdrawn || u.moraleState === 'routing') return;
                if (Math.hypot(u.gx - flag.gx, u.gy - flag.gy) > BATTALION.ASSESS_RADIUS) return;
                power[u.team] = (power[u.team] ?? 0) + (BATTALION_POWER[u.type] ?? 5);
            });
            return power;
        });
        for (const team of activeTeams(scene)) {
            const active = this.battalions.filter(b => b.team === team && !b.gathering && b.members.length);
            if (!active.length) continue;
            const army = this.army[team] ?? (this.army[team] = { target: null, phase: 'stage', stageSince: 0 });
            // 需求系数：每方每拍算一次；富余营多时高地驻守价值才拉满。
            const needs = this.siteNeeds(team);
            const free = active.filter(b => !b.playerOrdered && b.power() > 0);
            needs.hold = free.length >= 2 ? 1 : 0.5;
            const playerAssigned = new Array(flags.length).fill(0);
            // 玩家已指派的营占住目标位，AI 不与之争抢
            for (const b of active) if (b.playerOrdered && b.orderFlag != null) playerAssigned[b.orderFlag]++;
            // 零战力营（纯军医/纯民夫）不领旗令：占领力为 0 去夺旗永远完不成，
            // 医疗营就地待命随队急救即可（玩家令不受限）。
            for (const b of active) {
                if (b.playerOrdered) continue;
                if (b.power() <= 0) { b.orderFlag = null; b.stagePoint = null; b.retreat = false; }
            }

            // 回援留守：己方旗被明显进犯时一旗一营、取最近营；回援营不算进军团。
            // 阈值与旧版一致（theirs > max(12, mine×1.2)），除此之外不设常驻守军。
            const foes = enemiesOf(scene, team);
            const responders = new Set();
            for (let i = 0; i < flags.length; i++) {
                const flag = flags[i];
                if (flag.owner == null || !sameSide(scene, flag.owner, team)) continue;
                const mine = strength[i][team] ?? 0;
                const theirs = foes.reduce((n, f) => n + (strength[i][f] ?? 0), 0);
                if (!(theirs > Math.max(12, mine * 1.2))) continue;
                if (playerAssigned[i] > 0) continue;
                let pick = null, pickDistance = Infinity;
                for (const b of free) {
                    if (responders.has(b)) continue;
                    const center = b.center();
                    const distance = center ? quantizeDecision(Math.hypot(flag.gx - center.gx, flag.gy - center.gy)) : Infinity;
                    if (distance < pickDistance - 1e-9 || (Math.abs(distance - pickDistance) <= 1e-9 && pick && b.id < pick.id)) {
                        pickDistance = distance; pick = b;
                    }
                }
                if (pick) {
                    pick.orderFlag = i; pick.stagePoint = null; pick.retreat = false;
                    responders.add(pick);
                    playerAssigned[i]++;
                }
            }

            // 军团营 = 所有自由营 - 回援营；主攻判断用全军总战力（不是单营）。
            const pool = free.filter(b => !responders.has(b));
            const center = this.armyCenter(pool);
            const totalPower = pool.reduce((sum, b) => sum + b.power(), 0);
            if (!pool.length || !center) {
                army.target = null; army.phase = 'stage'; army.stageSince = now;
                continue;
            }
            const mineOf = i => strength[i][team] ?? 0;
            const theirsOf = i => foes.reduce((n, f) => n + (strength[i][f] ?? 0), 0);
            const owns = i => flags[i].owner != null && sameSide(scene, flags[i].owner, team);
            // 打得过：口径同旧版，把单营战力换成全军总战力。
            const winnable = i => mineOf(i) + totalPower * 0.8 >= theirsOf(i) * 0.85;

            let target = null;
            // 目标黏性：未攻下且仍打得过就不换（攻下/变为同盟后下一拍重选）。
            if (army.target != null && flags[army.target] && !owns(army.target) && winnable(army.target)) {
                target = army.target;
            } else {
                let best = -1, bestScore = -Infinity, bestTie = null;
                for (let i = 0; i < flags.length; i++) {
                    if (owns(i)) continue;
                    const mine = mineOf(i), theirs = theirsOf(i);
                    if (!winnable(i) && theirs > 0) continue;
                    const flag = flags[i];
                    // 据点特色权重（克制：基础夺旗分 50，这里只做 3~28 的加减，且按需求折算）
                    const weight = SITE_AI[flag.role];
                    const needKey = weight ? (weight.contestNeed ?? weight.need) : null;
                    const need = weight ? (needs[needKey] ?? 1) : 0;
                    // 同类据点"已经拥有一处"时降低争夺权重：全局效果不叠加（马场/渡口）。
                    const held = !!(weight && state.owns(team, flag.role));
                    const neutral = flag.owner == null;
                    let score = 50 + (neutral ? 8 : 0) + (mine - theirs) * 0.4
                        - quantizeDecision(Math.hypot(flag.gx - center.gx, flag.gy - center.gy)) * 0.35;
                    if (weight) score += (held ? weight.contestHeld : weight.contest) * need;
                    // 据点分量：只加在主攻目标打分上，分量越高越值得全军压上。
                    score += (siteWeight(flag.role) - 1) * BATTALION.ARMY_WEIGHT_BONUS;
                    const quantized = quantizeDecision(score);
                    // 量化主分相同（差 ≤1e-9）才用原始浮点几何键决胜；三键都容差内
                    // 相等时保持固定旗序。绝不能把距离/平方再量化——那会造出人为
                    // 平局区并在桶边界放大浮点噪声（见 targetTieKey 注释）。
                    const tie = this.targetTieKey(team, flag, center);
                    if (quantized > bestScore + 1e-9 ||
                        (best >= 0 && Math.abs(quantized - bestScore) <= 1e-9 &&
                            this.compareTieKeys(tie, bestTie) < 0)) {
                        bestScore = quantized; best = i; bestTie = tie;
                    }
                }
                if (best >= 0 && bestScore > 10) target = best;
            }

            if (target == null) {
                // 无仗可打：收缩到最近己方旗驻防（保持存在感，不站桩空地）
                army.target = null; army.phase = 'stage'; army.stageSince = now;
                for (const b of pool) {
                    b.orderFlag = this.nearestOwnFlag(b, flags) ?? b.orderFlag;
                    b.stagePoint = null;
                    b.retreat = false;
                }
                continue;
            }

            if (target !== army.target) {
                // 主攻目标变更：回到集合阶段，旧旗令作废。
                army.target = target;
                army.phase = 'stage';
                army.stageSince = now;
                for (const b of pool) { b.orderFlag = null; b.stagePoint = null; b.retreat = false; }
            }

            if (army.phase === 'stage') {
                // 集合点相对本方军团重心与目标旗计算（不写死红方坐标）。
                const stage = this.stagePointFor(center, flags[target]);
                for (const b of pool) {
                    b.orderFlag = null;
                    b.stagePoint = stage ? { gx: stage.gx, gy: stage.gy } : null;
                    b.retreat = false;
                }
                let total = 0, near = 0;
                for (const b of pool) {
                    total += b.power();
                    for (const u of b.aliveMembers()) {
                        if (stage && quantizeDecision(Math.hypot(u.gx - stage.gx, u.gy - stage.gy)) <= BATTALION.ARMY_STAGE_RADIUS) {
                            near += BATTALION_POWER[u.type] ?? 5;
                        }
                    }
                }
                // 集合战力比例同样量化后比较：near/total 是整数战力，但 total×0.7
                // 的浮点表示可能比 70 多/少 1e-14，量化后落在同一 0.05 档。
                const requiredNear = quantizeDecision(total * BATTALION.ARMY_ASSAULT_SHARE);
                if (stage && (now - army.stageSince >= BATTALION.ARMY_STAGE_TIMEOUT_MS ||
                    (total > 0 && quantizeDecision(near) >= requiredNear))) {
                    // 集合完成：撤集合点、全军一起压上主攻旗（突击阶段不再有 -30 分摊派扣分）。
                    army.phase = 'assault';
                    for (const b of pool) { b.stagePoint = null; b.orderFlag = target; b.retreat = false; }
                }
            } else {
                // 突击阶段：主力直取主攻旗；增援营（stagePoint 非空）先追当前军团重心，
                // 距重心 ≤ARMY_STAGE_RADIUS 后再领主攻旗令，绝不单独直扑前线。
                const bodyCenter = this.armyCenter(pool.filter(b => !b.stagePoint)) ?? center;
                for (const b of pool) {
                    const joinCenter = b.stagePoint ? b.center() : null;
                    if (joinCenter && quantizeDecision(Math.hypot(joinCenter.gx - bodyCenter.gx, joinCenter.gy - bodyCenter.gy)) <= BATTALION.ARMY_STAGE_RADIUS) {
                        b.stagePoint = null;
                        b.orderFlag = target;
                    } else if (b.stagePoint) {
                        b.stagePoint = { gx: bodyCenter.gx, gy: bodyCenter.gy };
                        b.orderFlag = null;
                    } else {
                        b.orderFlag = target;
                    }
                    b.retreat = false;
                }
            }
        }
    }

    nearestOwnFlag(battalion, flags) {
        const center = battalion.center();
        let best = null, bestDistance = Infinity;
        for (let i = 0; i < flags.length; i++) {
            if (flags[i].owner == null || !sameSide(this.scene, flags[i].owner, battalion.team)) continue;
            const d = center ? Math.hypot(flags[i].gx - center.gx, flags[i].gy - center.gy) : 0;
            if (d < bestDistance - 1e-9) { bestDistance = d; best = i; }
        }
        return best;
    }

    // 无归属守卫的下令（网络命令路径）：命令自带 side，且按 id+team 双重匹配寻营，
    // 两端各自确定性执行——"只许指挥己方"的守卫只属于 UI 路径（orderSelected）。
    orderBattalion(battalion, flagIndex) {
        if (!battalion) return false;
        if (flagIndex === 'home') {
            this.cancelCampOrders(battalion);
            battalion.orderFlag = null;
            battalion.orderPoint = null;
            battalion.stagePoint = null;  // 玩家令接管：清掉军团集合点
            battalion.playerOrdered = true;
            battalion.retreat = true;
            return true;
        }
        if (flagIndex == null || !this.scene.flags[flagIndex]) return false;
        this.cancelCampOrders(battalion);
        battalion.orderFlag = flagIndex;
        battalion.orderPoint = null;      // 旗令替换点令
        battalion.stagePoint = null;      // 旗令替换集合点
        battalion.playerOrdered = true;
        battalion.retreat = false;
        return true;
    }

    // 驻守任意点（玩家长期令）：全营开赴并驻守；AI 永不覆盖，只有玩家的新令可替换。
    orderHold(battalion, gx, gy) {
        if (!battalion || !Number.isFinite(gx) || !Number.isFinite(gy)) return false;
        this.cancelCampOrders(battalion);
        battalion.orderFlag = null;
        battalion.orderPoint = { gx, gy };
        battalion.stagePoint = null;
        battalion.playerOrdered = true;
        battalion.retreat = false;
        return true;
    }

    // 解除命令：清旗令/点令/回防，营交还 AI 调度
    orderClear(battalion) {
        if (!battalion) return false;
        this.cancelCampOrders(battalion);
        battalion.orderFlag = null;
        battalion.orderPoint = null;
        battalion.stagePoint = null;
        battalion.playerOrdered = false;
        battalion.retreat = false;
        return true;
    }

    cancelCampOrders(battalion) {
        this.scene.territory?.camps?.cancelUnitOrders(battalion.team, battalion.aliveMembers().map(u => u.id));
    }

    orderRally(team, gx, gy) {
        if (!this.scene.territory || !activeTeams(this.scene).includes(team) || !Number.isFinite(gx) || !Number.isFinite(gy) ||
            gx < 0.6 || gx > board.W - 0.6 || gy < 0.6 || gy > board.H - 0.6) return false;
        for (const b of this.battalions) if (b.team === team && b.gathering) this.cancelCampOrders(b);
        this.scene.territory.rally[team] = { gx, gy };
        return true;
    }

    // 营姿态：steady=驻守缰绳7格 | aggressive=追击缰绳14格
    orderStance(battalion, stance) {
        if (!battalion || !['steady', 'aggressive'].includes(stance)) return false;
        battalion.stance = stance;
        return true;
    }

    // 骑兵冲锋令（遗留手动路径）：6 秒自由冲锋窗口，15 秒冷却（营级，模拟时钟
    // 裁决——联机两端一致）。正常玩法已不依赖（S2 意图制自动冲锋：接敌/助跑/
    // 冲锋由营接管钩子自动交还冲锋状态机完成）；保留用途：① 网络命令 'charge'
    // 的兼容——部署切换期间对端/旧标签页仍在途的命令包不致失效；② 高级玩家的
    // 主动 override——无视 6 格交还半径强令自由出击（仍有窗口+冷却约束，不会
    // 成为无限冲锋的碾压开关）。
    orderCharge(battalion, now) {
        if (!battalion || now < (battalion.chargeReadyAt || 0)) return false;
        battalion.chargeUntil = now + 6000;
        battalion.chargeReadyAt = now + 21000;
        return true;
    }

    // 玩家指挥：选营点旗下令 / 回防集结。返回是否受理。
    orderSelected(flagIndex, scene, battalion = scene.selectedBattalion) {
        const selected = battalion;
        if (!selected || selected.team !== (scene.netMySide || 'red')) return false;
        return this.orderBattalion(selected, flagIndex);
    }
}
