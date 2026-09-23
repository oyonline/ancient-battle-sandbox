// 捕获 step 1649→1650 两帧：p20 弓手的位移、速度、facing 旋转输入输出
const { makeScene } = require('../tests/battle-harness');

const A_ID = parseInt(process.env.A || '93', 10);   // forward 蓝方弓手 blue#20
const B_ID = parseInt(process.env.B || '21', 10);    // reversed 红方弓手 red#20（镜像）
const UP_TO = parseInt(process.env.STEP || '1648', 10);  // 先跑到 step 1648 末

const forward = makeScene(), reversed = makeScene();
forward.deployUnits({ infantry: 72 }, { archer: 45 }, 'custom', 'custom');
reversed.deployUnits({ archer: 45 }, { infantry: 72 }, 'custom', 'custom');
forward.battleStarted = reversed.battleStarted = true;

for (let step = 0; step <= UP_TO; step++) {
    forward.advanceBattle(1000 / 60);
    reversed.advanceBattle(1000 / 60);
}

const uA = forward.units.find(x => x.id === A_ID);
const uB = reversed.units.find(x => x.id === B_ID);
if (!uA || !uB) throw new Error('unit not found');

function snap(u, label) {
    const dt = 1 / 60;
    const velX = u.pgx !== undefined ? (u.gx - u.pgx) / dt : 0;
    const velY = u.pgy !== undefined ? (u.gy - u.pgy) / dt : 0;
    console.log(`${label}: gx=${u.gx} gy=${u.gy} pgx=${u.pgx} pgy=${u.pgy} vel=(${velX},${velY}) moving=${u.moving} facing=(${u.moraleFacingX},${u.moraleFacingY}) state=${u.moraleState} target=${u.target ? u.target.id : 'null'} hp=${u.hp}`);
    return { gx: u.gx, gy: u.gy, pgx: u.pgx, pgy: u.pgy, velX, velY, moving: u.moving, fx: u.moraleFacingX, fy: u.moraleFacingY };
}

const p0A = snap(uA, 'A@1648末');
const p0B = snap(uB, 'B@1648末');

forward.advanceBattle(1000 / 60);
reversed.advanceBattle(1000 / 60);
const p1A = snap(uA, 'A@1649末');
const p1B = snap(uB, 'B@1649末');

// step 1650 开始时 updateFacing 实际看到的输入（vel 在帧首由 1649 位移算出）
for (const [tag, p, u] of [['A', p1A, uA], ['B', p1B, uB]]) {
    const dt = 1 / 60;
    const velX = (p.gx - p.pgx) / dt, velY = (p.gy - p.pgy) / dt;
    const speed = Math.hypot(velX, velY);
    const useVel = p.moving && speed > 0.15;
    let x = 0, y = 0, src = 'none';
    if (useVel) { x = velX; y = velY; src = 'vel'; }
    else if (u.target && !u.target.dead && !u.target.withdrawn) { x = u.target.gx - u.gx; y = u.target.gy - u.gy; src = 'target'; }
    const len = Math.hypot(x, y);
    console.log(`${tag} step1650 updateFacing 输入: src=${src} x=(${x},${y}) len=${len} vel=(${velX},${velY}) speed=${speed} facing=(${p.fx},${p.fy})`);
    if (len >= 0.001) {
        x /= len; y /= len;
        const angle = Math.atan2(p.fx * y - p.fy * x, p.fx * x + p.fy * y);
        const clamped = Math.max(-Math.PI * dt / 2, Math.min(Math.PI * dt / 2, angle));
        console.log(`${tag} 原始angle=${angle} clamp后=${clamped} (π·dt/2=${Math.PI * dt / 2})`);
    }
}

forward.advanceBattle(1000 / 60);
reversed.advanceBattle(1000 / 60);
snap(uA, 'A@1650末');
snap(uB, 'B@1650末');
