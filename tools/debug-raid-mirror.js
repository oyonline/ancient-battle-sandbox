// D 侧翼反冲镜像验证：A=红守red_pass vs 蓝攻；B=蓝守blue_pass vs 红攻（换座镜像）
// 断言反冲发起/选翼/收手在换座下对称，90 秒内无宏观分歧
const { makeScene } = require('../tests/battle-harness.js');

const DEF = { pikeman: 30, archer: 15, cavalry: 6 }, ATK = { infantry: 40, archer: 15 };

function runOnce(defTeam) {
    const scene = makeScene();
    const orders = defTeam === 'red'
        ? { red: 'hold_ground', blue: 'advance' }
        : { blue: 'hold_ground', red: 'advance' };
    scene.deployUnits(defTeam === 'red' ? DEF : ATK, defTeam === 'red' ? ATK : DEF,
        'custom', 'custom', orders, { terrain: defTeam === 'red' ? 'red_pass' : 'blue_pass' });
    scene.battleStarted = true;
    return scene;
}

const a = runOnce('red');   // A：红守
const b = runOnce('blue');  // B：蓝守（A 的换座镜像）

// 配对：A 红(守军) ↔ B 蓝(守军)；A 蓝(攻军) ↔ B 红(攻军)
const pairs = [];
a.units.filter(u => u.team === 'red').forEach((u, i) => pairs.push([u, b.units.filter(x => x.team === 'blue')[i], u.type[0] + i]));
a.units.filter(u => u.team === 'blue').forEach((u, i) => pairs.push([u, b.units.filter(x => x.team === 'red')[i], u.type[0] + i]));

const STEP = 1000 / 60;
let prevMax = 0;
for (let step = 0; step < 90 * 60 && !a.battleOver && !b.battleOver; step++) {
    a.advanceBattle(STEP); b.advanceBattle(STEP);
    let maxOff = 0, worst = null;
    for (const [ua, ub] of pairs) {
        if (!ua || !ub || ua.dead || ub.dead) continue;
        const off = Math.max(Math.abs(ua.gx + ub.gx - 70), Math.abs(ua.gy - ub.gy));
        if (off > maxOff) { maxOff = off; worst = [ua, ub]; }
    }
    if (maxOff > prevMax * 2 && maxOff > 0.001 || step % 600 === 0) {
        console.log(`step${step} maxOff=${maxOff.toFixed(4)}`);
    }
    if (maxOff > 0.3) {
        const [ua, ub] = worst;
        console.log(`step${step} 超阈值 maxOff=${maxOff.toFixed(3)}`);
        console.log(`  A: ${ua.type}#${ua.id} (${ua.gx.toFixed(2)},${ua.gy.toFixed(2)}) state=${ua.state} raid=${!!ua.counterRaid}`);
        console.log(`  B: ${ub.type}#${ub.id} (${ub.gx.toFixed(2)},${ub.gy.toFixed(2)}) state=${ub.state} raid=${!!ub.counterRaid}`);
        process.exit(1);
    }
    prevMax = maxOff;
}
console.log('90秒内无宏观分歧（含反冲镜像对称）');
