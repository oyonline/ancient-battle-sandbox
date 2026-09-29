// ==================== 护送模式：劫持拔河与胜负口径（纯模拟） ====================
// 从 game.js IsoBattleScene 抽出（第 0 批后续拆分：convoy）。
// 车 3 格内只有劫掠方时拉劫持进度，护卫在场冻结/夺回；车不可被攻击。
// 铁律：不 import Phaser；表现经 scene 钩子（addBattleEvent）。

export function updateConvoy(scene, dt) {
        const c = scene.convoy;
        if (scene.blueAlive > 0) c.lastFoeAt = scene.simulationTime;   // 敌人存活时刻：全灭后等车队进站的窗口计时
        // 劫持拔河：车 3 格内只有劫掠方(蓝)时拉劫持进度，拉满车被劫走；
        // 护卫(红)在场则冻结，独占时较快夺回，双方都不在缓慢回落。
        // 圈 3.0 > 护卫集结偏移 2.6：站桩护航的护卫明确算"在场冻结"，
        // 不靠参数巧合维持语义；拉/夺速度均按圈内部队数 sqrt 缩放（封顶 ×2），
        // 兵力投入换占领速度。车不可被攻击——得分手段是"占住车身"，不是"砍烂木头"。
        for (const wagon of c.wagons) {
            if (wagon.withdrawn || wagon.dead) continue;
            if (wagon.gx >= c.goalX) {
                wagon.withdrawn = true;
                c.delivered++;
                scene.addBattleEvent(`convoy-delivered-${c.delivered}`,
                    `红方辎重车送抵安全区（${c.delivered}/${c.need}）`, 'red');
                scene._countsDirty = true;
                continue;
            }
            let reds = 0, blues = 0;
            scene.forEachNear(wagon.gx, wagon.gy, 3, u => {
                if (u === wagon || u.type === 'wagon' || u.dead || u.withdrawn || u.moraleState === 'routing') return;
                if (Math.hypot(u.gx - wagon.gx, u.gy - wagon.gy) > 3) return;
                if (u.team === wagon.team) reds++; else blues++;
            });
            const HIJACK_SECONDS = 6;
            const pull = Math.min(2, Math.sqrt(blues));
            const push = Math.min(2, Math.sqrt(reds));
            if (blues > 0 && reds === 0) wagon.hijack = Math.min(1, (wagon.hijack || 0) + dt * pull / HIJACK_SECONDS);
            else if (reds > 0 && blues === 0) wagon.hijack = Math.max(0, (wagon.hijack || 0) - dt * push / (HIJACK_SECONDS * 0.45));
            else if (reds === 0 && blues === 0) wagon.hijack = Math.max(0, (wagon.hijack || 0) - dt / 12);
            if (wagon.hijack >= 1) {
                wagon.withdrawn = true;
                wagon.hijacked = true;
                c.hijacked = (c.hijacked || 0) + 1;
                scene.addBattleEvent(`convoy-hijacked-${c.hijacked}`,
                    `蓝方劫走一辆辎重车（${c.hijacked}/${c.need}）`, 'blue');
                scene._countsDirty = true;
            }
        }
    }

    // 护送胜负：送抵/劫走达标即胜；全部结算完（无在途车）按多者胜，2:2 交回常规判定
export function convoyOutcome(scene) {
        const c = scene.convoy;
        if (c.delivered >= c.need) return c.team;
        if ((c.hijacked || 0) >= c.need) return 'blue';
        const pending = c.wagons.filter(w => !w.dead && !w.withdrawn).length;
        const stolen = c.hijacked || 0;
        if (pending === 0 && c.delivered !== stolen) return c.delivered > stolen ? c.team : 'blue';
        return null;
    }
