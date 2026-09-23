// 全字段镜像追踪：找出第一处"决策字段"发散（士气、状态、计时等应逐位一致的字段）
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

// 决策字段：全部由整数输入/恒等运算得出，两场景应逐位一致
function snapOf(u, rec) {
    rec = rec || {};
    return {
        gx: u.gx, gy: u.gy, hp: u.hp, dead: !!u.dead, withdrawn: !!u.withdrawn,
        morale: u.morale, moraleState: u.moraleState, moraleSheltered: u.moraleSheltered, moraleReason: u.moraleReason,
        pressure: rec.pressure, pressureReason: rec.pressureReason, sheltered: rec.sheltered,
        lowTime: rec.lowTime, pressureTime: rec.pressureTime, safeTime: rec.safeTime,
        canSpread: rec.canSpread, spread: rec.spread,
        lastAttack: u.lastAttack, nextShift: u.nextShift,
        fx: u.moraleFacingX, fy: u.moraleFacingY, moving: u.moving
    };
}

let firstDiv = null;
for (let step = 0; step < 12000 && !(forward.battleOver && reversed.battleOver) && !firstDiv; step++) {
    const prevs = pairs.map(([a, b]) => [snapOf(a, forward.morale.records.get(a)), snapOf(b, reversed.morale.records.get(b))]);
    forward.advanceBattle(1000 / 60);
    reversed.advanceBattle(1000 / 60);
    for (let p = 0; p < pairs.length && !firstDiv; p++) {
        const [a, b, team, i] = pairs[p];
        const sa = snapOf(a, forward.morale.records.get(a));
        const sb = snapOf(b, reversed.morale.records.get(b));
        for (const key of Object.keys(sa)) {
            if (key === 'fx' || key === 'fy') continue;   // facing 走下方专门的镜像偏差检查
            let bad = false, va = sa[key], vb = sb[key];
            if (key === 'gx') bad = Math.abs(va + vb - 70) > 1e-9;
            else if (key === 'gy') bad = Math.abs(va - vb) > 1e-9;
            else bad = va !== vb;
            if (bad) {
                firstDiv = { step, p, team, i, key, aId: a.id, bId: b.id, va, vb,
                    prevA: prevs[p][0][key], prevB: prevs[p][1][key], prevSnapA: prevs[p][0], prevSnapB: prevs[p][1], type: a.type };
                break;
            }
        }
        if (!firstDiv) {
            // facing 镜像偏差：fA.x 应 = -fB.x，fA.y 应 = fB.y；噪声量级 ~1e-12，超过 1e-9 即为破对称
            const fDevX = a.moraleFacingX + b.moraleFacingX, fDevY = a.moraleFacingY - b.moraleFacingY;
            if (Math.abs(fDevX) > 1e-9 || Math.abs(fDevY) > 1e-9) {
                firstDiv = { step, p, team, i, key: 'facing', aId: a.id, bId: b.id,
                    va: `(${a.moraleFacingX},${a.moraleFacingY})`, vb: `(${b.moraleFacingX},${b.moraleFacingY})`,
                    prevA: `(${prevs[p][0].fx},${prevs[p][0].fy})`, prevB: `(${prevs[p][1].fx},${prevs[p][1].fy})`,
                    prevSnapA: prevs[p][0], prevSnapB: prevs[p][1], type: a.type };
            }
        }
    }
}

if (!firstDiv) {
    console.log('NO DIVERGENCE until battle end');
} else {
    const d = firstDiv;
    console.log(`FIRST DIVERGENCE step=${d.step} ${d.team}#${d.i} type=${d.type} aId=${d.aId} bId=${d.bId} field=${d.key}`);
    console.log(`  A(${d.team}) ${d.key}=${JSON.stringify(d.va)}`);
    console.log(`  B(mirror) ${d.key}=${JSON.stringify(d.vb)}`);
    console.log(`  prev A ${d.key}=${JSON.stringify(d.prevA)}  prev B ${d.key}=${JSON.stringify(d.prevB)}`);
    console.log('  prev full A:', JSON.stringify(d.prevSnapA));
    console.log('  prev full B:', JSON.stringify(d.prevSnapB));
}
console.log('over:', forward.battleOver, reversed.battleOver, 'duration:', forward.simulationTime, reversed.simulationTime);
