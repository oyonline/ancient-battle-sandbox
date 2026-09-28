// 调试矛阵方阵 vs 骑兵楔形：绕枪墙后骑兵为何反而全歼矛阵
const { makeScene } = require('../tests/battle-harness.js');

const scene = makeScene();
scene.deployUnits({ pikeman: 80, archer: 15 }, { cavalry: 50 }, 'square', 'wedge');
scene.battleStarted = true;
const STEP = 1000 / 60;
const cavs = scene.units.filter(u => u.type === 'cavalry' && u.team === 'blue');
let detouring = new Set();

for (let step = 0; step < 240 * 60 && !scene.battleOver; step++) {
    scene.advanceBattle(STEP);
    for (const c of cavs) {
        if (c.dead || !c.target) continue;
        const aim = scene.cavalryAI.detourPikes(c, c.target);
        if (aim !== c.target) detouring.add(c.id);
    }
    if (step % 1200 === 0) {
        const alive = (t, ty) => scene.units.filter(u => u.team === t && !u.dead && !u.withdrawn && (ty ? u.type === ty : true)).length;
        const detourNow = cavs.filter(c => !c.dead && c.detourSign !== null && c.detourSign !== undefined).length;
        const riderX = cavs.filter(c => !c.dead).map(c => c.gx.toFixed(0));
        console.log(`t=${(step / 60).toFixed(0)}s 矛=${alive('red','pikeman')} 弓=${alive('red','archer')} 骑=${alive('blue')} 绕行中=${detourNow} 曾绕行=${detouring.size} 骑x分布=${riderX.join(',')}`);
    }
}
console.log('结束: winner=', scene.winner, ' 矛=', scene.units.filter(u => u.team === 'red' && !u.dead).length, ' 骑=', scene.units.filter(u => u.team === 'blue' && !u.dead).length);
console.log('曾绕行的骑兵数:', detouring.size, '/', cavs.length);
