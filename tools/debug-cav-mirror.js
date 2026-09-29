// 全单位镜像配对追踪：找最大偏差对及其随时间的演变（含传染路径）
import { makeScene } from '../tests/battle-harness.js';

const SCREEN = { pikeman: 80, archer: 15 }, CAV = { cavalry: 50 };

function runOnce(red, blue, redForm, blueForm) {
    const scene = makeScene();
    scene.deployUnits(red, blue, redForm, blueForm);
    scene.battleStarted = true;
    return scene;
}

const a = runOnce(SCREEN, CAV, 'square', 'wedge');
const b = runOnce(CAV, SCREEN, 'wedge', 'square');
// 配对：A红屏[i] ↔ B蓝屏[i]；A蓝骑[i] ↔ B红骑[i]
const pairs = [];
a.units.filter(u => u.team === 'red').forEach((u, i) => pairs.push([u, b.units.filter(x => x.team === 'blue')[i], 'S' + u.type + i]));
a.units.filter(u => u.team === 'blue').forEach((u, i) => pairs.push([u, b.units.filter(x => x.team === 'red')[i], 'C' + u.type + i]));

const STEP = 1000 / 60;
let prevMax = 0;
for (let step = 0; step < 60 * 45 && !a.battleOver && !b.battleOver; step++) {
    a.advanceBattle(STEP); b.advanceBattle(STEP);
    let worst = null, maxOff = 0;
    for (const [ua, ub] of pairs) {
        if (ua.dead || ub.dead || !ua || !ub) continue;
        const off = Math.max(Math.abs(ua.gx + ub.gx - 70), Math.abs(ua.gy - ub.gy));
        if (off > maxOff) { maxOff = off; worst = [ua, ub]; }
    }
    if (maxOff > prevMax * 2 && maxOff > 0.001 || (step % 20 === 0)) {
        console.log(`step${step} maxOff=${maxOff.toFixed(4)}`);
    }
    if (maxOff > 0.3) {
        const [ua, ub] = worst;
        console.log(`step${step} 超阈值 maxOff=${maxOff.toFixed(3)}`);
        console.log(`  A: ${ua.type}#${ua.id} (${ua.gx.toFixed(2)},${ua.gy.toFixed(2)}) state=${ua.state} tgt=${ua.target?.type}#${ua.target?.id}`);
        console.log(`  B: ${ub.type}#${ub.id} (${ub.gx.toFixed(2)},${ub.gy.toFixed(2)}) state=${ub.state} tgt=${ub.target?.type}#${ub.target?.id}`);
        process.exit(1);
    }
    prevMax = maxOff;
}
console.log('45秒内无宏观分歧');
