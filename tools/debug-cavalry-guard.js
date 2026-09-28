// 防守骑兵AI改进验证：前瞻触发 / 对冲拦截 / 时机纪律 / 翼位分工
const { makeScene } = require('../tests/battle-harness.js');

const STEP = 1000 / 60;
const dist = (a, b) => Math.hypot(a.gx - b.gx, a.gy - b.gy);

const army = { infantry: 36, pikeman: 12, archer: 16, cavalry: 12 };

// 用 battle-harness 做真实部署
const harness = require('../tests/battle-harness.js');
function fullScene(terrain, orders, options, redConfig, blueConfig) {
    const scene = harness.makeScene();
    scene.deployUnits(redConfig, blueConfig, 'custom', 'custom', orders, { terrain, ...options });
    scene.battleStarted = true;
    return scene;
}

// ---- 验证1：对冲拦截 ----
{
    console.log('\n[1] 对冲拦截：红骑 14 格外冲锋直指蓝弓手平台');
    const scene = fullScene('blue_pass', { red: 'advance', blue: 'hold_ground' }, {}, { cavalry: 6 }, army);
    const blueCav = scene.units.filter(u => u.team === 'blue' && u.type === 'cavalry');
    const redCav = scene.units.filter(u => u.team === 'red' && u.type === 'cavalry');
    // 把红骑放到弓手平台正前方 14 格，进入冲锋状态直指平台
    redCav.forEach((u, i) => {
        u.gx = 38; u.gy = 34 + i * 0.9;
        u.state = 'charge'; u.chargeDX = 1; u.chargeDY = 0;
        u.chargeDistance = 3; u.chargeMomentum = 1; u.lastRetarget = scene.simulationTime;
    });
    u0: {
        scene.rebuildSpatial();
        const threats = scene.tactics.passArcherThreats('blue');
        const raidThreats = threats.filter(e => e.enemy.type === 'cavalry');
        console.log(`  威胁表: ${threats.length} 个威胁, 其中敌骑 ${raidThreats.length} 个`);
        // 蓝方守骑应获得拦截目标
        let intercepting = 0, charging = 0;
        for (let step = 0; step < 30; step++) {
            scene.simulationTime = step * STEP;
            scene.rebuildSpatial();
            for (const u of scene.units) { u.moveX = 0; u.moveY = 0; u.moving = false; u.velX = 6; u.velY = 0; }
            scene.planningStep = true;
            for (const u of blueCav) if (!u.dead) scene.tactics.updateGroundGuard(u, scene.simulationTime, 1 / 60);
            scene.planningStep = false;
            for (const u of scene.units) { u.gx += u.moveX; u.gy += u.moveY; }
            if (step < 5 || step === 29) {
                const ic = blueCav.filter(u => u.guardIntercept).length;
                const ch = blueCav.filter(u => u.state === 'charge' && u.target && u.target.team === 'red').length;
                if (step === 29) { intercepting = ic; charging = ch; }
            }
        }
        console.log(`  30 帧后: 持拦截点的守骑 ${intercepting}, 冲锋中的守骑 ${charging}`);
        console.log(`  守骑位置示例: gx=${blueCav[0].gx.toFixed(1)} gy=${blueCav[0].gy.toFixed(1)} (锚点 ${blueCav[0].guardAnchor.gx},${blueCav[0].guardAnchor.gy})`);
    }
}

// ---- 验证2：前瞻触发 ----
{
    console.log('\n[2] 前瞻触发：红骑 8 格外向弓手区推进（非冲锋）');
    const scene = fullScene('blue_pass', { red: 'advance', blue: 'hold_ground' }, {}, { cavalry: 4 }, army);
    const blueCav = scene.units.filter(u => u.team === 'blue' && u.type === 'cavalry');
    const redCav = scene.units.filter(u => u.team === 'red' && u.type === 'cavalry');
    redCav.forEach((u, i) => { u.gx = 43; u.gy = 33 + i * 0.8; u.state = 'melee'; });
    scene.rebuildSpatial();
    // 模拟红骑正在向弓手区移动（velX 朝向 +x）
    for (const u of scene.units) { u.velX = 4; u.velY = 0; }
    const threats = scene.tactics.passArcherThreats('blue');
    const cavThreats = threats.filter(e => e.enemy.type === 'cavalry');
    console.log(`  红骑距弓手 ~8格: 威胁表含敌骑 ${cavThreats.length} 个 (旧逻辑半径4.2应为0)`);
    // 对照：远离方向移动（越过 600ms 威胁粘滞窗口后再看方向过滤）
    for (const u of scene.units) { u.velX = -4; u.velY = 0; }
    scene.simulationTime += 700;
    const threats2 = scene.tactics.passArcherThreats('blue');
    const cavThreats2 = threats2.filter(e => e.enemy.type === 'cavalry');
    console.log(`  红骑远离时: 威胁表含敌骑 ${cavThreats2.length} 个 (方向过滤应为0)`);
}

// ---- 验证3：翼位分工 ----
{
    console.log('\n[3] 翼位分工：上下翼各来一队敌骑');
    const scene = fullScene('blue_pass', { red: 'advance', blue: 'hold_ground' }, {}, { cavalry: 8 }, army);
    const blueCav = scene.units.filter(u => u.team === 'blue' && u.type === 'cavalry');
    const redCav = scene.units.filter(u => u.team === 'red' && u.type === 'cavalry');
    redCav.slice(0, 4).forEach((u, i) => { u.gx = 46; u.gy = 26 + i * 0.8; u.velX = 4; u.velY = 0; });
    redCav.slice(4).forEach((u, i) => { u.gx = 46; u.gy = 44 + i * 0.8; u.velX = 4; u.velY = 0; });
    scene.rebuildSpatial();
    const upper = blueCav.filter(u => u.guardAnchor.gy < 35);
    const lower = blueCav.filter(u => u.guardAnchor.gy > 35);
    let upperToLower = 0, lowerToUpper = 0, upperOwn = 0, lowerOwn = 0;
    for (const u of upper) {
        const t = scene.tactics.groundThreat(u);
        if (t) { t.gy < 31 ? upperOwn++ : upperToLower++; }
    }
    for (const u of lower) {
        const t = scene.tactics.groundThreat(u);
        if (t) { t.gy > 39 ? lowerOwn++ : lowerToUpper++; }
    }
    console.log(`  上翼守骑 ${upper.length}: 接上翼威胁 ${upperOwn}, 越权接下翼 ${upperToLower}`);
    console.log(`  下翼守骑 ${lower.length}: 接下翼威胁 ${lowerOwn}, 越权接上翼 ${lowerToUpper}`);
}

// ---- 验证4：时机纪律（威胁消失后动量保持） ----
{
    console.log('\n[4] 时机纪律：威胁消失后 350ms 内不清冲锋动量');
    const scene = fullScene('blue_pass', { red: 'advance', blue: 'hold_ground' }, {}, { cavalry: 2 }, army);
    const cav = scene.units.find(u => u.team === 'blue' && u.type === 'cavalry');
    const enemy = scene.units.find(u => u.team === 'red');
    const step = (now) => {
        scene.simulationTime = now;
        scene.rebuildSpatial();
        scene.planningStep = true;
        scene.tactics.updateGroundGuard(cav, now, 1 / 60);
        scene.planningStep = false;
        cav.gx += cav.moveX; cav.gy += cav.moveY;
        cav.moveX = 0; cav.moveY = 0; cav.moving = false;
    };
    // 敌骑逼近弓手平台中性带（距弓手 ~4 格），成为真实威胁
    Object.assign(enemy, { gx: 46, gy: 35, velX: 4, velY: 0 });
    scene.rebuildSpatial();
    for (let i = 0; i < 20; i++) step(2000 + i * STEP);
    const fromPost = Math.hypot(cav.gx - cav.guardAnchor.gx, cav.gy - cav.guardAnchor.gy);
    console.log(`  追击20帧后: target=${!!cav.guardPursueTarget}, pursueFor=${cav.guardPursueFor}, 离锚=${fromPost.toFixed(1)}格, state=${cav.state}`);
    // 威胁撤离威胁区（远离弓手且不逼近），守骑应在宽限期内继续追击
    Object.assign(enemy, { gx: 20, gy: 12, velX: -4, velY: 0 });
    scene.rebuildSpatial();
    let firstFrame = null, stillChasing = 0;
    for (let i = 0; i < 40; i++) {
        const now = 2033 + (i + 1) * STEP;
        step(now);
        if (i === 0) firstFrame = { target: !!cav.groundGuardTarget, pursueFor: cav.guardPursueFor };
        if (cav.groundGuardTarget) stillChasing++;
    }
    console.log(`  威胁消失后第1帧: target=${firstFrame.target} (宽限应仍追击), pursueFor=${firstFrame.pursueFor?.toFixed(3)}`);
    console.log(`  之后40帧中仍持宽限目标的帧数: ${stillChasing} (应约21帧后归0, 之后返程)`);
    console.log(`  最终: groundGuardTarget=${!!cav.groundGuardTarget}, returning=${cav.groundGuardReturning}`);
}
