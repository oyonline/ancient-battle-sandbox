// D 侧翼反冲行为验证：红守坡口(hold_ground) vs 蓝步兵推进(advance)
// 追踪：咬合时刻、反冲发起、出击骑离锚距离轨迹、敌弓伤亡、返锚、结局
const { makeScene } = require('../tests/battle-harness.js');

const scene = makeScene();
scene.deployUnits(
    { pikeman: 30, archer: 15, cavalry: 6 },          // 红：守坡口（矛前排+弓平台+守骑）
    { infantry: 40, archer: 15 },                     // 蓝：步兵线+弓推进
    'custom', 'custom',
    { red: 'hold_ground', blue: 'advance' },
    { terrain: 'red_pass' }
);
scene.battleStarted = true;

const riders = scene.units.filter(u => u.team === 'red' && u.type === 'cavalry');
let biteSeen = false, raidSeen = false, raidLog = [];
const STEP = 1000 / 60;
for (let step = 0; step < 120 * 60 && !scene.battleOver; step++) {
    scene.advanceBattle(STEP);
    const now = scene.simulationTime;
    const group = scene.tactics?.groundGuards?.red;
    if (group?.biteAt != null && !biteSeen) { biteSeen = true; console.log(`t=${(now/1000).toFixed(1)}s 战线咬合(biteAt)`); }
    const raiding = riders.filter(u => u.counterRaid);
    if (raiding.length && !raidSeen) {
        raidSeen = true;
        console.log(`t=${(now/1000).toFixed(1)}s 反冲发起: 骑#${raiding.map(u => u.id).join(',')} ` +
            `冲击点(${raiding[0].counterRaid.gx.toFixed(1)},${raiding[0].counterRaid.gy.toFixed(1)})`);
    }
    if (raidSeen && step % 30 === 0) {
        const entry = raiding.map(u => ({
            id: u.id, distAnchor: Math.hypot(u.gx - u.guardAnchor.gx, u.gy - u.guardAnchor.gy).toFixed(1),
            hp: u.hp.toFixed(0), state: u.state, still: !!u.counterRaid
        }));
        raidLog.push(`t=${(now/1000).toFixed(1)}s ${JSON.stringify(entry)}`);
    }
}
const enemyArchers = scene.units.filter(u => u.team === 'blue' && u.type === 'archer');
console.log(`结局: winner=${scene.winner || 'timeout'} t=${(scene.simulationTime/1000).toFixed(0)}s`);
console.log(`红存活=${scene.units.filter(u => u.team === 'red' && !u.dead && !u.withdrawn).length} ` +
    `蓝存活=${scene.units.filter(u => u.team === 'blue' && !u.dead && !u.withdrawn).length} ` +
    `蓝弓存活=${enemyArchers.filter(u => !u.dead && !u.withdrawn).length}/${enemyArchers.length}`);
console.log('出击骑轨迹(每0.5s):');
console.log(raidLog.slice(0, 30).join('\n'));
if (!biteSeen) console.log('!! 未检测到咬合');
if (!raidSeen) console.log('!! 反冲未发起');
