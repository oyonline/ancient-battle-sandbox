// ==================== QA 平衡对照场景 runner（2026-10-03 Q1 专用） ====================
// 用法：node tools/qa-balance-run.mjs [--set=equal-cost|equal-count|cap|protection|runup|territory|all]
// 同一份脚本在两棵树各跑一遍（当前工作树 / 基线 a0dfc8e 导出树），输出 JSON Lines。
// 口径：同军费（equal-cost）/ 同人数（equal-count）/ 单位上限（cap）。
// 每场记录：胜负、存活、剩余血量价值（Σ cost×hp/maxHp）、模拟时长、墙钟耗时。
import { performance } from 'node:perf_hooks';
import { makeScene } from '../tests/battle-harness.js';
import { UNIT_TYPES } from '../js/units.js';
import { TERRITORY } from '../js/battle/economy.js';

const STEP = 1000 / 60;
const filter = (process.argv.find(a => a.startsWith('--set=')) || '--set=all').split('=')[1];

function runOnce(label, red, blue, redF = 'custom', blueF = 'custom', options = {}, tweaks = null) {
    const scene = makeScene();
    scene.deployUnits(red, blue, redF, blueF, options.orders || {}, options);
    if (tweaks) tweaks(scene);
    scene.battleStarted = true;
    const cap = (options.seconds ?? 240) * 60;
    const t0 = performance.now();
    let maxRunUp = 0;   // F9 真探针：逐步峰值助跑（受控组断言 ===0 的依据）
    for (let i = 0; i < cap && !scene.battleOver; i++) {
        scene.advanceBattle(STEP);
        for (const u of scene.units) if (!u.dead && !u.withdrawn && u.type === 'cavalry' && (u.chargeDistance || 0) > maxRunUp) maxRunUp = u.chargeDistance;
    }
    const wallMs = performance.now() - t0;
    const rep = scene.getBattleReport();
    const val = team => Math.round(scene.units
        .filter(u => !u.dead && !u.withdrawn && u.team === team)
        .reduce((s, u) => s + u.typeData.cost * u.hp / u.maxHp, 0));
    return {
        label, winner: scene.winner || 'timeout',
        seconds: +(rep.durationMs / 1000).toFixed(1), wallMs: Math.round(wallMs),
        survivors: { red: rep.red, blue: rep.blue },
        value: { red: val('red'), blue: val('blue') },
        maxRunUp: +maxRunUp.toFixed(3),
        armies: { red, blue }, formations: { red: redF, blue: blueF },
    };
}

function pair(label, red, blue, redF, blueF, options, tweaks) {
    // 换座：地图不动，只交换军队与阵型（与 tools/balance-report.js runPair 同口径）
    const fwd = runOnce(label + '|F', red, blue, redF, blueF, options, tweaks);
    const swapTweaks = tweaks ? s => tweaks(s) : null;   // 位置 tweak 按蓝方处理，换座后仍对东侧军队生效
    const rev = runOnce(label + '|R', blue, red, blueF, redF, options, swapTweaks);
    return [fwd, rev];
}

const rows = [];
function emit(r) { rows.push(r); console.log(JSON.stringify(r)); }

// ---------- 1) 同军费口径：240 / 600，骑 vs 剑/枪/裸弓，双座 ----------
if (['all', 'equal-cost'].includes(filter)) {
    for (const budget of [240, 600]) {
        const cav = { cavalry: budget / UNIT_TYPES.cavalry.cost };
        for (const foe of ['infantry', 'pikeman', 'archer']) {
            const foeArmy = { [foe]: budget / UNIT_TYPES[foe].cost };
            pair(`equal-cost-${budget}:cav${budget / 12}-vs-${foe}${budget / UNIT_TYPES[foe].cost}`, cav, foeArmy)
                .forEach(emit);
        }
    }
}

// ---------- 2) 同人数口径：50 v 50（军费自然不同，如实记录） ----------
if (['all', 'equal-count'].includes(filter)) {
    const N = 50;
    for (const foe of ['infantry', 'pikeman', 'archer']) {
        pair(`equal-count-50:cav50-vs-${foe}50`, { cavalry: N }, { [foe]: N })
            .forEach(emit);
    }
}

// ---------- 3) 单位上限口径：骑兵上限150 vs 各兵种上限 ----------
if (['all', 'cap'].includes(filter)) {
    for (const foe of ['infantry', 'pikeman', 'archer']) {
        const n = UNIT_TYPES[foe].maxCount;
        pair(`unit-cap:cav150-vs-${foe}${n}`, { cavalry: UNIT_TYPES.cavalry.maxCount }, { [foe]: n })
            .forEach(emit);
    }
}

// ---------- 4) 枪保弓混编：square 枪盾 vs wedge 骑墙（600 军费）+ 前排换座（裸弓对照） ----------
if (['all', 'protection'].includes(filter)) {
    pair('pike-screen:square-vs-wedge', { pikeman: 80, archer: 15 }, { cavalry: 50 }, 'square', 'wedge')
        .forEach(emit);
    // 前排换座（与 tests/combat-balance.test.js protectionBattle 同法）：同一支军队，
    // 仅交换前排兵种——枪前排=受保护，弓前排=裸露。记录存活/首发时间。
    for (const front of ['pikeman', 'archer']) {
        for (const mirror of [false, true]) {
            const scene = makeScene();
            const screen = { pikeman: 80, archer: 15 }, cavalry = { cavalry: 50 };
            scene.deployUnits(mirror ? cavalry : screen, mirror ? screen : cavalry,
                mirror ? 'wedge' : 'square', mirror ? 'square' : 'wedge');
            const team = mirror ? 'blue' : 'red';
            const units = scene.units.filter(u => u.team === team);
            const slots = units.map(({ gx, gy }) => ({ gx, gy }));
            units.sort((a, b) => Number(b.type === front) - Number(a.type === front) || a.id - b.id);
            units.forEach((u, i) => Object.assign(u, slots[i], { pgx: slots[i].gx, pgy: slots[i].gy }));
            let firstHit = Infinity;
            const rec = scene.recordDamage.bind(scene);
            scene.recordDamage = (target, damage, from) => {
                if (target.type === 'archer' && from?.type === 'cavalry') firstHit = Math.min(firstHit, scene.simulationTime);
                rec(target, damage, from);
            };
            scene.battleStarted = true;
            const t0 = performance.now();
            for (let i = 0; i < 14400 && !scene.battleOver; i++) scene.advanceBattle(STEP);
            const rep = scene.getBattleReport();
            emit({
                label: `front-swap:${front}${mirror ? '|R' : '|F'}`, winner: scene.winner || 'timeout',
                seconds: +(rep.durationMs / 1000).toFixed(1), wallMs: Math.round(performance.now() - t0),
                survivors: { red: rep.red, blue: rep.blue },
                value: { red: 'n/a', blue: 'n/a' }, front, seatTeam: team,
                alive: rep.teams[team].alive, firstHitSec: +(firstHit / 1000).toFixed(1),
                armies: { red: mirror ? cavalry : screen, blue: mirror ? screen : cavalry },
            });
        }
    }
}

// ---------- 5) 开局距离对照（R2 修订：原"无助跑"命名不实——近身开局仍会发生多轮
// 冲锋，只是助跑距离短、首撞动量小。本组改名"近身开局"，另加真禁冲锋受控组：
// 运行时把 beginCharge 重定向到 enterMelee（骑兵永不进入冲锋状态机——无助跑、
// 无首撞倍率、无穿透），仅测试代码，不改产品参数）----------
if (['all', 'runup'].includes(filter)) {
    const near = scene => {   // 东侧军队前压到 x≈18.5：与西面前锋约 2.5 格的开局距离
        const blues = scene.units.filter(u => u.team === 'blue');
        const minX = Math.min(...blues.map(u => u.gx));
        blues.forEach(u => { u.gx = 18.5 + (u.gx - minX); u.pgx = u.gx; });
        scene.rebuildSpatial?.();
    };
    const noCharge = scene => {   // 受控组：禁用冲锋（纯近战骑兵）。
        // 单位出生即 state:'charge'（平地战不走 beginCharge），故拦截 charge 状态本身：
        // 一进入冲锋态立即转 melee，助跑/首撞倍率/穿透全部不发生。
        scene.cavalryAI.charge = (unit, now, dt) => { scene.cavalryAI.enterMelee(unit); return true; };
        scene.cavalryAI.beginCharge = unit => { scene.cavalryAI.enterMelee(unit); };
    };
    pair('open-far 远距开局(充分助跑):cav20-vs-archer30', { cavalry: 20 }, { archer: 30 }).forEach(emit);
    pair('open-near 近身开局(短助跑多轮冲锋):cav20-vs-archer30', { cavalry: 20 }, { archer: 30 }, 'custom', 'custom', {}, near).forEach(emit);
    for (const seat of ['F', 'R']) {
        const r = runOnce(`no-charge 禁冲锋受控(纯近战)|${seat}`, seat === 'F' ? { cavalry: 20 } : { archer: 30 },
            seat === 'F' ? { archer: 30 } : { cavalry: 20 }, 'custom', 'custom', {}, noCharge);
        // F9 断言：受控组全场景峰值助跑必须严格为 0（真探针实测，非机制论证）
        if (r.maxRunUp !== 0) {
            console.error(`[no-charge 受控组断言失败] ${r.label} maxRunUp=${r.maxRunUp}（应为 0）`);
            process.exitCode = 1;
        }
        emit(r);
    }
}

// ---------- 6) 真实领土地图：开局常备军对冲（territoryAI 双方真 AI） ----------
if (['all', 'territory'].includes(filter)) {
    const t0 = performance.now();
    const scene = makeScene();
    scene.deployUnits({ ...TERRITORY.OPENING }, { ...TERRITORY.OPENING }, 'custom', 'custom', {},
        { territory: true, territoryAI: true, terrain: 'territory' });
    scene.battleStarted = true;
    for (let i = 0; i < 600 * 60 && !scene.battleOver; i++) scene.advanceBattle(STEP);
    const rep = scene.getBattleReport();
    const val = team => Math.round(scene.units
        .filter(u => !u.dead && !u.withdrawn && u.team === team)
        .reduce((s, u) => s + u.typeData.cost * u.hp / u.maxHp, 0));
    emit({
        label: 'territory-opening-clash', winner: scene.winner || 'timeout',
        seconds: +(rep.durationMs / 1000).toFixed(1), wallMs: Math.round(performance.now() - t0),
        survivors: { red: rep.red, blue: rep.blue },
        value: { red: val('red'), blue: val('blue') },
        armies: { red: { ...TERRITORY.OPENING }, blue: { ...TERRITORY.OPENING } },
    });
}

console.log(JSON.stringify({ summary: { scenarios: rows.length } }));
