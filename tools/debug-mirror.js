// 调试：360 金镜像局，找出第一处发散的配对单位（走 harness，保持与真实测试同环境）
const { makeScene } = require('../tests/battle-harness');

const forward = makeScene(), reversed = makeScene();
forward.deployUnits({ infantry: 72 }, { archer: 45 }, 'custom', 'custom');
reversed.deployUnits({ archer: 45 }, { infantry: 72 }, 'custom', 'custom');
forward.battleStarted = reversed.battleStarted = true;

const pairs = [];
for (const team of ['red', 'blue']) {
    const opposite = team === 'red' ? 'blue' : 'red';
    const a = forward.units.filter(u => u.team === team);
    const b = reversed.units.filter(u => u.team === opposite);
    for (let i = 0; i < a.length; i++) pairs.push([a[i], b[i], team, i]);
}

let firstDiv = null;
let prev = null;
let probeStep = parseInt(process.env.PROBE_STEP || '0', 10);
let probeLogA = [], probeLogB = [];
const A_TRACK = process.env.PROBE_A ? parseInt(process.env.PROBE_A, 10) : 0;   // unit.id
const B_TRACK = process.env.PROBE_B ? parseInt(process.env.PROBE_B, 10) : 0;

function patchProbe(scene, log, sceneTag) {
    const origNearest = scene.nearestEnemy.bind(scene);
    scene.nearestEnemy = function (u) {
        const r = origNearest(u);
        if (probeStep && Math.floor(scene.simulationTime) === probeStep) {
            log.push(`${sceneTag} nearest u=${u.id} -> ${r ? r.id + '@' + r.gx.toFixed(7) + ',' + r.gy.toFixed(7) : 'null'} d=${r ? Math.hypot(r.gx - u.gx, r.gy - u.gy).toFixed(7) : '-'}`);
        }
        return r;
    };
}
const origUpdateN = makeScene;
if (probeStep) {
    patchProbe(forward, probeLogA, 'F');
    patchProbe(reversed, probeLogB, 'R');
}

for (let step = 0; step < 12000 && !(forward.battleOver && reversed.battleOver); step++) {
    prev = pairs.map(([a, b]) => [
        [a.gx, a.gy, a.hp, a.strafeX, a.strafeY, a.strafeUntil, a.nextShift, a.randSeed],
        [b.gx, b.gy, b.hp, b.strafeX, b.strafeY, b.strafeUntil, b.nextShift, b.randSeed]
    ]);
    forward.advanceBattle(1000 / 60);
    reversed.advanceBattle(1000 / 60);
    if (probeStep && step === probeStep - 1 && probeLogA.length) {
        console.log('--- probe logs at step', step, '---');
        for (let i = 0; i < Math.max(probeLogA.length, probeLogB.length); i++) {
            const la = probeLogA[i] || '', lb = probeLogB[i] || '';
            if (la !== lb) console.log(`DIFF#${i}\n  ${la}\n  ${lb}`);
        }
        console.log('probe log lines:', probeLogA.length, probeLogB.length);
    }
    if (firstDiv) break;
    for (let p = 0; p < pairs.length; p++) {
        const [a, b, team, i] = pairs[p];
        const dx = Math.abs(a.gx + b.gx - 70), dy = Math.abs(a.gy - b.gy);
        if (dx > 1e-9 || dy > 1e-9 || a.hp !== b.hp) {
            firstDiv = { step, p, team, i, type: a.type,
                prevA: prev[p][0], prevB: prev[p][1],
                a: [a.gx, a.gy, a.hp, a.strafeX, a.strafeY, a.strafeUntil, a.nextShift, a.randSeed],
                b: [b.gx, b.gy, b.hp, b.strafeX, b.strafeY, b.strafeUntil, b.nextShift, b.randSeed] };
            console.log(`DIVERGED step=${firstDiv.step} team=${firstDiv.team} idx=${firstDiv.i} type=${firstDiv.type} aId=${a.id} bId=${b.id} field: gx?${Math.abs(firstDiv.a[0]+firstDiv.b[0]-70)>1e-9} gy?${Math.abs(firstDiv.a[1]-firstDiv.b[1])>1e-9} hp?${firstDiv.a[2]!==firstDiv.b[2]}`);
            console.log('  prevA:', JSON.stringify(firstDiv.prevA));
            console.log('  prevB:', JSON.stringify(firstDiv.prevB));
            console.log('  now A:', JSON.stringify(firstDiv.a));
            console.log('  now B:', JSON.stringify(firstDiv.b));
            break;
        }
    }
}
if (!firstDiv) console.log('NO DIVERGENCE until battle end');
console.log('forward over:', forward.battleOver, 'reversed over:', reversed.battleOver,
    'durations:', forward.simulationTime, reversed.simulationTime);
