// 高精度找首发分歧帧：逐帧全对比较，报告首个 >1e-12 的偏差对及其前后帧状态
const { makeScene } = require('../tests/battle-harness.js');

const SCREEN = { pikeman: 80, archer: 15 }, CAV = { cavalry: 50 };

function runOnce(red, blue, redForm, blueForm) {
    const scene = makeScene();
    scene.deployUnits(red, blue, redForm, blueForm);
    scene.battleStarted = true;
    return scene;
}

const a = runOnce(SCREEN, CAV, 'square', 'wedge');
const b = runOnce(CAV, SCREEN, 'wedge', 'square');

const pairs = [];
a.units.filter(u => u.team === 'red').forEach((u, i) => pairs.push([u, b.units.filter(x => x.team === 'blue')[i], 'S' + u.type[0] + i]));
a.units.filter(u => u.team === 'blue').forEach((u, i) => pairs.push([u, b.units.filter(x => x.team === 'red')[i], 'C' + i]));

const dump = (tag, u) => `${u.type}#${u.id}(${u.gx.toFixed(6)},${u.gy.toFixed(6)}) st=${u.state} mv=${u.moving?1:0} sign=${u.detourSign ?? '-'} tgt=${u.target ? u.target.type + '#' + u.target.id : '-'}`;

const STEP = 1000 / 60;
let lastDiverged = null;
for (let step = 0; step < 60 * 10; step++) {
    // 帧前位置快照
    const pre = pairs.map(([ua, ub]) => [ua.gx, ua.gy, ub.gx, ub.gy]);
    a.advanceBattle(STEP); b.advanceBattle(STEP);
    let first = null, maxOff = 0;
    for (let i = 0; i < pairs.length; i++) {
        const [ua, ub] = pairs[i];
        if (ua.dead || ub.dead) continue;
        const off = Math.max(Math.abs(ua.gx + ub.gx - 70), Math.abs(ua.gy - ub.gy));
        if (off > maxOff) { maxOff = off; first = i; }
    }
    if (maxOff > 1e-12) {
        const [ua, ub] = pairs[first];
        console.log(`step${step} 首发偏差 ${maxOff.toExponential(3)} 对=${pairs[first][2]}`);
        console.log(`  A: ${dump('A', ua)}`);
        console.log(`  B: ${dump('B', ub)}`);
        console.log(`  帧前 A(${pre[first][0].toFixed(6)},${pre[first][1].toFixed(6)}) B(${pre[first][2].toFixed(6)},${pre[first][3].toFixed(6)})`);
        // 该对单位帧前是否有绕行/状态差异
        process.exit(0);
    }
}
console.log('10秒内无 >1e-12 偏差');
