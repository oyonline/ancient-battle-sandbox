// ==================== 胜负结算（纯模拟判定；表现经场景钩子） ====================
// 从 game.js IsoBattleScene 抽出（第 0 批后续拆分：checkWin）。
// 汇总歼灭/溃散/相持/占点积分/领土票数/护送送达等口径判定终局；
// 领土模式下经济未枯竭不算败（增援随时抵达）。表现经 scene 钩子
// （addBattleEvent / showVictory）与全局 UI.onBattleEnd。
import { UI } from '../ui.js';
import { RELATIONS_COOP } from '../factions.js';

// 合作模式判定：红蓝联军（两名真人）对黑方 AI，采用纯歼灭制——
// 胜利 = 黑方 0 可战存活且不可重建 且 黑方所有建筑（大本营/营寨/箭塔/医帐）尽毁；
// 失败 = 红蓝两家都被打光。票数不参与胜负（用户口径：杀光 + 拔寨才算赢）。
export function isCoopBattle(scene) {
    return scene?.relationGroups === RELATIONS_COOP
        || (Array.isArray(scene?.activeTeams) && scene.activeTeams.includes('black'));
}

function checkCoopWin(scene) {
    if (!scene.battleOptions.territory || !scene.territory) return false;
    const teams = scene.activeTeams ?? ['red', 'blue', 'black'];
    const ready = {};
    for (const team of teams) ready[team] = 0;
    for (const unit of scene.units) {
        if (unit.dead || unit.withdrawn || unit.moraleState === 'routing') continue;
        if (Object.hasOwn(ready, unit.team)) ready[unit.team]++;
    }
    const canRebuild = team => scene.territory.recruit.queues[team].length > 0 ||
        scene.territory.econ.treasury[team] >= scene.territory.econ.costOf('infantry');
    const defeated = {};
    for (const team of teams) {
        const alive = scene.aliveByTeam?.[team] ?? 0;
        if (alive > 0 && !ready[team]) {
            if (scene.collapseSince[team] == null) scene.collapseSince[team] = scene.simulationTime;
        } else scene.collapseSince[team] = null;
        defeated[team] = !canRebuild(team) && (!alive || (scene.collapseSince[team] != null &&
            scene.simulationTime - scene.collapseSince[team] >= 5000 - 1e-7));
    }
    const blackUnitsGone = defeated.black === true;
    const blackBuildings = scene.territory.camps ? scene.territory.camps.buildings.filter(b => b.team === 'black') : [];
    const blackBuildingsGone = blackBuildings.every(b => b.dead);
    const alliesWiped = defeated.red === true && defeated.blue === true;
    if (!(blackUnitsGone && blackBuildingsGone) && !alliesWiped) return false;
    // 已发出的箭继续落地：与主流程一致，等箭雨结算完再判终局。
    if (scene.arrows.length > 0) {
        scene.resolvingOutcome = true;
        scene.battleQueue = [];
        return true;
    }
    scene.battleOver = true;
    scene.battleQueue = [];
    const allyWin = blackUnitsGone && blackBuildingsGone;
    const winner = allyWin ? 'red' : 'black';
    scene.endReason = allyWin ? 'coop-win' : 'coop-loss';
    scene.addBattleEvent(allyWin ? 'coop-win' : 'coop-loss',
        allyWin ? '黑方全军覆没、营寨尽毁，红蓝联军得胜' : '红蓝联军全线崩溃，黑方获胜',
        allyWin ? 'red' : 'black');
    scene.showVictory(winner);
    UI.onBattleEnd(winner, scene.getBattleReport());
    return true;
}

export function checkWin(scene) {

        if (scene.battleOver) return;
        // 合作模式完全由纯歼灭判定接管：未分胜负时不得回落到二元残局逻辑
        //（否则红方单独被打光会被误判为黑方获胜）。
        if (isCoopBattle(scene)) { checkCoopWin(scene); return; }
        const red = scene.redAlive, blue = scene.blueAlive;
        const ready = { red: 0, blue: 0 };
        for (const unit of scene.units) {
            if (!unit.dead && !unit.withdrawn && unit.moraleState !== 'routing') ready[unit.team]++;
        }
        const defeated = {};
        for (const team of ['red', 'blue']) {
            const alive = team === 'red' ? red : blue;
            // 领土征服：钱还能买兵或队列里还有人时， momentarily 全灭不算败——
            // 增援随时抵达，歼灭判定必须等经济枯竭（英雄连式"还能打"语义）。
            const canRebuild = scene.battleOptions.territory && scene.territory &&
                (scene.territory.recruit.queues[team].length > 0 ||
                    scene.territory.econ.treasury[team] >= scene.territory.econ.costOf('infantry'));
            if (!scene.battleOptions.deathmatch && alive > 0 && !ready[team]) {
                if (scene.collapseSince[team] == null) scene.collapseSince[team] = scene.simulationTime;
            } else scene.collapseSince[team] = null;
            defeated[team] = !canRebuild && (!alive || (scene.collapseSince[team] != null &&
                scene.simulationTime - scene.collapseSince[team] >= 5000 - 1e-7));
        }
        const standingOff = !defeated.red && !defeated.blue && scene.tactics?.isStalemate();
        if (standingOff && scene.battleOptions.deathmatch) scene.tactics.breakStalemate();
        const stalemate = standingOff && !scene.battleOptions.deathmatch;
        const controlWon = scene.battleOptions.control
            ? ['red', 'blue'].find(team => scene.controlScore[team] >= 60) : null;
        const ticketsWon = scene.battleOptions.territory ? scene.territory.tickets.winner() : null;
        const campWon = scene.battleOptions.territory ? scene.territory.camps?.winner() : null;
        const convoyWon = scene.battleOptions.convoy ? scene.convoyOutcome() : null;
        // 护送模式下劫掠方已全灭但车队还在路上：胜利只是时间问题，
        // 压下歼灭结算等车队进站（上限 40 秒），让"护送成功"的叙事走完
        if (!controlWon && !convoyWon && scene.battleOptions.convoy && defeated.blue && !defeated.red) {
            const c = scene.convoy;
            const pending = c.wagons.filter(w => !w.dead && !w.withdrawn).length;
            if (pending + c.delivered >= c.need && scene.simulationTime - (c.lastFoeAt ?? scene.simulationTime) < 40000) return;
        }
        if (!campWon && !ticketsWon && !controlWon && !convoyWon && !defeated.red && !defeated.blue && !stalemate) return;
        // 已发出的箭继续落地：最后一名射手阵亡后仍可能双方同归于尽。
        if (!campWon && !ticketsWon && !controlWon && !convoyWon && scene.arrows.length > 0) {
            // 只等待已经离弦的箭；停止生成新攻击，避免密集箭雨无限延后溃败结算。
            scene.resolvingOutcome = true;
            scene.battleQueue = [];
            return;
        }
        scene.battleOver = true;
        scene.battleQueue = [];
        const winner = campWon || ticketsWon || controlWon || convoyWon || (stalemate || (defeated.red && defeated.blue) ? 'draw' : defeated.red ? 'blue' : 'red');
        scene.endReason = campWon ? 'camp' : ticketsWon ? 'tickets' : controlWon ? 'control' : convoyWon ? 'convoy' : stalemate ? 'stalemate' : winner === 'draw' ? 'draw' :
            (defeated.red && red > 0) || (defeated.blue && blue > 0) ? 'rout' : 'elimination';
        if (scene.endReason === 'tickets') {
            const loser = winner === 'red' ? 'blue' : 'red';
            scene.addBattleEvent(`tickets-${winner}`,
                `${winner === 'red' ? '红方' : '蓝方'}掌控多数领土，${loser === 'red' ? '红方' : '蓝方'}票数耗尽，领土征服获胜`, loser);
        }
        if (scene.endReason === 'camp') scene.addBattleEvent(`camp-win-${winner}`,
            winner === 'draw' ? '双方大本营同时被摧毁' : `${winner === 'red' ? '红方' : '蓝方'}攻破敌方大本营，夺得胜利`, winner === 'draw' ? null : winner);
        if (scene.endReason === 'rout') {
            const loser = winner === 'red' ? 'blue' : 'red';
            scene.addBattleEvent(`collapse-${loser}`, `${loser === 'red' ? '红方' : '蓝方'}全军持续溃散，失去战斗意愿`, loser);
        }
        if (scene.endReason === 'control') {
            const loser = winner === 'red' ? 'blue' : 'red';
            scene.addBattleEvent(`control-${winner}`, `${winner === 'red' ? '红方' : '蓝方'}掌控旗帜积分获胜`, loser);
        }
        if (scene.endReason === 'convoy') {
            const escortWon = winner === scene.convoy.team;
            scene.addBattleEvent(`convoy-${winner}`,
                escortWon ? '红方辎重车队突破封锁，护送获胜' : '蓝方劫掠得手，辎重车队尽数被劫', escortWon ? 'red' : 'blue');
        }
        if (stalemate) scene.addBattleEvent('tactic-stalemate', '双方持续固守，未再接战，本局相持结束', null);
        scene.showVictory(winner);
        UI.onBattleEnd(winner, scene.getBattleReport());
    }
