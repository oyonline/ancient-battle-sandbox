// 领土节拍桥：旗帜争夺/经济推进/出生点占用/领土补兵，经场景单行委托调用（core.js/recruit.js/测试）。
import { board } from '../board.js';
import { TERRITORY } from './economy.js';

export function updateFlags(scene, dt) {
    const RADIUS = 2.8, RATE = 0.1 / 10;           // 净占领力 10（约一队剑士）10 秒拉满
    const POWER = { infantry: 10, pikeman: 7, archer: 4, cavalry: 12, worker: 0 };
    for (const flag of scene.flags) {
        let red = 0, blue = 0;
        scene.forEachNear(flag.gx, flag.gy, RADIUS, u => {
            if (u.dead || u.withdrawn || u.garrisonTowerId || u.type === 'worker' || u.moraleState === 'routing') return;
            if (Math.hypot(u.gx - flag.gx, u.gy - flag.gy) > RADIUS) return;
            if (u.team === 'red') red += POWER[u.type] ?? 5; else blue += POWER[u.type] ?? 5;
        });
        flag.contested = red > 0 && blue > 0;
        const net = red - blue;                     // 正=红方向拉，负=蓝方向拉
        if (net !== 0) flag.progress = Math.max(-1, Math.min(1, flag.progress + net * RATE * dt));
        const had = flag.owner;
        if (flag.progress >= 1) flag.owner = 'red';
        else if (flag.progress <= -1) flag.owner = 'blue';
        else if (had === 'red' && flag.progress < 0) flag.owner = null;   // 被拉过中线：失去归属
        else if (had === 'blue' && flag.progress > 0) flag.owner = null;
        if (flag.owner !== had) flag.pulseAt = scene.simulationTime;       // 归属变化：扩散脉冲
        if (flag.owner !== had && flag.owner != null) {
            scene.addBattleEvent(`flag-${flag.name}-${flag.owner}-${Math.floor(scene.simulationTime)}`,
                `${flag.owner === 'red' ? '红方' : '蓝方'}占领了${flag.name}旗帜`, flag.owner);
            scene._countsDirty = true;
        }
    }
    for (const team of ['red', 'blue']) {
        scene.controlScore[team] += dt * scene.flags.filter(f => f.owner === team).length;
    }
}

export function updateTerritory(scene, dt) {
    scene.updateFlags(dt);
    const owned = { red: 0, blue: 0 };
    for (const flag of scene.flags) if (flag.owner) owned[flag.owner]++;
    const state = scene.territory;
    state.econ.tick(dt, owned);
    state.recruit.update();
    state.camps?.update(dt);
    scene.battalions.update(scene.simulationTime);
    for (const team of ['red', 'blue']) {
        if (state.autoBuy[team]) state.ai[team].update(scene.simulationTime);
    }
    const before = { red: state.tickets.tickets.red, blue: state.tickets.tickets.blue };
    state.tickets.tick(dt, owned);
    for (const team of ['red', 'blue']) {
        if (before[team] > TERRITORY.TICKETS / 2 && state.tickets.tickets[team] <= TERRITORY.TICKETS / 2) {
            scene.addBattleEvent(`tickets-half-${team}`,
                `${team === 'red' ? '红方' : '蓝方'}票数已流失过半，领土告急`, team);
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
    const cx = team === 'red' ? 5.5 : board.W - 5.5;
    const cy = board.H / 2;
    let gx = cx + (team === 'red' ? 1 : -1), gy = cy;
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
