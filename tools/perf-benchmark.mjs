// Reproducible simulation benchmark; Phaser drawing is stubbed by the shared harness.
// JSON goes to stdout. Timing is evidence, never a pass/fail threshold.
import { performance } from 'node:perf_hooks';
import { arch, platform, cpus } from 'node:os';
import { makeScene } from '../tests/battle-harness.js';
import { ReferenceSpatialIndex, targetingStateProjection } from '../tests/targeting-reference.js';
import { battleProjection, hashProjection } from '../js/net/lockstep.js';

const args = process.argv.slice(2);
function option(name, fallback) {
    const entry = args.find(arg => arg.startsWith(`--${name}=`));
    const result = entry ? Number(entry.split('=')[1]) : fallback;
    if (!Number.isInteger(result) || result < 1) throw new Error(`Invalid --${name}`);
    return result;
}
const warmup = option('warmup', 20), steps = option('steps', 120);
const territorySteps = option('territory-steps', 30), repeats = option('repeats', 3);
const configurations = [
    ...[200, 500, 1000].map(total => ({ terrain: 'flat', total, steps })),
    ...[200, 440].map(total => ({ terrain: 'territory', total, steps: territorySteps }))
];
const hash = scene => hashProjection(targetingStateProjection(scene));
const networkHash = scene => scene.territory ? hashProjection(battleProjection(scene)) : null;
function advance(scene) {
    scene.simulationTime += 1000 / 60;
    scene.stepBattle(1 / 60);
}
function fixture({ terrain, total }, reference) {
    const scene = makeScene(), perSide = total / 2;
    if (reference) scene._spatial = new ReferenceSpatialIndex();
    const army = { infantry: perSide * 0.5, pikeman: perSide * 0.2,
        archer: perSide * 0.2, cavalry: perSide * 0.1 };
    scene.deployUnits(army, army, 'custom', 'custom', {}, {
        terrain, territory: terrain === 'territory', territoryAI: false
    });
    scene.battleStarted = true;
    return scene;
}
function sample(config, reference) {
    const scene = fixture(config, reference);
    for (let i = 0; i < warmup; i++) advance(scene);
    const warmupHash = hash(scene), warmupNetworkHash = networkHash(scene), durations = [];
    for (let i = 0; i < config.steps; i++) {
        const start = performance.now();
        advance(scene);
        durations.push(performance.now() - start);
    }
    const totalMs = durations.reduce((sum, duration) => sum + duration, 0);
    durations.sort((a, b) => a - b);
    return { meanMs: totalMs / config.steps, p95Ms: durations[Math.ceil(config.steps * 0.95) - 1],
        maxMs: durations.at(-1), warmupHash, finalHash: hash(scene), warmupNetworkHash,
        finalNetworkHash: networkHash(scene),
        initialUnits: config.total, finalAlive: scene.redAlive + scene.blueAlive };
}
function median(values) { return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]; }
const results = [];
for (const config of configurations) {
    const before = [], after = [];
    // Alternate first runner to reduce a consistent JIT/thermal-order advantage.
    for (let i = 0; i < repeats; i++) {
        if (i % 2) { after.push(sample(config, false)); before.push(sample(config, true)); }
        else { before.push(sample(config, true)); after.push(sample(config, false)); }
    }
    const sameHashes = before.every((sample, i) => sample.warmupHash === after[i].warmupHash &&
        sample.finalHash === after[i].finalHash && sample.warmupNetworkHash === after[i].warmupNetworkHash &&
        sample.finalNetworkHash === after[i].finalNetworkHash);
    const beforeMs = median(before.map(sample => sample.meanMs));
    const afterMs = median(after.map(sample => sample.meanMs));
    results.push({ ...config, warmup, repeats, sameHashes, before, after,
        medianMeanMs: { before: beforeMs, after: afterMs }, speedup: beforeMs / afterMs });
}
console.log(JSON.stringify({ kind: 'headless fixed-step simulation; excludes rendering/network',
    node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
    composition: { infantry: 0.5, pikeman: 0.2, archer: 0.2, cavalry: 0.1 },
    phase: 'opening deployment; normal army movement; no artificial target placement', results }, null, 2));
if (results.some(result => !result.sameHashes)) process.exitCode = 1;
