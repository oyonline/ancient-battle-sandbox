// 座位交换不变量差分：runPair 两次对战逐帧比对镜像量，找第一处发散。
import { makeScene, UNIT_TYPES } from '../tests/battle-harness.js';

const SCREEN = { pikeman: 80, archer: 15 }, CAV = { cavalry: 50 };

function runOnce(red, blue, redForm, blueForm) {
    const scene = makeScene();
    scene.deployUnits(red, blue, redForm, blueForm);
    scene.battleStarted = true;
    return scene;
}

const a = runOnce(SCREEN, CAV, 'square', 'wedge');       // 前向：红=矛墙
const b = runOnce(CAV, SCREEN, 'wedge', 'square');        // 换座：蓝=矛墙
const aPikes = a.units.filter(u => u.team === 'red');
const bPikes = b.units.filter(u => u.team === 'blue');
console.log(`红/蓝单位配对 ${aPikes.length} vs ${bPikes.length}`);

const STEP = 1000 / 60;
for (let step = 0; step < 60 * 30 && !a.battleOver && !b.battleOver; step++) {
    a.advanceBattle(STEP); b.advanceBattle(STEP);
    for (let i = 0; i < Math.min(aPikes.length, bPikes.length); i++) {
        const pa = aPikes[i], pb = bPikes[i];
        if (pa.dead !== pb.dead) { console.log(`step${step} pike${i} 存活发散 ${pa.dead}/${pb.dead}`); process.exit(0); }
        const mx = pa.gx + pb.gx, my = pa.gy - pb.gy;
        if (Math.abs(mx - 70) > 1e-12 || Math.abs(my) > 1e-12) {
            console.log(`step${step} pike${i} 位置发散: mx=${mx.toFixed(9)} my=${my.toFixed(9)} ` +
                `A(${pa.gx.toFixed(4)},${pa.gy.toFixed(4)}) B(${pb.gx.toFixed(4)},${pb.gy.toFixed(4)})`);
            console.log(`  A: moving=${pa.moving} braceReady=${pa.braceReady} braceHold=${pa.braceHold} braceT=${pa.braceTime.toFixed(3)} support=${pa.braceSupport} facing=(${pa.braceFacingX.toFixed(3)},${pa.braceFacingY.toFixed(3)})`);
            console.log(`  B: moving=${pb.moving} braceReady=${pb.braceReady} braceHold=${pb.braceHold} braceT=${pb.braceTime.toFixed(3)} support=${pb.braceSupport} facing=(${pb.braceFacingX.toFixed(3)},${pb.braceFacingY.toFixed(3)})`);
            console.log(`  A vel=(${pa.velX.toFixed(3)},${pa.velY.toFixed(3)}) B vel=(${pb.velX.toFixed(3)},${pb.velY.toFixed(3)})`);
            process.exit(0);
        }
    }
}
console.log('30秒内未发散');
