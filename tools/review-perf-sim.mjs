// Review 定点修复的性能 A/B 基准（模拟层）：同一脚本原样运行于
//   A = 修复前工作树（abs-review-baseline/A）
//   B = 修复后工作树（当前仓库）
// 场景覆盖评审要求：持续交战 + 施工 + 驻塔 + 自动征兵（territoryAI 全开）。
// 输出 JSON（stdout）：逐步耗时统计与实际兵力；耗时不设阈值，只作证据。
// 用法：node tools/review-perf-sim.mjs [--seconds=30] [--warmup=5]
import { performance } from 'node:perf_hooks';
import { arch, platform, cpus } from 'node:os';
import { makeScene } from '../tests/battle-harness.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const entry = args.find(a => a.startsWith(`--${name}=`));
    const value = entry ? Number(entry.split('=')[1]) : fallback;
    if (!Number.isFinite(value) || value < 1) throw new Error(`Invalid --${name}`);
    return value;
};
const seconds = option('seconds', 30), warmup = option('warmup', 5);
const STEP = 1000 / 60;

// 领土全面战争：双方 AI 自动征兵 + 自动建设（营寨→箭塔→医帐）+ 自动驻塔，
// 中央预置两军相向而遇形成持续交战。兵种构成与部署完全对称。
const scene = makeScene();
const opening = { infantry: 40, pikeman: 16, archer: 16, cavalry: 8, worker: 4 };
scene.deployUnits(opening, opening, 'custom', 'custom', {},
    { territory: true, terrain: 'territory', territoryAI: true });
scene.battleStarted = true;
scene.territory.econ.treasury.red = scene.territory.econ.treasury.blue = 4000;
scene.territory.autoBuy = { red: true, blue: true };
// 中央持续交战：在中央高地两侧各放一军自由单位（无营队 → 就近争旗接敌），
// 测量期间每秒各补 1 名步兵（固定节奏，两端同构），战线不会中途熄火。
const hill = scene.flags.find(f => f.role === 'hill');
for (let i = 0; i < 60; i++) {
    const column = i % 10, row = Math.floor(i / 10);
    scene.spawnUnit('red', ['infantry', 'pikeman', 'archer', 'cavalry'][i % 4],
        hill.gx - 4 - column * 0.8, hill.gy - 3 + row * 1.1);
    scene.spawnUnit('blue', ['infantry', 'pikeman', 'archer', 'cavalry'][i % 4],
        hill.gx + 4 + column * 0.8, hill.gy - 3 + row * 1.1);
}
scene.rebuildSpatial();
let trickleStep = 0;

function advance() {
    scene.simulationTime += STEP;
    scene.stepBattle(STEP / 1000);
    // 每秒向中央战线各补 1 名步兵（自由单位）：交战持续整个测量窗口。
    if (++trickleStep % 60 === 0) {
        scene.spawnUnit('red', 'infantry', hill.gx - 5, hill.gy - 2 + (trickleStep / 60) % 5);
        scene.spawnUnit('blue', 'infantry', hill.gx + 5, hill.gy - 2 + (trickleStep / 60) % 5);
        scene.rebuildSpatial();
    }
}
const unitCount = () => scene.units.filter(u => !u.dead && !u.withdrawn).length;
// 交战证据：带伤单位数 + 台账累计伤害（两侧合计）。
const combatProof = () => ({
    wounded: scene.units.filter(u => !u.dead && !u.withdrawn && u.hp < u.maxHp - 1e-9).length,
    damage: Math.round(scene.battleStats.red.damage + scene.battleStats.blue.damage),
    firstContactMs: scene.firstContactMs
});
const buildingStats = () => {
    const camps = scene.territory.camps;
    const live = camps.buildings.filter(b => !b.dead);
    return { buildings: live.length, underConstruction: live.filter(b => !b.complete).length,
        garrisoned: live.reduce((n, b) => n + b.garrisonIds.length, 0) };
};

for (let i = 0; i < Math.round(warmup * 60); i++) advance();   // 预热：行军接敌、开工、征兵启动
const warm = { units: unitCount(), ...combatProof(), ...buildingStats(),
    treasury: Math.round(scene.territory.econ.treasury.red + scene.territory.econ.treasury.blue) };
const durations = [];
for (let i = 0; i < Math.round(seconds * 60); i++) {
    const start = performance.now();
    advance();
    durations.push(performance.now() - start);
}
const total = durations.reduce((n, d) => n + d, 0);
durations.sort((a, b) => a - b);
const quantile = p => durations[Math.min(durations.length - 1, Math.ceil(durations.length * p) - 1)];
console.log(JSON.stringify({
    kind: 'review A/B simulation benchmark: sustained combat + construction + garrison + auto-recruit',
    seconds, warmupSeconds: warmup, steps: durations.length,
    node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
    scenario: { mode: 'territory 260x180', opening, autoBuy: true },
    warm, final: { units: unitCount(), ...buildingStats(),
        treasury: Math.round(scene.territory.econ.treasury.red + scene.territory.econ.treasury.blue),
        dead: scene.units.filter(u => u.dead).length },
    simStepMs: { mean: total / durations.length, p50: quantile(0.5), p95: quantile(0.95),
        p99: quantile(0.99), max: durations.at(-1) }
}, null, 2));
