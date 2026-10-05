// 领土节拍桥：旗帜争夺/经济推进/出生点占用/领土补兵，经场景单行委托调用（core.js/recruit.js/测试）。
import { board } from '../board.js';
import { TERRITORY } from './economy.js';
import { traitOf, traitState, ownsRole } from './site-traits.js';
import { TEAMS, RELATIONS_MUTUAL, groupOf, canonicalOf, sameSide, sideLabel } from '../factions.js';

export function updateFlags(scene, dt) {
    const RADIUS = 2.8, RATE = 0.1 / 10;           // 净占领力 10（约一队剑士）10 秒拉满
    const POWER = { infantry: 10, pikeman: 7, archer: 4, cavalry: 12, worker: 0, medic: 0 };
    let ownershipChanged = false;
    // 两阶段：同一次 updateFlags 里可能有多面旗同时易主（如两座渡口同一步失守）。
    // 阶段一只推进度/归属并记录变化；阶段二在【本步全部归属更新完成后】按最终
    // 归属生成播报——全局奖励（渡口/马场）的"仍保留/失效/骑源被断"若在循环内
    // 读中间状态，会对同一最终局面先说"仍保留"再说"失效"。
    const changes = [];
    const power = [];                              // 各同盟组占领力（按组索引累计，逐旗复用）
    // 同盟分组：默认「各自为战」（红蓝二元，与既有行为逐位一致）；
    // 合作模式为 [[red,blue],[black]] —— 盟友占领力合并成一路（红蓝合力翻旗）。
    const groups = scene.relationGroups || RELATIONS_MUTUAL;
    const ownerA = canonicalOf(groups[0]);
    const ownerB = groups[1] ? canonicalOf(groups[1]) : null;
    for (const flag of scene.flags) {
        for (let i = 0; i < groups.length; i++) power[i] = 0;
        scene.forEachNear(flag.gx, flag.gy, RADIUS, u => {
            if (u.dead || u.withdrawn || u.garrisonTowerId || u.type === 'worker' || u.moraleState === 'routing') return;
            if (Math.hypot(u.gx - flag.gx, u.gy - flag.gy) > RADIUS) return;
            const gi = groupOf(scene, u.team);
            if (gi >= 0 && gi < power.length) power[gi] += POWER[u.type] ?? 5;
        });
        const a = power[0] ?? 0, b = power[1] ?? 0;   // 前两组构成旗面拉锯轴（正=方向 A，负=方向 B）
        flag.contested = a > 0 && b > 0;
        const net = a - b;
        if (net !== 0) flag.progress = Math.max(-1, Math.min(1, flag.progress + net * RATE * dt));
        const had = flag.owner;
        const hadGroup = had == null ? -1 : groupOf(scene, had);
        if (flag.progress >= 1) flag.owner = ownerA;
        else if (flag.progress <= -1) flag.owner = ownerB;
        else if (hadGroup === 0 && flag.progress < 0) flag.owner = null;   // 被拉过中线：失去归属
        else if (hadGroup === 1 && flag.progress > 0) flag.owner = null;
        if (flag.owner !== had) {
            ownershipChanged = true;
            flag.pulseAt = scene.simulationTime;                            // 归属变化：扩散脉冲
            // 归属变化序数：本旗第几次真实易主（含失去/收复）。纯模拟确定性信息，
            // 作为"每次变化播报一次"的去重键成分——不用随机数或真实墙钟，
            // "失去→收复→再次失去"是三次不同序数，都能各自入账。
            flag.flipCount = (flag.flipCount || 0) + 1;
            changes.push({ flag, had });
            scene._countsDirty = true;
        }
    }
    // 据点特色派生状态只在归属变化时刷新（避免逐兵 × 全部据点的高频扫描）；
    // 必须先刷新再播报：阶段二的全局奖励判断读的是本步最终归属。
    if (ownershipChanged) traitState(scene)?.refresh();
    for (const { flag, had } of changes) {
        if (flag.owner === null && had != null) {
            // 被拉过中线丢掉据点：每次真实归属变化播报一次；
            // 持续停留在同一归属状态（键不变）时不重复刷屏。
            const who = sideLabel(scene, had);
            scene.addBattleEvent(`flag-lost-${flag.name}-${had}-${flag.flipCount}`, `${who}失去${flag.name}旗帜`, had);
            const trait = traitOf(flag.role);
            if (trait) {
                const [brief] = trait.reward.split('：');
                // 全局奖励（渡口/马场）按"本步最终是否仍拥有任一同类据点"判断失效：
                // 丢一座还有另一座时只算丢了一处，不能误报"通行/骑源失效"。
                const retained = trait.scope === 'global' && ownsRole(scene, had, flag.role);
                scene.addBattleEvent(`trait-lost-${flag.name}-${had}-${flag.flipCount}`,
                    retained ? `${who}失去${flag.name}，但仍有${trait.name}在手：${brief}仍保留`
                        : `${who}失去${flag.name}：${brief}失效`, had);
            }
        }
        // 占领播报：新归属非空即播（含中立→占领；changes 数组保证确有变化）。
        if (flag.owner != null) {
            scene.addBattleEvent(`flag-${flag.name}-${flag.owner}-${flag.flipCount}`,
                `${sideLabel(scene, flag.owner)}占领了${flag.name}旗帜`, flag.owner);
            // 马场易主即时播报：夺场开骑源 / 断敌骑源都是大新闻。
            // 但"断骑源"必须真的断（按本步最终归属）：对手仍保有其它马场时只算被夺走一座，
            // 不能断言其骑源被完全切断。
            if (flag.role === 'ranch') {
                // 断骑源判定按"本步最终归属"：对手（敌对同盟组）仍保有马场时只算被夺走一座。
                const myGroup = groupOf(scene, flag.owner);
                const foeGroup = groups.findIndex((_, i) => i !== myGroup);
                const foe = foeGroup >= 0 ? canonicalOf(groups[foeGroup]) : null;
                const foeStillRanch = foe != null && ownsRole(scene, foe, 'ranch');
                scene.addBattleEvent(`ranch-${flag.name}-${flag.owner}-${flag.flipCount}`,
                    `${sideLabel(scene, flag.owner)}掌控${flag.name}，骑兵征募开启；` +
                    (foeStillRanch ? `${sideLabel(scene, foe)}仍保有马场，骑源未断` : `${sideLabel(scene, foe)}骑源被断`), flag.owner);
            } else {
                // 其它据点特色：占领即生效，只播报一次（归属变化驱动，不逐帧重复）。
                const trait = traitOf(flag.role);
                if (trait) {
                    const [brief, ...rest] = trait.reward.split('：');
                    scene.addBattleEvent(`trait-${flag.name}-${flag.owner}-${flag.flipCount}`,
                        `${sideLabel(scene, flag.owner)}${flag.name}：${brief}生效${rest.length ? `（${rest.join('：')}）` : ''}`, flag.owner);
                }
            }
        }
    }
    for (const team of TEAMS) {
        scene.controlScore[team] += dt * scene.flags.filter(f => f.owner != null && sameSide(scene, team, f.owner)).length;
    }
}

export function updateTerritory(scene, dt) {
    scene.updateFlags(dt);
    // 归属计数对盟友共享：红蓝联军下任一盟友的据点同时计入双方（既有二元模式结果不变）。
    const owned = { red: 0, blue: 0, black: 0 };
    for (const flag of scene.flags) {
        if (!flag.owner) continue;
        for (const team of TEAMS) if (sameSide(scene, team, flag.owner)) owned[team]++;
    }
    const state = scene.territory;
    state.econ.tick(dt, owned);
    state.recruit.update();
    state.camps?.update(dt);
    state.healing?.update(dt);
    scene.battalions.update(scene.simulationTime);
    for (const team of TEAMS) {
        if (state.autoBuy[team]) state.ai[team].update(scene.simulationTime);
    }
    const before = {};
    for (const team of TEAMS) before[team] = state.tickets.tickets[team];
    state.tickets.tick(dt, owned);
    for (const team of TEAMS) {
        if (before[team] > TERRITORY.TICKETS / 2 && state.tickets.tickets[team] <= TERRITORY.TICKETS / 2) {
            scene.addBattleEvent(`tickets-half-${team}`,
                `${sideLabel(scene, team)}票数已流失过半，领土告急`, team);
        }
    }
}

export function aliveCount(scene, team, type) {
    let count = 0;
    for (const unit of scene._aliveArr) {
        if (unit.team === team && (!type || unit.type === type)) count++;
    }
    return count;
}

export function spotFree(scene, x, y) {
    let free = true;
    scene.forEachNear(x, y, 0.62, u => {
        if (!u.dead && !u.withdrawn && Math.hypot(u.gx - x, u.gy - y) < 0.62) free = false;
    });
    return free;
}

export function spawnTerritoryUnit(scene, team, type) {
    // 三方向出生：红自西、蓝自东、黑自南（合作模式）——各自家门口向场内一步。
    const cx = team === 'black' ? board.W / 2 : team === 'red' ? 5.5 : board.W - 5.5;
    const cy = team === 'black' ? board.H - 5.5 : board.H / 2;
    let gx = cx + (team === 'red' ? 1 : team === 'blue' ? -1 : 0);
    let gy = cy + (team === 'black' ? -1 : 0);
    outer:
    for (let ring = 0; ring < 8; ring++) {
        const radius = ring * 1.1;
        for (let i = 0; i < 10; i++) {
            const angle = i / 10 * Math.PI * 2 + (ring % 2) * Math.PI / 10;
            const x = Math.round((cx + Math.cos(angle) * radius) * 8) / 8;
            const y = Math.round((cy + Math.sin(angle) * radius * 0.8) * 8) / 8;
            if (x < 1.5 || x > board.W - 1.5 || y < 1.5 || y > board.H - 1.5) continue;
            if (scene.spotFree(x, y)) { gx = x; gy = y; break outer; }
        }
    }
    const unit = scene.spawnUnit(team, type, gx, gy);
    if (scene.battalions) scene.battalions.assignReinforcement(unit);
    return unit;
}
